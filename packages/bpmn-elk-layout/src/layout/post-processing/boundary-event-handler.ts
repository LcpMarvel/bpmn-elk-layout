/**
 * Boundary Event Handler
 * Handles post-layout processing for boundary events:
 * - Repositioning boundary event targets below their attached nodes
 * - Propagating movement to downstream nodes
 * - Recalculating edge waypoints for moved nodes
 */

import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { ElkBpmnGraph } from '../../types';
import type {
  Point,
  Bounds,
  NodeWithBpmn,
  BoundaryEventInfo,
  NodeMoveInfo,
  DEBUG,
} from '../../types/internal';

// Re-export DEBUG from internal for consistent usage
export { DEBUG } from '../../types/internal';

/**
 * Handler for boundary event post-processing
 */
export class BoundaryEventHandler {
  /**
   * Collect boundary event information for post-processing
   * Returns a map of boundary event ID -> { attachedToRef, targets, boundaryIndex, totalBoundaries }
   */
  collectInfo(graph: ElkBpmnGraph): Map<string, BoundaryEventInfo> {
    const info = new Map<string, BoundaryEventInfo>();
    const edgeMap = new Map<string, string[]>(); // source -> targets

    // First pass: collect all edges by source
    const collectEdges = (node: NodeWithBpmn) => {
      if (node.edges) {
        for (const edge of node.edges) {
          const source = edge.sources?.[0];
          const target = edge.targets?.[0];
          if (!source || !target) continue;
          if (!edgeMap.has(source)) {
            edgeMap.set(source, []);
          }
          edgeMap.get(source)!.push(target);
        }
      }
      if (node.children) {
        for (const child of node.children) {
          collectEdges(child as NodeWithBpmn);
        }
      }
    };

    // Second pass: collect boundary events and their targets
    const collectBoundaryEvents = (node: NodeWithBpmn) => {
      if (node.boundaryEvents) {
        const totalBoundaries = node.boundaryEvents.length;
        node.boundaryEvents.forEach((be, index) => {
          const targets = edgeMap.get(be.id) || [];
          info.set(be.id, {
            attachedToRef: be.attachedToRef,
            targets,
            boundaryIndex: index,
            totalBoundaries,
          });
        });
      }
      if (node.children) {
        for (const child of node.children) {
          collectBoundaryEvents(child as NodeWithBpmn);
        }
      }
    };

    for (const child of graph.children ?? []) {
      collectEdges(child as NodeWithBpmn);
      collectBoundaryEvents(child as NodeWithBpmn);
    }

    return info;
  }

  /**
   * Identify nodes that need to be moved below their attached boundary event parent
   * Returns a map of node ID -> new position info
   */
  identifyNodesToMove(
    graph: ElkNode,
    boundaryEventInfo: Map<string, BoundaryEventInfo>,
    debug = false
  ): Map<string, NodeMoveInfo> {
    const movedNodes = new Map<string, NodeMoveInfo>();

    // Build a map of node IDs to their ELK nodes
    const nodeMap = new Map<string, ElkNode>();
    // Build edge map: source -> targets
    const edgeMap = new Map<string, string[]>();

    const buildMaps = (node: ElkNode) => {
      nodeMap.set(node.id, node);
      if (node.edges) {
        for (const edge of node.edges) {
          const source = edge.sources?.[0];
          const target = edge.targets?.[0];
          if (source && target) {
            if (!edgeMap.has(source)) {
              edgeMap.set(source, []);
            }
            edgeMap.get(source)!.push(target);
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          buildMaps(child);
        }
      }
    };
    buildMaps(graph);

    // Collect all boundary events with targets
    const boundaryEventsWithTargets: Array<{
      beId: string;
      info: BoundaryEventInfo;
      attachedNode: ElkNode;
      beX: number; // Calculated boundary event X position
    }> = [];

    for (const [beId, info] of boundaryEventInfo) {
      if (info.targets.length === 0) continue;
      const attachedNode = nodeMap.get(info.attachedToRef);
      if (!attachedNode || attachedNode.y === undefined || attachedNode.height === undefined) continue;

      // Calculate boundary event X position
      const attachedX = attachedNode.x ?? 0;
      const attachedWidth = attachedNode.width ?? 100;
      const spacing = attachedWidth / (info.totalBoundaries + 1);
      const beX = attachedX + spacing * (info.boundaryIndex + 1);

      boundaryEventsWithTargets.push({ beId, info, attachedNode, beX });
    }

    // Sort all boundary events by their X position (left to right)
    // This ensures boundary event branches are stacked top-to-bottom in left-to-right order
    boundaryEventsWithTargets.sort((a, b) => {
      const xDiff = a.beX - b.beX;
      if (Math.abs(xDiff) > 1) return xDiff;
      // Same X position: sort by boundaryIndex
      return a.info.boundaryIndex - b.info.boundaryIndex;
    });

    // Find the global bottom Y of all attached nodes (boundary events extend below their parent)
    let globalBottomY = 0;
    for (const be of boundaryEventsWithTargets) {
      const attachedBottom = (be.attachedNode.y ?? 0) + (be.attachedNode.height ?? 80);
      // Boundary event extends 18px below task (beHeight/2 for 36px boundary event)
      const beBottom = attachedBottom + 18;
      globalBottomY = Math.max(globalBottomY, beBottom);
    }

    // Minimum gap between boundary event bottom and target top
    const minGap = 35;
    // Base Y position for all boundary event branches - starts below the lowest boundary event
    const baseY = globalBottomY + minGap;
    // Horizontal gap required between adjacent branches
    const horizontalGap = 20;

    // Track placed branches with their bounding boxes (x range and y range)
    const placedBranches: Array<{ minX: number; maxX: number; minY: number; maxY: number }> = [];

    // Helper to calculate branch bounds (including downstream nodes)
    const calculateBranchBounds = (
      targetId: string,
      newX: number,
      _startY: number
    ): { minX: number; maxX: number; height: number } => {
      const targetNode = nodeMap.get(targetId);
      const targetWidth = targetNode?.width ?? 100;
      const targetHeight = targetNode?.height ?? 80;

      let minX = newX;
      let maxX = newX + targetWidth;
      let totalHeight = targetHeight;

      // Include downstream nodes in the bounds calculation
      const downstreamTargets = edgeMap.get(targetId) || [];
      let currentX = newX + targetWidth + 20; // Gap between target and downstream
      for (const downId of downstreamTargets) {
        const downNode = nodeMap.get(downId);
        if (downNode) {
          const downWidth = downNode.width ?? 36;
          maxX = Math.max(maxX, currentX + downWidth);
          totalHeight = Math.max(totalHeight, (downNode.height ?? 36));
          currentX += downWidth + 20;
        }
      }

      return { minX, maxX, height: totalHeight };
    };

    // Helper to check if X ranges overlap (with gap)
    const xRangesOverlap = (
      minX1: number, maxX1: number,
      minX2: number, maxX2: number
    ): boolean => {
      // Add horizontal gap to check for overlap
      return !(maxX1 + horizontalGap < minX2 || maxX2 + horizontalGap < minX1);
    };

    // Helper to find appropriate Y position for a new branch
    const findYPosition = (branchMinX: number, branchMaxX: number, _branchHeight: number): number => {
      // Start at base Y
      let candidateY = baseY;

      // Find all branches that overlap in X
      const overlappingBranches = placedBranches.filter(b =>
        xRangesOverlap(branchMinX, branchMaxX, b.minX, b.maxX)
      );

      if (overlappingBranches.length === 0) {
        // No X overlap - can use base Y
        return candidateY;
      }

      // Find the lowest Y among overlapping branches
      for (const branch of overlappingBranches) {
        const requiredY = branch.maxY + 40; // Gap between branches
        candidateY = Math.max(candidateY, requiredY);
      }

      return candidateY;
    };

    // Process all boundary events in sorted order (left to right by X position)
    for (const beEntry of boundaryEventsWithTargets) {
      const { info, beX } = beEntry;

      if (debug) {
        console.log(`[BPMN] Processing boundary event at X=${beX} for ${info.attachedToRef}`);
      }

      for (const targetId of info.targets) {
        const targetNode = nodeMap.get(targetId);
        if (!targetNode || targetNode.y === undefined) continue;

        const targetWidth = targetNode.width ?? 100;
        const targetHeight = targetNode.height ?? 80;

        // Calculate new x position: align target's center with boundary event's center
        const newX = beX - targetWidth / 2;

        // Calculate branch bounds
        const branchBounds = calculateBranchBounds(targetId, newX, baseY);

        // Find appropriate Y position based on X overlap
        const newY = findYPosition(branchBounds.minX, branchBounds.maxX, branchBounds.height);
        const offset = newY - (targetNode.y ?? 0);
        movedNodes.set(targetId, { newY, offset, newX });

        if (debug) {
          console.log(`[BPMN] Moving ${targetId}: (${targetNode.x},${targetNode.y}) -> (${newX},${newY})`);
        }

        // Also move downstream nodes by the same y offset and aligned horizontally
        this.propagateMovement(targetId, offset, nodeMap, edgeMap, movedNodes, newX);

        // Register this branch in placedBranches
        placedBranches.push({
          minX: branchBounds.minX,
          maxX: branchBounds.maxX,
          minY: newY,
          maxY: newY + branchBounds.height,
        });
      }
    }

    return movedNodes;
  }

  /**
   * Propagate movement to downstream nodes
   */
  private propagateMovement(
    sourceId: string,
    offset: number,
    nodeMap: Map<string, ElkNode>,
    edgeMap: Map<string, string[]>,
    movedNodes: Map<string, NodeMoveInfo>,
    sourceNewX?: number
  ): void {
    const sourceNode = nodeMap.get(sourceId);
    const sourceWidth = sourceNode?.width ?? 100;

    const targets = edgeMap.get(sourceId) || [];
    for (const targetId of targets) {
      // Skip if already moved
      if (movedNodes.has(targetId)) continue;

      const targetNode = nodeMap.get(targetId);
      if (!targetNode || targetNode.y === undefined) continue;

      const newY = targetNode.y + offset;

      // Position downstream node to the right of source (aligned with source's right edge)
      let newX: number | undefined;
      if (sourceNewX !== undefined) {
        // Align downstream node to be to the right of the source
        newX = sourceNewX + sourceWidth + 20;
      }

      movedNodes.set(targetId, { newY, offset, newX });

      // Recursively propagate to downstream nodes
      this.propagateMovement(targetId, offset, nodeMap, edgeMap, movedNodes, newX);
    }
  }

  /**
   * Apply node moves to the layouted graph
   */
  applyNodeMoves(
    graph: ElkNode,
    movedNodes: Map<string, NodeMoveInfo>
  ): void {
    const applyMoves = (node: ElkNode) => {
      const moveInfo = movedNodes.get(node.id);
      if (moveInfo && node.y !== undefined) {
        node.y = moveInfo.newY;
        if (moveInfo.newX !== undefined) {
          node.x = moveInfo.newX;
        }
      }
      if (node.children) {
        for (const child of node.children) {
          applyMoves(child);
        }
      }
    };
    applyMoves(graph);
  }

  /**
   * Recalculate edge waypoints for edges connected to moved nodes
   * Implements orthogonal routing with obstacle avoidance
   */
  recalculateEdgesForMovedNodes(
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
              this.recalculateEdgeWithObstacleAvoidance(
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
   * Recalculate edge waypoints with orthogonal routing that avoids obstacles
   */
  private recalculateEdgeWithObstacleAvoidance(
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

    // Find relevant obstacles
    const obstacles: Bounds[] = [];
    for (const obsId of obstacleIds) {
      const obs = nodeMap.get(obsId);
      if (obs && obs.x !== undefined && obs.y !== undefined) {
        obstacles.push({
          x: obs.x,
          y: obs.y,
          width: obs.width ?? 100,
          height: obs.height ?? 80,
        });
      }
    }

    if (debug) {
      console.log(`[BPMN] Edge ${edge.id}: (${sx},${sy}) -> (${tx},${ty}), obstacles: ${obstacles.length}`);
    }

    // Determine routing strategy based on relative positions
    const waypoints: Point[] = [];

    // Source is below target (moved node connecting to main flow)
    if (sy > ty + th) {
      // Find the rightmost edge we need to clear
      let clearX = tx + tw;
      for (const obs of obstacles) {
        const obsRight = obs.x + obs.width;
        // If obstacle is between source and target vertically
        if (obs.y < sy && obs.y + obs.height > ty) {
          clearX = Math.max(clearX, obsRight + 30);
        }
      }

      // Route: right from source -> right past obstacles -> up -> left to target
      const startX = sx + sw;
      const startY = sy + sh / 2;
      const endX = tx + tw;
      const endY = ty + th / 2;

      waypoints.push({ x: startX, y: startY }); // Exit right from source

      if (clearX > startX) {
        // Need to go further right to clear obstacles
        waypoints.push({ x: clearX, y: startY }); // Go right
        waypoints.push({ x: clearX, y: endY }); // Go up
      } else {
        // Direct vertical routing
        waypoints.push({ x: startX, y: endY });
      }

      waypoints.push({ x: endX, y: endY }); // Enter target from right
    } else if (ty > sy + sh) {
      // Target is below source - route down from source to target
      // Exit from bottom of source, enter from top of target
      const startX = sx + sw / 2;
      const startY = sy + sh;
      const endX = tx + tw / 2;
      const endY = ty;

      waypoints.push({ x: startX, y: startY }); // Exit from bottom of source

      // Check if there are obstacles between source and target
      // that would be crossed by a simple orthogonal route
      const obstaclesToAvoid: Bounds[] = [];
      for (const obs of obstacles) {
        // Skip if obstacle is the source or target itself
        if (obs.x === sx && obs.y === sy) continue;
        if (obs.x === tx && obs.y === ty) continue;

        // Check if obstacle is in the vertical path between source and target
        const obsBottom = obs.y + obs.height;
        const obsRight = obs.x + obs.width;

        // Obstacle is between source bottom and target top vertically
        if (obs.y <= endY && obsBottom >= startY) {
          // Check horizontal overlap with the path (use wider margin)
          const pathMinX = Math.min(startX, endX) - 40;
          const pathMaxX = Math.max(startX, endX) + 40;
          if (obs.x <= pathMaxX && obsRight >= pathMinX) {
            obstaclesToAvoid.push(obs);
          }
        }
      }

      if (obstaclesToAvoid.length > 0) {
        // Find the leftmost X we need to route through to avoid ALL obstacles
        // including obstacles that might be in the vertical path of the detour
        let avoidX = startX;

        // First pass: find initial avoidX based on direct obstacles
        for (const obs of obstaclesToAvoid) {
          avoidX = Math.min(avoidX, obs.x - 30);
        }

        // Second pass: check if the detour path itself crosses any obstacles
        // and adjust avoidX further left if needed
        for (const obs of obstacles) {
          // Skip source and target
          if (obs.x === sx && obs.y === sy) continue;
          if (obs.x === tx && obs.y === ty) continue;

          const obsBottom = obs.y + obs.height;
          const obsRight = obs.x + obs.width;

          // Check if obstacle is in the vertical range of the detour (startY to endY)
          if (obs.y <= endY && obsBottom >= startY) {
            // Check if obstacle blocks the current avoidX path
            if (obs.x <= avoidX + 20 && obsRight >= avoidX - 20) {
              // Need to go further left to avoid this obstacle too
              avoidX = Math.min(avoidX, obs.x - 30);
            }
          }
        }

        if (debug) {
          console.log(`[BPMN] Avoiding ${obstaclesToAvoid.length} obstacles, avoidX=${avoidX}`);
        }

        // Route: down -> left to avoid -> down -> right to target
        const midY1 = startY + 20;
        waypoints.push({ x: startX, y: midY1 });
        waypoints.push({ x: avoidX, y: midY1 });
        waypoints.push({ x: avoidX, y: endY - 20 });
        waypoints.push({ x: endX, y: endY - 20 });
      } else {
        // No obstacles - simple orthogonal route
        const midY = (startY + endY) / 2;
        waypoints.push({ x: startX, y: midY });
        waypoints.push({ x: endX, y: midY });
      }

      waypoints.push({ x: endX, y: endY }); // Enter top of target
    } else {
      // Default: simple orthogonal routing (left-to-right)
      const startX = sx + sw;
      const startY = sy + sh / 2;
      const endX = tx;
      const endY = ty + th / 2;

      waypoints.push({ x: startX, y: startY });

      // Add midpoint for orthogonal routing
      const midX = (startX + endX) / 2;
      waypoints.push({ x: midX, y: startY });
      waypoints.push({ x: midX, y: endY });

      waypoints.push({ x: endX, y: endY });
    }

    // Update edge sections
    const firstWaypoint = waypoints[0];
    const lastWaypoint = waypoints[waypoints.length - 1];
    if (waypoints.length >= 2 && firstWaypoint && lastWaypoint) {
      edge.sections = [{
        id: `${edge.id}_section_0`,
        startPoint: firstWaypoint,
        endPoint: lastWaypoint,
        bendPoints: waypoints.slice(1, -1),
      }];

      if (debug) {
        console.log(`[BPMN] Waypoints for ${edge.id}: ${JSON.stringify(waypoints)}`);
      }
    }
  }
}
