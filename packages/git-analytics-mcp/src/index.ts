#!/usr/bin/env node

/**
 * Git Analytics MCP Server
 * Provides git repository analytics tools through the Model Context Protocol
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

// Import tool implementations
import { searchCommits, searchCommitsSchema } from './tools/commit-search.js';
import { analyzeCodeChurn, analyzeCodeChurnSchema } from './tools/code-churn.js';
import { getContributorStats, getContributorStatsSchema } from './tools/contributor-stats.js';
import { findBugIntroduction, findBugIntroductionSchema } from './tools/bug-tracker.js';
import { getRepoHealth, getRepoHealthSchema } from './tools/repo-health.js';

/**
 * Tool definitions with Zod schemas
 */
const TOOLS = {
  search_commits: {
    name: 'search_commits',
    description: `Search through git commit history with semantic matching.

Features:
- Searches commit messages and bodies for relevant content
- Supports filtering by author, date range, and path
- Returns relevance-scored results
- Shows file statistics for each commit

Example queries:
- "fix authentication bug"
- "add user profile feature"
- "refactor database connection"`,
    inputSchema: searchCommitsSchema,
    handler: searchCommits,
  },

  analyze_code_churn: {
    name: 'analyze_code_churn',
    description: `Analyze code churn to identify files with high change frequency (hotspots).

Features:
- Identifies files that change frequently (potential problem areas)
- Calculates churn rate (changes per day)
- Shows which authors modify each file
- Provides actionable recommendations

Use this to:
- Find code that might need refactoring
- Identify potential sources of bugs
- Understand team activity patterns`,
    inputSchema: analyzeCodeChurnSchema,
    handler: analyzeCodeChurn,
  },

  get_contributor_stats: {
    name: 'get_contributor_stats',
    description: `Get team contribution analytics with flexible grouping options.

Features:
- Detailed statistics per contributor (commits, lines, files)
- Activity streaks and patterns
- Timeline views by week or month
- Top files modified by each contributor

Use this to:
- Understand team productivity
- Identify knowledge silos
- Track project velocity over time`,
    inputSchema: getContributorStatsSchema,
    handler: getContributorStats,
  },

  find_bug_introduction: {
    name: 'find_bug_introduction',
    description: `Git bisect-style analysis to find when specific code patterns were introduced.

Features:
- Track when a pattern first appeared in a file
- Identify suspicious commits with risk scoring
- Full change timeline for a file
- Pattern matching with regex support

Use this to:
- Find when a bug was introduced
- Track the history of a specific code pattern
- Identify who and when changed critical code`,
    inputSchema: findBugIntroductionSchema,
    handler: findBugIntroduction,
  },

  get_repo_health: {
    name: 'get_repo_health',
    description: `Calculate comprehensive repository health score (0-100) with detailed metrics.

Metrics analyzed:
- Commit frequency: How often code is committed
- Average commit size: Are commits atomic and reviewable?
- Documentation ratio: Is the codebase well documented?
- Code churn rate: Is the code stable?
- Contributor activity: Is the team active?
- Branch health: Are there stale branches?

Returns:
- Overall health score and letter grade (A-F)
- Individual metric scores and status
- Actionable recommendations for improvement`,
    inputSchema: getRepoHealthSchema,
    handler: getRepoHealth,
  },
} as const;

/**
 * Convert Zod schema to JSON Schema for MCP
 */
function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodTypeAny;
    const description = zodType.description;

    // Handle optional types
    let innerType = zodType;
    let isOptional = false;

    if (zodType instanceof z.ZodOptional) {
      isOptional = true;
      innerType = zodType.unwrap();
    } else if (zodType instanceof z.ZodDefault) {
      isOptional = true;
      innerType = zodType.removeDefault();
    }

    // Determine the JSON Schema type
    let jsonType: Record<string, unknown> = {};

    if (innerType instanceof z.ZodString) {
      jsonType = { type: 'string' };
    } else if (innerType instanceof z.ZodNumber) {
      jsonType = { type: 'number' };
    } else if (innerType instanceof z.ZodBoolean) {
      jsonType = { type: 'boolean' };
    } else if (innerType instanceof z.ZodEnum) {
      jsonType = { type: 'string', enum: innerType.options };
    } else if (innerType instanceof z.ZodArray) {
      jsonType = { type: 'array' };
    } else if (innerType instanceof z.ZodObject) {
      jsonType = { type: 'object' };
    } else {
      jsonType = { type: 'string' }; // Default fallback
    }

    if (description) {
      jsonType.description = description;
    }

    properties[key] = jsonType;

    if (!isOptional) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/**
 * Create and configure the MCP server
 */
function createServer(): Server {
  const server = new Server(
    {
      name: 'git-analytics-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Object.values(TOOLS).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.inputSchema as z.ZodObject<z.ZodRawShape>),
      })),
    };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Find the tool
    const tool = TOOLS[name as keyof typeof TOOLS];
    if (!tool) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${name}`
      );
    }

    try {
      // Validate input with Zod
      const validatedInput = tool.inputSchema.parse(args);

      // Execute the tool handler
      const result = await (tool.handler as (input: unknown) => Promise<unknown>)(validatedInput);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      // Handle Zod validation errors
      if (error instanceof z.ZodError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid parameters: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`
        );
      }

      // Handle other errors
      if (error instanceof Error) {
        // Check for common git errors
        if (error.message.includes('Not a git repository')) {
          throw new McpError(
            ErrorCode.InvalidParams,
            error.message
          );
        }

        if (error.message.includes('File not found')) {
          throw new McpError(
            ErrorCode.InvalidParams,
            error.message
          );
        }

        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error.message}`
        );
      }

      throw new McpError(
        ErrorCode.InternalError,
        'An unexpected error occurred'
      );
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

  await server.connect(transport);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });

  // Log to stderr to avoid interfering with stdio transport
  console.error('Git Analytics MCP server started');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

// Export tools for programmatic use
export {
  searchCommits,
  searchCommitsSchema,
  analyzeCodeChurn,
  analyzeCodeChurnSchema,
  getContributorStats,
  getContributorStatsSchema,
  findBugIntroduction,
  findBugIntroductionSchema,
  getRepoHealth,
  getRepoHealthSchema,
};

// Export types
export * from './types.js';
