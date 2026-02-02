#!/usr/bin/env node

/**
 * Architecture Visualizer MCP Server
 *
 * Provides tools for:
 * - Generating dependency graphs
 * - Detecting circular dependencies
 * - Mapping module relationships
 * - Analyzing code complexity
 * - Generating architecture overviews
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  generateDependencyGraph,
  generateDependencyGraphInputSchema,
  formatDependencyGraphOutput,
} from './tools/dependency-graph.js';

import {
  detectCircularDependencies,
  detectCircularDependenciesInputSchema,
  formatCircularDependenciesOutput,
} from './tools/circular-detector.js';

import {
  mapModuleRelationships,
  mapModuleRelationshipsInputSchema,
  formatModuleRelationshipsOutput,
} from './tools/module-mapper.js';

import {
  analyzeComplexity,
  analyzeComplexityInputSchema,
  formatComplexityOutput,
  getArchitectureOverview,
  getArchitectureOverviewInputSchema,
  formatArchitectureOverviewOutput,
} from './tools/complexity-analyzer.js';

/**
 * Tool definitions
 */
const tools: Tool[] = [
  {
    name: 'generate_dependency_graph',
    description: `Generate a dependency graph for a codebase in various formats (mermaid, dot, json).

Analyzes imports and exports to build a comprehensive dependency graph showing how modules relate to each other.

Use cases:
- Visualize project structure
- Understand module relationships
- Identify highly connected modules
- Find entry points and leaf nodes

Supports: TypeScript, JavaScript, Python`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the directory or file to analyze',
        },
        format: {
          type: 'string',
          enum: ['mermaid', 'dot', 'json'],
          default: 'mermaid',
          description: 'Output format for the graph',
        },
        depth: {
          type: 'number',
          default: 10,
          description: 'Maximum depth for dependency resolution',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          default: [],
          description: 'Patterns to exclude from analysis',
        },
        language: {
          type: 'string',
          enum: ['typescript', 'javascript', 'python', 'auto'],
          default: 'auto',
          description: 'Programming language to analyze',
        },
        includeExternal: {
          type: 'boolean',
          default: false,
          description: 'Include external/npm dependencies',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'detect_circular_dependencies',
    description: `Detect circular dependencies in a codebase using Tarjan's algorithm.

Finds all circular import chains and provides:
- Severity ratings (low, medium, high, critical)
- Affected files list
- Suggestions for breaking cycles
- Visualization of cycles

Use cases:
- Find and fix circular imports
- Improve code architecture
- Prevent import issues

Supports: TypeScript, JavaScript, Python`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the directory to analyze',
        },
        language: {
          type: 'string',
          enum: ['typescript', 'javascript', 'python', 'auto'],
          default: 'auto',
          description: 'Programming language to analyze',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          default: [],
          description: 'Patterns to exclude from analysis',
        },
        maxCycles: {
          type: 'number',
          default: 20,
          description: 'Maximum number of cycles to report',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'map_module_relationships',
    description: `Analyze module coupling and cohesion with support for grouping.

Provides detailed analysis of:
- Module relationships and dependencies
- Coupling metrics (afferent/efferent)
- Cohesion scores
- Group-level analysis

Grouping options:
- directory: Group by folder structure
- package: Group by package.json/__init__.py
- feature: Group by feature patterns (api, models, services, etc.)
- layer: Group by architectural layers

Supports: TypeScript, JavaScript, Python`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the directory to analyze',
        },
        groupBy: {
          type: 'string',
          enum: ['directory', 'package', 'feature', 'layer'],
          default: 'directory',
          description: 'How to group modules',
        },
        language: {
          type: 'string',
          enum: ['typescript', 'javascript', 'python', 'auto'],
          default: 'auto',
          description: 'Programming language to analyze',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          default: [],
          description: 'Patterns to exclude from analysis',
        },
        depth: {
          type: 'number',
          default: 2,
          description: 'Directory depth for grouping',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'analyze_complexity',
    description: `Calculate cyclomatic complexity per file and function.

Analyzes code complexity and identifies hotspots:
- Cyclomatic complexity per function
- Lines of code analysis
- Maintainability index
- Complexity hotspots above threshold

Priority levels: low, medium, high, critical

Supports: TypeScript, JavaScript, Python`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the directory or file to analyze',
        },
        threshold: {
          type: 'number',
          default: 10,
          description: 'Complexity threshold for flagging hotspots',
        },
        language: {
          type: 'string',
          enum: ['typescript', 'javascript', 'python', 'auto'],
          default: 'auto',
          description: 'Programming language to analyze',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          default: [],
          description: 'Patterns to exclude from analysis',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_architecture_overview',
    description: `Generate a high-level architecture summary of a codebase.

Provides:
- Identified architectural layers
- Entry points detection
- External dependency analysis
- Architecture style classification
- Mermaid diagram visualization

Detected layers:
- Presentation (controllers, api, routes)
- Business (services, domain, usecases)
- Data (repositories, models, database)
- Infrastructure (adapters, clients)
- Utility (utils, helpers, common)

Supports: TypeScript, JavaScript, Python`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the directory to analyze',
        },
        language: {
          type: 'string',
          enum: ['typescript', 'javascript', 'python', 'auto'],
          default: 'auto',
          description: 'Programming language to analyze',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          default: [],
          description: 'Patterns to exclude from analysis',
        },
      },
      required: ['path'],
    },
  },
];

/**
 * Create and configure the MCP server
 */
const server = new Server(
  {
    name: 'architecture-visualizer-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Handle list_tools request
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

/**
 * Handle call_tool request
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'generate_dependency_graph': {
        const input = generateDependencyGraphInputSchema.parse(args);
        const result = await generateDependencyGraph(input);
        const formatted = formatDependencyGraphOutput(result);
        return {
          content: [
            {
              type: 'text',
              text: formatted,
            },
          ],
        };
      }

      case 'detect_circular_dependencies': {
        const input = detectCircularDependenciesInputSchema.parse(args);
        const result = await detectCircularDependencies(input);
        const formatted = formatCircularDependenciesOutput(result);
        return {
          content: [
            {
              type: 'text',
              text: formatted,
            },
          ],
        };
      }

      case 'map_module_relationships': {
        const input = mapModuleRelationshipsInputSchema.parse(args);
        const result = await mapModuleRelationships(input);
        const formatted = formatModuleRelationshipsOutput(result, input.path);
        return {
          content: [
            {
              type: 'text',
              text: formatted,
            },
          ],
        };
      }

      case 'analyze_complexity': {
        const input = analyzeComplexityInputSchema.parse(args);
        const result = await analyzeComplexity(input);
        const formatted = formatComplexityOutput(result, input.path);
        return {
          content: [
            {
              type: 'text',
              text: formatted,
            },
          ],
        };
      }

      case 'get_architecture_overview': {
        const input = getArchitectureOverviewInputSchema.parse(args);
        const result = await getArchitectureOverview(input);
        const formatted = formatArchitectureOverviewOutput(result, input.path);
        return {
          content: [
            {
              type: 'text',
              text: formatted,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Handle Zod validation errors specially
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      return {
        content: [
          {
            type: 'text',
            text: `Validation error: ${issues}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Architecture Visualizer MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

// Export for testing
export { server, tools };
