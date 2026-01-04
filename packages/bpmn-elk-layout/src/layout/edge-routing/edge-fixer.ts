/**
 * Edge Fixer
 * Detects and fixes edges that cross through nodes.
 * This is especially important for return edges (edges going from bottom to top).
 */

import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { Point, Bounds, NodeWithBpmn } from '../../types/internal';
import { segmentCrossesNode } from './geometry-utils';

const DEBUG = process.env?.['DEBUG'] === 'true';

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

    // Flow node ID patterns (tasks, gateways, events)
    const flowNodePatterns = [
      /^task_/, /^gateway_/, /^start_/, /^end_/,
      /^boundary_/, /^subprocess_/, /^call_/,
      /^intermediate_/, /^event_/, /^catch_/,
    ];

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
      const isFlowNode = flowNodePatterns.some(pattern => pattern.test(id));
      const isPool = poolPatterns.some(pattern => pattern.test(id));

      // If this is a pool/process container, use it as the new container context
      const currentContainerId = isPool ? id : containerId;

      // For flow nodes, store their position under their container
      if (isFlowNode && node.x !== undefined && node.y !== undefined) {
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
      if (node.children) {
        const newOffsetX = offsetX + (node.x ?? 0);
        const newOffsetY = offsetY + (node.y ?? 0);
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

      const isContainer = bpmn?.type === 'lane' || bpmn?.type === 'participant' ||
                         bpmn?.type === 'collaboration' || bpmn?.type === 'process';

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

    // Calculate new bend points that avoid obstacles
    const newBendPoints = this.calculateAvoidingBendPoints(
      originalStart,
      originalEnd,
      sourcePos,
      targetPos,
      obstacles,
      isReturnEdge
    );

    // Convert bend points back to relative coordinates
    const relativeBendPoints = newBendPoints.map(bp => ({
      x: bp.x - containerOffsetX,
      y: bp.y - containerOffsetY,
    }));

    section.bendPoints = relativeBendPoints.length > 0 ? relativeBendPoints : undefined;

    if (DEBUG) {
      console.log(`[BPMN] Fixed edge ${edge.id} with ${relativeBendPoints.length} bend points`);
    }
  }

  /**
   * Calculate bend points that avoid obstacles while preserving original start/end points
   * Uses LOCAL routing - only considers obstacles actually blocking the direct path
   */
  private calculateAvoidingBendPoints(
    originalStart: Point,
    originalEnd: Point,
    source: Bounds,
    target: Bounds,
    obstacles: (Bounds & { id: string })[],
    isReturnEdge: boolean
  ): Point[] {
    const bendPoints: Point[] = [];

    // Define the bounding box of direct path from start to end
    const pathMinX = Math.min(originalStart.x, originalEnd.x) - this.margin;
    const pathMaxX = Math.max(originalStart.x, originalEnd.x) + this.margin;
    const pathMinY = Math.min(originalStart.y, originalEnd.y) - this.margin;
    const pathMaxY = Math.max(originalStart.y, originalEnd.y) + this.margin;

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
      // No obstacles blocking - use simple L-shaped routing
      if (Math.abs(originalStart.y - originalEnd.y) > 5) {
        const midX = originalStart.x + this.margin;
        bendPoints.push({ x: midX, y: originalStart.y });
        bendPoints.push({ x: midX, y: originalEnd.y });
      }
      return bendPoints;
    }

    // Determine flow direction (left-to-right or right-to-left)
    const goingRight = originalEnd.x > originalStart.x;

    if (goingRight) {
      // For left-to-right flow, route between source and target (not to the right of target)
      // Find a clear vertical path between source right edge and target left edge
      const sourceRight = source.x + source.width;
      const targetLeft = target.x;

      // Find the midpoint between source and target for the vertical segment
      let routeX = sourceRight + this.margin;

      // Check if any obstacle blocks this path and find a clear X position
      for (const obs of blockingObstacles) {
        const obsLeft = obs.x;
        const obsRight = obs.x + obs.width;

        // If obstacle is between source and target horizontally
        if (obsRight > sourceRight && obsLeft < targetLeft) {
          // Route to the right of this obstacle, but still before target
          routeX = Math.max(routeX, obsRight + this.margin);
        }
      }

      // Ensure we don't go past the target
      routeX = Math.min(routeX, targetLeft - this.margin);

      // If there's no room between source and target, fall back to routing around
      if (routeX <= sourceRight) {
        routeX = Math.max(source.x + source.width, target.x + target.width) + this.margin;
        for (const obs of blockingObstacles) {
          routeX = Math.max(routeX, obs.x + obs.width + this.margin);
        }
      }

      bendPoints.push({ x: routeX, y: originalStart.y });
      bendPoints.push({ x: routeX, y: originalEnd.y });
    } else {
      // For right-to-left flow (return edges), route to the right of all obstacles
      let clearX = Math.max(source.x + source.width, target.x + target.width) + this.margin;
      for (const obs of blockingObstacles) {
        clearX = Math.max(clearX, obs.x + obs.width + this.margin);
      }

      if (isReturnEdge) {
        // Return edge: source is below target (need to route upward)
        bendPoints.push({ x: clearX, y: originalStart.y });
        bendPoints.push({ x: clearX, y: originalEnd.y });
      } else {
        // Normal edge going left
        bendPoints.push({ x: clearX, y: originalStart.y });
        bendPoints.push({ x: clearX, y: originalEnd.y });
      }
    }

    return bendPoints;
  }
}
