/**
 * Diff Reviewer tool - Analyzes code changes and identifies potential issues
 */

import { z } from 'zod';
import { getGitHubClient, GitHubClientError } from '../utils/github-client.js';
import { parsePatchesFromFiles, extractAddedLines } from '../utils/diff-parser.js';
import type {
  DiffAnalysisResult,
  DiffSummary,
  CodeIssue,
  Suggestion,
  FocusArea,
} from '../types.js';

/**
 * Input schema for analyze_pr_diff tool
 */
export const AnalyzePRDiffInputSchema = z.object({
  owner: z.string().min(1).describe('Repository owner (username or organization)'),
  repo: z.string().min(1).describe('Repository name'),
  prNumber: z.number().int().positive().describe('Pull request number'),
  focusAreas: z
    .array(z.enum(['security', 'performance', 'style', 'bugs', 'all']))
    .optional()
    .describe('Areas to focus the analysis on. Defaults to all areas.'),
});

export type AnalyzePRDiffInput = z.infer<typeof AnalyzePRDiffInputSchema>;

/**
 * Security patterns to detect
 */
const SECURITY_PATTERNS = [
  { pattern: /password\s*=\s*["'][^"']+["']/i, title: 'Hardcoded password', severity: 'critical' as const },
  { pattern: /api[_-]?key\s*=\s*["'][^"']+["']/i, title: 'Hardcoded API key', severity: 'critical' as const },
  { pattern: /secret\s*=\s*["'][^"']+["']/i, title: 'Hardcoded secret', severity: 'critical' as const },
  { pattern: /eval\s*\(/i, title: 'Use of eval()', severity: 'high' as const },
  { pattern: /exec\s*\(/i, title: 'Use of exec()', severity: 'high' as const },
  { pattern: /innerHTML\s*=/i, title: 'Direct innerHTML assignment', severity: 'medium' as const },
  { pattern: /dangerouslySetInnerHTML/i, title: 'dangerouslySetInnerHTML usage', severity: 'medium' as const },
  { pattern: /document\.write\s*\(/i, title: 'document.write usage', severity: 'medium' as const },
  { pattern: /SELECT\s+.*\s+FROM\s+.*\s+WHERE\s+.*\+/i, title: 'Potential SQL injection', severity: 'critical' as const },
  { pattern: /\$\{.*\}.*SELECT|SELECT.*\$\{/i, title: 'SQL query with template literal', severity: 'high' as const },
  { pattern: /crypto\.createCipher\s*\(/i, title: 'Deprecated crypto.createCipher', severity: 'medium' as const },
  { pattern: /Math\.random\s*\(/i, title: 'Math.random for security purposes', severity: 'low' as const },
  { pattern: /http:\/\/(?!localhost|127\.0\.0\.1)/i, title: 'Non-HTTPS URL', severity: 'medium' as const },
  { pattern: /disable.*ssl|ssl.*false|verify.*false/i, title: 'SSL verification disabled', severity: 'high' as const },
];

/**
 * Performance patterns to detect
 */
const PERFORMANCE_PATTERNS = [
  { pattern: /\.forEach\s*\(.*\.forEach/i, title: 'Nested forEach loops', severity: 'medium' as const },
  { pattern: /for\s*\(.*for\s*\(/i, title: 'Nested for loops', severity: 'low' as const },
  { pattern: /JSON\.parse\s*\(\s*JSON\.stringify/i, title: 'Deep clone using JSON', severity: 'low' as const },
  { pattern: /new RegExp\s*\(/i, title: 'RegExp in loop', severity: 'low' as const },
  { pattern: /document\.querySelector.*loop|loop.*document\.querySelector/i, title: 'DOM query in loop', severity: 'medium' as const },
  { pattern: /\.\s*map\s*\([^)]*\)\s*\.\s*filter/i, title: 'map().filter() could be optimized', severity: 'low' as const },
  { pattern: /\.\s*filter\s*\([^)]*\)\s*\.\s*map/i, title: 'filter().map() in sequence', severity: 'info' as const },
  { pattern: /async\s+function.*await.*for\s*\(|for\s*\(.*await/i, title: 'Sequential awaits in loop', severity: 'medium' as const },
  { pattern: /console\.(log|debug|info|warn|error)/i, title: 'Console statement', severity: 'info' as const },
  { pattern: /debugger;/i, title: 'Debugger statement', severity: 'medium' as const },
];

/**
 * Style patterns to detect
 */
const STYLE_PATTERNS = [
  { pattern: /TODO:|FIXME:|HACK:|XXX:/i, title: 'TODO/FIXME comment', severity: 'info' as const },
  { pattern: /^\s*\/\/\s*eslint-disable/i, title: 'ESLint disable comment', severity: 'low' as const },
  { pattern: /^\s*\/\*\s*eslint-disable/i, title: 'ESLint disable block', severity: 'low' as const },
  { pattern: /@ts-ignore/i, title: 'TypeScript @ts-ignore', severity: 'low' as const },
  { pattern: /@ts-nocheck/i, title: 'TypeScript @ts-nocheck', severity: 'medium' as const },
  { pattern: /any(?:\s|[;,)\]}])/i, title: 'TypeScript any type', severity: 'low' as const },
  { pattern: /function\s+\w+\s*\([^)]{100,}\)/i, title: 'Function with many parameters', severity: 'low' as const },
  { pattern: /^\s{200,}/i, title: 'Deep nesting', severity: 'low' as const },
];

/**
 * Bug patterns to detect
 */
const BUG_PATTERNS = [
  { pattern: /==\s*null(?!\s*\|)|null\s*==/i, title: 'Loose null comparison', severity: 'low' as const },
  { pattern: /===\s*undefined\s*\|\|\s*===\s*null|===\s*null\s*\|\|\s*===\s*undefined/i, title: 'Nullable check pattern', severity: 'info' as const },
  { pattern: /typeof\s+\w+\s*===?\s*["']undefined["']/i, title: 'typeof undefined check', severity: 'info' as const },
  { pattern: /new\s+Array\s*\(\s*\d+\s*\)/i, title: 'Array constructor with single number', severity: 'low' as const },
  { pattern: /parseInt\s*\([^,)]+\)/i, title: 'parseInt without radix', severity: 'low' as const },
  { pattern: /\[\s*\.\.\.\s*\]\s*=\s*undefined|\[\s*\.\.\.\s*\]\s*=\s*null/i, title: 'Destructuring null/undefined', severity: 'medium' as const },
  { pattern: /catch\s*\(\s*\w+\s*\)\s*\{\s*\}/i, title: 'Empty catch block', severity: 'medium' as const },
  { pattern: /return\s*;?\s*\n\s*[^}]/i, title: 'Unreachable code after return', severity: 'medium' as const },
  { pattern: /\bawait\b(?!.*\b(async|Promise|then)\b)/i, title: 'await without async context', severity: 'medium' as const },
];

/**
 * Analyze a PR's diff for issues
 */
export async function analyzePRDiff(input: AnalyzePRDiffInput): Promise<DiffAnalysisResult> {
  const { owner, repo, prNumber, focusAreas = ['all'] } = input;
  const client = getGitHubClient();

  try {
    // Fetch changed files
    const filesData = await client.execute(() =>
      client.client.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      })
    );

    // Parse the diffs
    const summary = parsePatchesFromFiles(filesData);

    // Analyze for issues
    const issues = analyzeForIssues(summary, focusAreas);

    // Generate suggestions
    const suggestions = generateSuggestions(summary, issues);

    // Calculate risk level
    const { riskLevel, riskFactors } = calculateRiskLevel(summary, issues);

    return {
      summary,
      issues,
      suggestions,
      riskLevel,
      riskFactors,
    };
  } catch (error) {
    if (error instanceof GitHubClientError) {
      throw error;
    }
    throw new GitHubClientError(
      `Failed to analyze PR diff: ${error instanceof Error ? error.message : 'Unknown error'}`,
      500
    );
  }
}

/**
 * Analyze diff for issues based on focus areas
 */
function analyzeForIssues(summary: DiffSummary, focusAreas: FocusArea[]): CodeIssue[] {
  const issues: CodeIssue[] = [];
  const checkAll = focusAreas.includes('all');
  let issueId = 0;

  for (const file of summary.fileBreakdown) {
    const addedLines = extractAddedLines(file.hunks);

    for (const { line, content } of addedLines) {
      // Security checks
      if (checkAll || focusAreas.includes('security')) {
        for (const check of SECURITY_PATTERNS) {
          if (check.pattern.test(content)) {
            issues.push({
              id: `issue-${++issueId}`,
              type: 'security',
              severity: check.severity,
              file: file.filename,
              line,
              title: check.title,
              description: `Potential security issue detected: ${check.title}`,
              suggestion: getSuggestionForPattern('security', check.title),
              rule: `security/${check.title.toLowerCase().replace(/\s+/g, '-')}`,
            });
          }
        }
      }

      // Performance checks
      if (checkAll || focusAreas.includes('performance')) {
        for (const check of PERFORMANCE_PATTERNS) {
          if (check.pattern.test(content)) {
            issues.push({
              id: `issue-${++issueId}`,
              type: 'performance',
              severity: check.severity,
              file: file.filename,
              line,
              title: check.title,
              description: `Performance concern: ${check.title}`,
              suggestion: getSuggestionForPattern('performance', check.title),
              rule: `performance/${check.title.toLowerCase().replace(/\s+/g, '-')}`,
            });
          }
        }
      }

      // Style checks
      if (checkAll || focusAreas.includes('style')) {
        for (const check of STYLE_PATTERNS) {
          if (check.pattern.test(content)) {
            issues.push({
              id: `issue-${++issueId}`,
              type: 'style',
              severity: check.severity,
              file: file.filename,
              line,
              title: check.title,
              description: `Style issue: ${check.title}`,
              suggestion: getSuggestionForPattern('style', check.title),
              rule: `style/${check.title.toLowerCase().replace(/\s+/g, '-')}`,
            });
          }
        }
      }

      // Bug checks
      if (checkAll || focusAreas.includes('bugs')) {
        for (const check of BUG_PATTERNS) {
          if (check.pattern.test(content)) {
            issues.push({
              id: `issue-${++issueId}`,
              type: 'bug',
              severity: check.severity,
              file: file.filename,
              line,
              title: check.title,
              description: `Potential bug: ${check.title}`,
              suggestion: getSuggestionForPattern('bug', check.title),
              rule: `bug/${check.title.toLowerCase().replace(/\s+/g, '-')}`,
            });
          }
        }
      }
    }
  }

  return issues;
}

/**
 * Get suggestion text for a detected pattern
 */
function getSuggestionForPattern(type: string, title: string): string {
  const suggestions: Record<string, Record<string, string>> = {
    security: {
      'Hardcoded password': 'Use environment variables or a secrets manager for credentials.',
      'Hardcoded API key': 'Store API keys in environment variables or a secure vault.',
      'Hardcoded secret': 'Move secrets to environment variables or a secrets manager.',
      'Use of eval()': 'Avoid eval(). Use safer alternatives like JSON.parse() or Function constructor with caution.',
      'Use of exec()': 'Sanitize input thoroughly or use safer alternatives.',
      'Direct innerHTML assignment': 'Use textContent for text or sanitize HTML before assignment.',
      'dangerouslySetInnerHTML usage': 'Ensure content is sanitized. Consider using a sanitization library.',
      'Potential SQL injection': 'Use parameterized queries or prepared statements.',
      'SQL query with template literal': 'Use parameterized queries instead of string interpolation.',
      'Non-HTTPS URL': 'Use HTTPS for all external resources.',
    },
    performance: {
      'Nested forEach loops': 'Consider using a Map or Set for O(1) lookup instead of nested iteration.',
      'Nested for loops': 'Consider restructuring to reduce algorithmic complexity.',
      'Deep clone using JSON': 'Use structuredClone() or a library like lodash.cloneDeep for better performance.',
      'Console statement': 'Remove console statements before production or use a proper logging library.',
      'Debugger statement': 'Remove debugger statements before merging.',
      'Sequential awaits in loop': 'Consider Promise.all() for parallel execution if order does not matter.',
    },
    style: {
      'TODO/FIXME comment': 'Create a tracking issue for this TODO item.',
      'ESLint disable comment': 'Address the underlying issue rather than disabling the rule.',
      'TypeScript @ts-ignore': 'Fix the type error rather than ignoring it.',
      'TypeScript @ts-nocheck': 'Enable type checking and fix type errors.',
      'TypeScript any type': 'Use a more specific type instead of any.',
    },
    bug: {
      'Loose null comparison': 'Use strict equality (===) for null checks.',
      'parseInt without radix': 'Always provide a radix to parseInt (e.g., parseInt(str, 10)).',
      'Empty catch block': 'Handle or log the error rather than silently catching it.',
      'Unreachable code after return': 'Remove or fix unreachable code.',
    },
  };

  return suggestions[type]?.[title] || 'Review this code for potential issues.';
}

/**
 * Generate improvement suggestions based on issues
 */
function generateSuggestions(summary: DiffSummary, issues: CodeIssue[]): Suggestion[] {
  const suggestions: Suggestion[] = [];
  let suggestionId = 0;

  // Group issues by file and line for suggestions
  const issuesByFile = issues.reduce(
    (acc, issue) => {
      if (!acc[issue.file]) {
        acc[issue.file] = [];
      }
      acc[issue.file].push(issue);
      return acc;
    },
    {} as Record<string, CodeIssue[]>
  );

  for (const file of summary.fileBreakdown) {
    const fileIssues = issuesByFile[file.filename] || [];

    // Generate suggestions for critical and high severity issues
    for (const issue of fileIssues.filter(i => i.severity === 'critical' || i.severity === 'high')) {
      if (issue.suggestion && issue.line) {
        suggestions.push({
          id: `suggestion-${++suggestionId}`,
          file: file.filename,
          line: issue.line,
          originalCode: '', // Would need actual code content
          suggestedCode: '', // Would need to generate specific fix
          reason: issue.suggestion,
          type: mapIssueTypeToSuggestionType(issue.type),
          confidence: issue.severity === 'critical' ? 'high' : 'medium',
        });
      }
    }
  }

  return suggestions;
}

/**
 * Map issue type to suggestion type
 */
function mapIssueTypeToSuggestionType(
  issueType: CodeIssue['type']
): Suggestion['type'] {
  switch (issueType) {
    case 'security':
      return 'security-fix';
    case 'performance':
      return 'optimization';
    case 'bug':
      return 'refactor';
    case 'style':
    case 'maintainability':
      return 'best-practice';
    default:
      return 'refactor';
  }
}

/**
 * Calculate risk level for the PR
 */
function calculateRiskLevel(
  summary: DiffSummary,
  issues: CodeIssue[]
): { riskLevel: DiffAnalysisResult['riskLevel']; riskFactors: string[] } {
  const riskFactors: string[] = [];
  let riskScore = 0;

  // Check for critical/high severity issues
  const criticalIssues = issues.filter(i => i.severity === 'critical').length;
  const highIssues = issues.filter(i => i.severity === 'high').length;

  if (criticalIssues > 0) {
    riskScore += criticalIssues * 10;
    riskFactors.push(`${criticalIssues} critical issue(s) found`);
  }
  if (highIssues > 0) {
    riskScore += highIssues * 5;
    riskFactors.push(`${highIssues} high severity issue(s) found`);
  }

  // Check for large changes
  if (summary.totalChanges > 1000) {
    riskScore += 3;
    riskFactors.push('Large number of changes (>1000 lines)');
  } else if (summary.totalChanges > 500) {
    riskScore += 2;
    riskFactors.push('Medium-large change size (>500 lines)');
  }

  // Check for many files changed
  if (summary.filesChanged > 20) {
    riskScore += 3;
    riskFactors.push('Many files changed (>20)');
  } else if (summary.filesChanged > 10) {
    riskScore += 1;
    riskFactors.push('Multiple files changed (>10)');
  }

  // Check for security-sensitive files
  const sensitiveFiles = summary.fileBreakdown.filter(f =>
    /\.(env|pem|key|secret|credential|password|auth)/i.test(f.filename) ||
    /(config|secret|credential|password|auth)/i.test(f.filename)
  );
  if (sensitiveFiles.length > 0) {
    riskScore += 5;
    riskFactors.push(`Security-sensitive files modified: ${sensitiveFiles.map(f => f.filename).join(', ')}`);
  }

  // Check for configuration files
  const configFiles = summary.fileBreakdown.filter(f =>
    /\.(json|yaml|yml|toml|ini|conf)$/i.test(f.filename) ||
    /package\.json|tsconfig|webpack|babel|eslint/i.test(f.filename)
  );
  if (configFiles.length > 0) {
    riskScore += 1;
    riskFactors.push('Configuration files modified');
  }

  // Determine risk level
  let riskLevel: DiffAnalysisResult['riskLevel'];
  if (riskScore >= 15) {
    riskLevel = 'critical';
  } else if (riskScore >= 8) {
    riskLevel = 'high';
  } else if (riskScore >= 3) {
    riskLevel = 'medium';
  } else {
    riskLevel = 'low';
  }

  return { riskLevel, riskFactors };
}

/**
 * Format analysis result as readable text
 */
export function formatAnalysisResult(result: DiffAnalysisResult): string {
  const lines: string[] = [
    '# Diff Analysis Report',
    '',
    '## Summary',
    `- **Files changed:** ${result.summary.filesChanged}`,
    `- **Lines added:** +${result.summary.totalAdditions}`,
    `- **Lines deleted:** -${result.summary.totalDeletions}`,
    `- **Total changes:** ${result.summary.totalChanges}`,
    '',
    `## Risk Assessment: ${result.riskLevel.toUpperCase()}`,
  ];

  if (result.riskFactors.length > 0) {
    lines.push('', '### Risk Factors:');
    result.riskFactors.forEach(factor => lines.push(`- ${factor}`));
  }

  if (result.issues.length > 0) {
    lines.push('', '## Issues Found', '');

    // Group by severity
    const bySeverity = {
      critical: result.issues.filter(i => i.severity === 'critical'),
      high: result.issues.filter(i => i.severity === 'high'),
      medium: result.issues.filter(i => i.severity === 'medium'),
      low: result.issues.filter(i => i.severity === 'low'),
      info: result.issues.filter(i => i.severity === 'info'),
    };

    for (const [severity, issues] of Object.entries(bySeverity)) {
      if (issues.length > 0) {
        lines.push(`### ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${issues.length})`);
        for (const issue of issues) {
          lines.push(`- **${issue.title}** in \`${issue.file}\`${issue.line ? `:${issue.line}` : ''}`);
          lines.push(`  ${issue.description}`);
          if (issue.suggestion) {
            lines.push(`  *Suggestion:* ${issue.suggestion}`);
          }
        }
        lines.push('');
      }
    }
  } else {
    lines.push('', 'No issues found in the analyzed areas.');
  }

  return lines.join('\n');
}
