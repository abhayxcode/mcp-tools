/**
 * Git Output Parsing Utilities
 */

import type {
  ParsedLogEntry,
  FileDiffStats,
  CommitResult,
} from '../types.js';

/**
 * Parse git log output with custom format
 * Format: %H|%an|%ae|%aI|%s|%b
 */
export function parseGitLog(output: string): ParsedLogEntry[] {
  const entries: ParsedLogEntry[] = [];
  const lines = output.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.split('|');
    if (parts.length < 5) continue;

    const [hash, author, authorEmail, dateStr, message, ...bodyParts] = parts;

    entries.push({
      hash: hash?.trim() ?? '',
      author: author?.trim() ?? '',
      authorEmail: authorEmail?.trim() ?? '',
      date: new Date(dateStr?.trim() ?? ''),
      message: message?.trim() ?? '',
      body: bodyParts.join('|').trim(),
    });
  }

  return entries;
}

/**
 * Parse git diff --stat output
 */
export function parseDiffStats(output: string): FileDiffStats[] {
  const stats: FileDiffStats[] = [];
  const lines = output.trim().split('\n');

  for (const line of lines) {
    // Match lines like: "src/file.ts | 10 ++++----"
    const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s*([+-]*)\s*$/);
    if (match) {
      const path = match[1]?.trim() ?? '';
      const changes = parseInt(match[2] ?? '0', 10);
      const plusMinus = match[3] ?? '';

      // Count + and - symbols
      const insertions = (plusMinus.match(/\+/g) || []).length;
      const deletions = (plusMinus.match(/-/g) || []).length;

      // Calculate proportional insertions/deletions
      const total = insertions + deletions;
      const ratio = total > 0 ? changes / total : 0;

      stats.push({
        path,
        insertions: Math.round(insertions * ratio),
        deletions: Math.round(deletions * ratio),
        binary: false,
      });
    }

    // Match binary files: "Binary files differ"
    if (line.includes('Bin ') || line.includes('Binary')) {
      const binaryMatch = line.match(/^\s*(.+?)\s*\|/);
      if (binaryMatch) {
        stats.push({
          path: binaryMatch[1]?.trim() ?? '',
          insertions: 0,
          deletions: 0,
          binary: true,
        });
      }
    }
  }

  return stats;
}

/**
 * Parse git shortstat output (e.g., " 3 files changed, 10 insertions(+), 5 deletions(-)")
 */
export function parseShortstat(output: string): { files: number; insertions: number; deletions: number } {
  const result = { files: 0, insertions: 0, deletions: 0 };

  const filesMatch = output.match(/(\d+)\s+files?\s+changed/);
  if (filesMatch) {
    result.files = parseInt(filesMatch[1] ?? '0', 10);
  }

  const insertionsMatch = output.match(/(\d+)\s+insertions?\(\+\)/);
  if (insertionsMatch) {
    result.insertions = parseInt(insertionsMatch[1] ?? '0', 10);
  }

  const deletionsMatch = output.match(/(\d+)\s+deletions?\(-\)/);
  if (deletionsMatch) {
    result.deletions = parseInt(deletionsMatch[1] ?? '0', 10);
  }

  return result;
}

/**
 * Parse git numstat output for detailed file changes
 * Format: insertions\tdeletions\tfilename
 */
export function parseNumstat(output: string): FileDiffStats[] {
  const stats: FileDiffStats[] = [];
  const lines = output.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [insertions, deletions, path] = parts;

    // Binary files show as "-\t-\tfilename"
    if (insertions === '-' || deletions === '-') {
      stats.push({
        path: path?.trim() ?? '',
        insertions: 0,
        deletions: 0,
        binary: true,
      });
    } else {
      stats.push({
        path: path?.trim() ?? '',
        insertions: parseInt(insertions ?? '0', 10),
        deletions: parseInt(deletions ?? '0', 10),
        binary: false,
      });
    }
  }

  return stats;
}

/**
 * Parse git blame output
 * Format varies but typically: hash (author date line) content
 */
export function parseBlame(output: string): Array<{
  hash: string;
  author: string;
  date: string;
  lineNumber: number;
  content: string;
}> {
  const results: Array<{
    hash: string;
    author: string;
    date: string;
    lineNumber: number;
    content: string;
  }> = [];

  const lines = output.trim().split('\n');
  let lineNumber = 0;

  for (const line of lines) {
    lineNumber++;

    // Match porcelain format: hash author date linenum content
    // Example: ^abc1234 (John Doe 2024-01-01 15:30:00 -0500  1) const x = 1;
    const match = line.match(/^([a-f0-9^]+)\s+\((.+?)\s+(\d{4}-\d{2}-\d{2})\s+[\d:]+\s+[+-]\d{4}\s+(\d+)\)\s*(.*)$/);

    if (match) {
      results.push({
        hash: match[1]?.replace('^', '') ?? '',
        author: match[2]?.trim() ?? '',
        date: match[3] ?? '',
        lineNumber: parseInt(match[4] ?? '0', 10),
        content: match[5] ?? '',
      });
    }
  }

  return results;
}

/**
 * Parse git show output for a specific commit
 */
export function parseCommitShow(output: string): Partial<CommitResult> {
  const result: Partial<CommitResult> = {};

  const hashMatch = output.match(/^commit\s+([a-f0-9]+)/m);
  if (hashMatch) {
    result.hash = hashMatch[1];
    result.shortHash = hashMatch[1]?.substring(0, 7);
  }

  const authorMatch = output.match(/^Author:\s+(.+?)\s+<(.+?)>/m);
  if (authorMatch) {
    result.author = authorMatch[1];
    result.authorEmail = authorMatch[2];
  }

  const dateMatch = output.match(/^Date:\s+(.+)$/m);
  if (dateMatch) {
    result.date = dateMatch[1]?.trim();
  }

  // Extract commit message (lines after Date: until the first empty line or diff)
  const messageMatch = output.match(/^Date:.+\n\n([\s\S]+?)(?=\n\ndiff|\n*$)/m);
  if (messageMatch) {
    const fullMessage = messageMatch[1]?.trim() ?? '';
    const [firstLine, ...rest] = fullMessage.split('\n');
    result.message = firstLine?.trim() ?? '';
    result.body = rest.map(l => l.trim()).join('\n').trim();
  }

  return result;
}

/**
 * Extract file paths from git diff output
 */
export function extractFilesFromDiff(output: string): string[] {
  const files: Set<string> = new Set();
  const lines = output.split('\n');

  for (const line of lines) {
    // Match "diff --git a/path/file b/path/file"
    const diffMatch = line.match(/^diff --git a\/(.+?)\s+b\//);
    if (diffMatch) {
      files.add(diffMatch[1] ?? '');
    }

    // Match "+++ b/path/file" or "--- a/path/file"
    const fileMatch = line.match(/^[+-]{3}\s+[ab]\/(.+)$/);
    if (fileMatch) {
      files.add(fileMatch[1] ?? '');
    }
  }

  return Array.from(files);
}

/**
 * Calculate text similarity using simple token matching
 * Returns a score between 0 and 1
 */
export function calculateTextSimilarity(text1: string, text2: string): number {
  const normalize = (text: string): Set<string> => {
    return new Set(
      text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2)
    );
  };

  const tokens1 = normalize(text1);
  const tokens2 = normalize(text2);

  if (tokens1.size === 0 || tokens2.size === 0) return 0;

  let intersection = 0;
  for (const token of tokens1) {
    if (tokens2.has(token)) intersection++;
  }

  // Jaccard similarity
  const union = tokens1.size + tokens2.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Parse a date string in various formats
 */
export function parseFlexibleDate(dateStr: string): Date | null {
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    return date;
  }

  // Try common formats
  const formats = [
    /^(\d{4})-(\d{2})-(\d{2})$/, // YYYY-MM-DD
    /^(\d{2})\/(\d{2})\/(\d{4})$/, // MM/DD/YYYY
    /^(\d{1,2})\s+(days?|weeks?|months?|years?)\s+ago$/i, // relative
  ];

  for (const format of formats) {
    const match = dateStr.match(format);
    if (match) {
      // Handle relative dates
      if (format.source.includes('ago')) {
        const amount = parseInt(match[1] ?? '0', 10);
        const unit = match[2]?.toLowerCase() ?? '';
        const now = new Date();

        switch (true) {
          case unit.startsWith('day'):
            now.setDate(now.getDate() - amount);
            break;
          case unit.startsWith('week'):
            now.setDate(now.getDate() - amount * 7);
            break;
          case unit.startsWith('month'):
            now.setMonth(now.getMonth() - amount);
            break;
          case unit.startsWith('year'):
            now.setFullYear(now.getFullYear() - amount);
            break;
        }
        return now;
      }
    }
  }

  return null;
}
