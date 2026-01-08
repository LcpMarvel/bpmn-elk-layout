/**
 * Tree Layout Algorithm
 * Implements a simplified Reingold-Tilford algorithm for laying out tree structures.
 * Primarily used for boundary event branches which have a natural tree structure.
 */

import type { Bounds } from '../../types/internal';

/**
 * A node in the tree structure
 */
export interface TreeNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children: TreeNode[];
  // Layout helper fields
  prelim: number;
  modifier: number;
}

/**
 * Options for tree layout
 */
export interface TreeLayoutOptions {
  /** Horizontal gap between sibling nodes */
  horizontalGap: number;
  /** Vertical gap between parent and children */
  verticalGap: number;
  /** Direction of tree expansion */
  direction: 'DOWN' | 'RIGHT';
}

const DEFAULT_OPTIONS: TreeLayoutOptions = {
  horizontalGap: 40,
  verticalGap: 60,
  direction: 'DOWN',
};

/**
 * Tree layout algorithm based on Reingold-Tilford
 */
export class TreeLayouter {
  private options: TreeLayoutOptions;

  constructor(options?: Partial<TreeLayoutOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Layout a tree structure
   * @param root The root node of the tree
   */
  layout(root: TreeNode): void {
    // Initialize prelim and modifier
    this.initializeNode(root);

    // First walk: compute preliminary x-coordinates
    this.firstWalk(root);

    // Second walk: compute final positions
    this.secondWalk(root, -root.prelim);
  }

  /**
   * Initialize node layout fields
   */
  private initializeNode(node: TreeNode): void {
    node.prelim = 0;
    node.modifier = 0;
    for (const child of node.children) {
      this.initializeNode(child);
    }
  }

  /**
   * First walk: Compute preliminary x-coordinates bottom-up
   */
  private firstWalk(node: TreeNode): void {
    if (node.children.length === 0) {
      // Leaf node - prelim is 0 (will be adjusted by parent)
      node.prelim = 0;
    } else {
      // Recursively process children first
      for (const child of node.children) {
        this.firstWalk(child);
      }

      // Position children horizontally
      let totalWidth = 0;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const childWidth = this.getSubtreeWidth(child);
        child.prelim = totalWidth + childWidth / 2;
        totalWidth += childWidth + this.options.horizontalGap;
      }
      // Remove last gap
      totalWidth -= this.options.horizontalGap;

      // Center parent above children
      const leftChild = node.children[0];
      const rightChild = node.children[node.children.length - 1];
      node.prelim = (leftChild.prelim + rightChild.prelim) / 2;

      // Store modifier for second walk
      node.modifier = node.prelim;
    }
  }

  /**
   * Second walk: Compute final positions top-down
   */
  private secondWalk(node: TreeNode, modifier: number, depth: number = 0): void {
    if (this.options.direction === 'DOWN') {
      // Tree expands downward
      node.x = node.prelim + modifier;
      node.y = depth * (this.getMaxHeightAtDepth(node, depth) + this.options.verticalGap);
    } else {
      // Tree expands rightward
      node.y = node.prelim + modifier;
      node.x = depth * (this.getMaxWidthAtDepth(node, depth) + this.options.horizontalGap);
    }

    for (const child of node.children) {
      this.secondWalk(child, modifier, depth + 1);
    }
  }

  /**
   * Get the width of a subtree (for horizontal spacing)
   */
  private getSubtreeWidth(node: TreeNode): number {
    if (node.children.length === 0) {
      return node.width;
    }

    let totalWidth = 0;
    for (const child of node.children) {
      totalWidth += this.getSubtreeWidth(child) + this.options.horizontalGap;
    }
    totalWidth -= this.options.horizontalGap;

    return Math.max(node.width, totalWidth);
  }

  /**
   * Get maximum height at a specific depth
   */
  private getMaxHeightAtDepth(_node: TreeNode, _depth: number): number {
    // For simplicity, use the node's own height
    // In a more complex implementation, we'd compute max height across all nodes at this depth
    return _node.height;
  }

  /**
   * Get maximum width at a specific depth
   */
  private getMaxWidthAtDepth(_node: TreeNode, _depth: number): number {
    // For simplicity, use the node's own width
    return _node.width;
  }

  /**
   * Apply offset to entire tree
   */
  applyOffset(root: TreeNode, offsetX: number, offsetY: number): void {
    const applyRecursive = (node: TreeNode) => {
      node.x += offsetX;
      node.y += offsetY;
      for (const child of node.children) {
        applyRecursive(child);
      }
    };
    applyRecursive(root);
  }

  /**
   * Get bounds of the entire tree
   */
  getTreeBounds(root: TreeNode): Bounds {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const collectBounds = (node: TreeNode) => {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
      for (const child of node.children) {
        collectBounds(child);
      }
    };

    collectBounds(root);

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }
}

/**
 * Build a tree structure from a flat list of nodes and edges
 * @param rootId The ID of the root node
 * @param nodeMap Map of node ID to node data
 * @param edgeMap Map of source node ID to array of target node IDs
 */
export function buildTree(
  rootId: string,
  nodeMap: Map<string, Bounds & { id: string }>,
  edgeMap: Map<string, string[]>
): TreeNode | null {
  const rootData = nodeMap.get(rootId);
  if (!rootData) return null;

  const visited = new Set<string>();

  const buildNode = (nodeId: string): TreeNode | null => {
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);

    const nodeData = nodeMap.get(nodeId);
    if (!nodeData) return null;

    const children: TreeNode[] = [];
    const childIds = edgeMap.get(nodeId) || [];

    for (const childId of childIds) {
      const childNode = buildNode(childId);
      if (childNode) {
        children.push(childNode);
      }
    }

    return {
      id: nodeId,
      x: nodeData.x,
      y: nodeData.y,
      width: nodeData.width,
      height: nodeData.height,
      children,
      prelim: 0,
      modifier: 0,
    };
  };

  return buildNode(rootId);
}

/**
 * Layout a boundary event branch as a tree
 * @param boundaryEventTargetId The ID of the first node after the boundary event
 * @param nodeMap Map of node ID to node data
 * @param edgeMap Map of source node ID to array of target node IDs
 * @param parentNode The parent task/subprocess that the boundary event is attached to
 * @param options Layout options
 */
export function layoutBoundaryBranch(
  boundaryEventTargetId: string,
  nodeMap: Map<string, Bounds & { id: string }>,
  edgeMap: Map<string, string[]>,
  parentNode: Bounds,
  options?: Partial<TreeLayoutOptions>
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();

  // Build tree from the branch
  const tree = buildTree(boundaryEventTargetId, nodeMap, edgeMap);
  if (!tree) return result;

  // Apply tree layout
  const layouter = new TreeLayouter(options);
  layouter.layout(tree);

  // Position tree relative to parent
  const treeBounds = layouter.getTreeBounds(tree);
  const offsetX = parentNode.x + parentNode.width / 2 - treeBounds.width / 2 - treeBounds.x;
  const offsetY = parentNode.y + parentNode.height + 50; // 50px below parent

  layouter.applyOffset(tree, offsetX, offsetY);

  // Collect final positions
  const collectPositions = (node: TreeNode) => {
    result.set(node.id, { x: node.x, y: node.y });
    for (const child of node.children) {
      collectPositions(child);
    }
  };
  collectPositions(tree);

  return result;
}
