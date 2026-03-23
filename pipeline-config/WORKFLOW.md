---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: $LINEAR_PROJECT_SLUG
  active_states:
    - Todo
    - In Progress
    - In Review
    - Rework
  terminal_states:
    - Done
    - Cancelled

polling:
  interval_ms: 30000

workspace:
  root: ./workspaces

agent:
  max_concurrent_agents: 3
  max_turns: 30
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    in progress: 3
    in review: 2

runner:
  kind: claude-code
  model: claude-sonnet-4-5

hooks:
  after_create: ./hooks/after-create.sh
  before_run: ./hooks/before-run.sh
  timeout_ms: 120000

server:
  port: 4321

observability:
  dashboard_enabled: true
  refresh_ms: 5000

stages:
  initial_stage: investigate

  investigate:
    type: agent
    runner: claude-code
    model: claude-opus-4
    max_turns: 8
    prompt: prompts/investigate.liquid
    on_complete: implement

  implement:
    type: agent
    runner: claude-code
    model: claude-sonnet-4-5
    max_turns: 30
    prompt: prompts/implement.liquid
    on_complete: review

  review:
    type: gate
    gate_type: ensemble
    max_rework: 3
    reviewers:
      - runner: codex
        model: gpt-5.3-codex
        role: adversarial-reviewer
        prompt: prompts/review-adversarial.liquid
      - runner: gemini
        model: gemini-3-pro
        role: security-reviewer
        prompt: prompts/review-security.liquid
    on_approve: merge
    on_rework: implement

  merge:
    type: agent
    runner: claude-code
    model: claude-sonnet-4-5
    max_turns: 5
    prompt: prompts/merge.liquid
    on_complete: done

  done:
    type: terminal
---

{% render 'prompts/global.liquid' %}

You are working on Linear issue {{ issue.identifier }}: {{ issue.title }}.

{{ issue.description }}

{% if issue.labels.size > 0 %}
Labels: {{ issue.labels | join: ", " }}
{% endif %}
