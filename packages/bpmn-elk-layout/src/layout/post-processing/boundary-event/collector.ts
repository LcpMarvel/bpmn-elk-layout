/**
 * Boundary Event Collector
 * Collects boundary event information from the BPMN graph for post-processing.
 */

import type { ElkBpmnGraph } from '../../../types';
import type { NodeWithBpmn, BoundaryEventInfo } from '../../../types/internal';

/**
 * Collect boundary event information for post-processing.
 * Returns a map of boundary event ID -> { attachedToRef, targets, boundaryIndex, totalBoundaries }
 *
 * @param graph - The ELK-BPMN input graph
 * @returns Map of boundary event ID to BoundaryEventInfo
 */
export function collectBoundaryEventInfo(
  graph: ElkBpmnGraph
): Map<string, BoundaryEventInfo> {
  const info = new Map<string, BoundaryEventInfo>();
  const edgeMap = new Map<string, string[]>(); // source -> targets

  // First pass: collect all edges by source
  const collectEdges = (node: NodeWithBpmn) => {
    if (node.edges) {
      for (const edge of node.edges) {
        const source = edge.sources?.[0];
        const target = edge.targets?.[0];
        if (!source || !target) continue;
        if (!edgeMap.has(source)) {
          edgeMap.set(source, []);
        }
        edgeMap.get(source)!.push(target);
      }
    }
    if (node.children) {
      for (const child of node.children) {
        collectEdges(child as NodeWithBpmn);
      }
    }
  };

  // Second pass: collect boundary events and their targets
  const collectBoundaryEvents = (node: NodeWithBpmn) => {
    if (node.boundaryEvents) {
      const totalBoundaries = node.boundaryEvents.length;
      node.boundaryEvents.forEach((be, index) => {
        const targets = edgeMap.get(be.id) || [];
        info.set(be.id, {
          attachedToRef: be.attachedToRef,
          targets,
          boundaryIndex: index,
          totalBoundaries,
        });
      });
    }
    if (node.children) {
      for (const child of node.children) {
        collectBoundaryEvents(child as NodeWithBpmn);
      }
    }
  };

  for (const child of graph.children ?? []) {
    collectEdges(child as NodeWithBpmn);
    collectBoundaryEvents(child as NodeWithBpmn);
  }

  return info;
}
