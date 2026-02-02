/**
 * Dependency Graph Tool
 * Generates dependency graphs in various formats (mermaid, dot, json)
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  GraphStats,
  Relationship,
  OutputFormat,
  SupportedLanguage,
} from '../types.js';
import {
  buildGraph,
  calculateGraphStats,
  generateMermaidDiagram,
  generateDotDiagram,
  generateJsonGraph,
  findCycles,
} from '../utils/graph-utils.js';
import { parseTypeScriptFile, scanDirectory, extractDependencies as extractTsDependencies } from '../parsers/typescript-parser.js';
import { parseJavaScriptFile, extractDependencies as extractJsDependencies } from '../parsers/javascript-parser.js';
import { parsePythonFile, extractDependencies as extractPyDependencies, scanPythonFiles } from '../parsers/python-parser.js';

/**
 * Input schema for generate_dependency_graph tool
 */
export const generateDependencyGraphInputSchema = z.object({
  path: z.string().describe('Path to the directory or file to analyze'),
  format: z.enum(['mermaid', 'dot', 'json']).optional().default('mermaid').describe('Output format for the graph'),
  depth: z.number().optional().default(10).describe('Maximum depth for dependency resolution'),
  exclude: z.array(z.string()).optional().default([]).describe('Patterns to exclude from analysis'),
  language: z.enum(['typescript', 'javascript', 'python', 'auto']).optional().default('auto').describe('Programming language to analyze'),
  includeExternal: z.boolean().optional().default(false).describe('Include external/npm dependencies'),
});

export type GenerateDependencyGraphInput = z.infer<typeof generateDependencyGraphInputSchema>;

/**
 * Output type for generate_dependency_graph tool
 */
export interface GenerateDependencyGraphOutput {
  graph: string;
  format: OutputFormat;
  stats: GraphStats;
  files: number;
  hasCycles: boolean;
  cycleCount: number;
}

/**
 * Detect the primary language in a directory
 */
function detectLanguage(dirPath: string): SupportedLanguage {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    let tsCount = 0;
    let jsCount = 0;
    let pyCount = 0;

    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (['.ts', '.tsx'].includes(ext)) tsCount++;
        if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) jsCount++;
        if (ext === '.py') pyCount++;
      }
    }

    // Check for config files
    if (fs.existsSync(path.join(dirPath, 'tsconfig.json'))) {
      return 'typescript';
    }
    if (fs.existsSync(path.join(dirPath, 'requirements.txt')) ||
        fs.existsSync(path.join(dirPath, 'setup.py')) ||
        fs.existsSync(path.join(dirPath, 'pyproject.toml'))) {
      return 'python';
    }

    // Count files
    if (tsCount > jsCount && tsCount > pyCount) return 'typescript';
    if (pyCount > jsCount) return 'python';
    return 'javascript';
  } catch {
    return 'javascript';
  }
}

/**
 * Scan files based on language
 */
function scanFiles(
  dirPath: string,
  language: SupportedLanguage,
  exclude: string[]
): string[] {
  const defaultExclude = ['node_modules', 'dist', 'build', '.git', 'coverage', '__pycache__', 'venv', '.venv'];
  const allExclude = [...new Set([...defaultExclude, ...exclude])];

  if (language === 'python') {
    return scanPythonFiles(dirPath, { exclude: allExclude });
  }

  const extensions = language === 'typescript'
    ? ['.ts', '.tsx', '.js', '.jsx']
    : ['.js', '.jsx', '.mjs', '.cjs'];

  return scanDirectory(dirPath, { exclude: allExclude, extensions });
}

/**
 * Extract relationships from files
 */
function extractRelationships(
  files: string[],
  basePath: string,
  language: SupportedLanguage,
  includeExternal: boolean
): Relationship[] {
  const relationships: Relationship[] = [];
  const fileSet = new Set(files.map(f => path.resolve(f)));

  for (const file of files) {
    let dependencies;

    try {
      if (language === 'python') {
        dependencies = extractPyDependencies(file, basePath);
      } else if (language === 'typescript') {
        dependencies = extractTsDependencies(file, basePath);
      } else {
        dependencies = extractJsDependencies(file, basePath);
      }

      for (const dep of dependencies) {
        // Skip external dependencies unless requested
        if (dep.type === 'external' && !includeExternal) {
          continue;
        }

        // Skip builtin dependencies
        if (dep.type === 'builtin') {
          continue;
        }

        // Only include internal dependencies that exist in our file set
        if (dep.type === 'internal') {
          const resolvedTarget = path.resolve(dep.to);
          if (!fileSet.has(resolvedTarget)) {
            // Try common extensions
            const extensions = language === 'python' ? ['.py'] : ['.ts', '.tsx', '.js', '.jsx', ''];
            let found = false;
            for (const ext of extensions) {
              if (fileSet.has(resolvedTarget + ext)) {
                relationships.push({
                  source: file,
                  target: resolvedTarget + ext,
                  type: 'import',
                  weight: 1,
                });
                found = true;
                break;
              }
            }
            if (!found && includeExternal) {
              // Include unresolved as potentially external
              relationships.push({
                source: file,
                target: dep.to,
                type: 'import',
                weight: 1,
              });
            }
          } else {
            relationships.push({
              source: file,
              target: resolvedTarget,
              type: 'import',
              weight: 1,
            });
          }
        } else if (dep.type === 'external' && includeExternal) {
          relationships.push({
            source: file,
            target: dep.packageName || dep.to,
            type: 'import',
            weight: 1,
          });
        }
      }
    } catch (error) {
      console.error(`Error extracting dependencies from ${file}:`, error);
    }
  }

  return relationships;
}

/**
 * Generate dependency graph
 */
export async function generateDependencyGraph(
  input: GenerateDependencyGraphInput
): Promise<GenerateDependencyGraphOutput> {
  const { path: inputPath, format = 'mermaid', depth = 10, exclude = [], language: inputLanguage = 'auto', includeExternal = false } = input;

  // Validate path exists
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Path does not exist: ${inputPath}`);
  }

  const isDirectory = fs.statSync(inputPath).isDirectory();
  const basePath = isDirectory ? inputPath : path.dirname(inputPath);

  // Detect or use specified language
  const language: SupportedLanguage = inputLanguage === 'auto'
    ? detectLanguage(basePath)
    : inputLanguage;

  // Scan for files
  let files: string[];
  if (isDirectory) {
    files = scanFiles(inputPath, language, exclude);
  } else {
    files = [inputPath];
  }

  if (files.length === 0) {
    return {
      graph: format === 'json' ? '{"nodes":[],"edges":[]}' : `graph TB\n  empty[No files found]`,
      format,
      stats: {
        totalNodes: 0,
        totalEdges: 0,
        averageDependencies: 0,
        maxDependencies: 0,
        mostConnected: [],
        entryPoints: [],
        leafNodes: [],
      },
      files: 0,
      hasCycles: false,
      cycleCount: 0,
    };
  }

  // Extract relationships
  const relationships = extractRelationships(files, basePath, language, includeExternal);

  // Build graph
  const graph = buildGraph(relationships);

  // Ensure all files are in the graph as nodes
  for (const file of files) {
    if (!graph.hasNode(file)) {
      graph.setNode(file, { path: file });
    }
  }

  // Calculate stats
  const stats = calculateGraphStats(graph);

  // Find cycles
  const cycles = findCycles(graph);

  // Generate output in requested format
  let graphOutput: string;

  switch (format) {
    case 'dot':
      graphOutput = generateDotDiagram(graph, {
        rankdir: 'TB',
        maxNodes: 100,
        cycles,
      });
      break;

    case 'json':
      graphOutput = generateJsonGraph(graph);
      break;

    case 'mermaid':
    default:
      graphOutput = generateMermaidDiagram(graph, {
        direction: 'TB',
        showWeights: false,
        maxNodes: 100,
        highlightCycles: true,
        cycles,
      });
      break;
  }

  return {
    graph: graphOutput,
    format,
    stats,
    files: files.length,
    hasCycles: cycles.length > 0,
    cycleCount: cycles.length,
  };
}

/**
 * Format the output for display
 */
export function formatDependencyGraphOutput(output: GenerateDependencyGraphOutput): string {
  const lines: string[] = [];

  lines.push('## Dependency Graph Analysis\n');

  lines.push('### Statistics');
  lines.push(`- **Files Analyzed**: ${output.files}`);
  lines.push(`- **Total Nodes**: ${output.stats.totalNodes}`);
  lines.push(`- **Total Edges**: ${output.stats.totalEdges}`);
  lines.push(`- **Average Dependencies**: ${output.stats.averageDependencies.toFixed(2)}`);
  lines.push(`- **Max Dependencies**: ${output.stats.maxDependencies}`);
  lines.push(`- **Has Cycles**: ${output.hasCycles ? `Yes (${output.cycleCount} found)` : 'No'}`);

  if (output.stats.entryPoints.length > 0) {
    lines.push(`\n### Entry Points (${output.stats.entryPoints.length})`);
    for (const entry of output.stats.entryPoints.slice(0, 10)) {
      lines.push(`- ${path.basename(entry)}`);
    }
    if (output.stats.entryPoints.length > 10) {
      lines.push(`- ... and ${output.stats.entryPoints.length - 10} more`);
    }
  }

  if (output.stats.leafNodes.length > 0) {
    lines.push(`\n### Leaf Nodes (${output.stats.leafNodes.length})`);
    for (const leaf of output.stats.leafNodes.slice(0, 10)) {
      lines.push(`- ${path.basename(leaf)}`);
    }
    if (output.stats.leafNodes.length > 10) {
      lines.push(`- ... and ${output.stats.leafNodes.length - 10} more`);
    }
  }

  if (output.stats.mostConnected.length > 0) {
    lines.push('\n### Most Connected');
    for (const node of output.stats.mostConnected.slice(0, 5)) {
      lines.push(`- ${path.basename(node)}`);
    }
  }

  lines.push(`\n### ${output.format.toUpperCase()} Graph\n`);

  if (output.format === 'mermaid') {
    lines.push('```mermaid');
    lines.push(output.graph);
    lines.push('```');
  } else if (output.format === 'dot') {
    lines.push('```dot');
    lines.push(output.graph);
    lines.push('```');
  } else {
    lines.push('```json');
    lines.push(output.graph);
    lines.push('```');
  }

  return lines.join('\n');
}
