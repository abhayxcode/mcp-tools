/**
 * Repository Health Assessment Tool
 * Calculate health score and generate recommendations
 */

import { z } from 'zod';
import { simpleGit, SimpleGit } from 'simple-git';
import { format, subDays, differenceInDays } from 'date-fns';
import type { RepoHealth, HealthMetric } from '../types.js';
import {
  analyticsCache,
  calculateHealthMetric,
  calculateOverallScore,
  scoreToGrade,
  generateHealthRecommendations,
} from '../utils/analytics.js';
import { analyzeCodeChurn } from './code-churn.js';

/**
 * Input schema for get_repo_health tool
 */
export const getRepoHealthSchema = z.object({
  path: z.string().optional().describe('Repository path (defaults to current directory)'),
});

export type GetRepoHealthInput = z.infer<typeof getRepoHealthSchema>;

/**
 * Get comprehensive repository health assessment
 */
export async function getRepoHealth(input: GetRepoHealthInput): Promise<RepoHealth> {
  const { path = process.cwd() } = input;

  const git: SimpleGit = simpleGit(path);

  // Validate git repository
  try {
    await git.revparse(['--git-dir']);
  } catch {
    throw new Error(`Not a git repository: ${path}`);
  }

  // Check cache (shorter TTL for health checks)
  const cacheKey = analyticsCache.generateKey('health', path);
  const cached = analyticsCache.get<RepoHealth>(cacheKey);
  if (cached) {
    return { ...cached, analyzedAt: new Date().toISOString() };
  }

  // Gather metrics in parallel
  const [
    commitFrequencyMetric,
    avgCommitSizeMetric,
    documentationMetric,
    churnRateMetric,
    contributorMetric,
    branchHealthMetric,
    repoInfo,
  ] = await Promise.all([
    calculateCommitFrequencyMetric(git),
    calculateAvgCommitSizeMetric(git),
    calculateDocumentationMetric(git),
    calculateChurnRateMetric(path),
    calculateContributorActivityMetric(git),
    calculateBranchHealthMetric(git),
    getRepositoryInfo(git, path),
  ]);

  const metrics = {
    commitFrequency: commitFrequencyMetric,
    averageCommitSize: avgCommitSizeMetric,
    documentationRatio: documentationMetric,
    codeChurnRate: churnRateMetric,
    contributorActivity: contributorMetric,
    branchHealth: branchHealthMetric,
  };

  const allMetrics = Object.values(metrics);
  const overallScore = calculateOverallScore(allMetrics);
  const grade = scoreToGrade(overallScore);
  const recommendations = generateHealthRecommendations(metrics);

  const summary = generateHealthSummary(overallScore, grade, metrics);

  const result: RepoHealth = {
    overallScore,
    grade,
    metrics,
    summary,
    recommendations,
    analyzedAt: new Date().toISOString(),
    repositoryInfo: repoInfo,
  };

  // Cache the result
  analyticsCache.set(cacheKey, result);

  return result;
}

/**
 * Calculate commit frequency metric
 */
async function calculateCommitFrequencyMetric(git: SimpleGit): Promise<HealthMetric> {
  const since = format(subDays(new Date(), 30), 'yyyy-MM-dd');

  const output = await git.raw([
    'rev-list',
    '--count',
    `--since=${since}`,
    'HEAD',
  ]);

  const commitsLast30Days = parseInt(output.trim(), 10) || 0;
  const commitsPerWeek = Math.round((commitsLast30Days / 30) * 7 * 10) / 10;

  return calculateHealthMetric(
    'commitFrequency',
    commitsPerWeek,
    { excellent: 10, good: 5, fair: 2, poor: 0.5 },
    true,
    1.5,
    `${commitsPerWeek}/week`
  );
}

/**
 * Calculate average commit size metric
 */
async function calculateAvgCommitSizeMetric(git: SimpleGit): Promise<HealthMetric> {
  const since = format(subDays(new Date(), 30), 'yyyy-MM-dd');

  const output = await git.raw([
    'log',
    `--since=${since}`,
    '--numstat',
    '--format=',
    '--no-merges',
  ]);

  const lines = output.trim().split('\n').filter(l => l.trim());
  let totalChanges = 0;
  let commitCount = 0;

  let currentCommitChanges = 0;
  for (const line of lines) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (match) {
      const insertions = match[1] === '-' ? 0 : parseInt(match[1] ?? '0', 10);
      const deletions = match[2] === '-' ? 0 : parseInt(match[2] ?? '0', 10);
      currentCommitChanges += insertions + deletions;
    } else if (currentCommitChanges > 0) {
      totalChanges += currentCommitChanges;
      commitCount++;
      currentCommitChanges = 0;
    }
  }

  // Don't forget the last commit
  if (currentCommitChanges > 0) {
    totalChanges += currentCommitChanges;
    commitCount++;
  }

  const avgSize = commitCount > 0 ? Math.round(totalChanges / commitCount) : 0;

  // For commit size, smaller is generally better (atomic commits)
  // But we need to handle zero commits case
  if (commitCount === 0) {
    return {
      name: 'averageCommitSize',
      score: 50,
      weight: 1,
      status: 'fair',
      value: 'N/A',
      description: 'No recent commits to analyze',
    };
  }

  return calculateHealthMetric(
    'averageCommitSize',
    avgSize,
    { excellent: 50, good: 150, fair: 300, poor: 500 },
    false, // Lower is better
    1,
    `${avgSize} lines`
  );
}

/**
 * Calculate documentation ratio metric
 */
async function calculateDocumentationMetric(git: SimpleGit): Promise<HealthMetric> {
  const allFiles = await git.raw(['ls-files']);
  const fileList = allFiles.trim().split('\n').filter(f => f);

  const docPatterns = [
    /\.md$/i,
    /\.mdx$/i,
    /\.rst$/i,
    /\.txt$/i,
    /readme/i,
    /changelog/i,
    /contributing/i,
    /license/i,
    /\.adoc$/i,
  ];

  const docFiles = fileList.filter(f =>
    docPatterns.some(pattern => pattern.test(f))
  );

  // Exclude obvious non-code files
  const codePatterns = [
    /\.(js|ts|jsx|tsx|py|rb|java|go|rs|c|cpp|h|hpp|cs|php|swift|kt)$/i,
  ];

  const codeFiles = fileList.filter(f =>
    codePatterns.some(pattern => pattern.test(f))
  );

  const ratio = codeFiles.length > 0
    ? Math.round((docFiles.length / codeFiles.length) * 100)
    : 0;

  return calculateHealthMetric(
    'documentationRatio',
    ratio,
    { excellent: 15, good: 8, fair: 3, poor: 1 },
    true,
    0.8,
    `${ratio}%`
  );
}

/**
 * Calculate code churn rate metric
 */
async function calculateChurnRateMetric(repoPath: string): Promise<HealthMetric> {
  try {
    const churnResult = await analyzeCodeChurn({ path: repoPath, days: 30, minChanges: 1 });

    // Average changes per file per week
    const avgChurnRate = churnResult.averageChurnRate * 7; // Convert to weekly

    return calculateHealthMetric(
      'codeChurnRate',
      avgChurnRate,
      { excellent: 0.5, good: 1, fair: 2, poor: 4 },
      false, // Lower is better (more stable)
      1.2,
      `${Math.round(avgChurnRate * 100) / 100}/file/week`
    );
  } catch {
    return {
      name: 'codeChurnRate',
      score: 50,
      weight: 1.2,
      status: 'fair',
      value: 'N/A',
      description: 'Could not calculate churn rate',
    };
  }
}

/**
 * Calculate contributor activity metric
 */
async function calculateContributorActivityMetric(git: SimpleGit): Promise<HealthMetric> {
  const since = format(subDays(new Date(), 30), 'yyyy-MM-dd');

  const output = await git.raw([
    'shortlog',
    '-sn',
    `--since=${since}`,
    'HEAD',
  ]);

  const lines = output.trim().split('\n').filter(l => l.trim());
  const activeContributors = lines.length;

  return calculateHealthMetric(
    'contributorActivity',
    activeContributors,
    { excellent: 5, good: 3, fair: 2, poor: 1 },
    true,
    0.8,
    `${activeContributors}`
  );
}

/**
 * Calculate branch health metric
 */
async function calculateBranchHealthMetric(git: SimpleGit): Promise<HealthMetric> {
  // Get all branches
  const branchOutput = await git.raw(['branch', '-a', '--format=%(refname:short) %(committerdate:iso)']);
  const branches = branchOutput.trim().split('\n').filter(b => b.trim());

  let staleBranches = 0;
  const staleThresholdDays = 30;
  const now = new Date();

  for (const branch of branches) {
    const parts = branch.trim().split(/\s+/);
    if (parts.length >= 2) {
      const dateStr = parts.slice(1).join(' ');
      const branchDate = new Date(dateStr);

      if (!isNaN(branchDate.getTime())) {
        const daysSinceActivity = differenceInDays(now, branchDate);
        if (daysSinceActivity > staleThresholdDays) {
          staleBranches++;
        }
      }
    }
  }

  // Stale branch ratio
  const totalBranches = branches.length;
  const staleRatio = totalBranches > 0 ? (staleBranches / totalBranches) * 100 : 0;

  return calculateHealthMetric(
    'branchHealth',
    staleRatio,
    { excellent: 10, good: 25, fair: 50, poor: 75 },
    false, // Lower is better
    0.7,
    `${staleBranches}/${totalBranches} stale`
  );
}

/**
 * Get repository information
 */
async function getRepositoryInfo(git: SimpleGit, repoPath: string): Promise<RepoHealth['repositoryInfo']> {
  // Get default branch
  let defaultBranch = 'main';
  try {
    const remote = await git.raw(['remote', 'show', 'origin']);
    const match = remote.match(/HEAD branch:\s*(.+)/);
    if (match) {
      defaultBranch = match[1]?.trim() ?? 'main';
    }
  } catch {
    // Try to determine from local branches
    try {
      const branches = await git.branchLocal();
      if (branches.all.includes('main')) {
        defaultBranch = 'main';
      } else if (branches.all.includes('master')) {
        defaultBranch = 'master';
      }
    } catch {
      // Keep default
    }
  }

  // Get total commits
  let totalCommits = 0;
  try {
    const count = await git.raw(['rev-list', '--count', 'HEAD']);
    totalCommits = parseInt(count.trim(), 10) || 0;
  } catch {
    // Repository might be empty
  }

  // Get total contributors
  let totalContributors = 0;
  try {
    const shortlog = await git.raw(['shortlog', '-sn', 'HEAD']);
    totalContributors = shortlog.trim().split('\n').filter(l => l.trim()).length;
  } catch {
    // Repository might be empty
  }

  // Get first and last commit dates
  let createdAt = '';
  let lastActivity = '';

  try {
    const firstCommit = await git.raw(['log', '--reverse', '--format=%aI', '-1']);
    createdAt = firstCommit.trim();
  } catch {
    createdAt = 'Unknown';
  }

  try {
    const lastCommit = await git.raw(['log', '--format=%aI', '-1']);
    lastActivity = lastCommit.trim();
  } catch {
    lastActivity = 'Unknown';
  }

  return {
    path: repoPath,
    defaultBranch,
    totalCommits,
    totalContributors,
    createdAt,
    lastActivity,
  };
}

/**
 * Generate health summary
 */
function generateHealthSummary(
  score: number,
  grade: string,
  metrics: Record<string, HealthMetric>
): string {
  const parts: string[] = [];

  parts.push(`Repository health score: ${score}/100 (Grade ${grade}).`);

  // Find strengths
  const strengths = Object.values(metrics)
    .filter(m => m.status === 'excellent' || m.status === 'good')
    .map(m => m.name);

  if (strengths.length > 0) {
    parts.push(`Strengths: ${strengths.join(', ')}.`);
  }

  // Find weaknesses
  const weaknesses = Object.values(metrics)
    .filter(m => m.status === 'poor' || m.status === 'critical')
    .map(m => m.name);

  if (weaknesses.length > 0) {
    parts.push(`Areas needing attention: ${weaknesses.join(', ')}.`);
  }

  return parts.join(' ');
}

/**
 * Get health trend over time
 */
export async function getHealthTrend(
  repoPath: string = process.cwd(),
  weeks: number = 4
): Promise<Array<{ week: string; score: number; grade: string }>> {
  const trends: Array<{ week: string; score: number; grade: string }> = [];

  // This is a simplified implementation
  // A more accurate version would need historical data
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = subDays(new Date(), i * 7 + 7);
    // weekEnd could be used for more accurate historical analysis
    // const weekEnd = subDays(new Date(), i * 7);

    // For now, we'll just return the current health
    // In a real implementation, you'd calculate historical metrics
    const health = await getRepoHealth({ path: repoPath });

    trends.push({
      week: format(weekStart, 'yyyy-MM-dd'),
      score: health.overallScore,
      grade: health.grade,
    });
  }

  return trends;
}

/**
 * Compare health between two repositories
 */
export async function compareRepoHealth(
  repo1Path: string,
  repo2Path: string
): Promise<{
  repo1: { path: string; score: number; grade: string };
  repo2: { path: string; score: number; grade: string };
  comparison: Array<{
    metric: string;
    repo1Score: number;
    repo2Score: number;
    winner: string;
  }>;
}> {
  const [health1, health2] = await Promise.all([
    getRepoHealth({ path: repo1Path }),
    getRepoHealth({ path: repo2Path }),
  ]);

  const comparison: Array<{
    metric: string;
    repo1Score: number;
    repo2Score: number;
    winner: string;
  }> = [];

  for (const [key, metric1] of Object.entries(health1.metrics)) {
    const metric2 = health2.metrics[key as keyof typeof health2.metrics];
    comparison.push({
      metric: key,
      repo1Score: metric1.score,
      repo2Score: metric2.score,
      winner: metric1.score > metric2.score ? repo1Path : metric2.score > metric1.score ? repo2Path : 'tie',
    });
  }

  return {
    repo1: { path: repo1Path, score: health1.overallScore, grade: health1.grade },
    repo2: { path: repo2Path, score: health2.overallScore, grade: health2.grade },
    comparison,
  };
}
