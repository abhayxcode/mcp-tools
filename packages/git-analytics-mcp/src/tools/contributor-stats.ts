/**
 * Contributor Statistics Tool
 * Team contribution analytics with grouping options
 */

import { z } from 'zod';
import { simpleGit, SimpleGit } from 'simple-git';
import { format, subMonths } from 'date-fns';
import type { ContributorStats, ActivityTimeline } from '../types.js';
import { analyticsCache, calculateStreak, groupByPeriod } from '../utils/analytics.js';

/**
 * Input schema for get_contributor_stats tool
 */
export const getContributorStatsSchema = z.object({
  since: z.string().optional().describe('Start date (ISO format or relative)'),
  until: z.string().optional().describe('End date (ISO format or relative)'),
  groupBy: z.enum(['author', 'week', 'month']).default('author').describe('How to group the statistics'),
  path: z.string().optional().describe('Repository path (defaults to current directory)'),
});

export type GetContributorStatsInput = z.infer<typeof getContributorStatsSchema>;

/**
 * Get contributor statistics
 */
export async function getContributorStats(input: GetContributorStatsInput): Promise<{
  contributors?: ContributorStats[];
  timeline?: ActivityTimeline[];
  summary: {
    totalCommits: number;
    totalContributors: number;
    totalInsertions: number;
    totalDeletions: number;
    dateRange: { start: string; end: string };
  };
}> {
  const {
    since = format(subMonths(new Date(), 3), 'yyyy-MM-dd'),
    until,
    groupBy = 'author',
    path = process.cwd(),
  } = input;

  const git: SimpleGit = simpleGit(path);

  // Validate git repository
  try {
    await git.revparse(['--git-dir']);
  } catch {
    throw new Error(`Not a git repository: ${path}`);
  }

  // Check cache
  const cacheKey = analyticsCache.generateKey('contributors', path, since, until, groupBy);
  const cached = analyticsCache.get<{
    contributors?: ContributorStats[];
    timeline?: ActivityTimeline[];
    summary: {
      totalCommits: number;
      totalContributors: number;
      totalInsertions: number;
      totalDeletions: number;
      dateRange: { start: string; end: string };
    };
  }>(cacheKey);
  if (cached) {
    return cached;
  }

  // Build log command
  const logArgs = [
    'log',
    '--numstat',
    '--format=%H|%an|%ae|%aI',
    '--no-merges',
    `--since=${since}`,
  ];

  if (until) {
    logArgs.push(`--until=${until}`);
  }

  const logOutput = await git.raw(logArgs);

  // Parse commits
  const commits: Array<{
    hash: string;
    author: string;
    email: string;
    date: Date;
    files: Array<{ path: string; insertions: number; deletions: number }>;
  }> = [];

  const lines = logOutput.trim().split('\n');
  let currentCommit: {
    hash: string;
    author: string;
    email: string;
    date: Date;
    files: Array<{ path: string; insertions: number; deletions: number }>;
  } | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    // Check if it's a commit header
    const headerMatch = line.match(/^([a-f0-9]{40})\|(.+?)\|(.+?)\|(.+)$/);
    if (headerMatch) {
      if (currentCommit) {
        commits.push(currentCommit);
      }
      currentCommit = {
        hash: headerMatch[1] ?? '',
        author: headerMatch[2] ?? '',
        email: headerMatch[3] ?? '',
        date: new Date(headerMatch[4] ?? ''),
        files: [],
      };
      continue;
    }

    // Parse numstat line
    const statMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (statMatch && currentCommit) {
      const insertions = statMatch[1] === '-' ? 0 : parseInt(statMatch[1] ?? '0', 10);
      const deletions = statMatch[2] === '-' ? 0 : parseInt(statMatch[2] ?? '0', 10);
      const filePath = statMatch[3] ?? '';

      currentCommit.files.push({ path: filePath, insertions, deletions });
    }
  }

  // Don't forget the last commit
  if (currentCommit) {
    commits.push(currentCommit);
  }

  // Calculate totals
  let totalInsertions = 0;
  let totalDeletions = 0;
  const allAuthors = new Set<string>();

  for (const commit of commits) {
    allAuthors.add(commit.author);
    for (const file of commit.files) {
      totalInsertions += file.insertions;
      totalDeletions += file.deletions;
    }
  }

  const dateRange = {
    start: since,
    end: until ?? format(new Date(), 'yyyy-MM-dd'),
  };

  const summary = {
    totalCommits: commits.length,
    totalContributors: allAuthors.size,
    totalInsertions,
    totalDeletions,
    dateRange,
  };

  let result: {
    contributors?: ContributorStats[];
    timeline?: ActivityTimeline[];
    summary: typeof summary;
  };

  if (groupBy === 'author') {
    // Group by author
    const authorMap = new Map<string, {
      email: string;
      commits: Array<{
        hash: string;
        date: Date;
        files: Array<{ path: string; insertions: number; deletions: number }>;
      }>;
    }>();

    for (const commit of commits) {
      const existing = authorMap.get(commit.author);
      if (existing) {
        existing.commits.push({
          hash: commit.hash,
          date: commit.date,
          files: commit.files,
        });
      } else {
        authorMap.set(commit.author, {
          email: commit.email,
          commits: [{
            hash: commit.hash,
            date: commit.date,
            files: commit.files,
          }],
        });
      }
    }

    const contributors: ContributorStats[] = [];

    for (const [author, data] of authorMap) {
      const sortedCommits = data.commits.sort((a, b) => a.date.getTime() - b.date.getTime());
      const commitDates = sortedCommits.map(c => c.date);

      let totalInsertions = 0;
      let totalDeletions = 0;
      const fileChanges = new Map<string, number>();

      for (const commit of data.commits) {
        for (const file of commit.files) {
          totalInsertions += file.insertions;
          totalDeletions += file.deletions;
          fileChanges.set(file.path, (fileChanges.get(file.path) ?? 0) + file.insertions + file.deletions);
        }
      }

      // Get unique days with commits
      const uniqueDays = new Set(commitDates.map(d => format(d, 'yyyy-MM-dd'))).size;

      // Get top files
      const topFiles = Array.from(fileChanges.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([path, changes]) => ({ path, changes }));

      contributors.push({
        author,
        email: data.email,
        commitCount: data.commits.length,
        firstCommit: format(sortedCommits[0]?.date ?? new Date(), 'yyyy-MM-dd'),
        lastCommit: format(sortedCommits[sortedCommits.length - 1]?.date ?? new Date(), 'yyyy-MM-dd'),
        filesChanged: fileChanges.size,
        insertions: totalInsertions,
        deletions: totalDeletions,
        netContribution: totalInsertions - totalDeletions,
        activeDays: uniqueDays,
        averageCommitSize: data.commits.length > 0
          ? Math.round((totalInsertions + totalDeletions) / data.commits.length)
          : 0,
        topFiles,
        streak: calculateStreak(commitDates),
      });
    }

    // Sort by commit count
    contributors.sort((a, b) => b.commitCount - a.commitCount);

    result = { contributors, summary };
  } else {
    // Group by week or month
    const timelineData = commits.map(commit => ({
      date: commit.date,
      author: commit.author,
      insertions: commit.files.reduce((sum, f) => sum + f.insertions, 0),
      deletions: commit.files.reduce((sum, f) => sum + f.deletions, 0),
      filesChanged: commit.files.length,
    }));

    const timeline = groupByPeriod(timelineData, groupBy === 'week' ? 'week' : 'month');

    result = { timeline, summary };
  }

  // Cache the result
  analyticsCache.set(cacheKey, result);

  return result;
}

/**
 * Get contribution heatmap data (commits per day of week and hour)
 */
export async function getContributionHeatmap(
  repoPath: string = process.cwd(),
  since?: string
): Promise<{
  heatmap: Array<{ dayOfWeek: number; hour: number; count: number }>;
  peakTime: { dayOfWeek: string; hour: number };
  totalCommits: number;
}> {
  const git = simpleGit(repoPath);

  const logArgs = [
    'log',
    '--format=%aI',
    '--no-merges',
  ];

  if (since) {
    logArgs.push(`--since=${since}`);
  }

  const output = await git.raw(logArgs);
  const dates = output.trim().split('\n').filter(d => d).map(d => new Date(d));

  // Build heatmap
  const countMap = new Map<string, number>();

  for (const date of dates) {
    const dayOfWeek = date.getDay();
    const hour = date.getHours();
    const key = `${dayOfWeek}-${hour}`;
    countMap.set(key, (countMap.get(key) ?? 0) + 1);
  }

  const heatmap: Array<{ dayOfWeek: number; hour: number; count: number }> = [];
  let maxCount = 0;
  let peakKey = '0-12';

  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const key = `${day}-${hour}`;
      const count = countMap.get(key) ?? 0;
      heatmap.push({ dayOfWeek: day, hour, count });

      if (count > maxCount) {
        maxCount = count;
        peakKey = key;
      }
    }
  }

  const [peakDay, peakHour] = peakKey.split('-').map((s: string) => Number(s));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return {
    heatmap,
    peakTime: {
      dayOfWeek: dayNames[peakDay ?? 0] ?? 'Monday',
      hour: peakHour ?? 12,
    },
    totalCommits: dates.length,
  };
}

/**
 * Compare two contributors' activity
 */
export async function compareContributors(
  author1: string,
  author2: string,
  repoPath: string = process.cwd(),
  since?: string
): Promise<{
  comparison: {
    [author: string]: {
      commits: number;
      insertions: number;
      deletions: number;
      filesChanged: number;
      avgCommitSize: number;
    };
  };
  overlap: {
    filesModifiedByBoth: string[];
    collaborationScore: number;
  };
}> {
  const stats1 = await getContributorStats({
    path: repoPath,
    since,
    groupBy: 'author',
  });

  const contributor1 = stats1.contributors?.find(c =>
    c.author.toLowerCase().includes(author1.toLowerCase()) ||
    c.email.toLowerCase().includes(author1.toLowerCase())
  );

  const contributor2 = stats1.contributors?.find(c =>
    c.author.toLowerCase().includes(author2.toLowerCase()) ||
    c.email.toLowerCase().includes(author2.toLowerCase())
  );

  if (!contributor1 || !contributor2) {
    throw new Error('One or both contributors not found');
  }

  // Find files modified by both
  const files1 = new Set(contributor1.topFiles.map(f => f.path));
  const files2 = new Set(contributor2.topFiles.map(f => f.path));
  const filesModifiedByBoth = Array.from(files1).filter(f => files2.has(f));

  // Calculate collaboration score (percentage of shared files)
  const totalUniqueFiles = new Set([...files1, ...files2]).size;
  const collaborationScore = totalUniqueFiles > 0
    ? Math.round((filesModifiedByBoth.length / totalUniqueFiles) * 100)
    : 0;

  return {
    comparison: {
      [contributor1.author]: {
        commits: contributor1.commitCount,
        insertions: contributor1.insertions,
        deletions: contributor1.deletions,
        filesChanged: contributor1.filesChanged,
        avgCommitSize: contributor1.averageCommitSize,
      },
      [contributor2.author]: {
        commits: contributor2.commitCount,
        insertions: contributor2.insertions,
        deletions: contributor2.deletions,
        filesChanged: contributor2.filesChanged,
        avgCommitSize: contributor2.averageCommitSize,
      },
    },
    overlap: {
      filesModifiedByBoth,
      collaborationScore,
    },
  };
}
