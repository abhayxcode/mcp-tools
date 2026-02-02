/**
 * Unified diff parsing utilities
 */

import parseDiff from 'parse-diff';
import type { DiffSummary, DiffHunk, DiffChange } from '../types.js';

/**
 * Language detection based on file extension
 */
const LANGUAGE_MAP: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.scala': 'scala',
  '.clj': 'clojure',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.ml': 'ocaml',
  '.fs': 'fsharp',
  '.r': 'r',
  '.R': 'r',
  '.sql': 'sql',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'zsh',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.xml': 'xml',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.md': 'markdown',
  '.mdx': 'mdx',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.dockerfile': 'dockerfile',
  '.tf': 'terraform',
  '.hcl': 'hcl',
  '.proto': 'protobuf',
  '.graphql': 'graphql',
  '.gql': 'graphql',
};

/**
 * Get language from filename
 */
export function getLanguageFromFilename(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();

  // Handle special cases
  if (filename.toLowerCase() === 'dockerfile' || filename.toLowerCase().endsWith('.dockerfile')) {
    return 'dockerfile';
  }
  if (filename.toLowerCase() === 'makefile' || filename.toLowerCase() === 'gnumakefile') {
    return 'makefile';
  }

  return LANGUAGE_MAP[ext] || 'unknown';
}

/**
 * Parse a unified diff string into structured data
 */
export function parseDiffString(diffString: string): DiffSummary {
  const files = parseDiff(diffString);

  let totalAdditions = 0;
  let totalDeletions = 0;

  const fileBreakdown = files.map(file => {
    const filename = file.to || file.from || 'unknown';
    const language = getLanguageFromFilename(filename);

    const hunks: DiffHunk[] = file.chunks.map(chunk => {
      const changes: DiffChange[] = chunk.changes.map(change => {
        const changeObj: DiffChange = {
          type: change.type === 'add' ? 'add' : change.type === 'del' ? 'del' : 'normal',
          content: change.content,
        };

        if (change.type === 'normal' || change.type === 'del') {
          changeObj.oldLineNumber = 'ln1' in change ? change.ln1 : undefined;
        }
        if (change.type === 'normal' || change.type === 'add') {
          changeObj.newLineNumber = 'ln2' in change ? change.ln2 : ('ln' in change ? change.ln : undefined);
        }

        return changeObj;
      });

      return {
        oldStart: chunk.oldStart,
        oldLines: chunk.oldLines,
        newStart: chunk.newStart,
        newLines: chunk.newLines,
        content: chunk.content,
        changes,
      };
    });

    totalAdditions += file.additions;
    totalDeletions += file.deletions;

    return {
      filename,
      language,
      additions: file.additions,
      deletions: file.deletions,
      hunks,
    };
  });

  return {
    totalAdditions,
    totalDeletions,
    totalChanges: totalAdditions + totalDeletions,
    filesChanged: files.length,
    fileBreakdown,
  };
}

/**
 * Parse patches from GitHub API response
 */
export function parsePatchesFromFiles(
  files: Array<{ filename: string; patch?: string; additions: number; deletions: number }>
): DiffSummary {
  let totalAdditions = 0;
  let totalDeletions = 0;

  const fileBreakdown = files.map(file => {
    const language = getLanguageFromFilename(file.filename);
    totalAdditions += file.additions;
    totalDeletions += file.deletions;

    let hunks: DiffHunk[] = [];

    if (file.patch) {
      // Parse the patch for this file
      const lines = file.patch.split('\n');
      let currentHunk: DiffHunk | null = null;

      for (const line of lines) {
        // Check for hunk header
        const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);

        if (hunkMatch) {
          if (currentHunk) {
            hunks.push(currentHunk);
          }
          currentHunk = {
            oldStart: parseInt(hunkMatch[1], 10),
            oldLines: parseInt(hunkMatch[2] || '1', 10),
            newStart: parseInt(hunkMatch[3], 10),
            newLines: parseInt(hunkMatch[4] || '1', 10),
            content: hunkMatch[5] || '',
            changes: [],
          };
        } else if (currentHunk) {
          let type: 'add' | 'del' | 'normal' = 'normal';
          let content = line;

          if (line.startsWith('+')) {
            type = 'add';
            content = line.substring(1);
          } else if (line.startsWith('-')) {
            type = 'del';
            content = line.substring(1);
          } else if (line.startsWith(' ')) {
            content = line.substring(1);
          }

          currentHunk.changes.push({
            type,
            content,
          });
        }
      }

      if (currentHunk) {
        hunks.push(currentHunk);
      }
    }

    return {
      filename: file.filename,
      language,
      additions: file.additions,
      deletions: file.deletions,
      hunks,
    };
  });

  return {
    totalAdditions,
    totalDeletions,
    totalChanges: totalAdditions + totalDeletions,
    filesChanged: files.length,
    fileBreakdown,
  };
}

/**
 * Extract added lines from a diff
 */
export function extractAddedLines(hunks: DiffHunk[]): Array<{ line: number; content: string }> {
  const addedLines: Array<{ line: number; content: string }> = [];

  for (const hunk of hunks) {
    let newLineNum = hunk.newStart;

    for (const change of hunk.changes) {
      if (change.type === 'add') {
        addedLines.push({
          line: newLineNum,
          content: change.content,
        });
        newLineNum++;
      } else if (change.type === 'normal') {
        newLineNum++;
      }
      // Deleted lines don't affect newLineNum
    }
  }

  return addedLines;
}

/**
 * Extract deleted lines from a diff
 */
export function extractDeletedLines(hunks: DiffHunk[]): Array<{ line: number; content: string }> {
  const deletedLines: Array<{ line: number; content: string }> = [];

  for (const hunk of hunks) {
    let oldLineNum = hunk.oldStart;

    for (const change of hunk.changes) {
      if (change.type === 'del') {
        deletedLines.push({
          line: oldLineNum,
          content: change.content,
        });
        oldLineNum++;
      } else if (change.type === 'normal') {
        oldLineNum++;
      }
      // Added lines don't affect oldLineNum
    }
  }

  return deletedLines;
}

/**
 * Get the context around a specific line in a diff
 */
export function getLineContext(
  hunks: DiffHunk[],
  targetLine: number,
  contextLines: number = 3
): { before: string[]; target: string; after: string[] } | null {
  for (const hunk of hunks) {
    let currentLine = hunk.newStart;

    for (let i = 0; i < hunk.changes.length; i++) {
      const change = hunk.changes[i];

      if (change.type !== 'del') {
        if (currentLine === targetLine) {
          const before: string[] = [];
          const after: string[] = [];

          // Get lines before
          for (let j = i - 1; j >= 0 && before.length < contextLines; j--) {
            const prevChange = hunk.changes[j];
            if (prevChange.type !== 'del') {
              before.unshift(prevChange.content);
            }
          }

          // Get lines after
          for (let j = i + 1; j < hunk.changes.length && after.length < contextLines; j++) {
            const nextChange = hunk.changes[j];
            if (nextChange.type !== 'del') {
              after.push(nextChange.content);
            }
          }

          return {
            before,
            target: change.content,
            after,
          };
        }
        currentLine++;
      }
    }
  }

  return null;
}

/**
 * Calculate diff statistics
 */
export function calculateDiffStats(summary: DiffSummary): {
  addedLinesRatio: number;
  deletedLinesRatio: number;
  churnRatio: number;
  averageHunkSize: number;
  largestFile: { filename: string; changes: number } | null;
} {
  const total = summary.totalChanges || 1;

  let totalHunks = 0;
  let totalHunkChanges = 0;
  let largestFile: { filename: string; changes: number } | null = null;

  for (const file of summary.fileBreakdown) {
    const fileChanges = file.additions + file.deletions;

    if (!largestFile || fileChanges > largestFile.changes) {
      largestFile = {
        filename: file.filename,
        changes: fileChanges,
      };
    }

    for (const hunk of file.hunks) {
      totalHunks++;
      totalHunkChanges += hunk.changes.length;
    }
  }

  return {
    addedLinesRatio: summary.totalAdditions / total,
    deletedLinesRatio: summary.totalDeletions / total,
    churnRatio: Math.min(summary.totalAdditions, summary.totalDeletions) /
                Math.max(summary.totalAdditions, summary.totalDeletions, 1),
    averageHunkSize: totalHunks > 0 ? totalHunkChanges / totalHunks : 0,
    largestFile,
  };
}
