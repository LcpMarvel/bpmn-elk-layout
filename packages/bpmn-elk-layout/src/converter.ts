/**
 * BpmnElkLayout - Main Converter Class
 *
 * Converts ELK-BPMN JSON to:
 * - BPMN 2.0 XML (with diagram interchange)
 * - Layouted ELK-BPMN JSON (with coordinates)
 */

import type { ElkBpmnGraph, ElkLayoutOptions } from './types';
import type { LayoutedGraph } from './types/elk-output';
import { ElkLayouter } from './layout';
import { ModelBuilder } from './transform';
import { BpmnXmlGenerator } from './generators';

export interface BpmnElkLayoutOptions {
  /**
   * ELK layout options to override defaults
   */
  elkOptions?: ElkLayoutOptions;
  /**
   * Enable layout compaction to reduce unnecessary whitespace
   * @default false
   */
  enableCompaction?: boolean;
}

export class BpmnElkLayout {
  private layouter: ElkLayouter;
  private modelBuilder: ModelBuilder;
  private xmlGenerator: BpmnXmlGenerator;

  constructor(options?: BpmnElkLayoutOptions) {
    this.layouter = new ElkLayouter({
      elkOptions: options?.elkOptions,
      enableCompaction: options?.enableCompaction,
    });
    this.modelBuilder = new ModelBuilder();
    this.xmlGenerator = new BpmnXmlGenerator();
  }

  /**
   * Convert ELK-BPMN JSON to BPMN 2.0 XML
   *
   * @param input - ELK-BPMN JSON (without coordinates)
   * @returns BPMN 2.0 XML string with diagram interchange
   *
   * @example
   * ```typescript
   * const converter = new BpmnElkLayout();
   * const xml = await converter.to_bpmn(elkBpmnJson);
   * console.log(xml);
   * ```
   */
  async to_bpmn(input: ElkBpmnGraph): Promise<string> {
    // Step 1: Run ELK layout to get coordinates
    const layouted = await this.layouter.layout(input);

    // Step 2: Build intermediate model
    const model = this.modelBuilder.build(layouted);

    // Step 3: Generate BPMN XML
    const xml = await this.xmlGenerator.generate(model);

    return xml;
  }

  /**
   * Convert ELK-BPMN JSON to layouted JSON with coordinates
   *
   * @param input - ELK-BPMN JSON (without coordinates)
   * @returns ELK-BPMN JSON with x, y coordinates for all nodes and edges
   *
   * @example
   * ```typescript
   * const converter = new BpmnElkLayout();
   * const layouted = await converter.to_json(elkBpmnJson);
   * console.log(layouted.children[0].x, layouted.children[0].y);
   * ```
   */
  async to_json(input: ElkBpmnGraph): Promise<LayoutedGraph> {
    return this.layouter.layout(input);
  }

  /**
   * Create a new instance with different options
   */
  static create(options?: BpmnElkLayoutOptions): BpmnElkLayout {
    return new BpmnElkLayout(options);
  }
}

// Re-export types for convenience
export type { ElkBpmnGraph, ElkLayoutOptions } from './types';
export type { LayoutedGraph } from './types/elk-output';
