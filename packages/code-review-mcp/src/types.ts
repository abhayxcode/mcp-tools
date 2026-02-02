/**
 * Type definitions for the Code Review Assistant MCP
 */

/**
 * Represents a GitHub Pull Request
 */
export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  user: {
    login: string;
    avatarUrl: string;
  };
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
    sha: string;
  };
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  reviewers: string[];
  assignees: string[];
  url: string;
  htmlUrl: string;
}

/**
 * Represents a file changed in a Pull Request
 */
export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previousFilename?: string;
  contentsUrl: string;
  blobUrl: string;
  rawUrl: string;
}

/**
 * Represents a comment on a Pull Request
 */
export interface Comment {
  id: number;
  body: string;
  user: {
    login: string;
    avatarUrl: string;
  };
  createdAt: string;
  updatedAt: string;
  path?: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
  commitId?: string;
  htmlUrl: string;
  inReplyToId?: number;
}

/**
 * Represents a review on a Pull Request
 */
export interface Review {
  id: number;
  user: {
    login: string;
    avatarUrl: string;
  };
  body: string | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submittedAt: string | null;
  commitId: string | null;
  htmlUrl: string;
}

/**
 * Summary of diff changes
 */
export interface DiffSummary {
  totalAdditions: number;
  totalDeletions: number;
  totalChanges: number;
  filesChanged: number;
  fileBreakdown: {
    filename: string;
    language: string;
    additions: number;
    deletions: number;
    hunks: DiffHunk[];
  }[];
}

/**
 * Represents a hunk in a diff
 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
  changes: DiffChange[];
}

/**
 * Represents a single change in a diff
 */
export interface DiffChange {
  type: 'add' | 'del' | 'normal';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Represents a potential code issue found during review
 */
export interface CodeIssue {
  id: string;
  type: 'security' | 'performance' | 'style' | 'bug' | 'maintainability' | 'documentation';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  file: string;
  line?: number;
  endLine?: number;
  title: string;
  description: string;
  suggestion?: string;
  rule?: string;
}

/**
 * Represents a code improvement suggestion
 */
export interface Suggestion {
  id: string;
  file: string;
  line: number;
  endLine?: number;
  originalCode: string;
  suggestedCode: string;
  reason: string;
  type: 'refactor' | 'optimization' | 'simplification' | 'best-practice' | 'security-fix';
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Represents a review comment to be submitted
 */
export interface ReviewComment {
  path: string;
  body: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
  startLine?: number;
  startSide?: 'LEFT' | 'RIGHT';
}

/**
 * Represents a review suggestion with quality metrics
 */
export interface ReviewSuggestion {
  file: string;
  line?: number;
  category: 'security' | 'performance' | 'style' | 'bug' | 'maintainability';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  suggestedFix?: string;
  references?: string[];
}

/**
 * Result of PR details fetch
 */
export interface PRDetailsResult {
  pullRequest: PullRequest;
  files: ChangedFile[];
  comments: Comment[];
  reviews: Review[];
}

/**
 * Result of diff analysis
 */
export interface DiffAnalysisResult {
  summary: DiffSummary;
  issues: CodeIssue[];
  suggestions: Suggestion[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskFactors: string[];
}

/**
 * Result of adding a review comment
 */
export interface AddCommentResult {
  id: number;
  url: string;
  body: string;
  createdAt: string;
}

/**
 * Result of submitting a review
 */
export interface SubmitReviewResult {
  id: number;
  url: string;
  state: string;
  body: string | null;
  submittedAt: string;
}

/**
 * Result of getting review suggestions
 */
export interface ReviewSuggestionsResult {
  suggestions: ReviewSuggestion[];
  qualityScore: number;
  summary: string;
}

/**
 * GitHub API error
 */
export interface GitHubApiError {
  status: number;
  message: string;
  documentation_url?: string;
}

/**
 * Focus areas for diff analysis
 */
export type FocusArea = 'security' | 'performance' | 'style' | 'bugs' | 'all';

/**
 * Review event type
 */
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
