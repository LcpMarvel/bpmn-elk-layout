/**
 * Lane Arranger
 * Handles rearranging lanes to stack vertically within pools.
 * Uses simple sequential stacking for lane positioning.
 */

import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { ElkBpmnGraph } from '../../types';
import type { NodeWithBpmn, Point } from '../../types/internal';
import { isDebugEnabled } from '../../utils/debug';

type ElkNodeWithBpmn = ElkNode & { bpmn?: NodeWithBpmn['bpmn'] };

/**
 * Handler for lane rearrangement
 */
export class LaneArranger {
  private readonly laneHeaderWidth = 30;
  private readonly lanePadding = 0; // No extra padding - tight fit
  private readonly laneExtraWidth = 130; // Extra width for each lane
  private readonly laneExtraHeight = 120; // Extra height for each lane

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
   * Uses ConstraintSolver for vertical stacking
   */
  private buildLaneStructure(
    origChildren: NodeWithBpmn[],
    layoutedNodes: Map<string, ElkNode>,
    nodeToLane: Map<string, string>,
    startY: number,
    maxRight: number
  ): { lanes: ElkNode[]; totalHeight: number } {
    const lanes: ElkNode[] = [];

    // Filter to get only lanes and sort by partition
    const origLanes = origChildren.filter(c => c.bpmn?.type === 'lane');
    origLanes.sort((a, b) => {
      const partA = a.layoutOptions?.['elk.partitioning.partition'];
      const partB = b.layoutOptions?.['elk.partitioning.partition'];
      return (partA !== undefined ? Number(partA) : 0) - (partB !== undefined ? Number(partB) : 0);
    });

    if (origLanes.length === 0) {
      return { lanes: [], totalHeight: 0 };
    }

    // Calculate heights for each lane
    const laneHeights = new Map<string, number>();
    const laneNodes = new Map<string, ElkNode[]>();

    for (const origLane of origLanes) {
      const hasNestedLanes = origLane.children?.some((c: unknown) => (c as NodeWithBpmn).bpmn?.type === 'lane');

      if (hasNestedLanes) {
        const nestedWidth = maxRight - this.laneHeaderWidth;
        const nested = this.buildLaneStructure(
          origLane.children as NodeWithBpmn[],
          layoutedNodes,
          nodeToLane,
          0,
          nestedWidth
        );
        laneHeights.set(origLane.id, nested.totalHeight);
        laneNodes.set(origLane.id, nested.lanes);
      } else {
        const nodesInLane: ElkNode[] = [];
        if (origLane.children) {
          for (const child of origLane.children) {
            const node = layoutedNodes.get((child as NodeWithBpmn).id);
            if (node) nodesInLane.push(node);
          }
        }

        let minY = Infinity, maxY = 0;
        for (const node of nodesInLane) {
          minY = Math.min(minY, node.y ?? 0);
          maxY = Math.max(maxY, (node.y ?? 0) + (node.height ?? 80));
        }
        const contentHeight = nodesInLane.length > 0 ? maxY - minY : 50;
        const laneHeight = contentHeight + this.laneExtraHeight;

        const yOffset = nodesInLane.length > 0 ? (this.laneExtraHeight / 2) - minY : 0;
        const xOffset = this.laneExtraWidth / 2; // Center nodes horizontally
        for (const node of nodesInLane) {
          node.x = (node.x ?? 0) + xOffset;
          node.y = (node.y ?? 0) + yOffset;
        }

        laneHeights.set(origLane.id, laneHeight);
        laneNodes.set(origLane.id, nodesInLane);
      }
    }

    // Simple sequential stacking - lanes stack from startY downward
    let currentY = startY;

    // Build lane nodes with sequential positions
    for (const origLane of origLanes) {
      const height = laneHeights.get(origLane.id) ?? 100;
      const children = laneNodes.get(origLane.id) ?? [];
      const hasNestedLanes = origLane.children?.some((c: unknown) => (c as NodeWithBpmn).bpmn?.type === 'lane');

      if (hasNestedLanes) {
        for (const nestedLane of children) {
          nestedLane.width = maxRight - this.laneHeaderWidth;
        }
      }

      const laneNode: ElkNodeWithBpmn = {
        id: origLane.id,
        x: this.laneHeaderWidth,
        y: currentY,
        width: maxRight,
        height: height,
        children: children,
        bpmn: origLane.bpmn,
      };
      lanes.push(laneNode);
      currentY += height;
    }

    const totalHeight = currentY - startY;
    return { lanes, totalHeight };
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

      if (isDebugEnabled()) {
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

        if (isDebugEnabled()) {
          console.log(`[BPMN]   startX=${startX}, startY=${startY}, endX=${endX}, endY=${endY}`);
        }

        // Create new waypoints
        const waypoints: Point[] = [];
        waypoints.push({ x: startX, y: startY });

        // Check if there are obstacles in the direct path (even for same Y level)
        const obstaclesInPath = this.getObstaclesInPath(
          startX,
          startY,
          endX,
          endY,
          sourceId,
          targetId,
          nodePositions
        );

        // Add bend points for orthogonal routing if source and target are in different lanes
        // OR if there are obstacles in the direct path
        if (Math.abs(startY - endY) > 10 || obstaclesInPath.length > 0) {
          // If obstacles are in the way and Y levels are similar, we need to route around them
          if (obstaclesInPath.length > 0 && Math.abs(startY - endY) <= 10) {
            // Route around obstacles by going above or below
            const routePoints = this.routeAroundObstacles(
              startX,
              startY,
              endX,
              endY,
              obstaclesInPath,
              nodePositions
            );
            for (const pt of routePoints) {
              waypoints.push(pt);
            }
          } else {
            // Find a clear X position for the vertical segment that avoids obstacles
            const midX = this.findClearMidX(
              startX,
              endX,
              startY,
              endY,
              sourceId,
              targetId,
              nodePositions
            );

            if (midX !== null) {
              waypoints.push({ x: midX, y: startY });
              waypoints.push({ x: midX, y: endY });
            } else {
              // No clear midX found - fallback to routing around obstacles
              const routePoints = this.routeAroundObstacles(
                startX,
                startY,
                endX,
                endY,
                obstaclesInPath,
                nodePositions
              );
              for (const pt of routePoints) {
                waypoints.push(pt);
              }
            }
          }
        }

        waypoints.push({ x: endX, y: endY });

        if (isDebugEnabled()) {
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

  /**
   * Get obstacles in the direct path from source to target.
   * This handles the case where source and target are at similar Y positions
   * but there are nodes in between.
   */
  private getObstaclesInPath(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    sourceId: string | undefined,
    targetId: string | undefined,
    nodePositions: Map<string, { x: number; y: number; width: number; height: number }>
  ): { id: string; x: number; y: number; width: number; height: number }[] {
    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);

    const obstacles: { id: string; x: number; y: number; width: number; height: number }[] = [];

    // Patterns to identify flow nodes (actual obstacles) vs containers (lanes)
    const flowNodePatterns = [
      /^task_/, /^gateway_/, /^start_/, /^end_/,
      /^subprocess_/, /^call_/,
      /^intermediate_/, /^event_/, /^catch_/,
    ];

    for (const [nodeId, pos] of nodePositions) {
      if (nodeId === sourceId || nodeId === targetId) continue;

      // Skip lanes - they are containers, not obstacles
      if (nodeId.startsWith('lane_')) continue;

      // Only consider flow nodes as obstacles
      const isFlowNode = flowNodePatterns.some(pattern => pattern.test(nodeId));
      if (!isFlowNode) continue;

      const nodeLeft = pos.x;
      const nodeRight = pos.x + pos.width;
      const nodeTop = pos.y;
      const nodeBottom = pos.y + pos.height;

      // Check if node's bounding box intersects with the line segment's bounding box
      // For a roughly horizontal line (small Y difference), check if the node is in the way
      const xOverlap = nodeRight > minX && nodeLeft < maxX;

      // More precise check: does the line segment pass through the node?
      // For nearly horizontal lines, check if the node's Y range contains the line's Y range
      if (xOverlap) {
        // Check if the node's Y range intersects with the line's Y range
        if (nodeTop <= maxY && nodeBottom >= minY) {
          if (isDebugEnabled()) {
            console.log(`[BPMN]   getObstaclesInPath: found obstacle ${nodeId} at x=[${nodeLeft}, ${nodeRight}], y=[${nodeTop}, ${nodeBottom}]`);
          }
          obstacles.push({ id: nodeId, ...pos });
        }
      }
    }

    // Sort obstacles by X position (left to right)
    obstacles.sort((a, b) => a.x - b.x);

    return obstacles;
  }

  /**
   * Route around obstacles when source and target are at similar Y levels.
   * Decides whether to go above or below based on available space.
   */
  private routeAroundObstacles(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    obstacles: { id: string; x: number; y: number; width: number; height: number }[],
    nodePositions: Map<string, { x: number; y: number; width: number; height: number }>
  ): Point[] {
    const margin = 20;
    const points: Point[] = [];

    // Find the combined bounding box of all obstacles
    let minObsY = Infinity;
    let maxObsY = -Infinity;
    let minObsX = Infinity;
    let maxObsX = -Infinity;

    for (const obs of obstacles) {
      minObsY = Math.min(minObsY, obs.y);
      maxObsY = Math.max(maxObsY, obs.y + obs.height);
      minObsX = Math.min(minObsX, obs.x);
      maxObsX = Math.max(maxObsX, obs.x + obs.width);
    }

    // Check space above and below
    const spaceAbove = minObsY - margin;
    const spaceBelow = maxObsY + margin;

    // Decide direction: prefer going above if there's more space or if startY is above obstacle center
    const obsCenterY = (minObsY + maxObsY) / 2;
    const goAbove = startY < obsCenterY || spaceAbove > 0;

    const routeY = goAbove ? (minObsY - margin) : (maxObsY + margin);

    if (isDebugEnabled()) {
      console.log(`[BPMN]   routeAroundObstacles: goAbove=${goAbove}, routeY=${routeY}, minObsX=${minObsX}, maxObsX=${maxObsX}`);
    }

    // Create the route: go to first obstacle, up/down, horizontal past obstacles, then to target Y
    // Point 1: Vertical move to route Y level at start X
    points.push({ x: startX, y: routeY });

    // Point 2: Horizontal move past all obstacles
    points.push({ x: maxObsX + margin, y: routeY });

    // Point 3: Vertical move back to end Y level
    points.push({ x: maxObsX + margin, y: endY });

    return points;
  }

  /**
   * Find a clear X position for vertical edge segment that avoids obstacles.
   * Checks all three segments of the L-shaped path:
   * 1. Horizontal from (startX, startY) to (midX, startY)
   * 2. Vertical from (midX, startY) to (midX, endY)
   * 3. Horizontal from (midX, endY) to (endX, endY)
   *
   * Returns null if no valid route can be found (caller should use routeAroundObstacles instead)
   */
  private findClearMidX(
    startX: number,
    endX: number,
    startY: number,
    endY: number,
    sourceId: string | undefined,
    targetId: string | undefined,
    nodePositions: Map<string, { x: number; y: number; width: number; height: number }>
  ): number | null {
    const margin = 15; // Margin to keep from node edges
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);
    const rangeMinX = Math.min(startX, endX);
    const rangeMaxX = Math.max(startX, endX);

    if (isDebugEnabled()) {
      console.log(`[BPMN]   findClearMidX: startX=${startX}, endX=${endX}, startY=${startY}, endY=${endY}`);
    }

    // Patterns to identify flow nodes (actual obstacles) vs containers (lanes)
    const flowNodePatterns = [
      /^task_/, /^gateway_/, /^start_/, /^end_/,
      /^subprocess_/, /^call_/,
      /^intermediate_/, /^event_/, /^catch_/,
    ];

    // Collect all obstacles that could affect any segment of the path
    const allObstacles: { x: number; y: number; width: number; height: number; right: number; bottom: number; id: string }[] = [];
    for (const [nodeId, pos] of nodePositions) {
      if (nodeId === sourceId || nodeId === targetId) continue;

      // Skip lanes - they are containers, not obstacles
      if (nodeId.startsWith('lane_')) continue;

      // Only consider flow nodes as obstacles
      const isFlowNode = flowNodePatterns.some(pattern => pattern.test(nodeId));
      if (!isFlowNode) continue;

      const nodeLeft = pos.x;
      const nodeRight = pos.x + pos.width;
      const nodeTop = pos.y;
      const nodeBottom = pos.y + pos.height;

      // Check if this node could affect any part of the path
      // It affects the path if:
      // - Its X range overlaps with [rangeMinX, rangeMaxX] AND
      // - Its Y range overlaps with [minY, maxY] OR contains startY OR contains endY
      const xOverlap = nodeRight > rangeMinX && nodeLeft < rangeMaxX;
      const yOverlapVertical = nodeBottom > minY && nodeTop < maxY;
      const yContainsStartY = nodeTop <= startY && nodeBottom >= startY;
      const yContainsEndY = nodeTop <= endY && nodeBottom >= endY;

      if (xOverlap && (yOverlapVertical || yContainsStartY || yContainsEndY)) {
        allObstacles.push({
          x: nodeLeft,
          y: nodeTop,
          width: pos.width,
          height: pos.height,
          right: nodeRight,
          bottom: nodeBottom,
          id: nodeId,
        });
        if (isDebugEnabled()) {
          console.log(`[BPMN]   findClearMidX: obstacle ${nodeId}: x=[${nodeLeft}, ${nodeRight}], y=[${nodeTop}, ${nodeBottom}]`);
        }
      }
    }

    // If no obstacles, use simple midpoint
    if (allObstacles.length === 0) {
      return (startX + endX) / 2;
    }

    // Check if a candidate midX creates a valid path that doesn't cross any obstacle
    const isValidMidX = (midX: number): boolean => {
      for (const obs of allObstacles) {
        // Check horizontal segment 1: y=startY, x from startX to midX
        const seg1MinX = Math.min(startX, midX);
        const seg1MaxX = Math.max(startX, midX);
        if (obs.y <= startY && obs.bottom >= startY && // Y range contains startY
            obs.right > seg1MinX && obs.x < seg1MaxX) { // X ranges overlap
          return false;
        }

        // Check vertical segment: x=midX, y from minY to maxY
        if (obs.x <= midX && obs.right >= midX && // X range contains midX
            obs.bottom > minY && obs.y < maxY) { // Y ranges overlap
          return false;
        }

        // Check horizontal segment 2: y=endY, x from midX to endX
        const seg2MinX = Math.min(midX, endX);
        const seg2MaxX = Math.max(midX, endX);
        if (obs.y <= endY && obs.bottom >= endY && // Y range contains endY
            obs.right > seg2MinX && obs.x < seg2MaxX) { // X ranges overlap
          return false;
        }
      }
      return true;
    };

    // Generate candidate midX positions to try
    const candidates: number[] = [];

    // Simple midpoint
    candidates.push((startX + endX) / 2);

    // Just after startX
    candidates.push(startX + margin);

    // Just before endX
    candidates.push(endX - margin);

    // Positions around each obstacle (left and right edges)
    for (const obs of allObstacles) {
      candidates.push(obs.x - margin);
      candidates.push(obs.right + margin);
    }

    // Filter candidates to valid range and sort by distance from midpoint
    const simpleMidX = (startX + endX) / 2;
    const validCandidates = candidates
      .filter(x => x >= rangeMinX && x <= rangeMaxX)
      .sort((a, b) => Math.abs(a - simpleMidX) - Math.abs(b - simpleMidX));

    // Find first valid candidate
    for (const candidate of validCandidates) {
      if (isValidMidX(candidate)) {
        if (isDebugEnabled()) {
          console.log(`[BPMN]   findClearMidX: found valid position ${candidate}`);
        }
        return candidate;
      }
    }

    // No valid position found - try routing completely outside all obstacles
    const leftMost = Math.min(...allObstacles.map(o => o.x)) - margin;
    const rightMost = Math.max(...allObstacles.map(o => o.right)) + margin;

    if (leftMost >= rangeMinX && isValidMidX(leftMost)) {
      if (isDebugEnabled()) {
        console.log(`[BPMN]   findClearMidX: routing left of all obstacles at ${leftMost}`);
      }
      return leftMost;
    }

    if (rightMost <= rangeMaxX && isValidMidX(rightMost)) {
      if (isDebugEnabled()) {
        console.log(`[BPMN]   findClearMidX: routing right of all obstacles at ${rightMost}`);
      }
      return rightMost;
    }

    // No valid route found - return null so caller can use routeAroundObstacles
    if (isDebugEnabled()) {
      console.log(`[BPMN]   findClearMidX: no valid route found, returning null`);
    }
    return null;
  }
}
