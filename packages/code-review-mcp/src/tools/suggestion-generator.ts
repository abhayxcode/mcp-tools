/**
 * Suggestion Generator tool - Submit reviews and generate review suggestions
 */

import { z } from 'zod';
import { getGitHubClient, GitHubClientError } from '../utils/github-client.js';
import { parsePatchesFromFiles, extractAddedLines, getLanguageFromFilename } from '../utils/diff-parser.js';
import type {
  SubmitReviewResult,
  ReviewSuggestionsResult,
  ReviewSuggestion,
  ReviewEvent,
} from '../types.js';

/**
 * Input schema for submit_review tool
 */
export const SubmitReviewInputSchema = z.object({
  owner: z.string().min(1).describe('Repository owner (username or organization)'),
  repo: z.string().min(1).describe('Repository name'),
  prNumber: z.number().int().positive().describe('Pull request number'),
  body: z.string().describe('The review summary/body text'),
  event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).describe('The review action'),
  comments: z
    .array(
      z.object({
        path: z.string().describe('The relative path of the file to comment on'),
        body: z.string().describe('The comment text'),
        line: z.number().int().positive().optional().describe('The line number to comment on'),
        side: z.enum(['LEFT', 'RIGHT']).optional().describe('Which side of the diff'),
        startLine: z.number().int().positive().optional().describe('Starting line for multi-line comment'),
        startSide: z.enum(['LEFT', 'RIGHT']).optional().describe('Side for the starting line'),
      })
    )
    .optional()
    .describe('Optional array of inline comments to include with the review'),
  commitId: z.string().optional().describe('The SHA of the commit to review. Defaults to the latest.'),
});

export type SubmitReviewInput = z.infer<typeof SubmitReviewInputSchema>;

/**
 * Input schema for get_review_suggestions tool
 */
export const GetReviewSuggestionsInputSchema = z.object({
  owner: z.string().min(1).describe('Repository owner (username or organization)'),
  repo: z.string().min(1).describe('Repository name'),
  prNumber: z.number().int().positive().describe('Pull request number'),
});

export type GetReviewSuggestionsInput = z.infer<typeof GetReviewSuggestionsInputSchema>;

/**
 * Submit a complete PR review
 */
export async function submitReview(input: SubmitReviewInput): Promise<SubmitReviewResult> {
  const { owner, repo, prNumber, body, event, comments = [], commitId } = input;

  const client = getGitHubClient();

  try {
    // Get commit SHA if not provided
    let sha = commitId;
    if (!sha) {
      const prData = await client.execute(() =>
        client.client.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        })
      );
      sha = prData.head.sha;
    }

    // Transform comments to GitHub API format
    const apiComments = comments.map(comment => {
      const apiComment: {
        path: string;
        body: string;
        line?: number;
        side?: 'LEFT' | 'RIGHT';
        start_line?: number;
        start_side?: 'LEFT' | 'RIGHT';
      } = {
        path: comment.path,
        body: comment.body,
      };

      if (comment.line !== undefined) {
        apiComment.line = comment.line;
      }
      if (comment.side) {
        apiComment.side = comment.side;
      }
      if (comment.startLine !== undefined) {
        apiComment.start_line = comment.startLine;
        if (comment.startSide) {
          apiComment.start_side = comment.startSide;
        }
      }

      return apiComment;
    });

    // Submit the review
    const result = await client.execute(() =>
      client.client.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: sha,
        body,
        event: event as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
        comments: apiComments.length > 0 ? apiComments : undefined,
      })
    );

    return {
      id: result.id,
      url: result.html_url,
      state: result.state,
      body: result.body,
      submittedAt: result.submitted_at || new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof GitHubClientError) {
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Handle specific errors
    if (errorMessage.includes('Can not approve your own pull request')) {
      throw new GitHubClientError(
        'You cannot approve your own pull request.',
        422
      );
    }

    if (errorMessage.includes('Review cannot be empty')) {
      throw new GitHubClientError(
        'Review body cannot be empty when submitting without comments.',
        422
      );
    }

    throw new GitHubClientError(
      `Failed to submit review: ${errorMessage}`,
      500
    );
  }
}

/**
 * Generate review suggestions based on diff analysis
 */
export async function getReviewSuggestions(
  input: GetReviewSuggestionsInput
): Promise<ReviewSuggestionsResult> {
  const { owner, repo, prNumber } = input;

  const client = getGitHubClient();

  try {
    // Fetch changed files and PR details
    const [filesData, prData] = await Promise.all([
      client.execute(() =>
        client.client.pulls.listFiles({
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100,
        })
      ),
      client.execute(() =>
        client.client.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        })
      ),
    ]);

    // Parse the diffs
    const diffSummary = parsePatchesFromFiles(filesData);

    // Generate suggestions
    const suggestions = generateReviewSuggestions(diffSummary, filesData);

    // Calculate quality score
    const qualityScore = calculateQualityScore(diffSummary, suggestions, prData);

    // Generate summary
    const summary = generateSuggestionSummary(suggestions, qualityScore);

    return {
      suggestions,
      qualityScore,
      summary,
    };
  } catch (error) {
    if (error instanceof GitHubClientError) {
      throw error;
    }
    throw new GitHubClientError(
      `Failed to generate review suggestions: ${error instanceof Error ? error.message : 'Unknown error'}`,
      500
    );
  }
}

/**
 * Generate review suggestions from diff analysis
 */
function generateReviewSuggestions(
  diffSummary: ReturnType<typeof parsePatchesFromFiles>,
  _files: Array<{ filename: string; patch?: string; additions: number; deletions: number }>
): ReviewSuggestion[] {
  const suggestions: ReviewSuggestion[] = [];

  for (const file of diffSummary.fileBreakdown) {
    const language = getLanguageFromFilename(file.filename);
    const addedLines = extractAddedLines(file.hunks);

    // Check for various issues
    for (const { line, content } of addedLines) {
      // Security suggestions
      const securitySuggestion = checkSecurityPatterns(file.filename, line, content);
      if (securitySuggestion) {
        suggestions.push(securitySuggestion);
      }

      // Performance suggestions
      const perfSuggestion = checkPerformancePatterns(file.filename, line, content, language);
      if (perfSuggestion) {
        suggestions.push(perfSuggestion);
      }

      // Maintainability suggestions
      const maintSuggestion = checkMaintainabilityPatterns(file.filename, line, content, language);
      if (maintSuggestion) {
        suggestions.push(maintSuggestion);
      }

      // Bug prevention suggestions
      const bugSuggestion = checkBugPatterns(file.filename, line, content, language);
      if (bugSuggestion) {
        suggestions.push(bugSuggestion);
      }
    }

    // File-level suggestions
    const fileSuggestions = checkFileLevel(file.filename, file.additions, file.deletions, language);
    suggestions.push(...fileSuggestions);
  }

  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  suggestions.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return suggestions;
}

/**
 * Check for security patterns
 */
function checkSecurityPatterns(
  filename: string,
  line: number,
  content: string
): ReviewSuggestion | null {
  const patterns = [
    {
      regex: /password\s*=\s*["'][^"']+["']/i,
      title: 'Hardcoded password detected',
      description: 'Credentials should not be hardcoded. Use environment variables or a secrets manager.',
      severity: 'critical' as const,
      fix: 'Replace with process.env.PASSWORD or similar secure method.',
    },
    {
      regex: /api[_-]?key\s*=\s*["'][^"']+["']/i,
      title: 'Hardcoded API key detected',
      description: 'API keys should be stored securely, not in source code.',
      severity: 'critical' as const,
      fix: 'Use environment variables or a secrets manager.',
    },
    {
      regex: /eval\s*\(/i,
      title: 'Use of eval() detected',
      description: 'eval() can execute arbitrary code and poses a security risk.',
      severity: 'high' as const,
      fix: 'Replace eval() with safer alternatives like JSON.parse() for data parsing.',
    },
    {
      regex: /innerHTML\s*=/i,
      title: 'Direct innerHTML assignment',
      description: 'Direct innerHTML can lead to XSS vulnerabilities if user input is included.',
      severity: 'medium' as const,
      fix: 'Use textContent for text or sanitize HTML before assignment.',
    },
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(content)) {
      return {
        file: filename,
        line,
        category: 'security',
        severity: pattern.severity,
        title: pattern.title,
        description: pattern.description,
        suggestedFix: pattern.fix,
        references: ['https://owasp.org/Top10/'],
      };
    }
  }

  return null;
}

/**
 * Check for performance patterns
 */
function checkPerformancePatterns(
  filename: string,
  line: number,
  content: string,
  _language: string
): ReviewSuggestion | null {
  const patterns = [
    {
      regex: /\.forEach\s*\(.*\.forEach/i,
      title: 'Nested forEach detected',
      description: 'Nested iterations can lead to O(n^2) complexity.',
      severity: 'medium' as const,
      fix: 'Consider using a Map or Set for O(1) lookups.',
    },
    {
      regex: /JSON\.parse\s*\(\s*JSON\.stringify/i,
      title: 'JSON deep clone pattern',
      description: 'Using JSON.parse(JSON.stringify()) for cloning is slow and has limitations.',
      severity: 'low' as const,
      fix: 'Use structuredClone() or a library like lodash.cloneDeep().',
    },
    {
      regex: /await.*for\s*\(|for\s*\(.*await/i,
      title: 'Sequential awaits in loop',
      description: 'Sequential awaits in loops can be slow. Consider parallel execution.',
      severity: 'medium' as const,
      fix: 'Use Promise.all() if operations are independent.',
    },
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(content)) {
      return {
        file: filename,
        line,
        category: 'performance',
        severity: pattern.severity,
        title: pattern.title,
        description: pattern.description,
        suggestedFix: pattern.fix,
      };
    }
  }

  return null;
}

/**
 * Check for maintainability patterns
 */
function checkMaintainabilityPatterns(
  filename: string,
  line: number,
  content: string,
  _language: string
): ReviewSuggestion | null {
  const patterns = [
    {
      regex: /TODO:|FIXME:|HACK:|XXX:/i,
      title: 'TODO/FIXME comment',
      description: 'This code has a TODO marker that should be tracked.',
      severity: 'low' as const,
      fix: 'Create a tracking issue for this TODO item.',
    },
    {
      regex: /@ts-ignore|@ts-nocheck/i,
      title: 'TypeScript check disabled',
      description: 'Type checking is disabled for this line/file.',
      severity: 'medium' as const,
      fix: 'Fix the underlying type error instead of disabling the check.',
    },
    {
      regex: /eslint-disable/i,
      title: 'ESLint rule disabled',
      description: 'Linting rules are disabled. This may hide issues.',
      severity: 'low' as const,
      fix: 'Address the underlying lint error rather than disabling the rule.',
    },
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(content)) {
      return {
        file: filename,
        line,
        category: 'maintainability',
        severity: pattern.severity,
        title: pattern.title,
        description: pattern.description,
        suggestedFix: pattern.fix,
      };
    }
  }

  return null;
}

/**
 * Check for potential bug patterns
 */
function checkBugPatterns(
  filename: string,
  line: number,
  content: string,
  _language: string
): ReviewSuggestion | null {
  const patterns = [
    {
      regex: /catch\s*\(\s*\w+\s*\)\s*\{\s*\}/i,
      title: 'Empty catch block',
      description: 'Empty catch blocks silently swallow errors.',
      severity: 'medium' as const,
      fix: 'Log the error or handle it appropriately.',
    },
    {
      regex: /parseInt\s*\([^,)]+\)(?!\s*,)/i,
      title: 'parseInt without radix',
      description: 'parseInt without a radix can produce unexpected results.',
      severity: 'low' as const,
      fix: 'Always specify the radix: parseInt(str, 10)',
    },
    {
      regex: /==\s*null|null\s*==/i,
      title: 'Loose null comparison',
      description: 'Using == instead of === for null comparison.',
      severity: 'low' as const,
      fix: 'Use strict equality (===) for null checks.',
    },
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(content)) {
      return {
        file: filename,
        line,
        category: 'bug',
        severity: pattern.severity,
        title: pattern.title,
        description: pattern.description,
        suggestedFix: pattern.fix,
      };
    }
  }

  return null;
}

/**
 * Check file-level issues
 */
function checkFileLevel(
  filename: string,
  additions: number,
  _deletions: number,
  _language: string
): ReviewSuggestion[] {
  const suggestions: ReviewSuggestion[] = [];

  // Large file changes
  if (additions > 500) {
    suggestions.push({
      file: filename,
      category: 'maintainability',
      severity: 'medium',
      title: 'Large number of additions',
      description: `This file has ${additions} additions. Consider breaking into smaller, focused changes.`,
      suggestedFix: 'Split into multiple smaller PRs if possible.',
    });
  }

  // Check for test file presence
  const isTestFile = /\.(test|spec)\.(ts|js|tsx|jsx)$/i.test(filename);
  const isSourceFile = /\.(ts|js|tsx|jsx)$/i.test(filename) && !isTestFile;

  if (isSourceFile && additions > 50) {
    suggestions.push({
      file: filename,
      category: 'maintainability',
      severity: 'low',
      title: 'Consider adding tests',
      description: 'Significant code changes should include corresponding tests.',
      suggestedFix: `Add test coverage for ${filename}`,
    });
  }

  return suggestions;
}

/**
 * Calculate quality score based on analysis
 */
function calculateQualityScore(
  _diffSummary: ReturnType<typeof parsePatchesFromFiles>,
  suggestions: ReviewSuggestion[],
  prData: { additions?: number; deletions?: number; changed_files?: number }
): number {
  let score = 100;

  // Deduct for issues found
  const criticalIssues = suggestions.filter(s => s.severity === 'critical').length;
  const highIssues = suggestions.filter(s => s.severity === 'high').length;
  const mediumIssues = suggestions.filter(s => s.severity === 'medium').length;
  const lowIssues = suggestions.filter(s => s.severity === 'low').length;

  score -= criticalIssues * 15;
  score -= highIssues * 8;
  score -= mediumIssues * 3;
  score -= lowIssues * 1;

  // Deduct for very large PRs
  const totalChanges = (prData.additions || 0) + (prData.deletions || 0);
  if (totalChanges > 1000) {
    score -= 10;
  } else if (totalChanges > 500) {
    score -= 5;
  }

  // Deduct for many files changed
  if ((prData.changed_files || 0) > 20) {
    score -= 10;
  } else if ((prData.changed_files || 0) > 10) {
    score -= 5;
  }

  // Ensure score is between 0 and 100
  return Math.max(0, Math.min(100, score));
}

/**
 * Generate summary text for suggestions
 */
function generateSuggestionSummary(
  suggestions: ReviewSuggestion[],
  qualityScore: number
): string {
  const criticalCount = suggestions.filter(s => s.severity === 'critical').length;
  const highCount = suggestions.filter(s => s.severity === 'high').length;
  const mediumCount = suggestions.filter(s => s.severity === 'medium').length;
  const lowCount = suggestions.filter(s => s.severity === 'low').length;

  const lines: string[] = [
    `## Code Quality Score: ${qualityScore}/100`,
    '',
  ];

  if (qualityScore >= 90) {
    lines.push('Overall: Excellent code quality.');
  } else if (qualityScore >= 75) {
    lines.push('Overall: Good code quality with minor improvements needed.');
  } else if (qualityScore >= 50) {
    lines.push('Overall: Code quality needs improvement.');
  } else {
    lines.push('Overall: Significant issues found that should be addressed.');
  }

  lines.push('');
  lines.push('### Issues by Severity:');
  if (criticalCount > 0) lines.push(`- Critical: ${criticalCount}`);
  if (highCount > 0) lines.push(`- High: ${highCount}`);
  if (mediumCount > 0) lines.push(`- Medium: ${mediumCount}`);
  if (lowCount > 0) lines.push(`- Low: ${lowCount}`);

  if (suggestions.length === 0) {
    lines.push('- No issues found!');
  }

  // Group by category
  const byCategory = suggestions.reduce(
    (acc, s) => {
      acc[s.category] = (acc[s.category] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  if (Object.keys(byCategory).length > 0) {
    lines.push('');
    lines.push('### Issues by Category:');
    for (const [category, count] of Object.entries(byCategory)) {
      lines.push(`- ${category}: ${count}`);
    }
  }

  return lines.join('\n');
}

/**
 * Helper to determine recommended review action
 */
export function getRecommendedAction(
  suggestions: ReviewSuggestion[],
  qualityScore: number
): ReviewEvent {
  const criticalCount = suggestions.filter(s => s.severity === 'critical').length;
  const highCount = suggestions.filter(s => s.severity === 'high').length;

  if (criticalCount > 0) {
    return 'REQUEST_CHANGES';
  }

  if (highCount > 2 || qualityScore < 50) {
    return 'REQUEST_CHANGES';
  }

  if (highCount > 0 || qualityScore < 75) {
    return 'COMMENT';
  }

  return 'APPROVE';
}
