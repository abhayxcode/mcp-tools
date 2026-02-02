/**
 * Graph utilities for dependency analysis
 * Includes Tarjan's algorithm for cycle detection and Mermaid diagram generation
 */

import graphlib from 'graphlib';
import type { Graph as GraphType } from 'graphlib';
import { DependencyCycle, GraphStats, Relationship } from '../types.js';

const { Graph, alg } = graphlib;

/**
 * Build a graphlib Graph from relationships
 */
export function buildGraph(relationships: Relationship[]): GraphType {
  const graph = new Graph({ directed: true });

  for (const rel of relationships) {
    if (!graph.hasNode(rel.source)) {
      graph.setNode(rel.source, { path: rel.source });
    }
    if (!graph.hasNode(rel.target)) {
      graph.setNode(rel.target, { path: rel.target });
    }
    graph.setEdge(rel.source, rel.target, { type: rel.type, weight: rel.weight });
  }

  return graph;
}

/**
 * Tarjan's algorithm for finding strongly connected components (cycles)
 */
export function findStronglyConnectedComponents(graph: GraphType): string[][] {
  const nodes = graph.nodes();
  const indices: Map<string, number> = new Map();
  const lowLinks: Map<string, number> = new Map();
  const onStack: Set<string> = new Set();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let index = 0;

  function strongConnect(node: string): void {
    indices.set(node, index);
    lowLinks.set(node, index);
    index++;
    stack.push(node);
    onStack.add(node);

    const successors = graph.successors(node) || [];
    for (const successor of successors as string[]) {
      if (!indices.has(successor)) {
        strongConnect(successor);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(successor)!));
      } else if (onStack.has(successor)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(successor)!));
      }
    }

    if (lowLinks.get(node) === indices.get(node)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== node);

      if (scc.length > 1) {
        sccs.push(scc.reverse());
      }
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return sccs;
}

/**
 * Find all cycles in a graph using Tarjan's algorithm
 */
export function findCycles(graph: GraphType): DependencyCycle[] {
  const sccs = findStronglyConnectedComponents(graph);
  const cycles: DependencyCycle[] = [];

  for (const scc of sccs) {
    const severity = determineCycleSeverity(scc, graph);
    const suggestions = generateCycleSuggestions(scc, graph);

    cycles.push({
      nodes: scc,
      length: scc.length,
      severity,
      description: `Circular dependency involving ${scc.length} modules: ${scc.map(n => getShortName(n)).join(' -> ')} -> ${getShortName(scc[0])}`,
      suggestions,
    });
  }

  return cycles.sort((a, b) => {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
}

/**
 * Determine the severity of a cycle
 */
function determineCycleSeverity(cycle: string[], graph: GraphType): 'low' | 'medium' | 'high' | 'critical' {
  const length = cycle.length;

  // Check how many other nodes depend on nodes in the cycle
  let affectedNodes = 0;
  for (const node of cycle) {
    const predecessors = (graph.predecessors(node) || []) as string[];
    affectedNodes += predecessors.filter(p => !cycle.includes(p)).length;
  }

  if (length >= 5 || affectedNodes >= 10) {
    return 'critical';
  }
  if (length >= 4 || affectedNodes >= 5) {
    return 'high';
  }
  if (length >= 3 || affectedNodes >= 2) {
    return 'medium';
  }
  return 'low';
}

/**
 * Generate suggestions for breaking a cycle
 */
function generateCycleSuggestions(cycle: string[], graph: GraphType): string[] {
  const suggestions: string[] = [];

  // Find the weakest link (edge with lowest weight or most easily breakable)
  let minWeight = Infinity;
  let weakestEdge: [string, string] | null = null;

  for (let i = 0; i < cycle.length; i++) {
    const from = cycle[i];
    const to = cycle[(i + 1) % cycle.length];
    const edge = graph.edge(from, to) as { weight?: number } | undefined;
    const weight = edge?.weight ?? 1;

    if (weight < minWeight) {
      minWeight = weight;
      weakestEdge = [from, to];
    }
  }

  if (weakestEdge) {
    suggestions.push(
      `Consider breaking the dependency from '${getShortName(weakestEdge[0])}' to '${getShortName(weakestEdge[1])}' as it appears to be the weakest link.`
    );
  }

  suggestions.push(
    'Extract shared code into a separate module that both can depend on.',
    'Use dependency injection to invert the dependency direction.',
    'Consider using interfaces/protocols to break the direct dependency.',
    'Evaluate if the circular dependency indicates a design issue that needs refactoring.'
  );

  return suggestions;
}

/**
 * Get short name from a file path
 */
export function getShortName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/**
 * Calculate graph statistics
 */
export function calculateGraphStats(graph: GraphType): GraphStats {
  const nodes = graph.nodes();
  const edges = graph.edges();

  if (nodes.length === 0) {
    return {
      totalNodes: 0,
      totalEdges: 0,
      averageDependencies: 0,
      maxDependencies: 0,
      mostConnected: [],
      entryPoints: [],
      leafNodes: [],
    };
  }

  // Calculate dependencies per node
  const dependencies: Map<string, number> = new Map();
  let maxDeps = 0;
  const mostConnected: string[] = [];

  for (const node of nodes) {
    const outDegree = ((graph.successors(node) || []) as string[]).length;
    const inDegree = ((graph.predecessors(node) || []) as string[]).length;
    const totalConnections = outDegree + inDegree;
    dependencies.set(node, totalConnections);

    if (totalConnections > maxDeps) {
      maxDeps = totalConnections;
      mostConnected.length = 0;
      mostConnected.push(node);
    } else if (totalConnections === maxDeps) {
      mostConnected.push(node);
    }
  }

  // Find entry points (no incoming edges)
  const entryPoints = nodes.filter((node: string) => {
    const predecessors = (graph.predecessors(node) || []) as string[];
    return predecessors.length === 0;
  });

  // Find leaf nodes (no outgoing edges)
  const leafNodes = nodes.filter((node: string) => {
    const successors = (graph.successors(node) || []) as string[];
    return successors.length === 0;
  });

  const totalDependencies = Array.from(dependencies.values()).reduce((a, b) => a + b, 0);

  return {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    averageDependencies: totalDependencies / nodes.length / 2, // Divide by 2 since we counted both directions
    maxDependencies: maxDeps,
    mostConnected,
    entryPoints,
    leafNodes,
  };
}

/**
 * Generate Mermaid diagram from graph
 */
export function generateMermaidDiagram(
  graph: GraphType,
  options: {
    direction?: 'TB' | 'BT' | 'LR' | 'RL';
    showWeights?: boolean;
    maxNodes?: number;
    highlightCycles?: boolean;
    cycles?: DependencyCycle[];
  } = {}
): string {
  const { direction = 'TB', showWeights = false, maxNodes = 100, highlightCycles = true, cycles = [] } = options;

  const nodes = graph.nodes();
  const edges = graph.edges();

  if (nodes.length === 0) {
    return `graph ${direction}\n  empty[No dependencies found]`;
  }

  // Limit nodes if too many
  const limitedNodes = nodes.slice(0, maxNodes);
  const limitedNodeSet = new Set(limitedNodes);

  const lines: string[] = [`graph ${direction}`];

  // Collect cycle nodes for highlighting
  const cycleNodes = new Set<string>();
  const cycleEdges = new Set<string>();

  if (highlightCycles && cycles.length > 0) {
    for (const cycle of cycles) {
      for (const node of cycle.nodes) {
        cycleNodes.add(node);
      }
      for (let i = 0; i < cycle.nodes.length; i++) {
        const from = cycle.nodes[i];
        const to = cycle.nodes[(i + 1) % cycle.nodes.length];
        cycleEdges.add(`${from}|${to}`);
      }
    }
  }

  // Add nodes with sanitized IDs
  const nodeIdMap = new Map<string, string>();
  let nodeCounter = 0;

  for (const node of limitedNodes) {
    const nodeId = `n${nodeCounter++}`;
    nodeIdMap.set(node, nodeId);
    const shortName = getShortName(node);
    const sanitizedName = shortName.replace(/[^a-zA-Z0-9]/g, '_');

    if (cycleNodes.has(node)) {
      lines.push(`  ${nodeId}[${sanitizedName}]:::cycle`);
    } else {
      lines.push(`  ${nodeId}[${sanitizedName}]`);
    }
  }

  // Add edges
  for (const edge of edges) {
    if (!limitedNodeSet.has(edge.v) || !limitedNodeSet.has(edge.w)) {
      continue;
    }

    const fromId = nodeIdMap.get(edge.v)!;
    const toId = nodeIdMap.get(edge.w)!;
    const edgeData = graph.edge(edge) as { weight?: number } | undefined;
    const isCycleEdge = cycleEdges.has(`${edge.v}|${edge.w}`);

    let edgeStr = `  ${fromId}`;

    if (showWeights && edgeData?.weight) {
      edgeStr += ` -->|${edgeData.weight}| ${toId}`;
    } else if (isCycleEdge) {
      edgeStr += ` -.-> ${toId}`;
    } else {
      edgeStr += ` --> ${toId}`;
    }

    lines.push(edgeStr);
  }

  // Add styling for cycles
  if (cycleNodes.size > 0) {
    lines.push('  classDef cycle fill:#ff6b6b,stroke:#c92a2a,stroke-width:2px');
  }

  // Add note if truncated
  if (nodes.length > maxNodes) {
    lines.push(`  note[Showing ${maxNodes} of ${nodes.length} nodes]`);
  }

  return lines.join('\n');
}

/**
 * Generate DOT (Graphviz) diagram from graph
 */
export function generateDotDiagram(
  graph: GraphType,
  options: {
    rankdir?: 'TB' | 'BT' | 'LR' | 'RL';
    maxNodes?: number;
    cycles?: DependencyCycle[];
  } = {}
): string {
  const { rankdir = 'TB', maxNodes = 100, cycles = [] } = options;

  const nodes = graph.nodes();
  const edges = graph.edges();

  if (nodes.length === 0) {
    return 'digraph G {\n  empty [label="No dependencies found"]\n}';
  }

  const limitedNodes = nodes.slice(0, maxNodes);
  const limitedNodeSet = new Set(limitedNodes);

  // Collect cycle nodes
  const cycleNodes = new Set<string>();
  for (const cycle of cycles) {
    for (const node of cycle.nodes) {
      cycleNodes.add(node);
    }
  }

  const lines: string[] = [
    'digraph G {',
    `  rankdir=${rankdir};`,
    '  node [shape=box, style=rounded];',
  ];

  // Add nodes
  const nodeIdMap = new Map<string, string>();
  let nodeCounter = 0;

  for (const node of limitedNodes) {
    const nodeId = `n${nodeCounter++}`;
    nodeIdMap.set(node, nodeId);
    const shortName = getShortName(node).replace(/"/g, '\\"');

    if (cycleNodes.has(node)) {
      lines.push(`  ${nodeId} [label="${shortName}", color=red, penwidth=2];`);
    } else {
      lines.push(`  ${nodeId} [label="${shortName}"];`);
    }
  }

  // Add edges
  for (const edge of edges) {
    if (!limitedNodeSet.has(edge.v) || !limitedNodeSet.has(edge.w)) {
      continue;
    }

    const fromId = nodeIdMap.get(edge.v)!;
    const toId = nodeIdMap.get(edge.w)!;
    lines.push(`  ${fromId} -> ${toId};`);
  }

  lines.push('}');

  return lines.join('\n');
}

/**
 * Generate JSON representation of graph
 */
export function generateJsonGraph(graph: GraphType): string {
  const nodes = graph.nodes().map((node: string) => ({
    id: node,
    label: getShortName(node),
    data: graph.node(node),
  }));

  const edges = graph.edges().map((edge: graphlib.Edge) => ({
    source: edge.v,
    target: edge.w,
    data: graph.edge(edge),
  }));

  return JSON.stringify({ nodes, edges }, null, 2);
}

/**
 * Find all paths between two nodes
 */
export function findAllPaths(graph: GraphType, start: string, end: string, maxPaths = 10): string[][] {
  const paths: string[][] = [];
  const visited = new Set<string>();

  function dfs(current: string, path: string[]): void {
    if (paths.length >= maxPaths) return;

    if (current === end) {
      paths.push([...path]);
      return;
    }

    visited.add(current);

    const successors = (graph.successors(current) || []) as string[];
    for (const successor of successors) {
      if (!visited.has(successor)) {
        path.push(successor);
        dfs(successor, path);
        path.pop();
      }
    }

    visited.delete(current);
  }

  if (graph.hasNode(start) && graph.hasNode(end)) {
    dfs(start, [start]);
  }

  return paths;
}

/**
 * Calculate the transitive closure of dependencies for a node
 */
export function getTransitiveDependencies(graph: GraphType, node: string): Set<string> {
  const visited = new Set<string>();
  const queue = [node];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;

    visited.add(current);
    const successors = (graph.successors(current) || []) as string[];
    queue.push(...successors.filter((s: string) => !visited.has(s)));
  }

  visited.delete(node); // Remove the starting node
  return visited;
}

/**
 * Get nodes that depend on a given node (reverse dependencies)
 */
export function getReverseDependencies(graph: GraphType, node: string): Set<string> {
  const visited = new Set<string>();
  const queue = [node];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;

    visited.add(current);
    const predecessors = (graph.predecessors(current) || []) as string[];
    queue.push(...predecessors.filter((p: string) => !visited.has(p)));
  }

  visited.delete(node);
  return visited;
}

/**
 * Calculate the depth of a node in the dependency graph
 */
export function calculateNodeDepth(graph: GraphType, node: string): number {
  const entryPoints = graph.nodes().filter((n: string) => {
    const predecessors = (graph.predecessors(n) || []) as string[];
    return predecessors.length === 0;
  });

  if (entryPoints.includes(node)) {
    return 0;
  }

  let maxDepth = 0;

  for (const entry of entryPoints) {
    const paths = findAllPaths(graph, entry, node, 1);
    if (paths.length > 0) {
      maxDepth = Math.max(maxDepth, paths[0].length - 1);
    }
  }

  return maxDepth;
}

/**
 * Check if the graph is a DAG (Directed Acyclic Graph)
 */
export function isDAG(graph: GraphType): boolean {
  return alg.isAcyclic(graph);
}

/**
 * Get topological sort if graph is a DAG
 */
export function getTopologicalSort(graph: GraphType): string[] | null {
  if (!isDAG(graph)) {
    return null;
  }
  return alg.topsort(graph);
}
