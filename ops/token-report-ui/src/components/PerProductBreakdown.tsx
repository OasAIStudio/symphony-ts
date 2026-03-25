/**
 * Section 8: Per-Product Breakdown
 * Converted from design reference PerProductBreakdown.jsx.
 */
import type { ProductData } from "../types.ts";
import { fmtNum } from "./chartUtils.tsx";

function round(n: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export interface PerProductBreakdownProps {
  perProduct: Record<string, ProductData>;
}

export default function PerProductBreakdown({
  perProduct,
}: PerProductBreakdownProps) {
  const products = perProduct ?? {};
  const totalTokens =
    Object.values(products).reduce((s, p) => s + (p.total_tokens ?? 0), 0) || 1;

  const sorted = Object.entries(products).sort(
    (a, b) => (b[1].total_tokens ?? 0) - (a[1].total_tokens ?? 0),
  );

  return (
    <section>
      <h2>Per-Product Breakdown</h2>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th style={{ textAlign: "right" }}>Tokens</th>
            <th style={{ textAlign: "right" }}>Stages</th>
            <th style={{ textAlign: "right" }}>Issues</th>
            <th>Share</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(([name, data]) => {
            const pct = round((data.total_tokens / totalTokens) * 100, 1);
            return (
              <tr key={name}>
                <td>{name}</td>
                <td style={{ textAlign: "right" }}>
                  {fmtNum(data.total_tokens)}
                </td>
                <td style={{ textAlign: "right" }}>{data.total_stages}</td>
                <td style={{ textAlign: "right" }}>{data.unique_issues}</td>
                <td>
                  <div className="product-bar" style={{ width: `${pct}%` }} />{" "}
                  {pct}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
