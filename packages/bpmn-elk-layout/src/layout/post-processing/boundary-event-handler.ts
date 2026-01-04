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
   * @param graph - The ELK layouted graph
   * @param boundaryEventInfo - Boundary event metadata
   * @param sizedGraph - The original graph with BPMN type information
   * @param debug - Enable debug logging
   */
  identifyNodesToMove(
    graph: ElkNode,
    boundaryEventInfo: Map<string, BoundaryEventInfo>,
    sizedGraph: ElkBpmnGraph,
    debug = false
  ): Map<string, NodeMoveInfo> {
    const movedNodes = new Map<string, NodeMoveInfo>();

    // Build a map of node IDs to their ELK nodes
    const nodeMap = new Map<string, ElkNode>();
    // Build a map of node IDs to their BPMN type (from original sizedGraph)
    const nodeTypeMap = new Map<string, string>();
    // Build edge map: source -> targets
    const edgeMap = new Map<string, string[]>();
    // Build reverse edge map: target -> sources (to detect merge points)
    const reverseEdgeMap = new Map<string, string[]>();

    // Helper to collect node types from sizedGraph
    const collectNodeTypes = (node: NodeWithBpmn) => {
      if (node.bpmn?.type) {
        nodeTypeMap.set(node.id, node.bpmn.type);
      }
      if (node.children) {
        for (const child of node.children) {
          collectNodeTypes(child as NodeWithBpmn);
        }
      }
      if (node.boundaryEvents) {
        for (const be of node.boundaryEvents) {
          if ((be as NodeWithBpmn).bpmn?.type) {
            nodeTypeMap.set(be.id, (be as NodeWithBpmn).bpmn!.type!);
          }
        }
      }
    };

    // Collect node types from sizedGraph
    for (const child of sizedGraph.children ?? []) {
      collectNodeTypes(child as NodeWithBpmn);
    }

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

            // Build reverse map
            if (!reverseEdgeMap.has(target)) {
              reverseEdgeMap.set(target, []);
            }
            reverseEdgeMap.get(target)!.push(source);
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

    // Collect all boundary event target IDs (direct targets of boundary events)
    const boundaryEventTargetIds = new Set<string>();
    for (const [_beId, info] of boundaryEventInfo) {
      for (const targetId of info.targets) {
        boundaryEventTargetIds.add(targetId);
      }
    }

    // Helper to check if a node is a merge point (has incoming edges from non-boundary-event sources)
    const isMergePoint = (nodeId: string): boolean => {
      const incomingSources = reverseEdgeMap.get(nodeId) || [];
      // A merge point has multiple incoming edges, at least one from a non-boundary-event-branch source
      if (incomingSources.length <= 1) return false;

      // Check if any incoming source is NOT a boundary event target or its downstream
      for (const sourceId of incomingSources) {
        // If source is not in boundaryEventTargetIds and not already marked as moved,
        // this node is connected to the main flow
        if (!boundaryEventTargetIds.has(sourceId) && !movedNodes.has(sourceId)) {
          if (debug) {
            console.log(`[BPMN] isMergePoint(${nodeId}): true - source ${sourceId} is from main flow`);
          }
          return true;
        }
      }
      if (debug) {
        console.log(`[BPMN] isMergePoint(${nodeId}): false - all ${incomingSources.length} sources are boundary event branches`);
      }
      return false;
    };

    // Branch destination type enum for prioritization
    enum BranchDestType {
      MERGE_TO_MAIN = 1,    // Branches that merge back to main flow (highest priority - closest to main flow)
      TO_END_EVENT = 2,     // Branches that end at end events (medium priority)
      DEAD_END = 3,         // Branches with no outgoing edges (lowest priority - furthest from main flow)
    }

    // Helper to trace a branch and determine its destination type
    const getBranchDestinationType = (startNodeId: string): BranchDestType => {
      const visited = new Set<string>();
      const queue = [startNodeId];

      while (queue.length > 0) {
        const nodeId = queue.shift()!;
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const node = nodeMap.get(nodeId);
        if (!node) continue;

        // Check if this is a merge point (connects back to main flow)
        if (isMergePoint(nodeId)) {
          return BranchDestType.MERGE_TO_MAIN;
        }

        const outgoingTargets = edgeMap.get(nodeId) || [];

        // If no outgoing edges, check if it's an end event
        if (outgoingTargets.length === 0) {
          // It's an end event or dead end - use nodeTypeMap from sizedGraph
          const nodeType = nodeTypeMap.get(nodeId);
          if (nodeType === 'endEvent') {
            return BranchDestType.TO_END_EVENT;
          }
          return BranchDestType.DEAD_END;
        }

        // Continue tracing downstream
        for (const targetId of outgoingTargets) {
          if (!visited.has(targetId)) {
            // Check if the target is a merge point before adding
            if (isMergePoint(targetId)) {
              return BranchDestType.MERGE_TO_MAIN;
            }
            queue.push(targetId);
          }
        }
      }

      return BranchDestType.DEAD_END;
    };

    // Collect all boundary events with targets
    const boundaryEventsWithTargets: Array<{
      beId: string;
      info: BoundaryEventInfo;
      attachedNode: ElkNode;
      beX: number; // Calculated boundary event X position
      attachedRight: number; // Right edge of the attached node (for MERGE_TO_MAIN positioning)
      destType: BranchDestType; // Destination type for Y position prioritization
    }> = [];

    for (const [beId, info] of boundaryEventInfo) {
      if (info.targets.length === 0) continue;
      const attachedNode = nodeMap.get(info.attachedToRef);
      if (!attachedNode || attachedNode.y === undefined || attachedNode.height === undefined) continue;

      // Calculate boundary event X position
      const attachedX = attachedNode.x ?? 0;
      const attachedWidth = attachedNode.width ?? 100;
      const attachedRight = attachedX + attachedWidth;
      const spacing = attachedWidth / (info.totalBoundaries + 1);
      const beX = attachedX + spacing * (info.boundaryIndex + 1);

      // Determine destination type for the first target
      const destType = info.targets.length > 0
        ? getBranchDestinationType(info.targets[0])
        : BranchDestType.DEAD_END;

      boundaryEventsWithTargets.push({ beId, info, attachedNode, beX, attachedRight, destType });

      if (debug) {
        console.log(`[BPMN] Branch ${beId} -> ${info.targets[0]}: destType=${BranchDestType[destType]}`);
      }
    }

    // Sort boundary events by:
    // 1. Destination type (MERGE_TO_MAIN first, then TO_END_EVENT, then DEAD_END)
    // 2. Within same destination type, sort by X position (left to right)
    boundaryEventsWithTargets.sort((a, b) => {
      // First by destination type
      if (a.destType !== b.destType) {
        return a.destType - b.destType;
      }
      // Then by X position
      const xDiff = a.beX - b.beX;
      if (Math.abs(xDiff) > 1) return xDiff;
      // Same X position: sort by boundaryIndex
      return a.info.boundaryIndex - b.info.boundaryIndex;
    });

    // Find the global bottom Y of all attached nodes (boundary events extend below their parent)
    // Also track the main flow Y level (minimum Y of attached nodes)
    let globalBottomY = 0;
    let mainFlowY = Infinity;
    let mainFlowBottom = 0;
    for (const be of boundaryEventsWithTargets) {
      const attachedY = be.attachedNode.y ?? 0;
      const attachedHeight = be.attachedNode.height ?? 80;
      const attachedBottom = attachedY + attachedHeight;
      // Boundary event extends 18px below task (beHeight/2 for 36px boundary event)
      const beBottom = attachedBottom + 18;
      globalBottomY = Math.max(globalBottomY, beBottom);
      mainFlowY = Math.min(mainFlowY, attachedY);
      mainFlowBottom = Math.max(mainFlowBottom, attachedBottom);
    }

    // Minimum gap between elements
    const minGap = 35;
    // Base Y position for MERGE_TO_MAIN branches - very close to main flow
    // These branches should be just below the main flow tasks, not below the boundary events
    const mergeToMainBaseY = mainFlowBottom + minGap + 50; // Just 50px below task bottom + gap
    // Base Y for TO_END_EVENT branches - a bit further below
    const toEndEventBaseY = mergeToMainBaseY + 80;
    // Base Y for DEAD_END branches - furthest from main flow
    const deadEndBaseY = toEndEventBaseY + 100;
    // Horizontal gap required between adjacent branches
    const horizontalGap = 50;

    // Track placed branches with their bounding boxes (x range and y range) and destination type
    const placedBranches: Array<{
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
      destType: BranchDestType;
    }> = [];

    // Helper to calculate branch bounds (including downstream nodes, but not merge points)
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

      // Include downstream nodes in the bounds calculation (but not merge points)
      const visited = new Set<string>();
      const queue = [targetId];
      let currentMaxX = newX + targetWidth;

      while (queue.length > 0) {
        const nodeId = queue.shift()!;
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const downstreamTargets = edgeMap.get(nodeId) || [];
        for (const downId of downstreamTargets) {
          // Don't include merge points in branch bounds
          if (isMergePoint(downId)) continue;

          const downNode = nodeMap.get(downId);
          if (downNode && !visited.has(downId)) {
            const downWidth = downNode.width ?? 36;
            currentMaxX += 20 + downWidth; // Gap + node width
            maxX = Math.max(maxX, currentMaxX);
            totalHeight = Math.max(totalHeight, (downNode.height ?? 36));
            queue.push(downId);
          }
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

    // Helper to get base Y for each destination type
    const getLayerBaseY = (destType: BranchDestType): number => {
      switch (destType) {
        case BranchDestType.MERGE_TO_MAIN:
          return mergeToMainBaseY;
        case BranchDestType.TO_END_EVENT:
          return toEndEventBaseY;
        case BranchDestType.DEAD_END:
          return deadEndBaseY;
        default:
          return deadEndBaseY;
      }
    };

    // Helper to find appropriate Y position for a new branch
    // Checks overlap against ALL placed branches to prevent node stacking
    const findYPosition = (
      branchMinX: number,
      branchMaxX: number,
      branchHeight: number,
      destType: BranchDestType
    ): number => {
      const layerBaseY = getLayerBaseY(destType);
      let candidateY = layerBaseY;

      // Find ALL branches that overlap in X (not just same destType)
      // This prevents nodes from different branch types from stacking
      const overlappingBranches = placedBranches.filter(b =>
        xRangesOverlap(branchMinX, branchMaxX, b.minX, b.maxX)
      );

      if (overlappingBranches.length === 0) {
        // No X overlap - can use layer base Y
        return candidateY;
      }

      // Find the lowest Y among ALL overlapping branches
      // Add sufficient gap (minGap + branchHeight) to prevent vertical overlap
      for (const branch of overlappingBranches) {
        const requiredY = branch.maxY + minGap + 20; // Gap between branches
        candidateY = Math.max(candidateY, requiredY);
      }

      return candidateY;
    };

    // Process all boundary events in sorted order (by destination type, then by X position)
    for (const beEntry of boundaryEventsWithTargets) {
      const { info, beX, attachedRight, destType } = beEntry;

      if (debug) {
        console.log(`[BPMN] Processing boundary event at X=${beX} for ${info.attachedToRef}, destType=${BranchDestType[destType]}`);
      }

      for (const targetId of info.targets) {
        const targetNode = nodeMap.get(targetId);
        if (!targetNode || targetNode.y === undefined) continue;

        const targetWidth = targetNode.width ?? 100;
        const targetHeight = targetNode.height ?? 80;

        // Calculate new X position based on destination type:
        // - MERGE_TO_MAIN: Position to the RIGHT of the attached node (flows naturally to merge point)
        // - TO_END_EVENT: Position below boundary event but shifted right for better flow to end events
        // - DEAD_END: Position below boundary event, slightly right-shifted
        let newX: number;
        if (destType === BranchDestType.MERGE_TO_MAIN) {
          // Place branch to the right of the parent task, with some gap
          newX = attachedRight + 30;
        } else if (destType === BranchDestType.TO_END_EVENT) {
          // Position slightly to the right of the boundary event for better flow toward end events
          // This helps avoid edge crossings when connecting to shared end events
          newX = beX + 20;
        } else {
          // DEAD_END: Position below the boundary event, shifted slightly right
          newX = beX;
        }

        // Calculate branch bounds
        const branchBounds = calculateBranchBounds(targetId, newX, getLayerBaseY(destType));

        // Find appropriate Y position based on destination type and X overlap within that layer
        const newY = findYPosition(branchBounds.minX, branchBounds.maxX, branchBounds.height, destType);
        const offset = newY - (targetNode.y ?? 0);
        movedNodes.set(targetId, { newY, offset, newX });

        if (debug) {
          console.log(`[BPMN] Moving ${targetId}: (${targetNode.x},${targetNode.y}) -> (${newX},${newY}), destType=${BranchDestType[destType]}`);
        }

        // Also move downstream nodes to be aligned with this node
        // But skip merge points (nodes connected to main flow)
        this.propagateMovement(targetId, newY, nodeMap, edgeMap, movedNodes, newX, isMergePoint, debug);

        // Register this branch in placedBranches with its destination type
        placedBranches.push({
          minX: branchBounds.minX,
          maxX: branchBounds.maxX,
          minY: newY,
          maxY: newY + branchBounds.height,
          destType,
        });
      }
    }

    return movedNodes;
  }

  /**
   * Reposition converging gateways based on their incoming edges.
   * The gateway should be positioned to the right of all its incoming sources
   * to enable clean horizontal edge routing.
   */
  repositionConvergingGateways(
    graph: ElkNode,
    movedNodes: Map<string, NodeMoveInfo>,
    boundaryEventInfo: Map<string, BoundaryEventInfo>,
    debug = false
  ): Map<string, NodeMoveInfo> {
    const gatewayMoves = new Map<string, NodeMoveInfo>();

    // Build node map and edge maps
    const nodeMap = new Map<string, ElkNode>();
    const reverseEdgeMap = new Map<string, string[]>(); // target -> sources

    const buildMaps = (node: ElkNode) => {
      nodeMap.set(node.id, node);
      if (node.edges) {
        for (const edge of node.edges) {
          const source = edge.sources?.[0];
          const target = edge.targets?.[0];
          if (source && target) {
            if (!reverseEdgeMap.has(target)) {
              reverseEdgeMap.set(target, []);
            }
            reverseEdgeMap.get(target)!.push(source);
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

    // Collect boundary event target IDs
    const boundaryEventTargetIds = new Set<string>();
    for (const [_beId, info] of boundaryEventInfo) {
      for (const targetId of info.targets) {
        boundaryEventTargetIds.add(targetId);
      }
    }

    // Find converging gateways (nodes with multiple incoming edges, some from boundary branches)
    for (const [nodeId, node] of nodeMap) {
      const incomingSources = reverseEdgeMap.get(nodeId) || [];
      if (incomingSources.length <= 1) continue;

      // Check if this node receives edges from both main flow and boundary branches
      let hasMainFlowInput = false;
      let hasBoundaryBranchInput = false;

      for (const sourceId of incomingSources) {
        if (boundaryEventTargetIds.has(sourceId) || movedNodes.has(sourceId)) {
          hasBoundaryBranchInput = true;
        } else if (!sourceId.startsWith('boundary_')) {
          hasMainFlowInput = true;
        }
      }

      if (!hasMainFlowInput || !hasBoundaryBranchInput) continue;

      // This is a converging gateway - calculate its optimal X position
      // It should be to the right of all incoming sources
      let maxSourceRightX = 0;
      for (const sourceId of incomingSources) {
        const sourceNode = nodeMap.get(sourceId);
        if (!sourceNode) continue;

        // Use moved position if available, otherwise ELK position
        const moveInfo = movedNodes.get(sourceId);
        const sourceX = moveInfo?.newX ?? sourceNode.x ?? 0;
        const sourceWidth = sourceNode.width ?? 100;
        const sourceRightX = sourceX + sourceWidth;

        maxSourceRightX = Math.max(maxSourceRightX, sourceRightX);
      }

      // Position gateway to the right of all sources with some gap
      const gatewayGap = 50;
      const newGatewayX = maxSourceRightX + gatewayGap;
      const currentGatewayX = node.x ?? 0;

      // Only move if it would move the gateway further right
      if (newGatewayX > currentGatewayX) {
        const currentY = node.y ?? 0;
        gatewayMoves.set(nodeId, {
          newY: currentY,
          offset: 0,
          newX: newGatewayX,
        });

        if (debug) {
          console.log(`[BPMN] Repositioning converging gateway ${nodeId}: x ${currentGatewayX} -> ${newGatewayX}`);
        }
      }
    }

    return gatewayMoves;
  }

  /**
   * Propagate movement to downstream nodes
   */
  private propagateMovement(
    sourceId: string,
    sourceNewY: number,
    nodeMap: Map<string, ElkNode>,
    edgeMap: Map<string, string[]>,
    movedNodes: Map<string, NodeMoveInfo>,
    sourceNewX?: number,
    isMergePoint?: (nodeId: string) => boolean,
    debug = false
  ): void {
    const sourceNode = nodeMap.get(sourceId);
    const sourceWidth = sourceNode?.width ?? 100;
    const sourceHeight = sourceNode?.height ?? 80;

    const targets = edgeMap.get(sourceId) || [];
    for (const targetId of targets) {
      // Check if already moved - but update X position if current source is further right
      if (movedNodes.has(targetId)) {
        const existingMove = movedNodes.get(targetId)!;
        const currentSourceRight = (sourceNewX ?? 0) + sourceWidth + 20;

        // If current source would place target further right, update X position
        if (existingMove.newX !== undefined && currentSourceRight > existingMove.newX) {
          existingMove.newX = currentSourceRight;
          if (debug) {
            console.log(`[BPMN] propagateMovement: updating ${targetId} X to ${currentSourceRight} (source is further right)`);
          }
        } else if (debug) {
          console.log(`[BPMN] propagateMovement: skipping ${targetId} - already moved`);
        }
        continue;
      }

      // Skip merge points (nodes with incoming edges from main flow)
      // These should stay in their ELK-determined position
      if (isMergePoint && isMergePoint(targetId)) {
        if (debug) {
          console.log(`[BPMN] propagateMovement: skipping ${targetId} - is merge point`);
        }
        continue;
      }

      const targetNode = nodeMap.get(targetId);
      if (!targetNode || targetNode.y === undefined) continue;

      const targetHeight = targetNode.height ?? 36;
      // Align downstream node vertically centered with source node
      const newY = sourceNewY + (sourceHeight - targetHeight) / 2;
      const offset = newY - (targetNode.y ?? 0);

      // Position downstream node to the right of source (aligned with source's right edge)
      let newX: number | undefined;
      if (sourceNewX !== undefined) {
        // Align downstream node to be to the right of the source
        newX = sourceNewX + sourceWidth + 20;
      }

      movedNodes.set(targetId, { newY, offset, newX });

      if (debug) {
        console.log(`[BPMN] propagateMovement: moving ${targetId} to y=${newY}, newX=${newX}`);
      }

      // Recursively propagate to downstream nodes
      this.propagateMovement(targetId, newY, nodeMap, edgeMap, movedNodes, newX, isMergePoint, debug);
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
  /**
   * Recalculate edge waypoints with orthogonal routing that avoids obstacles.
   * Key constraints:
   * 1. Edges MUST connect perpendicular to node boundaries
   * 2. Edges MUST NOT pass through any node
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
      console.log(`[BPMN] Edge ${edge.id}: source(${sx},${sy},${sw},${sh}) -> target(${tx},${ty},${tw},${th}), obstacles: ${obstacles.length}`);
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
      // This ensures perpendicular connection at both ends
      const startX = sx + sw / 2;
      const startY = sy + sh;
      const endX = tx + tw / 2;
      const endY = ty;

      waypoints.push({ x: startX, y: startY }); // Exit perpendicular from bottom

      // Check for obstacles that would block a direct vertical path
      const obstaclesToAvoid = this.findBlockingObstacles(
        startX, startY, endX, endY, obstacles, 'vertical'
      );

      if (obstaclesToAvoid.length > 0) {
        // Need to route around obstacles while maintaining perpendicular connections
        // Choose optimal routing direction (left or right) based on obstacle positions

        // Calculate left routing X (go left of all obstacles)
        let leftAvoidX = Math.min(startX, endX);
        for (const obs of obstaclesToAvoid) {
          leftAvoidX = Math.min(leftAvoidX, obs.x - 30);
        }
        // Check if left path is blocked by other obstacles
        for (const obs of obstacles) {
          if (obs.y < endY && obs.y + obs.height > startY) {
            if (obs.x <= leftAvoidX + 20 && obs.x + obs.width >= leftAvoidX - 20) {
              leftAvoidX = Math.min(leftAvoidX, obs.x - 30);
            }
          }
        }

        // Calculate right routing X (go right of all obstacles)
        let rightAvoidX = Math.max(startX, endX);
        for (const obs of obstaclesToAvoid) {
          rightAvoidX = Math.max(rightAvoidX, obs.x + obs.width + 30);
        }
        // Check if right path is blocked by other obstacles
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

        // Route: down (perpendicular) -> left/right -> down -> back -> up to target (perpendicular)
        const exitY = startY + 20; // Small perpendicular exit
        waypoints.push({ x: startX, y: exitY }); // Go down first (perpendicular to source bottom)
        waypoints.push({ x: avoidX, y: exitY }); // Go left or right
        waypoints.push({ x: avoidX, y: endY - 20 }); // Go down
        waypoints.push({ x: endX, y: endY - 20 }); // Go back to target X
        // Last segment will be vertical to endY (perpendicular to target top)


      } else {
        // No obstacles - simple perpendicular routing
        // Use Z-routing: down -> horizontal -> down
        const midY = (startY + endY) / 2;
        waypoints.push({ x: startX, y: midY }); // Go down (perpendicular)
        waypoints.push({ x: endX, y: midY }); // Go horizontal
        // Last segment will be vertical to endY (perpendicular)
      }

      waypoints.push({ x: endX, y: endY }); // Enter perpendicular from top

    } else if (isPrimarilyVertical && dy < 0) {
      // Primary direction is UP (return edge) - exit from right, enter from bottom
      const startX = sx + sw;
      const startY = sy + sh / 2;
      const endX = tx + tw / 2; // Target horizontal center
      const endY = ty + th; // Target bottom

      waypoints.push({ x: startX, y: startY }); // Exit perpendicular from right

      // Route to the right of all obstacles, then up to target bottom
      let clearX = Math.max(sx + sw, tx + tw) + 30;
      for (const obs of obstacles) {
        if (obs.y < sy && obs.y + obs.height > ty) {
          clearX = Math.max(clearX, obs.x + obs.width + 30);
        }
      }

      waypoints.push({ x: clearX, y: startY }); // Go right (perpendicular to source)
      waypoints.push({ x: clearX, y: endY }); // Go up to target bottom level
      waypoints.push({ x: endX, y: endY }); // Enter perpendicular from bottom

    } else if (!isPrimarilyVertical && dx > 0) {
      // Primary direction is RIGHT - exit from right, enter from left
      const startX = sx + sw;
      const startY = sy + sh / 2;
      const endX = tx;
      const endY = ty + th / 2;

      waypoints.push({ x: startX, y: startY }); // Exit perpendicular from right

      // Check for obstacles
      const obstaclesToAvoid = this.findBlockingObstacles(
        startX, startY, endX, endY, obstacles, 'horizontal'
      );

      if (obstaclesToAvoid.length > 0) {
        // Route above or below obstacles
        let clearY = Math.max(sy + sh, ty + th) + 30;
        for (const obs of obstaclesToAvoid) {
          clearY = Math.max(clearY, obs.y + obs.height + 30);
        }

        waypoints.push({ x: startX + 20, y: startY }); // Small perpendicular exit
        waypoints.push({ x: startX + 20, y: clearY }); // Go down
        waypoints.push({ x: endX - 20, y: clearY }); // Go right
        waypoints.push({ x: endX - 20, y: endY }); // Go up
      } else {
        // Simple Z-routing: right -> vertical -> right
        const midX = (startX + endX) / 2;
        waypoints.push({ x: midX, y: startY }); // Go right (perpendicular)
        waypoints.push({ x: midX, y: endY }); // Go vertical
      }

      waypoints.push({ x: endX, y: endY }); // Enter perpendicular from left

    } else {
      // Primary direction is LEFT - exit from left, enter from right
      const startX = sx;
      const startY = sy + sh / 2;
      const endX = tx + tw;
      const endY = ty + th / 2;

      waypoints.push({ x: startX, y: startY }); // Exit perpendicular from left

      // Route to the left of all obstacles
      let clearX = Math.min(sx, tx) - 30;
      for (const obs of obstacles) {
        clearX = Math.min(clearX, obs.x - 30);
      }

      waypoints.push({ x: clearX, y: startY }); // Go left (perpendicular)
      waypoints.push({ x: clearX, y: endY }); // Go vertical
      waypoints.push({ x: endX, y: endY }); // Enter perpendicular from right
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

  /**
   * Find obstacles that block a path between two points
   */
  private findBlockingObstacles(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    obstacles: Bounds[],
    direction: 'vertical' | 'horizontal'
  ): Bounds[] {
    const blocking: Bounds[] = [];
    // Use smaller margin to avoid over-detection of obstacles
    // The margin accounts for edge thickness and small positioning errors
    const margin = 5;

    for (const obs of obstacles) {
      const obsRight = obs.x + obs.width;
      const obsBottom = obs.y + obs.height;

      if (direction === 'vertical') {
        // Check if obstacle blocks vertical path
        const pathMinX = Math.min(startX, endX) - margin;
        const pathMaxX = Math.max(startX, endX) + margin;
        const pathMinY = Math.min(startY, endY);
        const pathMaxY = Math.max(startY, endY);

        // Obstacle must be in vertical range AND horizontal overlap with path
        // Use strict comparison (>) for vertical range to exclude obstacles at same level
        if (obs.y < pathMaxY && obsBottom > pathMinY) {
          if (obs.x < pathMaxX && obsRight > pathMinX) {
            blocking.push(obs);
          }
        }
      } else {
        // Check if obstacle blocks horizontal path
        const pathMinX = Math.min(startX, endX);
        const pathMaxX = Math.max(startX, endX);
        const pathMinY = Math.min(startY, endY) - margin;
        const pathMaxY = Math.max(startY, endY) + margin;

        // Obstacle must be in horizontal range AND vertical overlap with path
        if (obs.x < pathMaxX && obsRight > pathMinX) {
          if (obs.y < pathMaxY && obsBottom > pathMinY) {
            blocking.push(obs);
          }
        }
      }
    }

    return blocking;
  }
}
