/**
 * Group Positioner
 * Handles repositioning of BPMN Group elements to surround their grouped elements.
 * Groups are visual overlays that don't participate in ELK layout.
 */

import type { ElkNode } from 'elkjs';
import type { ElkBpmnGraph } from '../../types';
import type { NodeWithBpmn, GroupInfo } from '../../types/internal';
import { GROUP_TYPE } from '../../types/bpmn-constants';
import { buildNodeMapWithParents } from '../../utils/node-map-builder';

// Re-export GROUP_TYPE for backward compatibility
export { GROUP_TYPE };

/**
 * Handler for group repositioning
 */
export class GroupPositioner {
  /**
   * Collect Group information for post-processing
   * Returns a map of group ID -> { groupedElements, padding, name, parentId }
   */
  collectInfo(graph: ElkBpmnGraph): Map<string, GroupInfo> {
    const info = new Map<string, GroupInfo>();

    const collectFromNode = (node: NodeWithBpmn, parentId: string) => {
      if (node.children) {
        for (const child of node.children) {
          const childNode = child as NodeWithBpmn;
          if (childNode.bpmn?.type === GROUP_TYPE) {
            const bpmn = childNode.bpmn as { groupedElements?: string[]; padding?: number; name?: string };
            info.set(childNode.id, {
              groupedElements: bpmn.groupedElements ?? [],
              padding: bpmn.padding ?? 20,
              name: bpmn.name,
              parentId,
            });
          }
          // Recurse into children
          collectFromNode(childNode, childNode.id);
        }
      }
    };

    for (const child of graph.children ?? []) {
      collectFromNode(child as NodeWithBpmn, (child as NodeWithBpmn).id);
    }

    return info;
  }

  /**
   * Remove Groups from the graph before ELK layout
   * Groups will be repositioned after layout based on their grouped elements
   */
  removeFromGraph(graph: ElkBpmnGraph, groupInfo: Map<string, GroupInfo>): void {
    const groupIds = new Set(groupInfo.keys());

    const removeFromNode = (node: NodeWithBpmn) => {
      if (node.children) {
        node.children = node.children.filter((child) => {
          const childNode = child as NodeWithBpmn;
          return !groupIds.has(childNode.id);
        });

        // Recurse into remaining children
        for (const child of node.children) {
          removeFromNode(child as NodeWithBpmn);
        }
      }

      // Also remove edges that connect to groups
      if (node.edges) {
        node.edges = node.edges.filter((edge) => {
          const sourceId = edge.sources[0];
          const targetId = edge.targets[0];
          return !groupIds.has(sourceId) && !groupIds.has(targetId);
        });
      }
    };

    for (const child of graph.children ?? []) {
      removeFromNode(child as NodeWithBpmn);
    }
  }

  /**
   * Reposition Groups to surround their grouped elements
   * Modifies existing Group nodes in the layouted graph
   */
  reposition(
    graph: ElkNode,
    groupInfo: Map<string, GroupInfo>,
    _originalGraph: ElkBpmnGraph
  ): void {
    if (groupInfo.size === 0) return;

    // Build node map for position lookups
    const [nodeMap, parentMap] = buildNodeMapWithParents(graph);

    // Process each group
    for (const [groupId, info] of groupInfo) {
      // Find the existing group node in the layouted graph
      const groupNode = nodeMap.get(groupId);
      if (!groupNode) continue;

      // If no grouped elements specified, keep the ELK-calculated position
      if (info.groupedElements.length === 0) continue;

      // Calculate bounding box of grouped elements
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      for (const elementId of info.groupedElements) {
        const elementNode = nodeMap.get(elementId);
        if (!elementNode || elementNode.x === undefined || elementNode.y === undefined) continue;

        // Get position of the element relative to the same parent container as the group
        // Elements might be nested in lanes, so we need to traverse up to the group's parent
        let absX = elementNode.x ?? 0;
        let absY = elementNode.y ?? 0;
        let currentParent = parentMap.get(elementId);
        const groupParent = parentMap.get(groupId);

        // Traverse up to find common ancestor or group's parent
        while (currentParent && currentParent !== groupParent && currentParent.id !== info.parentId) {
          absX += currentParent.x ?? 0;
          absY += currentParent.y ?? 0;
          currentParent = parentMap.get(currentParent.id);
        }

        const w = elementNode.width ?? 100;
        const h = elementNode.height ?? 80;

        minX = Math.min(minX, absX);
        minY = Math.min(minY, absY);
        maxX = Math.max(maxX, absX + w);
        maxY = Math.max(maxY, absY + h);
      }

      // Check if we found any valid elements
      if (minX === Infinity) continue;

      // Add padding
      const padding = info.padding;
      minX -= padding;
      minY -= padding;
      maxX += padding;
      maxY += padding;

      // Update the group node's position and size
      groupNode.x = minX;
      groupNode.y = minY;
      groupNode.width = maxX - minX;
      groupNode.height = maxY - minY;
    }
  }
}
