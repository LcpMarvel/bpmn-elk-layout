/**
 * Gateway Endpoint Adjuster
 * Handles the calculation of edge endpoint positions for gateway diamond shapes.
 * Gateways in BPMN are rendered as diamonds, so edge endpoints need to be adjusted
 * to connect to the diamond edges rather than the rectangular bounding box.
 */

import type { Point, Bounds } from '../../types/internal';
import { isDebugEnabled } from '../../utils/debug';

/**
 * Adjust an edge endpoint to connect to a gateway's diamond shape.
 * Gateway diamonds have 4 corners: left, top, right, bottom (at midpoints of bounding box edges).
 *
 * @param endpoint - The current endpoint position
 * @param adjacentPoint - The adjacent point on the edge (used to determine approach direction)
 * @param gatewayBounds - The bounding box of the gateway
 * @param isSource - Whether this endpoint is the source (true) or target (false) of the edge
 * @returns The adjusted endpoint position on the diamond edge
 */
export function adjustGatewayEndpoint(
  endpoint: Point,
  adjacentPoint: Point,
  gatewayBounds: Bounds,
  isSource: boolean
): Point {
  const gatewayCenterX = gatewayBounds.x + gatewayBounds.width / 2;
  const gatewayCenterY = gatewayBounds.y + gatewayBounds.height / 2;
  const tolerance = 1; // Tolerance for corner detection

  if (isDebugEnabled()) {
    console.log(`[BPMN] adjustGatewayEndpoint: isSource=${isSource}`);
    console.log(`  endpoint: (${endpoint.x}, ${endpoint.y})`);
    console.log(`  gatewayBounds: x=${gatewayBounds.x}, y=${gatewayBounds.y}, w=${gatewayBounds.width}, h=${gatewayBounds.height}`);
    console.log(`  gatewayCenter: (${gatewayCenterX}, ${gatewayCenterY})`);
    console.log(`  right edge x: ${gatewayBounds.x + gatewayBounds.width}`);
  }

  // Diamond corners (at midpoints of bounding box edges)
  const leftCorner = { x: gatewayBounds.x, y: gatewayCenterY };
  const rightCorner = { x: gatewayBounds.x + gatewayBounds.width, y: gatewayCenterY };
  const topCorner = { x: gatewayCenterX, y: gatewayBounds.y };
  const bottomCorner = { x: gatewayCenterX, y: gatewayBounds.y + gatewayBounds.height };

  // Check if endpoint is already at a diamond corner (no adjustment needed)
  // Left corner: x at left edge AND y at center
  if (Math.abs(endpoint.x - gatewayBounds.x) < tolerance &&
      Math.abs(endpoint.y - gatewayCenterY) < tolerance) {
    if (isDebugEnabled()) console.log(`  -> Already at LEFT corner, no adjustment`);
    return endpoint;
  }
  // Right corner: x at right edge AND y at center
  if (Math.abs(endpoint.x - (gatewayBounds.x + gatewayBounds.width)) < tolerance &&
      Math.abs(endpoint.y - gatewayCenterY) < tolerance) {
    if (isDebugEnabled()) console.log(`  -> Already at RIGHT corner, no adjustment`);
    return endpoint;
  }
  // Top corner: y at top edge AND x at center
  if (Math.abs(endpoint.y - gatewayBounds.y) < tolerance &&
      Math.abs(endpoint.x - gatewayCenterX) < tolerance) {
    if (isDebugEnabled()) console.log(`  -> Already at TOP corner, no adjustment`);
    return endpoint;
  }
  // Bottom corner: y at bottom edge AND x at center
  if (Math.abs(endpoint.y - (gatewayBounds.y + gatewayBounds.height)) < tolerance &&
      Math.abs(endpoint.x - gatewayCenterX) < tolerance) {
    if (isDebugEnabled()) console.log(`  -> Already at BOTTOM corner, no adjustment`);
    return endpoint;
  }

  if (isDebugEnabled()) {
    console.log(`  -> NOT at corner, will adjust`);
  }

  // Endpoint is NOT at a corner - calculate intersection with diamond edge
  const result = calculateDiamondIntersection(
    endpoint,
    gatewayBounds,
    gatewayCenterX,
    gatewayCenterY,
    isSource,
    adjacentPoint
  );
  if (isDebugEnabled()) {
    console.log(`  -> Adjusted to: (${result.x}, ${result.y})`);
  }
  return result;
}

/**
 * Calculate the intersection point with the diamond edge.
 * The diamond is defined by connecting the midpoints of the bounding box edges.
 *
 * @param endpoint - The current endpoint position
 * @param gatewayBounds - The bounding box of the gateway
 * @param gatewayCenterX - X coordinate of gateway center
 * @param gatewayCenterY - Y coordinate of gateway center
 * @param isSource - Whether this endpoint is the source of the edge
 * @param adjacentPoint - The adjacent point on the edge
 * @returns The intersection point on the diamond edge
 */
export function calculateDiamondIntersection(
  endpoint: Point,
  gatewayBounds: Bounds,
  gatewayCenterX: number,
  gatewayCenterY: number,
  isSource: boolean,
  adjacentPoint: Point
): Point {
  const tolerance = 1;

  const leftCorner = { x: gatewayBounds.x, y: gatewayCenterY };
  const rightCorner = { x: gatewayBounds.x + gatewayBounds.width, y: gatewayCenterY };
  const topCorner = { x: gatewayCenterX, y: gatewayBounds.y };
  const bottomCorner = { x: gatewayCenterX, y: gatewayBounds.y + gatewayBounds.height };

  // Determine which side based on endpoint position relative to gateway
  const isOnLeftEdge = Math.abs(endpoint.x - gatewayBounds.x) < tolerance;
  const isOnRightEdge = Math.abs(endpoint.x - (gatewayBounds.x + gatewayBounds.width)) < tolerance;
  const isOnTopEdge = Math.abs(endpoint.y - gatewayBounds.y) < tolerance;
  const isOnBottomEdge = Math.abs(endpoint.y - (gatewayBounds.y + gatewayBounds.height)) < tolerance;

  const halfWidth = gatewayBounds.width / 2;
  const halfHeight = gatewayBounds.height / 2;

  if (isOnLeftEdge || isOnRightEdge) {
    // Endpoint is on left or right edge of bounding box but not at corner
    // Calculate diamond edge intersection at this Y position
    const yDistFromCenter = Math.abs(endpoint.y - gatewayCenterY);

    if (yDistFromCenter >= halfHeight) {
      // Outside diamond vertically - snap to corner
      return isOnLeftEdge ? leftCorner : rightCorner;
    }

    // Diamond edge equation: |x - centerX| / halfWidth + |y - centerY| / halfHeight = 1
    const xOffsetFromCenter = halfWidth * (1 - yDistFromCenter / halfHeight);
    const intersectX = isOnLeftEdge
      ? gatewayCenterX - xOffsetFromCenter
      : gatewayCenterX + xOffsetFromCenter;

    return { x: intersectX, y: endpoint.y };
  }

  if (isOnTopEdge || isOnBottomEdge) {
    // Endpoint is on top or bottom edge of bounding box but not at corner
    // Calculate diamond edge intersection at this X position
    const xDistFromCenter = Math.abs(endpoint.x - gatewayCenterX);

    if (xDistFromCenter >= halfWidth) {
      // Outside diamond horizontally - snap to corner
      return isOnTopEdge ? topCorner : bottomCorner;
    }

    const yOffsetFromCenter = halfHeight * (1 - xDistFromCenter / halfWidth);
    const intersectY = isOnTopEdge
      ? gatewayCenterY - yOffsetFromCenter
      : gatewayCenterY + yOffsetFromCenter;

    return { x: endpoint.x, y: intersectY };
  }

  // Endpoint is not on any edge - use approach direction to determine corner
  const dx = isSource ? adjacentPoint.x - endpoint.x : endpoint.x - adjacentPoint.x;
  const dy = isSource ? adjacentPoint.y - endpoint.y : endpoint.y - adjacentPoint.y;

  if (Math.abs(dx) > Math.abs(dy)) {
    // Horizontal approach
    if (isSource) {
      return dx > 0 ? rightCorner : leftCorner;
    } else {
      return dx > 0 ? leftCorner : rightCorner;
    }
  } else {
    // Vertical approach
    if (isSource) {
      return dy > 0 ? bottomCorner : topCorner;
    } else {
      return dy > 0 ? topCorner : bottomCorner;
    }
  }
}

/**
 * Get the four corner points of a gateway diamond.
 *
 * @param gatewayBounds - The bounding box of the gateway
 * @returns Object containing all four corner points
 */
export function getDiamondCorners(gatewayBounds: Bounds): {
  left: Point;
  right: Point;
  top: Point;
  bottom: Point;
} {
  const centerX = gatewayBounds.x + gatewayBounds.width / 2;
  const centerY = gatewayBounds.y + gatewayBounds.height / 2;

  return {
    left: { x: gatewayBounds.x, y: centerY },
    right: { x: gatewayBounds.x + gatewayBounds.width, y: centerY },
    top: { x: centerX, y: gatewayBounds.y },
    bottom: { x: centerX, y: gatewayBounds.y + gatewayBounds.height },
  };
}

/**
 * Check if a point is on the diamond edge (within tolerance).
 *
 * @param point - The point to check
 * @param gatewayBounds - The bounding box of the gateway
 * @param tolerance - Distance tolerance for edge detection
 * @returns True if the point is on the diamond edge
 */
export function isPointOnDiamondEdge(
  point: Point,
  gatewayBounds: Bounds,
  tolerance: number = 2
): boolean {
  const centerX = gatewayBounds.x + gatewayBounds.width / 2;
  const centerY = gatewayBounds.y + gatewayBounds.height / 2;
  const halfWidth = gatewayBounds.width / 2;
  const halfHeight = gatewayBounds.height / 2;

  // Diamond edge equation: |x - centerX| / halfWidth + |y - centerY| / halfHeight = 1
  // Check if point satisfies this equation within tolerance
  const normalizedX = Math.abs(point.x - centerX) / halfWidth;
  const normalizedY = Math.abs(point.y - centerY) / halfHeight;
  const edgeValue = normalizedX + normalizedY;

  return Math.abs(edgeValue - 1) < tolerance / Math.min(halfWidth, halfHeight);
}
