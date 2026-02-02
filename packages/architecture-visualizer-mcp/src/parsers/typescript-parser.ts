/**
 * TypeScript/JavaScript parser using TypeScript Compiler API
 * Extracts imports, exports, and module dependencies
 */

import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { ModuleInfo, Dependency, FunctionComplexity } from '../types.js';

/**
 * Parse a TypeScript/JavaScript file and extract module information
 */
export function parseTypeScriptFile(filePath: string): ModuleInfo | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
        ? ts.ScriptKind.TSX
        : filePath.endsWith('.ts')
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS
    );

    const imports: string[] = [];
    const exports: string[] = [];

    // Visit all nodes in the AST
    function visit(node: ts.Node): void {
      // Handle import declarations
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          imports.push(moduleSpecifier.text);
        }
      }

      // Handle export declarations
      if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          // Re-export from another module
          imports.push(node.moduleSpecifier.text);
        }
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) {
            exports.push(element.name.text);
          }
        }
      }

      // Handle export assignments (export default)
      if (ts.isExportAssignment(node)) {
        exports.push('default');
      }

      // Handle exported declarations
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableStatement(node)) {
        const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
        if (modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          if (ts.isFunctionDeclaration(node) && node.name) {
            exports.push(node.name.text);
          } else if (ts.isClassDeclaration(node) && node.name) {
            exports.push(node.name.text);
          } else if (ts.isVariableStatement(node)) {
            for (const declaration of node.declarationList.declarations) {
              if (ts.isIdentifier(declaration.name)) {
                exports.push(declaration.name.text);
              }
            }
          }
        }
      }

      // Handle require() calls
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) {
            imports.push(arg.text);
          }
        }

        // Handle dynamic imports
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) {
            imports.push(arg.text);
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    const stats = fs.statSync(filePath);
    const lines = content.split('\n').length;

    return {
      path: filePath,
      name: path.basename(filePath, path.extname(filePath)),
      type: filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'javascript',
      imports: [...new Set(imports)],
      exports: [...new Set(exports)],
      size: stats.size,
      lines,
    };
  } catch (error) {
    console.error(`Error parsing ${filePath}:`, error);
    return null;
  }
}

/**
 * Extract detailed dependencies from a TypeScript file
 */
export function extractDependencies(filePath: string, basePath: string): Dependency[] {
  const moduleInfo = parseTypeScriptFile(filePath);
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
      packageName: importPath,
      importStatements: [importPath],
    };
  }

  if (isRelative) {
    // Resolve relative path
    const fromDir = path.dirname(fromFile);
    let resolvedPath = path.resolve(fromDir, importPath);

    // Handle ESM .js extension mapping to .ts
    // When using ESM, imports like './foo.js' should resolve to './foo.ts'
    if (resolvedPath.endsWith('.js') && !fs.existsSync(resolvedPath)) {
      const withoutJs = resolvedPath.slice(0, -3);
      if (fs.existsSync(withoutJs + '.ts')) {
        return {
          from: fromFile,
          to: withoutJs + '.ts',
          type: 'internal',
          importStatements: [importPath],
        };
      }
      if (fs.existsSync(withoutJs + '.tsx')) {
        return {
          from: fromFile,
          to: withoutJs + '.tsx',
          type: 'internal',
          importStatements: [importPath],
        };
      }
      // Update resolvedPath without .js for further extension checking
      resolvedPath = withoutJs;
    }

    // Try to resolve with extensions
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', ''];
    let finalPath = resolvedPath;

    for (const ext of extensions) {
      const withExt = resolvedPath + ext;
      if (fs.existsSync(withExt)) {
        finalPath = withExt;
        break;
      }
      // Check for index file
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

  // External package
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
  // Handle scoped packages (@org/package)
  if (importPath.startsWith('@')) {
    const parts = importPath.split('/');
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  }
  // Regular package
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
    'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads',
    'zlib', 'node:assert', 'node:buffer', 'node:child_process', 'node:cluster',
    'node:crypto', 'node:dgram', 'node:dns', 'node:events', 'node:fs',
    'node:http', 'node:https', 'node:net', 'node:os', 'node:path',
    'node:process', 'node:querystring', 'node:readline', 'node:stream',
    'node:timers', 'node:tls', 'node:url', 'node:util', 'node:v8', 'node:vm',
    'node:worker_threads', 'node:zlib'
  ];

  const baseName = moduleName.split('/')[0];
  return builtins.includes(baseName);
}

/**
 * Calculate cyclomatic complexity for functions in a TypeScript file
 */
export function calculateComplexity(filePath: string): FunctionComplexity[] {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const functions: FunctionComplexity[] = [];

    function countComplexity(node: ts.Node): number {
      let complexity = 0;

      function visit(n: ts.Node): void {
        switch (n.kind) {
          case ts.SyntaxKind.IfStatement:
          case ts.SyntaxKind.ConditionalExpression:
          case ts.SyntaxKind.ForStatement:
          case ts.SyntaxKind.ForInStatement:
          case ts.SyntaxKind.ForOfStatement:
          case ts.SyntaxKind.WhileStatement:
          case ts.SyntaxKind.DoStatement:
          case ts.SyntaxKind.CaseClause:
          case ts.SyntaxKind.CatchClause:
            complexity++;
            break;
          case ts.SyntaxKind.BinaryExpression:
            const binary = n as ts.BinaryExpression;
            if (binary.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
                binary.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                binary.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
              complexity++;
            }
            break;
        }
        ts.forEachChild(n, visit);
      }

      visit(node);
      return complexity + 1; // Base complexity is 1
    }

    function countNestingDepth(node: ts.Node): number {
      let maxDepth = 0;

      function visit(n: ts.Node, depth: number): void {
        let newDepth = depth;

        if (ts.isIfStatement(n) || ts.isForStatement(n) || ts.isForInStatement(n) ||
            ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n) ||
            ts.isTryStatement(n) || ts.isSwitchStatement(n)) {
          newDepth++;
          maxDepth = Math.max(maxDepth, newDepth);
        }

        ts.forEachChild(n, child => visit(child, newDepth));
      }

      visit(node, 0);
      return maxDepth;
    }

    function countParameters(node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression): number {
      return node.parameters?.length ?? 0;
    }

    function visitFunction(node: ts.Node): void {
      let funcName: string | undefined;
      let startLine: number;
      let endLine: number;

      if (ts.isFunctionDeclaration(node) && node.name) {
        funcName = node.name.text;
      } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        funcName = node.name.text;
      } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        // Try to get name from variable declaration
        const parent = node.parent;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          funcName = parent.name.text;
        } else if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
          funcName = parent.name.text;
        }
      }

      if (funcName && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
        const { line: startLineNum } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const { line: endLineNum } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        startLine = startLineNum + 1;
        endLine = endLineNum + 1;

        const complexity = countComplexity(node);
        const nestingDepth = countNestingDepth(node);
        const paramCount = countParameters(node as any);

        functions.push({
          name: funcName,
          startLine,
          endLine,
          complexity,
          parameterCount: paramCount,
          maxNestingDepth: nestingDepth,
        });
      }

      ts.forEachChild(node, visitFunction);
    }

    visitFunction(sourceFile);

    return functions;
  } catch (error) {
    console.error(`Error calculating complexity for ${filePath}:`, error);
    return [];
  }
}

/**
 * Scan a directory for TypeScript/JavaScript files
 */
export function scanDirectory(
  dirPath: string,
  options: {
    exclude?: string[];
    extensions?: string[];
    maxDepth?: number;
  } = {}
): string[] {
  const {
    exclude = ['node_modules', 'dist', 'build', '.git', 'coverage', '__pycache__'],
    extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    maxDepth = 20,
  } = options;

  const files: string[] = [];

  function scan(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Check exclusions
        if (exclude.some(ex => entry.name === ex || fullPath.includes(`/${ex}/`))) {
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
