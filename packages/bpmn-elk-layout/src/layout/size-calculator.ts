/**
 * Size Calculator
 * Handles calculating and applying default sizes to BPMN elements.
 * Also estimates label widths based on text content.
 */

import type { ElkBpmnGraph } from '../types';
import type { NodeWithBpmn } from '../types/internal';

/**
 * Default size dimensions for various BPMN element types
 */
export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Size Calculator for BPMN elements
 * Applies default sizes based on element type and properties
 */
export class SizeCalculator {
  /**
   * Apply default sizes to all nodes in the graph
   */
  applyDefaultSizes(graph: ElkBpmnGraph): ElkBpmnGraph {
    if (graph.children) {
      graph.children = graph.children.map((child) => {
        return this.applyDefaultSizesRecursive(child);
      });
    }
    return graph;
  }

  /**
   * Recursively apply default sizes to a node and its children
   */
  private applyDefaultSizesRecursive<T extends object>(node: T): T {
    const result = { ...node };

    // Apply sizes if this is a node with bpmn type
    if ('bpmn' in result && 'id' in result) {
      const bpmn = (result as unknown as NodeWithBpmn).bpmn;
      const nodeResult = result as { width?: number; height?: number };

      // Get default size based on type
      const defaultSize = this.getDefaultSizeForType(bpmn.type, bpmn.name, bpmn.isExpanded);

      if (nodeResult.width === undefined) {
        nodeResult.width = defaultSize.width;
      }
      if (nodeResult.height === undefined) {
        nodeResult.height = defaultSize.height;
      }
    }

    // Process children recursively
    if ('children' in result && Array.isArray((result as { children: unknown[] }).children)) {
      (result as { children: unknown[] }).children = (result as { children: object[] }).children.map(
        (child) => this.applyDefaultSizesRecursive(child)
      );
    }

    // Process boundary events
    if ('boundaryEvents' in result && Array.isArray((result as { boundaryEvents: unknown[] }).boundaryEvents)) {
      const boundaryEvents = (result as { boundaryEvents: object[] }).boundaryEvents;
      (result as { boundaryEvents: unknown[] }).boundaryEvents = boundaryEvents.map(
        (be) => this.applyDefaultSizesRecursive(be)
      );

      // Ensure host node is wide enough to accommodate all boundary events with spacing
      // Each boundary event is 36px wide, and we need at least 20px spacing between them
      const beCount = boundaryEvents.length;
      if (beCount > 1) {
        const beWidth = 36;
        const beSpacing = 20;
        // Need: margin + (beWidth + spacing) * beCount - spacing + margin
        // Simplified: (beCount * (beWidth + beSpacing)) + margin
        const minWidth = beCount * (beWidth + beSpacing) + beSpacing;
        const nodeResult = result as { width?: number };
        if (nodeResult.width !== undefined && nodeResult.width < minWidth) {
          nodeResult.width = minWidth;
        }
      }
    }

    // Process artifacts
    if ('artifacts' in result && Array.isArray((result as { artifacts: unknown[] }).artifacts)) {
      (result as { artifacts: unknown[] }).artifacts = (result as { artifacts: object[] }).artifacts.map(
        (artifact) => this.applyDefaultSizesRecursive(artifact)
      );
    }

    return result;
  }

  /**
   * Estimate label width based on text content
   * Uses approximate character width of 14px for CJK and 7px for ASCII
   */
  estimateLabelWidth(text?: string): number {
    if (!text) return 50;

    let width = 0;
    for (const char of text) {
      // CJK characters are wider
      if (char.charCodeAt(0) > 255) {
        width += 14; // ~14px for CJK characters
      } else {
        width += 7; // ~7px for ASCII characters
      }
    }

    return Math.max(30, Math.min(width, 200)); // Clamp between 30 and 200
  }

  /**
   * Get default size for a BPMN element type
   */
  getDefaultSizeForType(type: string, name?: string, isExpanded?: boolean): ElementSize {
    // Expanded subprocesses
    if (isExpanded === true) {
      return { width: 300, height: 200 };
    }

    // Events
    if (type.includes('Event')) {
      return { width: 36, height: 36 };
    }

    // Gateways
    if (type.includes('Gateway')) {
      return { width: 50, height: 50 };
    }

    // Tasks and activities
    if (type.includes('Task') || type === 'task' || type === 'callActivity') {
      const nameLen = name?.length ?? 0;
      if (nameLen > 12) return { width: 150, height: 80 };
      if (nameLen > 8) return { width: 120, height: 80 };
      return { width: 100, height: 80 };
    }

    // Collapsed subprocesses
    if (type === 'subProcess' || type === 'transaction' || type === 'adHocSubProcess' || type === 'eventSubProcess') {
      return { width: 100, height: 80 };
    }

    // Data objects
    if (type === 'dataObject' || type === 'dataObjectReference' || type === 'dataInput' || type === 'dataOutput') {
      return { width: 36, height: 50 };
    }

    // Data store
    if (type === 'dataStoreReference') {
      return { width: 50, height: 50 };
    }

    // Text annotation
    if (type === 'textAnnotation') {
      return { width: 100, height: 30 };
    }

    // Participant/Pool - let ELK calculate
    if (type === 'participant') {
      return { width: 680, height: 200 };
    }

    // Lane - let ELK calculate
    if (type === 'lane') {
      return { width: 680, height: 150 };
    }

    // Default
    return { width: 100, height: 80 };
  }
}

/**
 * Standalone function to apply default sizes to a graph
 * Convenience wrapper around SizeCalculator
 */
export function applyDefaultSizes(graph: ElkBpmnGraph): ElkBpmnGraph {
  const calculator = new SizeCalculator();
  return calculator.applyDefaultSizes(graph);
}

/**
 * Standalone function to estimate label width
 * Convenience wrapper around SizeCalculator
 */
export function estimateLabelWidth(text?: string): number {
  const calculator = new SizeCalculator();
  return calculator.estimateLabelWidth(text);
}

/**
 * Standalone function to get default size for a type
 * Convenience wrapper around SizeCalculator
 */
export function getDefaultSizeForType(type: string, name?: string, isExpanded?: boolean): ElementSize {
  const calculator = new SizeCalculator();
  return calculator.getDefaultSizeForType(type, name, isExpanded);
}
