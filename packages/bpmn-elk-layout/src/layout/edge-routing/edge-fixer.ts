/**
 * Edge Fixer
 * Detects and fixes edges that cross through nodes.
 * Ensures edges connect perpendicular to node boundaries.
 */

import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { Point, Bounds, NodeWithBpmn } from '../../types/internal';
import { segmentCrossesNode } from './geometry-utils';
import { DEBUG } from '../../utils/debug';

/**
 * Handler for edge crossing detection and fixing
 */
export class EdgeFixer {
  private readonly margin = 15;

  /**
   * Fix edges that cross through nodes
   */
  fix(graph: ElkNode): void {
    // Build node positions organized by container (pool/process)
    const nodesByContainer = new Map<string, Map<string, Bounds>>();

    // Flow node ID patterns (tasks, gateways, events) - excluding boundary events
    // Boundary events are small elements attached to tasks and should not block edges
    const flowNodePatterns = [
      /^task_/, /^gateway_/, /^start_/, /^end_/,
      /^subprocess_/, /^call_/,
      /^intermediate_/, /^event_/, /^catch_/,
    ];

    // Boundary event pattern - these should not be treated as obstacles
    const boundaryEventPattern = /^boundary_/;

    // Container ID patterns that define pool/process boundaries
    const poolPatterns = [
      /^pool_/, /^participant_/, /^process_/,
    ];

    const collectNodePositions = (
      node: ElkNode,
      offsetX: number = 0,
      offsetY: number = 0,
      containerId: string = 'root'
    ) => {
      const id = node.id || '';
      const isBoundaryEvent = boundaryEventPattern.test(id);
      const isFlowNode = flowNodePatterns.some(pattern => pattern.test(id));
      const isPool = poolPatterns.some(pattern => pattern.test(id));
      const bpmn = (node as unknown as NodeWithBpmn).bpmn;

      if (DEBUG && (id.includes('lane') || id.includes('pool') || id.includes('end_fast') || id.includes('gateway_fast'))) {
        console.log(`[BPMN] EdgeFixer.collectNodePositions: id=${id}, offsetX=${offsetX}, offsetY=${offsetY}, bpmn=${JSON.stringify(bpmn)}`);
        console.log(`[BPMN]   node.x=${node.x}, node.y=${node.y}, isFlowNode=${isFlowNode}, isPool=${isPool}`);
      }

      // If this is a pool/process container, use it as the new container context
      const currentContainerId = isPool ? id : containerId;

      // For flow nodes (excluding boundary events), store their position under their container
      // Boundary events should not be obstacles as they're small elements attached to tasks
      if (isFlowNode && !isBoundaryEvent && node.x !== undefined && node.y !== undefined) {
        const absX = offsetX + node.x;
        const absY = offsetY + node.y;

        if (!nodesByContainer.has(currentContainerId)) {
          nodesByContainer.set(currentContainerId, new Map());
        }
        nodesByContainer.get(currentContainerId)!.set(node.id, {
          x: absX,
          y: absY,
          width: node.width ?? 100,
          height: node.height ?? 80,
        });
      }

      // Recursively process children
      // Use same container detection logic as model-builder:
      // - Containers that offset children: pools (participants), lanes, expanded subprocesses
      // - Regular processes do NOT offset their children (unlike pools)
      const isExpandedSubprocess = bpmn?.isExpanded === true &&
        (bpmn?.type === 'subProcess' || bpmn?.type === 'transaction' ||
         bpmn?.type === 'adHocSubProcess' || bpmn?.type === 'eventSubProcess');
      const isPoolOrLane = bpmn?.type === 'participant' || bpmn?.type === 'lane';
      const isContainer = isExpandedSubprocess || isPoolOrLane;

      if (node.children) {
        const newOffsetX = isContainer ? offsetX + (node.x ?? 0) : offsetX;
        const newOffsetY = isContainer ? offsetY + (node.y ?? 0) : offsetY;
        for (const child of node.children) {
          collectNodePositions(child, newOffsetX, newOffsetY, currentContainerId);
        }
      }
    };
    collectNodePositions(graph);

    // Process all edges in the graph
    const processEdges = (
      node: ElkNode,
      containerOffsetX: number = 0,
      containerOffsetY: number = 0,
      containerId: string = 'root'
    ) => {
      const bpmn = (node as unknown as NodeWithBpmn).bpmn;
      const isPool = poolPatterns.some(pattern => pattern.test(node.id || ''));
      const currentContainerId = isPool ? node.id : containerId;

      if (node.edges) {
        // Get only nodes in the same container for crossing detection
        const containerNodes = nodesByContainer.get(currentContainerId) ?? new Map();

        for (const edge of node.edges) {
          if (edge.sections && edge.sections.length > 0) {
            this.fixEdgeIfCrossing(edge, containerNodes, containerOffsetX, containerOffsetY);
          }
        }
      }

      // Use same container detection logic as model-builder and collectNodePositions
      const isExpandedSubprocess = bpmn?.isExpanded === true &&
        (bpmn?.type === 'subProcess' || bpmn?.type === 'transaction' ||
         bpmn?.type === 'adHocSubProcess' || bpmn?.type === 'eventSubProcess');
      const isPoolOrLane = bpmn?.type === 'participant' || bpmn?.type === 'lane';
      const isContainer = isExpandedSubprocess || isPoolOrLane;

      if (node.children) {
        const newOffsetX = isContainer ? containerOffsetX + (node.x ?? 0) : containerOffsetX;
        const newOffsetY = isContainer ? containerOffsetY + (node.y ?? 0) : containerOffsetY;
        for (const child of node.children) {
          processEdges(child, newOffsetX, newOffsetY, currentContainerId);
        }
      }
    };
    processEdges(graph);
  }

  /**
   * Check if an edge crosses any node and fix it if so
   */
  private fixEdgeIfCrossing(
    edge: ElkExtendedEdge,
    nodePositions: Map<string, Bounds>,
    containerOffsetX: number,
    containerOffsetY: number
  ): void {
    const section = edge.sections?.[0];
    if (!section) return;

    const sourceId = edge.sources?.[0];
    const targetId = edge.targets?.[0];

    // Skip edges from boundary events - they're already handled by boundary-event-handler
    // with proper perpendicular routing and obstacle avoidance
    if (sourceId?.startsWith('boundary_')) {
      return;
    }

    // Convert waypoints to absolute positions
    const waypoints: Point[] = [
      { x: containerOffsetX + section.startPoint.x, y: containerOffsetY + section.startPoint.y },
    ];
    if (section.bendPoints) {
      for (const bp of section.bendPoints) {
        waypoints.push({ x: containerOffsetX + bp.x, y: containerOffsetY + bp.y });
      }
    }
    waypoints.push({ x: containerOffsetX + section.endPoint.x, y: containerOffsetY + section.endPoint.y });

    // Check each segment of the edge for crossings
    const crossedNodes: string[] = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const p1 = waypoints[i];
      const p2 = waypoints[i + 1];
      if (!p1 || !p2) continue;

      for (const [nodeId, pos] of nodePositions) {
        // Skip source and target nodes for intermediate segments
        if (nodeId === sourceId || nodeId === targetId) continue;

        if (segmentCrossesNode(p1, p2, pos)) {
          crossedNodes.push(nodeId);
        }
      }
    }

    // Also check if the edge path crosses THROUGH the target node (not just connects to it)
    const targetPos = targetId ? nodePositions.get(targetId) : undefined;
    const sourcePos = sourceId ? nodePositions.get(sourceId) : undefined;

    if (DEBUG && edge.id?.includes('back')) {
      console.log(`[BPMN] Edge ${edge.id}: sourceId=${sourceId}, targetId=${targetId}`);
      console.log(`[BPMN] Edge ${edge.id}: sourcePos=${JSON.stringify(sourcePos)}, targetPos=${JSON.stringify(targetPos)}`);
      console.log(`[BPMN] Edge ${edge.id}: waypoints.length=${waypoints.length}`);
    }

    if (targetPos && sourcePos && waypoints.length >= 2) {
      // Check the last segment before entering the target
      const lastWaypoint = waypoints[waypoints.length - 1];
      const secondLastWaypoint = waypoints[waypoints.length - 2];

      // If this is a return edge (target above source) and the last segment is horizontal
      // going through the target, we need to reroute
      const isReturnEdge = targetPos.y + targetPos.height < sourcePos.y;

      if (DEBUG && edge.id?.includes('back')) {
        console.log(`[BPMN] Edge ${edge.id}: isReturnEdge=${isReturnEdge}`);
        if (lastWaypoint) {
          console.log(`[BPMN] Edge ${edge.id}: lastWaypoint=(${lastWaypoint.x},${lastWaypoint.y})`);
        }
      }

      if (isReturnEdge && lastWaypoint && secondLastWaypoint) {
        // Check if the horizontal segment crosses through the target interior
        if (Math.abs(secondLastWaypoint.y - lastWaypoint.y) < 5) {
          // Horizontal segment
          const segY = secondLastWaypoint.y;
          const segMinX = Math.min(secondLastWaypoint.x, lastWaypoint.x);
          const segMaxX = Math.max(secondLastWaypoint.x, lastWaypoint.x);

          // Check if segment passes through target interior
          if (segY > targetPos.y && segY < targetPos.y + targetPos.height) {
            if (segMinX < targetPos.x + targetPos.width && segMaxX > targetPos.x) {
              crossedNodes.push(targetId + ' (target)');
            }
          }
        }
      }
    }

    if (crossedNodes.length === 0) return;

    if (DEBUG) {
      console.log(`[BPMN] Edge ${edge.id} crosses nodes: ${crossedNodes.join(', ')}`);
    }

    if (!sourcePos || !targetPos) return;

    // Collect obstacles (all crossed nodes plus nearby nodes)
    const obstacles: (Bounds & { id: string })[] = [];
    for (const [nodeId, pos] of nodePositions) {
      if (nodeId === sourceId || nodeId === targetId) continue;
      obstacles.push({ ...pos, id: nodeId });
    }

    // Determine if this is a return edge (target is above source)
    const isReturnEdge = targetPos.y + targetPos.height < sourcePos.y;

    // For return edges that cross through target, adjust endpoint to enter from right side
    const crossesThroughTarget = crossedNodes.some(n => n.includes('(target)'));
    if (isReturnEdge && crossesThroughTarget) {
      const targetWidth = targetPos.width;
      section.endPoint = {
        x: section.endPoint.x + targetWidth,
        y: section.endPoint.y,
      };
    }

    // Get the adjusted endpoints in absolute coordinates
    const originalStart = {
      x: containerOffsetX + section.startPoint.x,
      y: containerOffsetY + section.startPoint.y,
    };
    const originalEnd = {
      x: containerOffsetX + section.endPoint.x,
      y: containerOffsetY + section.endPoint.y,
    };

    // Calculate new path that avoids obstacles with perpendicular connections
    const result = this.calculatePerpendicularAvoidingPath(
      originalStart,
      originalEnd,
      sourcePos,
      targetPos,
      obstacles,
      isReturnEdge
    );

    // Update start and end points if new ones were calculated
    if (result.startPoint) {
      section.startPoint = {
        x: result.startPoint.x - containerOffsetX,
        y: result.startPoint.y - containerOffsetY,
      };
    }
    if (result.endPoint) {
      section.endPoint = {
        x: result.endPoint.x - containerOffsetX,
        y: result.endPoint.y - containerOffsetY,
      };
    }

    // Convert bend points back to relative coordinates
    const relativeBendPoints = result.bendPoints.map(bp => ({
      x: bp.x - containerOffsetX,
      y: bp.y - containerOffsetY,
    }));

    section.bendPoints = relativeBendPoints.length > 0 ? relativeBendPoints : undefined;

    if (DEBUG) {
      console.log(`[BPMN] Fixed edge ${edge.id} with ${relativeBendPoints.length} bend points`);
    }
  }

  /**
   * Determine connection side based on the edge direction
   * For BPMN diagrams with left-to-right flow, we prefer horizontal connections
   * even when vertical distance is larger, as long as target is to the right.
   */
  private determineConnectionSide(
    from: Point,
    to: Point,
    nodeBounds: Bounds,
    isSource: boolean
  ): 'top' | 'bottom' | 'left' | 'right' {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // For BPMN left-to-right flow: when target is to the right of source,
    // prefer horizontal connections (exit right from source, enter left to target)
    // This ensures edges follow the natural flow direction.
    // EXCEPTION: If target is significantly above/below (vertical distance > 1.5x horizontal),
    // the target should use vertical entry point (top/bottom) for cleaner routing.
    if (dx > 0) {
      // Target is to the right
      if (isSource) {
        return 'right';
      } else {
        // For target: if it's significantly above or below, use vertical entry
        if (absDy > absDx * 1.5) {
          return dy > 0 ? 'top' : 'bottom';
        }
        return 'left';
      }
    } else if (dx < 0) {
      // Target is to the left (return edge)
      if (isSource) {
        return 'left';
      } else {
        return 'right';
      }
    } else {
      // Same X position - use vertical routing
      if (isSource) {
        return dy > 0 ? 'bottom' : 'top';
      } else {
        return dy > 0 ? 'top' : 'bottom';
      }
    }
  }

  /**
   * Get the connection point on a node boundary
   */
  private getConnectionPoint(bounds: Bounds, side: 'top' | 'bottom' | 'left' | 'right'): Point {
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;

    switch (side) {
      case 'top':
        return { x: centerX, y: bounds.y };
      case 'bottom':
        return { x: centerX, y: bounds.y + bounds.height };
      case 'left':
        return { x: bounds.x, y: centerY };
      case 'right':
        return { x: bounds.x + bounds.width, y: centerY };
    }
  }

  /**
   * Calculate bend points that avoid obstacles while ensuring perpendicular connections
   * Uses LOCAL routing - only considers obstacles actually blocking the direct path
   */
  private calculatePerpendicularAvoidingPath(
    originalStart: Point,
    originalEnd: Point,
    source: Bounds,
    target: Bounds,
    obstacles: (Bounds & { id: string })[],
    isReturnEdge: boolean
  ): { bendPoints: Point[]; startPoint?: Point; endPoint?: Point } {
    // Determine the primary direction of travel
    const dx = originalEnd.x - originalStart.x;
    const dy = originalEnd.y - originalStart.y;

    // Determine connection sides based on overall direction
    const sourceSide = this.determineConnectionSide(originalStart, originalEnd, source, true);
    const targetSide = this.determineConnectionSide(originalStart, originalEnd, target, false);

    // Get actual start and end points on node boundaries
    const startPoint = this.getConnectionPoint(source, sourceSide);
    const endPoint = this.getConnectionPoint(target, targetSide);

    // Define the bounding box of direct path from start to end
    const pathMinX = Math.min(startPoint.x, endPoint.x) - this.margin;
    const pathMaxX = Math.max(startPoint.x, endPoint.x) + this.margin;
    const pathMinY = Math.min(startPoint.y, endPoint.y) - this.margin;
    const pathMaxY = Math.max(startPoint.y, endPoint.y) + this.margin;

    // Filter obstacles to only those that actually block the path
    const blockingObstacles = obstacles.filter(obs => {
      const obsRight = obs.x + obs.width;
      const obsBottom = obs.y + obs.height;

      // Check if obstacle overlaps with the path bounding box
      const overlapX = obs.x < pathMaxX && obsRight > pathMinX;
      const overlapY = obs.y < pathMaxY && obsBottom > pathMinY;

      return overlapX && overlapY;
    });

    if (blockingObstacles.length === 0) {
      // No obstacles blocking - use simple perpendicular routing
      const bendPoints = this.createPerpendicularPath(startPoint, endPoint, sourceSide, targetSide);
      return { bendPoints, startPoint, endPoint };
    }

    // Determine routing strategy based on BOTH horizontal and vertical directions
    // When target is to the right of source, always prefer routing RIGHT (not left)
    const targetIsRight = dx > 0;
    const targetIsAbove = dy < 0;
    const targetIsBelow = dy > 0;

    let bendPoints: Point[];

    // For diagonal movements where target is to the right, use right-biased routing
    if (targetIsRight) {
      if (targetIsAbove) {
        // Going right and up - route right then up
        bendPoints = this.routeRightThenUp(startPoint, endPoint, blockingObstacles, source, target);
      } else if (targetIsBelow) {
        // Going right and down - route right then down
        bendPoints = this.routeRightThenDown(startPoint, endPoint, blockingObstacles, source, target);
      } else {
        // Purely horizontal right
        bendPoints = this.routeRightWithObstacleAvoidance(startPoint, endPoint, sourceSide, targetSide, blockingObstacles, source, target);
      }
    } else {
      // Target is to the left or same X
      if (targetIsAbove) {
        bendPoints = this.routeUpWithObstacleAvoidance(startPoint, endPoint, sourceSide, targetSide, blockingObstacles, source, target);
      } else if (targetIsBelow) {
        bendPoints = this.routeDownWithObstacleAvoidance(startPoint, endPoint, sourceSide, targetSide, blockingObstacles, source, target);
      } else {
        bendPoints = this.routeLeftWithObstacleAvoidance(startPoint, endPoint, sourceSide, targetSide, blockingObstacles, source, target);
      }
    }

    return { bendPoints, startPoint, endPoint };
  }

  /**
   * Route right then up - for edges going both right and up
   * Source exits from right side, target enters from left side
   * Strategy: go horizontally right past obstacles, then vertically to target
   */
  private routeRightThenUp(
    start: Point,
    end: Point,
    obstacles: (Bounds & { id: string })[],
    source: Bounds,
    target: Bounds
  ): Point[] {
    const bendPoints: Point[] = [];

    // Find obstacles that block the direct vertical path from start.x to end.y
    const blockingObstacles = obstacles.filter(obs => {
      // Obstacle blocks if it's horizontally overlapping with the path
      // and vertically between source and target
      const obsRight = obs.x + obs.width;
      const obsBottom = obs.y + obs.height;
      const pathMinY = Math.min(start.y, end.y);
      const pathMaxY = Math.max(start.y, end.y);

      return obs.x < end.x && obsRight > start.x - this.margin &&
             obs.y < pathMaxY && obsBottom > pathMinY;
    });

    if (blockingObstacles.length === 0) {
      // No obstacles - simple L-route
      bendPoints.push({ x: end.x, y: start.y });
      return bendPoints;
    }

    // Find the rightmost edge of blocking obstacles
    let clearX = start.x;
    for (const obs of blockingObstacles) {
      clearX = Math.max(clearX, obs.x + obs.width + this.margin);
    }
    // Ensure we go at least to target X
    clearX = Math.max(clearX, end.x);

    // Route: go right to clearX, then up to target Y, then left to target X (if needed)
    if (Math.abs(clearX - end.x) < 5) {
      // clearX is close to end.x - simple L-route
      bendPoints.push({ x: end.x, y: start.y });
    } else {
      // Need to route past obstacles then back
      bendPoints.push({ x: clearX, y: start.y });
      bendPoints.push({ x: clearX, y: end.y });
    }

    return bendPoints;
  }

  /**
   * Route right then down - for edges going both right and down
   * Source exits from right side, target enters from left side
   * Strategy: go horizontally right past obstacles, then vertically to target
   */
  private routeRightThenDown(
    start: Point,
    end: Point,
    obstacles: (Bounds & { id: string })[],
    source: Bounds,
    target: Bounds
  ): Point[] {
    const bendPoints: Point[] = [];

    // Find obstacles that block the direct vertical path from start.x to end.y
    const blockingObstacles = obstacles.filter(obs => {
      // Obstacle blocks if it's horizontally overlapping with the path
      // and vertically between source and target
      const obsRight = obs.x + obs.width;
      const obsBottom = obs.y + obs.height;
      const pathMinY = Math.min(start.y, end.y);
      const pathMaxY = Math.max(start.y, end.y);

      return obs.x < end.x && obsRight > start.x - this.margin &&
             obs.y < pathMaxY && obsBottom > pathMinY;
    });

    if (blockingObstacles.length === 0) {
      // No obstacles - simple L-route
      bendPoints.push({ x: end.x, y: start.y });
      return bendPoints;
    }

    // Find the rightmost edge of blocking obstacles
    let clearX = start.x;
    for (const obs of blockingObstacles) {
      clearX = Math.max(clearX, obs.x + obs.width + this.margin);
    }
    // Ensure we go at least to target X
    clearX = Math.max(clearX, end.x);

    // Route: go right to clearX, then down to target Y, then left to target X (if needed)
    if (Math.abs(clearX - end.x) < 5) {
      // clearX is close to end.x - simple L-route
      bendPoints.push({ x: end.x, y: start.y });
    } else {
      // Need to route past obstacles then back
      bendPoints.push({ x: clearX, y: start.y });
      bendPoints.push({ x: clearX, y: end.y });
    }

    return bendPoints;
  }

  /**
   * Create a simple perpendicular path without obstacle avoidance
   */
  private createPerpendicularPath(
    start: Point,
    end: Point,
    sourceSide: 'top' | 'bottom' | 'left' | 'right',
    targetSide: 'top' | 'bottom' | 'left' | 'right'
  ): Point[] {
    const bendPoints: Point[] = [];

    // If start and end are aligned, no bend points needed
    if (Math.abs(start.x - end.x) < 5 || Math.abs(start.y - end.y) < 5) {
      return bendPoints;
    }

    // Create perpendicular routing based on exit and entry sides
    const isVerticalExit = sourceSide === 'top' || sourceSide === 'bottom';
    const isVerticalEntry = targetSide === 'top' || targetSide === 'bottom';

    if (isVerticalExit && isVerticalEntry) {
      // Both vertical - need horizontal middle segment
      const midY = (start.y + end.y) / 2;
      bendPoints.push({ x: start.x, y: midY });
      bendPoints.push({ x: end.x, y: midY });
    } else if (!isVerticalExit && !isVerticalEntry) {
      // Both horizontal - need vertical middle segment
      const midX = (start.x + end.x) / 2;
      bendPoints.push({ x: midX, y: start.y });
      bendPoints.push({ x: midX, y: end.y });
    } else if (isVerticalExit && !isVerticalEntry) {
      // Exit vertical, entry horizontal - L-shape
      bendPoints.push({ x: start.x, y: end.y });
    } else {
      // Exit horizontal, entry vertical - L-shape
      bendPoints.push({ x: end.x, y: start.y });
    }

    return bendPoints;
  }

  /**
   * Route downward with obstacle avoidance, maintaining perpendicular connections
   */
  private routeDownWithObstacleAvoidance(
    start: Point,
    end: Point,
    sourceSide: 'top' | 'bottom' | 'left' | 'right',
    targetSide: 'top' | 'bottom' | 'left' | 'right',
    obstacles: (Bounds & { id: string })[],
    source: Bounds,
    target: Bounds
  ): Point[] {
    const bendPoints: Point[] = [];

    // Find the leftmost X we need to route through to avoid obstacles
    let avoidX = Math.min(start.x, end.x);
    for (const obs of obstacles) {
      // If obstacle blocks the vertical path
      if (obs.y <= end.y && obs.y + obs.height >= start.y) {
        if (obs.x <= start.x && obs.x + obs.width >= start.x) {
          avoidX = Math.min(avoidX, obs.x - this.margin);
        }
        if (obs.x <= end.x && obs.x + obs.width >= end.x) {
          avoidX = Math.min(avoidX, obs.x - this.margin);
        }
      }
    }

    // Ensure we don't route through the source or target
    avoidX = Math.min(avoidX, source.x - this.margin);
    avoidX = Math.min(avoidX, target.x - this.margin);

    // Exit perpendicular from source
    if (sourceSide === 'bottom') {
      // Exit down first
      const exitY = start.y + this.margin;
      bendPoints.push({ x: start.x, y: exitY });

      if (avoidX < start.x - 5) {
        // Need to go left to avoid obstacle
        bendPoints.push({ x: avoidX, y: exitY });
        bendPoints.push({ x: avoidX, y: end.y - this.margin });
        bendPoints.push({ x: end.x, y: end.y - this.margin });
      } else if (Math.abs(start.x - end.x) > 5) {
        // Simple L-routing
        bendPoints.push({ x: end.x, y: exitY });
      }
    } else {
      // Exit from side, then go down
      const midY = (start.y + end.y) / 2;
      bendPoints.push({ x: avoidX, y: start.y });
      bendPoints.push({ x: avoidX, y: midY });
      bendPoints.push({ x: end.x, y: midY });
    }

    return bendPoints;
  }

  /**
   * Route upward with obstacle avoidance, maintaining perpendicular connections
   */
  private routeUpWithObstacleAvoidance(
    start: Point,
    end: Point,
    sourceSide: 'top' | 'bottom' | 'left' | 'right',
    targetSide: 'top' | 'bottom' | 'left' | 'right',
    obstacles: (Bounds & { id: string })[],
    source: Bounds,
    target: Bounds
  ): Point[] {
    const bendPoints: Point[] = [];

    // For upward routing (return edges), typically exit from right and route around
    let clearX = Math.max(source.x + source.width, target.x + target.width) + this.margin;
    for (const obs of obstacles) {
      clearX = Math.max(clearX, obs.x + obs.width + this.margin);
    }

    // Exit perpendicular then route
    if (sourceSide === 'right') {
      bendPoints.push({ x: clearX, y: start.y });
      bendPoints.push({ x: clearX, y: end.y });
    } else if (sourceSide === 'top') {
      const exitY = start.y - this.margin;
      bendPoints.push({ x: start.x, y: exitY });
      bendPoints.push({ x: clearX, y: exitY });
      bendPoints.push({ x: clearX, y: end.y });
    } else {
      bendPoints.push({ x: clearX, y: start.y });
      bendPoints.push({ x: clearX, y: end.y });
    }

    return bendPoints;
  }

  /**
   * Route rightward with obstacle avoidance, maintaining perpendicular connections
   */
  private routeRightWithObstacleAvoidance(
    start: Point,
    end: Point,
    sourceSide: 'top' | 'bottom' | 'left' | 'right',
    targetSide: 'top' | 'bottom' | 'left' | 'right',
    obstacles: (Bounds & { id: string })[],
    source: Bounds,
    target: Bounds
  ): Point[] {
    const bendPoints: Point[] = [];

    // Find a clear X position between source and target
    const sourceRight = source.x + source.width;
    const targetLeft = target.x;
    let routeX = sourceRight + this.margin;

    // Check if any obstacle blocks this path
    for (const obs of obstacles) {
      const obsLeft = obs.x;
      const obsRight = obs.x + obs.width;

      if (obsRight > sourceRight && obsLeft < targetLeft) {
        routeX = Math.max(routeX, obsRight + this.margin);
      }
    }

    // Ensure we don't go past the target
    routeX = Math.min(routeX, targetLeft - this.margin);

    // If there's no room, route above or below
    if (routeX <= sourceRight) {
      // Route below obstacles
      let clearY = Math.max(source.y + source.height, target.y + target.height) + this.margin;
      for (const obs of obstacles) {
        clearY = Math.max(clearY, obs.y + obs.height + this.margin);
      }

      if (sourceSide === 'right') {
        bendPoints.push({ x: start.x + this.margin, y: start.y });
        bendPoints.push({ x: start.x + this.margin, y: clearY });
        bendPoints.push({ x: end.x - this.margin, y: clearY });
        bendPoints.push({ x: end.x - this.margin, y: end.y });
      } else {
        bendPoints.push({ x: start.x, y: clearY });
        bendPoints.push({ x: end.x, y: clearY });
      }
    } else {
      // Normal routing through routeX
      bendPoints.push({ x: routeX, y: start.y });
      bendPoints.push({ x: routeX, y: end.y });
    }

    return bendPoints;
  }

  /**
   * Route leftward with obstacle avoidance, maintaining perpendicular connections
   */
  private routeLeftWithObstacleAvoidance(
    start: Point,
    end: Point,
    sourceSide: 'top' | 'bottom' | 'left' | 'right',
    targetSide: 'top' | 'bottom' | 'left' | 'right',
    obstacles: (Bounds & { id: string })[],
    source: Bounds,
    target: Bounds
  ): Point[] {
    const bendPoints: Point[] = [];

    // Find a clear X position to route through
    let clearX = Math.min(source.x, target.x) - this.margin;
    for (const obs of obstacles) {
      if (obs.x < source.x && obs.x + obs.width > target.x + target.width) {
        clearX = Math.min(clearX, obs.x - this.margin);
      }
    }

    if (sourceSide === 'left') {
      bendPoints.push({ x: clearX, y: start.y });
      bendPoints.push({ x: clearX, y: end.y });
    } else {
      // Exit perpendicular first
      const exitX = start.x - this.margin;
      bendPoints.push({ x: exitX, y: start.y });
      bendPoints.push({ x: exitX, y: end.y });
    }

    return bendPoints;
  }
}
