/**
 * Artifact Positioner
 * Handles repositioning of BPMN artifacts (data objects, data stores, annotations)
 * to be positioned above/near their associated tasks.
 */

import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { ElkBpmnGraph } from '../../types';
import type { Point, Bounds, NodeWithBpmn, ArtifactInfo, Obstacle } from '../../types/internal';
import {
  segmentIntersectsRect,
  scoreRoute,
  findClearVerticalPath,
} from '../edge-routing/geometry-utils';
import { ARTIFACT_TYPES_SET } from '../../types/bpmn-constants';
import { buildNodeMap } from '../../utils/node-map-builder';

/**
 * Artifact types that should be repositioned above their associated tasks
 * @deprecated Use ARTIFACT_TYPES_SET from bpmn-constants instead
 */
export const ARTIFACT_TYPES = ARTIFACT_TYPES_SET;

/**
 * Handler for artifact repositioning
 */
export class ArtifactPositioner {
  /**
   * Collect artifact information for post-processing
   * Returns a map of artifact ID -> { associatedTaskId, isInput }
   */
  collectInfo(graph: ElkBpmnGraph): Map<string, ArtifactInfo> {
    const info = new Map<string, ArtifactInfo>();

    const collectFromNode = (node: NodeWithBpmn) => {
      // Build a set of artifact IDs in this node
      const artifactIds = new Set<string>();
      if (node.children) {
        for (const child of node.children) {
          const childNode = child as NodeWithBpmn;
          if (childNode.bpmn && ARTIFACT_TYPES.has(childNode.bpmn.type)) {
            artifactIds.add(childNode.id);
          }
        }
      }

      // Find associations between artifacts and tasks from edges
      if (node.edges) {
        for (const edge of node.edges) {
          const sourceId = edge.sources?.[0];
          const targetId = edge.targets?.[0];
          const edgeType = edge.bpmn?.type;

          if (!sourceId || !targetId) continue;

          // Skip artifact-to-artifact associations (e.g., between two dataStores)
          // These should not be used for positioning
          if (artifactIds.has(sourceId) && artifactIds.has(targetId)) {
            continue;
          }

          // Data input association: artifact -> task
          if (edgeType === 'dataInputAssociation' || edgeType === 'association') {
            if (artifactIds.has(sourceId)) {
              info.set(sourceId, { associatedTaskId: targetId, isInput: true });
            }
          }
          // Data output association: task -> artifact
          if (edgeType === 'dataOutputAssociation') {
            if (artifactIds.has(targetId)) {
              info.set(targetId, { associatedTaskId: sourceId, isInput: false });
            }
          }
        }
      }

      // Recurse into children
      if (node.children) {
        for (const child of node.children) {
          collectFromNode(child as NodeWithBpmn);
        }
      }
    };

    for (const child of graph.children ?? []) {
      collectFromNode(child as NodeWithBpmn);
    }

    return info;
  }

  /**
   * Reposition artifacts to be above their associated tasks
   */
  reposition(graph: ElkNode, artifactInfo: Map<string, ArtifactInfo>): void {
    // Build node map
    const nodeMap = buildNodeMap(graph);

    // Track horizontal offset for each task (for multiple artifacts)
    const taskInputOffsets = new Map<string, number>();
    const taskOutputOffsets = new Map<string, number>();

    // Reposition each artifact
    for (const [artifactId, info] of artifactInfo) {
      const artifactNode = nodeMap.get(artifactId);
      const taskNode = nodeMap.get(info.associatedTaskId);

      if (!artifactNode || !taskNode) continue;
      if (taskNode.x === undefined || taskNode.y === undefined) continue;

      const artifactWidth = artifactNode.width ?? 36;
      const artifactHeight = artifactNode.height ?? 50;
      const taskWidth = taskNode.width ?? 100;

      // Position artifact above the task
      // Input artifacts on the left, output artifacts on the right
      let newX: number;
      if (info.isInput) {
        const currentOffset = taskInputOffsets.get(info.associatedTaskId) ?? 0;
        newX = taskNode.x + currentOffset;
        taskInputOffsets.set(info.associatedTaskId, currentOffset + artifactWidth + 15);
      } else {
        const currentOffset = taskOutputOffsets.get(info.associatedTaskId) ?? 0;
        newX = taskNode.x + taskWidth + 15 + currentOffset; // Position to the right of task
        taskOutputOffsets.set(info.associatedTaskId, currentOffset + artifactWidth + 15);
      }
      const newY = taskNode.y - artifactHeight - 20; // 20px gap above task

      artifactNode.x = newX;
      artifactNode.y = newY;
    }

    // Recalculate edges for repositioned artifacts
    this.recalculateEdges(graph, artifactInfo, nodeMap);
  }

  /**
   * Recalculate edges connected to repositioned artifacts
   */
  private recalculateEdges(
    graph: ElkNode,
    artifactInfo: Map<string, ArtifactInfo>,
    nodeMap: Map<string, ElkNode>
  ): void {
    const processEdges = (node: ElkNode) => {
      if (node.edges) {
        for (const edge of node.edges) {
          const sourceId = edge.sources?.[0];
          const targetId = edge.targets?.[0];

          if (!sourceId || !targetId) continue;

          // Check if this edge involves an artifact
          const sourceIsArtifact = artifactInfo.has(sourceId);
          const targetIsArtifact = artifactInfo.has(targetId);

          if (sourceIsArtifact || targetIsArtifact) {
            const sourceNode = nodeMap.get(sourceId);
            const targetNode = nodeMap.get(targetId);

            if (sourceNode && targetNode) {
              this.recalculateArtifactEdge(edge, sourceNode, targetNode, sourceIsArtifact);
            }
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          processEdges(child);
        }
      }
    };
    processEdges(graph);
  }

  /**
   * Recalculate a single artifact edge (simple version)
   */
  private recalculateArtifactEdge(
    edge: ElkExtendedEdge,
    source: ElkNode,
    target: ElkNode,
    sourceIsArtifact: boolean
  ): void {
    const sx = source.x ?? 0;
    const sy = source.y ?? 0;
    const sw = source.width ?? 36;
    const sh = source.height ?? 50;

    const tx = target.x ?? 0;
    const ty = target.y ?? 0;
    const tw = target.width ?? 100;
    const th = target.height ?? 80;

    let startPoint: Point;
    let endPoint: Point;

    if (sourceIsArtifact) {
      // Artifact -> Task (input): artifact is above/left of task
      // Start from bottom of artifact, end at top of task
      startPoint = { x: sx + sw / 2, y: sy + sh };
      endPoint = { x: Math.min(Math.max(sx + sw / 2, tx), tx + tw), y: ty };
    } else {
      // Task -> Artifact (output): artifact is above/right of task
      // Start from top-right of task, end at bottom of artifact
      const artifactCenterX = tx + tw / 2;
      startPoint = { x: Math.min(sx + sw, artifactCenterX), y: sy };
      endPoint = { x: artifactCenterX, y: ty + th };
    }

    edge.sections = [{
      id: `${edge.id}_section_0`,
      startPoint,
      endPoint,
      bendPoints: [],
    }];
  }

  /**
   * Recalculate artifact edges with obstacle avoidance
   * Implements orthogonal routing that avoids crossing other elements
   */
  recalculateWithObstacleAvoidance(
    graph: ElkNode,
    artifactInfo: Map<string, ArtifactInfo>
  ): void {
    // Build node map for position lookups
    const nodeMap = buildNodeMap(graph);

    // Collect all obstacles (non-artifact nodes)
    const obstacles: Obstacle[] = [];
    const collectObstacles = (node: ElkNode) => {
      if (node.x !== undefined && node.y !== undefined && !artifactInfo.has(node.id)) {
        // Skip groups (they're just visual overlays)
        const isGroup = node.id.includes('group');
        if (!isGroup) {
          obstacles.push({
            id: node.id,
            x: node.x,
            y: node.y,
            width: node.width ?? 100,
            height: node.height ?? 80,
          });
        }
      }
      if (node.children) {
        for (const child of node.children) {
          collectObstacles(child);
        }
      }
    };
    collectObstacles(graph);

    // Process edges
    const processEdges = (node: ElkNode) => {
      if (node.edges) {
        for (const edge of node.edges) {
          const sourceId = edge.sources?.[0];
          const targetId = edge.targets?.[0];

          if (!sourceId || !targetId) continue;

          // Check if this edge involves an artifact
          const sourceIsArtifact = artifactInfo.has(sourceId);
          const targetIsArtifact = artifactInfo.has(targetId);

          if (sourceIsArtifact || targetIsArtifact) {
            const sourceNode = nodeMap.get(sourceId);
            const targetNode = nodeMap.get(targetId);

            if (sourceNode && targetNode) {
              this.recalculateEdgeWithObstacles(
                edge,
                sourceNode,
                targetNode,
                sourceIsArtifact,
                obstacles.filter(o => o.id !== sourceId && o.id !== targetId)
              );
            }
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          processEdges(child);
        }
      }
    };
    processEdges(graph);
  }

  /**
   * Recalculate a single artifact edge with orthogonal routing and obstacle avoidance
   */
  private recalculateEdgeWithObstacles(
    edge: ElkExtendedEdge,
    source: ElkNode,
    target: ElkNode,
    sourceIsArtifact: boolean,
    obstacles: Obstacle[]
  ): void {
    const sx = source.x ?? 0;
    const sy = source.y ?? 0;
    const sw = source.width ?? 36;
    const sh = source.height ?? 50;

    const tx = target.x ?? 0;
    const ty = target.y ?? 0;
    const tw = target.width ?? 100;
    const th = target.height ?? 80;

    // Determine connection points based on relative positions
    let startPoint: Point;
    let endPoint: Point;
    const bendPoints: Point[] = [];

    const sourceCenterX = sx + sw / 2;
    const sourceCenterY = sy + sh / 2;
    const targetCenterX = tx + tw / 2;
    const targetCenterY = ty + th / 2;

    // Determine if we're going up, down, left, or right
    const goingRight = targetCenterX > sourceCenterX + sw / 2;
    const goingLeft = targetCenterX < sourceCenterX - sw / 2;
    const goingDown = targetCenterY > sourceCenterY + sh / 2;
    const goingUp = targetCenterY < sourceCenterY - sh / 2;

    if (sourceIsArtifact) {
      // Artifact is source (data input association: artifact -> task)
      if (goingDown) {
        // Source above target: exit from bottom, enter from top
        startPoint = { x: sourceCenterX, y: sy + sh };
        endPoint = { x: targetCenterX, y: ty };

        // Check for obstacles and route around them
        const routeY = findClearVerticalPath(startPoint.x, startPoint.y, endPoint.y, obstacles);
        if (Math.abs(startPoint.x - endPoint.x) > 5 || routeY !== null) {
          if (routeY !== null && routeY !== startPoint.y && routeY !== endPoint.y) {
            bendPoints.push({ x: startPoint.x, y: routeY });
            bendPoints.push({ x: endPoint.x, y: routeY });
          } else {
            // Simple L-shaped routing
            const midY = (startPoint.y + endPoint.y) / 2;
            bendPoints.push({ x: startPoint.x, y: midY });
            bendPoints.push({ x: endPoint.x, y: midY });
          }
        }
      } else if (goingUp) {
        // Source below target: exit from top, enter from bottom
        startPoint = { x: sourceCenterX, y: sy };
        endPoint = { x: targetCenterX, y: ty + th };

        const midY = (startPoint.y + endPoint.y) / 2;
        if (Math.abs(startPoint.x - endPoint.x) > 5) {
          bendPoints.push({ x: startPoint.x, y: midY });
          bendPoints.push({ x: endPoint.x, y: midY });
        }
      } else if (goingRight) {
        // Source left of target: exit from right, enter from left
        startPoint = { x: sx + sw, y: sourceCenterY };
        endPoint = { x: tx, y: targetCenterY };

        // Route with obstacle avoidance
        this.addOrthogonalBendPoints(startPoint, endPoint, bendPoints, obstacles);
      } else {
        // Source right of target: exit from left, enter from right
        startPoint = { x: sx, y: sourceCenterY };
        endPoint = { x: tx + tw, y: targetCenterY };

        this.addOrthogonalBendPoints(startPoint, endPoint, bendPoints, obstacles);
      }
    } else {
      // Task is source (data output association: task -> artifact)
      if (goingUp) {
        // Target above source: exit from top, enter from bottom
        startPoint = { x: sourceCenterX, y: sy };
        endPoint = { x: targetCenterX, y: ty + th };

        const midY = (startPoint.y + endPoint.y) / 2;
        if (Math.abs(startPoint.x - endPoint.x) > 5) {
          bendPoints.push({ x: startPoint.x, y: midY });
          bendPoints.push({ x: endPoint.x, y: midY });
        }
      } else if (goingDown) {
        // Target below source: exit from bottom, enter from top
        startPoint = { x: sourceCenterX, y: sy + sh };
        endPoint = { x: targetCenterX, y: ty };

        const midY = (startPoint.y + endPoint.y) / 2;
        if (Math.abs(startPoint.x - endPoint.x) > 5) {
          bendPoints.push({ x: startPoint.x, y: midY });
          bendPoints.push({ x: endPoint.x, y: midY });
        }
      } else if (goingRight) {
        // Target right of source: exit from right, enter from left
        startPoint = { x: sx + sw, y: sourceCenterY };
        endPoint = { x: tx, y: targetCenterY };

        this.addOrthogonalBendPoints(startPoint, endPoint, bendPoints, obstacles);
      } else {
        // Target left of source: exit from left, enter from right
        startPoint = { x: sx, y: sourceCenterY };
        endPoint = { x: tx + tw, y: targetCenterY };

        this.addOrthogonalBendPoints(startPoint, endPoint, bendPoints, obstacles);
      }
    }

    edge.sections = [{
      id: `${edge.id}_section_0`,
      startPoint,
      endPoint,
      bendPoints: bendPoints.length > 0 ? bendPoints : undefined,
    }];
  }

  /**
   * Add orthogonal bend points with obstacle avoidance
   */
  private addOrthogonalBendPoints(
    start: Point,
    end: Point,
    bendPoints: Point[],
    obstacles: Bounds[]
  ): void {
    const margin = 15;

    // Check if direct path (with one bend) crosses any obstacle
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;

    // Try different routing strategies
    const strategies: Array<{ points: Point[]; score: number }> = [];

    // Strategy 1: Horizontal first, then vertical
    const s1: Point[] = [
      { x: midX, y: start.y },
      { x: midX, y: end.y },
    ];
    strategies.push({ points: s1, score: scoreRoute(start, s1, end, obstacles) });

    // Strategy 2: Vertical first, then horizontal
    const s2: Point[] = [
      { x: start.x, y: midY },
      { x: end.x, y: midY },
    ];
    strategies.push({ points: s2, score: scoreRoute(start, s2, end, obstacles) });

    // Strategy 3: Route above obstacles
    const maxObstacleTop = Math.min(...obstacles.map(o => o.y), start.y, end.y);
    const routeAboveY = maxObstacleTop - margin;
    const s3: Point[] = [
      { x: start.x, y: routeAboveY },
      { x: end.x, y: routeAboveY },
    ];
    strategies.push({ points: s3, score: scoreRoute(start, s3, end, obstacles) });

    // Strategy 4: Route below obstacles
    const maxObstacleBottom = Math.max(...obstacles.map(o => o.y + o.height), start.y, end.y);
    const routeBelowY = maxObstacleBottom + margin;
    const s4: Point[] = [
      { x: start.x, y: routeBelowY },
      { x: end.x, y: routeBelowY },
    ];
    strategies.push({ points: s4, score: scoreRoute(start, s4, end, obstacles) });

    // Strategy 5: Route to the right of obstacles
    const maxObstacleRight = Math.max(...obstacles.map(o => o.x + o.width), start.x, end.x);
    const routeRightX = maxObstacleRight + margin;
    const s5: Point[] = [
      { x: routeRightX, y: start.y },
      { x: routeRightX, y: end.y },
    ];
    strategies.push({ points: s5, score: scoreRoute(start, s5, end, obstacles) });

    // Choose the best strategy (lowest score = fewer crossings + shorter path)
    strategies.sort((a, b) => a.score - b.score);
    const best = strategies[0];

    // Only add bend points if they're significantly different from start/end
    for (const bp of best.points) {
      if (Math.abs(bp.x - start.x) > 5 || Math.abs(bp.y - start.y) > 5) {
        if (Math.abs(bp.x - end.x) > 5 || Math.abs(bp.y - end.y) > 5) {
          bendPoints.push(bp);
        }
      }
    }
  }
}
