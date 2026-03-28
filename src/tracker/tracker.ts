import type { Issue } from "../domain/model.js";

export interface IssueStateSnapshot {
  id: string;
  identifier: string;
  state: string;
}

export interface IssueTracker {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<IssueStateSnapshot[]>;
  fetchIssuesByLabels?(labelNames: string[]): Promise<Issue[]>;
  fetchOpenIssuesByLabels?(
    labelNames: string[],
    excludeStateNames: string[],
  ): Promise<Issue[]>;
  fetchParent?(
    issueId: string,
  ): Promise<{ identifier: string; title: string; url: string } | null>;
}
