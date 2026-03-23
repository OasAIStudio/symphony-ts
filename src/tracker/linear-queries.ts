const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state {
    name
  }
  labels {
    nodes {
      name
    }
  }
  inverseRelations(first: $relationFirst) {
    nodes {
      type
      issue {
        id
        identifier
        state {
          name
        }
      }
    }
  }
`;

export const LINEAR_CANDIDATE_ISSUES_QUERY = `
  query SymphonyCandidateIssues(
    $projectSlug: String!
    $activeStates: [String!]!
    $first: Int!
    $relationFirst: Int!
    $after: String
  ) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $activeStates } }
      }
      orderBy: createdAt
    ) {
      nodes {
        ${ISSUE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`.trim();

export const LINEAR_ISSUES_BY_STATES_QUERY = `
  query SymphonyIssuesByStates(
    $projectSlug: String!
    $stateNames: [String!]!
    $first: Int!
    $relationFirst: Int!
    $after: String
  ) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $stateNames } }
      }
      orderBy: createdAt
    ) {
      nodes {
        ${ISSUE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`.trim();

export const LINEAR_ISSUE_STATES_BY_IDS_QUERY = `
  query SymphonyIssueStatesByIds($issueIds: [ID!]!) {
    issues(filter: { id: { in: $issueIds } }) {
      nodes {
        id
        identifier
        state {
          name
        }
      }
    }
  }
`.trim();

export const LINEAR_WORKFLOW_STATES_QUERY = `
  query SymphonyWorkflowStates($teamId: String!) {
    workflowStates(filter: { team: { key: { eq: $teamId } } }) {
      nodes {
        id
        name
      }
    }
  }
`.trim();

export const LINEAR_ISSUE_UPDATE_MUTATION = `
  mutation SymphonyIssueUpdate($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
      issue {
        id
        state {
          name
        }
      }
    }
  }
`.trim();

export const LINEAR_CREATE_COMMENT_MUTATION = `
  mutation SymphonyCreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment {
        id
      }
    }
  }
`.trim();

export const LINEAR_ISSUES_BY_LABELS_QUERY = `
  query SymphonyIssuesByLabels(
    $projectSlug: String!
    $labelNames: [String!]!
    $first: Int!
    $relationFirst: Int!
    $after: String
  ) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        labels: { name: { in: $labelNames } }
      }
      orderBy: createdAt
    ) {
      nodes {
        ${ISSUE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`.trim();

export const LINEAR_ISSUE_PARENT_AND_SIBLINGS_QUERY = `
  query SymphonyIssueParentAndSiblings($issueId: String!) {
    issue(id: $issueId) {
      id
      identifier
      parent {
        id
        identifier
        state {
          name
        }
        children {
          nodes {
            id
            identifier
            state {
              name
            }
          }
        }
      }
    }
  }
`.trim();

export const LINEAR_OPEN_ISSUES_BY_LABELS_QUERY = `
  query SymphonyOpenIssuesByLabels(
    $projectSlug: String!
    $labelNames: [String!]!
    $excludeStateNames: [String!]!
    $first: Int!
    $relationFirst: Int!
  ) {
    issues(
      first: $first
      filter: {
        project: { slugId: { eq: $projectSlug } }
        labels: { name: { in: $labelNames } }
        state: { name: { nin: $excludeStateNames } }
      }
      orderBy: createdAt
    ) {
      nodes {
        ${ISSUE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`.trim();
