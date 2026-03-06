import { Liquid } from "liquidjs";

import type { Issue, WorkflowDefinition } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";

export const DEFAULT_WORKFLOW_PROMPT =
  "You are working on an issue from Linear.";

const liquidEngine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  ownPropertyOnly: true,
});

export class PromptTemplateError extends Error {
  readonly code = ERROR_CODES.promptRenderFailed;
  readonly kind: "template_parse_error" | "template_render_error";

  constructor(
    kind: "template_parse_error" | "template_render_error",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PromptTemplateError";
    this.kind = kind;
  }
}

export interface RenderPromptInput {
  workflow: Pick<WorkflowDefinition, "promptTemplate">;
  issue: Issue;
  attempt: number | null;
}

export interface BuildTurnPromptInput extends RenderPromptInput {
  turnNumber: number;
  maxTurns: number;
}

export function getEffectivePromptTemplate(promptTemplate: string): string {
  const trimmed = promptTemplate.trim();

  return trimmed.length > 0 ? trimmed : DEFAULT_WORKFLOW_PROMPT;
}

export async function renderPrompt(input: RenderPromptInput): Promise<string> {
  const template = getEffectivePromptTemplate(input.workflow.promptTemplate);

  try {
    const parsedTemplate = liquidEngine.parse(template);

    return await liquidEngine.render(parsedTemplate, {
      issue: toTemplateIssue(input.issue),
      attempt: input.attempt,
    });
  } catch (error) {
    throw toPromptTemplateError(error);
  }
}

export async function buildTurnPrompt(
  input: BuildTurnPromptInput,
): Promise<string> {
  if (input.turnNumber <= 1) {
    return await renderPrompt(input);
  }

  return buildContinuationPrompt({
    issue: input.issue,
    attempt: input.attempt,
    turnNumber: input.turnNumber,
    maxTurns: input.maxTurns,
  });
}

export function buildContinuationPrompt(input: {
  issue: Issue;
  attempt: number | null;
  turnNumber: number;
  maxTurns: number;
}): string {
  const attemptLine =
    input.attempt === null
      ? "This worker session started from the initial dispatch."
      : `This worker session is running retry/continuation attempt ${input.attempt}.`;

  return [
    `Continue working on issue ${input.issue.identifier}: ${input.issue.title}.`,
    `This is continuation turn ${input.turnNumber} of ${input.maxTurns} in the current worker session.`,
    attemptLine,
    `Current tracker state: ${input.issue.state}.`,
    "Reuse the existing thread context and current workspace state.",
    "Do not restate the original task prompt unless it is strictly needed.",
    "Make the next best progress on the issue, then stop when this session has no further useful work to do.",
  ].join("\n");
}

function toTemplateIssue(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branchName: issue.branchName,
    url: issue.url,
    labels: [...issue.labels],
    blockedBy: issue.blockedBy.map((blocker) => ({
      id: blocker.id,
      identifier: blocker.identifier,
      state: blocker.state,
    })),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function toPromptTemplateError(error: unknown): PromptTemplateError {
  if (error instanceof PromptTemplateError) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
  ) {
    if (getErrorMessage(error).includes("undefined filter")) {
      return new PromptTemplateError(
        "template_render_error",
        getErrorMessage(error),
        { cause: error },
      );
    }

    if (error.name === "ParseError" || error.name === "TokenizationError") {
      return new PromptTemplateError(
        "template_parse_error",
        getErrorMessage(error),
        { cause: error },
      );
    }
  }

  return new PromptTemplateError(
    "template_render_error",
    getErrorMessage(error),
    {
      cause: error,
    },
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Prompt rendering failed";
}
