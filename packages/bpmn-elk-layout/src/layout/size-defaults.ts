/**
 * Default Size Definitions for BPMN Elements
 */

import type { FlowNode, BoundaryEvent, Artifact, Lane, Participant } from '../types';
import { DEFAULT_SIZES } from '../types/bpmn-constants';

interface Size {
  width: number;
  height: number;
}

/**
 * Get default size for a BPMN element type
 */
export function getDefaultSize(type: string, name?: string): Size {
  // Events
  if (type.includes('Event')) {
    return DEFAULT_SIZES.EVENT;
  }

  // Gateways
  if (type.includes('Gateway')) {
    return DEFAULT_SIZES.GATEWAY;
  }

  // Tasks
  if (type.includes('Task') || type === 'task') {
    // Adjust width based on name length
    if (name) {
      const nameLength = name.length;
      if (nameLength > 12) {
        return DEFAULT_SIZES.TASK_WIDER;
      } else if (nameLength > 8) {
        return DEFAULT_SIZES.TASK_WIDE;
      }
    }
    return DEFAULT_SIZES.TASK;
  }

  // SubProcesses
  if (type === 'subProcess' || type === 'transaction' || type === 'adHocSubProcess' || type === 'eventSubProcess') {
    return DEFAULT_SIZES.SUBPROCESS_COLLAPSED;
  }

  // Call Activity
  if (type === 'callActivity') {
    return DEFAULT_SIZES.TASK;
  }

  // Data Objects
  if (type === 'dataObject' || type === 'dataObjectReference' || type === 'dataInput' || type === 'dataOutput') {
    return DEFAULT_SIZES.DATA_OBJECT;
  }

  // Data Store
  if (type === 'dataStoreReference') {
    return DEFAULT_SIZES.DATA_STORE;
  }

  // Text Annotation
  if (type === 'textAnnotation') {
    return DEFAULT_SIZES.TEXT_ANNOTATION;
  }

  // Default
  return DEFAULT_SIZES.TASK;
}

/**
 * Apply default sizes to nodes that don't have dimensions specified
 */
export function applyDefaultSizes<T extends { id: string; width?: number; height?: number; bpmn: { type: string; name?: string; isExpanded?: boolean } }>(
  node: T
): T & { width: number; height: number } {
  const bpmn = node.bpmn as { type: string; name?: string; isExpanded?: boolean };

  // Check if sizes are already specified
  if (node.width !== undefined && node.height !== undefined) {
    return node as T & { width: number; height: number };
  }

  // Handle expanded subprocesses
  if (bpmn.isExpanded === true) {
    return {
      ...node,
      width: node.width ?? DEFAULT_SIZES.SUBPROCESS_EXPANDED_MIN.width,
      height: node.height ?? DEFAULT_SIZES.SUBPROCESS_EXPANDED_MIN.height,
    };
  }

  const defaultSize = getDefaultSize(bpmn.type, bpmn.name);

  return {
    ...node,
    width: node.width ?? defaultSize.width,
    height: node.height ?? defaultSize.height,
  };
}

/**
 * Recursively apply default sizes to all nodes in a graph
 */
export function applyDefaultSizesToGraph<T extends {
  children?: Array<T | { id: string; width?: number; height?: number; bpmn: { type: string; name?: string } }>;
  boundaryEvents?: BoundaryEvent[];
  artifacts?: Artifact[];
}>(graph: T): T {
  const processNode = <N extends { id: string; width?: number; height?: number; bpmn: { type: string; name?: string; isExpanded?: boolean } }>(
    node: N
  ): N => {
    const sized = applyDefaultSizes(node);

    // Process children recursively
    if ('children' in sized && Array.isArray(sized.children)) {
      (sized as { children: unknown[] }).children = sized.children.map((child: unknown) => {
        if (typeof child === 'object' && child !== null && 'bpmn' in child) {
          return processNode(child as N);
        }
        return child;
      });
    }

    // Process boundary events
    if ('boundaryEvents' in sized && Array.isArray(sized.boundaryEvents)) {
      (sized as { boundaryEvents: unknown[] }).boundaryEvents = sized.boundaryEvents.map((be) =>
        applyDefaultSizes(be as BoundaryEvent & { bpmn: { type: string; name?: string; isExpanded?: boolean } })
      );
    }

    return sized;
  };

  // Process children at root level
  if (graph.children) {
    graph.children = graph.children.map((child) => {
      if ('bpmn' in child) {
        return processNode(child as FlowNode & { bpmn: { type: string; name?: string; isExpanded?: boolean } });
      }
      return child;
    }) as T['children'];
  }

  // Process artifacts
  if (graph.artifacts) {
    graph.artifacts = graph.artifacts.map((artifact) =>
      applyDefaultSizes(artifact as Artifact & { bpmn: { type: string; name?: string; isExpanded?: boolean } })
    );
  }

  return graph;
}
