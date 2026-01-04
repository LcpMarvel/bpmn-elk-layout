/**
 * Edge Recalculator for Boundary Events
 * Handles edge waypoint recalculation for moved boundary event nodes.
 */

import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { Point, Bounds, BoundaryEventInfo, NodeMoveInfo } from '../../../types/internal';

/**
 * Recalculate edge waypoints for edges connected to moved nodes
 * Implements orthogonal routing with obstacle avoidance
 */
export function recalculateEdgesForMovedNodes(
  graph: ElkNode,
  movedNodes: Map<string, NodeMoveInfo>,
  boundaryEventInfo: Map<string, BoundaryEventInfo>,
  debug = false
): void {
  // Build node map for position lookups (including boundary events)
  const nodeMap = new Map<string, ElkNode>();
  const buildNodeMap = (node: ElkNode) => {
    nodeMap.set(node.id, node);
    if (node.children) {
      for (const child of node.children) {
        buildNodeMap(child);
      }
    }
    // Also include boundary events
    const nodeWithBE = node as unknown as { boundaryEvents?: ElkNode[] };
    if (nodeWithBE.boundaryEvents) {
      for (const be of nodeWithBE.boundaryEvents) {
        nodeMap.set(be.id, be);
      }
    }
  };
  buildNodeMap(graph);

  // Get all obstacle IDs: attached nodes + all moved nodes
  const obstacleIds = new Set<string>();
  for (const [, info] of boundaryEventInfo) {
    obstacleIds.add(info.attachedToRef);
  }
  // Add all moved nodes as obstacles (they may block edge paths)
  for (const [nodeId] of movedNodes) {
    obstacleIds.add(nodeId);
  }

  // Calculate correct boundary event positions (they are attached to the bottom of their parent)
  const boundaryEventPositions = new Map<string, Bounds>();
  for (const [beId, info] of boundaryEventInfo) {
    const attachedNode = nodeMap.get(info.attachedToRef);
    if (attachedNode && attachedNode.x !== undefined && attachedNode.y !== undefined) {
      const attachedX = attachedNode.x;
      const attachedY = attachedNode.y;
      const attachedWidth = attachedNode.width ?? 100;
      const attachedHeight = attachedNode.height ?? 80;
      const beWidth = 36;
      const beHeight = 36;

      // Calculate position on the bottom edge of the attached node
      const spacing = attachedWidth / (info.totalBoundaries + 1);
      const beX = attachedX + spacing * (info.boundaryIndex + 1) - beWidth / 2;
      const beY = attachedY + attachedHeight - beHeight / 2;

      boundaryEventPositions.set(beId, { x: beX, y: beY, width: beWidth, height: beHeight });
    }
  }

  // Find and recalculate edges in each node
  const processEdges = (node: ElkNode) => {
    if (node.edges) {
      for (const edge of node.edges) {
        const sourceId = edge.sources?.[0];
        const targetId = edge.targets?.[0];

        if (!sourceId || !targetId) continue;

        // Recalculate if source OR target was moved, OR source is a boundary event
        const sourceMoved = movedNodes.has(sourceId);
        const targetMoved = movedNodes.has(targetId);
        const sourceIsBoundaryEvent = boundaryEventInfo.has(sourceId);

        if (sourceMoved || targetMoved || sourceIsBoundaryEvent) {
          let sourceNode = nodeMap.get(sourceId);
          const targetNode = nodeMap.get(targetId);

          // For boundary events, use the calculated position
          if (sourceIsBoundaryEvent && boundaryEventPositions.has(sourceId)) {
            const bePos = boundaryEventPositions.get(sourceId)!;
            sourceNode = { ...sourceNode, ...bePos } as ElkNode;
          }

          if (sourceNode && targetNode) {
            recalculateEdgeWithObstacleAvoidance(
              edge,
              sourceNode,
              targetNode,
              obstacleIds,
              nodeMap,
              debug
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
 * Recalculate edge waypoints with orthogonal routing that avoids obstacles.
 * Key constraints:
 * 1. Edges MUST connect perpendicular to node boundaries
 * 2. Edges MUST NOT pass through any node
 */
export function recalculateEdgeWithObstacleAvoidance(
  edge: ElkExtendedEdge,
  source: ElkNode,
  target: ElkNode,
  obstacleIds: Set<string>,
  nodeMap: Map<string, ElkNode>,
  debug = false
): void {
  const sx = source.x ?? 0;
  const sy = source.y ?? 0;
  const sw = source.width ?? 100;
  const sh = source.height ?? 80;

  const tx = target.x ?? 0;
  const ty = target.y ?? 0;
  const tw = target.width ?? 36;
  const th = target.height ?? 36;

  // Collect all obstacles (excluding source and target)
  const obstacles: Bounds[] = [];
  for (const obsId of obstacleIds) {
    const obs = nodeMap.get(obsId);
    if (obs && obs.x !== undefined && obs.y !== undefined) {
      // Skip source and target
      if (obs.x === sx && obs.y === sy) continue;
      if (obs.x === tx && obs.y === ty) continue;
      obstacles.push({
        x: obs.x,
        y: obs.y,
        width: obs.width ?? 100,
        height: obs.height ?? 80,
      });
    }
  }

  if (debug) {
    console.log(
      `[BPMN] Edge ${edge.id}: source(${sx},${sy},${sw},${sh}) -> target(${tx},${ty},${tw},${th}), obstacles: ${obstacles.length}`
    );
  }

  // Determine primary direction of travel
  const dx = tx - sx;
  const dy = ty - sy;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const isPrimarilyVertical = absDy > absDx;

  const waypoints: Point[] = [];

  if (isPrimarilyVertical && dy > 0) {
    // Primary direction is DOWN - exit from bottom, enter from top
    const startX = sx + sw / 2;
    const startY = sy + sh;
    const endX = tx + tw / 2;
    const endY = ty;

    waypoints.push({ x: startX, y: startY });

    // Check for obstacles that would block a direct vertical path
    const obstaclesToAvoid = findBlockingObstacles(
      startX,
      startY,
      endX,
      endY,
      obstacles,
      'vertical'
    );

    if (obstaclesToAvoid.length > 0) {
      // Calculate left routing X
      let leftAvoidX = Math.min(startX, endX);
      for (const obs of obstaclesToAvoid) {
        leftAvoidX = Math.min(leftAvoidX, obs.x - 30);
      }
      for (const obs of obstacles) {
        if (obs.y < endY && obs.y + obs.height > startY) {
          if (obs.x <= leftAvoidX + 20 && obs.x + obs.width >= leftAvoidX - 20) {
            leftAvoidX = Math.min(leftAvoidX, obs.x - 30);
          }
        }
      }

      // Calculate right routing X
      let rightAvoidX = Math.max(startX, endX);
      for (const obs of obstaclesToAvoid) {
        rightAvoidX = Math.max(rightAvoidX, obs.x + obs.width + 30);
      }
      for (const obs of obstacles) {
        if (obs.y < endY && obs.y + obs.height > startY) {
          if (obs.x <= rightAvoidX + 20 && obs.x + obs.width >= rightAvoidX - 20) {
            rightAvoidX = Math.max(rightAvoidX, obs.x + obs.width + 30);
          }
        }
      }

      // Choose the shorter detour
      const leftDistance = Math.abs(startX - leftAvoidX) + Math.abs(endX - leftAvoidX);
      const rightDistance = Math.abs(startX - rightAvoidX) + Math.abs(endX - rightAvoidX);
      const avoidX = leftDistance <= rightDistance ? leftAvoidX : rightAvoidX;

      const exitY = startY + 20;
      waypoints.push({ x: startX, y: exitY });
      waypoints.push({ x: avoidX, y: exitY });
      waypoints.push({ x: avoidX, y: endY - 20 });
      waypoints.push({ x: endX, y: endY - 20 });
    } else {
      // No obstacles - simple Z-routing
      const midY = (startY + endY) / 2;
      waypoints.push({ x: startX, y: midY });
      waypoints.push({ x: endX, y: midY });
    }

    waypoints.push({ x: endX, y: endY });
  } else if (isPrimarilyVertical && dy < 0) {
    // Primary direction is UP - exit from right, enter from bottom
    const startX = sx + sw;
    const startY = sy + sh / 2;
    const endX = tx + tw / 2;
    const endY = ty + th;

    waypoints.push({ x: startX, y: startY });

    let clearX = Math.max(sx + sw, tx + tw) + 30;
    for (const obs of obstacles) {
      if (obs.y < sy && obs.y + obs.height > ty) {
        clearX = Math.max(clearX, obs.x + obs.width + 30);
      }
    }

    waypoints.push({ x: clearX, y: startY });
    waypoints.push({ x: clearX, y: endY });
    waypoints.push({ x: endX, y: endY });
  } else if (!isPrimarilyVertical && dx > 0) {
    // Primary direction is RIGHT - exit from right, enter from left
    const startX = sx + sw;
    const startY = sy + sh / 2;
    const endX = tx;
    const endY = ty + th / 2;

    waypoints.push({ x: startX, y: startY });

    const obstaclesToAvoid = findBlockingObstacles(
      startX,
      startY,
      endX,
      endY,
      obstacles,
      'horizontal'
    );

    if (obstaclesToAvoid.length > 0) {
      let clearY = Math.max(sy + sh, ty + th) + 30;
      for (const obs of obstaclesToAvoid) {
        clearY = Math.max(clearY, obs.y + obs.height + 30);
      }

      waypoints.push({ x: startX + 20, y: startY });
      waypoints.push({ x: startX + 20, y: clearY });
      waypoints.push({ x: endX - 20, y: clearY });
      waypoints.push({ x: endX - 20, y: endY });
    } else {
      // Simple Z-routing
      const midX = (startX + endX) / 2;
      waypoints.push({ x: midX, y: startY });
      waypoints.push({ x: midX, y: endY });
    }

    waypoints.push({ x: endX, y: endY });
  } else {
    // Primary direction is LEFT - exit from left, enter from right
    const startX = sx;
    const startY = sy + sh / 2;
    const endX = tx + tw;
    const endY = ty + th / 2;

    waypoints.push({ x: startX, y: startY });

    let clearX = Math.min(sx, tx) - 30;
    for (const obs of obstacles) {
      clearX = Math.min(clearX, obs.x - 30);
    }

    waypoints.push({ x: clearX, y: startY });
    waypoints.push({ x: clearX, y: endY });
    waypoints.push({ x: endX, y: endY });
  }

  // Update edge sections
  const firstWaypoint = waypoints[0];
  const lastWaypoint = waypoints[waypoints.length - 1];
  if (waypoints.length >= 2 && firstWaypoint && lastWaypoint) {
    edge.sections = [
      {
        id: `${edge.id}_section_0`,
        startPoint: firstWaypoint,
        endPoint: lastWaypoint,
        bendPoints: waypoints.slice(1, -1),
      },
    ];

    if (debug) {
      console.log(`[BPMN] Waypoints for ${edge.id}: ${JSON.stringify(waypoints)}`);
    }
  }
}

/**
 * Find obstacles that block a path between two points
 */
export function findBlockingObstacles(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  obstacles: Bounds[],
  direction: 'vertical' | 'horizontal'
): Bounds[] {
  const blocking: Bounds[] = [];
  const margin = 5;

  for (const obs of obstacles) {
    const obsRight = obs.x + obs.width;
    const obsBottom = obs.y + obs.height;

    if (direction === 'vertical') {
      const pathMinX = Math.min(startX, endX) - margin;
      const pathMaxX = Math.max(startX, endX) + margin;
      const pathMinY = Math.min(startY, endY);
      const pathMaxY = Math.max(startY, endY);

      if (obs.y < pathMaxY && obsBottom > pathMinY) {
        if (obs.x < pathMaxX && obsRight > pathMinX) {
          blocking.push(obs);
        }
      }
    } else {
      const pathMinX = Math.min(startX, endX);
      const pathMaxX = Math.max(startX, endX);
      const pathMinY = Math.min(startY, endY) - margin;
      const pathMaxY = Math.max(startY, endY) + margin;

      if (obs.x < pathMaxX && obsRight > pathMinX) {
        if (obs.y < pathMaxY && obsBottom > pathMinY) {
          blocking.push(obs);
        }
      }
    }
  }

  return blocking;
}
