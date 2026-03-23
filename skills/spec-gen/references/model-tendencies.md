# Model Tendencies — Spec Generation

Known patterns to watch for when Claude generates specs. Use these to self-correct during spec generation and to anticipate issues the ensemble gate will flag.

---

## Claude (Spec Author)

### Strengths
- Excellent at structuring brain dumps into coherent capabilities
- Good at generating realistic Gherkin scenarios
- Naturally produces acceptance criteria that map to testable outcomes
- Strong at identifying edge cases and error scenarios

### Known Spec Generation Artifacts

- **Over-specification**: Generates 15 scenarios when 6 would cover the behavior. Trim to what matters. Each scenario should test a distinct behavioral path, not a minor variation.

- **Verify line verbosity**: Writes multi-line verify commands when a single `curl | jq` pipeline would suffice. Keep verify lines to one line where possible.

- **Missing error scenarios**: Strong on happy paths, weaker on error cases. After generating scenarios, ask: "What happens when input is missing? Invalid? Too large? Unauthorized?" Add scenarios for each.

- **Vague acceptance criteria**: Writes AC like "the system should handle errors gracefully." Replace with specific, testable criteria: "POST /api/tasks with missing title returns 400 with `{error: 'title is required'}`."

- **Task granularity mismatch**: Either decomposes into too many tiny tasks (1 task per endpoint) or too few large tasks (1 task for entire feature). Target 1-2 tasks for STANDARD features.

- **Scope creep in specs**: Brain dump says "add pagination" but the spec includes sorting, filtering, search, and caching. Stick to what was asked. Extra capabilities should be separate brain dumps.

- **$BASE_URL in assertion values**: Puts `$BASE_URL` inside jq assertions instead of only in curl URLs. Linter catches this, but avoid it in the first place.

- **Verify lines that depend on ordering**: Assumes tasks will have sequential IDs or specific creation order. Use creation-then-assertion patterns (create the data, then check it) instead of assuming pre-existing state.

- **Forgetting the `# Verify:` line entirely**: When writing complex scenarios with multiple AND clauses, sometimes generates the Gherkin without any verify lines. The linter will catch this, but aim to write them inline with the scenario.

### Blind Spots

- **Infrastructure assumptions**: Generates verify lines that assume a specific runtime (e.g., Bun vs Node) without checking. Use portable commands.
- **Concurrent access scenarios**: Rarely generates scenarios for concurrent requests or race conditions unless explicitly prompted.
- **Data cleanup**: Verify lines that create test data don't clean it up. For stateful systems, this means verify lines may interact with each other.

---

## Ensemble Gate Reviewers

When the ensemble gate runs on COMPLEX specs, anticipate these patterns:

### PM Reviewer (Claude)
- Focuses on completeness and user value
- Will flag missing user stories or acceptance criteria
- May push for additional features beyond scope — resist scope creep
- Good at catching when a spec describes HOW instead of WHAT

### Architect Reviewer (Claude)
- Focuses on feasibility, tech risk, and integration points
- Will flag missing error handling, security considerations
- May over-engineer — suggests abstractions and patterns prematurely
- Good at catching when a spec creates coupling or breaks existing contracts

### VoC Reviewer (Gemini)
- Focuses on user experience and value proposition
- May flag UX concerns that are valid but out of scope
- Sometimes confuses backend API specs with user-facing features
- Good at catching when acceptance criteria don't map to user outcomes

---

## Spec Quality Checklist

Before finalizing any spec, check against these known issues:

- [ ] Every THEN/AND has a `# Verify:` line
- [ ] All verify lines use `$BASE_URL`, not hardcoded URLs
- [ ] Verify lines use `-e` flag with `jq`
- [ ] Error cases use `-s` (not `-sf`) with curl for status code checks
- [ ] Acceptance criteria are specific and testable (no "should handle gracefully")
- [ ] Task count is appropriate for complexity tier (1-2 for STANDARD)
- [ ] No scope creep beyond the original brain dump
- [ ] Scenarios cover error paths, not just happy paths
- [ ] Each verify line is self-contained (no cross-dependency)
