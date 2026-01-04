import { describe, it, expect } from 'vitest';
import {
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
} from '../../../src/layout/edge-routing/geometry-utils';

describe('geometry-utils', () => {
  describe('distance', () => {
    it('should calculate distance between two points', () => {
      expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
      expect(distance({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(0);
      expect(distance({ x: 1, y: 1 }, { x: 4, y: 5 })).toBe(5);
    });
  });

  describe('calculatePathLength', () => {
    it('should calculate total path length', () => {
      const waypoints = [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 4 },
      ];
      expect(calculatePathLength(waypoints)).toBe(7);
    });

    it('should return 0 for single point', () => {
      expect(calculatePathLength([{ x: 0, y: 0 }])).toBe(0);
    });

    it('should return 0 for empty array', () => {
      expect(calculatePathLength([])).toBe(0);
    });
  });

  describe('segmentIntersectsRect', () => {
    const rect = { x: 10, y: 10, width: 20, height: 20 };

    it('should detect horizontal segment crossing rectangle', () => {
      expect(segmentIntersectsRect({ x: 0, y: 20 }, { x: 40, y: 20 }, rect)).toBe(true);
    });

    it('should detect vertical segment crossing rectangle', () => {
      expect(segmentIntersectsRect({ x: 20, y: 0 }, { x: 20, y: 40 }, rect)).toBe(true);
    });

    it('should not detect segment that misses rectangle', () => {
      // Horizontal segment above the rectangle
      expect(segmentIntersectsRect({ x: 0, y: 0 }, { x: 5, y: 0 }, rect)).toBe(false);
    });

    it('should not detect segment to the right of rectangle', () => {
      // Horizontal segment to the right of the rectangle
      expect(segmentIntersectsRect({ x: 40, y: 20 }, { x: 50, y: 20 }, rect)).toBe(false);
    });
  });

  describe('segmentCrossesNode', () => {
    const node = { x: 10, y: 10, width: 20, height: 20 };

    it('should detect horizontal segment crossing through interior', () => {
      expect(segmentCrossesNode({ x: 0, y: 20 }, { x: 40, y: 20 }, node)).toBe(true);
    });

    it('should detect vertical segment crossing through interior', () => {
      expect(segmentCrossesNode({ x: 20, y: 0 }, { x: 20, y: 40 }, node)).toBe(true);
    });

    it('should not detect segment that misses node', () => {
      expect(segmentCrossesNode({ x: 0, y: 0 }, { x: 5, y: 0 }, node)).toBe(false);
    });
  });

  describe('boundsOverlap', () => {
    it('should detect overlapping rectangles', () => {
      const a = { x: 0, y: 0, width: 20, height: 20 };
      const b = { x: 10, y: 10, width: 20, height: 20 };
      expect(boundsOverlap(a, b)).toBe(true);
    });

    it('should not detect non-overlapping rectangles', () => {
      const a = { x: 0, y: 0, width: 10, height: 10 };
      const b = { x: 20, y: 20, width: 10, height: 10 };
      expect(boundsOverlap(a, b)).toBe(false);
    });

    it('should respect margin parameter', () => {
      const a = { x: 0, y: 0, width: 10, height: 10 };
      const b = { x: 15, y: 0, width: 10, height: 10 };
      expect(boundsOverlap(a, b, 0)).toBe(false);
      expect(boundsOverlap(a, b, 10)).toBe(true);
    });
  });

  describe('getCenter', () => {
    it('should calculate center of bounds', () => {
      expect(getCenter({ x: 0, y: 0, width: 100, height: 80 })).toEqual({ x: 50, y: 40 });
      expect(getCenter({ x: 10, y: 20, width: 30, height: 40 })).toEqual({ x: 25, y: 40 });
    });
  });

  describe('getMidpoint', () => {
    it('should calculate midpoint between two points', () => {
      expect(getMidpoint({ x: 0, y: 0 }, { x: 10, y: 10 })).toEqual({ x: 5, y: 5 });
      expect(getMidpoint({ x: -10, y: 0 }, { x: 10, y: 0 })).toEqual({ x: 0, y: 0 });
    });
  });

  describe('getConnectionPoint', () => {
    const bounds = { x: 10, y: 20, width: 100, height: 80 };

    it('should return left center point', () => {
      expect(getConnectionPoint(bounds, 'left')).toEqual({ x: 10, y: 60 });
    });

    it('should return right center point', () => {
      expect(getConnectionPoint(bounds, 'right')).toEqual({ x: 110, y: 60 });
    });

    it('should return top center point', () => {
      expect(getConnectionPoint(bounds, 'top')).toEqual({ x: 60, y: 20 });
    });

    it('should return bottom center point', () => {
      expect(getConnectionPoint(bounds, 'bottom')).toEqual({ x: 60, y: 100 });
    });
  });

  describe('determineBestConnectionSide', () => {
    it('should determine right-left for target to the right', () => {
      const source = { x: 0, y: 0, width: 50, height: 50 };
      const target = { x: 100, y: 0, width: 50, height: 50 };
      expect(determineBestConnectionSide(source, target)).toEqual({
        sourceSide: 'right',
        targetSide: 'left',
      });
    });

    it('should determine left-right for target to the left', () => {
      const source = { x: 100, y: 0, width: 50, height: 50 };
      const target = { x: 0, y: 0, width: 50, height: 50 };
      expect(determineBestConnectionSide(source, target)).toEqual({
        sourceSide: 'left',
        targetSide: 'right',
      });
    });

    it('should determine bottom-top for target below', () => {
      const source = { x: 0, y: 0, width: 50, height: 50 };
      const target = { x: 0, y: 100, width: 50, height: 50 };
      expect(determineBestConnectionSide(source, target)).toEqual({
        sourceSide: 'bottom',
        targetSide: 'top',
      });
    });

    it('should determine top-bottom for target above', () => {
      const source = { x: 0, y: 100, width: 50, height: 50 };
      const target = { x: 0, y: 0, width: 50, height: 50 };
      expect(determineBestConnectionSide(source, target)).toEqual({
        sourceSide: 'top',
        targetSide: 'bottom',
      });
    });
  });

  describe('createOrthogonalPath', () => {
    it('should create direct path for aligned points', () => {
      const start = { x: 0, y: 0 };
      const end = { x: 100, y: 0 };
      const path = createOrthogonalPath(start, end);
      expect(path).toEqual([start, end]);
    });

    it('should create L-shaped path for horizontal-first routing', () => {
      const start = { x: 0, y: 0 };
      const end = { x: 100, y: 50 };
      const path = createOrthogonalPath(start, end, 'horizontal');
      expect(path).toHaveLength(4);
      expect(path[0]).toEqual(start);
      expect(path[path.length - 1]).toEqual(end);
    });

    it('should create L-shaped path for vertical-first routing', () => {
      const start = { x: 0, y: 0 };
      const end = { x: 100, y: 50 };
      const path = createOrthogonalPath(start, end, 'vertical');
      expect(path).toHaveLength(4);
      expect(path[0]).toEqual(start);
      expect(path[path.length - 1]).toEqual(end);
    });
  });

  describe('scoreRoute', () => {
    it('should return 0 for direct path with no obstacles', () => {
      const start = { x: 0, y: 0 };
      const end = { x: 100, y: 0 };
      const score = scoreRoute(start, [], end, []);
      // Should only include path length score
      expect(score).toBeCloseTo(10, 0); // 100 * 0.1
    });

    it('should add penalty for obstacle crossings', () => {
      const start = { x: 0, y: 0 };
      const end = { x: 100, y: 0 };
      const obstacle = { x: 40, y: -10, width: 20, height: 20 };
      const scoreWithObstacle = scoreRoute(start, [], end, [obstacle]);
      const scoreWithoutObstacle = scoreRoute(start, [], end, []);
      expect(scoreWithObstacle).toBeGreaterThan(scoreWithoutObstacle);
    });
  });

  describe('findClearVerticalPath', () => {
    it('should return null when path is clear', () => {
      const result = findClearVerticalPath(50, 0, 100, []);
      expect(result).toBeNull();
    });

    it('should find a clear path around obstacle', () => {
      const obstacle = { x: 40, y: 40, width: 20, height: 20 };
      const result = findClearVerticalPath(50, 0, 100, [obstacle]);
      expect(result).not.toBeNull();
      // Should be above or below the obstacle
      if (result !== null) {
        expect(result < 40 || result > 60).toBe(true);
      }
    });
  });

  describe('findClearHorizontalPath', () => {
    it('should return null when path is clear', () => {
      const result = findClearHorizontalPath(50, 0, 100, []);
      expect(result).toBeNull();
    });

    it('should find a clear path around obstacle', () => {
      const obstacle = { x: 40, y: 40, width: 20, height: 20 };
      const result = findClearHorizontalPath(50, 0, 100, [obstacle]);
      expect(result).not.toBeNull();
      // Should be left or right of the obstacle
      if (result !== null) {
        expect(result < 40 || result > 60).toBe(true);
      }
    });
  });
});
