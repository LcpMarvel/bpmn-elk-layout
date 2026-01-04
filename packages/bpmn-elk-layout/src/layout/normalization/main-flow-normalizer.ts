/**
 * Main Flow Normalizer
 * Normalizes main flow position to keep it at the top of the diagram.
 * ELK may place the main flow lower to accommodate boundary event branches,
 * but we want the main flow to stay at a consistent top position.
 */

import type { ElkNode } from 'elkjs';
import type { ElkBpmnGraph } from '../../types';
import type { NodeWithBpmn } from '../../types/internal';
import { DEBUG } from '../../utils/debug';

const TARGET_MAIN_FLOW_Y = 12; // Target Y position for main flow (with padding)
const GATEWAY_OFFSET_Y = 150; // How far below main flow the converging gateway should be

/**
 * Handler for normalizing main flow position
 */
export class MainFlowNormalizer {
  /**
   * Normalize main flow position to keep it at the top of the diagram.
   *
   * Strategy:
   * 1. Identify "upstream main flow" nodes (before converging gateway)
   * 2. Shift these nodes up to target Y
   * 3. Position converging gateway below the main flow
   * 4. Position downstream nodes (after gateway) relative to gateway
   */
  normalize(
    graph: ElkNode,
    mainFlowNodes: Set<string>,
    boundaryEventTargetIds: Set<string>,
    originalGraph: ElkBpmnGraph
  ): void {
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
   * Update edges after normalization to adjust waypoints
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
}
