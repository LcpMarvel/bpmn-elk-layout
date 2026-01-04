/**
 * Result Merger
 * Merges ELK layout results back with original BPMN metadata.
 * Preserves BPMN-specific properties while applying layout coordinates.
 */

import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { ElkBpmnGraph, LayoutedGraph } from '../../types';
import type { NodeWithBpmn } from '../../types/internal';

const DEBUG = process.env.DEBUG === 'true';

/**
 * Handler for merging layout results with original BPMN data
 */
export class ResultMerger {
  /**
   * Merge ELK layout results back with original BPMN metadata
   */
  merge(original: ElkBpmnGraph, layouted: ElkNode): LayoutedGraph {
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
      }) as LayoutedGraph['children'];
    }

    return result;
  }

  /**
   * Merge a single node's layout results with original BPMN data
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
      result.edges = this.mergeEdges(original.edges, layouted.edges);
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

  /**
   * Merge edge layout results
   */
  private mergeEdges(
    originalEdges: NodeWithBpmn['edges'],
    layoutedEdges: ElkExtendedEdge[]
  ): NodeWithBpmn['edges'] {
    if (!originalEdges) return undefined;

    const layoutedEdgeMap = new Map(layoutedEdges.map((e) => [e.id, e]));

    return originalEdges.map((origEdge) => {
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
}
