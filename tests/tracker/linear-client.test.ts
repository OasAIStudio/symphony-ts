import { afterEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  LINEAR_CANDIDATE_ISSUES_QUERY,
  LINEAR_ISSUE_STATES_BY_IDS_QUERY,
  LinearTrackerClient,
  type TrackerError,
} from "../../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LinearTrackerClient", () => {
  it("fetches candidate issues with the required slugId project filter and pagination", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                issueNode({
                  id: "1",
                  identifier: "ENG-1",
                  title: "First",
                  createdAt: "2026-03-01T00:00:00.000Z",
                }),
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor-1",
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                issueNode({
                  id: "2",
                  identifier: "ENG-2",
                  title: "Second",
                  createdAt: "2026-03-02T00:00:00.000Z",
                }),
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        }),
      );

    const client = createClient({ fetchFn });
    const issues = await client.fetchCandidateIssues();

    expect(issues.map((issue) => issue.identifier)).toEqual(["ENG-1", "ENG-2"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const firstCall = fetchFn.mock.calls[0];
    expect(firstCall?.[0]).toBe("https://api.linear.app/graphql");

    const firstRequest = parseRequestBody(firstCall?.[1]);
    expect(firstRequest.query).toContain("slugId");
    expect(firstRequest.query).toBe(LINEAR_CANDIDATE_ISSUES_QUERY);
    expect(firstRequest.variables).toEqual({
      projectSlug: "ENG",
      activeStates: ["Todo", "In Progress"],
      first: 50,
      relationFirst: 50,
      after: null,
    });

    const secondRequest = parseRequestBody(fetchFn.mock.calls[1]?.[1]);
    expect(secondRequest.variables).toEqual({
      projectSlug: "ENG",
      activeStates: ["Todo", "In Progress"],
      first: 50,
      relationFirst: 50,
      after: "cursor-1",
    });
  });

  it("returns empty immediately when fetchIssuesByStates receives no states", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = createClient({ fetchFn });

    await expect(client.fetchIssuesByStates([])).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches minimal issue states by GraphQL ID list", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              {
                id: "1",
                identifier: "ENG-1",
                state: {
                  name: "Done",
                },
              },
            ],
          },
        },
      }),
    );

    const client = createClient({ fetchFn });

    await expect(client.fetchIssueStatesByIds(["1"])).resolves.toEqual([
      {
        id: "1",
        identifier: "ENG-1",
        state: "Done",
      },
    ]);

    const request = parseRequestBody(fetchFn.mock.calls[0]?.[1]);
    expect(request.query).toBe(LINEAR_ISSUE_STATES_BY_IDS_QUERY);
    expect(request.query).toContain("$issueIds: [ID!]!");
    expect(request.variables).toEqual({
      issueIds: ["1"],
    });
  });

  it("maps missing API key and project slug to typed errors", async () => {
    const missingApiKeyClient = createClient({
      apiKey: null,
      fetchFn: vi.fn<typeof fetch>(),
    });
    const missingProjectClient = createClient({
      projectSlug: null,
      fetchFn: vi.fn<typeof fetch>(),
    });

    await expect(
      missingApiKeyClient.fetchIssueStatesByIds(["1"]),
    ).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.missingTrackerApiKey,
      }),
    );
    await expect(missingProjectClient.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.missingTrackerProjectSlug,
      }),
    );
  });

  it("maps non-200, GraphQL errors, malformed payloads, and missing cursors", async () => {
    const non200Client = createClient({
      fetchFn: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("boom", { status: 500 })),
    });
    await expect(non200Client.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearApiStatus,
        status: 500,
      }),
    );

    const graphqlErrorClient = createClient({
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          data: null,
          errors: [{ message: "broken" }],
        }),
      ),
    });
    await expect(graphqlErrorClient.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearGraphqlErrors,
      }),
    );

    const malformedClient = createClient({
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        }),
      ),
    });
    await expect(malformedClient.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearUnknownPayload,
      }),
    );

    const missingCursorClient = createClient({
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [],
              pageInfo: {
                hasNextPage: true,
                endCursor: null,
              },
            },
          },
        }),
      ),
    });
    await expect(missingCursorClient.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearMissingEndCursor,
      }),
    );
  });

  it("maps transport failures to linear_api_request", async () => {
    const client = createClient({
      fetchFn: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("network down")),
    });

    await expect(client.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.linearApiRequest,
      }),
    );
  });
});

describe("fetchParent", () => {
  it("returns parent data on cache miss", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            id: "issue-1",
            identifier: "SYMPH-100",
            parent: {
              identifier: "SYMPH-50",
              title: "Parent Epic",
              url: "https://linear.app/team/issue/SYMPH-50",
            },
          },
        },
      }),
    );
    const client = createClient({ fetchFn: mockFetch });

    const result = await client.fetchParent("issue-1");

    expect(result).toEqual({
      identifier: "SYMPH-50",
      title: "Parent Epic",
      url: "https://linear.app/team/issue/SYMPH-50",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns cached data on cache hit without making a GraphQL call", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            id: "issue-1",
            identifier: "SYMPH-100",
            parent: {
              identifier: "SYMPH-50",
              title: "Parent Epic",
              url: "https://linear.app/team/issue/SYMPH-50",
            },
          },
        },
      }),
    );
    const client = createClient({ fetchFn: mockFetch });

    await client.fetchParent("issue-1");
    const result = await client.fetchParent("issue-1");

    expect(result).toEqual({
      identifier: "SYMPH-50",
      title: "Parent Epic",
      url: "https://linear.app/team/issue/SYMPH-50",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns null when issue has no parent", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            id: "issue-2",
            identifier: "SYMPH-101",
            parent: null,
          },
        },
      }),
    );
    const client = createClient({ fetchFn: mockFetch });

    const result = await client.fetchParent("issue-2");

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("caches null results to avoid re-fetching for orphan issues", async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          issue: {
            id: "issue-2",
            identifier: "SYMPH-101",
            parent: null,
          },
        },
      }),
    );
    const client = createClient({ fetchFn: mockFetch });

    await client.fetchParent("issue-2");
    const result = await client.fetchParent("issue-2");

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

function createClient(
  overrides: Partial<ConstructorParameters<typeof LinearTrackerClient>[0]> = {},
): LinearTrackerClient {
  return new LinearTrackerClient({
    endpoint: "https://api.linear.app/graphql",
    apiKey: "linear-token",
    projectSlug: "ENG",
    activeStates: ["Todo", "In Progress"],
    fetchFn: overrides.fetchFn ?? vi.fn<typeof fetch>(),
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function parseRequestBody(init: RequestInit | undefined): {
  query: string;
  variables: Record<string, unknown>;
} {
  if (typeof init?.body !== "string") {
    throw new Error("Expected string request body.");
  }

  return JSON.parse(init.body) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

function issueNode(input: {
  id: string;
  identifier: string;
  title: string;
  createdAt: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    identifier: input.identifier,
    title: input.title,
    description: null,
    priority: 2,
    branchName: null,
    url: null,
    assignee: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    state: {
      name: "Todo",
    },
    labels: {
      nodes: [{ name: "Backend" }],
    },
    inverseRelations: {
      nodes: [],
    },
  };
}
