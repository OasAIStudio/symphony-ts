export function formatRuntimeAndTurns(
  startedAt: string,
  turnCount: number,
  generatedAt: string,
): string {
  const runtime = formatRuntimeSeconds(
    runtimeSecondsFromStartedAt(startedAt, generatedAt),
  );
  return Number.isInteger(turnCount) && turnCount > 0
    ? `${runtime} / ${turnCount}`
    : runtime;
}

export function formatRuntimeSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0m 0s";
  }
  const wholeSeconds = Math.max(0, Math.trunc(seconds));
  const mins = Math.floor(wholeSeconds / 60);
  const secs = wholeSeconds % 60;
  return `${mins}m ${secs}s`;
}

export function runtimeSecondsFromStartedAt(
  startedAt: string,
  generatedAt: string,
): number {
  const start = Date.parse(startedAt);
  const generated = Date.parse(generatedAt);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(generated) ||
    generated < start
  ) {
    return 0;
  }
  return (generated - start) / 1000;
}

export function formatInteger(value: number): string {
  return Number.isFinite(value)
    ? Math.trunc(value).toLocaleString("en-US")
    : "n/a";
}

export function prettyValue(value: unknown): string {
  return value === null || value === undefined
    ? "n/a"
    : JSON.stringify(value, null, 2);
}

export function stateBadgeClass(state: string): string {
  const normalized = state.toLowerCase();
  if (
    normalized.includes("progress") ||
    normalized.includes("running") ||
    normalized.includes("active")
  ) {
    return "state-badge state-badge-active";
  }
  if (
    normalized.includes("blocked") ||
    normalized.includes("error") ||
    normalized.includes("failed")
  ) {
    return "state-badge state-badge-danger";
  }
  if (
    normalized.includes("todo") ||
    normalized.includes("queued") ||
    normalized.includes("pending") ||
    normalized.includes("retry")
  ) {
    return "state-badge state-badge-warning";
  }
  return "state-badge";
}

export function escapeHtml(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
