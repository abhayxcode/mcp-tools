/**
 * PR Analyzer tool - Fetches comprehensive PR information
 */

import { z } from 'zod';
import { getGitHubClient, GitHubClientError } from '../utils/github-client.js';
import type {
  PullRequest,
  ChangedFile,
  Comment,
  Review,
  PRDetailsResult,
} from '../types.js';

/**
 * Input schema for get_pr_details tool
 */
export const GetPRDetailsInputSchema = z.object({
  owner: z.string().min(1).describe('Repository owner (username or organization)'),
  repo: z.string().min(1).describe('Repository name'),
  prNumber: z.number().int().positive().describe('Pull request number'),
});

export type GetPRDetailsInput = z.infer<typeof GetPRDetailsInputSchema>;

/**
 * Fetch comprehensive PR details
 */
export async function getPRDetails(input: GetPRDetailsInput): Promise<PRDetailsResult> {
  const { owner, repo, prNumber } = input;
  const client = getGitHubClient();

  try {
    // Fetch PR, files, comments, and reviews in parallel
    const [prData, filesData, commentsData, reviewCommentsData, reviewsData] = await Promise.all([
      // Get PR details
      client.execute(() =>
        client.client.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        })
      ),

      // Get changed files
      client.execute(() =>
        client.client.pulls.listFiles({
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100,
        })
      ),

      // Get issue comments (general PR comments)
      client.execute(() =>
        client.client.issues.listComments({
          owner,
          repo,
          issue_number: prNumber,
          per_page: 100,
        })
      ),

      // Get review comments (inline comments)
      client.execute(() =>
        client.client.pulls.listReviewComments({
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100,
        })
      ),

      // Get reviews
      client.execute(() =>
        client.client.pulls.listReviews({
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100,
        })
      ),
    ]);

    // Transform PR data
    const pullRequest: PullRequest = {
      number: prData.number,
      title: prData.title,
      body: prData.body,
      state: prData.state as 'open' | 'closed',
      draft: prData.draft || false,
      merged: prData.merged || false,
      mergeable: prData.mergeable,
      mergeableState: prData.mergeable_state || 'unknown',
      user: {
        login: prData.user?.login || 'unknown',
        avatarUrl: prData.user?.avatar_url || '',
      },
      head: {
        ref: prData.head.ref,
        sha: prData.head.sha,
      },
      base: {
        ref: prData.base.ref,
        sha: prData.base.sha,
      },
      createdAt: prData.created_at,
      updatedAt: prData.updated_at,
      closedAt: prData.closed_at,
      mergedAt: prData.merged_at,
      additions: prData.additions || 0,
      deletions: prData.deletions || 0,
      changedFiles: prData.changed_files || 0,
      labels: prData.labels.map(label =>
        typeof label === 'string' ? label : label.name || ''
      ),
      reviewers: prData.requested_reviewers?.map(reviewer => {
        if (reviewer && typeof reviewer === 'object') {
          if ('login' in reviewer && reviewer.login) {
            return reviewer.login;
          }
          if ('name' in reviewer && reviewer.name) {
            return reviewer.name;
          }
        }
        return 'unknown';
      }) || [],
      assignees: prData.assignees?.map(assignee => assignee.login) || [],
      url: prData.url,
      htmlUrl: prData.html_url,
    };

    // Transform files data
    const files: ChangedFile[] = filesData.map(file => ({
      filename: file.filename,
      status: file.status as ChangedFile['status'],
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: file.patch,
      previousFilename: file.previous_filename,
      contentsUrl: file.contents_url,
      blobUrl: file.blob_url,
      rawUrl: file.raw_url,
    }));

    // Transform issue comments
    const issueComments: Comment[] = commentsData.map(comment => ({
      id: comment.id,
      body: comment.body || '',
      user: {
        login: comment.user?.login || 'unknown',
        avatarUrl: comment.user?.avatar_url || '',
      },
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      htmlUrl: comment.html_url,
    }));

    // Transform review comments (inline)
    const reviewComments: Comment[] = reviewCommentsData.map(comment => ({
      id: comment.id,
      body: comment.body,
      user: {
        login: comment.user?.login || 'unknown',
        avatarUrl: comment.user?.avatar_url || '',
      },
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      path: comment.path,
      line: comment.line || undefined,
      side: comment.side as 'LEFT' | 'RIGHT' | undefined,
      commitId: comment.commit_id,
      htmlUrl: comment.html_url,
      inReplyToId: comment.in_reply_to_id,
    }));

    // Combine all comments
    const comments: Comment[] = [...issueComments, ...reviewComments].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    // Transform reviews
    const reviews: Review[] = reviewsData.map(review => ({
      id: review.id,
      user: {
        login: review.user?.login || 'unknown',
        avatarUrl: review.user?.avatar_url || '',
      },
      body: review.body,
      state: review.state as Review['state'],
      submittedAt: review.submitted_at || null,
      commitId: review.commit_id,
      htmlUrl: review.html_url,
    }));

    return {
      pullRequest,
      files,
      comments,
      reviews,
    };
  } catch (error) {
    if (error instanceof GitHubClientError) {
      throw error;
    }
    throw new GitHubClientError(
      `Failed to fetch PR details: ${error instanceof Error ? error.message : 'Unknown error'}`,
      500
    );
  }
}

/**
 * Get a summary of the PR for quick overview
 */
export function summarizePR(result: PRDetailsResult): string {
  const { pullRequest, files, comments, reviews } = result;

  const approvals = reviews.filter(r => r.state === 'APPROVED').length;
  const changesRequested = reviews.filter(r => r.state === 'CHANGES_REQUESTED').length;

  const filesByType = files.reduce(
    (acc, file) => {
      acc[file.status] = (acc[file.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const lines = [
    `# PR #${pullRequest.number}: ${pullRequest.title}`,
    '',
    `**Author:** ${pullRequest.user.login}`,
    `**State:** ${pullRequest.state}${pullRequest.draft ? ' (draft)' : ''}${pullRequest.merged ? ' (merged)' : ''}`,
    `**Branch:** ${pullRequest.head.ref} -> ${pullRequest.base.ref}`,
    '',
    '## Changes',
    `- **Files changed:** ${pullRequest.changedFiles}`,
    `- **Additions:** +${pullRequest.additions}`,
    `- **Deletions:** -${pullRequest.deletions}`,
    '',
    '### File breakdown:',
    ...Object.entries(filesByType).map(([status, count]) => `- ${status}: ${count}`),
    '',
    '## Review Status',
    `- **Comments:** ${comments.length}`,
    `- **Reviews:** ${reviews.length}`,
    `- **Approvals:** ${approvals}`,
    `- **Changes requested:** ${changesRequested}`,
  ];

  if (pullRequest.labels.length > 0) {
    lines.push('', '## Labels', pullRequest.labels.map(l => `- ${l}`).join('\n'));
  }

  return lines.join('\n');
}
