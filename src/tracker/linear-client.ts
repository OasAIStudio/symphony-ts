import {
  DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
  DEFAULT_LINEAR_PAGE_SIZE,
} from "../config/defaults.js";
import type { Issue } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import { TrackerError, toTrackerRequestError } from "./errors.js";
import {
  normalizeLinearIssue,
  normalizeLinearIssueState,
} from "./linear-normalize.js";
import {
  LINEAR_CANDIDATE_ISSUES_QUERY,
  LINEAR_CREATE_COMMENT_MUTATION,
  LINEAR_ISSUE_STATES_BY_IDS_QUERY,
  LINEAR_ISSUE_UPDATE_MUTATION,
  LINEAR_ISSUES_BY_STATES_QUERY,
  LINEAR_WORKFLOW_STATES_QUERY,
} from "./linear-queries.js";
import type { IssueStateSnapshot, IssueTracker } from "./tracker.js";

interface LinearGraphqlPageInfo {
  hasNextPage?: unknown;
  endCursor?: unknown;
}

interface LinearGraphqlConnection<TNode> {
  nodes?: unknown;
  pageInfo?: LinearGraphqlPageInfo | null;
}

interface LinearGraphqlResponse<TData> {
  data?: TData;
  errors?: unknown;
}

export interface LinearRawGraphqlResponse {
  status: number;
  body: unknown;
}

interface LinearCandidateData {
  issues?: LinearGraphqlConnection<unknown>;
}

type LinearStatesData = LinearCandidateData;

interface LinearIssueStatesData {
  issues?: {
    nodes?: unknown;
  };
}

interface LinearIssueUpdateData {
  issueUpdate?: {
    success?: boolean;
    issue?: { id?: string; state?: { name?: string } };
  };
}

interface LinearCommentCreateData {
  commentCreate?: {
    success?: boolean;
    comment?: { id?: string };
  };
}

interface LinearWorkflowStatesData {
  workflowStates?: {
    nodes?: Array<{ id?: string; name?: string }>;
  };
}

export interface LinearTrackerClientOptions {
  endpoint: string;
  apiKey: string | null;
  projectSlug: string | null;
  activeStates: string[];
  pageSize?: number;
  networkTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class LinearTrackerClient implements IssueTracker {
  private readonly endpoint: string;
  private readonly apiKey: string | null;
  private readonly projectSlug: string | null;
  private readonly activeStates: string[];
  private readonly pageSize: number;
  private readonly networkTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: LinearTrackerClientOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.projectSlug = options.projectSlug;
    this.activeStates = [...options.activeStates];
    this.pageSize = options.pageSize ?? DEFAULT_LINEAR_PAGE_SIZE;
    this.networkTimeoutMs =
      options.networkTimeoutMs ?? DEFAULT_LINEAR_NETWORK_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuePages(LINEAR_CANDIDATE_ISSUES_QUERY, {
      projectSlug: this.requireProjectSlug(),
      activeStates: this.activeStates,
      first: this.pageSize,
      relationFirst: this.pageSize,
    });
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) {
      return [];
    }

    return this.fetchIssuePages(LINEAR_ISSUES_BY_STATES_QUERY, {
      projectSlug: this.requireProjectSlug(),
      stateNames,
      first: this.pageSize,
      relationFirst: this.pageSize,
    });
  }

  async fetchIssueStatesByIds(
    issueIds: string[],
  ): Promise<IssueStateSnapshot[]> {
    if (issueIds.length === 0) {
      return [];
    }

    const response = await this.postGraphql<LinearIssueStatesData>(
      LINEAR_ISSUE_STATES_BY_IDS_QUERY,
      {
        issueIds,
      },
    );

    const nodes = response.issues?.nodes;
    if (!Array.isArray(nodes)) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear issue states payload was missing issues.nodes.",
        { details: response },
      );
    }

    return nodes.map((node) => normalizeLinearIssueState(node));
  }

  async postComment(issueId: string, body: string): Promise<void> {
    const response = await this.postGraphql<LinearCommentCreateData>(
      LINEAR_CREATE_COMMENT_MUTATION,
      { issueId, body },
    );

    if (response.commentCreate?.success !== true) {
      throw new TrackerError(
        ERROR_CODES.linearGraphqlErrors,
        "Linear commentCreate mutation did not return success.",
        { details: response },
      );
    }
  }

  async updateIssueState(
    issueId: string,
    stateName: string,
    teamKey: string,
  ): Promise<void> {
    const statesResponse = await this.postGraphql<LinearWorkflowStatesData>(
      LINEAR_WORKFLOW_STATES_QUERY,
      { teamId: teamKey },
    );

    const states = statesResponse.workflowStates?.nodes;
    if (!Array.isArray(states)) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear workflowStates payload was missing nodes.",
        { details: statesResponse },
      );
    }

    const targetState = states.find(
      (s) =>
        typeof s.name === "string" &&
        s.name.toLowerCase() === stateName.toLowerCase(),
    );
    if (!targetState || typeof targetState.id !== "string") {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        `Linear workflow state "${stateName}" not found for team "${teamKey}".`,
        { details: { states, targetStateName: stateName } },
      );
    }

    const updateResponse = await this.postGraphql<LinearIssueUpdateData>(
      LINEAR_ISSUE_UPDATE_MUTATION,
      { issueId, stateId: targetState.id },
    );

    if (updateResponse.issueUpdate?.success !== true) {
      throw new TrackerError(
        ERROR_CODES.linearGraphqlErrors,
        "Linear issueUpdate mutation did not return success.",
        { details: updateResponse },
      );
    }
  }

  async executeRawGraphql(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<LinearRawGraphqlResponse> {
    const apiKey = this.requireApiKey();
    const response = await this.fetchWithTimeout(query, variables, apiKey);
    const body = await parseGraphqlResponseBody(response);

    return {
      status: response.status,
      body,
    };
  }

  private async fetchIssuePages(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Issue[]> {
    const issues: Issue[] = [];
    let after: string | null = null;

    while (true) {
      const response: LinearCandidateData = await this.postGraphql(query, {
        ...variables,
        after,
      });

      const connection: LinearGraphqlConnection<unknown> | undefined =
        response.issues;
      if (!connection || typeof connection !== "object") {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear issues payload was missing the issues connection.",
          { details: response },
        );
      }

      const nodes = connection.nodes;
      if (!Array.isArray(nodes)) {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear issues payload was missing issues.nodes.",
          { details: response },
        );
      }

      issues.push(...nodes.map((node) => normalizeLinearIssue(node)));

      const pageInfo: LinearGraphqlPageInfo | null | undefined =
        connection.pageInfo;
      if (!pageInfo || typeof pageInfo !== "object") {
        throw new TrackerError(
          ERROR_CODES.linearUnknownPayload,
          "Linear issues payload was missing pageInfo.",
          { details: response },
        );
      }

      if (pageInfo.hasNextPage !== true) {
        break;
      }

      if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor === "") {
        throw new TrackerError(
          ERROR_CODES.linearMissingEndCursor,
          "Linear pagination indicated more pages without an end cursor.",
          { details: response },
        );
      }

      after = pageInfo.endCursor;
    }

    return issues;
  }

  private async postGraphql<TData>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<TData> {
    const apiKey = this.requireApiKey();
    const response = await this.fetchWithTimeout(query, variables, apiKey);

    if (!response.ok) {
      throw new TrackerError(
        ERROR_CODES.linearApiStatus,
        `Linear API request failed with HTTP ${response.status}.`,
        { status: response.status },
      );
    }

    let body: LinearGraphqlResponse<TData>;
    try {
      body = (await response.json()) as LinearGraphqlResponse<TData>;
    } catch (error) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear API returned a non-JSON payload.",
        { cause: error },
      );
    }

    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new TrackerError(
        ERROR_CODES.linearGraphqlErrors,
        "Linear GraphQL returned top-level errors.",
        { details: body.errors },
      );
    }

    if (!("data" in body) || body.data === undefined || body.data === null) {
      throw new TrackerError(
        ERROR_CODES.linearUnknownPayload,
        "Linear GraphQL response was missing the data field.",
        { details: body },
      );
    }

    return body.data;
  }

  private async fetchWithTimeout(
    query: string,
    variables: Record<string, unknown>,
    apiKey: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.networkTimeoutMs);

    try {
      return await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      throw toTrackerRequestError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireApiKey(): string {
    if (!this.apiKey || this.apiKey.trim() === "") {
      throw new TrackerError(
        ERROR_CODES.missingTrackerApiKey,
        "Linear tracker API key is required.",
      );
    }

    return this.apiKey;
  }

  private requireProjectSlug(): string {
    if (!this.projectSlug || this.projectSlug.trim() === "") {
      throw new TrackerError(
        ERROR_CODES.missingTrackerProjectSlug,
        "Linear tracker project slug is required.",
      );
    }

    return this.projectSlug;
  }
}

async function parseGraphqlResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      raw: text,
    };
  }
}
