/**
 * Edge Fixer
 * Detects and fixes edges that cross through nodes.
 * Uses PathfindingRouter for obstacle-avoiding pathfinding.
 */

import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { Point, Bounds, NodeWithBpmn } from '../../types/internal';
import { segmentCrossesNode } from './geometry-utils';
import { PathfindingRouter } from './pathfinding-router';
import { isDebugEnabled } from '../../utils/debug';

/**
 * Handler for edge crossing detection and fixing
 */
export class EdgeFixer {
  private readonly margin = 15;
  private router: PathfindingRouter;

  constructor() {
    this.router = new PathfindingRouter({
      cellSize: 10,
      obstacleMargin: this.margin,
      allowDiagonal: false,
      gridPadding: 50,
    });
  }

  /**
   * Fix edges that cross through nodes
   */
  fix(graph: ElkNode): void {
    const nodesByContainer = new Map<string, Map<string, Bounds>>();

    const flowNodePatterns = [
      /^task_/, /^gateway_/, /^start_/, /^end_/,
      /^subprocess_/, /^call_/,
      /^intermediate_/, /^event_/, /^catch_/,
    ];
    const boundaryEventPattern = /^boundary_/;
    const poolPatterns = [/^pool_/, /^participant_/, /^process_/];

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
      const currentContainerId = isPool ? id : containerId;

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
        const containerNodes = nodesByContainer.get(currentContainerId) ?? new Map();

        for (const edge of node.edges) {
          if (edge.sections && edge.sections.length > 0) {
            const hasPoolRelativeCoords = (edge as ElkExtendedEdge & { _poolRelativeCoords?: boolean })._poolRelativeCoords === true;
            if (hasPoolRelativeCoords) continue;
            this.fixEdgeIfCrossing(edge, containerNodes, containerOffsetX, containerOffsetY);
          }
        }
      }

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

    if (sourceId?.startsWith('boundary_')) return;

    const waypoints: Point[] = [
      { x: containerOffsetX + section.startPoint.x, y: containerOffsetY + section.startPoint.y },
    ];
    if (section.bendPoints) {
      for (const bp of section.bendPoints) {
        waypoints.push({ x: containerOffsetX + bp.x, y: containerOffsetY + bp.y });
      }
    }
    waypoints.push({ x: containerOffsetX + section.endPoint.x, y: containerOffsetY + section.endPoint.y });

    const crossedNodes: string[] = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const p1 = waypoints[i];
      const p2 = waypoints[i + 1];
      if (!p1 || !p2) continue;

      for (const [nodeId, pos] of nodePositions) {
        if (nodeId === sourceId || nodeId === targetId) continue;
        if (segmentCrossesNode(p1, p2, pos)) {
          crossedNodes.push(nodeId);
        }
      }
    }

    const targetPos = targetId ? nodePositions.get(targetId) : undefined;
    const sourcePos = sourceId ? nodePositions.get(sourceId) : undefined;

    if (targetPos && sourcePos && waypoints.length >= 2) {
      const lastWaypoint = waypoints[waypoints.length - 1];
      const secondLastWaypoint = waypoints[waypoints.length - 2];
      const isReturnEdge = targetPos.y + targetPos.height < sourcePos.y;

      if (isReturnEdge && lastWaypoint && secondLastWaypoint) {
        if (Math.abs(secondLastWaypoint.y - lastWaypoint.y) < 5) {
          const segY = secondLastWaypoint.y;
          const segMinX = Math.min(secondLastWaypoint.x, lastWaypoint.x);
          const segMaxX = Math.max(secondLastWaypoint.x, lastWaypoint.x);

          if (segY > targetPos.y && segY < targetPos.y + targetPos.height) {
            if (segMinX < targetPos.x + targetPos.width && segMaxX > targetPos.x) {
              crossedNodes.push(targetId + ' (target)');
            }
          }
        }
      }
    }

    if (crossedNodes.length === 0) return;

    if (isDebugEnabled()) {
      console.log(`[BPMN] Edge ${edge.id} crosses nodes: ${crossedNodes.join(', ')}`);
    }

    if (!sourcePos || !targetPos) return;

    const obstacles: Bounds[] = [];
    for (const [, pos] of nodePositions) {
      obstacles.push(pos);
    }

    this.router.setObstacles(obstacles);

    const dx = (targetPos.x + targetPos.width / 2) - (sourcePos.x + sourcePos.width / 2);
    const dy = (targetPos.y + targetPos.height / 2) - (sourcePos.y + sourcePos.height / 2);

    let sourcePort: 'top' | 'bottom' | 'left' | 'right';
    let targetPort: 'top' | 'bottom' | 'left' | 'right';

    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) {
        sourcePort = 'right';
        targetPort = 'left';
      } else {
        sourcePort = 'left';
        targetPort = 'right';
      }
    } else {
      if (dy > 0) {
        sourcePort = 'bottom';
        targetPort = 'top';
      } else {
        sourcePort = 'top';
        targetPort = 'bottom';
      }
    }

    const result = this.router.routeEdge(sourcePos, targetPos, sourcePort, targetPort);
    const path = result.path;

    if (path.length < 2) return;

    const startPoint = path[0];
    const endPoint = path[path.length - 1];
    const bendPoints = path.slice(1, -1);

    section.startPoint = {
      x: startPoint.x - containerOffsetX,
      y: startPoint.y - containerOffsetY,
    };
    section.endPoint = {
      x: endPoint.x - containerOffsetX,
      y: endPoint.y - containerOffsetY,
    };
    section.bendPoints = bendPoints.length > 0
      ? bendPoints.map(bp => ({
          x: bp.x - containerOffsetX,
          y: bp.y - containerOffsetY,
        }))
      : undefined;

    if (isDebugEnabled()) {
      console.log(`[BPMN] Fixed edge ${edge.id} with ${bendPoints.length} bend points using PathfindingRouter`);
    }
  }
}
