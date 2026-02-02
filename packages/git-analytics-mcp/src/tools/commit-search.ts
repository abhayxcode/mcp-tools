/**
 * Commit Search Tool
 * Semantic search through git commit history
 */

import { z } from 'zod';
import { simpleGit, SimpleGit, LogResult } from 'simple-git';
import type { CommitResult } from '../types.js';
import { calculateTextSimilarity, parseShortstat } from '../utils/git-parser.js';
import { analyticsCache } from '../utils/analytics.js';

/**
 * Input schema for search_commits tool
 */
export const searchCommitsSchema = z.object({
  query: z.string().min(1).describe('Search query to match against commit messages and content'),
  path: z.string().optional().describe('Repository path (defaults to current directory)'),
  author: z.string().optional().describe('Filter by author name or email'),
  since: z.string().optional().describe('Start date (ISO format or relative like "2 weeks ago")'),
  until: z.string().optional().describe('End date (ISO format or relative)'),
  limit: z.number().min(1).max(500).default(50).describe('Maximum number of results to return'),
});

export type SearchCommitsInput = z.infer<typeof searchCommitsSchema>;

/**
 * Search commits by query with relevance scoring
 */
export async function searchCommits(input: SearchCommitsInput): Promise<{
  results: CommitResult[];
  totalMatched: number;
  searchCriteria: Record<string, unknown>;
}> {
  const { query, path = process.cwd(), author, since, until, limit = 50 } = input;

  // Validate path is a git repository
  const git: SimpleGit = simpleGit(path);

  try {
    await git.revparse(['--git-dir']);
  } catch {
    throw new Error(`Not a git repository: ${path}`);
  }

  // Build cache key
  const cacheKey = analyticsCache.generateKey('commits', path, query, author, since, until);
  const cached = analyticsCache.get<CommitResult[]>(cacheKey);
  if (cached) {
    return {
      results: cached.slice(0, limit),
      totalMatched: cached.length,
      searchCriteria: { query, author, since, until, limit, cached: true },
    };
  }

  // Prepare git log options
  const logOptions: Record<string, string | number | boolean | undefined> = {
    '--all': true,
    '--date-order': true,
    maxCount: 1000, // Fetch more for relevance filtering
  };

  if (author) {
    logOptions['--author'] = author;
  }

  if (since) {
    logOptions['--since'] = since;
  }

  if (until) {
    logOptions['--until'] = until;
  }

  // Search by message first using grep
  const searchTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  let logResult: LogResult;

  try {
    // Try to grep for the query in commit messages
    if (searchTerms.length > 0) {
      logOptions['--grep'] = searchTerms[0];
      logOptions['--regexp-ignore-case'] = true;
    }

    logResult = await git.log(logOptions);
  } catch {
    // Fallback to regular log if grep fails
    delete logOptions['--grep'];
    delete logOptions['--regexp-ignore-case'];
    logResult = await git.log(logOptions);
  }

  const commits: CommitResult[] = [];

  for (const commit of logResult.all) {
    // Calculate relevance score
    const messageRelevance = calculateTextSimilarity(query, commit.message);
    const bodyRelevance = commit.body ? calculateTextSimilarity(query, commit.body) : 0;
    const relevanceScore = Math.round((messageRelevance * 0.7 + bodyRelevance * 0.3) * 100);

    // Only include if there's some relevance or if it matched the grep
    if (relevanceScore > 0 || searchTerms.some(term =>
      commit.message.toLowerCase().includes(term) ||
      (commit.body?.toLowerCase().includes(term))
    )) {
      // Get diff stats for this commit
      let filesChanged = 0;
      let insertions = 0;
      let deletions = 0;

      try {
        const stats = await git.raw(['show', '--stat', '--format=', commit.hash]);
        const parsedStats = parseShortstat(stats);
        filesChanged = parsedStats.files;
        insertions = parsedStats.insertions;
        deletions = parsedStats.deletions;
      } catch {
        // Stats not available
      }

      commits.push({
        hash: commit.hash,
        shortHash: commit.hash.substring(0, 7),
        author: commit.author_name,
        authorEmail: commit.author_email,
        date: commit.date,
        message: commit.message,
        body: commit.body || undefined,
        filesChanged,
        insertions,
        deletions,
        relevanceScore: Math.max(relevanceScore, 10), // Minimum score for matches
      });
    }
  }

  // Sort by relevance score, then by date
  commits.sort((a, b) => {
    const scoreDiff = (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });

  // Cache results
  analyticsCache.set(cacheKey, commits);

  return {
    results: commits.slice(0, limit),
    totalMatched: commits.length,
    searchCriteria: { query, author, since, until, limit, cached: false },
  };
}

/**
 * Get commit details with full diff
 */
export async function getCommitDetails(
  hash: string,
  repoPath: string = process.cwd()
): Promise<CommitResult & { files: string[]; diff?: string }> {
  const git = simpleGit(repoPath);

  const logResult = await git.log({ from: hash, to: hash, maxCount: 1 });
  const commit = logResult.latest;

  if (!commit) {
    throw new Error(`Commit not found: ${hash}`);
  }

  // Get file list
  const diffNameOnly = await git.raw(['diff-tree', '--no-commit-id', '--name-only', '-r', hash]);
  const files = diffNameOnly.trim().split('\n').filter((f: string) => f);

  // Get stats
  const statsOutput = await git.raw(['show', '--stat', '--format=', hash]);
  const stats = parseShortstat(statsOutput);

  return {
    hash: commit.hash,
    shortHash: commit.hash.substring(0, 7),
    author: commit.author_name,
    authorEmail: commit.author_email,
    date: commit.date,
    message: commit.message,
    body: commit.body || undefined,
    filesChanged: stats.files,
    insertions: stats.insertions,
    deletions: stats.deletions,
    files,
  };
}

/**
 * Find commits that modified a specific file
 */
export async function findCommitsForFile(
  filePath: string,
  repoPath: string = process.cwd(),
  options: { since?: string; until?: string; limit?: number } = {}
): Promise<CommitResult[]> {
  const git = simpleGit(repoPath);
  const { since, until, limit = 50 } = options;

  const logOptions: string[] = ['log', '--format=%H|%an|%ae|%aI|%s', '--follow'];

  if (since) logOptions.push(`--since=${since}`);
  if (until) logOptions.push(`--until=${until}`);
  logOptions.push(`-n${limit}`);
  logOptions.push('--', filePath);

  const output = await git.raw(logOptions);
  const commits: CommitResult[] = [];

  for (const line of output.trim().split('\n')) {
    if (!line) continue;

    const [hash, author, authorEmail, date, message] = line.split('|');
    if (!hash) continue;

    commits.push({
      hash,
      shortHash: hash.substring(0, 7),
      author: author ?? '',
      authorEmail: authorEmail ?? '',
      date: date ?? '',
      message: message ?? '',
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
    });
  }

  return commits;
}
