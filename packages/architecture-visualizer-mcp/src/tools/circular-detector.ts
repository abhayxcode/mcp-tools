/**
 * Circular Dependency Detector Tool
 * Uses Tarjan's algorithm to find circular imports
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { DependencyCycle, Relationship, SupportedLanguage } from '../types.js';
import { buildGraph, findCycles, getShortName } from '../utils/graph-utils.js';
import { scanDirectory, extractDependencies as extractTsDependencies } from '../parsers/typescript-parser.js';
import { extractDependencies as extractJsDependencies } from '../parsers/javascript-parser.js';
import { extractDependencies as extractPyDependencies, scanPythonFiles } from '../parsers/python-parser.js';

/**
 * Input schema for detect_circular_dependencies tool
 */
export const detectCircularDependenciesInputSchema = z.object({
  path: z.string().describe('Path to the directory to analyze'),
  language: z.enum(['typescript', 'javascript', 'python', 'auto']).optional().default('auto').describe('Programming language to analyze'),
  exclude: z.array(z.string()).optional().default([]).describe('Patterns to exclude from analysis'),
  maxCycles: z.number().optional().default(20).describe('Maximum number of cycles to report'),
});

export type DetectCircularDependenciesInput = z.infer<typeof detectCircularDependenciesInputSchema>;

/**
 * Output type for detect_circular_dependencies tool
 */
export interface DetectCircularDependenciesOutput {
  hasCycles: boolean;
  totalCycles: number;
  cycles: DependencyCycle[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  affectedFiles: string[];
  recommendations: string[];
}

/**
 * Detect the primary language in a directory
 */
function detectLanguage(dirPath: string): SupportedLanguage {
  try {
    // Check for config files
    if (fs.existsSync(path.join(dirPath, 'tsconfig.json'))) {
      return 'typescript';
    }
    if (fs.existsSync(path.join(dirPath, 'requirements.txt')) ||
        fs.existsSync(path.join(dirPath, 'setup.py')) ||
        fs.existsSync(path.join(dirPath, 'pyproject.toml'))) {
      return 'python';
    }

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
  language: SupportedLanguage
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
        // Only consider internal dependencies for cycle detection
        if (dep.type !== 'internal') continue;

        const resolvedTarget = path.resolve(dep.to);

        // Check if target exists in our file set
        if (fileSet.has(resolvedTarget)) {
          relationships.push({
            source: file,
            target: resolvedTarget,
            type: 'import',
            weight: 1,
          });
          continue;
        }

        // Try common extensions
        const extensions = language === 'python' ? ['.py'] : ['.ts', '.tsx', '.js', '.jsx', ''];
        for (const ext of extensions) {
          const withExt = resolvedTarget + ext;
          if (fileSet.has(withExt)) {
            relationships.push({
              source: file,
              target: withExt,
              type: 'import',
              weight: 1,
            });
            break;
          }
          // Check for index file
          const indexPath = path.join(resolvedTarget, 'index' + ext);
          if (fileSet.has(indexPath)) {
            relationships.push({
              source: file,
              target: indexPath,
              type: 'import',
              weight: 1,
            });
            break;
          }
        }
      }
    } catch (error) {
      console.error(`Error extracting dependencies from ${file}:`, error);
    }
  }

  return relationships;
}

/**
 * Generate recommendations based on detected cycles
 */
function generateRecommendations(cycles: DependencyCycle[]): string[] {
  const recommendations: string[] = [];

  if (cycles.length === 0) {
    return ['No circular dependencies detected. Great job maintaining clean architecture!'];
  }

  // Count severity
  const criticalCount = cycles.filter(c => c.severity === 'critical').length;
  const highCount = cycles.filter(c => c.severity === 'high').length;

  if (criticalCount > 0) {
    recommendations.push(
      `URGENT: ${criticalCount} critical cycle(s) found. These should be addressed immediately as they can cause unpredictable behavior.`
    );
  }

  if (highCount > 0) {
    recommendations.push(
      `${highCount} high-severity cycle(s) need attention. Consider refactoring these modules.`
    );
  }

  // General recommendations
  if (cycles.length > 5) {
    recommendations.push(
      'Multiple cycles detected. Consider a broader architectural review to identify design issues.'
    );
  }

  // Specific patterns
  const twoNodeCycles = cycles.filter(c => c.length === 2);
  if (twoNodeCycles.length > 0) {
    recommendations.push(
      'Two-node cycles often indicate modules that should be merged or have a common dependency extracted.'
    );
  }

  const largerCycles = cycles.filter(c => c.length >= 4);
  if (largerCycles.length > 0) {
    recommendations.push(
      'Larger cycles (4+ modules) suggest a need for dependency injection or event-based communication.'
    );
  }

  // Add general best practices
  recommendations.push(
    'General tips for breaking cycles:',
    '- Extract shared code into a separate utility module',
    '- Use dependency injection to invert dependencies',
    '- Implement interfaces/protocols to decouple modules',
    '- Consider using an event bus for cross-module communication',
    '- Apply the Dependency Inversion Principle'
  );

  return recommendations;
}

/**
 * Detect circular dependencies
 */
export async function detectCircularDependencies(
  input: DetectCircularDependenciesInput
): Promise<DetectCircularDependenciesOutput> {
  const { path: inputPath, language: inputLanguage = 'auto', exclude = [], maxCycles = 20 } = input;

  // Validate path exists
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Path does not exist: ${inputPath}`);
  }

  if (!fs.statSync(inputPath).isDirectory()) {
    throw new Error(`Path must be a directory: ${inputPath}`);
  }

  // Detect or use specified language
  const language: SupportedLanguage = inputLanguage === 'auto'
    ? detectLanguage(inputPath)
    : inputLanguage;

  // Scan for files
  const files = scanFiles(inputPath, language, exclude);

  if (files.length === 0) {
    return {
      hasCycles: false,
      totalCycles: 0,
      cycles: [],
      summary: { critical: 0, high: 0, medium: 0, low: 0 },
      affectedFiles: [],
      recommendations: ['No files found to analyze.'],
    };
  }

  // Extract relationships
  const relationships = extractRelationships(files, inputPath, language);

  // Build graph
  const graph = buildGraph(relationships);

  // Find cycles using Tarjan's algorithm
  const allCycles = findCycles(graph);

  // Limit cycles for output
  const cycles = allCycles.slice(0, maxCycles);

  // Calculate summary
  const summary = {
    critical: allCycles.filter(c => c.severity === 'critical').length,
    high: allCycles.filter(c => c.severity === 'high').length,
    medium: allCycles.filter(c => c.severity === 'medium').length,
    low: allCycles.filter(c => c.severity === 'low').length,
  };

  // Get affected files
  const affectedFilesSet = new Set<string>();
  for (const cycle of allCycles) {
    for (const node of cycle.nodes) {
      affectedFilesSet.add(node);
    }
  }
  const affectedFiles = Array.from(affectedFilesSet);

  // Generate recommendations
  const recommendations = generateRecommendations(allCycles);

  return {
    hasCycles: allCycles.length > 0,
    totalCycles: allCycles.length,
    cycles,
    summary,
    affectedFiles,
    recommendations,
  };
}

/**
 * Format the output for display
 */
export function formatCircularDependenciesOutput(output: DetectCircularDependenciesOutput): string {
  const lines: string[] = [];

  lines.push('## Circular Dependency Analysis\n');

  // Summary
  lines.push('### Summary');
  if (output.hasCycles) {
    lines.push(`- **Total Cycles Found**: ${output.totalCycles}`);
    lines.push(`  - Critical: ${output.summary.critical}`);
    lines.push(`  - High: ${output.summary.high}`);
    lines.push(`  - Medium: ${output.summary.medium}`);
    lines.push(`  - Low: ${output.summary.low}`);
    lines.push(`- **Affected Files**: ${output.affectedFiles.length}`);
  } else {
    lines.push('**No circular dependencies detected!**');
  }

  // Cycles detail
  if (output.cycles.length > 0) {
    lines.push('\n### Detected Cycles\n');

    for (let i = 0; i < output.cycles.length; i++) {
      const cycle = output.cycles[i];
      const severityEmoji = {
        critical: '[CRITICAL]',
        high: '[HIGH]',
        medium: '[MEDIUM]',
        low: '[LOW]',
      }[cycle.severity];

      lines.push(`#### Cycle ${i + 1} ${severityEmoji}`);
      lines.push(`**Modules involved (${cycle.length}):**`);

      // Show cycle path
      const cyclePath = cycle.nodes.map(n => getShortName(n)).join(' -> ') + ' -> ' + getShortName(cycle.nodes[0]);
      lines.push(`\`${cyclePath}\``);

      lines.push('\n**Suggestions:**');
      for (const suggestion of cycle.suggestions.slice(0, 3)) {
        lines.push(`- ${suggestion}`);
      }
      lines.push('');
    }

    if (output.totalCycles > output.cycles.length) {
      lines.push(`\n*... and ${output.totalCycles - output.cycles.length} more cycles not shown*\n`);
    }
  }

  // Affected files
  if (output.affectedFiles.length > 0) {
    lines.push('\n### Affected Files');
    for (const file of output.affectedFiles.slice(0, 20)) {
      lines.push(`- \`${getShortName(file)}\``);
    }
    if (output.affectedFiles.length > 20) {
      lines.push(`- ... and ${output.affectedFiles.length - 20} more`);
    }
  }

  // Recommendations
  lines.push('\n### Recommendations');
  for (const rec of output.recommendations) {
    lines.push(`- ${rec}`);
  }

  // Mermaid diagram for visualization
  if (output.cycles.length > 0 && output.cycles.length <= 5) {
    lines.push('\n### Visualization\n');
    lines.push('```mermaid');
    lines.push('graph LR');

    const nodeMap = new Map<string, string>();
    let nodeCounter = 0;

    for (const cycle of output.cycles.slice(0, 3)) {
      for (const node of cycle.nodes) {
        if (!nodeMap.has(node)) {
          const nodeId = `n${nodeCounter++}`;
          nodeMap.set(node, nodeId);
          lines.push(`  ${nodeId}[${getShortName(node)}]:::cycle`);
        }
      }

      for (let i = 0; i < cycle.nodes.length; i++) {
        const from = cycle.nodes[i];
        const to = cycle.nodes[(i + 1) % cycle.nodes.length];
        lines.push(`  ${nodeMap.get(from)} -.-> ${nodeMap.get(to)}`);
      }
    }

    lines.push('  classDef cycle fill:#ff6b6b,stroke:#c92a2a');
    lines.push('```');
  }

  return lines.join('\n');
}
