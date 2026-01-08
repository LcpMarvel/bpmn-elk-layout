/**
 * Default ELK Layout Options
 * Optimized for BPMN diagram layout
 */

import type { ElkLayoutOptions } from '../types';

export const DEFAULT_ELK_OPTIONS: ElkLayoutOptions = {
  // === Basic Configuration ===
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',

  // === Layer Assignment ===
  // NETWORK_SIMPLEX provides better layer distribution than LONGEST_PATH
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',

  // === Crossing Minimization ===
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  // TWO_SIDED greedy switch improves crossing reduction
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',

  // === Node Placement ===
  // BRANDES_KOEPF provides better vertical alignment than NETWORK_SIMPLEX
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  // Use BALANCED alignment for symmetric layouts
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',

  // === Edge Routing ===
  'elk.edgeRouting': 'ORTHOGONAL',
  // Distribute self-loops evenly
  'elk.layered.edgeRouting.selfLoopDistribution': 'EQUALLY',

  // === Edge Labels ===
  // Place edge labels at the center of the edge
  'elk.edgeLabels.placement': 'CENTER',
  // Ensure labels don't overlap with nodes or other labels
  'elk.spacing.labelLabel': 5,
  'elk.spacing.labelNode': 10,
  'elk.spacing.edgeLabel': 10,

  // === Spacing (increased for better readability) ===
  'elk.spacing.nodeNode': 60,
  'elk.spacing.edgeNode': 40,
  'elk.spacing.edgeEdge': 25,
  'elk.layered.spacing.nodeNodeBetweenLayers': 100,
  'elk.layered.spacing.edgeNodeBetweenLayers': 40,
  'elk.layered.spacing.edgeEdgeBetweenLayers': 25,

  // === Hierarchy Handling ===
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',

  // === Model Order ===
  // Consider both node and edge order from the input model
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',

  // === Compaction ===
  // Compact connected components together
  'elk.layered.compaction.connectedComponents': true,

  // === Alignment ===
  // Center alignment for cleaner appearance
  'elk.alignment': 'CENTER',
};

/**
 * Merge user options with default options
 */
export function mergeElkOptions(
  userOptions?: ElkLayoutOptions,
  graphOptions?: ElkLayoutOptions
): ElkLayoutOptions {
  return {
    ...DEFAULT_ELK_OPTIONS,
    ...graphOptions,
    ...userOptions,
  };
}
