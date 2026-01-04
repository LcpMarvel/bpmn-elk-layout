/**
 * Boundary Event Mover
 * Handles identification and movement of boundary event target nodes.
 */

import type { ElkNode } from 'elkjs';
import type { ElkBpmnGraph } from '../../../types';
import type { NodeWithBpmn, BoundaryEventInfo, NodeMoveInfo } from '../../../types/internal';

/**
 * Branch destination type enum for prioritization
 */
export enum BranchDestType {
  MERGE_TO_MAIN = 1, // Branches that merge back to main flow (highest priority - closest to main flow)
  TO_END_EVENT = 2, // Branches that end at end events (medium priority)
  DEAD_END = 3, // Branches with no outgoing edges (lowest priority - furthest from main flow)
}

/**
 * Placed branch info for collision detection
 */
interface PlacedBranch {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  destType: BranchDestType;
}

/**
 * Build maps for node lookups and edge relationships
 */
export function buildNodeAndEdgeMaps(
  graph: ElkNode,
  sizedGraph?: ElkBpmnGraph
): {
  nodeMap: Map<string, ElkNode>;
  nodeTypeMap: Map<string, string>;
  edgeMap: Map<string, string[]>;
  reverseEdgeMap: Map<string, string[]>;
} {
  const nodeMap = new Map<string, ElkNode>();
  const nodeTypeMap = new Map<string, string>();
  const edgeMap = new Map<string, string[]>();
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

  // Collect node types from sizedGraph if provided
  if (sizedGraph) {
    for (const child of sizedGraph.children ?? []) {
      collectNodeTypes(child as NodeWithBpmn);
    }
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

  return { nodeMap, nodeTypeMap, edgeMap, reverseEdgeMap };
}

/**
 * Identify nodes that need to be moved below their attached boundary event parent
 * Returns a map of node ID -> new position info
 */
export function identifyNodesToMove(
  graph: ElkNode,
  boundaryEventInfo: Map<string, BoundaryEventInfo>,
  sizedGraph: ElkBpmnGraph,
  debug = false
): Map<string, NodeMoveInfo> {
  const movedNodes = new Map<string, NodeMoveInfo>();
  const { nodeMap, nodeTypeMap, edgeMap, reverseEdgeMap } = buildNodeAndEdgeMaps(
    graph,
    sizedGraph
  );

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
    if (incomingSources.length <= 1) return false;

    for (const sourceId of incomingSources) {
      if (!boundaryEventTargetIds.has(sourceId) && !movedNodes.has(sourceId)) {
        if (debug) {
          console.log(
            `[BPMN] isMergePoint(${nodeId}): true - source ${sourceId} is from main flow`
          );
        }
        return true;
      }
    }
    if (debug) {
      console.log(
        `[BPMN] isMergePoint(${nodeId}): false - all ${incomingSources.length} sources are boundary event branches`
      );
    }
    return false;
  };

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

      if (isMergePoint(nodeId)) {
        return BranchDestType.MERGE_TO_MAIN;
      }

      const outgoingTargets = edgeMap.get(nodeId) || [];

      if (outgoingTargets.length === 0) {
        const nodeType = nodeTypeMap.get(nodeId);
        if (nodeType === 'endEvent') {
          return BranchDestType.TO_END_EVENT;
        }
        return BranchDestType.DEAD_END;
      }

      for (const targetId of outgoingTargets) {
        if (!visited.has(targetId)) {
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
    beX: number;
    attachedRight: number;
    destType: BranchDestType;
  }> = [];

  for (const [beId, info] of boundaryEventInfo) {
    if (info.targets.length === 0) continue;
    const attachedNode = nodeMap.get(info.attachedToRef);
    if (
      !attachedNode ||
      attachedNode.y === undefined ||
      attachedNode.height === undefined
    )
      continue;

    const attachedX = attachedNode.x ?? 0;
    const attachedWidth = attachedNode.width ?? 100;
    const attachedRight = attachedX + attachedWidth;
    const spacing = attachedWidth / (info.totalBoundaries + 1);
    const beX = attachedX + spacing * (info.boundaryIndex + 1);

    const destType =
      info.targets.length > 0
        ? getBranchDestinationType(info.targets[0])
        : BranchDestType.DEAD_END;

    boundaryEventsWithTargets.push({
      beId,
      info,
      attachedNode,
      beX,
      attachedRight,
      destType,
    });

    if (debug) {
      console.log(
        `[BPMN] Branch ${beId} -> ${info.targets[0]}: destType=${BranchDestType[destType]}`
      );
    }
  }

  // Sort boundary events by destination type, then by X position
  boundaryEventsWithTargets.sort((a, b) => {
    if (a.destType !== b.destType) {
      return a.destType - b.destType;
    }
    const xDiff = a.beX - b.beX;
    if (Math.abs(xDiff) > 1) return xDiff;
    return a.info.boundaryIndex - b.info.boundaryIndex;
  });

  // Find the global bottom Y of all attached nodes
  let mainFlowBottom = 0;
  for (const be of boundaryEventsWithTargets) {
    const attachedY = be.attachedNode.y ?? 0;
    const attachedHeight = be.attachedNode.height ?? 80;
    const attachedBottom = attachedY + attachedHeight;
    mainFlowBottom = Math.max(mainFlowBottom, attachedBottom);
  }

  // Layout constants
  const minGap = 35;
  const mergeToMainBaseY = mainFlowBottom + minGap + 50;
  const toEndEventBaseY = mergeToMainBaseY + 80;
  const deadEndBaseY = toEndEventBaseY + 100;
  const horizontalGap = 50;

  // Track placed branches
  const placedBranches: PlacedBranch[] = [];

  // Helper to calculate branch bounds
  const calculateBranchBounds = (
    targetId: string,
    newX: number
  ): { minX: number; maxX: number; height: number } => {
    const targetNode = nodeMap.get(targetId);
    const targetWidth = targetNode?.width ?? 100;
    const targetHeight = targetNode?.height ?? 80;

    let maxX = newX + targetWidth;
    let totalHeight = targetHeight;

    const visited = new Set<string>();
    const queue = [targetId];
    let currentMaxX = newX + targetWidth;

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const downstreamTargets = edgeMap.get(nodeId) || [];
      for (const downId of downstreamTargets) {
        if (isMergePoint(downId)) continue;

        const downNode = nodeMap.get(downId);
        if (downNode && !visited.has(downId)) {
          const downWidth = downNode.width ?? 36;
          currentMaxX += 20 + downWidth;
          maxX = Math.max(maxX, currentMaxX);
          totalHeight = Math.max(totalHeight, downNode.height ?? 36);
          queue.push(downId);
        }
      }
    }

    return { minX: newX, maxX, height: totalHeight };
  };

  // Helper to check if X ranges overlap
  const xRangesOverlap = (
    minX1: number,
    maxX1: number,
    minX2: number,
    maxX2: number
  ): boolean => {
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
  const findYPosition = (
    branchMinX: number,
    branchMaxX: number,
    branchHeight: number,
    destType: BranchDestType
  ): number => {
    const layerBaseY = getLayerBaseY(destType);
    let candidateY = layerBaseY;

    const overlappingBranches = placedBranches.filter((b) =>
      xRangesOverlap(branchMinX, branchMaxX, b.minX, b.maxX)
    );

    if (overlappingBranches.length === 0) {
      return candidateY;
    }

    for (const branch of overlappingBranches) {
      const requiredY = branch.maxY + minGap + 20;
      candidateY = Math.max(candidateY, requiredY);
    }

    return candidateY;
  };

  // Process all boundary events in sorted order
  for (const beEntry of boundaryEventsWithTargets) {
    const { info, beX, attachedRight, destType } = beEntry;

    if (debug) {
      console.log(
        `[BPMN] Processing boundary event at X=${beX} for ${info.attachedToRef}, destType=${BranchDestType[destType]}`
      );
    }

    for (const targetId of info.targets) {
      const targetNode = nodeMap.get(targetId);
      if (!targetNode || targetNode.y === undefined) continue;

      const targetWidth = targetNode.width ?? 100;
      const targetHeight = targetNode.height ?? 80;

      // Calculate new X position based on destination type
      let newX: number;
      if (destType === BranchDestType.MERGE_TO_MAIN) {
        newX = attachedRight + 30;
      } else if (destType === BranchDestType.TO_END_EVENT) {
        newX = beX + 20;
      } else {
        newX = beX;
      }

      // Calculate branch bounds
      const branchBounds = calculateBranchBounds(targetId, newX);

      // Find appropriate Y position
      const newY = findYPosition(
        branchBounds.minX,
        branchBounds.maxX,
        branchBounds.height,
        destType
      );
      const offset = newY - (targetNode.y ?? 0);
      movedNodes.set(targetId, { newY, offset, newX });

      if (debug) {
        console.log(
          `[BPMN] Moving ${targetId}: (${targetNode.x},${targetNode.y}) -> (${newX},${newY}), destType=${BranchDestType[destType]}`
        );
      }

      // Propagate movement to downstream nodes
      propagateMovement(
        targetId,
        newY,
        nodeMap,
        edgeMap,
        movedNodes,
        newX,
        isMergePoint,
        debug
      );

      // Register this branch
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
 * Propagate movement to downstream nodes
 */
export function propagateMovement(
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
    if (movedNodes.has(targetId)) {
      const existingMove = movedNodes.get(targetId)!;
      const currentSourceRight = (sourceNewX ?? 0) + sourceWidth + 20;

      if (
        existingMove.newX !== undefined &&
        currentSourceRight > existingMove.newX
      ) {
        existingMove.newX = currentSourceRight;
        if (debug) {
          console.log(
            `[BPMN] propagateMovement: updating ${targetId} X to ${currentSourceRight} (source is further right)`
          );
        }
      } else if (debug) {
        console.log(
          `[BPMN] propagateMovement: skipping ${targetId} - already moved`
        );
      }
      continue;
    }

    if (isMergePoint && isMergePoint(targetId)) {
      if (debug) {
        console.log(
          `[BPMN] propagateMovement: skipping ${targetId} - is merge point`
        );
      }
      continue;
    }

    const targetNode = nodeMap.get(targetId);
    if (!targetNode || targetNode.y === undefined) continue;

    const targetHeight = targetNode.height ?? 36;
    const newY = sourceNewY + (sourceHeight - targetHeight) / 2;
    const offset = newY - (targetNode.y ?? 0);

    let newX: number | undefined;
    if (sourceNewX !== undefined) {
      newX = sourceNewX + sourceWidth + 20;
    }

    movedNodes.set(targetId, { newY, offset, newX });

    if (debug) {
      console.log(
        `[BPMN] propagateMovement: moving ${targetId} to y=${newY}, newX=${newX}`
      );
    }

    propagateMovement(
      targetId,
      newY,
      nodeMap,
      edgeMap,
      movedNodes,
      newX,
      isMergePoint,
      debug
    );
  }
}

/**
 * Reposition converging gateways based on their incoming edges.
 */
export function repositionConvergingGateways(
  graph: ElkNode,
  movedNodes: Map<string, NodeMoveInfo>,
  boundaryEventInfo: Map<string, BoundaryEventInfo>,
  debug = false
): Map<string, NodeMoveInfo> {
  const gatewayMoves = new Map<string, NodeMoveInfo>();

  const nodeMap = new Map<string, ElkNode>();
  const reverseEdgeMap = new Map<string, string[]>();

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

  // Find converging gateways
  for (const [nodeId, node] of nodeMap) {
    const incomingSources = reverseEdgeMap.get(nodeId) || [];
    if (incomingSources.length <= 1) continue;

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

    let maxSourceRightX = 0;
    for (const sourceId of incomingSources) {
      const sourceNode = nodeMap.get(sourceId);
      if (!sourceNode) continue;

      const moveInfo = movedNodes.get(sourceId);
      const sourceX = moveInfo?.newX ?? sourceNode.x ?? 0;
      const sourceWidth = sourceNode.width ?? 100;
      const sourceRightX = sourceX + sourceWidth;

      maxSourceRightX = Math.max(maxSourceRightX, sourceRightX);
    }

    const gatewayGap = 50;
    const newGatewayX = maxSourceRightX + gatewayGap;
    const currentGatewayX = node.x ?? 0;

    if (newGatewayX > currentGatewayX) {
      const currentY = node.y ?? 0;
      gatewayMoves.set(nodeId, {
        newY: currentY,
        offset: 0,
        newX: newGatewayX,
      });

      if (debug) {
        console.log(
          `[BPMN] Repositioning converging gateway ${nodeId}: x ${currentGatewayX} -> ${newGatewayX}`
        );
      }
    }
  }

  return gatewayMoves;
}

/**
 * Apply node moves to the layouted graph
 */
export function applyNodeMoves(
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
