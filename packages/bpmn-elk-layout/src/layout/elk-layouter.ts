/**
 * ELK Layout Engine Wrapper
 */

import ELK from 'elkjs';
import type { ElkNode, ElkExtendedEdge, LayoutOptions } from 'elkjs';
import type { ElkBpmnGraph, ElkLayoutOptions } from '../types';
import type { LayoutedGraph } from '../types/elk-output';
import type { NodeWithBpmn, BoundaryEventInfo } from '../types/internal';
import { mergeElkOptions } from './default-options';
import { SizeCalculator } from './size-calculator';
import { EdgeFixer } from './edge-routing/edge-fixer';
import { BoundaryEventHandler } from './post-processing/boundary-event-handler';
import { ArtifactPositioner } from './post-processing/artifact-positioner';
import { GroupPositioner } from './post-processing/group-positioner';
import { LaneArranger } from './post-processing/lane-arranger';
import { PoolArranger } from './post-processing/pool-arranger';
import { GatewayEdgeAdjuster } from './post-processing/gateway-edge-adjuster';

// Debug flag for layout logging
const DEBUG = typeof process !== 'undefined' && process.env?.['DEBUG'] === 'true';

export interface ElkLayouterOptions {
  elkOptions?: ElkLayoutOptions;
}

export class ElkLayouter {
  private elk: InstanceType<typeof ELK>;
  private userOptions: ElkLayoutOptions;
  private sizeCalculator: SizeCalculator;
  private edgeFixer: EdgeFixer;
  private boundaryEventHandler: BoundaryEventHandler;
  private artifactPositioner: ArtifactPositioner;
  private groupPositioner: GroupPositioner;
  private laneArranger: LaneArranger;
  private poolArranger: PoolArranger;
  private gatewayEdgeAdjuster: GatewayEdgeAdjuster;

  constructor(options?: ElkLayouterOptions) {
    this.elk = new ELK();
    this.userOptions = options?.elkOptions ?? {};
    this.sizeCalculator = new SizeCalculator();
    this.edgeFixer = new EdgeFixer();
    this.boundaryEventHandler = new BoundaryEventHandler();
    this.artifactPositioner = new ArtifactPositioner();
    this.groupPositioner = new GroupPositioner();
    this.laneArranger = new LaneArranger();
    this.poolArranger = new PoolArranger();
    this.gatewayEdgeAdjuster = new GatewayEdgeAdjuster();
  }

  /**
   * Run ELK layout on the graph
   */
  async layout(graph: ElkBpmnGraph): Promise<LayoutedGraph> {
    // Deep clone to avoid mutating the original
    const graphCopy = JSON.parse(JSON.stringify(graph)) as ElkBpmnGraph;

    // Apply default sizes to all nodes
    const sizedGraph = this.sizeCalculator.applyDefaultSizes(graphCopy);

    // Collect boundary event info for post-processing
    const boundaryEventInfo = this.boundaryEventHandler.collectInfo(sizedGraph);

    // Collect boundary event target IDs for ELK constraint assignment
    const boundaryEventTargetIds = this.collectBoundaryEventTargetIds(boundaryEventInfo);

    // Collect artifact association info for post-processing
    const artifactInfo = this.artifactPositioner.collectInfo(sizedGraph);

    // Collect Group info for post-processing (Groups will be repositioned after layout)
    const groupInfo = this.groupPositioner.collectInfo(sizedGraph);

    // Prepare graph for ELK (convert to ELK format)
    const elkGraph = this.prepareForElk(sizedGraph, boundaryEventTargetIds);

    // Run ELK layout
    const layoutedElkGraph = await this.elk.layout(elkGraph);

    // Identify main flow nodes for normalization
    const mainFlowNodes = this.identifyMainFlowNodes(sizedGraph, boundaryEventTargetIds);

    // Normalize main flow to the top of the diagram
    // This ensures the primary flow path stays at a consistent Y position
    this.normalizeMainFlowPosition(layoutedElkGraph, mainFlowNodes, boundaryEventTargetIds, sizedGraph);

    // Check if boundary event targets need repositioning
    // Pass sizedGraph to access node type information (bpmn.type) which is not preserved in ELK graph
    const movedNodes = this.boundaryEventHandler.identifyNodesToMove(layoutedElkGraph, boundaryEventInfo, sizedGraph, DEBUG);

    if (movedNodes.size > 0) {
      // Move nodes and recalculate affected edges
      this.boundaryEventHandler.applyNodeMoves(layoutedElkGraph, movedNodes);

      // Reposition converging gateways based on incoming edge positions
      const gatewayMoves = this.boundaryEventHandler.repositionConvergingGateways(
        layoutedElkGraph, movedNodes, boundaryEventInfo, DEBUG
      );

      if (gatewayMoves.size > 0) {
        // Apply gateway moves
        this.boundaryEventHandler.applyNodeMoves(layoutedElkGraph, gatewayMoves);

        // Also move downstream nodes of the gateway
        this.propagateGatewayMovement(layoutedElkGraph, gatewayMoves, mainFlowNodes);
      }

      // Merge gateway moves into movedNodes for edge recalculation
      for (const [id, move] of gatewayMoves) {
        movedNodes.set(id, move);
      }

      this.boundaryEventHandler.recalculateEdgesForMovedNodes(layoutedElkGraph, movedNodes, boundaryEventInfo, DEBUG);
    }

    // Reposition artifacts (data objects, data stores, annotations) to be near their associated tasks
    this.artifactPositioner.reposition(layoutedElkGraph, artifactInfo);

    // Rearrange lanes to stack vertically within pools (ELK's partitioning doesn't do this correctly)
    this.laneArranger.rearrange(layoutedElkGraph, sizedGraph);

    // Rearrange pools to stack vertically within collaborations
    this.poolArranger.rearrange(layoutedElkGraph, sizedGraph);

    // Reposition Groups to surround their grouped elements
    this.groupPositioner.reposition(layoutedElkGraph, groupInfo, sizedGraph);

    // Recalculate artifact edges with obstacle avoidance
    this.artifactPositioner.recalculateWithObstacleAvoidance(layoutedElkGraph, artifactInfo);

    // Fix edges that cross through nodes (especially return edges in complex flows)
    this.edgeFixer.fix(layoutedElkGraph);

    // Update container bounds to include all moved children
    this.updateContainerBounds(layoutedElkGraph);

    // Note: Gateway edge endpoint adjustment is now handled in model-builder.ts
    // during the buildEdge() step, which has access to the correct coordinate system.

    // Merge layout results back with BPMN metadata
    return this.mergeLayoutResults(sizedGraph, layoutedElkGraph);
  }

  /**
   * Propagate gateway movement to downstream nodes (nodes after the gateway in the flow)
   */
  private propagateGatewayMovement(
    graph: ElkNode,
    gatewayMoves: Map<string, NodeMoveInfo>,
    mainFlowNodes: Set<string>
  ): void {
    // Build node and edge maps
    const nodeMap = new Map<string, ElkNode>();
    const edgeMap = new Map<string, string[]>(); // source -> targets

    const buildMaps = (node: ElkNode) => {
      nodeMap.set(node.id, node);
      if (node.edges) {
        for (const edge of node.edges) {
          const source = edge.sources?.[0];
          const target = edge.targets?.[0];
          if (source && target) {
            if (!edgeMap.has(source)) edgeMap.set(source, []);
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

    // For each moved gateway, move its downstream main flow nodes
    for (const [gatewayId, gatewayMove] of gatewayMoves) {
      if (gatewayMove.newX === undefined) continue;

      const gateway = nodeMap.get(gatewayId);
      if (!gateway) continue;

      const gatewayRight = gatewayMove.newX + (gateway.width ?? 50);
      const downstreamTargets = edgeMap.get(gatewayId) || [];

      for (const targetId of downstreamTargets) {
        // Only move main flow nodes downstream of gateway
        if (!mainFlowNodes.has(targetId)) continue;

        const targetNode = nodeMap.get(targetId);
        if (!targetNode) continue;

        // Position target to the right of gateway
        const newX = gatewayRight + 50;
        const currentX = targetNode.x ?? 0;

        if (newX > currentX) {
          targetNode.x = newX;
          gatewayMoves.set(targetId, {
            newY: targetNode.y ?? 0,
            offset: 0,
            newX: newX,
          });

          if (DEBUG) {
            console.log(`[BPMN] Propagating gateway movement to ${targetId}: x ${currentX} -> ${newX}`);
          }

          // Recursively move further downstream nodes
          this.propagateDownstreamX(targetId, newX, targetNode.width ?? 100, nodeMap, edgeMap, mainFlowNodes, gatewayMoves);
        }
      }
    }
  }

  /**
   * Recursively propagate X movement to downstream main flow nodes
   */
  private propagateDownstreamX(
    sourceId: string,
    sourceX: number,
    sourceWidth: number,
    nodeMap: Map<string, ElkNode>,
    edgeMap: Map<string, string[]>,
    mainFlowNodes: Set<string>,
    moves: Map<string, NodeMoveInfo>
  ): void {
    const targets = edgeMap.get(sourceId) || [];
    const sourceRight = sourceX + sourceWidth;

    for (const targetId of targets) {
      if (!mainFlowNodes.has(targetId)) continue;
      if (moves.has(targetId)) continue; // Already moved

      const targetNode = nodeMap.get(targetId);
      if (!targetNode) continue;

      const newX = sourceRight + 50;
      const currentX = targetNode.x ?? 0;

      if (newX > currentX) {
        targetNode.x = newX;
        moves.set(targetId, {
          newY: targetNode.y ?? 0,
          offset: 0,
          newX: newX,
        });

        if (DEBUG) {
          console.log(`[BPMN] Propagating X to ${targetId}: x ${currentX} -> ${newX}`);
        }

        this.propagateDownstreamX(targetId, newX, targetNode.width ?? 100, nodeMap, edgeMap, mainFlowNodes, moves);
      }
    }
  }

  /**
   * Update container bounds to include all children after post-processing
   * This is needed because post-processing may move nodes outside the original ELK-calculated bounds
   */
  /**
   * Normalize main flow position to keep it at the top of the diagram.
   * ELK may place the main flow lower to accommodate boundary event branches,
   * but we want the main flow to stay at a consistent top position.
   *
   * Strategy:
   * 1. Identify "upstream main flow" nodes (before converging gateway)
   * 2. Shift these nodes up to target Y
   * 3. Position converging gateway below the main flow
   * 4. Position downstream nodes (after gateway) relative to gateway
   */
  private normalizeMainFlowPosition(
    graph: ElkNode,
    mainFlowNodes: Set<string>,
    boundaryEventTargetIds: Set<string>,
    originalGraph: ElkBpmnGraph
  ): void {
    const TARGET_MAIN_FLOW_Y = 12; // Target Y position for main flow (with padding)
    const GATEWAY_OFFSET_Y = 150; // How far below main flow the converging gateway should be

    // Build node map and track which nodes are inside subprocesses (have local coordinates)
    const nodeMap = new Map<string, ElkNode>();
    const nodesInsideContainers = new Set<string>(); // Nodes that shouldn't be moved (local coords)
    const buildNodeMap = (node: ElkNode, parentIsContainer = false) => {
      nodeMap.set(node.id, node);
      if (parentIsContainer) {
        nodesInsideContainers.add(node.id);
      }
      if (node.children) {
        // Check if this node is a container (subprocess, transaction, etc.)
        const nodeType = this.getNodeTypeFromOriginal(node.id, originalGraph);
        const isContainer = nodeType === 'subProcess' || nodeType === 'transaction' ||
                           nodeType === 'adHocSubProcess' || nodeType === 'eventSubProcess';
        for (const child of node.children) {
          buildNodeMap(child, isContainer || parentIsContainer);
        }
      }
    };
    buildNodeMap(graph);

    // Find converging gateways and separate main flow into upstream/downstream
    const convergingGatewayIds = new Set<string>();
    const upstreamMainFlow: ElkNode[] = []; // Nodes before converging gateway
    const downstreamMainFlow: ElkNode[] = []; // Nodes after converging gateway (including gateway)

    // First pass: identify converging gateways
    // Note: endEvents should stay on main flow line even if they receive boundary inputs
    for (const nodeId of mainFlowNodes) {
      if (this.isConvergingGatewayWithBoundaryInputs(nodeId, graph, boundaryEventTargetIds)) {
        // Check if this is an endEvent - if so, keep it on main flow line
        // Use originalGraph to access BPMN type info (not preserved in ELK graph)
        const nodeType = this.getNodeTypeFromOriginal(nodeId, originalGraph);
        const isEndEvent = nodeType === 'endEvent';
        if (!isEndEvent) {
          convergingGatewayIds.add(nodeId);
        }
      }
    }

    // Second pass: categorize nodes as upstream or downstream of converging gateway
    // Build edge map to trace flow
    const edgeMap = new Map<string, string[]>();
    const collectEdges = (node: ElkNode) => {
      if (node.edges) {
        for (const edge of node.edges) {
          const source = edge.sources?.[0];
          const target = edge.targets?.[0];
          if (source && target) {
            if (!edgeMap.has(source)) edgeMap.set(source, []);
            edgeMap.get(source)!.push(target);
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          collectEdges(child);
        }
      }
    };
    collectEdges(graph);

    // Find nodes downstream of converging gateways
    const downstreamNodeIds = new Set<string>();
    const markDownstream = (nodeId: string) => {
      if (downstreamNodeIds.has(nodeId)) return;
      downstreamNodeIds.add(nodeId);
      const targets = edgeMap.get(nodeId) || [];
      for (const targetId of targets) {
        if (mainFlowNodes.has(targetId)) {
          markDownstream(targetId);
        }
      }
    };
    for (const gatewayId of convergingGatewayIds) {
      markDownstream(gatewayId);
    }

    // Categorize main flow nodes (excluding nodes inside containers - they have local coordinates)
    for (const nodeId of mainFlowNodes) {
      // Skip nodes that are inside subprocesses - they have local coordinates
      if (nodesInsideContainers.has(nodeId)) continue;

      const node = nodeMap.get(nodeId);
      if (!node || node.y === undefined) continue;

      if (downstreamNodeIds.has(nodeId)) {
        downstreamMainFlow.push(node);
      } else {
        upstreamMainFlow.push(node);
      }
    }

    // Separate endEvents from other upstream nodes - they need special alignment
    const endEventNodes: ElkNode[] = [];
    const otherUpstreamNodes: ElkNode[] = [];
    for (const node of upstreamMainFlow) {
      const nodeType = this.getNodeTypeFromOriginal(node.id, originalGraph);
      if (nodeType === 'endEvent') {
        endEventNodes.push(node);
      } else {
        otherUpstreamNodes.push(node);
      }
    }

    // Find current min Y of non-endEvent upstream main flow nodes
    let currentMinY = Infinity;
    for (const node of otherUpstreamNodes) {
      if (node.y !== undefined) {
        currentMinY = Math.min(currentMinY, node.y);
      }
    }

    if (currentMinY === Infinity || currentMinY <= TARGET_MAIN_FLOW_Y) {
      // Main flow is already at or above target position, no normalization needed
      return;
    }

    // Calculate the offset to shift upstream main flow up
    const offsetY = currentMinY - TARGET_MAIN_FLOW_Y;

    if (DEBUG) {
      console.log(`[BPMN] Normalizing main flow: currentMinY=${currentMinY}, offsetY=${offsetY}`);
      console.log(`[BPMN] Upstream nodes: ${upstreamMainFlow.map(n => n.id).join(', ')}`);
      console.log(`[BPMN] Downstream nodes: ${downstreamMainFlow.map(n => n.id).join(', ')}`);
    }

    // Shift non-endEvent upstream main flow nodes up
    for (const node of otherUpstreamNodes) {
      if (node.y !== undefined) {
        node.y -= offsetY;
        if (DEBUG) {
          console.log(`[BPMN] Shifted upstream ${node.id} to y=${node.y}`);
        }
      }
    }

    // Align endEvents with their predecessor's vertical center
    // Find the main container (e.g., subprocess, task) that precedes the endEvent
    for (const endNode of endEventNodes) {
      const predecessorId = this.findPredecessorOnMainFlow(endNode.id, graph, mainFlowNodes);
      if (predecessorId) {
        const predecessor = nodeMap.get(predecessorId);
        if (predecessor && predecessor.y !== undefined) {
          // Align endEvent center with predecessor's vertical center
          const predecessorCenterY = predecessor.y + (predecessor.height ?? 80) / 2;
          const endNodeCenterY = (endNode.height ?? 36) / 2;
          endNode.y = predecessorCenterY - endNodeCenterY;
          if (DEBUG) {
            console.log(`[BPMN] Aligned endEvent ${endNode.id} with predecessor ${predecessorId}: y=${endNode.y}`);
          }
        }
      } else {
        // Fallback: shift like other nodes
        if (endNode.y !== undefined) {
          endNode.y -= offsetY;
          if (DEBUG) {
            console.log(`[BPMN] Shifted upstream ${endNode.id} to y=${endNode.y} (no predecessor found)`);
          }
        }
      }
    }

    // Calculate target Y for downstream nodes (converging gateway and after)
    // The gateway should be positioned below the main flow
    const mainFlowBottom = Math.max(...upstreamMainFlow.map(n => (n.y ?? 0) + (n.height ?? 80)));
    const targetGatewayY = mainFlowBottom + GATEWAY_OFFSET_Y;

    // Find current gateway Y to calculate downstream offset
    let currentGatewayY = Infinity;
    for (const gatewayId of convergingGatewayIds) {
      const gateway = nodeMap.get(gatewayId);
      if (gateway && gateway.y !== undefined) {
        currentGatewayY = Math.min(currentGatewayY, gateway.y);
      }
    }

    if (currentGatewayY !== Infinity) {
      const downstreamOffsetY = currentGatewayY - targetGatewayY;

      // Shift downstream nodes (gateway and nodes after it)
      for (const node of downstreamMainFlow) {
        if (node.y !== undefined) {
          node.y -= downstreamOffsetY;
          if (DEBUG) {
            console.log(`[BPMN] Shifted downstream ${node.id} to y=${node.y}`);
          }
        }
      }
    }

    // Update boundary event positions
    for (const [nodeId, node] of nodeMap) {
      if (node.y !== undefined && nodeId.startsWith('boundary_')) {
        const attachedNodeId = this.findBoundaryAttachedNode(nodeId, graph);
        if (attachedNodeId && mainFlowNodes.has(attachedNodeId)) {
          const attachedNode = nodeMap.get(attachedNodeId);
          if (attachedNode && attachedNode.y !== undefined) {
            const attachedBottom = attachedNode.y + (attachedNode.height ?? 80);
            node.y = attachedBottom - (node.height ?? 36) / 2;
          }
        }
      }
    }

    // Update edges that connect main flow nodes
    this.updateEdgesAfterNormalization(graph, [...upstreamMainFlow, ...downstreamMainFlow], offsetY);
  }

  /**
   * Find the predecessor node of a given node on the main flow
   */
  private findPredecessorOnMainFlow(
    nodeId: string,
    graph: ElkNode,
    mainFlowNodes: Set<string>
  ): string | undefined {
    // Find incoming edges to this node from main flow
    const findIncoming = (node: ElkNode): string | undefined => {
      if (node.edges) {
        for (const edge of node.edges) {
          const target = edge.targets?.[0];
          const source = edge.sources?.[0];
          if (target === nodeId && source && mainFlowNodes.has(source)) {
            // Skip boundary events
            if (!source.includes('boundary')) {
              return source;
            }
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          const result = findIncoming(child);
          if (result) return result;
        }
      }
      return undefined;
    };
    return findIncoming(graph);
  }

  /**
   * Get the BPMN type of a node by searching the original graph (with BPMN info preserved)
   */
  private getNodeTypeFromOriginal(nodeId: string, graph: ElkBpmnGraph): string | undefined {
    const findType = (children: ElkBpmnGraph['children']): string | undefined => {
      if (!children) return undefined;
      for (const child of children) {
        const node = child as unknown as NodeWithBpmn;
        if (node.id === nodeId) {
          return node.bpmn?.type;
        }
        // Check in nested children
        if (node.children) {
          const result = findType(node.children as ElkBpmnGraph['children']);
          if (result) return result;
        }
      }
      return undefined;
    };
    return findType(graph.children);
  }

  /**
   * Check if a node is a converging gateway that receives edges from both
   * main flow and boundary event branches (should be positioned below main flow)
   */
  private isConvergingGatewayWithBoundaryInputs(
    nodeId: string,
    graph: ElkNode,
    boundaryEventTargetIds: Set<string>
  ): boolean {
    // Collect all incoming edges to this node
    const incomingSources: string[] = [];

    const collectIncoming = (node: ElkNode) => {
      if (node.edges) {
        for (const edge of node.edges) {
          const target = edge.targets?.[0];
          const source = edge.sources?.[0];
          if (target === nodeId && source) {
            incomingSources.push(source);
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          collectIncoming(child);
        }
      }
    };
    collectIncoming(graph);

    if (incomingSources.length <= 1) return false;

    // Check if any incoming source is a boundary event target (or downstream of one)
    let hasMainFlowInput = false;
    let hasBoundaryInput = false;

    for (const sourceId of incomingSources) {
      if (boundaryEventTargetIds.has(sourceId) || this.isDownstreamOfBoundaryTarget(sourceId, graph, boundaryEventTargetIds)) {
        hasBoundaryInput = true;
      } else if (!sourceId.startsWith('boundary_')) {
        hasMainFlowInput = true;
      }
    }

    return hasMainFlowInput && hasBoundaryInput;
  }

  /**
   * Check if a node is downstream of a boundary event target
   */
  private isDownstreamOfBoundaryTarget(
    nodeId: string,
    graph: ElkNode,
    boundaryEventTargetIds: Set<string>,
    visited: Set<string> = new Set()
  ): boolean {
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);

    if (boundaryEventTargetIds.has(nodeId)) return true;

    // Find incoming edges to this node
    const findIncoming = (node: ElkNode): string[] => {
      const sources: string[] = [];
      if (node.edges) {
        for (const edge of node.edges) {
          if (edge.targets?.[0] === nodeId) {
            sources.push(edge.sources?.[0] ?? '');
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          sources.push(...findIncoming(child));
        }
      }
      return sources.filter(s => s);
    };

    const sources = findIncoming(graph);
    for (const sourceId of sources) {
      if (this.isDownstreamOfBoundaryTarget(sourceId, graph, boundaryEventTargetIds, visited)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Find the node that a boundary event is attached to
   */
  private findBoundaryAttachedNode(boundaryEventId: string, graph: ElkNode): string | null {
    // In our graph structure, boundary events are defined in the original sizedGraph
    // but in ELK they're siblings. We need to check the original structure.
    // For now, use a heuristic: boundary event ID contains the parent node name
    // e.g., "boundary_error_call_order" is attached to "call_activity_order"

    // This is a simplified approach - in a real implementation, we'd track this mapping
    const parts = boundaryEventId.replace('boundary_', '').split('_');
    if (parts.length >= 2) {
      // Try to reconstruct the parent node ID
      // e.g., "error_call_order" -> try "call_activity_order"
      const suffix = parts.slice(1).join('_');
      const possibleParents = ['call_activity_' + suffix, 'task_' + suffix, suffix];

      const nodeMap = new Map<string, ElkNode>();
      const buildMap = (node: ElkNode) => {
        nodeMap.set(node.id, node);
        if (node.children) {
          for (const child of node.children) {
            buildMap(child);
          }
        }
      };
      buildMap(graph);

      for (const parentId of possibleParents) {
        if (nodeMap.has(parentId)) {
          return parentId;
        }
      }
    }

    return null;
  }

  /**
   * Update edge waypoints after normalizing main flow positions
   */
  private updateEdgesAfterNormalization(
    graph: ElkNode,
    movedNodes: ElkNode[],
    offsetY: number
  ): void {
    const movedNodeIds = new Set(movedNodes.map(n => n.id));

    const updateEdges = (node: ElkNode) => {
      if (node.edges) {
        for (const edge of node.edges) {
          const sourceId = edge.sources?.[0];
          const targetId = edge.targets?.[0];
          const sourceMoved = sourceId && movedNodeIds.has(sourceId);
          const targetMoved = targetId && movedNodeIds.has(targetId);

          // If both source and target moved, shift all waypoints
          if (sourceMoved && targetMoved && edge.sections) {
            for (const section of edge.sections) {
              if (section.startPoint) {
                section.startPoint.y -= offsetY;
              }
              if (section.endPoint) {
                section.endPoint.y -= offsetY;
              }
              if (section.bendPoints) {
                for (const bp of section.bendPoints) {
                  bp.y -= offsetY;
                }
              }
            }
          }
          // If only source moved, adjust start point
          else if (sourceMoved && !targetMoved && edge.sections) {
            for (const section of edge.sections) {
              if (section.startPoint) {
                section.startPoint.y -= offsetY;
              }
            }
          }
          // If only target moved, adjust end point
          else if (!sourceMoved && targetMoved && edge.sections) {
            for (const section of edge.sections) {
              if (section.endPoint) {
                section.endPoint.y -= offsetY;
              }
            }
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          updateEdges(child);
        }
      }
    };
    updateEdges(graph);
  }

  private updateContainerBounds(graph: ElkNode): void {
    const updateBounds = (node: ElkNode): { maxX: number; maxY: number } => {
      let maxX = (node.x ?? 0) + (node.width ?? 0);
      let maxY = (node.y ?? 0) + (node.height ?? 0);

      // Recursively update children first
      if (node.children) {
        for (const child of node.children) {
          const childBounds = updateBounds(child);
          // Child coordinates are relative to parent, so add parent offset
          const childMaxX = (node.x ?? 0) + childBounds.maxX;
          const childMaxY = (node.y ?? 0) + childBounds.maxY;
          maxX = Math.max(maxX, childMaxX);
          maxY = Math.max(maxY, childMaxY);
        }

        // Check if this container has lanes (children positioned at x=30, which is the lane header width)
        // Pools with lanes should not have padding added - lanes fill the pool completely
        const hasLanes = node.children.length > 0 &&
          node.children.every(child => (child.x ?? 0) === 30);

        // If children extend beyond current bounds, expand the container
        const nodeX = node.x ?? 0;
        const nodeY = node.y ?? 0;
        // Don't add padding for pools with lanes - lanes already fill the container
        const padding = hasLanes ? 0 : 12;

        // Calculate required dimensions based on children
        let requiredWidth = 0;
        let requiredHeight = 0;
        for (const child of node.children) {
          const childRight = (child.x ?? 0) + (child.width ?? 0) + padding;
          const childBottom = (child.y ?? 0) + (child.height ?? 0) + padding;
          requiredWidth = Math.max(requiredWidth, childRight);
          requiredHeight = Math.max(requiredHeight, childBottom);
        }

        // Update node dimensions if needed
        if (requiredWidth > (node.width ?? 0)) {
          node.width = requiredWidth;
          maxX = nodeX + requiredWidth;
        }
        if (requiredHeight > (node.height ?? 0)) {
          node.height = requiredHeight;
          maxY = nodeY + requiredHeight;
        }
      }

      return { maxX, maxY };
    };

    updateBounds(graph);
  }

  /**
   * Collect all boundary event target node IDs
   * These are nodes that are directly connected from boundary events
   */
  private collectBoundaryEventTargetIds(boundaryEventInfo: Map<string, BoundaryEventInfo>): Set<string> {
    const targetIds = new Set<string>();
    for (const [_beId, info] of boundaryEventInfo) {
      for (const targetId of info.targets) {
        targetIds.add(targetId);
      }
    }
    return targetIds;
  }

  /**
   * Identify main flow nodes - nodes that are in the primary path from start to end,
   * not including boundary event branches.
   * Main flow nodes should be prioritized in layout to stay at the top.
   */
  private identifyMainFlowNodes(graph: ElkBpmnGraph, boundaryEventTargetIds: Set<string>): Set<string> {
    const mainFlowNodes = new Set<string>();
    const edgeMap = new Map<string, string[]>(); // source -> targets
    const boundaryEventIds = new Set<string>();

    // Collect all boundary event IDs and edges
    const collectInfo = (node: NodeWithBpmn) => {
      if (node.boundaryEvents) {
        for (const be of node.boundaryEvents) {
          boundaryEventIds.add(be.id);
        }
      }
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
          collectInfo(child as NodeWithBpmn);
        }
      }
    };

    // Find start events
    const findStartEvents = (node: NodeWithBpmn): string[] => {
      const starts: string[] = [];
      if (node.bpmn?.type === 'startEvent') {
        starts.push(node.id);
      }
      if (node.children) {
        for (const child of node.children) {
          starts.push(...findStartEvents(child as NodeWithBpmn));
        }
      }
      return starts;
    };

    // Traverse from start events, following only non-boundary-event edges
    const traverseMainFlow = (nodeId: string) => {
      if (mainFlowNodes.has(nodeId)) return;
      // Don't include boundary event targets as main flow
      if (boundaryEventTargetIds.has(nodeId)) return;
      // Don't include boundary events themselves
      if (boundaryEventIds.has(nodeId)) return;

      mainFlowNodes.add(nodeId);

      const targets = edgeMap.get(nodeId) || [];
      for (const targetId of targets) {
        // Skip if this edge originates from a boundary event
        if (!boundaryEventIds.has(nodeId)) {
          traverseMainFlow(targetId);
        }
      }
    };

    for (const child of graph.children ?? []) {
      collectInfo(child as NodeWithBpmn);
    }

    const startEvents = findStartEvents({ children: graph.children } as NodeWithBpmn);
    for (const startId of startEvents) {
      traverseMainFlow(startId);
    }

    if (DEBUG) {
      console.log(`[BPMN] Main flow nodes: ${Array.from(mainFlowNodes).join(', ')}`);
    }

    return mainFlowNodes;
  }

  /**
   * Prepare the BPMN graph for ELK layout
   */
  private prepareForElk(graph: ElkBpmnGraph, boundaryEventTargetIds: Set<string> = new Set()): ElkNode {
    let layoutOptions: LayoutOptions = mergeElkOptions(this.userOptions, graph.layoutOptions) as LayoutOptions;

    // Check if this graph contains a cross-pool collaboration
    // If so, force RIGHT direction for better horizontal layout
    if (this.hasCrossPoolCollaboration(graph)) {
      layoutOptions = {
        ...layoutOptions,
        'elk.direction': 'RIGHT',
      };
    }

    // Identify main flow nodes to give them layout priority
    const mainFlowNodes = this.identifyMainFlowNodes(graph, boundaryEventTargetIds);

    return {
      id: graph.id ?? 'root',
      layoutOptions,
      children: this.prepareChildrenForElk(graph.children, boundaryEventTargetIds, mainFlowNodes),
    };
  }

  /**
   * Check if the graph contains a collaboration with cross-pool sequence flows
   */
  private hasCrossPoolCollaboration(graph: ElkBpmnGraph): boolean {
    if (!graph.children) return false;

    for (const child of graph.children) {
      const node = child as NodeWithBpmn;
      if (node.bpmn?.type === 'collaboration') {
        // Check for multiple pools
        const pools = node.children?.filter(
          (c: unknown) => (c as NodeWithBpmn).bpmn?.type === 'participant'
        ) ?? [];

        if (pools.length > 1) {
          // Check for cross-pool sequence flows
          const hasCrossPoolFlows = node.edges?.some(
            (edge) => edge.bpmn?.type === 'sequenceFlow' ||
                      edge.bpmn?.type === 'dataInputAssociation' ||
                      edge.bpmn?.type === 'dataOutputAssociation'
          );
          if (hasCrossPoolFlows) return true;
        }
      }
    }

    return false;
  }

  /**
   * Prepare children nodes for ELK layout
   */
  private prepareChildrenForElk(
    children: ElkBpmnGraph['children'],
    boundaryEventTargetIds: Set<string> = new Set(),
    mainFlowNodes: Set<string> = new Set()
  ): ElkNode[] {
    if (!children) return [];

    const result: ElkNode[] = [];

    for (const child of children) {
      const node = child as unknown as NodeWithBpmn;
      result.push(this.prepareNodeForElk(node, boundaryEventTargetIds, mainFlowNodes));

      // Add boundary events as sibling nodes (not children of the task)
      // This allows ELK to route edges from boundary events correctly
      if (node.boundaryEvents && node.boundaryEvents.length > 0) {
        for (const be of node.boundaryEvents) {
          result.push({
            id: be.id,
            width: be.width ?? 36,
            height: be.height ?? 36,
          });
        }
      }
    }

    return result;
  }

  /**
   * Prepare a single node for ELK layout
   */
  private prepareNodeForElk(
    node: NodeWithBpmn,
    boundaryEventTargetIds: Set<string> = new Set(),
    mainFlowNodes: Set<string> = new Set()
  ): ElkNode {
    let layoutOptions = node.layoutOptions as LayoutOptions | undefined;

    // Add ELK layer constraints for start/end events to ensure proper flow direction
    // startEvent should be in the first layer (leftmost in RIGHT direction)
    // endEvent should be in the last layer (rightmost in RIGHT direction)
    const nodeType = node.bpmn?.type;
    if (nodeType === 'startEvent') {
      layoutOptions = {
        ...layoutOptions,
        'elk.layered.layering.layerConstraint': 'FIRST',
      } as LayoutOptions;
    } else if (nodeType === 'endEvent') {
      layoutOptions = {
        ...layoutOptions,
        'elk.layered.layering.layerConstraint': 'LAST',
      } as LayoutOptions;
    }

    // Give main flow nodes higher priority so ELK keeps them aligned at the top
    // This ensures the primary flow path is laid out first and stays in optimal position
    if (mainFlowNodes.has(node.id)) {
      layoutOptions = {
        ...layoutOptions,
        'elk.priority': 10,
      } as LayoutOptions;
    }

    // Give boundary event targets lower priority so ELK prioritizes main flow layout
    // This helps prevent exception branches from pulling main flow nodes out of alignment
    if (boundaryEventTargetIds.has(node.id)) {
      layoutOptions = {
        ...layoutOptions,
        'elk.priority': 0,
      } as LayoutOptions;
    }

    // For expanded subprocesses, add top padding for the label header
    const isExpandedSubprocess = node.bpmn?.isExpanded === true &&
      (node.bpmn?.type === 'subProcess' || node.bpmn?.type === 'transaction' ||
       node.bpmn?.type === 'adHocSubProcess' || node.bpmn?.type === 'eventSubProcess');

    // Save user-specified padding to preserve it
    const userPadding = layoutOptions?.['elk.padding'];

    if (isExpandedSubprocess) {
      layoutOptions = {
        'elk.padding': '[top=30,left=12,bottom=30,right=12]',
        ...layoutOptions,
      } as LayoutOptions;
      // Restore user padding if specified (it takes precedence)
      if (userPadding) {
        layoutOptions['elk.padding'] = userPadding;
      }
    }

    // Check if this is a collaboration with multiple pools and cross-pool sequence flow edges
    // Only flatten nodes when there are actual sequenceFlow edges crossing pools
    // (messageFlow edges are normal for collaborations and don't require flattening)
    const isCollaboration = node.bpmn?.type === 'collaboration';
    const hasMultiplePools = isCollaboration &&
      (node.children?.filter((c) => (c as NodeWithBpmn).bpmn?.type === 'participant').length ?? 0) > 1;

    // Check if any collaboration-level edges are sequenceFlow (cross-pool flow)
    const hasCrossPoolSequenceFlows = isCollaboration && node.edges?.some(
      (edge) => edge.bpmn?.type === 'sequenceFlow' ||
                edge.bpmn?.type === 'dataInputAssociation' ||
                edge.bpmn?.type === 'dataOutputAssociation'
    );

    if (isCollaboration && hasCrossPoolSequenceFlows && hasMultiplePools) {
      // For collaborations with cross-pool edges, flatten all pool contents
      // to collaboration level for unified layout
      layoutOptions = {
        ...layoutOptions,
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.padding': '[top=12,left=12,bottom=12,right=12]',
      } as LayoutOptions;

      const elkNode: ElkNode = {
        id: node.id,
        width: node.width,
        height: node.height,
        layoutOptions,
      };

      // Flatten all pool contents to collaboration level
      const childNodes: ElkNode[] = [];
      this.extractNodesFromPools(node.children as NodeWithBpmn[], childNodes);
      elkNode.children = childNodes;

      // Copy edges to ELK format
      if (node.edges && node.edges.length > 0) {
        elkNode.edges = node.edges.map((edge) => ({
          id: edge.id,
          sources: edge.sources,
          targets: edge.targets,
          layoutOptions: edge.layoutOptions as LayoutOptions | undefined,
          labels: edge.labels?.map((l) => ({
            text: l.text,
            width: l.width ?? 50,
            height: l.height ?? 14,
          })),
        })) as ElkExtendedEdge[];
      }

      return elkNode;
    }

    // Check if this is a pool (participant)
    const isPool = node.bpmn?.type === 'participant';
    const hasLanes = isPool &&
      node.children?.some((c) => (c as NodeWithBpmn).bpmn?.type === 'lane');

    if (hasLanes) {
      // For pools with lanes, use a different layout strategy:
      // - Use partitioning to create horizontal swim lanes (rows, not columns)
      // - Set direction to RIGHT for flow within lanes
      // - Use 'elk.partitioning.activate' with vertical partitions
      layoutOptions = {
        ...layoutOptions,
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        // Remove partitioning - we'll handle lane stacking differently
        'elk.partitioning.activate': 'false',
        // Add padding for lane header (left side)
        'elk.padding': '[top=12,left=30,bottom=12,right=12]',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      } as LayoutOptions;
    } else if (isPool) {
      // For pools without lanes, still add left padding for pool label
      layoutOptions = {
        ...layoutOptions,
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        // Add padding for pool header (left side) - 55px to accommodate vertical label
        'elk.padding': '[top=12,left=55,bottom=12,right=12]',
      } as LayoutOptions;
    }

    // Check if this is a lane
    const isLane = node.bpmn?.type === 'lane';
    if (isLane) {
      // For lanes, don't set separate layout algorithm - let parent pool handle layout
      // Just set padding for content spacing
      layoutOptions = {
        'elk.padding': '[top=12,left=12,bottom=12,right=12]',
      } as LayoutOptions;
    }

    const elkNode: ElkNode = {
      id: node.id,
      width: node.width,
      height: node.height,
      layoutOptions,
    };

    // Process children (including boundary events as siblings)
    if (node.children && node.children.length > 0) {
      const childNodes: ElkNode[] = [];

      // For pools with lanes, flatten all lane contents to pool level for unified layout
      // This allows ELK to consider cross-lane edges when positioning nodes
      if (hasLanes) {
        // Recursively extract all flow nodes from lanes (including nested lanes)
        this.extractNodesFromLanes(node.children as NodeWithBpmn[], childNodes);
      } else {
        // Normal processing for non-lane containers
        for (const child of node.children) {
          const childNode = child as NodeWithBpmn;
          childNodes.push(this.prepareNodeForElk(childNode, boundaryEventTargetIds));

          // Add boundary events as siblings
          if (childNode.boundaryEvents && childNode.boundaryEvents.length > 0) {
            for (const be of childNode.boundaryEvents) {
              childNodes.push({
                id: be.id,
                width: be.width ?? 36,
                height: be.height ?? 36,
              });
            }
          }
        }
      }
      elkNode.children = childNodes;
    }

    // Process edges
    if (node.edges && node.edges.length > 0) {
      elkNode.edges = node.edges.map((edge) => ({
        id: edge.id,
        sources: edge.sources,
        targets: edge.targets,
        layoutOptions: edge.layoutOptions as LayoutOptions | undefined,
        labels: edge.labels?.map((l) => ({
          text: l.text,
          width: l.width ?? 50,
          height: l.height ?? 14,
        })),
      })) as ElkExtendedEdge[];
    }

    // Boundary events are added as siblings (not children) for ELK edge routing
    // Their actual visual positions are recalculated in model-builder.ts

    // Process labels - ensure all labels have dimensions (ELK requires this)
    if (node.labels && node.labels.length > 0) {
      elkNode.labels = node.labels.map((l) => ({
        text: l.text,
        width: l.width ?? this.sizeCalculator.estimateLabelWidth(l.text),
        height: l.height ?? 14,
      }));
    }

    // Process ports
    if (node.ports && node.ports.length > 0) {
      elkNode.ports = node.ports.map((p) => ({
        id: p.id,
        width: p.width ?? 10,
        height: p.height ?? 10,
      }));
    }

    return elkNode;
  }

  /**
   * Extract all flow nodes from pools to flatten them for unified layout
   * This is used for collaborations with cross-pool edges
   */
  private extractNodesFromPools(children: NodeWithBpmn[], result: ElkNode[]): void {
    for (const child of children) {
      if (child.bpmn?.type === 'participant') {
        // Check if this is an empty/black box pool
        const isEmpty = !child.children || child.children.length === 0;

        if (isEmpty) {
          // Add the pool itself as a node (for message flows targeting the pool)
          result.push({
            id: child.id,
            width: child.width ?? 680,
            height: child.height ?? 60,
          });
        } else {
          // Extract nodes from this pool
          // Check if pool has lanes
            const hasLanes = child.children!.some((c) => (c as NodeWithBpmn).bpmn?.type === 'lane');
            if (hasLanes) {
              this.extractNodesFromLanes(child.children! as NodeWithBpmn[], result);
          } else {
            // Direct children of pool (no lanes)
            for (const poolChild of child.children!) {
              const node = poolChild as NodeWithBpmn;
              result.push(this.prepareNodeForElk(node));

              // Add boundary events as siblings
              if (node.boundaryEvents && node.boundaryEvents.length > 0) {
                for (const be of node.boundaryEvents) {
                  result.push({
                    id: be.id,
                    width: be.width ?? 36,
                    height: be.height ?? 36,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  /**
   * Recursively extract all flow nodes from lanes (including nested lanes)
   * and add them to the result array for unified ELK layout
   */
  private extractNodesFromLanes(children: NodeWithBpmn[], result: ElkNode[]): void {
    for (const child of children) {
      if (child.bpmn?.type === 'lane') {
        // Recursively extract from nested lanes
        if (child.children) {
          this.extractNodesFromLanes(child.children as NodeWithBpmn[], result);
        }
      } else {
        // Non-lane node - add to result
        result.push(this.prepareNodeForElk(child));

        // Add boundary events as siblings
        if (child.boundaryEvents && child.boundaryEvents.length > 0) {
          for (const be of child.boundaryEvents) {
            result.push({
              id: be.id,
              width: be.width ?? 36,
              height: be.height ?? 36,
            });
          }
        }
      }
    }
  }

  /**
   * Merge ELK layout results back with original BPMN metadata
   */
  private mergeLayoutResults(
    original: ElkBpmnGraph,
    layouted: ElkNode
  ): LayoutedGraph {
    const result: LayoutedGraph = {
      ...original,
      x: layouted.x,
      y: layouted.y,
      width: layouted.width,
      height: layouted.height,
      children: [],
    };

    // Merge children by ID
    if (original.children && layouted.children) {
      const layoutedChildMap = new Map(layouted.children.map((c) => [c.id, c]));

      result.children = original.children.map((origChild) => {
          const layoutedChild = layoutedChildMap.get(origChild.id);
          if (layoutedChild) {
            return this.mergeNodeResults(
              origChild as unknown as NodeWithBpmn,
              layoutedChild
            );
          }
          return origChild as unknown as LayoutedGraph['children'][number];
        }) as (LayoutedGraph['children'][number])[];
    }

    return result;
  }

  /**
   * Merge layout results for a single node
   */
  private mergeNodeResults(original: NodeWithBpmn, layouted: ElkNode): NodeWithBpmn {
    const result: NodeWithBpmn = {
      ...original,
      x: layouted.x ?? 0,
      y: layouted.y ?? 0,
      width: layouted.width ?? original.width,
      height: layouted.height ?? original.height,
    };

    // Merge children
    if (original.children && layouted.children) {
      // Filter out boundary events from layouted children
      const layoutedChildMap = new Map(layouted.children.map((c) => [c.id, c]));

      result.children = original.children.map((origChild) => {
        const layoutedChild = layoutedChildMap.get((origChild as NodeWithBpmn).id);
        if (layoutedChild) {
          return this.mergeNodeResults(origChild as NodeWithBpmn, layoutedChild);
        }
        return origChild;
      });
    }

    // Keep boundary events as-is (their positions are calculated in model-builder.ts)
    if (original.boundaryEvents) {
      result.boundaryEvents = original.boundaryEvents;
    }

    // Merge edges
    if (original.edges && layouted.edges) {
      const layoutedEdgeMap = new Map(layouted.edges.map((e) => [e.id, e]));

      result.edges = original.edges.map((origEdge) => {
        const layoutedEdge = layoutedEdgeMap.get(origEdge.id);
        if (layoutedEdge) {
          if (DEBUG && layoutedEdge.sections?.[0]?.bendPoints?.length) {
            console.log(`[BPMN] Merge ${origEdge.id}: bendPoints=${JSON.stringify(layoutedEdge.sections[0].bendPoints)}`);
          }
          const mergedEdge: typeof origEdge & { _absoluteCoords?: boolean; _poolRelativeCoords?: boolean } = {
            ...origEdge,
            sections: layoutedEdge.sections ?? [],
            labels: origEdge.labels?.map((label, idx) => {
              const layoutedLabel = layoutedEdge.labels?.[idx];
              if (layoutedLabel) {
                return {
                  ...label,
                  x: layoutedLabel.x ?? 0,
                  y: layoutedLabel.y ?? 0,
                  width: layoutedLabel.width ?? label.width ?? 50,
                  height: layoutedLabel.height ?? label.height ?? 14,
                };
              }
              return label;
            }),
          };
          // Preserve the _absoluteCoords flag for message flows
          if ((layoutedEdge as { _absoluteCoords?: boolean })._absoluteCoords) {
            mergedEdge._absoluteCoords = true;
          }
          // Preserve the _poolRelativeCoords flag for pool edges
          if ((layoutedEdge as { _poolRelativeCoords?: boolean })._poolRelativeCoords) {
            mergedEdge._poolRelativeCoords = true;
          }
          return mergedEdge;
        }
        return origEdge;
      });
    }

    // Merge labels
    if (original.labels && layouted.labels) {
      result.labels = original.labels.map((label, idx) => {
        const layoutedLabel = layouted.labels?.[idx];
        if (layoutedLabel) {
          return {
            ...label,
            x: layoutedLabel.x ?? 0,
            y: layoutedLabel.y ?? 0,
            width: layoutedLabel.width ?? label.width,
            height: layoutedLabel.height ?? label.height,
          };
        }
        return label;
      });
    }

    return result;
  }
}
