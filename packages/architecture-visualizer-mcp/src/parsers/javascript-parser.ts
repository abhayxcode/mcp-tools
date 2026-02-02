/**
 * JavaScript parser using Babel
 * Parses ES modules and CommonJS to extract dependencies
 */

import * as parser from '@babel/parser';
import * as fs from 'fs';
import * as path from 'path';
import { ModuleInfo, Dependency } from '../types.js';

type BabelNode = parser.ParseResult<any>;

/**
 * Parse a JavaScript file and extract module information using Babel
 */
export function parseJavaScriptFile(filePath: string): ModuleInfo | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    let ast: BabelNode;
    try {
      ast = parser.parse(content, {
        sourceType: 'unambiguous',
        plugins: [
          'jsx',
          'typescript',
          'decorators-legacy',
          'classProperties',
          'classPrivateProperties',
          'classPrivateMethods',
          'exportDefaultFrom',
          'exportNamespaceFrom',
          'dynamicImport',
          'nullishCoalescingOperator',
          'optionalChaining',
          'optionalCatchBinding',
          'asyncGenerators',
          'objectRestSpread',
        ],
        errorRecovery: true,
      });
    } catch (parseError) {
      // Try with module source type if unambiguous fails
      ast = parser.parse(content, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript', 'decorators-legacy', 'dynamicImport'],
        errorRecovery: true,
      });
    }

    const imports: string[] = [];
    const exports: string[] = [];

    // Traverse the AST
    function traverse(node: any, parent?: any): void {
      if (!node || typeof node !== 'object') return;

      // Handle import declarations
      if (node.type === 'ImportDeclaration' && node.source?.value) {
        imports.push(node.source.value);
      }

      // Handle export named declarations
      if (node.type === 'ExportNamedDeclaration') {
        if (node.source?.value) {
          // Re-export from another module
          imports.push(node.source.value);
        }
        if (node.declaration) {
          extractExportNames(node.declaration, exports);
        }
        if (node.specifiers) {
          for (const spec of node.specifiers) {
            if (spec.exported?.name) {
              exports.push(spec.exported.name);
            }
          }
        }
      }

      // Handle export default
      if (node.type === 'ExportDefaultDeclaration') {
        exports.push('default');
      }

      // Handle export all
      if (node.type === 'ExportAllDeclaration' && node.source?.value) {
        imports.push(node.source.value);
      }

      // Handle require() calls
      if (node.type === 'CallExpression') {
        if (node.callee?.name === 'require' && node.arguments?.[0]?.value) {
          imports.push(node.arguments[0].value);
        }
        // Handle dynamic import()
        if (node.callee?.type === 'Import' && node.arguments?.[0]?.value) {
          imports.push(node.arguments[0].value);
        }
      }

      // Handle module.exports assignments
      if (node.type === 'AssignmentExpression') {
        if (node.left?.type === 'MemberExpression') {
          if (node.left.object?.name === 'module' && node.left.property?.name === 'exports') {
            exports.push('default');
          }
          if (node.left.object?.name === 'exports') {
            if (node.left.property?.name) {
              exports.push(node.left.property.name);
            }
          }
        }
      }

      // Recursively traverse
      for (const key of Object.keys(node)) {
        if (key === 'parent' || key === 'loc' || key === 'range') continue;

        const value = node[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            traverse(item, node);
          }
        } else if (value && typeof value === 'object') {
          traverse(value, node);
        }
      }
    }

    traverse(ast);

    const stats = fs.statSync(filePath);
    const lines = content.split('\n').length;

    return {
      path: filePath,
      name: path.basename(filePath, path.extname(filePath)),
      type: 'javascript',
      imports: [...new Set(imports)],
      exports: [...new Set(exports)],
      size: stats.size,
      lines,
    };
  } catch (error) {
    console.error(`Error parsing ${filePath} with Babel:`, error);
    return null;
  }
}

/**
 * Extract export names from a declaration node
 */
function extractExportNames(declaration: any, exports: string[]): void {
  if (!declaration) return;

  switch (declaration.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      if (declaration.id?.name) {
        exports.push(declaration.id.name);
      }
      break;

    case 'VariableDeclaration':
      for (const decl of declaration.declarations || []) {
        if (decl.id?.name) {
          exports.push(decl.id.name);
        } else if (decl.id?.type === 'ObjectPattern') {
          // Destructuring
          for (const prop of decl.id.properties || []) {
            if (prop.key?.name) {
              exports.push(prop.key.name);
            }
          }
        } else if (decl.id?.type === 'ArrayPattern') {
          for (const element of decl.id.elements || []) {
            if (element?.name) {
              exports.push(element.name);
            }
          }
        }
      }
      break;
  }
}

/**
 * Extract dependencies from a JavaScript file using Babel
 */
export function extractDependencies(filePath: string, basePath: string): Dependency[] {
  const moduleInfo = parseJavaScriptFile(filePath);
  if (!moduleInfo) {
    return [];
  }

  const dependencies: Dependency[] = [];

  for (const importPath of moduleInfo.imports) {
    const dependency = classifyDependency(importPath, filePath, basePath);
    dependencies.push(dependency);
  }

  return dependencies;
}

/**
 * Classify a dependency as internal, external, or builtin
 */
function classifyDependency(importPath: string, fromFile: string, basePath: string): Dependency {
  const isRelative = importPath.startsWith('.') || importPath.startsWith('/');
  const isBuiltin = isNodeBuiltin(importPath);

  if (isBuiltin) {
    return {
      from: fromFile,
      to: importPath,
      type: 'builtin',
      packageName: importPath.replace('node:', ''),
      importStatements: [importPath],
    };
  }

  if (isRelative) {
    const fromDir = path.dirname(fromFile);
    let resolvedPath = path.resolve(fromDir, importPath);

    const extensions = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', ''];
    let finalPath = resolvedPath;

    for (const ext of extensions) {
      const withExt = resolvedPath + ext;
      if (fs.existsSync(withExt)) {
        finalPath = withExt;
        break;
      }
      const indexPath = path.join(resolvedPath, 'index' + ext);
      if (fs.existsSync(indexPath)) {
        finalPath = indexPath;
        break;
      }
    }

    return {
      from: fromFile,
      to: finalPath,
      type: 'internal',
      importStatements: [importPath],
    };
  }

  const packageName = getPackageName(importPath);
  return {
    from: fromFile,
    to: importPath,
    type: 'external',
    packageName,
    importStatements: [importPath],
  };
}

/**
 * Get package name from import path
 */
function getPackageName(importPath: string): string {
  if (importPath.startsWith('@')) {
    const parts = importPath.split('/');
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  }
  return importPath.split('/')[0];
}

/**
 * Check if module is a Node.js builtin
 */
function isNodeBuiltin(moduleName: string): boolean {
  const builtins = [
    'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
    'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'https',
    'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
    'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
    'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
  ];

  const baseName = moduleName.replace('node:', '').split('/')[0];
  return builtins.includes(baseName);
}

/**
 * Calculate basic complexity metrics for JavaScript using Babel
 */
export function calculateComplexity(filePath: string): { complexity: number; functions: number } {
  try {
    if (!fs.existsSync(filePath)) {
      return { complexity: 0, functions: 0 };
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    const ast = parser.parse(content, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript', 'decorators-legacy', 'dynamicImport'],
      errorRecovery: true,
    });

    let complexity = 1; // Base complexity
    let functionCount = 0;

    function traverse(node: any): void {
      if (!node || typeof node !== 'object') return;

      // Count decision points
      switch (node.type) {
        case 'IfStatement':
        case 'ConditionalExpression':
        case 'ForStatement':
        case 'ForInStatement':
        case 'ForOfStatement':
        case 'WhileStatement':
        case 'DoWhileStatement':
        case 'SwitchCase':
        case 'CatchClause':
          complexity++;
          break;

        case 'LogicalExpression':
          if (node.operator === '&&' || node.operator === '||' || node.operator === '??') {
            complexity++;
          }
          break;

        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
        case 'ClassMethod':
        case 'ObjectMethod':
          functionCount++;
          break;
      }

      for (const key of Object.keys(node)) {
        if (key === 'parent' || key === 'loc' || key === 'range') continue;

        const value = node[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            traverse(item);
          }
        } else if (value && typeof value === 'object') {
          traverse(value);
        }
      }
    }

    traverse(ast);

    return { complexity, functions: functionCount };
  } catch (error) {
    console.error(`Error calculating complexity for ${filePath}:`, error);
    return { complexity: 0, functions: 0 };
  }
}

/**
 * Scan directory for JavaScript files
 */
export function scanJavaScriptFiles(
  dirPath: string,
  options: {
    exclude?: string[];
    maxDepth?: number;
  } = {}
): string[] {
  const {
    exclude = ['node_modules', 'dist', 'build', '.git', 'coverage'],
    maxDepth = 20,
  } = options;

  const extensions = ['.js', '.jsx', '.mjs', '.cjs'];
  const files: string[] = [];

  function scan(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (exclude.some(ex => entry.name === ex)) {
          continue;
        }

        if (entry.isDirectory()) {
          scan(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      console.error(`Error scanning ${dir}:`, error);
    }
  }

  scan(dirPath, 0);
  return files;
}
