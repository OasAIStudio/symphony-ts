import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";

describe("ERROR_CODES", () => {
  it("contains the typed workflow parsing failures required by the spec", () => {
    expect(ERROR_CODES.missingWorkflowFile).toBe("missing_workflow_file");
    expect(ERROR_CODES.workflowParseError).toBe("workflow_parse_error");
    expect(ERROR_CODES.workflowFrontMatterNotAMap).toBe(
      "workflow_front_matter_not_a_map",
    );
    expect(ERROR_CODES.workflowNotFound).toBe("workflow_not_found");
    expect(ERROR_CODES.workflowYamlInvalid).toBe("workflow_yaml_invalid");
    expect(ERROR_CODES.workflowFrontmatterNotMap).toBe(
      "workflow_frontmatter_not_map",
    );
  });

  it("contains the mandatory workspace and codex failure families", () => {
    expect(ERROR_CODES.workspaceRootEscape).toBe("workspace_root_escape");
    expect(ERROR_CODES.invalidWorkspaceCwd).toBe("invalid_workspace_cwd");
    expect(ERROR_CODES.hookTimedOut).toBe("hook_timed_out");
    expect(ERROR_CODES.codexReadTimeout).toBe("codex_read_timeout");
    expect(ERROR_CODES.codexTurnTimeout).toBe("codex_turn_timeout");
  });
});
