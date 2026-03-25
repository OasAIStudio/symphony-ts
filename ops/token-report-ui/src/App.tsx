// TODO: SYMPH-142+ will replace this with actual report components
// using Paper `get_jsx` output as the starting point
import analysisData from "./analysis.json";

export default function App() {
  const data = analysisData;
  return (
    <div
      style={{
        background: "#0d1117",
        color: "#c9d1d9",
        minHeight: "100vh",
        padding: "2rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ color: "#58a6ff" }}>Token Report</h1>
      <p>
        Analyzed at: {data.analyzed_at} &middot; Data span:{" "}
        {data.data_span_days} days &middot; Records: {data.record_count}
      </p>
      <section>
        <h2 style={{ color: "#58a6ff" }}>Executive Summary</h2>
        <ul>
          <li>
            Total tokens:{" "}
            {data.executive_summary.total_tokens.value.toLocaleString()}
          </li>
          <li>Total stages: {data.executive_summary.total_stages.value}</li>
          <li>Unique issues: {data.executive_summary.unique_issues.value}</li>
        </ul>
      </section>
      <section>
        <h2 style={{ color: "#58a6ff" }}>Efficiency Scorecard</h2>
        <ul>
          <li>
            Cache efficiency:{" "}
            {(data.efficiency_scorecard.cache_efficiency.current * 100).toFixed(
              1,
            )}
            %
          </li>
          <li>
            Output ratio:{" "}
            {(data.efficiency_scorecard.output_ratio.current * 100).toFixed(1)}%
          </li>
          <li>
            Tokens per turn:{" "}
            {Math.round(
              data.efficiency_scorecard.tokens_per_turn.current,
            ).toLocaleString()}
          </li>
          <li>
            First pass rate:{" "}
            {data.efficiency_scorecard.first_pass_rate.current.toFixed(1)}%
          </li>
        </ul>
      </section>
    </div>
  );
}
