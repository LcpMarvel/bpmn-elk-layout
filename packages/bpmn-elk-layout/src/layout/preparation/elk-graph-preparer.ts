/**
 * ELK Graph Preparer
 * Prepares BPMN graphs for ELK layout by:
 * - Merging layout options
 * - Converting to ELK-compatible format
 * - Flattening pool/lane structures when needed for cross-pool edges
 * - Handling boundary events as siblings for proper edge routing
 * - Identifying main flow nodes for layout priority
 */

import type { ElkNode, ElkExtendedEdge, LayoutOptions } from 'elkjs';
import type { ElkBpmnGraph } from '../../types';
import type { NodeWithBpmn, BoundaryEventInfo } from '../../types/internal';
import { mergeElkOptions } from '../default-options';
import { SizeCalculator } from '../size-calculator';
import { DEBUG } from '../../utils/debug';

/**
 * Handler for preparing graphs for ELK layout
 */
export class ElkGraphPreparer {
  private sizeCalculator: SizeCalculator;

  constructor() {
    this.sizeCalculator = new SizeCalculator();
  }

  /**
   * Prepare the graph for ELK layout
   */
  prepare(
    graph: ElkBpmnGraph,
    userOptions: Record<string, unknown> = {},
    boundaryEventTargetIds: Set<string> = new Set()
  ): ElkNode {
    let layoutOptions = mergeElkOptions(userOptions as Record<string, string | number | boolean | undefined>, graph.layoutOptions);

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
      layoutOptions: layoutOptions as LayoutOptions,
      children: this.prepareChildrenForElk(graph.children, boundaryEventTargetIds, mainFlowNodes),
    };
  }

  /**
   * Check if the graph contains a collaboration with cross-pool sequence flows
   */
  hasCrossPoolCollaboration(graph: ElkBpmnGraph): boolean {
    if (!graph.children) return false;

    for (const child of graph.children) {
      const node = child as unknown as NodeWithBpmn;
      if (node.bpmn?.type !== 'collaboration') continue;

      // Check if collaboration has multiple pools
      const pools = (node.children as NodeWithBpmn[] | undefined)?.filter(
        c => c.bpmn?.type === 'participant'
      ) ?? [];
      if (pools.length <= 1) continue;

      // Check if collaboration has cross-pool sequence flows
      const hasCrossPoolFlows = node.edges?.some(
        edge => edge.bpmn?.type === 'sequenceFlow' ||
                edge.bpmn?.type === 'dataInputAssociation' ||
                edge.bpmn?.type === 'dataOutputAssociation'
      );

      if (hasCrossPoolFlows) return true;
    }

    return false;
  }

  /**
   * Collect all boundary event target IDs from boundary event info
   */
  collectBoundaryEventTargetIds(boundaryEventInfo: Map<string, BoundaryEventInfo>): Set<string> {
    const targetIds = new Set<string>();
    for (const [_beId, info] of boundaryEventInfo) {
      for (const targetId of info.targets) {
        targetIds.add(targetId);
      }
    }
    return targetIds;
  }

  /**
   * Collect all boundary event IDs and their target nodes from edges
   */
  collectBoundaryEventTargets(node: NodeWithBpmn): Set<string> {
    const boundaryEventIds = new Set<string>();
    const targetNodeIds = new Set<string>();

    // Collect boundary event IDs from this node and children
    const collectBoundaryEventIds = (n: NodeWithBpmn) => {
      if (n.boundaryEvents) {
        for (const be of n.boundaryEvents) {
          boundaryEventIds.add(be.id);
        }
      }
      if (n.children) {
        for (const child of n.children) {
          collectBoundaryEventIds(child as NodeWithBpmn);
        }
      }
    };
    collectBoundaryEventIds(node);

    // Find edges where source is a boundary event
    const findTargets = (n: NodeWithBpmn) => {
      if (n.edges) {
        for (const edge of n.edges) {
          const sourceId = edge.sources[0];
          if (boundaryEventIds.has(sourceId)) {
            targetNodeIds.add(edge.targets[0]);
          }
        }
      }
      if (n.children) {
        for (const child of n.children) {
          findTargets(child as NodeWithBpmn);
        }
      }
    };
    findTargets(node);

    return targetNodeIds;
  }

  /**
   * Identify main flow nodes - nodes that are in the primary path from start to end,
   * not including boundary event branches.
   * Main flow nodes should be prioritized in layout to stay at the top.
   */
  identifyMainFlowNodes(graph: ElkBpmnGraph, boundaryEventTargetIds: Set<string>): Set<string> {
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
   * Prepare children for ELK layout
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
        'elk.priority': '10',
      } as LayoutOptions;
    }

    // Give boundary event targets lower priority so ELK prioritizes main flow layout
    // This helps prevent exception branches from pulling main flow nodes out of alignment
    if (boundaryEventTargetIds.has(node.id)) {
      layoutOptions = {
        ...layoutOptions,
        'elk.priority': '0',
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
      ((node.children as NodeWithBpmn[] | undefined)?.filter((c) => c.bpmn?.type === 'participant').length ?? 0) > 1;

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
      this.extractNodesFromPools(node.children as NodeWithBpmn[], childNodes, boundaryEventTargetIds, mainFlowNodes);
      elkNode.children = childNodes;

      // Copy edges to ELK format
      if (node.edges && node.edges.length > 0) {
        elkNode.edges = this.prepareEdges(node.edges);
      }

      return elkNode;
    }

    // Check if this is a pool (participant)
    const isPool = node.bpmn?.type === 'participant';
    const hasLanes = isPool &&
      (node.children as NodeWithBpmn[] | undefined)?.some((c) => c.bpmn?.type === 'lane');

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
        this.extractNodesFromLanes(node.children as NodeWithBpmn[], childNodes, boundaryEventTargetIds, mainFlowNodes);
      } else {
        // Normal processing for non-lane containers
        for (const child of node.children) {
          const childNode = child as NodeWithBpmn;
          childNodes.push(this.prepareNodeForElk(childNode, boundaryEventTargetIds, mainFlowNodes));

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
      elkNode.edges = this.prepareEdges(node.edges);
    }

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
   * Prepare edges for ELK format
   */
  private prepareEdges(edges: NodeWithBpmn['edges']): ElkExtendedEdge[] {
    if (!edges) return [];

    return edges.map((edge) => ({
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

  /**
   * Extract all flow nodes from pools to flatten them for unified layout
   * This is used for collaborations with cross-pool edges
   */
  private extractNodesFromPools(
    children: NodeWithBpmn[],
    result: ElkNode[],
    boundaryEventTargetIds: Set<string> = new Set(),
    mainFlowNodes: Set<string> = new Set()
  ): void {
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
            this.extractNodesFromLanes(child.children! as NodeWithBpmn[], result, boundaryEventTargetIds, mainFlowNodes);
          } else {
            // Direct children of pool (no lanes)
            for (const poolChild of child.children!) {
              const node = poolChild as NodeWithBpmn;
              result.push(this.prepareNodeForElk(node, boundaryEventTargetIds, mainFlowNodes));

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
  private extractNodesFromLanes(
    children: NodeWithBpmn[],
    result: ElkNode[],
    boundaryEventTargetIds: Set<string> = new Set(),
    mainFlowNodes: Set<string> = new Set()
  ): void {
    for (const child of children) {
      if (child.bpmn?.type === 'lane') {
        // Recursively extract from nested lanes
        if (child.children) {
          this.extractNodesFromLanes(child.children as NodeWithBpmn[], result, boundaryEventTargetIds, mainFlowNodes);
        }
      } else {
        // Non-lane node - add to result
        result.push(this.prepareNodeForElk(child, boundaryEventTargetIds, mainFlowNodes));

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
}
