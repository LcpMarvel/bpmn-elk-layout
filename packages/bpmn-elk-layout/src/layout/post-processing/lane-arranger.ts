/**
 * Lane Arranger
 * Handles rearranging lanes to stack vertically within pools.
 * ELK's partitioning doesn't correctly handle BPMN lanes, so we need
 * to rearrange them after layout.
 */

import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { ElkBpmnGraph } from '../../types';
import type { NodeWithBpmn, Point } from '../../types/internal';

type ElkNodeWithBpmn = ElkNode & { bpmn?: NodeWithBpmn['bpmn'] };
import { DEBUG } from '../../utils/debug';

/**
 * Handler for lane rearrangement
 */
export class LaneArranger {
  private readonly laneHeaderWidth = 30;
  private readonly lanePadding = 0; // No extra padding - tight fit
  private readonly laneExtraWidth = 50; // Extra width for each lane
  private readonly laneExtraHeight = 80; // Extra height for each lane

  /**
   * Rearrange lanes within pools to stack vertically
   */
  rearrange(layouted: ElkNode, original: ElkBpmnGraph): void {
    // Find pools in collaborations and process them
    if (layouted.children) {
      for (let i = 0; i < layouted.children.length; i++) {
        const child = layouted.children[i];
        const origChild = original.children?.[i] as NodeWithBpmn | undefined;

        // Check if this is a collaboration with pools
        if (origChild?.bpmn?.type === 'collaboration' && child.children) {
          for (let j = 0; j < child.children.length; j++) {
            const pool = child.children[j];
            const origPool = (origChild.children as NodeWithBpmn[] | undefined)?.[j];
            if (origPool?.bpmn?.type === 'participant') {
              this.processPool(pool, origPool);
            }
          }
        } else if (origChild?.bpmn?.type === 'participant') {
          // Direct pool (not in collaboration)
          this.processPool(child, origChild);
        }
      }
    }
  }

  /**
   * Process a single pool to arrange its lanes
   */
  private processPool(pool: ElkNode, origPool: NodeWithBpmn | undefined): void {
    if (!pool.children || !origPool?.children) return;

    // Check if this pool has lanes
    const hasLanes = (origPool.children as NodeWithBpmn[]).some(c => c.bpmn?.type === 'lane');
    if (!hasLanes) return;

    // Build node -> lane mapping (handles nested lanes)
    const nodeToLane = new Map<string, string>();
    this.buildNodeToLaneMap(origPool.children as NodeWithBpmn[], nodeToLane);

    // Get layouted nodes (flattened at pool level after ELK)
    const layoutedNodes = new Map<string, ElkNode>();
    for (const child of pool.children) {
      layoutedNodes.set(child.id, child);
    }

    // Calculate max content width
    let maxRight = 0;
    for (const child of pool.children) {
      maxRight = Math.max(maxRight, (child.x ?? 0) + (child.width ?? 100));
    }

    // Calculate pool width (content width + extra width)
    const poolContentWidth = maxRight + this.laneExtraWidth;

    // Build lane structure - lanes fill the full pool width
    const result = this.buildLaneStructure(
      origPool.children as NodeWithBpmn[],
      layoutedNodes,
      nodeToLane,
      0,
      poolContentWidth // Lanes fill full width
    );

    // Update pool - lanes fill the entire pool, no gaps
    pool.children = result.lanes;
    pool.width = this.laneHeaderWidth + poolContentWidth;
    pool.height = result.totalHeight;

    // Recalculate edge waypoints
    if (pool.edges) {
      this.recalculatePoolEdges(pool, result.lanes);
    }
  }

  /**
   * Build a map of node ID -> deepest lane ID (for nested lanes)
   */
  private buildNodeToLaneMap(children: NodeWithBpmn[], map: Map<string, string>): void {
    for (const child of children) {
      if (child.bpmn?.type === 'lane') {
        // Check if this lane has nested lanes
        const hasNestedLanes = child.children?.some((c: unknown) => (c as NodeWithBpmn).bpmn?.type === 'lane');
        if (hasNestedLanes) {
          // Recurse into nested lanes
          this.buildNodeToLaneMap(child.children as NodeWithBpmn[], map);
        } else if (child.children) {
          // Leaf lane - map its children to this lane
          for (const node of child.children) {
            map.set((node as NodeWithBpmn).id, child.id);
          }
        }
      }
    }
  }

  /**
   * Recursively build lane structure with positioned nodes
   */
  private buildLaneStructure(
    origChildren: NodeWithBpmn[],
    layoutedNodes: Map<string, ElkNode>,
    nodeToLane: Map<string, string>,
    startY: number,
    maxRight: number
  ): { lanes: ElkNode[]; totalHeight: number } {
    const lanes: ElkNode[] = [];
    let currentY = startY;

    // Filter to get only lanes and sort by partition
    const origLanes = origChildren.filter(c => c.bpmn?.type === 'lane');
    origLanes.sort((a, b) => {
      const partA = a.layoutOptions?.['elk.partitioning.partition'];
      const partB = b.layoutOptions?.['elk.partitioning.partition'];
      return (partA !== undefined ? Number(partA) : 0) - (partB !== undefined ? Number(partB) : 0);
    });

    for (const origLane of origLanes) {
      const hasNestedLanes = origLane.children?.some((c: unknown) => (c as NodeWithBpmn).bpmn?.type === 'lane');

      if (hasNestedLanes) {
        // Recursively process nested lanes
        // Nested lanes are offset by laneHeaderWidth inside their parent,
        // so they need reduced width to avoid overflow
        const nestedWidth = maxRight - this.laneHeaderWidth;
        const nested = this.buildLaneStructure(
          origLane.children as NodeWithBpmn[],
          layoutedNodes,
          nodeToLane,
          0,
          nestedWidth
        );

        // Ensure nested lanes fill parent lane width (minus header)
        for (const nestedLane of nested.lanes) {
          nestedLane.width = nestedWidth;
        }

        const laneNode: ElkNodeWithBpmn = {
          id: origLane.id,
          x: this.laneHeaderWidth,
          y: currentY,
          width: maxRight, // Fill full width
          height: nested.totalHeight, // Tight fit
          children: nested.lanes,
          bpmn: origLane.bpmn,
        };
        lanes.push(laneNode);
        currentY += laneNode.height!;
      } else {
        // Leaf lane - collect its nodes
        const nodesInLane: ElkNode[] = [];
        if (origLane.children) {
          for (const child of origLane.children) {
            const node = layoutedNodes.get((child as NodeWithBpmn).id);
            if (node) nodesInLane.push(node);
          }
        }

        // Calculate lane height based on content + extra height
        let minY = Infinity, maxY = 0;
        for (const node of nodesInLane) {
          minY = Math.min(minY, node.y ?? 0);
          maxY = Math.max(maxY, (node.y ?? 0) + (node.height ?? 80));
        }
        // Add extra height to each lane
        const contentHeight = nodesInLane.length > 0 ? maxY - minY : 50;
        const laneHeight = contentHeight + this.laneExtraHeight;

        // Center content vertically within the lane
        const yOffset = nodesInLane.length > 0 ? (this.laneExtraHeight / 2) - minY : 0;
        for (const node of nodesInLane) {
          node.y = (node.y ?? 0) + yOffset;
        }

        const laneNode: ElkNodeWithBpmn = {
          id: origLane.id,
          x: this.laneHeaderWidth,
          y: currentY,
          width: maxRight,
          height: laneHeight,
          children: nodesInLane,
          bpmn: origLane.bpmn,
        };
        lanes.push(laneNode);
        currentY += laneHeight;
      }
    }

    return { lanes, totalHeight: currentY - startY };
  }

  /**
   * Rearrange nested lanes within a parent lane
   */
  rearrangeNested(lane: ElkNode, origLane: NodeWithBpmn | undefined): void {
    if (!lane.children) return;

    // Check if this lane has nested lanes
    const nestedLanes: ElkNode[] = [];
    const nonLanes: ElkNode[] = [];

    for (const child of lane.children) {
      const origChild = origLane?.children?.find((c: unknown) => (c as NodeWithBpmn).id === child.id) as NodeWithBpmn | undefined;
      if (origChild?.bpmn?.type === 'lane') {
        nestedLanes.push(child);
      } else {
        nonLanes.push(child);
      }
    }

    if (nestedLanes.length > 0) {
      // Stack nested lanes vertically
      let currentY = 12;
      let maxWidth = 0;

      for (const nestedLane of nestedLanes) {
        const contentHeight = this.calculateContentHeight(nestedLane);
        const laneHeight = Math.max(contentHeight + 24, 60);

        nestedLane.x = 30; // Nested lane header offset
        nestedLane.y = currentY;
        nestedLane.height = laneHeight;

        const contentWidth = this.calculateContentWidth(nestedLane);
        nestedLane.width = contentWidth + 24;
        maxWidth = Math.max(maxWidth, nestedLane.width ?? 0);

        currentY += laneHeight;
      }

      // Update all nested lanes to have the same width
      for (const nestedLane of nestedLanes) {
        nestedLane.width = maxWidth;
      }

      // Update parent lane dimensions
      lane.width = 30 + maxWidth + 12;
      lane.height = currentY + 12;
    }
  }

  /**
   * Calculate the width needed to contain all children of a node
   */
  calculateContentWidth(node: ElkNode): number {
    if (!node.children || node.children.length === 0) {
      return 100; // Default minimum width
    }

    let maxRight = 0;
    for (const child of node.children) {
      const right = (child.x ?? 0) + (child.width ?? 100);
      maxRight = Math.max(maxRight, right);
    }

    return maxRight;
  }

  /**
   * Calculate the height needed to contain all children of a node
   */
  calculateContentHeight(node: ElkNode): number {
    if (!node.children || node.children.length === 0) {
      return 60; // Default minimum height
    }

    let maxBottom = 0;
    for (const child of node.children) {
      const bottom = (child.y ?? 0) + (child.height ?? 80);
      maxBottom = Math.max(maxBottom, bottom);
    }

    return maxBottom;
  }

  /**
   * Recalculate edge waypoints after lanes have been rearranged
   */
  private recalculatePoolEdges(pool: ElkNode, lanes: ElkNode[]): void {
    if (!pool.edges) return;

    // Build a map of node positions within the pool
    const nodePositions = new Map<string, { x: number; y: number; width: number; height: number }>();

    const collectNodePositions = (container: ElkNode, offsetX: number, offsetY: number) => {
      if (container.children) {
        for (const child of container.children) {
          const absX = offsetX + (child.x ?? 0);
          const absY = offsetY + (child.y ?? 0);
          nodePositions.set(child.id, {
            x: absX,
            y: absY,
            width: child.width ?? 100,
            height: child.height ?? 80,
          });
          // Recursively collect from nested containers
          collectNodePositions(child, absX, absY);
        }
      }
    };

    // Collect positions from all lanes
    for (const lane of lanes) {
      collectNodePositions(lane, lane.x ?? 0, lane.y ?? 0);
    }

    // Recalculate edge waypoints
    for (const edge of pool.edges) {
      const sourceId = edge.sources?.[0];
      const targetId = edge.targets?.[0];

      const sourcePos = sourceId ? nodePositions.get(sourceId) : undefined;
      const targetPos = targetId ? nodePositions.get(targetId) : undefined;

      if (DEBUG) {
        console.log(`[BPMN] recalculatePoolEdges ${edge.id}: source=${sourceId}, target=${targetId}`);
        console.log(`[BPMN]   sourcePos=${JSON.stringify(sourcePos)}`);
        console.log(`[BPMN]   targetPos=${JSON.stringify(targetPos)}`);
      }

      if (sourcePos && targetPos) {
        // Calculate connection points
        const startX = sourcePos.x + sourcePos.width;
        const startY = sourcePos.y + sourcePos.height / 2;
        const endX = targetPos.x;
        const endY = targetPos.y + targetPos.height / 2;

        if (DEBUG) {
          console.log(`[BPMN]   startX=${startX}, startY=${startY}, endX=${endX}, endY=${endY}`);
        }

        // Create new waypoints
        const waypoints: Point[] = [];
        waypoints.push({ x: startX, y: startY });

        // Add bend points for orthogonal routing if source and target are in different lanes
        if (Math.abs(startY - endY) > 10) {
          const midX = (startX + endX) / 2;
          waypoints.push({ x: midX, y: startY });
          waypoints.push({ x: midX, y: endY });
        }

        waypoints.push({ x: endX, y: endY });

        if (DEBUG) {
          console.log(`[BPMN]   waypoints=${JSON.stringify(waypoints)}`);
        }

        // Update edge sections
        // Mark as pool-relative coords (model-builder should use pool offset, not source node offset)
        (edge as ElkExtendedEdge & { _poolRelativeCoords?: boolean })._poolRelativeCoords = true;
        edge.sections = [{
          id: `${edge.id}_s0`,
          startPoint: { x: startX, y: startY },
          endPoint: { x: endX, y: endY },
          bendPoints: waypoints.length > 2 ? waypoints.slice(1, -1) : undefined,
        }];
      }
    }
  }
}
