---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: 1fa66498be91
workspace:
  root: /tmp/symphony_workspaces
polling:
  interval_ms: 15000
agent:
  max_concurrent_agents: 1
  max_turns: 5
codex:
  command: codex app-server
  approval_policy: never
server:
  port: 4321
---

You are implementing work for Linear issue {{ issue.identifier }}.

Rules:
1. Implement only what the ticket asks for.
2. Keep changes scoped and safe.
3. Do not add secrets or credentials to the repository.

When finished, update the Linear issue state to "Done" using the `linear_graphql` tool.
