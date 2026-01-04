/**
 * Gateway Propagator
 * Propagates gateway movement to downstream nodes.
 * When a gateway is moved, its downstream nodes in the main flow
 * need to be repositioned accordingly to maintain proper layout.
 */

import type { ElkNode } from 'elkjs';
import type { NodeMoveInfo } from '../../types/internal';
import { DEBUG } from '../../utils/debug';

/**
 * Handler for propagating gateway movement to downstream nodes
 */
export class GatewayPropagator {
  /**
   * Propagate gateway movement to downstream nodes (nodes after the gateway in the flow)
   */
  propagate(
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
}
