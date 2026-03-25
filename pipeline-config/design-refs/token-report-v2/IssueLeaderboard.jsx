/**
 * Section 6: Issue Leaderboard
 * Converted from token-report.mjs:1768–1781 (top-25 table).
 *
 * Props:
 *   - leaderboard: array of { identifier: string, title: string, tokens: number }
 *     Pre-sorted by tokens descending. Only the first 25 are rendered.
 */
import React from "react";
import { fmtNum } from "./chartUtils.jsx";

export default function IssueLeaderboard({ leaderboard }) {
  const items = Array.isArray(leaderboard) ? leaderboard.slice(0, 25) : [];

  return (
    <section>
      <h2>Issue Leaderboard</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Issue</th>
            <th>Title</th>
            <th style={{ textAlign: "right" }}>Tokens</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={item.identifier}>
              <td>{i + 1}</td>
              <td>
                <a
                  href={`https://linear.app/issue/${item.identifier}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {item.identifier}
                </a>
              </td>
              <td>{item.title}</td>
              <td style={{ textAlign: "right" }}>{fmtNum(item.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
