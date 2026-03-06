# Symphony

**Symphony turns project work into isolated, autonomous implementation runs, so teams can manage work instead of supervising coding agents.**

> Harness Engineering is exactly what I want!
> Not vibe coding. Not just giving OpenClaw a sentence and asking it to orchestrate the rest.

`symphony-ts` is a TypeScript implementation of the original
[openai/symphony](https://github.com/openai/symphony) project.

It is an orchestration service for agent-driven software delivery: it reads work from your tracker,
creates a dedicated workspace for each issue, runs a coding agent inside that boundary, and gives
operators a clean surface for runtime visibility, retries, and control.

It works best in codebases that have adopted
[harness engineering](https://openai.com/index/harness-engineering/). Symphony is the next step:
moving from managing coding agents to managing work that needs to get done.

> [!WARNING]
> Symphony is intended for trusted environments.

<!-- Demo preview goes here -->

## Running Symphony

### Requirements

- Node.js `>= 22`
- pnpm `>= 10`
- a repository with a valid `WORKFLOW.md`
- tracker credentials such as `LINEAR_API_KEY`
- a coding agent runtime that supports app-server mode

### Install

```bash
pnpm install
```

If you want the packaged CLI after publishing:

```bash
npm install -g symphony-ts
```

### Develop

```bash
pnpm build
pnpm test
pnpm lint
pnpm format
```

## What Symphony Does

Symphony is a long-running service that:

- monitors your tracker for eligible work
- creates deterministic, per-issue workspaces
- renders repository-owned workflow prompts from `WORKFLOW.md`
- runs coding agents in isolated execution contexts
- handles retries, reconciliation, and cleanup
- exposes structured logs and an operator-facing status surface

In a typical setup, Symphony watches a Linear board, dispatches agent runs for ready tickets, and
lets the agents produce proof of work such as CI status, review feedback, and pull requests. Human
operators stay focused on the work itself instead of supervising every agent turn.

### Configure your repository

Create a `WORKFLOW.md` that defines how Symphony should operate in your codebase.
The YAML front matter configures tracker, workspace, hooks, and runtime behavior.
The Markdown body becomes the agent prompt template.

Example:

```md
---
tracker:
  kind: linear
workspace:
  root: ~/code/symphony-workspaces
agent:
  max_concurrent_agents: 10
codex:
  command: codex app-server
---

You are working on Linear issue {{ issue.identifier }}.
Implement the task, validate the result, and stop at the required handoff state.
```

## Why Teams Use It

- to turn tracker tickets into autonomous implementation runs
- to isolate agent work by issue instead of sharing one mutable directory
- to keep workflow policy inside the repository
- to operate multiple concurrent agents without losing observability
- to introduce a higher-level operating model for AI-assisted engineering

## Contributing

If you are extending this TypeScript implementation, keep changes aligned with the upstream product
model in [`SPEC.upstream.md`](/Users/wangruobing/Personal/symwork/symphony/SPEC.upstream.md) and
follow the repository workflow documented in [`AGENTS.md`](/Users/wangruobing/Personal/symwork/symphony/AGENTS.md).
