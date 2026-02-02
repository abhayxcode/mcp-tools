/**
 * Comment Manager tool - Add inline or general review comments to PRs
 */

import { z } from 'zod';
import { getGitHubClient, GitHubClientError } from '../utils/github-client.js';
import type { AddCommentResult } from '../types.js';

/**
 * Input schema for add_review_comment tool
 */
export const AddReviewCommentInputSchema = z.object({
  owner: z.string().min(1).describe('Repository owner (username or organization)'),
  repo: z.string().min(1).describe('Repository name'),
  prNumber: z.number().int().positive().describe('Pull request number'),
  body: z.string().min(1).describe('The comment text (supports Markdown)'),
  path: z.string().optional().describe('The relative path of the file to comment on (for inline comments)'),
  line: z.number().int().positive().optional().describe('The line number in the file to comment on (for inline comments)'),
  side: z.enum(['LEFT', 'RIGHT']).optional().describe('The side of the diff to comment on. LEFT for deletions, RIGHT for additions. Defaults to RIGHT.'),
  commitId: z.string().optional().describe('The SHA of the commit to comment on. Defaults to the latest commit.'),
  startLine: z.number().int().positive().optional().describe('The starting line for a multi-line comment'),
  startSide: z.enum(['LEFT', 'RIGHT']).optional().describe('The side of the diff for the starting line'),
  subjectType: z.enum(['line', 'file']).optional().describe('The type of comment subject. Use "file" for file-level comments.'),
  inReplyTo: z.number().int().positive().optional().describe('The ID of a comment to reply to'),
});

export type AddReviewCommentInput = z.infer<typeof AddReviewCommentInputSchema>;

/**
 * Add a review comment to a PR
 */
export async function addReviewComment(input: AddReviewCommentInput): Promise<AddCommentResult> {
  const {
    owner,
    repo,
    prNumber,
    body,
    path,
    line,
    side = 'RIGHT',
    commitId,
    startLine,
    startSide,
    subjectType,
    inReplyTo,
  } = input;

  const client = getGitHubClient();

  try {
    // If replying to a comment, use the reply endpoint
    if (inReplyTo) {
      const result = await client.execute(() =>
        client.client.pulls.createReplyForReviewComment({
          owner,
          repo,
          pull_number: prNumber,
          comment_id: inReplyTo,
          body,
        })
      );

      return {
        id: result.id,
        url: result.html_url,
        body: result.body,
        createdAt: result.created_at,
      };
    }

    // If no path is provided, add a general issue comment
    if (!path) {
      const result = await client.execute(() =>
        client.client.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body,
        })
      );

      return {
        id: result.id,
        url: result.html_url,
        body: result.body || '',
        createdAt: result.created_at,
      };
    }

    // For inline comments, we need the commit SHA
    let sha = commitId;
    if (!sha) {
      // Get the latest commit SHA from the PR
      const prData = await client.execute(() =>
        client.client.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        })
      );
      sha = prData.head.sha;
    }

    // Build the review comment parameters
    const commentParams: {
      owner: string;
      repo: string;
      pull_number: number;
      body: string;
      commit_id: string;
      path: string;
      side?: 'LEFT' | 'RIGHT';
      line?: number;
      start_line?: number;
      start_side?: 'LEFT' | 'RIGHT';
      subject_type?: 'line' | 'file';
    } = {
      owner,
      repo,
      pull_number: prNumber,
      body,
      commit_id: sha,
      path,
      side,
    };

    // Add optional parameters
    if (line !== undefined) {
      commentParams.line = line;
    }
    if (startLine !== undefined) {
      commentParams.start_line = startLine;
      if (startSide) {
        commentParams.start_side = startSide;
      }
    }
    if (subjectType) {
      commentParams.subject_type = subjectType;
    }

    const result = await client.execute(() =>
      client.client.pulls.createReviewComment(commentParams)
    );

    return {
      id: result.id,
      url: result.html_url,
      body: result.body,
      createdAt: result.created_at,
    };
  } catch (error) {
    if (error instanceof GitHubClientError) {
      throw error;
    }

    // Handle specific errors with better messages
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage.includes('pull_request_review_thread.line')) {
      throw new GitHubClientError(
        'Invalid line number. The line must be part of the diff. Make sure you are commenting on a changed line.',
        422
      );
    }

    if (errorMessage.includes('path')) {
      throw new GitHubClientError(
        `Invalid file path: ${path}. The file must be part of the pull request diff.`,
        422
      );
    }

    throw new GitHubClientError(
      `Failed to add review comment: ${errorMessage}`,
      500
    );
  }
}

/**
 * Helper to create a suggestion comment body
 */
export function createSuggestionBody(
  description: string,
  suggestedCode: string
): string {
  return `${description}\n\n\`\`\`suggestion\n${suggestedCode}\n\`\`\``;
}

/**
 * Helper to create a code block comment
 */
export function createCodeBlockComment(
  description: string,
  code: string,
  language: string = ''
): string {
  return `${description}\n\n\`\`\`${language}\n${code}\n\`\`\``;
}

/**
 * Validate that the input is appropriate for the type of comment
 */
export function validateCommentInput(input: AddReviewCommentInput): string[] {
  const errors: string[] = [];

  // If path is provided, line should usually be provided too (unless file-level comment)
  if (input.path && !input.line && input.subjectType !== 'file') {
    errors.push('Line number is recommended when providing a file path for inline comments.');
  }

  // If startLine is provided, line must be provided and greater
  if (input.startLine !== undefined) {
    if (input.line === undefined) {
      errors.push('End line (line) must be provided when startLine is specified.');
    } else if (input.startLine >= input.line) {
      errors.push('startLine must be less than line for multi-line comments.');
    }
  }

  // If inReplyTo is provided, path and line should not be
  if (input.inReplyTo && (input.path || input.line)) {
    errors.push('When replying to a comment, do not specify path or line.');
  }

  return errors;
}

/**
 * Format a comment with metadata
 */
export function formatCommentWithMetadata(
  body: string,
  metadata: {
    issueId?: string;
    severity?: string;
    category?: string;
    automated?: boolean;
  }
): string {
  const parts: string[] = [];

  if (metadata.severity) {
    const emoji = getSeverityEmoji(metadata.severity);
    parts.push(`${emoji} **${metadata.severity.toUpperCase()}**`);
  }

  if (metadata.category) {
    parts.push(`[${metadata.category}]`);
  }

  if (parts.length > 0) {
    parts.push('\n\n');
  }

  parts.push(body);

  if (metadata.automated) {
    parts.push('\n\n---\n*This comment was generated automatically by Code Review Assistant*');
  }

  if (metadata.issueId) {
    parts.push(`\n<!-- issue-id: ${metadata.issueId} -->`);
  }

  return parts.join('');
}

/**
 * Get emoji for severity level
 */
function getSeverityEmoji(severity: string): string {
  switch (severity.toLowerCase()) {
    case 'critical':
      return ':rotating_light:';
    case 'high':
      return ':warning:';
    case 'medium':
      return ':large_orange_diamond:';
    case 'low':
      return ':information_source:';
    case 'info':
      return ':bulb:';
    default:
      return ':speech_balloon:';
  }
}
