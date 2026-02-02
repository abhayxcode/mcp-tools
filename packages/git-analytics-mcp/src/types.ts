/**
 * Git Analytics MCP - Type Definitions
 */

/**
 * Represents a single commit result from search
 */
export interface CommitResult {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  message: string;
  body?: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files?: string[];
  relevanceScore?: number;
}

/**
 * File churn information - tracks how often a file changes
 */
export interface FileChurn {
  path: string;
  changeCount: number;
  insertions: number;
  deletions: number;
  netChange: number;
  authors: string[];
  lastModified: string;
  churnRate: number; // Changes per day
  isHotspot: boolean;
}

/**
 * Summary of code churn analysis
 */
export interface ChurnSummary {
  analyzedPeriod: {
    start: string;
    end: string;
    days: number;
  };
  totalFiles: number;
  totalChanges: number;
  hotspotCount: number;
  hotspots: FileChurn[];
  averageChurnRate: number;
  recommendations: string[];
}

/**
 * Statistics for a single contributor
 */
export interface ContributorStats {
  author: string;
  email: string;
  commitCount: number;
  firstCommit: string;
  lastCommit: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  netContribution: number;
  activeDays: number;
  averageCommitSize: number;
  topFiles: Array<{ path: string; changes: number }>;
  streak: {
    current: number;
    longest: number;
  };
}

/**
 * Activity timeline entry
 */
export interface ActivityTimeline {
  period: string; // Date string or week/month identifier
  commits: number;
  authors: string[];
  insertions: number;
  deletions: number;
  filesChanged: number;
}

/**
 * Represents a potentially suspicious commit (for bug tracking)
 */
export interface SuspectedCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
  matchedPatterns: string[];
  affectedLines: Array<{
    file: string;
    lineNumber: number;
    content: string;
  }>;
  suspicionScore: number; // 0-100
  reason: string;
}

/**
 * Timeline of changes for a specific file or pattern
 */
export interface ChangeTimeline {
  file: string;
  pattern?: string;
  firstIntroduced: {
    hash: string;
    author: string;
    date: string;
    message: string;
  };
  subsequentChanges: Array<{
    hash: string;
    author: string;
    date: string;
    message: string;
    changeType: 'modified' | 'deleted' | 'restored';
  }>;
  totalChanges: number;
}

/**
 * Individual health metric
 */
export interface HealthMetric {
  name: string;
  score: number; // 0-100
  weight: number;
  status: 'excellent' | 'good' | 'fair' | 'poor' | 'critical';
  value: string | number;
  description: string;
}

/**
 * Overall repository health assessment
 */
export interface RepoHealth {
  overallScore: number; // 0-100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  metrics: {
    commitFrequency: HealthMetric;
    averageCommitSize: HealthMetric;
    documentationRatio: HealthMetric;
    codeChurnRate: HealthMetric;
    contributorActivity: HealthMetric;
    branchHealth: HealthMetric;
  };
  summary: string;
  recommendations: Array<{
    priority: 'high' | 'medium' | 'low';
    category: string;
    message: string;
    action: string;
  }>;
  analyzedAt: string;
  repositoryInfo: {
    path: string;
    defaultBranch: string;
    totalCommits: number;
    totalContributors: number;
    createdAt: string;
    lastActivity: string;
  };
}

/**
 * Cache entry for expensive operations
 */
export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  key: string;
}

/**
 * Git log entry parsed from raw output
 */
export interface ParsedLogEntry {
  hash: string;
  author: string;
  authorEmail: string;
  date: Date;
  message: string;
  body: string;
}

/**
 * Diff stats for a single file
 */
export interface FileDiffStats {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

/**
 * Tool input schemas (for documentation)
 */
export interface SearchCommitsInput {
  query: string;
  path?: string;
  author?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface AnalyzeCodeChurnInput {
  path?: string;
  days?: number;
  minChanges?: number;
}

export interface GetContributorStatsInput {
  since?: string;
  until?: string;
  groupBy?: 'author' | 'week' | 'month';
}

export interface FindBugIntroductionInput {
  path: string;
  pattern?: string;
  since?: string;
}

export interface GetRepoHealthInput {
  path?: string;
}
