/**
 * Node Map Builder Utility
 * Provides shared functions for building node maps from ELK graphs.
 * Used by various post-processors to efficiently look up nodes by ID.
 */

import type { ElkNode } from 'elkjs';

/**
 * Build a flat map of all nodes in the graph, keyed by ID.
 * Recursively traverses the graph to include all nested nodes.
 *
 * @param graph - The root ELK graph node
 * @returns A Map from node ID to ElkNode
 */
export function buildNodeMap(graph: ElkNode): Map<string, ElkNode> {
  const nodeMap = new Map<string, ElkNode>();

  const traverse = (node: ElkNode) => {
    nodeMap.set(node.id, node);
    if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  };

  traverse(graph);
  return nodeMap;
}

/**
 * Build a map of nodes with their parent references.
 * Useful when you need to know the parent of each node.
 *
 * @param graph - The root ELK graph node
 * @returns A tuple of [nodeMap, parentMap] where parentMap maps node ID to parent node
 */
export function buildNodeMapWithParents(
  graph: ElkNode
): [Map<string, ElkNode>, Map<string, ElkNode>] {
  const nodeMap = new Map<string, ElkNode>();
  const parentMap = new Map<string, ElkNode>();

  const traverse = (node: ElkNode, parent?: ElkNode) => {
    nodeMap.set(node.id, node);
    if (parent) {
      parentMap.set(node.id, parent);
    }
    if (node.children) {
      for (const child of node.children) {
        traverse(child, node);
      }
    }
  };

  traverse(graph);
  return [nodeMap, parentMap];
}

/**
 * Build a map of nodes with accumulated absolute offsets.
 * Useful when you need absolute coordinates for nodes in nested containers.
 *
 * @param graph - The root ELK graph node
 * @param isContainer - Function to determine if a node is a container (adds offset)
 * @returns A Map from node ID to { node, offsetX, offsetY }
 */
export function buildNodeMapWithOffsets(
  graph: ElkNode,
  isContainer: (node: ElkNode) => boolean
): Map<string, { node: ElkNode; offsetX: number; offsetY: number }> {
  const nodeMap = new Map<string, { node: ElkNode; offsetX: number; offsetY: number }>();

  const traverse = (node: ElkNode, offsetX: number, offsetY: number) => {
    nodeMap.set(node.id, { node, offsetX, offsetY });

    if (node.children) {
      // Calculate new offset for children
      const addOffset = isContainer(node);
      const newOffsetX = addOffset ? offsetX + (node.x ?? 0) : offsetX;
      const newOffsetY = addOffset ? offsetY + (node.y ?? 0) : offsetY;

      for (const child of node.children) {
        traverse(child, newOffsetX, newOffsetY);
      }
    }
  };

  traverse(graph, 0, 0);
  return nodeMap;
}

/**
 * Build a map of node absolute positions.
 * Calculates absolute x, y coordinates for each node.
 *
 * @param graph - The root ELK graph node
 * @param isContainer - Function to determine if a node is a container
 * @returns A Map from node ID to { x, y, width, height } in absolute coordinates
 */
export function buildAbsolutePositionMap(
  graph: ElkNode,
  isContainer: (node: ElkNode) => boolean
): Map<string, { x: number; y: number; width: number; height: number }> {
  const positionMap = new Map<string, { x: number; y: number; width: number; height: number }>();

  const traverse = (node: ElkNode, offsetX: number, offsetY: number) => {
    const absX = offsetX + (node.x ?? 0);
    const absY = offsetY + (node.y ?? 0);

    positionMap.set(node.id, {
      x: absX,
      y: absY,
      width: node.width ?? 0,
      height: node.height ?? 0,
    });

    if (node.children) {
      // Calculate new offset for children
      const addOffset = isContainer(node);
      const newOffsetX = addOffset ? absX : offsetX;
      const newOffsetY = addOffset ? absY : offsetY;

      for (const child of node.children) {
        traverse(child, newOffsetX, newOffsetY);
      }
    }
  };

  traverse(graph, 0, 0);
  return positionMap;
}
