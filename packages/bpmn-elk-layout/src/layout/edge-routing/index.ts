export { EdgeFixer } from './edge-fixer';
export {
  distance,
  calculatePathLength,
  segmentIntersectsRect,
  segmentCrossesNode,
  boundsOverlap,
  getCenter,
  getMidpoint,
  getConnectionPoint,
  determineBestConnectionSide,
  createOrthogonalPath,
  scoreRoute,
  findClearVerticalPath,
  findClearHorizontalPath,
  lineIntersection,
  type ConnectionSide,
} from './geometry-utils';
export {
  adjustGatewayEndpoint,
  calculateDiamondIntersection,
  getDiamondCorners,
  isPointOnDiamondEdge,
} from './gateway-endpoint-adjuster';
