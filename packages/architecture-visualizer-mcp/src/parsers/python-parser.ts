/**
 * Python import parser
 * Parses import statements and from...import syntax
 */

import * as fs from 'fs';
import * as path from 'path';
import { ModuleInfo, Dependency } from '../types.js';

/**
 * Regular expressions for Python import patterns
 */
const IMPORT_PATTERNS = {
  // import module
  // import module as alias
  // import module1, module2
  simpleImport: /^import\s+(.+?)(?:\s+as\s+\w+)?$/,

  // from module import name
  // from module import name as alias
  // from module import name1, name2
  // from module import (name1, name2)
  // from module import *
  fromImport: /^from\s+([\w.]+)\s+import\s+(.+)$/,

  // Continuation line detection
  continuation: /\\\s*$/,

  // Parenthesis continuation
  openParen: /\(\s*$/,
  closeParen: /^\s*\)/,
};

/**
 * Parse a Python file and extract module information
 */
export function parsePythonFile(filePath: string): ModuleInfo | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    const imports: string[] = [];
    const exports: string[] = [];

    let i = 0;
    while (i < lines.length) {
      let line = lines[i].trim();

      // Skip comments and empty lines
      if (line.startsWith('#') || line === '') {
        i++;
        continue;
      }

      // Handle multi-line imports with backslash
      while (IMPORT_PATTERNS.continuation.test(line) && i + 1 < lines.length) {
        line = line.replace(/\\\s*$/, '') + ' ' + lines[++i].trim();
      }

      // Handle multi-line imports with parentheses
      if (line.includes('import') && (line.includes('(') && !line.includes(')'))) {
        while (!line.includes(')') && i + 1 < lines.length) {
          line = line + ' ' + lines[++i].trim();
        }
      }

      // Parse simple import
      const simpleMatch = line.match(IMPORT_PATTERNS.simpleImport);
      if (simpleMatch) {
        const modules = simpleMatch[1].split(',').map(m => m.trim().split(/\s+as\s+/)[0].trim());
        for (const module of modules) {
          if (module) {
            imports.push(module.split('.')[0]); // Get top-level module
          }
        }
        i++;
        continue;
      }

      // Parse from...import
      const fromMatch = line.match(IMPORT_PATTERNS.fromImport);
      if (fromMatch) {
        const module = fromMatch[1];
        const importedNames = fromMatch[2];

        // Handle relative imports
        if (module.startsWith('.')) {
          imports.push(module);
        } else {
          imports.push(module.split('.')[0]); // Get top-level module
        }

        // Track exported names if this is a re-export pattern
        if (!module.startsWith('.')) {
          const names = parseImportedNames(importedNames);
          // We don't track these as exports unless explicitly defined
        }

        i++;
        continue;
      }

      // Parse __all__ for exports
      if (line.includes('__all__')) {
        const allMatch = line.match(/__all__\s*=\s*\[([^\]]+)\]/);
        if (allMatch) {
          const names = allMatch[1]
            .split(',')
            .map(n => n.trim().replace(/['"]/g, ''))
            .filter(n => n);
          exports.push(...names);
        }
      }

      // Parse class definitions for exports
      const classMatch = line.match(/^class\s+(\w+)/);
      if (classMatch && !classMatch[1].startsWith('_')) {
        exports.push(classMatch[1]);
      }

      // Parse function definitions for exports
      const funcMatch = line.match(/^def\s+(\w+)/);
      if (funcMatch && !funcMatch[1].startsWith('_')) {
        exports.push(funcMatch[1]);
      }

      // Parse top-level variable assignments for exports
      const varMatch = line.match(/^([A-Z][A-Z0-9_]*)\s*=/);
      if (varMatch) {
        exports.push(varMatch[1]);
      }

      i++;
    }

    const stats = fs.statSync(filePath);

    return {
      path: filePath,
      name: path.basename(filePath, '.py'),
      type: 'python',
      imports: [...new Set(imports)],
      exports: [...new Set(exports)],
      size: stats.size,
      lines: lines.length,
    };
  } catch (error) {
    console.error(`Error parsing Python file ${filePath}:`, error);
    return null;
  }
}

/**
 * Parse imported names from an import statement
 */
function parseImportedNames(importStr: string): string[] {
  // Remove parentheses
  let cleaned = importStr.replace(/[()]/g, '').trim();

  // Handle star import
  if (cleaned === '*') {
    return ['*'];
  }

  // Split by comma and clean up
  return cleaned
    .split(',')
    .map(n => n.trim().split(/\s+as\s+/)[0].trim())
    .filter(n => n);
}

/**
 * Extract dependencies from a Python file
 */
export function extractDependencies(filePath: string, basePath: string): Dependency[] {
  const moduleInfo = parsePythonFile(filePath);
  if (!moduleInfo) {
    return [];
  }

  const dependencies: Dependency[] = [];

  for (const importPath of moduleInfo.imports) {
    const dependency = classifyPythonDependency(importPath, filePath, basePath);
    dependencies.push(dependency);
  }

  return dependencies;
}

/**
 * Classify a Python dependency
 */
function classifyPythonDependency(importPath: string, fromFile: string, basePath: string): Dependency {
  const isRelative = importPath.startsWith('.');
  const isBuiltin = isPythonBuiltin(importPath);

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
    // Resolve relative import
    const fromDir = path.dirname(fromFile);
    let targetDir = fromDir;
    let moduleName = importPath;

    // Count leading dots
    let dots = 0;
    while (moduleName.startsWith('.')) {
      dots++;
      moduleName = moduleName.slice(1);
    }

    // Go up directories based on dots
    for (let i = 1; i < dots; i++) {
      targetDir = path.dirname(targetDir);
    }

    // Resolve module path
    const parts = moduleName.split('.');
    let resolvedPath = targetDir;
    for (const part of parts) {
      if (part) {
        resolvedPath = path.join(resolvedPath, part);
      }
    }

    // Try to find the actual file
    const possiblePaths = [
      resolvedPath + '.py',
      path.join(resolvedPath, '__init__.py'),
    ];

    let finalPath = resolvedPath;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        finalPath = p;
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

  // Check if it's a local module within the project
  const possibleLocalPaths = [
    path.join(basePath, importPath.replace(/\./g, '/') + '.py'),
    path.join(basePath, importPath.replace(/\./g, '/'), '__init__.py'),
    path.join(basePath, 'src', importPath.replace(/\./g, '/') + '.py'),
    path.join(basePath, 'src', importPath.replace(/\./g, '/'), '__init__.py'),
  ];

  for (const localPath of possibleLocalPaths) {
    if (fs.existsSync(localPath)) {
      return {
        from: fromFile,
        to: localPath,
        type: 'internal',
        importStatements: [importPath],
      };
    }
  }

  // External package
  return {
    from: fromFile,
    to: importPath,
    type: 'external',
    packageName: importPath.split('.')[0],
    importStatements: [importPath],
  };
}

/**
 * Check if module is a Python standard library module
 */
function isPythonBuiltin(moduleName: string): boolean {
  const builtins = [
    'abc', 'aifc', 'argparse', 'array', 'ast', 'asynchat', 'asyncio', 'asyncore',
    'atexit', 'audioop', 'base64', 'bdb', 'binascii', 'binhex', 'bisect', 'builtins',
    'bz2', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code', 'codecs',
    'codeop', 'collections', 'colorsys', 'compileall', 'concurrent', 'configparser',
    'contextlib', 'contextvars', 'copy', 'copyreg', 'cProfile', 'crypt', 'csv',
    'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib',
    'dis', 'distutils', 'doctest', 'email', 'encodings', 'enum', 'errno', 'faulthandler',
    'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools',
    'gc', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip', 'hashlib',
    'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib', 'imghdr', 'imp', 'importlib',
    'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache',
    'locale', 'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes',
    'mmap', 'modulefinder', 'multiprocessing', 'netrc', 'nis', 'nntplib', 'numbers',
    'operator', 'optparse', 'os', 'ossaudiodev', 'parser', 'pathlib', 'pdb', 'pickle',
    'pickletools', 'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posix',
    'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr',
    'pydoc', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib', 'resource',
    'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve',
    'shlex', 'shutil', 'signal', 'site', 'smtpd', 'smtplib', 'sndhdr', 'socket',
    'socketserver', 'spwd', 'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'stringprep',
    'struct', 'subprocess', 'sunau', 'symbol', 'symtable', 'sys', 'sysconfig', 'syslog',
    'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'test', 'textwrap',
    'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'trace', 'traceback',
    'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing', 'unicodedata',
    'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser',
    'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp', 'zipfile',
    'zipimport', 'zlib', 'zoneinfo',
  ];

  const baseName = moduleName.split('.')[0];
  return builtins.includes(baseName);
}

/**
 * Calculate basic complexity metrics for Python code
 */
export function calculatePythonComplexity(filePath: string): { complexity: number; functions: number; classes: number } {
  try {
    if (!fs.existsSync(filePath)) {
      return { complexity: 0, functions: 0, classes: 0 };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    let complexity = 1; // Base complexity
    let functionCount = 0;
    let classCount = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (trimmed.startsWith('#') || trimmed === '') {
        continue;
      }

      // Count decision points
      if (/^(if|elif|while|for)\s/.test(trimmed)) {
        complexity++;
      }

      // Count exception handlers
      if (/^except(\s|:)/.test(trimmed)) {
        complexity++;
      }

      // Count logical operators
      const andOrCount = (trimmed.match(/\s(and|or)\s/g) || []).length;
      complexity += andOrCount;

      // Count conditional expressions (ternary)
      if (/\sif\s.+\selse\s/.test(trimmed)) {
        complexity++;
      }

      // Count functions
      if (/^def\s+\w+/.test(trimmed)) {
        functionCount++;
      }

      // Count classes
      if (/^class\s+\w+/.test(trimmed)) {
        classCount++;
      }
    }

    return { complexity, functions: functionCount, classes: classCount };
  } catch (error) {
    console.error(`Error calculating Python complexity for ${filePath}:`, error);
    return { complexity: 0, functions: 0, classes: 0 };
  }
}

/**
 * Scan directory for Python files
 */
export function scanPythonFiles(
  dirPath: string,
  options: {
    exclude?: string[];
    maxDepth?: number;
  } = {}
): string[] {
  const {
    exclude = ['node_modules', 'venv', '.venv', 'env', '.env', '__pycache__', '.git', 'dist', 'build', 'egg-info'],
    maxDepth = 20,
  } = options;

  const files: string[] = [];

  function scan(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (exclude.some(ex => entry.name === ex || entry.name.endsWith(ex))) {
          continue;
        }

        if (entry.isDirectory()) {
          scan(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.py')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.error(`Error scanning ${dir}:`, error);
    }
  }

  scan(dirPath, 0);
  return files;
}

/**
 * Parse Python function information for complexity analysis
 */
export function parsePythonFunctions(filePath: string): Array<{
  name: string;
  startLine: number;
  endLine: number;
  complexity: number;
  parameterCount: number;
}> {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const functions: Array<{
      name: string;
      startLine: number;
      endLine: number;
      complexity: number;
      parameterCount: number;
    }> = [];

    let currentFunction: {
      name: string;
      startLine: number;
      indent: number;
      complexity: number;
      parameterCount: number;
    } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;

      // Check for function definition
      const funcMatch = trimmed.match(/^def\s+(\w+)\s*\(([^)]*)\)/);
      if (funcMatch) {
        // Save previous function
        if (currentFunction) {
          functions.push({
            name: currentFunction.name,
            startLine: currentFunction.startLine,
            endLine: i,
            complexity: currentFunction.complexity,
            parameterCount: currentFunction.parameterCount,
          });
        }

        // Start new function
        const params = funcMatch[2].split(',').filter(p => p.trim() && !p.trim().startsWith('self'));
        currentFunction = {
          name: funcMatch[1],
          startLine: i + 1,
          indent,
          complexity: 1,
          parameterCount: params.length,
        };
        continue;
      }

      // Check if we've exited the function
      if (currentFunction && trimmed !== '' && !trimmed.startsWith('#') && indent <= currentFunction.indent) {
        functions.push({
          name: currentFunction.name,
          startLine: currentFunction.startLine,
          endLine: i,
          complexity: currentFunction.complexity,
          parameterCount: currentFunction.parameterCount,
        });
        currentFunction = null;
      }

      // Count complexity within function
      if (currentFunction) {
        if (/^(if|elif|while|for)\s/.test(trimmed)) {
          currentFunction.complexity++;
        }
        if (/^except(\s|:)/.test(trimmed)) {
          currentFunction.complexity++;
        }
        const andOrCount = (trimmed.match(/\s(and|or)\s/g) || []).length;
        currentFunction.complexity += andOrCount;
      }
    }

    // Don't forget the last function
    if (currentFunction) {
      functions.push({
        name: currentFunction.name,
        startLine: currentFunction.startLine,
        endLine: lines.length,
        complexity: currentFunction.complexity,
        parameterCount: currentFunction.parameterCount,
      });
    }

    return functions;
  } catch (error) {
    console.error(`Error parsing Python functions in ${filePath}:`, error);
    return [];
  }
}
