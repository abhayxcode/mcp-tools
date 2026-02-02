/**
 * Type definitions for Architecture Visualizer MCP
 */

/**
 * Statistics about a dependency graph
 */
export interface GraphStats {
  /** Total number of nodes (files/modules) in the graph */
  totalNodes: number;
  /** Total number of edges (dependencies) in the graph */
  totalEdges: number;
  /** Average number of dependencies per node */
  averageDependencies: number;
  /** Maximum number of dependencies for any single node */
  maxDependencies: number;
  /** Node(s) with the most dependencies */
  mostConnected: string[];
  /** Nodes with no incoming dependencies (entry points) */
  entryPoints: string[];
  /** Nodes with no outgoing dependencies (leaf nodes) */
  leafNodes: string[];
}

/**
 * Represents a circular dependency cycle
 */
export interface DependencyCycle {
  /** Ordered list of nodes forming the cycle */
  nodes: string[];
  /** Length of the cycle */
  length: number;
  /** Severity level based on cycle characteristics */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Human-readable description of the cycle */
  description: string;
  /** Suggestions for breaking the cycle */
  suggestions: string[];
}

/**
 * Information about a module/file
 */
export interface ModuleInfo {
  /** Absolute or relative path to the module */
  path: string;
  /** Module name (usually filename without extension) */
  name: string;
  /** Type of module */
  type: 'typescript' | 'javascript' | 'python' | 'unknown';
  /** List of imports/dependencies */
  imports: string[];
  /** List of exports */
  exports: string[];
  /** Size in bytes */
  size?: number;
  /** Number of lines of code */
  lines?: number;
}

/**
 * Relationship between two modules
 */
export interface Relationship {
  /** Source module path */
  source: string;
  /** Target module path */
  target: string;
  /** Type of relationship */
  type: 'import' | 'export' | 're-export' | 'dynamic-import' | 'require';
  /** Specific imports (named imports, default, etc.) */
  imports?: string[];
  /** Weight/strength of the relationship */
  weight: number;
}

/**
 * Complexity metrics for a file
 */
export interface FileComplexity {
  /** Path to the file */
  path: string;
  /** Cyclomatic complexity of the file */
  cyclomaticComplexity: number;
  /** Number of functions/methods */
  functionCount: number;
  /** Lines of code (excluding comments/blanks) */
  linesOfCode: number;
  /** Complexity per function */
  functionsComplexity: FunctionComplexity[];
  /** Maintainability index (0-100, higher is better) */
  maintainabilityIndex: number;
}

/**
 * Complexity metrics for a function
 */
export interface FunctionComplexity {
  /** Function/method name */
  name: string;
  /** Line number where the function starts */
  startLine: number;
  /** Line number where the function ends */
  endLine: number;
  /** Cyclomatic complexity */
  complexity: number;
  /** Number of parameters */
  parameterCount: number;
  /** Nesting depth */
  maxNestingDepth: number;
}

/**
 * A complexity hotspot that exceeds thresholds
 */
export interface ComplexityHotspot {
  /** Path to the file */
  path: string;
  /** Function name if applicable */
  functionName?: string;
  /** Line number */
  line: number;
  /** Complexity score */
  complexity: number;
  /** Threshold that was exceeded */
  threshold: number;
  /** Reason for being flagged as a hotspot */
  reason: string;
  /** Priority for refactoring */
  priority: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Architecture layer in the system
 */
export interface ArchitectureLayer {
  /** Name of the layer */
  name: string;
  /** Description of the layer's purpose */
  description: string;
  /** Modules belonging to this layer */
  modules: string[];
  /** Layers this layer depends on */
  dependsOn: string[];
  /** Type of layer */
  type: 'presentation' | 'business' | 'data' | 'infrastructure' | 'utility' | 'unknown';
}

/**
 * Dependency information
 */
export interface Dependency {
  /** Source module */
  from: string;
  /** Target module */
  to: string;
  /** Type of dependency */
  type: 'internal' | 'external' | 'builtin';
  /** Package name if external */
  packageName?: string;
  /** Import statements */
  importStatements: string[];
}

/**
 * Module coupling metrics
 */
export interface CouplingMetrics {
  /** Afferent coupling (incoming dependencies) */
  afferentCoupling: number;
  /** Efferent coupling (outgoing dependencies) */
  efferentCoupling: number;
  /** Instability (Ce / (Ca + Ce)) */
  instability: number;
  /** Abstractness (abstract types / total types) */
  abstractness: number;
  /** Distance from main sequence */
  distanceFromMainSequence: number;
}

/**
 * Result of module relationship mapping
 */
export interface ModuleRelationshipResult {
  /** All modules in the analysis */
  modules: ModuleInfo[];
  /** Relationships between modules */
  relationships: Relationship[];
  /** Coupling metrics per module */
  couplingMetrics: Record<string, CouplingMetrics>;
  /** Overall cohesion score */
  cohesionScore: number;
  /** Groups/clusters of related modules */
  groups: ModuleGroup[];
}

/**
 * A group of related modules
 */
export interface ModuleGroup {
  /** Group name */
  name: string;
  /** Modules in this group */
  modules: string[];
  /** Internal cohesion score */
  cohesion: number;
  /** External coupling score */
  coupling: number;
}

/**
 * Architecture overview result
 */
export interface ArchitectureOverview {
  /** Identified architecture layers */
  layers: ArchitectureLayer[];
  /** Entry points to the application */
  entryPoints: string[];
  /** External dependencies */
  externalDependencies: ExternalDependency[];
  /** Overall architecture style */
  architectureStyle: string;
  /** Generated Mermaid diagram */
  mermaidDiagram: string;
  /** Summary statistics */
  summary: {
    totalFiles: number;
    totalDependencies: number;
    layerCount: number;
    externalDependencyCount: number;
  };
}

/**
 * External dependency information
 */
export interface ExternalDependency {
  /** Package name */
  name: string;
  /** Modules that use this dependency */
  usedBy: string[];
  /** Usage count */
  usageCount: number;
  /** Category of dependency */
  category: 'framework' | 'library' | 'utility' | 'dev' | 'unknown';
}

/**
 * Supported output formats for dependency graphs
 */
export type OutputFormat = 'mermaid' | 'dot' | 'json';

/**
 * Supported programming languages
 */
export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'auto';

/**
 * Grouping options for module mapping
 */
export type GroupByOption = 'directory' | 'package' | 'feature' | 'layer';
