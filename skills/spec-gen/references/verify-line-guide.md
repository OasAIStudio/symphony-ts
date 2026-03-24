# Verify Line Guide — How to Write Executable Verification

Every THEN and AND clause in a Gherkin scenario MUST have a `# Verify:` line. This is enforced by the linter and is the foundation of our pipeline's reliability.

## Rules

1. **`# Verify:` lines are shell commands.** Exit code 0 = pass, non-zero = fail.
2. **Use `$BASE_URL`** for all HTTP targets. Never hardcode `localhost:3000`.
3. **`$BASE_URL` belongs in request URLs only**, not in assertion values.
4. **Each verify line is self-contained.** It must not depend on output from previous verify lines.
5. **Verify lines test behavior, not implementation.** Test what the system does, not how it does it.

## Directives Reference

| Directive | Placement | Required? | Consumed By | Purpose |
|-----------|-----------|-----------|-------------|---------|
| `# Verify:` | After THEN/AND | **Yes** (linter-enforced) | Implement stage | Deterministic behavioral check. Exit 0 = pass. |
| `# Test:` | After any scenario line | No | Implement stage | Agent generates a persistent test file. Descriptive, not executable. |

---

## API Verification Patterns (curl + jq)

These are proven patterns from our pipeline. Use them as templates.

### Pattern 1: Assert response shape

Check that a response has required fields:

```gherkin
Then I receive a task with all required fields
# Verify: curl -sf $BASE_URL/api/tasks/1 | jq -e 'has("id","title","status","createdAt","updatedAt")'
```

**How it works**: `jq -e` exits non-zero if the expression evaluates to `false` or `null`. `has()` checks for key existence.

### Pattern 2: Assert specific field values

Check that a field has an expected value:

```gherkin
Then the task status defaults to "todo"
# Verify: curl -sf -X POST $BASE_URL/api/tasks -H 'Content-Type: application/json' -d '{"title":"Status check"}' | jq -e '.status == "todo"'
```

**How it works**: `jq -e '.field == "value"'` returns true/false. `-e` makes jq exit non-zero on false.

### Pattern 3: Assert HTTP status codes

Check error responses by status code:

```gherkin
Then I receive a 404 response
# Verify: curl -s -o /dev/null -w '%{http_code}' $BASE_URL/api/tasks/99999 | grep -q '404'
```

**How it works**: `-o /dev/null` discards the body. `-w '%{http_code}'` prints only the status code. `grep -q` exits 0 on match.

**Note**: Use `-sf` (silent + fail) for success cases, `-s` (silent only) for error cases. The `-f` flag makes curl exit non-zero on HTTP errors, which you want for success assertions but NOT for error assertions where you're checking the error code itself.

### Pattern 4: Assert array properties

Check collection responses:

```gherkin
Then I receive a JSON array of tasks
# Verify: curl -sf $BASE_URL/api/tasks | jq -e 'type == "array"'

And each task has the required fields
# Verify: curl -sf $BASE_URL/api/tasks | jq -e 'all(has("id","title","status"))'

And the list contains at least 3 items
# Verify: curl -sf $BASE_URL/api/tasks | jq -e 'length >= 3'
```

### Pattern 5: Create-then-verify (stateful sequences)

When a verify line needs setup (create before checking), do it all in one command:

```gherkin
Then the task no longer appears in the task list
# Verify: ID=$(curl -sf -X POST $BASE_URL/api/tasks -H 'Content-Type: application/json' -d '{"title":"Delete me"}' | jq -r '.id') && curl -sf -X DELETE $BASE_URL/api/tasks/$ID && curl -sf $BASE_URL/api/tasks | jq -e "map(select(.id == $ID)) | length == 0"
```

**How it works**: Chain setup → action → assertion with `&&`. If any step fails, the whole line fails.

### Pattern 6: Assert response headers

Check headers like pagination metadata:

```gherkin
Then the response includes a total count header
# Verify: curl -sf -D - $BASE_URL/api/tasks?page=1&limit=10 -o /dev/null | grep -qi 'x-total-count'
```

---

## UI Verification Patterns (Playwright)

For features with a user interface, verify lines reference Playwright test files. The implementing agent writes the Playwright test; the verify line runs it.

### Pattern 1: Run a specific test file

```gherkin
Then the login form renders with email and password fields
# Verify: npx playwright test tests/e2e/login.spec.ts --reporter=json 2>/dev/null | jq -e '.suites[0].specs | all(.ok)'
# Test: Write a Playwright test that navigates to /login and asserts email input, password input, and submit button are visible
```

### Pattern 2: Run a specific test by name

```gherkin
Then clicking submit with invalid credentials shows an error message
# Verify: npx playwright test tests/e2e/login.spec.ts -g "invalid credentials" --reporter=json 2>/dev/null | jq -e '.suites[0].specs | all(.ok)'
# Test: Write a Playwright test that submits invalid credentials and asserts the error message contains "Invalid email or password"
```

### Pattern 3: Check visual state with screenshot comparison

```gherkin
Then the dashboard matches the approved design
# Verify: npx playwright test tests/e2e/dashboard-visual.spec.ts --reporter=json 2>/dev/null | jq -e '.suites[0].specs | all(.ok)'
# Test: Write a Playwright visual regression test for the dashboard page at 1440x900 viewport
```

**Note on UI verify lines**: The `# Test:` directive tells the implementing agent WHAT to test. The `# Verify:` line tells the pipeline HOW to run it. The agent must create the test file first, then the verify line will pass.

---

## Infrastructure Verification Patterns

For changes to configuration, deployment, or non-HTTP infrastructure.

### Pattern 1: File existence and content

```gherkin
Then the config file contains the database URL
# Verify: grep -q 'DATABASE_URL' .env.example
```

### Pattern 2: Script executability

```gherkin
Then the migration script is executable and runs without error
# Verify: test -x scripts/migrate.sh && bash scripts/migrate.sh --dry-run
```

### Pattern 3: Docker/container health

```gherkin
Then the service starts successfully in Docker
# Verify: docker compose up -d --wait && curl -sf http://localhost:3000/health | jq -e '.status == "ok"' && docker compose down
```

### Pattern 4: TypeScript compilation

```gherkin
Then the project compiles without errors
# Verify: npx tsc --noEmit
```

### Pattern 5: Dependency validation

```gherkin
Then all dependencies resolve correctly
# Verify: bun install --frozen-lockfile 2>&1 | tail -1 | grep -qv 'error'
```

---

## Common Mistakes

### Mistake 1: Hardcoded localhost

```gherkin
# WRONG:
# Verify: curl -sf http://localhost:3000/api/tasks | jq -e 'length > 0'

# RIGHT:
# Verify: curl -sf $BASE_URL/api/tasks | jq -e 'length > 0'
```

### Mistake 2: $BASE_URL in assertion values

```gherkin
# WRONG (BASE_URL in the expected value):
# Verify: curl -sf $BASE_URL/api/tasks/1 | jq -e '.url == "$BASE_URL/api/tasks/1"'

# RIGHT (only in request URL):
# Verify: curl -sf $BASE_URL/api/tasks/1 | jq -e '.url | endswith("/api/tasks/1")'
```

### Mistake 3: Missing `-e` flag on jq

```gherkin
# WRONG (jq exits 0 even when expression is false):
# Verify: curl -sf $BASE_URL/api/tasks | jq 'length > 0'

# RIGHT (-e makes jq exit non-zero on false/null):
# Verify: curl -sf $BASE_URL/api/tasks | jq -e 'length > 0'
```

### Mistake 4: Using `-sf` for error status checks

```gherkin
# WRONG (-f makes curl exit non-zero on 4xx/5xx, so grep never runs):
# Verify: curl -sf -o /dev/null -w '%{http_code}' $BASE_URL/api/tasks/bad | grep -q '400'

# RIGHT (use -s only, let the status code through):
# Verify: curl -s -o /dev/null -w '%{http_code}' $BASE_URL/api/tasks/bad | grep -q '400'
```

### Mistake 5: Verify lines that depend on each other

```gherkin
# WRONG (second verify depends on first creating the task):
Then a task is created
# Verify: curl -sf -X POST $BASE_URL/api/tasks -H 'Content-Type: application/json' -d '{"title":"Dep test"}'
And the task appears in the list
# Verify: curl -sf $BASE_URL/api/tasks | jq -e 'map(select(.title == "Dep test")) | length > 0'

# RIGHT (self-contained — creates and checks in one line):
And the task appears in the list after creation
# Verify: curl -sf -X POST $BASE_URL/api/tasks -H 'Content-Type: application/json' -d '{"title":"Dep test"}' && curl -sf $BASE_URL/api/tasks | jq -e 'map(select(.title == "Dep test")) | length > 0'
```

### Mistake 6: Overly complex single verify lines

If a verify line exceeds ~200 characters or has 3+ chained operations, consider whether the scenario should be split into separate scenarios. Each scenario should test one thing.

---

## When You Can't Write a Deterministic Verify Line

Some requirements don't have deterministic, observable outputs. In these cases:

1. **Use `# Test:` instead.** Write a descriptive test directive that the implementing agent will use to generate a test file.

```gherkin
Then the cache is invalidated after update
# Test: Unit test that the cache TTL resets when a task is updated via PATCH
```

2. **Pair `# Test:` with a `# Verify:` that runs the test.**

```gherkin
Then the cache is invalidated after update
# Verify: bun test tests/cache-invalidation.test.ts
# Test: Unit test that the cache TTL resets when a task is updated via PATCH
```

3. **For purely subjective criteria**, omit both directives. The review stage (LLM-as-judge) evaluates these during adversarial review.

**Hierarchy**: Prefer `# Verify:` (deterministic) over `# Test:` (agent-generated) over nothing (review-judged). Use the most deterministic option available.
