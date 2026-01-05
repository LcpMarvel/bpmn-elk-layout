/**
 * ELK Layout Engine Wrapper
 * Orchestrates the BPMN layout pipeline using specialized handlers.
 */

import ELK from 'elkjs';
import type { ElkNode } from 'elkjs';
import type { ElkBpmnGraph, ElkLayoutOptions } from '../types';
import type { LayoutedGraph } from '../types/elk-output';
import type { NodeMoveInfo } from '../types/internal';
import { SizeCalculator } from './size-calculator';
import { EdgeFixer } from './edge-routing/edge-fixer';
import { BoundaryEventHandler } from './post-processing/boundary-event';
import { ArtifactPositioner } from './post-processing/artifact-positioner';
import { GroupPositioner } from './post-processing/group-positioner';
import { LaneArranger } from './post-processing/lane-arranger';
import { PoolArranger } from './post-processing/pool-arranger';
import { GatewayEdgeAdjuster } from './post-processing/gateway-edge-adjuster';
import { ElkGraphPreparer } from './preparation/elk-graph-preparer';
import { ResultMerger } from './preparation/result-merger';
import { MainFlowNormalizer } from './normalization/main-flow-normalizer';
import { GatewayPropagator } from './normalization/gateway-propagator';
import { isDebugEnabled } from '../utils/debug';

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
  private graphPreparer: ElkGraphPreparer;
  private resultMerger: ResultMerger;
  private mainFlowNormalizer: MainFlowNormalizer;
  private gatewayPropagator: GatewayPropagator;

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
    this.graphPreparer = new ElkGraphPreparer();
    this.resultMerger = new ResultMerger();
    this.mainFlowNormalizer = new MainFlowNormalizer();
    this.gatewayPropagator = new GatewayPropagator();
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
    const boundaryEventTargetIds = this.graphPreparer.collectBoundaryEventTargetIds(boundaryEventInfo);

    // Collect artifact association info for post-processing
    const artifactInfo = this.artifactPositioner.collectInfo(sizedGraph);

    // Collect Group info for post-processing (Groups will be repositioned after layout)
    const groupInfo = this.groupPositioner.collectInfo(sizedGraph);

    // Prepare graph for ELK (convert to ELK format)
    const elkGraph = this.graphPreparer.prepare(sizedGraph, this.userOptions, boundaryEventTargetIds);

    // Run ELK layout
    const layoutedElkGraph = await this.elk.layout(elkGraph);

    // Identify main flow nodes for normalization
    const mainFlowNodes = this.graphPreparer.identifyMainFlowNodes(sizedGraph, boundaryEventTargetIds);

    // Normalize main flow to the top of the diagram
    // This ensures the primary flow path stays at a consistent Y position
    this.mainFlowNormalizer.normalize(layoutedElkGraph, mainFlowNodes, boundaryEventTargetIds, sizedGraph);

    // Check if boundary event targets need repositioning
    // Pass sizedGraph to access node type information (bpmn.type) which is not preserved in ELK graph
    const movedNodes = this.boundaryEventHandler.identifyNodesToMove(layoutedElkGraph, boundaryEventInfo, sizedGraph, isDebugEnabled());

    if (movedNodes.size > 0) {
      // Move nodes and recalculate affected edges
      this.boundaryEventHandler.applyNodeMoves(layoutedElkGraph, movedNodes);

      // Reposition converging gateways based on incoming edge positions
      const gatewayMoves = this.boundaryEventHandler.repositionConvergingGateways(
        layoutedElkGraph, movedNodes, boundaryEventInfo, isDebugEnabled()
      );

      if (gatewayMoves.size > 0) {
        // Apply gateway moves
        this.boundaryEventHandler.applyNodeMoves(layoutedElkGraph, gatewayMoves);

        // Also move downstream nodes of the gateway
        this.gatewayPropagator.propagate(layoutedElkGraph, gatewayMoves, mainFlowNodes);
      }

      // Merge gateway moves into movedNodes for edge recalculation
      for (const [id, move] of gatewayMoves) {
        movedNodes.set(id, move);
      }

      this.boundaryEventHandler.recalculateEdgesForMovedNodes(layoutedElkGraph, movedNodes, boundaryEventInfo);
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
    return this.resultMerger.merge(sizedGraph, layoutedElkGraph);
  }

  /**
   * Update container bounds to include all children after post-processing
   * This is needed because post-processing may move nodes outside the original ELK-calculated bounds
   */
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
}
