import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("mobile-dashboard.html", () => {
  const htmlPath = resolve(
    import.meta.dirname,
    "../../.symphony/reports/mobile-dashboard.html",
  );
  const html = readFileSync(htmlPath, "utf-8");

  it("is a valid HTML document", () => {
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("</html>");
  });

  it("includes viewport meta with viewport-fit=cover", () => {
    expect(html).toContain("viewport-fit=cover");
  });

  it("loads Inter and JetBrains Mono from Google Fonts", () => {
    expect(html).toContain("fonts.googleapis.com");
    expect(html).toContain("Inter");
    expect(html).toContain("JetBrains+Mono");
  });

  it("respects safe-area-inset CSS environment variables", () => {
    expect(html).toContain("env(safe-area-inset-top)");
    expect(html).toContain("env(safe-area-inset-bottom)");
    expect(html).toContain("env(safe-area-inset-left)");
    expect(html).toContain("env(safe-area-inset-right)");
  });

  it("includes port configuration flow", () => {
    expect(html).toContain("port-overlay");
    expect(html).toContain("port-input");
    expect(html).toContain("port-connect");
    expect(html).toContain("symphony_base_url");
  });

  it("includes pipeline home screen elements", () => {
    // Status bar counts
    expect(html).toContain("count-running");
    expect(html).toContain("count-retrying");
    expect(html).toContain("count-completed");
    expect(html).toContain("count-failed");
    // Issue card rendering
    expect(html).toContain("issue-card");
    expect(html).toContain("issue-title");
    // Retry section
    expect(html).toContain("retry-card");
  });

  it("includes issue detail screen elements", () => {
    // Stage breakdown bar
    expect(html).toContain("stage-bar");
    expect(html).toContain("stage-bar-segment");
    // Live metrics
    expect(html).toContain("metrics-grid");
    expect(html).toContain("metric-card");
    // Activity feed
    expect(html).toContain("activity-section");
    expect(html).toContain("activity-item");
    // Linear deep link
    expect(html).toContain("linear.app/issue");
  });

  it("includes reports tab", () => {
    expect(html).toContain("screen-reports");
    expect(html).toContain("reports-content");
    expect(html).toContain("report-item");
  });

  it("uses SSE EventSource for live updates", () => {
    expect(html).toContain("EventSource");
    expect(html).toContain("/api/v1/events");
  });

  it("uses dark theme with Linear-inspired colors", () => {
    expect(html).toContain("color-scheme: dark");
    // Linear accent purple
    expect(html).toContain("#5e6ad2");
  });

  it("has hold-to-confirm for destructive stop action (2 seconds)", () => {
    expect(html).toContain("hold-btn");
    expect(html).toContain("hold-to-confirm");
    // 2 second hold duration
    expect(html).toMatch(
      /setTimeout\(\s*\(\)\s*=>\s*\{[^}]*\}\s*,\s*2000\s*\)/s,
    );
  });

  it("has CORS-compatible Access-Control-Allow-Origin: * pattern noted", () => {
    // The dashboard connects to servers that set CORS: *, it does not set its own
    // Verify it does not hardcode a specific origin
    expect(html).not.toContain("Access-Control-Allow-Origin");
  });

  it("does not hardcode localhost in connection logic", () => {
    // Port config should construct URL dynamically, not hardcode connections
    // The parseBaseUrl function uses localhost only as fallback for bare port numbers
    // which is the expected behavior for local development per spec
    const scriptSection = html.slice(html.indexOf("<script>"));
    // Ensure no hardcoded fetch URLs to localhost
    expect(scriptSection).not.toMatch(/fetch\s*\(\s*['"]https?:\/\/localhost/);
    expect(scriptSection).not.toMatch(
      /fetch\s*\(\s*['"]https?:\/\/127\.0\.0\.1/,
    );
    // EventSource should use baseUrl variable, not hardcoded
    expect(scriptSection).toContain("${baseUrl}/api/v1/events");
  });

  it("includes 4-tab navigation bar (pipeline, queue, deploy, reports)", () => {
    expect(html).toContain('data-tab="pipeline"');
    expect(html).toContain('data-tab="queue"');
    expect(html).toContain('data-tab="deploy"');
    expect(html).toContain('data-tab="reports"');
    expect(html).toContain("tab-bar");
  });

  it("includes queue screen with sections for alerts, in-queue, merged, rejected", () => {
    expect(html).toContain("screen-queue");
    expect(html).toContain("queue-content");
    expect(html).toContain("queue-badge-alert");
    expect(html).toContain("queue-badge-queued");
    expect(html).toContain("queue-badge-merged");
    expect(html).toContain("queue-badge-rejected");
  });

  it("fetches queue data from /api/v1/queue", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("/api/v1/queue");
  });

  it("includes deploy screen with preview, version display, and output", () => {
    expect(html).toContain("screen-deploy");
    expect(html).toContain("deploy-content");
    expect(html).toContain("deploy-version-card");
    expect(html).toContain("deploy-output");
    expect(html).toContain("deploy-status-banner");
  });

  it("fetches deploy preview from POST /api/v1/deploy/preview", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("/api/v1/deploy/preview");
    expect(scriptSection).toContain("method: 'POST'");
  });

  it("shows warning when issues are running during deploy", () => {
    expect(html).toContain("deploy-warning");
    expect(html).toContain("running_issues_count");
  });

  it("streams deploy output via SSE with deploy_output events", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("deploy_output");
    expect(scriptSection).toContain("deploy_complete");
    expect(scriptSection).toContain("/api/v1/deploy/stream");
  });

  it("includes stop confirmation bottom sheet", () => {
    expect(html).toContain("stop-sheet");
    expect(html).toContain("bottom-sheet");
    expect(html).toContain("stop-checklist");
    expect(html).toContain("stop-sheet-btn");
  });

  it("stop bottom sheet uses hold-to-confirm pattern", () => {
    expect(html).toContain("Hold to Confirm Stop");
    expect(html).toContain("wireHoldToConfirm");
  });

  it("stop bottom sheet shows per-step success/failure", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("stop-check-icon");
    expect(scriptSection).toContain("success");
    expect(scriptSection).toContain("failed");
    // Per-step results from stop endpoint
    expect(scriptSection).toContain("data.steps");
  });

  it("deploy uses hold-to-confirm pattern", () => {
    expect(html).toContain("deploy-btn");
    expect(html).toContain("Hold to Deploy");
  });

  it("never deploys without showing preview first", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("preview has not loaded");
  });

  it("never auto-retries a failed stop action", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).not.toMatch(/stopIssue.*retry/i);
  });

  it("handles queue/deploy 404 gracefully", () => {
    const scriptSection = html.slice(html.indexOf("<script>"));
    expect(scriptSection).toContain("resp.status === 404");
  });
});
