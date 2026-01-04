/**
 * ELK Graph Preparer
 * Prepares BPMN graphs for ELK layout by:
 * - Merging layout options
 * - Converting to ELK-compatible format
 * - Flattening pool/lane structures when needed for cross-pool edges
 * - Handling boundary events as siblings for proper edge routing
 */

import type { ElkNode, ElkExtendedEdge, LayoutOptions } from 'elkjs';
import type { ElkBpmnGraph } from '../../types';
import type { NodeWithBpmn } from '../../types/internal';
import { mergeElkOptions } from '../default-options';

/**
 * Handler for preparing graphs for ELK layout
 */
export class ElkGraphPreparer {
  /**
   * Prepare the graph for ELK layout
   */
  prepare(graph: ElkBpmnGraph, userOptions: Record<string, unknown> = {}): ElkNode {
    let layoutOptions = mergeElkOptions(userOptions as Record<string, string | number | boolean | undefined>, graph.layoutOptions);

    // Check if this graph contains a cross-pool collaboration
    // If so, force RIGHT direction for better horizontal layout
    if (this.hasCrossPoolCollaboration(graph)) {
      layoutOptions = {
        ...layoutOptions,
        'elk.direction': 'RIGHT',
      };
    }

    return {
      id: graph.id,
      layoutOptions: layoutOptions as LayoutOptions,
      children: this.prepareChildrenForElk(graph.children),
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
   * Prepare children for ELK layout
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
        elkNode.edges = this.prepareEdges(node.edges);
      }

      return elkNode;
    }

    // Check if this is a pool (participant)
    const isPool = node.bpmn?.type === 'participant';
    const hasLanes = isPool &&
      (node.children as NodeWithBpmn[] | undefined)?.some((c) => c.bpmn?.type === 'lane');

    if (hasLanes) {
      layoutOptions = {
        ...layoutOptions,
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.partitioning.activate': 'false',
        'elk.padding': '[top=12,left=30,bottom=12,right=12]',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      } as LayoutOptions;
    } else if (isPool) {
      layoutOptions = {
        ...layoutOptions,
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.padding': '[top=12,left=55,bottom=12,right=12]',
      } as LayoutOptions;
    }

    // Check if this is a lane
    const isLane = node.bpmn?.type === 'lane';
    if (isLane) {
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

    // Process children
    if (node.children && node.children.length > 0) {
      const childNodes: ElkNode[] = [];

      if (hasLanes) {
        // Flatten lane contents to pool level for unified layout
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
      elkNode.edges = this.prepareEdges(node.edges);
    }

    // Process labels
    if (node.labels && node.labels.length > 0) {
      elkNode.labels = node.labels.map((l) => ({
        text: l.text,
        width: l.width ?? this.estimateLabelWidth(l.text),
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
   */
  private extractNodesFromPools(children: NodeWithBpmn[], result: ElkNode[]): void {
    for (const child of children) {
      if (child.bpmn?.type === 'participant') {
        const isEmpty = !child.children || child.children.length === 0;

        if (isEmpty) {
          // Add the pool itself as a node (for message flows targeting the pool)
          result.push({
            id: child.id,
            width: child.width ?? 680,
            height: child.height ?? 60,
          });
        } else {
          // Check if pool has lanes
          const hasLanes = child.children!.some((c) => (c as NodeWithBpmn).bpmn?.type === 'lane');
          if (hasLanes) {
            this.extractNodesFromLanes(child.children! as NodeWithBpmn[], result);
          } else {
            // Direct children of pool (no lanes)
            for (const poolChild of child.children!) {
              const node = poolChild as NodeWithBpmn;
              result.push(this.prepareNodeForElk(node));

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
   * Extract all flow nodes from lanes (including nested lanes)
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
   * Estimate label width based on text content
   */
  private estimateLabelWidth(text?: string): number {
    if (!text) return 50;

    let width = 0;
    for (const char of text) {
      // CJK characters are wider
      if (char.charCodeAt(0) > 255) {
        width += 14;
      } else {
        width += 7;
      }
    }

    return Math.max(30, Math.min(width, 200));
  }
}
