/**
 * ELK Layout Engine Wrapper
 * Orchestrates the BPMN layout pipeline using specialized handlers.
 *
 * Lightweight post-processing: Only repositions boundary event targets below main flow.
 * ELK handles all edge routing.
 */

import ELK from 'elkjs';
import type { ElkNode } from 'elkjs';
import type { ElkBpmnGraph, ElkLayoutOptions } from '../types';
import type { LayoutedGraph } from '../types/elk-output';
import { SizeCalculator } from './size-calculator';
import { BoundaryEventHandler } from './post-processing/boundary-event';
import { ArtifactPositioner } from './post-processing/artifact-positioner';
import { GroupPositioner } from './post-processing/group-positioner';
import { LaneArranger } from './post-processing/lane-arranger';
import { PoolArranger } from './post-processing/pool-arranger';
import { Compactor } from './post-processing/compactor';
import { ElkGraphPreparer } from './preparation/elk-graph-preparer';
import { ResultMerger } from './preparation/result-merger';
import { isDebugEnabled } from '../utils/debug';

export interface ElkLayouterOptions {
  elkOptions?: ElkLayoutOptions;
  /** Enable layout compaction to reduce whitespace */
  enableCompaction?: boolean;
}

export class ElkLayouter {
  private elk: InstanceType<typeof ELK>;
  private userOptions: ElkLayoutOptions;
  private enableCompaction: boolean;
  private sizeCalculator: SizeCalculator;
  private boundaryEventHandler: BoundaryEventHandler;
  private artifactPositioner: ArtifactPositioner;
  private groupPositioner: GroupPositioner;
  private laneArranger: LaneArranger;
  private poolArranger: PoolArranger;
  private compactor: Compactor;
  private graphPreparer: ElkGraphPreparer;
  private resultMerger: ResultMerger;

  constructor(options?: ElkLayouterOptions) {
    this.elk = new ELK();
    this.userOptions = options?.elkOptions ?? {};
    this.enableCompaction = options?.enableCompaction ?? false;
    this.sizeCalculator = new SizeCalculator();
    this.boundaryEventHandler = new BoundaryEventHandler();
    this.artifactPositioner = new ArtifactPositioner();
    this.groupPositioner = new GroupPositioner();
    this.laneArranger = new LaneArranger();
    this.poolArranger = new PoolArranger();
    this.compactor = new Compactor();
    this.graphPreparer = new ElkGraphPreparer();
    this.resultMerger = new ResultMerger();
  }

  /**
   * Run ELK layout on the graph
   */
  async layout(graph: ElkBpmnGraph): Promise<LayoutedGraph> {
    // Deep clone to avoid mutating the original
    const graphCopy = JSON.parse(JSON.stringify(graph)) as ElkBpmnGraph;

    // Apply default sizes to all nodes
    const sizedGraph = this.sizeCalculator.applyDefaultSizes(graphCopy);

    // Collect boundary event info - used to set ELK constraints for target nodes
    const boundaryEventInfo = this.boundaryEventHandler.collectInfo(sizedGraph);

    // Collect boundary event target IDs for ELK constraint assignment
    const boundaryEventTargetIds = this.graphPreparer.collectBoundaryEventTargetIds(boundaryEventInfo);

    // Collect artifact association info for post-processing
    const artifactInfo = this.artifactPositioner.collectInfo(sizedGraph);

    // Collect Group info for post-processing (Groups will be repositioned after layout)
    const groupInfo = this.groupPositioner.collectInfo(sizedGraph);

    // Prepare graph for ELK (convert to ELK format)
    // Pass boundaryEventTargetIds so ELK can apply position constraints
    const elkGraph = this.graphPreparer.prepare(sizedGraph, this.userOptions, boundaryEventTargetIds);

    // Run ELK layout
    const layoutedElkGraph = await this.elk.layout(elkGraph);

    // Lightweight post-processing: Move boundary event targets below their attached tasks
    // This is BPMN-specific positioning that ELK cannot handle via constraints
    const movedNodes = this.boundaryEventHandler.identifyNodesToMove(
      layoutedElkGraph, boundaryEventInfo, sizedGraph, isDebugEnabled()
    );

    if (movedNodes.size > 0) {
      // Move nodes
      this.boundaryEventHandler.applyNodeMoves(layoutedElkGraph, movedNodes);
      // Recalculate edges for moved nodes
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

    // Apply layout compaction to reduce whitespace (if enabled)
    if (this.enableCompaction) {
      this.compactor.compact(layoutedElkGraph);
    }

    // Update container bounds to include all moved children
    this.updateContainerBounds(layoutedElkGraph);

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
