/**
 * Code Churn Analysis Tool
 * Identify files with high change frequency (hotspots)
 */

import { z } from 'zod';
import { simpleGit, SimpleGit } from 'simple-git';
import { subDays, format } from 'date-fns';
import type { FileChurn, ChurnSummary } from '../types.js';
import {
  analyticsCache,
  calculateChurnRate,
  identifyHotspots,
  generateChurnSummary,
} from '../utils/analytics.js';

/**
 * Input schema for analyze_code_churn tool
 */
export const analyzeCodeChurnSchema = z.object({
  path: z.string().optional().describe('Repository path (defaults to current directory)'),
  days: z.number().min(1).max(365).default(30).describe('Number of days to analyze'),
  minChanges: z.number().min(1).default(3).describe('Minimum number of changes to be considered'),
});

export type AnalyzeCodeChurnInput = z.infer<typeof analyzeCodeChurnSchema>;

/**
 * Analyze code churn to identify hotspots
 */
export async function analyzeCodeChurn(input: AnalyzeCodeChurnInput): Promise<ChurnSummary> {
  const { path = process.cwd(), days = 30, minChanges = 3 } = input;

  const git: SimpleGit = simpleGit(path);

  // Validate git repository
  try {
    await git.revparse(['--git-dir']);
  } catch {
    throw new Error(`Not a git repository: ${path}`);
  }

  // Check cache
  const cacheKey = analyticsCache.generateKey('churn', path, days, minChanges);
  const cached = analyticsCache.get<ChurnSummary>(cacheKey);
  if (cached) {
    return { ...cached, analyzedPeriod: { ...cached.analyzedPeriod } };
  }

  const endDate = new Date();
  const startDate = subDays(endDate, days);
  const sinceDate = format(startDate, 'yyyy-MM-dd');

  // Get all commits in the time range with file stats
  const logOutput = await git.raw([
    'log',
    `--since=${sinceDate}`,
    '--numstat',
    '--format=%H|%an|%aI',
    '--no-merges',
  ]);

  // Parse the output
  const fileChanges = new Map<string, {
    changeCount: number;
    insertions: number;
    deletions: number;
    authors: Set<string>;
    lastModified: Date;
  }>();

  const lines = logOutput.trim().split('\n');
  let currentCommit: { hash: string; author: string; date: Date } | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    // Check if it's a commit header
    if (line.includes('|')) {
      const parts = line.split('|');
      if (parts.length >= 3 && parts[0]?.match(/^[a-f0-9]{40}$/)) {
        currentCommit = {
          hash: parts[0],
          author: parts[1] ?? '',
          date: new Date(parts[2] ?? ''),
        };
        continue;
      }
    }

    // Parse numstat line (insertions\tdeletions\tfilename)
    const statMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (statMatch && currentCommit) {
      const [, insertionsStr, deletionsStr, filePath] = statMatch;

      // Skip binary files
      if (insertionsStr === '-' || deletionsStr === '-') continue;
      if (!filePath) continue;

      const insertions = parseInt(insertionsStr ?? '0', 10);
      const deletions = parseInt(deletionsStr ?? '0', 10);

      const existing = fileChanges.get(filePath);
      if (existing) {
        existing.changeCount++;
        existing.insertions += insertions;
        existing.deletions += deletions;
        existing.authors.add(currentCommit.author);
        if (currentCommit.date > existing.lastModified) {
          existing.lastModified = currentCommit.date;
        }
      } else {
        fileChanges.set(filePath, {
          changeCount: 1,
          insertions,
          deletions,
          authors: new Set([currentCommit.author]),
          lastModified: currentCommit.date,
        });
      }
    }
  }

  // Convert to FileChurn array
  const files: FileChurn[] = [];

  for (const [filePath, data] of fileChanges) {
    if (data.changeCount < minChanges) continue;

    const churnRate = calculateChurnRate(data.changeCount, days);

    files.push({
      path: filePath,
      changeCount: data.changeCount,
      insertions: data.insertions,
      deletions: data.deletions,
      netChange: data.insertions - data.deletions,
      authors: Array.from(data.authors),
      lastModified: format(data.lastModified, 'yyyy-MM-dd HH:mm:ss'),
      churnRate,
      isHotspot: false, // Will be set by identifyHotspots
    });
  }

  // Identify hotspots
  const hotspotsIdentified = identifyHotspots(files, { minChanges });

  // Mark hotspots in the original files array
  const hotspotPaths = new Set(hotspotsIdentified.map(h => h.path));
  for (const file of files) {
    file.isHotspot = hotspotPaths.has(file.path);
  }

  // Sort files by change count
  files.sort((a, b) => b.changeCount - a.changeCount);

  // Generate summary
  const summary = generateChurnSummary(files, startDate, endDate);

  // Cache the result
  analyticsCache.set(cacheKey, summary);

  return summary;
}

/**
 * Get detailed churn history for a specific file
 */
export async function getFileChurnHistory(
  filePath: string,
  repoPath: string = process.cwd(),
  days: number = 90
): Promise<{
  file: string;
  history: Array<{
    date: string;
    author: string;
    hash: string;
    message: string;
    insertions: number;
    deletions: number;
  }>;
  summary: {
    totalChanges: number;
    totalInsertions: number;
    totalDeletions: number;
    uniqueAuthors: number;
    averageChangeSize: number;
  };
}> {
  const git = simpleGit(repoPath);
  const sinceDate = format(subDays(new Date(), days), 'yyyy-MM-dd');

  const logOutput = await git.raw([
    'log',
    `--since=${sinceDate}`,
    '--numstat',
    '--format=%H|%an|%aI|%s',
    '--follow',
    '--',
    filePath,
  ]);

  const history: Array<{
    date: string;
    author: string;
    hash: string;
    message: string;
    insertions: number;
    deletions: number;
  }> = [];

  const lines = logOutput.trim().split('\n');
  let currentCommit: { hash: string; author: string; date: string; message: string } | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    // Check if it's a commit header
    const headerMatch = line.match(/^([a-f0-9]{40})\|(.+?)\|(.+?)\|(.*)$/);
    if (headerMatch) {
      currentCommit = {
        hash: headerMatch[1] ?? '',
        author: headerMatch[2] ?? '',
        date: headerMatch[3] ?? '',
        message: headerMatch[4] ?? '',
      };
      continue;
    }

    // Parse numstat line
    const statMatch = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (statMatch && currentCommit) {
      const insertions = statMatch[1] === '-' ? 0 : parseInt(statMatch[1] ?? '0', 10);
      const deletions = statMatch[2] === '-' ? 0 : parseInt(statMatch[2] ?? '0', 10);

      history.push({
        date: currentCommit.date,
        author: currentCommit.author,
        hash: currentCommit.hash.substring(0, 7),
        message: currentCommit.message,
        insertions,
        deletions,
      });
    }
  }

  // Calculate summary
  const totalInsertions = history.reduce((sum, h) => sum + h.insertions, 0);
  const totalDeletions = history.reduce((sum, h) => sum + h.deletions, 0);
  const uniqueAuthors = new Set(history.map(h => h.author)).size;

  return {
    file: filePath,
    history,
    summary: {
      totalChanges: history.length,
      totalInsertions,
      totalDeletions,
      uniqueAuthors,
      averageChangeSize: history.length > 0
        ? Math.round((totalInsertions + totalDeletions) / history.length)
        : 0,
    },
  };
}

/**
 * Analyze churn by directory
 */
export async function analyzeDirectoryChurn(
  repoPath: string = process.cwd(),
  days: number = 30
): Promise<Array<{
  directory: string;
  fileCount: number;
  totalChanges: number;
  churnRate: number;
  topFiles: string[];
}>> {
  const churnResult = await analyzeCodeChurn({ path: repoPath, days, minChanges: 1 });

  // Group by directory
  const dirMap = new Map<string, {
    fileCount: number;
    totalChanges: number;
    files: Array<{ path: string; changes: number }>;
  }>();

  for (const file of churnResult.hotspots) {
    const parts = file.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';

    const existing = dirMap.get(dir);
    if (existing) {
      existing.fileCount++;
      existing.totalChanges += file.changeCount;
      existing.files.push({ path: file.path, changes: file.changeCount });
    } else {
      dirMap.set(dir, {
        fileCount: 1,
        totalChanges: file.changeCount,
        files: [{ path: file.path, changes: file.changeCount }],
      });
    }
  }

  // Convert to array and sort
  const directories = Array.from(dirMap.entries()).map(([directory, data]) => ({
    directory,
    fileCount: data.fileCount,
    totalChanges: data.totalChanges,
    churnRate: calculateChurnRate(data.totalChanges, days),
    topFiles: data.files
      .sort((a, b) => b.changes - a.changes)
      .slice(0, 5)
      .map(f => f.path),
  }));

  return directories.sort((a, b) => b.totalChanges - a.totalChanges);
}
