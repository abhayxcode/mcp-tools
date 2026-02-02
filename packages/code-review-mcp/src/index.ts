#!/usr/bin/env node

/**
 * Code Review Assistant MCP Server
 *
 * An MCP server that provides tools for reviewing GitHub pull requests,
 * analyzing diffs, and managing review comments.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { getPRDetails, GetPRDetailsInputSchema, summarizePR } from './tools/pr-analyzer.js';
import { analyzePRDiff, AnalyzePRDiffInputSchema, formatAnalysisResult } from './tools/diff-reviewer.js';
import { addReviewComment, AddReviewCommentInputSchema, validateCommentInput } from './tools/comment-manager.js';
import {
  submitReview,
  SubmitReviewInputSchema,
  getReviewSuggestions,
  GetReviewSuggestionsInputSchema,
  getRecommendedAction,
} from './tools/suggestion-generator.js';
import { GitHubClientError } from './utils/github-client.js';

/**
 * Tool definitions for the MCP server
 */
const TOOLS = [
  {
    name: 'get_pr_details',
    description:
      'Fetch comprehensive information about a GitHub pull request including PR metadata, changed files, comments, and reviews.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: {
          type: 'string',
          description: 'Repository owner (username or organization)',
        },
        repo: {
          type: 'string',
          description: 'Repository name',
        },
        prNumber: {
          type: 'number',
          description: 'Pull request number',
        },
      },
      required: ['owner', 'repo', 'prNumber'],
    },
  },
  {
    name: 'analyze_pr_diff',
    description:
      'Analyze code changes in a pull request to identify potential issues in security, performance, style, and bugs. Returns a risk assessment and suggestions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: {
          type: 'string',
          description: 'Repository owner (username or organization)',
        },
        repo: {
          type: 'string',
          description: 'Repository name',
        },
        prNumber: {
          type: 'number',
          description: 'Pull request number',
        },
        focusAreas: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['security', 'performance', 'style', 'bugs', 'all'],
          },
          description: 'Areas to focus the analysis on. Defaults to all areas.',
        },
      },
      required: ['owner', 'repo', 'prNumber'],
    },
  },
  {
    name: 'add_review_comment',
    description:
      'Add a review comment to a pull request. Can be a general comment or an inline comment on a specific file and line.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: {
          type: 'string',
          description: 'Repository owner (username or organization)',
        },
        repo: {
          type: 'string',
          description: 'Repository name',
        },
        prNumber: {
          type: 'number',
          description: 'Pull request number',
        },
        body: {
          type: 'string',
          description: 'The comment text (supports Markdown)',
        },
        path: {
          type: 'string',
          description: 'The relative path of the file to comment on (for inline comments)',
        },
        line: {
          type: 'number',
          description: 'The line number in the file to comment on (for inline comments)',
        },
        side: {
          type: 'string',
          enum: ['LEFT', 'RIGHT'],
          description: 'The side of the diff to comment on. LEFT for deletions, RIGHT for additions.',
        },
      },
      required: ['owner', 'repo', 'prNumber', 'body'],
    },
  },
  {
    name: 'submit_review',
    description:
      'Submit a complete pull request review with an approval, request for changes, or comment. Can include inline comments.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: {
          type: 'string',
          description: 'Repository owner (username or organization)',
        },
        repo: {
          type: 'string',
          description: 'Repository name',
        },
        prNumber: {
          type: 'number',
          description: 'Pull request number',
        },
        body: {
          type: 'string',
          description: 'The review summary/body text',
        },
        event: {
          type: 'string',
          enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
          description: 'The review action',
        },
        comments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'The relative path of the file' },
              body: { type: 'string', description: 'The comment text' },
              line: { type: 'number', description: 'The line number' },
              side: { type: 'string', enum: ['LEFT', 'RIGHT'] },
              startLine: { type: 'number', description: 'Starting line for multi-line comment' },
              startSide: { type: 'string', enum: ['LEFT', 'RIGHT'] },
            },
            required: ['path', 'body'],
          },
          description: 'Optional array of inline comments',
        },
      },
      required: ['owner', 'repo', 'prNumber', 'body', 'event'],
    },
  },
  {
    name: 'get_review_suggestions',
    description:
      'Generate review suggestions based on diff analysis. Returns a list of suggestions, quality score, and summary.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: {
          type: 'string',
          description: 'Repository owner (username or organization)',
        },
        repo: {
          type: 'string',
          description: 'Repository name',
        },
        prNumber: {
          type: 'number',
          description: 'Pull request number',
        },
      },
      required: ['owner', 'repo', 'prNumber'],
    },
  },
];

/**
 * Create and configure the MCP server
 */
function createServer(): Server {
  const server = new Server(
    {
      name: 'code-review-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register list tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Register call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Validate GITHUB_TOKEN is set
    if (!process.env.GITHUB_TOKEN) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'GITHUB_TOKEN environment variable is required. Please set it before using this tool.'
      );
    }

    try {
      switch (name) {
        case 'get_pr_details': {
          const input = GetPRDetailsInputSchema.parse(args);
          const result = await getPRDetails(input);
          const summary = summarizePR(result);

          return {
            content: [
              {
                type: 'text',
                text: summary,
              },
              {
                type: 'text',
                text: `\n\n---\n\n**Raw Data:**\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
              },
            ],
          };
        }

        case 'analyze_pr_diff': {
          const input = AnalyzePRDiffInputSchema.parse(args);
          const result = await analyzePRDiff(input);
          const formatted = formatAnalysisResult(result);

          return {
            content: [
              {
                type: 'text',
                text: formatted,
              },
              {
                type: 'text',
                text: `\n\n---\n\n**Raw Data:**\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
              },
            ],
          };
        }

        case 'add_review_comment': {
          const input = AddReviewCommentInputSchema.parse(args);

          // Validate input
          const validationErrors = validateCommentInput(input);
          if (validationErrors.length > 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Validation warnings:\n${validationErrors.map(e => `- ${e}`).join('\n')}`,
                },
              ],
              isError: true,
            };
          }

          const result = await addReviewComment(input);

          return {
            content: [
              {
                type: 'text',
                text: `Comment added successfully!\n\n**ID:** ${result.id}\n**URL:** ${result.url}\n**Created:** ${result.createdAt}`,
              },
            ],
          };
        }

        case 'submit_review': {
          const input = SubmitReviewInputSchema.parse(args);
          const result = await submitReview(input);

          return {
            content: [
              {
                type: 'text',
                text: `Review submitted successfully!\n\n**ID:** ${result.id}\n**State:** ${result.state}\n**URL:** ${result.url}\n**Submitted:** ${result.submittedAt}`,
              },
            ],
          };
        }

        case 'get_review_suggestions': {
          const input = GetReviewSuggestionsInputSchema.parse(args);
          const result = await getReviewSuggestions(input);
          const recommendedAction = getRecommendedAction(result.suggestions, result.qualityScore);

          return {
            content: [
              {
                type: 'text',
                text: result.summary,
              },
              {
                type: 'text',
                text: `\n\n**Recommended Action:** ${recommendedAction}`,
              },
              {
                type: 'text',
                text: `\n\n---\n\n**Suggestions:**\n\`\`\`json\n${JSON.stringify(result.suggestions, null, 2)}\n\`\`\``,
              },
            ],
          };
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      // Handle Zod validation errors
      if (error instanceof z.ZodError) {
        const messages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid parameters:\n${messages.join('\n')}`
        );
      }

      // Handle GitHub API errors
      if (error instanceof GitHubClientError) {
        throw new McpError(
          error.status === 404 ? ErrorCode.InvalidParams : ErrorCode.InternalError,
          error.message
        );
      }

      // Re-throw MCP errors
      if (error instanceof McpError) {
        throw error;
      }

      // Handle unknown errors
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      throw new McpError(ErrorCode.InternalError, message);
    }
  });

  return server;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });

  // Connect and run
  await server.connect(transport);

  // Log to stderr so it doesn't interfere with stdio transport
  console.error('Code Review MCP server running on stdio');
}

// Run the server
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

// Export for testing
export { createServer, TOOLS };
