/**
 * Boundary Event Post-Processing Module
 * Re-exports all boundary event related functionality.
 */

import type { ElkNode } from 'elkjs';
import type { ElkBpmnGraph } from '../../../types';
import type { BoundaryEventInfo, NodeMoveInfo } from '../../../types/internal';

// Export collector function
export { collectBoundaryEventInfo } from './collector';

// Export mover functions
export {
  identifyNodesToMove,
  repositionConvergingGateways,
  applyNodeMoves,
  propagateMovement,
  BranchDestType,
} from './mover';

// Export edge recalculator functions
export {
  recalculateEdgesForMovedNodes,
  recalculateEdgeWithObstacleAvoidance,
  findBlockingObstacles,
} from './edge-recalculator';

// Import for class implementation
import { collectBoundaryEventInfo } from './collector';
import {
  identifyNodesToMove,
  repositionConvergingGateways,
  applyNodeMoves,
} from './mover';
import { recalculateEdgesForMovedNodes } from './edge-recalculator';

/**
 * Handler for boundary event post-processing
 * Wraps the extracted functions in a class interface for backward compatibility.
 */
export class BoundaryEventHandler {
  /**
   * Collect boundary event information for post-processing
   * Returns a map of boundary event ID -> { attachedToRef, targets, boundaryIndex, totalBoundaries }
   */
  collectInfo(graph: ElkBpmnGraph): Map<string, BoundaryEventInfo> {
    return collectBoundaryEventInfo(graph);
  }

  /**
   * Identify nodes that need to be moved below their attached boundary event parent
   * Returns a map of node ID -> new position info
   */
  identifyNodesToMove(
    graph: ElkNode,
    boundaryEventInfo: Map<string, BoundaryEventInfo>,
    sizedGraph: ElkBpmnGraph,
    debug = false
  ): Map<string, NodeMoveInfo> {
    return identifyNodesToMove(graph, boundaryEventInfo, sizedGraph, debug);
  }

  /**
   * Reposition converging gateways based on their incoming edges.
   */
  repositionConvergingGateways(
    graph: ElkNode,
    movedNodes: Map<string, NodeMoveInfo>,
    boundaryEventInfo: Map<string, BoundaryEventInfo>,
    debug = false
  ): Map<string, NodeMoveInfo> {
    return repositionConvergingGateways(graph, movedNodes, boundaryEventInfo, debug);
  }

  /**
   * Apply node moves to the layouted graph
   */
  applyNodeMoves(graph: ElkNode, movedNodes: Map<string, NodeMoveInfo>): void {
    applyNodeMoves(graph, movedNodes);
  }

  /**
   * Recalculate edge waypoints for edges connected to moved nodes
   */
  recalculateEdgesForMovedNodes(
    graph: ElkNode,
    movedNodes: Map<string, NodeMoveInfo>,
    boundaryEventInfo: Map<string, BoundaryEventInfo>
  ): void {
    recalculateEdgesForMovedNodes(graph, movedNodes, boundaryEventInfo);
  }
}
