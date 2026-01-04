/**
 * ELK Layout Engine Wrapper
 */

import ELK from 'elkjs';
import type { ElkNode, ElkExtendedEdge, LayoutOptions } from 'elkjs';
import type { ElkBpmnGraph, ElkLayoutOptions } from '../types';
import type { LayoutedGraph } from '../types/elk-output';
import type { NodeWithBpmn } from '../types/internal';
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

    // Collect artifact association info for post-processing
    const artifactInfo = this.artifactPositioner.collectInfo(sizedGraph);

    // Collect Group info for post-processing (Groups will be repositioned after layout)
    const groupInfo = this.groupPositioner.collectInfo(sizedGraph);

    // Prepare graph for ELK (convert to ELK format)
    const elkGraph = this.prepareForElk(sizedGraph);

    // Run ELK layout
    const layoutedElkGraph = await this.elk.layout(elkGraph);

    // Check if boundary event targets need repositioning
    const movedNodes = this.boundaryEventHandler.identifyNodesToMove(layoutedElkGraph, boundaryEventInfo, DEBUG);

    if (movedNodes.size > 0) {
      // Move nodes and recalculate affected edges
      this.boundaryEventHandler.applyNodeMoves(layoutedElkGraph, movedNodes);
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

    // Note: Gateway edge endpoint adjustment is now handled in model-builder.ts
    // during the buildEdge() step, which has access to the correct coordinate system.

    // Merge layout results back with BPMN metadata
    return this.mergeLayoutResults(sizedGraph, layoutedElkGraph);
  }

  /**
   * Prepare the BPMN graph for ELK layout
   */
  private prepareForElk(graph: ElkBpmnGraph): ElkNode {
    let layoutOptions: LayoutOptions = mergeElkOptions(this.userOptions, graph.layoutOptions) as LayoutOptions;

    // Check if this graph contains a cross-pool collaboration
    // If so, force RIGHT direction for better horizontal layout
    if (this.hasCrossPoolCollaboration(graph)) {
      layoutOptions = {
        ...layoutOptions,
        'elk.direction': 'RIGHT',
      };
    }

    return {
      id: graph.id ?? 'root',
      layoutOptions,
      children: this.prepareChildrenForElk(graph.children),
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
  private prepareChildrenForElk(children: ElkBpmnGraph['children']): ElkNode[] {
    if (!children) return [];

    const result: ElkNode[] = [];

    for (const child of children) {
      const node = child as unknown as NodeWithBpmn;
      result.push(this.prepareNodeForElk(node));

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
  private prepareNodeForElk(node: NodeWithBpmn): ElkNode {
    let layoutOptions = node.layoutOptions as LayoutOptions | undefined;

    // For expanded subprocesses, add top padding for the label header
    const isExpandedSubprocess = node.bpmn?.isExpanded === true &&
      (node.bpmn?.type === 'subProcess' || node.bpmn?.type === 'transaction' ||
       node.bpmn?.type === 'adHocSubProcess' || node.bpmn?.type === 'eventSubProcess');

    if (isExpandedSubprocess) {
      layoutOptions = {
        ...layoutOptions,
        'elk.padding': '[top=30,left=12,bottom=30,right=12]',
      } as LayoutOptions;
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
          childNodes.push(this.prepareNodeForElk(childNode));

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
