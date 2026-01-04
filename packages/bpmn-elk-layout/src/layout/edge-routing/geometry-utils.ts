/**
 * Geometry Utilities for Edge Routing
 * Provides geometric calculation functions for edge routing and obstacle avoidance.
 */

import type { Point, Bounds } from '../../types/internal';

/**
 * Calculate Euclidean distance between two points
 */
export function distance(p1: Point, p2: Point): number {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
}

/**
 * Calculate total path length of a series of waypoints
 */
export function calculatePathLength(waypoints: Point[]): number {
  let length = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];
    if (p1 && p2) {
      length += distance(p1, p2);
    }
  }
  return length;
}

/**
 * Check if a line segment intersects a rectangle
 * Used for detecting edge-node collisions
 */
export function segmentIntersectsRect(
  p1: Point,
  p2: Point,
  rect: Bounds
): boolean {
  const margin = 5;
  const left = rect.x - margin;
  const right = rect.x + rect.width + margin;
  const top = rect.y - margin;
  const bottom = rect.y + rect.height + margin;

  // Check if both points are on the same side of the rectangle
  if ((p1.x < left && p2.x < left) || (p1.x > right && p2.x > right)) return false;
  if ((p1.y < top && p2.y < top) || (p1.y > bottom && p2.y > bottom)) return false;

  // Check if segment is horizontal or vertical
  if (Math.abs(p1.x - p2.x) < 1) {
    // Vertical segment
    const x = p1.x;
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);
    return x >= left && x <= right && maxY >= top && minY <= bottom;
  }

  if (Math.abs(p1.y - p2.y) < 1) {
    // Horizontal segment
    const y = p1.y;
    const minX = Math.min(p1.x, p2.x);
    const maxX = Math.max(p1.x, p2.x);
    return y >= top && y <= bottom && maxX >= left && minX <= right;
  }

  // For diagonal segments (shouldn't happen in orthogonal routing)
  return true; // Assume intersection if not axis-aligned
}

/**
 * Check if a line segment crosses through a node's interior
 * More strict than segmentIntersectsRect - requires passing through the interior
 */
export function segmentCrossesNode(
  p1: Point,
  p2: Point,
  node: Bounds
): boolean {
  const margin = 5;
  const nodeLeft = node.x - margin;
  const nodeRight = node.x + node.width + margin;
  const nodeTop = node.y - margin;
  const nodeBottom = node.y + node.height + margin;

  // Check if segment is horizontal
  if (Math.abs(p1.y - p2.y) < 1) {
    const segY = p1.y;
    const segMinX = Math.min(p1.x, p2.x);
    const segMaxX = Math.max(p1.x, p2.x);

    // Segment crosses if: y is within node's vertical range AND segment spans node's horizontal range
    if (segY > nodeTop && segY < nodeBottom) {
      if (segMinX < nodeRight && segMaxX > nodeLeft) {
        // Check if segment actually passes through the interior (not just touching edges)
        const interiorLeft = node.x + margin;
        const interiorRight = node.x + node.width - margin;
        if (segMinX < interiorRight && segMaxX > interiorLeft) {
          return true;
        }
      }
    }
  }

  // Check if segment is vertical
  if (Math.abs(p1.x - p2.x) < 1) {
    const segX = p1.x;
    const segMinY = Math.min(p1.y, p2.y);
    const segMaxY = Math.max(p1.y, p2.y);

    // Segment crosses if: x is within node's horizontal range AND segment spans node's vertical range
    if (segX > nodeLeft && segX < nodeRight) {
      if (segMinY < nodeBottom && segMaxY > nodeTop) {
        // Check if segment actually passes through the interior
        const interiorTop = node.y + margin;
        const interiorBottom = node.y + node.height - margin;
        if (segMinY < interiorBottom && segMaxY > interiorTop) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if two rectangles overlap
 */
export function boundsOverlap(a: Bounds, b: Bounds, margin: number = 0): boolean {
  return !(
    a.x + a.width + margin < b.x ||
    b.x + b.width + margin < a.x ||
    a.y + a.height + margin < b.y ||
    b.y + b.height + margin < a.y
  );
}

/**
 * Get the center point of a bounds
 */
export function getCenter(bounds: Bounds): Point {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

/**
 * Calculate the midpoint between two points
 */
export function getMidpoint(p1: Point, p2: Point): Point {
  return {
    x: (p1.x + p2.x) / 2,
    y: (p1.y + p2.y) / 2,
  };
}

/**
 * Calculate connection point on a node based on direction
 */
export type ConnectionSide = 'left' | 'right' | 'top' | 'bottom';

export function getConnectionPoint(
  bounds: Bounds,
  side: ConnectionSide
): Point {
  const center = getCenter(bounds);

  switch (side) {
    case 'left':
      return { x: bounds.x, y: center.y };
    case 'right':
      return { x: bounds.x + bounds.width, y: center.y };
    case 'top':
      return { x: center.x, y: bounds.y };
    case 'bottom':
      return { x: center.x, y: bounds.y + bounds.height };
  }
}

/**
 * Determine the best connection side based on relative positions
 */
export function determineBestConnectionSide(
  source: Bounds,
  target: Bounds
): { sourceSide: ConnectionSide; targetSide: ConnectionSide } {
  const sourceCenter = getCenter(source);
  const targetCenter = getCenter(target);

  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;

  // Determine primary direction
  if (Math.abs(dx) > Math.abs(dy)) {
    // Horizontal movement
    if (dx > 0) {
      return { sourceSide: 'right', targetSide: 'left' };
    } else {
      return { sourceSide: 'left', targetSide: 'right' };
    }
  } else {
    // Vertical movement
    if (dy > 0) {
      return { sourceSide: 'bottom', targetSide: 'top' };
    } else {
      return { sourceSide: 'top', targetSide: 'bottom' };
    }
  }
}

/**
 * Create an orthogonal path between two points with L-shaped or Z-shaped routing
 */
export function createOrthogonalPath(
  start: Point,
  end: Point,
  primaryDirection: 'horizontal' | 'vertical' = 'horizontal'
): Point[] {
  const waypoints: Point[] = [start];

  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);

  // If already aligned, direct connection
  if (dx < 5 || dy < 5) {
    waypoints.push(end);
    return waypoints;
  }

  // Create L-shaped routing
  if (primaryDirection === 'horizontal') {
    const midX = (start.x + end.x) / 2;
    waypoints.push({ x: midX, y: start.y });
    waypoints.push({ x: midX, y: end.y });
  } else {
    const midY = (start.y + end.y) / 2;
    waypoints.push({ x: start.x, y: midY });
    waypoints.push({ x: end.x, y: midY });
  }

  waypoints.push(end);
  return waypoints;
}

/**
 * Score a route based on obstacle crossings and path length
 * Lower score = better route
 */
export function scoreRoute(
  start: Point,
  bendPoints: Point[],
  end: Point,
  obstacles: Bounds[]
): number {
  let score = 0;
  const crossingPenalty = 1000;
  const lengthWeight = 0.1;

  // Build full path
  const path = [start, ...bendPoints, end];

  // Check for crossings with each obstacle
  for (const obs of obstacles) {
    for (let i = 0; i < path.length - 1; i++) {
      const p1 = path[i];
      const p2 = path[i + 1];
      if (p1 && p2 && segmentIntersectsRect(p1, p2, obs)) {
        score += crossingPenalty;
      }
    }
  }

  // Add path length to score
  for (let i = 0; i < path.length - 1; i++) {
    const p1 = path[i];
    const p2 = path[i + 1];
    if (p1 && p2) {
      score += distance(p1, p2) * lengthWeight;
    }
  }

  return score;
}

/**
 * Find a clear vertical path that avoids obstacles
 * Returns the Y coordinate to route through, or null if direct path is clear
 */
export function findClearVerticalPath(
  x: number,
  startY: number,
  endY: number,
  obstacles: Bounds[]
): number | null {
  const minY = Math.min(startY, endY);
  const maxY = Math.max(startY, endY);
  const margin = 10;

  // Check if any obstacle blocks the vertical path
  for (const obs of obstacles) {
    const obsLeft = obs.x - margin;
    const obsRight = obs.x + obs.width + margin;
    const obsTop = obs.y;
    const obsBottom = obs.y + obs.height;

    // Check if x is within obstacle's horizontal range
    if (x >= obsLeft && x <= obsRight) {
      // Check if obstacle is in our vertical path
      if (obsBottom > minY && obsTop < maxY) {
        // Found an obstacle - return a Y that goes around it
        // Prefer going below the obstacle if there's more space
        const spaceAbove = obsTop - minY;
        const spaceBelow = maxY - obsBottom;

        if (spaceBelow > spaceAbove && obsBottom + margin < maxY) {
          return obsBottom + margin;
        } else if (obsTop - margin > minY) {
          return obsTop - margin;
        }
      }
    }
  }

  return null; // No obstacle found, direct path is clear
}

/**
 * Calculate intersection point of two line segments.
 * Returns null if lines don't intersect within both segments.
 * Used for diamond edge intersection calculations.
 */
export function lineIntersection(
  p1: Point,
  p2: Point,
  p3: Point,
  p4: Point
): Point | null {
  const denom = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);
  if (Math.abs(denom) < 0.0001) return null; // Lines are parallel

  const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / denom;
  const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / denom;

  // Check if intersection is within both line segments
  if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
    return {
      x: p1.x + ua * (p2.x - p1.x),
      y: p1.y + ua * (p2.y - p1.y),
    };
  }

  return null;
}

/**
 * Find a clear horizontal path that avoids obstacles
 * Returns the X coordinate to route through, or null if direct path is clear
 */
export function findClearHorizontalPath(
  y: number,
  startX: number,
  endX: number,
  obstacles: Bounds[]
): number | null {
  const minX = Math.min(startX, endX);
  const maxX = Math.max(startX, endX);
  const margin = 10;

  // Check if any obstacle blocks the horizontal path
  for (const obs of obstacles) {
    const obsTop = obs.y - margin;
    const obsBottom = obs.y + obs.height + margin;
    const obsLeft = obs.x;
    const obsRight = obs.x + obs.width;

    // Check if y is within obstacle's vertical range
    if (y >= obsTop && y <= obsBottom) {
      // Check if obstacle is in our horizontal path
      if (obsRight > minX && obsLeft < maxX) {
        // Found an obstacle - return an X that goes around it
        // Prefer going right of the obstacle if there's more space
        const spaceLeft = obsLeft - minX;
        const spaceRight = maxX - obsRight;

        if (spaceRight > spaceLeft && obsRight + margin < maxX) {
          return obsRight + margin;
        } else if (obsLeft - margin > minX) {
          return obsLeft - margin;
        }
      }
    }
  }

  return null; // No obstacle found, direct path is clear
}
