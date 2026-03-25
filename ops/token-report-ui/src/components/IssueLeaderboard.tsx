/**
 * Section 6: Issue Leaderboard
 * Converted from design reference IssueLeaderboard.jsx.
 *
 * TODO: IssueLeaderboard data is not in the current analysis.json shape.
 * The leaderboard prop should be populated once computeAnalysis() is extended
 * to include per-issue token totals.
 */
import { fmtNum } from "./chartUtils.tsx";

export interface LeaderboardItem {
  identifier: string;
  title: string;
  tokens: number;
}

export interface IssueLeaderboardProps {
  leaderboard: LeaderboardItem[];
}

export default function IssueLeaderboard({
  leaderboard,
}: IssueLeaderboardProps) {
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
