/**
 * Complexity Analyzer Tool
 * Calculates cyclomatic complexity and generates architecture overview
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  FileComplexity,
  ComplexityHotspot,
  ArchitectureOverview,
  ArchitectureLayer,
  ExternalDependency,
  SupportedLanguage,
  FunctionComplexity,
} from '../types.js';
import { buildGraph, calculateGraphStats, getShortName } from '../utils/graph-utils.js';
import { scanDirectory, extractDependencies as extractTsDependencies, calculateComplexity as calculateTsComplexity } from '../parsers/typescript-parser.js';
import { extractDependencies as extractJsDependencies, calculateComplexity as calculateJsComplexity } from '../parsers/javascript-parser.js';
import { extractDependencies as extractPyDependencies, scanPythonFiles, calculatePythonComplexity, parsePythonFunctions } from '../parsers/python-parser.js';

/**
 * Input schema for analyze_complexity tool
 */
export const analyzeComplexityInputSchema = z.object({
  path: z.string().describe('Path to the directory or file to analyze'),
  threshold: z.number().optional().default(10).describe('Complexity threshold for flagging hotspots'),
  language: z.enum(['typescript', 'javascript', 'python', 'auto']).optional().default('auto').describe('Programming language to analyze'),
  exclude: z.array(z.string()).optional().default([]).describe('Patterns to exclude from analysis'),
});

export type AnalyzeComplexityInput = z.infer<typeof analyzeComplexityInputSchema>;

/**
 * Output type for analyze_complexity tool
 */
export interface AnalyzeComplexityOutput {
  totalFiles: number;
  totalComplexity: number;
  averageComplexity: number;
  files: FileComplexity[];
  hotspots: ComplexityHotspot[];
  summary: {
    lowComplexity: number;
    mediumComplexity: number;
    highComplexity: number;
    veryHighComplexity: number;
  };
}

/**
 * Input schema for get_architecture_overview tool
 */
export const getArchitectureOverviewInputSchema = z.object({
  path: z.string().describe('Path to the directory to analyze'),
  language: z.enum(['typescript', 'javascript', 'python', 'auto']).optional().default('auto').describe('Programming language to analyze'),
  exclude: z.array(z.string()).optional().default([]).describe('Patterns to exclude from analysis'),
});

export type GetArchitectureOverviewInput = z.infer<typeof getArchitectureOverviewInputSchema>;

/**
 * Detect the primary language in a directory
 */
function detectLanguage(dirPath: string): SupportedLanguage {
  try {
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
 * Calculate file complexity for TypeScript/JavaScript
 */
function calculateTsFileComplexity(filePath: string): FileComplexity | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const linesOfCode = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*');
    }).length;

    const functions = calculateTsComplexity(filePath);
    const totalComplexity = functions.reduce((sum, f) => sum + f.complexity, 0);

    // Calculate maintainability index (simplified Halstead-based)
    const avgComplexity = functions.length > 0 ? totalComplexity / functions.length : 1;
    const maintainabilityIndex = Math.max(0, Math.min(100,
      171 - 5.2 * Math.log(avgComplexity + 1) - 0.23 * avgComplexity - 16.2 * Math.log(linesOfCode + 1)
    ));

    return {
      path: filePath,
      cyclomaticComplexity: totalComplexity || 1,
      functionCount: functions.length,
      linesOfCode,
      functionsComplexity: functions,
      maintainabilityIndex: Math.round(maintainabilityIndex),
    };
  } catch (error) {
    console.error(`Error calculating complexity for ${filePath}:`, error);
    return null;
  }
}

/**
 * Calculate file complexity for Python
 */
function calculatePyFileComplexity(filePath: string): FileComplexity | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const linesOfCode = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('#');
    }).length;

    const { complexity, functions: funcCount } = calculatePythonComplexity(filePath);
    const pyFunctions = parsePythonFunctions(filePath);

    const functionsComplexity: FunctionComplexity[] = pyFunctions.map(f => ({
      name: f.name,
      startLine: f.startLine,
      endLine: f.endLine,
      complexity: f.complexity,
      parameterCount: f.parameterCount,
      maxNestingDepth: 0, // Not calculated for Python
    }));

    const avgComplexity = funcCount > 0 ? complexity / funcCount : 1;
    const maintainabilityIndex = Math.max(0, Math.min(100,
      171 - 5.2 * Math.log(avgComplexity + 1) - 0.23 * avgComplexity - 16.2 * Math.log(linesOfCode + 1)
    ));

    return {
      path: filePath,
      cyclomaticComplexity: complexity,
      functionCount: funcCount,
      linesOfCode,
      functionsComplexity,
      maintainabilityIndex: Math.round(maintainabilityIndex),
    };
  } catch (error) {
    console.error(`Error calculating Python complexity for ${filePath}:`, error);
    return null;
  }
}

/**
 * Identify complexity hotspots
 */
function identifyHotspots(files: FileComplexity[], threshold: number): ComplexityHotspot[] {
  const hotspots: ComplexityHotspot[] = [];

  for (const file of files) {
    // Check file-level complexity
    if (file.cyclomaticComplexity >= threshold * 2) {
      hotspots.push({
        path: file.path,
        line: 1,
        complexity: file.cyclomaticComplexity,
        threshold: threshold * 2,
        reason: `File has very high total complexity (${file.cyclomaticComplexity})`,
        priority: file.cyclomaticComplexity >= threshold * 4 ? 'critical' : 'high',
      });
    }

    // Check function-level complexity
    for (const func of file.functionsComplexity) {
      if (func.complexity >= threshold) {
        let priority: 'low' | 'medium' | 'high' | 'critical';
        if (func.complexity >= threshold * 3) {
          priority = 'critical';
        } else if (func.complexity >= threshold * 2) {
          priority = 'high';
        } else if (func.complexity >= threshold * 1.5) {
          priority = 'medium';
        } else {
          priority = 'low';
        }

        hotspots.push({
          path: file.path,
          functionName: func.name,
          line: func.startLine,
          complexity: func.complexity,
          threshold,
          reason: `Function '${func.name}' has complexity ${func.complexity} (threshold: ${threshold})`,
          priority,
        });
      }
    }

    // Check maintainability
    if (file.maintainabilityIndex < 20) {
      hotspots.push({
        path: file.path,
        line: 1,
        complexity: file.cyclomaticComplexity,
        threshold: 20,
        reason: `Low maintainability index (${file.maintainabilityIndex}/100)`,
        priority: file.maintainabilityIndex < 10 ? 'critical' : 'high',
      });
    }
  }

  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  return hotspots.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}

/**
 * Analyze complexity
 */
export async function analyzeComplexity(
  input: AnalyzeComplexityInput
): Promise<AnalyzeComplexityOutput> {
  const { path: inputPath, threshold = 10, language: inputLanguage = 'auto', exclude = [] } = input;

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
  let filePaths: string[];
  if (isDirectory) {
    filePaths = scanFiles(inputPath, language, exclude);
  } else {
    filePaths = [inputPath];
  }

  if (filePaths.length === 0) {
    return {
      totalFiles: 0,
      totalComplexity: 0,
      averageComplexity: 0,
      files: [],
      hotspots: [],
      summary: {
        lowComplexity: 0,
        mediumComplexity: 0,
        highComplexity: 0,
        veryHighComplexity: 0,
      },
    };
  }

  // Calculate complexity for each file
  const files: FileComplexity[] = [];
  for (const filePath of filePaths) {
    let fileComplexity: FileComplexity | null;

    if (language === 'python') {
      fileComplexity = calculatePyFileComplexity(filePath);
    } else {
      fileComplexity = calculateTsFileComplexity(filePath);
    }

    if (fileComplexity) {
      files.push(fileComplexity);
    }
  }

  // Calculate totals
  const totalComplexity = files.reduce((sum, f) => sum + f.cyclomaticComplexity, 0);
  const averageComplexity = files.length > 0 ? totalComplexity / files.length : 0;

  // Identify hotspots
  const hotspots = identifyHotspots(files, threshold);

  // Categorize files
  const summary = {
    lowComplexity: files.filter(f => f.cyclomaticComplexity < threshold).length,
    mediumComplexity: files.filter(f => f.cyclomaticComplexity >= threshold && f.cyclomaticComplexity < threshold * 2).length,
    highComplexity: files.filter(f => f.cyclomaticComplexity >= threshold * 2 && f.cyclomaticComplexity < threshold * 4).length,
    veryHighComplexity: files.filter(f => f.cyclomaticComplexity >= threshold * 4).length,
  };

  return {
    totalFiles: files.length,
    totalComplexity,
    averageComplexity,
    files: files.sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity),
    hotspots,
    summary,
  };
}

/**
 * Identify architecture layers
 */
function identifyLayers(files: string[], basePath: string): ArchitectureLayer[] {
  const layerPatterns: Array<{
    pattern: RegExp;
    name: string;
    type: ArchitectureLayer['type'];
    description: string;
  }> = [
    { pattern: /\/(controllers?|api|routes?|handlers?|endpoints?)\//i, name: 'Presentation', type: 'presentation', description: 'Handles HTTP requests and responses' },
    { pattern: /\/(services?|business|domain|usecases?|core)\//i, name: 'Business Logic', type: 'business', description: 'Contains core business logic and rules' },
    { pattern: /\/(repositories?|data|db|database|models?|entities?)\//i, name: 'Data Access', type: 'data', description: 'Manages data persistence and retrieval' },
    { pattern: /\/(infrastructure|external|adapters?|clients?)\//i, name: 'Infrastructure', type: 'infrastructure', description: 'External service integrations and infrastructure concerns' },
    { pattern: /\/(utils?|helpers?|lib|common|shared)\//i, name: 'Utilities', type: 'utility', description: 'Shared utilities and helper functions' },
  ];

  const layers = new Map<string, { modules: string[]; type: ArchitectureLayer['type']; description: string }>();
  const unmatchedFiles: string[] = [];

  for (const file of files) {
    const relativePath = '/' + path.relative(basePath, file);
    let matched = false;

    for (const { pattern, name, type, description } of layerPatterns) {
      if (pattern.test(relativePath)) {
        if (!layers.has(name)) {
          layers.set(name, { modules: [], type, description });
        }
        layers.get(name)!.modules.push(file);
        matched = true;
        break;
      }
    }

    if (!matched) {
      unmatchedFiles.push(file);
    }
  }

  // Add unmatched files to "Unknown" layer
  if (unmatchedFiles.length > 0) {
    layers.set('Other', {
      modules: unmatchedFiles,
      type: 'unknown',
      description: 'Files not matching standard layer patterns',
    });
  }

  // Convert to array and determine dependencies
  const result: ArchitectureLayer[] = [];
  for (const [name, data] of layers) {
    result.push({
      name,
      description: data.description,
      modules: data.modules,
      dependsOn: [], // Will be filled by dependency analysis
      type: data.type,
    });
  }

  return result;
}

/**
 * Identify external dependencies
 */
function identifyExternalDependencies(
  files: string[],
  basePath: string,
  language: SupportedLanguage
): ExternalDependency[] {
  const externalDeps = new Map<string, { usedBy: Set<string>; count: number }>();

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
        if (dep.type === 'external' && dep.packageName) {
          if (!externalDeps.has(dep.packageName)) {
            externalDeps.set(dep.packageName, { usedBy: new Set(), count: 0 });
          }
          externalDeps.get(dep.packageName)!.usedBy.add(file);
          externalDeps.get(dep.packageName)!.count++;
        }
      }
    } catch (error) {
      // Continue on error
    }
  }

  // Categorize dependencies
  const frameworkPatterns = [
    /^react/, /^vue/, /^angular/, /^express/, /^fastapi/, /^django/, /^flask/,
    /^next/, /^nuxt/, /^nest/, /^koa/,
  ];

  const result: ExternalDependency[] = [];
  for (const [name, data] of externalDeps) {
    let category: ExternalDependency['category'] = 'library';

    if (frameworkPatterns.some(p => p.test(name))) {
      category = 'framework';
    } else if (name.includes('dev') || name.startsWith('@types/')) {
      category = 'dev';
    } else if (/^(lodash|underscore|moment|dayjs|uuid|axios|fetch)/.test(name)) {
      category = 'utility';
    }

    result.push({
      name,
      usedBy: Array.from(data.usedBy),
      usageCount: data.count,
      category,
    });
  }

  return result.sort((a, b) => b.usageCount - a.usageCount);
}

/**
 * Determine architecture style
 */
function determineArchitectureStyle(layers: ArchitectureLayer[], files: string[]): string {
  const hasPresentation = layers.some(l => l.type === 'presentation');
  const hasBusiness = layers.some(l => l.type === 'business');
  const hasData = layers.some(l => l.type === 'data');
  const hasInfrastructure = layers.some(l => l.type === 'infrastructure');

  // Check for specific patterns in file paths
  const hasComponents = files.some(f => /\/components?\//i.test(f));
  const hasPages = files.some(f => /\/pages?\//i.test(f));
  const hasHooks = files.some(f => /\/hooks?\//i.test(f));
  const hasFeatures = files.some(f => /\/features?\//i.test(f));
  const hasModules = files.some(f => /\/modules?\//i.test(f));

  if (hasFeatures || hasModules) {
    return 'Feature-Sliced / Modular Architecture';
  }

  if (hasComponents && hasPages && hasHooks) {
    return 'Component-Based Frontend Architecture';
  }

  if (hasPresentation && hasBusiness && hasData) {
    if (hasInfrastructure) {
      return 'Clean Architecture / Hexagonal';
    }
    return 'Layered Architecture (3-tier)';
  }

  if (hasPresentation && hasData) {
    return 'MVC-like Architecture';
  }

  if (layers.length === 1) {
    return 'Flat / Monolithic Structure';
  }

  return 'Mixed / Custom Architecture';
}

/**
 * Generate Mermaid diagram for architecture overview
 */
function generateArchitectureDiagram(
  layers: ArchitectureLayer[],
  externalDeps: ExternalDependency[]
): string {
  const lines: string[] = ['graph TB'];

  // Add subgraphs for each layer
  let nodeId = 0;
  const layerNodes = new Map<string, string>();

  for (const layer of layers) {
    const layerId = `layer${nodeId++}`;
    layerNodes.set(layer.name, layerId);

    const sanitizedName = layer.name.replace(/[^a-zA-Z0-9]/g, '_');
    const moduleCount = layer.modules.length;

    lines.push(`  ${layerId}[${sanitizedName}<br/>${moduleCount} modules]`);

    // Style based on layer type
    switch (layer.type) {
      case 'presentation':
        lines.push(`  class ${layerId} presentation`);
        break;
      case 'business':
        lines.push(`  class ${layerId} business`);
        break;
      case 'data':
        lines.push(`  class ${layerId} data`);
        break;
      case 'infrastructure':
        lines.push(`  class ${layerId} infrastructure`);
        break;
      default:
        lines.push(`  class ${layerId} utility`);
    }
  }

  // Add external dependencies (top 5)
  const topDeps = externalDeps.slice(0, 5);
  if (topDeps.length > 0) {
    lines.push('  subgraph External');

    for (const dep of topDeps) {
      const depId = `ext${nodeId++}`;
      const sanitizedName = dep.name.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 15);
      lines.push(`    ${depId}((${sanitizedName}))`);
    }

    lines.push('  end');
  }

  // Add typical layer dependencies
  const layerOrder = ['Presentation', 'Business Logic', 'Data Access', 'Infrastructure'];
  for (let i = 0; i < layerOrder.length - 1; i++) {
    const fromId = layerNodes.get(layerOrder[i]);
    const toId = layerNodes.get(layerOrder[i + 1]);
    if (fromId && toId) {
      lines.push(`  ${fromId} --> ${toId}`);
    }
  }

  // Add utility connections
  const utilityId = layerNodes.get('Utilities');
  if (utilityId) {
    for (const [name, id] of layerNodes) {
      if (name !== 'Utilities') {
        lines.push(`  ${id} -.-> ${utilityId}`);
      }
    }
  }

  // Add styles
  lines.push('  classDef presentation fill:#a8e6cf,stroke:#2d6a4f');
  lines.push('  classDef business fill:#ffd3b6,stroke:#f4a261');
  lines.push('  classDef data fill:#dcedc1,stroke:#52796f');
  lines.push('  classDef infrastructure fill:#ffaaa5,stroke:#e07a5f');
  lines.push('  classDef utility fill:#d4a5a5,stroke:#9b5de5');

  return lines.join('\n');
}

/**
 * Get architecture overview
 */
export async function getArchitectureOverview(
  input: GetArchitectureOverviewInput
): Promise<ArchitectureOverview> {
  const { path: inputPath, language: inputLanguage = 'auto', exclude = [] } = input;

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
      layers: [],
      entryPoints: [],
      externalDependencies: [],
      architectureStyle: 'Empty project',
      mermaidDiagram: 'graph TB\n  empty[No files found]',
      summary: {
        totalFiles: 0,
        totalDependencies: 0,
        layerCount: 0,
        externalDependencyCount: 0,
      },
    };
  }

  // Identify layers
  const layers = identifyLayers(files, inputPath);

  // Identify external dependencies
  const externalDependencies = identifyExternalDependencies(files, inputPath, language);

  // Find entry points
  const entryPointPatterns = [
    /\/(index|main|app|server|cli)\.(ts|js|py)$/i,
    /\/__init__\.py$/,
    /\/package\.json$/,
  ];
  const entryPoints = files.filter(f =>
    entryPointPatterns.some(p => p.test(f))
  );

  // Determine architecture style
  const architectureStyle = determineArchitectureStyle(layers, files);

  // Generate Mermaid diagram
  const mermaidDiagram = generateArchitectureDiagram(layers, externalDependencies);

  return {
    layers,
    entryPoints,
    externalDependencies,
    architectureStyle,
    mermaidDiagram,
    summary: {
      totalFiles: files.length,
      totalDependencies: externalDependencies.reduce((sum, d) => sum + d.usageCount, 0),
      layerCount: layers.length,
      externalDependencyCount: externalDependencies.length,
    },
  };
}

/**
 * Format complexity output for display
 */
export function formatComplexityOutput(output: AnalyzeComplexityOutput, basePath: string): string {
  const lines: string[] = [];

  lines.push('## Complexity Analysis\n');

  // Summary
  lines.push('### Summary');
  lines.push(`- **Files Analyzed**: ${output.totalFiles}`);
  lines.push(`- **Total Complexity**: ${output.totalComplexity}`);
  lines.push(`- **Average Complexity**: ${output.averageComplexity.toFixed(2)}`);
  lines.push('');
  lines.push('**Distribution:**');
  lines.push(`- Low complexity: ${output.summary.lowComplexity} files`);
  lines.push(`- Medium complexity: ${output.summary.mediumComplexity} files`);
  lines.push(`- High complexity: ${output.summary.highComplexity} files`);
  lines.push(`- Very high complexity: ${output.summary.veryHighComplexity} files`);

  // Hotspots
  if (output.hotspots.length > 0) {
    lines.push('\n### Complexity Hotspots\n');

    const grouped = {
      critical: output.hotspots.filter(h => h.priority === 'critical'),
      high: output.hotspots.filter(h => h.priority === 'high'),
      medium: output.hotspots.filter(h => h.priority === 'medium'),
      low: output.hotspots.filter(h => h.priority === 'low'),
    };

    for (const [priority, hotspots] of Object.entries(grouped)) {
      if (hotspots.length === 0) continue;

      lines.push(`#### ${priority.toUpperCase()} Priority (${hotspots.length})\n`);

      for (const hotspot of hotspots.slice(0, 10)) {
        const relativePath = path.relative(basePath, hotspot.path);
        if (hotspot.functionName) {
          lines.push(`- **${relativePath}:${hotspot.line}** - \`${hotspot.functionName}\``);
        } else {
          lines.push(`- **${relativePath}**`);
        }
        lines.push(`  - ${hotspot.reason}`);
      }

      if (hotspots.length > 10) {
        lines.push(`  - ... and ${hotspots.length - 10} more`);
      }
      lines.push('');
    }
  }

  // Top complex files
  lines.push('### Most Complex Files\n');
  lines.push('| File | Complexity | Functions | Lines | Maintainability |');
  lines.push('|------|------------|-----------|-------|-----------------|');

  for (const file of output.files.slice(0, 15)) {
    const relativePath = path.relative(basePath, file.path);
    const shortPath = relativePath.length > 40 ? '...' + relativePath.slice(-37) : relativePath;
    lines.push(`| ${shortPath} | ${file.cyclomaticComplexity} | ${file.functionCount} | ${file.linesOfCode} | ${file.maintainabilityIndex}/100 |`);
  }

  // Recommendations
  lines.push('\n### Recommendations\n');

  if (output.summary.veryHighComplexity > 0) {
    lines.push(`- **URGENT**: ${output.summary.veryHighComplexity} file(s) have very high complexity and should be refactored immediately.`);
  }

  if (output.summary.highComplexity > 0) {
    lines.push(`- ${output.summary.highComplexity} file(s) have high complexity. Consider breaking them into smaller modules.`);
  }

  const criticalHotspots = output.hotspots.filter(h => h.priority === 'critical');
  if (criticalHotspots.length > 0) {
    lines.push(`- ${criticalHotspots.length} critical hotspot(s) need immediate attention.`);
  }

  lines.push('- Consider using:');
  lines.push('  - Strategy pattern to reduce conditional complexity');
  lines.push('  - Extract Method refactoring for long functions');
  lines.push('  - Guard clauses to flatten nested conditions');

  return lines.join('\n');
}

/**
 * Format architecture overview for display
 */
export function formatArchitectureOverviewOutput(output: ArchitectureOverview, basePath: string): string {
  const lines: string[] = [];

  lines.push('## Architecture Overview\n');

  // Summary
  lines.push('### Summary');
  lines.push(`- **Architecture Style**: ${output.architectureStyle}`);
  lines.push(`- **Total Files**: ${output.summary.totalFiles}`);
  lines.push(`- **Layers**: ${output.summary.layerCount}`);
  lines.push(`- **External Dependencies**: ${output.summary.externalDependencyCount}`);

  // Entry Points
  if (output.entryPoints.length > 0) {
    lines.push('\n### Entry Points');
    for (const entry of output.entryPoints) {
      lines.push(`- \`${path.relative(basePath, entry)}\``);
    }
  }

  // Layers
  lines.push('\n### Architecture Layers\n');
  for (const layer of output.layers) {
    lines.push(`#### ${layer.name}`);
    lines.push(`*${layer.description}*\n`);
    lines.push(`- Type: ${layer.type}`);
    lines.push(`- Modules: ${layer.modules.length}`);

    if (layer.modules.length <= 5) {
      for (const mod of layer.modules) {
        lines.push(`  - \`${path.relative(basePath, mod)}\``);
      }
    } else {
      for (const mod of layer.modules.slice(0, 3)) {
        lines.push(`  - \`${path.relative(basePath, mod)}\``);
      }
      lines.push(`  - ... and ${layer.modules.length - 3} more`);
    }
    lines.push('');
  }

  // External Dependencies
  if (output.externalDependencies.length > 0) {
    lines.push('### External Dependencies\n');
    lines.push('| Package | Category | Usage Count |');
    lines.push('|---------|----------|-------------|');

    for (const dep of output.externalDependencies.slice(0, 15)) {
      lines.push(`| ${dep.name} | ${dep.category} | ${dep.usageCount} |`);
    }

    if (output.externalDependencies.length > 15) {
      lines.push(`\n*... and ${output.externalDependencies.length - 15} more dependencies*`);
    }
  }

  // Mermaid Diagram
  lines.push('\n### Architecture Diagram\n');
  lines.push('```mermaid');
  lines.push(output.mermaidDiagram);
  lines.push('```');

  return lines.join('\n');
}
