/**
 * Layout Compactor
 * Reduces unnecessary whitespace in layouts while maintaining relative positions and constraints.
 */

import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { Bounds } from '../../types/internal';

export interface CompactorOptions {
  /** Minimum horizontal gap between nodes */
  minHorizontalGap: number;
  /** Minimum vertical gap between nodes */
  minVerticalGap: number;
  /** Whether to compact horizontally */
  compactHorizontal: boolean;
  /** Whether to compact vertically */
  compactVertical: boolean;
  /** Whether to consider edge dependencies */
  considerDependencies: boolean;
}

const DEFAULT_OPTIONS: CompactorOptions = {
  minHorizontalGap: 60,
  minVerticalGap: 40,
  compactHorizontal: true,
  compactVertical: true,
  considerDependencies: true,
};

/**
 * Compact layout to reduce whitespace while maintaining constraints
 */
export class Compactor {
  private options: CompactorOptions;

  constructor(options?: Partial<CompactorOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Compact the graph layout
   */
  compact(graph: ElkNode): void {
    if (!graph.children || graph.children.length === 0) return;

    // Build node bounds map
    const nodeBounds = this.collectNodeBounds(graph);

    if (nodeBounds.length === 0) return;

    // Collect edges for dependency tracking
    const edges = this.collectEdges(graph);

    if (this.options.considerDependencies && edges.length > 0) {
      // Compact with dependency consideration
      this.compactWithDependencies(graph, nodeBounds, edges);
    } else {
      // Simple compaction
      if (this.options.compactHorizontal) {
        this.compactHorizontalSimple(nodeBounds);
      }
      if (this.options.compactVertical) {
        this.compactVerticalSimple(nodeBounds);
      }
      // Apply bounds back to nodes
      this.applyBounds(graph, nodeBounds);
    }

    // Recursively compact children
    for (const child of graph.children) {
      if ((child as ElkNode).children && (child as ElkNode).children!.length > 0) {
        this.compact(child as ElkNode);
      }
    }
  }

  /**
   * Collect node bounds from graph
   */
  private collectNodeBounds(graph: ElkNode): Array<Bounds & { id: string }> {
    const bounds: Array<Bounds & { id: string }> = [];

    if (!graph.children) return bounds;

    for (const child of graph.children) {
      const node = child as ElkNode;
      if (node.x !== undefined && node.y !== undefined) {
        bounds.push({
          id: node.id,
          x: node.x,
          y: node.y,
          width: node.width ?? 0,
          height: node.height ?? 0,
        });
      }
    }

    return bounds;
  }

  /**
   * Collect edges from graph
   */
  private collectEdges(graph: ElkNode): Array<{ source: string; target: string }> {
    const edges: Array<{ source: string; target: string }> = [];

    const collectFromNode = (node: ElkNode) => {
      if (node.edges) {
        for (const edge of node.edges) {
          const elkEdge = edge as ElkExtendedEdge;
          if (elkEdge.sources && elkEdge.targets) {
            for (const source of elkEdge.sources) {
              for (const target of elkEdge.targets) {
                edges.push({ source, target });
              }
            }
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          collectFromNode(child as ElkNode);
        }
      }
    };

    collectFromNode(graph);
    return edges;
  }

  /**
   * Simple horizontal compaction - move nodes left while maintaining minimum gap
   */
  private compactHorizontalSimple(nodes: Array<Bounds & { id: string }>): void {
    if (nodes.length === 0) return;

    // Sort by X coordinate
    nodes.sort((a, b) => a.x - b.x);

    // Find minimum X (keep first node's position as anchor)
    const minX = nodes[0].x;

    // Compact from left to right
    for (let i = 1; i < nodes.length; i++) {
      const prev = nodes[i - 1];
      const curr = nodes[i];

      // Check if nodes are on the same horizontal band (Y overlap)
      if (this.hasVerticalOverlap(prev, curr)) {
        const minAllowedX = prev.x + prev.width + this.options.minHorizontalGap;

        // Only move left, never right
        if (curr.x > minAllowedX) {
          curr.x = minAllowedX;
        }
      }
    }

    // Normalize to start from original min X
    const newMinX = Math.min(...nodes.map((n) => n.x));
    const offsetX = minX - newMinX;
    if (offsetX > 0) {
      for (const node of nodes) {
        node.x += offsetX;
      }
    }
  }

  /**
   * Simple vertical compaction - move nodes up while maintaining minimum gap
   */
  private compactVerticalSimple(nodes: Array<Bounds & { id: string }>): void {
    if (nodes.length === 0) return;

    // Sort by Y coordinate
    nodes.sort((a, b) => a.y - b.y);

    // Find minimum Y (keep first node's position as anchor)
    const minY = nodes[0].y;

    // Compact from top to bottom
    for (let i = 1; i < nodes.length; i++) {
      const prev = nodes[i - 1];
      const curr = nodes[i];

      // Check if nodes are on the same vertical band (X overlap)
      if (this.hasHorizontalOverlap(prev, curr)) {
        const minAllowedY = prev.y + prev.height + this.options.minVerticalGap;

        // Only move up, never down
        if (curr.y > minAllowedY) {
          curr.y = minAllowedY;
        }
      }
    }

    // Normalize to start from original min Y
    const newMinY = Math.min(...nodes.map((n) => n.y));
    const offsetY = minY - newMinY;
    if (offsetY > 0) {
      for (const node of nodes) {
        node.y += offsetY;
      }
    }
  }

  /**
   * Compact with dependency consideration using topological sort
   */
  private compactWithDependencies(
    graph: ElkNode,
    nodeBounds: Array<Bounds & { id: string }>,
    edges: Array<{ source: string; target: string }>
  ): void {
    // Build node map for quick lookup
    const boundsMap = new Map<string, Bounds & { id: string }>();
    for (const node of nodeBounds) {
      boundsMap.set(node.id, node);
    }

    // Build dependency graph (target depends on source)
    const dependencies = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!dependencies.has(edge.target)) {
        dependencies.set(edge.target, new Set());
      }
      dependencies.get(edge.target)!.add(edge.source);
    }

    // Topological sort
    const sorted = this.topologicalSort([...boundsMap.keys()], dependencies);

    // Compact horizontally following dependency order
    if (this.options.compactHorizontal) {
      for (const nodeId of sorted) {
        const node = boundsMap.get(nodeId);
        if (!node) continue;

        const deps = dependencies.get(nodeId);
        if (!deps || deps.size === 0) continue;

        // Find the rightmost edge of all dependencies
        let maxRight = 0;
        for (const depId of deps) {
          const dep = boundsMap.get(depId);
          if (dep) {
            maxRight = Math.max(maxRight, dep.x + dep.width);
          }
        }

        // Compact to minimum allowed position
        const targetX = maxRight + this.options.minHorizontalGap;
        if (node.x > targetX) {
          node.x = targetX;
        }
      }
    }

    // Apply bounds back to nodes
    this.applyBounds(graph, nodeBounds);
  }

  /**
   * Apply bounds back to graph nodes
   */
  private applyBounds(graph: ElkNode, bounds: Array<Bounds & { id: string }>): void {
    const boundsMap = new Map<string, Bounds & { id: string }>();
    for (const b of bounds) {
      boundsMap.set(b.id, b);
    }

    if (!graph.children) return;

    for (const child of graph.children) {
      const node = child as ElkNode;
      const b = boundsMap.get(node.id);
      if (b) {
        node.x = b.x;
        node.y = b.y;
      }
    }
  }

  /**
   * Check if two nodes have vertical overlap (same horizontal band)
   */
  private hasVerticalOverlap(a: Bounds, b: Bounds): boolean {
    const aTop = a.y;
    const aBottom = a.y + a.height;
    const bTop = b.y;
    const bBottom = b.y + b.height;

    return aTop < bBottom && bTop < aBottom;
  }

  /**
   * Check if two nodes have horizontal overlap (same vertical band)
   */
  private hasHorizontalOverlap(a: Bounds, b: Bounds): boolean {
    const aLeft = a.x;
    const aRight = a.x + a.width;
    const bLeft = b.x;
    const bRight = b.x + b.width;

    return aLeft < bRight && bLeft < aRight;
  }

  /**
   * Topological sort using Kahn's algorithm
   */
  private topologicalSort(
    nodes: string[],
    dependencies: Map<string, Set<string>>
  ): string[] {
    const inDegree = new Map<string, number>();
    const adjacencyList = new Map<string, string[]>();

    // Initialize
    for (const node of nodes) {
      inDegree.set(node, 0);
      adjacencyList.set(node, []);
    }

    // Build adjacency list and compute in-degrees
    for (const [target, sources] of dependencies) {
      for (const source of sources) {
        if (adjacencyList.has(source)) {
          adjacencyList.get(source)!.push(target);
          inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
        }
      }
    }

    // Find nodes with no dependencies
    const queue: string[] = [];
    for (const node of nodes) {
      if ((inDegree.get(node) ?? 0) === 0) {
        queue.push(node);
      }
    }

    const sorted: string[] = [];

    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);

      for (const dependent of adjacencyList.get(node) ?? []) {
        const newDegree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          queue.push(dependent);
        }
      }
    }

    // If there are cycles, append remaining nodes
    for (const node of nodes) {
      if (!sorted.includes(node)) {
        sorted.push(node);
      }
    }

    return sorted;
  }
}

/**
 * Standalone function for horizontal compaction
 */
export function compactHorizontal(
  nodes: Array<{ id: string; x: number; width: number }>,
  minGap: number
): void {
  if (nodes.length === 0) return;

  // Sort by X coordinate
  nodes.sort((a, b) => a.x - b.x);

  // Compact from left to right
  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1];
    const curr = nodes[i];

    const minX = prev.x + prev.width + minGap;

    // Only move left, never right
    if (curr.x > minX) {
      curr.x = minX;
    }
  }
}

/**
 * Standalone function for vertical compaction
 */
export function compactVertical(
  nodes: Array<{ id: string; y: number; height: number }>,
  minGap: number
): void {
  if (nodes.length === 0) return;

  // Sort by Y coordinate
  nodes.sort((a, b) => a.y - b.y);

  // Compact from top to bottom
  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1];
    const curr = nodes[i];

    const minY = prev.y + prev.height + minGap;

    // Only move up, never down
    if (curr.y > minY) {
      curr.y = minY;
    }
  }
}
