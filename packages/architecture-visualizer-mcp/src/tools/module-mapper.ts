/**
 * Module Relationship Mapper Tool
 * Analyzes module coupling and cohesion with support for grouping
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  ModuleInfo,
  Relationship,
  CouplingMetrics,
  ModuleGroup,
  ModuleRelationshipResult,
  SupportedLanguage,
  GroupByOption,
} from '../types.js';
import { buildGraph, getShortName } from '../utils/graph-utils.js';
import { parseTypeScriptFile, scanDirectory, extractDependencies as extractTsDependencies } from '../parsers/typescript-parser.js';
import { parseJavaScriptFile, extractDependencies as extractJsDependencies } from '../parsers/javascript-parser.js';
import { parsePythonFile, extractDependencies as extractPyDependencies, scanPythonFiles } from '../parsers/python-parser.js';

/**
 * Input schema for map_module_relationships tool
 */
export const mapModuleRelationshipsInputSchema = z.object({
  path: z.string().describe('Path to the directory to analyze'),
  groupBy: z.enum(['directory', 'package', 'feature', 'layer']).optional().default('directory').describe('How to group modules'),
  language: z.enum(['typescript', 'javascript', 'python', 'auto']).optional().default('auto').describe('Programming language to analyze'),
  exclude: z.array(z.string()).optional().default([]).describe('Patterns to exclude from analysis'),
  depth: z.number().optional().default(2).describe('Directory depth for grouping'),
});

export type MapModuleRelationshipsInput = z.infer<typeof mapModuleRelationshipsInputSchema>;

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
 * Parse module information from a file
 */
function parseModuleInfo(filePath: string, language: SupportedLanguage): ModuleInfo | null {
  if (language === 'python') {
    return parsePythonFile(filePath);
  } else if (language === 'typescript') {
    return parseTypeScriptFile(filePath);
  } else {
    return parseJavaScriptFile(filePath);
  }
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
        if (dep.type !== 'internal') continue;

        const resolvedTarget = path.resolve(dep.to);

        if (fileSet.has(resolvedTarget)) {
          relationships.push({
            source: file,
            target: resolvedTarget,
            type: 'import',
            imports: dep.importStatements,
            weight: dep.importStatements.length,
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
              imports: dep.importStatements,
              weight: dep.importStatements.length,
            });
            break;
          }
          const indexPath = path.join(resolvedTarget, 'index' + ext);
          if (fileSet.has(indexPath)) {
            relationships.push({
              source: file,
              target: indexPath,
              type: 'import',
              imports: dep.importStatements,
              weight: dep.importStatements.length,
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
 * Group modules by directory
 */
function groupByDirectory(files: string[], basePath: string, depth: number): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  for (const file of files) {
    const relativePath = path.relative(basePath, file);
    const parts = path.dirname(relativePath).split(path.sep);
    const groupName = parts.slice(0, depth).join('/') || 'root';

    if (!groups.has(groupName)) {
      groups.set(groupName, []);
    }
    groups.get(groupName)!.push(file);
  }

  return groups;
}

/**
 * Group modules by package (package.json or __init__.py)
 */
function groupByPackage(files: string[], basePath: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const packageCache = new Map<string, string>();

  function findPackage(filePath: string): string {
    if (packageCache.has(filePath)) {
      return packageCache.get(filePath)!;
    }

    let dir = path.dirname(filePath);
    while (dir.startsWith(basePath)) {
      // Check for package markers
      if (fs.existsSync(path.join(dir, 'package.json')) ||
          fs.existsSync(path.join(dir, '__init__.py')) ||
          fs.existsSync(path.join(dir, 'setup.py'))) {
        const packageName = path.relative(basePath, dir) || 'root';
        packageCache.set(filePath, packageName);
        return packageName;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    const packageName = 'root';
    packageCache.set(filePath, packageName);
    return packageName;
  }

  for (const file of files) {
    const packageName = findPackage(file);
    if (!groups.has(packageName)) {
      groups.set(packageName, []);
    }
    groups.get(packageName)!.push(file);
  }

  return groups;
}

/**
 * Group modules by feature (heuristic based on common patterns)
 */
function groupByFeature(files: string[], basePath: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const featurePatterns = [
    { pattern: /\/(api|routes?|endpoints?|handlers?)\//i, feature: 'api' },
    { pattern: /\/(models?|entities?|schemas?)\//i, feature: 'models' },
    { pattern: /\/(services?|business|domain)\//i, feature: 'services' },
    { pattern: /\/(utils?|helpers?|lib|common)\//i, feature: 'utilities' },
    { pattern: /\/(components?|ui|views?|pages?)\//i, feature: 'ui' },
    { pattern: /\/(tests?|spec|__tests__)\//i, feature: 'tests' },
    { pattern: /\/(config|settings?|constants?)\//i, feature: 'config' },
    { pattern: /\/(middlewares?)\//i, feature: 'middleware' },
    { pattern: /\/(repositories?|data|db|database)\//i, feature: 'data' },
  ];

  for (const file of files) {
    const relativePath = '/' + path.relative(basePath, file);
    let featureName = 'other';

    for (const { pattern, feature } of featurePatterns) {
      if (pattern.test(relativePath)) {
        featureName = feature;
        break;
      }
    }

    if (!groups.has(featureName)) {
      groups.set(featureName, []);
    }
    groups.get(featureName)!.push(file);
  }

  return groups;
}

/**
 * Group modules by architectural layer
 */
function groupByLayer(files: string[], basePath: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const layerPatterns = [
    { pattern: /\/(controllers?|api|routes?|handlers?|endpoints?)\//i, layer: 'presentation' },
    { pattern: /\/(services?|business|domain|usecases?)\//i, layer: 'business' },
    { pattern: /\/(repositories?|data|db|database|models?)\//i, layer: 'data' },
    { pattern: /\/(infrastructure|external|adapters?)\//i, layer: 'infrastructure' },
    { pattern: /\/(utils?|helpers?|lib|common|shared)\//i, layer: 'utility' },
  ];

  for (const file of files) {
    const relativePath = '/' + path.relative(basePath, file);
    let layerName = 'unknown';

    for (const { pattern, layer } of layerPatterns) {
      if (pattern.test(relativePath)) {
        layerName = layer;
        break;
      }
    }

    if (!groups.has(layerName)) {
      groups.set(layerName, []);
    }
    groups.get(layerName)!.push(file);
  }

  return groups;
}

/**
 * Calculate coupling metrics for each module
 */
function calculateCouplingMetrics(
  files: string[],
  relationships: Relationship[]
): Record<string, CouplingMetrics> {
  const metrics: Record<string, CouplingMetrics> = {};

  for (const file of files) {
    // Afferent coupling (incoming dependencies)
    const incoming = relationships.filter(r => r.target === file).length;

    // Efferent coupling (outgoing dependencies)
    const outgoing = relationships.filter(r => r.source === file).length;

    // Instability
    const total = incoming + outgoing;
    const instability = total === 0 ? 0 : outgoing / total;

    // Abstractness (simplified - would need type analysis for accurate measure)
    // For now, use a heuristic based on filename
    const isAbstract = /\b(interface|abstract|types?|contracts?)\b/i.test(file) ? 1 : 0;

    // Distance from main sequence
    const distance = Math.abs(isAbstract + instability - 1);

    metrics[file] = {
      afferentCoupling: incoming,
      efferentCoupling: outgoing,
      instability,
      abstractness: isAbstract,
      distanceFromMainSequence: distance,
    };
  }

  return metrics;
}

/**
 * Calculate cohesion score for a group
 */
function calculateGroupCohesion(
  groupFiles: string[],
  relationships: Relationship[]
): number {
  if (groupFiles.length <= 1) return 1;

  const groupSet = new Set(groupFiles);

  // Count internal relationships
  let internalRelationships = 0;
  for (const rel of relationships) {
    if (groupSet.has(rel.source) && groupSet.has(rel.target)) {
      internalRelationships++;
    }
  }

  // Maximum possible internal relationships
  const maxRelationships = groupFiles.length * (groupFiles.length - 1);

  if (maxRelationships === 0) return 1;

  return internalRelationships / maxRelationships;
}

/**
 * Calculate coupling score for a group (external dependencies)
 */
function calculateGroupCoupling(
  groupFiles: string[],
  allFiles: string[],
  relationships: Relationship[]
): number {
  const groupSet = new Set(groupFiles);
  const otherFiles = allFiles.filter(f => !groupSet.has(f));

  if (otherFiles.length === 0) return 0;

  let externalRelationships = 0;
  for (const rel of relationships) {
    const sourceInGroup = groupSet.has(rel.source);
    const targetInGroup = groupSet.has(rel.target);

    if ((sourceInGroup && !targetInGroup) || (!sourceInGroup && targetInGroup)) {
      externalRelationships++;
    }
  }

  // Normalize by group size and external file count
  return externalRelationships / (groupFiles.length * otherFiles.length + 1);
}

/**
 * Map module relationships
 */
export async function mapModuleRelationships(
  input: MapModuleRelationshipsInput
): Promise<ModuleRelationshipResult> {
  const { path: inputPath, groupBy = 'directory', language: inputLanguage = 'auto', exclude = [], depth = 2 } = input;

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
      modules: [],
      relationships: [],
      couplingMetrics: {},
      cohesionScore: 0,
      groups: [],
    };
  }

  // Parse module information
  const modules: ModuleInfo[] = [];
  for (const file of files) {
    const moduleInfo = parseModuleInfo(file, language);
    if (moduleInfo) {
      modules.push(moduleInfo);
    }
  }

  // Extract relationships
  const relationships = extractRelationships(files, inputPath, language);

  // Calculate coupling metrics
  const couplingMetrics = calculateCouplingMetrics(files, relationships);

  // Group modules
  let fileGroups: Map<string, string[]>;
  switch (groupBy) {
    case 'package':
      fileGroups = groupByPackage(files, inputPath);
      break;
    case 'feature':
      fileGroups = groupByFeature(files, inputPath);
      break;
    case 'layer':
      fileGroups = groupByLayer(files, inputPath);
      break;
    case 'directory':
    default:
      fileGroups = groupByDirectory(files, inputPath, depth);
      break;
  }

  // Calculate group metrics
  const groups: ModuleGroup[] = [];
  for (const [name, groupFiles] of fileGroups) {
    groups.push({
      name,
      modules: groupFiles,
      cohesion: calculateGroupCohesion(groupFiles, relationships),
      coupling: calculateGroupCoupling(groupFiles, files, relationships),
    });
  }

  // Calculate overall cohesion
  const totalCohesion = groups.reduce((sum, g) => sum + g.cohesion * g.modules.length, 0);
  const cohesionScore = files.length > 0 ? totalCohesion / files.length : 0;

  return {
    modules,
    relationships,
    couplingMetrics,
    cohesionScore,
    groups,
  };
}

/**
 * Format the output for display
 */
export function formatModuleRelationshipsOutput(
  result: ModuleRelationshipResult,
  basePath: string
): string {
  const lines: string[] = [];

  lines.push('## Module Relationship Analysis\n');

  // Summary
  lines.push('### Summary');
  lines.push(`- **Total Modules**: ${result.modules.length}`);
  lines.push(`- **Total Relationships**: ${result.relationships.length}`);
  lines.push(`- **Overall Cohesion Score**: ${(result.cohesionScore * 100).toFixed(1)}%`);
  lines.push(`- **Groups**: ${result.groups.length}`);

  // Groups
  lines.push('\n### Module Groups\n');
  const sortedGroups = [...result.groups].sort((a, b) => b.modules.length - a.modules.length);

  for (const group of sortedGroups) {
    lines.push(`#### ${group.name}`);
    lines.push(`- Modules: ${group.modules.length}`);
    lines.push(`- Cohesion: ${(group.cohesion * 100).toFixed(1)}%`);
    lines.push(`- External Coupling: ${(group.coupling * 100).toFixed(1)}%`);

    if (group.modules.length <= 10) {
      lines.push('- Files:');
      for (const mod of group.modules) {
        lines.push(`  - \`${path.relative(basePath, mod)}\``);
      }
    } else {
      lines.push(`- Files: ${group.modules.slice(0, 5).map(m => `\`${getShortName(m)}\``).join(', ')}...`);
    }
    lines.push('');
  }

  // High coupling modules
  const highCouplingModules = Object.entries(result.couplingMetrics)
    .filter(([_, m]) => m.efferentCoupling > 5 || m.afferentCoupling > 5)
    .sort((a, b) => (b[1].afferentCoupling + b[1].efferentCoupling) - (a[1].afferentCoupling + a[1].efferentCoupling))
    .slice(0, 10);

  if (highCouplingModules.length > 0) {
    lines.push('### High Coupling Modules\n');
    lines.push('| Module | Incoming | Outgoing | Instability |');
    lines.push('|--------|----------|----------|-------------|');

    for (const [file, metrics] of highCouplingModules) {
      lines.push(`| ${getShortName(file)} | ${metrics.afferentCoupling} | ${metrics.efferentCoupling} | ${metrics.instability.toFixed(2)} |`);
    }
    lines.push('');
  }

  // Recommendations
  lines.push('### Recommendations\n');

  const lowCohesionGroups = result.groups.filter(g => g.cohesion < 0.1 && g.modules.length > 2);
  if (lowCohesionGroups.length > 0) {
    lines.push(`- ${lowCohesionGroups.length} group(s) have low cohesion. Consider reorganizing:`);
    for (const g of lowCohesionGroups.slice(0, 3)) {
      lines.push(`  - **${g.name}**: cohesion ${(g.cohesion * 100).toFixed(1)}%`);
    }
  }

  const highCouplingGroups = result.groups.filter(g => g.coupling > 0.3);
  if (highCouplingGroups.length > 0) {
    lines.push(`- ${highCouplingGroups.length} group(s) have high external coupling. Consider:`);
    lines.push('  - Extracting shared interfaces');
    lines.push('  - Using dependency injection');
  }

  if (result.cohesionScore > 0.7) {
    lines.push('- Overall architecture shows good cohesion!');
  } else if (result.cohesionScore < 0.3) {
    lines.push('- Consider refactoring to improve module organization');
  }

  // Mermaid diagram
  if (result.groups.length > 1 && result.groups.length <= 15) {
    lines.push('\n### Group Dependencies\n');
    lines.push('```mermaid');
    lines.push('graph TB');

    const groupMap = new Map<string, Set<string>>();
    for (const group of result.groups) {
      groupMap.set(group.name, new Set(group.modules));
    }

    // Find cross-group relationships
    const groupRelationships = new Map<string, Set<string>>();
    for (const rel of result.relationships) {
      let sourceGroup = '';
      let targetGroup = '';

      for (const [name, files] of groupMap) {
        if (files.has(rel.source)) sourceGroup = name;
        if (files.has(rel.target)) targetGroup = name;
      }

      if (sourceGroup && targetGroup && sourceGroup !== targetGroup) {
        const key = sourceGroup;
        if (!groupRelationships.has(key)) {
          groupRelationships.set(key, new Set());
        }
        groupRelationships.get(key)!.add(targetGroup);
      }
    }

    // Add group nodes
    let nodeId = 0;
    const nodeIdMap = new Map<string, string>();
    for (const group of result.groups) {
      const id = `g${nodeId++}`;
      nodeIdMap.set(group.name, id);
      const sanitizedName = group.name.replace(/[^a-zA-Z0-9]/g, '_');
      lines.push(`  ${id}[${sanitizedName}<br/>${group.modules.length} modules]`);
    }

    // Add edges
    for (const [from, targets] of groupRelationships) {
      for (const to of targets) {
        const fromId = nodeIdMap.get(from);
        const toId = nodeIdMap.get(to);
        if (fromId && toId) {
          lines.push(`  ${fromId} --> ${toId}`);
        }
      }
    }

    lines.push('```');
  }

  return lines.join('\n');
}
