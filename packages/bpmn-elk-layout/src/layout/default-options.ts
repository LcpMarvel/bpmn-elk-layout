/**
 * Default ELK Layout Options
 */

import type { ElkLayoutOptions } from '../types';

export const DEFAULT_ELK_OPTIONS: ElkLayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': 50,
  'elk.spacing.edgeNode': 30,
  'elk.spacing.edgeEdge': 20,
  'elk.layered.spacing.nodeNodeBetweenLayers': 80,
  'elk.layered.spacing.edgeNodeBetweenLayers': 30,
  'elk.layered.spacing.edgeEdgeBetweenLayers': 20,
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.edgeRouting': 'ORTHOGONAL',
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
