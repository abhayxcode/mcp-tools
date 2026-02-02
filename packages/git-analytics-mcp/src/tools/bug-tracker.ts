/**
 * Bug Introduction Tracker Tool
 * Git bisect-style analysis to find when code patterns were introduced
 */

import { z } from 'zod';
import { simpleGit, SimpleGit } from 'simple-git';
import { format, subMonths } from 'date-fns';
import type { SuspectedCommit, ChangeTimeline } from '../types.js';
import { analyticsCache } from '../utils/analytics.js';

/**
 * Input schema for find_bug_introduction tool
 */
export const findBugIntroductionSchema = z.object({
  path: z.string().describe('File path to analyze'),
  pattern: z.string().optional().describe('Code pattern to search for (regex)'),
  since: z.string().optional().describe('How far back to search (ISO date or relative)'),
  repoPath: z.string().optional().describe('Repository path (defaults to current directory)'),
});

export type FindBugIntroductionInput = z.infer<typeof findBugIntroductionSchema>;

/**
 * Find when a specific code pattern was introduced
 */
export async function findBugIntroduction(input: FindBugIntroductionInput): Promise<{
  timeline: ChangeTimeline;
  suspectedCommits: SuspectedCommit[];
  analysis: {
    totalChanges: number;
    patternFound: boolean;
    firstIntroduction: string | null;
    riskLevel: 'low' | 'medium' | 'high';
    recommendation: string;
  };
}> {
  const {
    path: filePath,
    pattern,
    since = format(subMonths(new Date(), 6), 'yyyy-MM-dd'),
    repoPath = process.cwd(),
  } = input;

  const git: SimpleGit = simpleGit(repoPath);

  // Validate git repository
  try {
    await git.revparse(['--git-dir']);
  } catch {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  // Check if file exists in repository
  try {
    await git.raw(['ls-files', '--error-unmatch', filePath]);
  } catch {
    throw new Error(`File not found in repository: ${filePath}`);
  }

  // Check cache
  const cacheKey = analyticsCache.generateKey('bug-track', repoPath, filePath, pattern, since);
  const cached = analyticsCache.get<{
    timeline: ChangeTimeline;
    suspectedCommits: SuspectedCommit[];
    analysis: {
      totalChanges: number;
      patternFound: boolean;
      firstIntroduction: string | null;
      riskLevel: 'low' | 'medium' | 'high';
      recommendation: string;
    };
  }>(cacheKey);
  if (cached) {
    return cached;
  }

  // Get commit history for the file
  const logOutput = await git.raw([
    'log',
    `--since=${since}`,
    '--format=%H|%an|%aI|%s',
    '--follow',
    '-p',
    '--',
    filePath,
  ]);

  // Parse commits and their diffs
  const commits: Array<{
    hash: string;
    author: string;
    date: string;
    message: string;
    diff: string;
    addedLines: Array<{ lineNumber: number; content: string }>;
    removedLines: Array<{ lineNumber: number; content: string }>;
  }> = [];

  const sections = logOutput.split(/(?=^[a-f0-9]{40}\|)/m);

  for (const section of sections) {
    if (!section.trim()) continue;

    const lines = section.split('\n');
    const headerLine = lines[0];

    if (!headerLine) continue;

    const headerMatch = headerLine.match(/^([a-f0-9]{40})\|(.+?)\|(.+?)\|(.*)$/);
    if (!headerMatch) continue;

    const commit = {
      hash: headerMatch[1] ?? '',
      author: headerMatch[2] ?? '',
      date: headerMatch[3] ?? '',
      message: headerMatch[4] ?? '',
      diff: lines.slice(1).join('\n'),
      addedLines: [] as Array<{ lineNumber: number; content: string }>,
      removedLines: [] as Array<{ lineNumber: number; content: string }>,
    };

    // Parse diff to extract added/removed lines
    let lineNumber = 0;
    let inHunk = false;

    for (const line of lines.slice(1)) {
      // Check for hunk header
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        lineNumber = parseInt(hunkMatch[1] ?? '0', 10) - 1;
        inHunk = true;
        continue;
      }

      if (inHunk) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          lineNumber++;
          commit.addedLines.push({
            lineNumber,
            content: line.substring(1),
          });
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          commit.removedLines.push({
            lineNumber,
            content: line.substring(1),
          });
        } else if (!line.startsWith('\\')) {
          lineNumber++;
        }
      }
    }

    commits.push(commit);
  }

  // Reverse to get chronological order
  commits.reverse();

  // Find pattern matches if specified
  const suspectedCommits: SuspectedCommit[] = [];
  let firstPatternIntroduction: typeof commits[0] | null = null;

  if (pattern) {
    const regex = new RegExp(pattern, 'gi');

    for (const commit of commits) {
      const matchedLines: Array<{ file: string; lineNumber: number; content: string }> = [];
      const matchedPatterns: string[] = [];

      for (const line of commit.addedLines) {
        const matches = line.content.match(regex);
        if (matches) {
          matchedPatterns.push(...matches);
          matchedLines.push({
            file: filePath,
            lineNumber: line.lineNumber,
            content: line.content.trim(),
          });
        }
      }

      if (matchedLines.length > 0) {
        if (!firstPatternIntroduction) {
          firstPatternIntroduction = commit;
        }

        // Calculate suspicion score
        const suspicionScore = calculateSuspicionScore(commit, matchedLines.length);

        suspectedCommits.push({
          hash: commit.hash,
          shortHash: commit.hash.substring(0, 7),
          author: commit.author,
          date: commit.date,
          message: commit.message,
          matchedPatterns: [...new Set(matchedPatterns)],
          affectedLines: matchedLines,
          suspicionScore,
          reason: generateSuspicionReason(commit, matchedLines.length, suspicionScore),
        });
      }
    }
  }

  // Build timeline
  const firstCommit = commits[0];
  const subsequentChanges = commits.slice(1).map(c => ({
    hash: c.hash,
    author: c.author,
    date: c.date,
    message: c.message,
    changeType: determineChangeType(c.addedLines.length, c.removedLines.length),
  }));

  const timeline: ChangeTimeline = {
    file: filePath,
    pattern,
    firstIntroduced: firstCommit
      ? {
          hash: firstCommit.hash,
          author: firstCommit.author,
          date: firstCommit.date,
          message: firstCommit.message,
        }
      : {
          hash: '',
          author: '',
          date: '',
          message: 'No commits found',
        },
    subsequentChanges,
    totalChanges: commits.length,
  };

  // Sort suspected commits by suspicion score
  suspectedCommits.sort((a, b) => b.suspicionScore - a.suspicionScore);

  // Generate analysis
  const riskLevel = calculateRiskLevel(suspectedCommits, commits.length);
  const analysis = {
    totalChanges: commits.length,
    patternFound: suspectedCommits.length > 0,
    firstIntroduction: firstPatternIntroduction?.hash.substring(0, 7) ?? null,
    riskLevel,
    recommendation: generateRecommendation(riskLevel, suspectedCommits.length, pattern),
  };

  const result = { timeline, suspectedCommits, analysis };

  // Cache the result
  analyticsCache.set(cacheKey, result);

  return result;
}

/**
 * Calculate suspicion score for a commit
 */
function calculateSuspicionScore(
  commit: { message: string; addedLines: unknown[]; removedLines: unknown[] },
  matchCount: number
): number {
  let score = 0;

  // More matches = higher score
  score += Math.min(matchCount * 15, 50);

  // Check commit message for suspicious keywords
  const suspiciousKeywords = [
    'fix', 'bug', 'hotfix', 'patch', 'workaround', 'hack',
    'temporary', 'todo', 'fixme', 'quick', 'urgent',
  ];

  const messageLower = commit.message.toLowerCase();
  for (const keyword of suspiciousKeywords) {
    if (messageLower.includes(keyword)) {
      score += 10;
    }
  }

  // Large number of changes in a single commit
  const totalChanges = commit.addedLines.length + commit.removedLines.length;
  if (totalChanges > 100) {
    score += 15;
  } else if (totalChanges > 50) {
    score += 10;
  }

  // Cap at 100
  return Math.min(score, 100);
}

/**
 * Generate reason for suspicion
 */
function generateSuspicionReason(
  commit: { message: string; addedLines: unknown[]; removedLines: unknown[] },
  matchCount: number,
  _score: number
): string {
  const reasons: string[] = [];

  if (matchCount > 1) {
    reasons.push(`Pattern matched ${matchCount} times`);
  } else {
    reasons.push('Pattern match found');
  }

  const messageLower = commit.message.toLowerCase();
  if (messageLower.includes('fix') || messageLower.includes('bug')) {
    reasons.push('Commit message indicates bug fix');
  }
  if (messageLower.includes('hotfix') || messageLower.includes('urgent')) {
    reasons.push('Marked as urgent/hotfix');
  }

  const totalChanges = commit.addedLines.length + commit.removedLines.length;
  if (totalChanges > 100) {
    reasons.push('Large commit with many changes');
  }

  return reasons.join('; ');
}

/**
 * Determine change type based on additions and deletions
 */
function determineChangeType(
  additions: number,
  deletions: number
): 'modified' | 'deleted' | 'restored' {
  if (deletions > 0 && additions === 0) {
    return 'deleted';
  }
  if (additions > 0 && deletions === 0) {
    return 'restored';
  }
  return 'modified';
}

/**
 * Calculate overall risk level
 */
function calculateRiskLevel(
  suspectedCommits: SuspectedCommit[],
  totalCommits: number
): 'low' | 'medium' | 'high' {
  if (suspectedCommits.length === 0) {
    return 'low';
  }

  const highSuspicionCommits = suspectedCommits.filter(c => c.suspicionScore >= 70);
  const suspicionRatio = suspectedCommits.length / Math.max(totalCommits, 1);

  if (highSuspicionCommits.length >= 3 || suspicionRatio > 0.5) {
    return 'high';
  }

  if (highSuspicionCommits.length >= 1 || suspicionRatio > 0.2) {
    return 'medium';
  }

  return 'low';
}

/**
 * Generate recommendation based on analysis
 */
function generateRecommendation(
  riskLevel: 'low' | 'medium' | 'high',
  suspectedCount: number,
  pattern?: string
): string {
  if (!pattern) {
    return 'No pattern specified. Showing file change history.';
  }

  switch (riskLevel) {
    case 'high':
      return `High risk: ${suspectedCount} commits introduced the pattern. ` +
        'Review all suspected commits carefully and consider refactoring.';
    case 'medium':
      return `Medium risk: Pattern found in ${suspectedCount} commit(s). ` +
        'Review the suspected commits to understand the context.';
    case 'low':
      return suspectedCount > 0
        ? `Low risk: Pattern found but appears intentional. Verify the implementation.`
        : `Pattern "${pattern}" not found in recent history. ` +
          'Consider extending the search range or checking if the file was renamed.';
  }
}

/**
 * Find all commits that introduced a pattern across the repository
 */
export async function findPatternAcrossRepo(
  pattern: string,
  repoPath: string = process.cwd(),
  options: { since?: string; fileGlob?: string } = {}
): Promise<Array<{
  file: string;
  commits: Array<{
    hash: string;
    author: string;
    date: string;
    message: string;
    matchCount: number;
  }>;
}>> {
  const git = simpleGit(repoPath);
  const { since = format(subMonths(new Date(), 3), 'yyyy-MM-dd'), fileGlob } = options;

  // Use git log with -S to find commits that added/removed the pattern
  const logArgs = [
    'log',
    `--since=${since}`,
    `-S${pattern}`,
    '--format=%H|%an|%aI|%s',
    '--name-only',
  ];

  if (fileGlob) {
    logArgs.push('--', fileGlob);
  }

  const output = await git.raw(logArgs);

  const results = new Map<string, Array<{
    hash: string;
    author: string;
    date: string;
    message: string;
    matchCount: number;
  }>>();

  const lines = output.trim().split('\n');
  let currentCommit: { hash: string; author: string; date: string; message: string } | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;

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

    // This is a filename
    if (currentCommit && !line.includes('|')) {
      const fileName = line.trim();
      if (fileName) {
        const existing = results.get(fileName) ?? [];
        existing.push({
          ...currentCommit,
          matchCount: 1, // Could be enhanced to count actual matches
        });
        results.set(fileName, existing);
      }
    }
  }

  return Array.from(results.entries()).map(([file, commits]) => ({
    file,
    commits,
  }));
}
