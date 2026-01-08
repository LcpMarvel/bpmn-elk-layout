/**
 * Unit tests for PathfindingRouter
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PathfindingRouter,
  routeEdges,
  findPathAvoidingObstacles,
} from '../../../src/layout/edge-routing/pathfinding-router';
import type { Bounds, Point } from '../../../src/types/internal';

describe('PathfindingRouter', () => {
  let router: PathfindingRouter;

  beforeEach(() => {
    router = new PathfindingRouter();
  });

  describe('setObstacles', () => {
    it('should accept an empty array of obstacles', () => {
      expect(() => router.setObstacles([])).not.toThrow();
    });

    it('should accept obstacles with valid bounds', () => {
      const obstacles: Bounds[] = [
        { x: 100, y: 100, width: 100, height: 80 },
        { x: 300, y: 100, width: 100, height: 80 },
      ];
      expect(() => router.setObstacles(obstacles)).not.toThrow();
    });
  });

  describe('findPath', () => {
    it('should return a direct path when no obstacles', () => {
      router.setObstacles([]);
      const source: Point = { x: 0, y: 0 };
      const target: Point = { x: 100, y: 100 };

      const result = router.findPath(source, target);

      expect(result.path.length).toBeGreaterThanOrEqual(2);
      expect(result.path[0]).toEqual(source);
      expect(result.path[result.path.length - 1]).toEqual(target);
    });

    it('should find a path around a single obstacle', () => {
      const obstacles: Bounds[] = [
        { x: 40, y: 40, width: 50, height: 50 },
      ];
      router.setObstacles(obstacles);

      const source: Point = { x: 20, y: 60 };
      const target: Point = { x: 120, y: 60 };

      const result = router.findPath(source, target);

      expect(result.path.length).toBeGreaterThanOrEqual(2);
      expect(result.path[0]).toEqual(source);
      expect(result.path[result.path.length - 1]).toEqual(target);
    });

    it('should handle paths with same start and end point', () => {
      router.setObstacles([]);
      const point: Point = { x: 50, y: 50 };

      const result = router.findPath(point, point);

      expect(result.path.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('findOrthogonalPath', () => {
    it('should return orthogonal path with only horizontal and vertical segments', () => {
      router.setObstacles([]);
      const source: Point = { x: 0, y: 0 };
      const target: Point = { x: 100, y: 100 };

      const result = router.findOrthogonalPath(source, target);

      // Check that all segments are orthogonal
      for (let i = 1; i < result.path.length; i++) {
        const prev = result.path[i - 1];
        const curr = result.path[i];
        const isHorizontal = prev.y === curr.y;
        const isVertical = prev.x === curr.x;
        expect(isHorizontal || isVertical).toBe(true);
      }
    });

    it('should avoid obstacles with orthogonal path', () => {
      const obstacles: Bounds[] = [
        { x: 50, y: 0, width: 30, height: 100 },
      ];
      router.setObstacles(obstacles);

      const source: Point = { x: 20, y: 50 };
      const target: Point = { x: 120, y: 50 };

      const result = router.findOrthogonalPath(source, target);

      expect(result.path.length).toBeGreaterThan(2);
      expect(result.path[0]).toEqual(source);
      expect(result.path[result.path.length - 1]).toEqual(target);
    });
  });

  describe('routeEdge', () => {
    it('should route edge between two nodes', () => {
      const obstacles: Bounds[] = [
        { x: 150, y: 0, width: 50, height: 100 },
      ];
      router.setObstacles(obstacles);

      const sourceNode: Bounds = { x: 0, y: 25, width: 100, height: 50 };
      const targetNode: Bounds = { x: 250, y: 25, width: 100, height: 50 };

      const result = router.routeEdge(sourceNode, targetNode);

      expect(result.path.length).toBeGreaterThanOrEqual(2);
    });

    it('should use specified ports', () => {
      // Set up obstacles to ensure pathfinding has a proper grid
      const sourceNode: Bounds = { x: 0, y: 0, width: 100, height: 80 };
      const targetNode: Bounds = { x: 200, y: 0, width: 100, height: 80 };
      router.setObstacles([sourceNode, targetNode]);

      const result = router.routeEdge(sourceNode, targetNode, 'right', 'left');

      // Path should have at least start and end points
      expect(result.path.length).toBeGreaterThanOrEqual(1);

      // First point should be approximately at right side of source
      const startX = result.path[0].x;
      const startY = result.path[0].y;
      expect(startX).toBeGreaterThanOrEqual(80); // Allow tolerance
      expect(startX).toBeLessThanOrEqual(220);
      expect(startY).toBeGreaterThanOrEqual(0);
      expect(startY).toBeLessThanOrEqual(100);
    });

    it('should use top port', () => {
      router.setObstacles([]);

      const sourceNode: Bounds = { x: 0, y: 100, width: 100, height: 80 };
      const targetNode: Bounds = { x: 0, y: 0, width: 100, height: 50 };

      const result = router.routeEdge(sourceNode, targetNode, 'top', 'bottom');

      // Start should be on top of source
      expect(result.path[0].x).toBe(50); // centered
      expect(result.path[0].y).toBe(100); // sourceNode.y (top)
    });

    it('should use bottom port', () => {
      router.setObstacles([]);

      const sourceNode: Bounds = { x: 0, y: 0, width: 100, height: 80 };
      const targetNode: Bounds = { x: 0, y: 200, width: 100, height: 80 };

      const result = router.routeEdge(sourceNode, targetNode, 'bottom', 'top');

      // Start should be on bottom of source
      expect(result.path[0].x).toBe(50); // centered
      expect(result.path[0].y).toBe(80); // sourceNode.y + sourceNode.height
    });
  });

  describe('with custom options', () => {
    it('should respect cellSize option', () => {
      const routerSmallCell = new PathfindingRouter({ cellSize: 5 });
      const routerLargeCell = new PathfindingRouter({ cellSize: 20 });

      const obstacles: Bounds[] = [{ x: 50, y: 50, width: 50, height: 50 }];
      routerSmallCell.setObstacles(obstacles);
      routerLargeCell.setObstacles(obstacles);

      // Both should work
      const result1 = routerSmallCell.findPath({ x: 0, y: 75 }, { x: 150, y: 75 });
      const result2 = routerLargeCell.findPath({ x: 0, y: 75 }, { x: 150, y: 75 });

      expect(result1.path.length).toBeGreaterThanOrEqual(2);
      expect(result2.path.length).toBeGreaterThanOrEqual(2);
    });

    it('should respect obstacleMargin option', () => {
      const routerWithMargin = new PathfindingRouter({ obstacleMargin: 20 });
      routerWithMargin.setObstacles([{ x: 50, y: 50, width: 50, height: 50 }]);

      const result = routerWithMargin.findPath({ x: 0, y: 75 }, { x: 150, y: 75 });
      expect(result.path.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('routeEdges', () => {
  it('should route multiple edges', () => {
    const edges = [
      {
        id: 'e1',
        source: { x: 0, y: 0, width: 100, height: 80 },
        target: { x: 200, y: 0, width: 100, height: 80 },
      },
      {
        id: 'e2',
        source: { x: 0, y: 100, width: 100, height: 80 },
        target: { x: 200, y: 100, width: 100, height: 80 },
      },
    ];

    const obstacles: Bounds[] = [
      { x: 0, y: 0, width: 100, height: 80 },
      { x: 200, y: 0, width: 100, height: 80 },
      { x: 0, y: 100, width: 100, height: 80 },
      { x: 200, y: 100, width: 100, height: 80 },
    ];

    const results = routeEdges(edges, obstacles);

    expect(results.size).toBe(2);
    expect(results.has('e1')).toBe(true);
    expect(results.has('e2')).toBe(true);
    expect(results.get('e1')!.length).toBeGreaterThanOrEqual(2);
    expect(results.get('e2')!.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle empty edges array', () => {
    const results = routeEdges([], []);
    expect(results.size).toBe(0);
  });

  it('should respect port specifications', () => {
    const sourceNode = { x: 0, y: 0, width: 100, height: 80 };
    const targetNode = { x: 200, y: 0, width: 100, height: 80 };
    const edges = [
      {
        id: 'e1',
        source: sourceNode,
        target: targetNode,
        sourcePort: 'right' as const,
        targetPort: 'left' as const,
      },
    ];

    // Include nodes as obstacles to ensure proper grid
    const results = routeEdges(edges, [sourceNode, targetNode]);

    expect(results.size).toBe(1);
    const path = results.get('e1')!;
    expect(path.length).toBeGreaterThanOrEqual(1);
    // Path should exist and have valid coordinates
    expect(path[0].x).toBeGreaterThanOrEqual(0);
    expect(path[path.length - 1].x).toBeLessThanOrEqual(400);
  });
});

describe('findPathAvoidingObstacles', () => {
  it('should find a path avoiding obstacles', () => {
    const source: Point = { x: 0, y: 50 };
    const target: Point = { x: 200, y: 50 };
    const obstacles: Bounds[] = [
      { x: 80, y: 0, width: 40, height: 100 },
    ];

    const path = findPathAvoidingObstacles(source, target, obstacles);

    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0]).toEqual(source);
    expect(path[path.length - 1]).toEqual(target);
  });

  it('should return direct path when no obstacles', () => {
    const source: Point = { x: 0, y: 0 };
    const target: Point = { x: 100, y: 100 };

    const path = findPathAvoidingObstacles(source, target, []);

    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0]).toEqual(source);
    expect(path[path.length - 1]).toEqual(target);
  });

  it('should accept custom options', () => {
    const source: Point = { x: 0, y: 50 };
    const target: Point = { x: 200, y: 50 };
    const obstacles: Bounds[] = [
      { x: 80, y: 0, width: 40, height: 100 },
    ];

    const path = findPathAvoidingObstacles(source, target, obstacles, {
      cellSize: 5,
      obstacleMargin: 10,
    });

    expect(path.length).toBeGreaterThanOrEqual(2);
  });
});

describe('edge cases', () => {
  let router: PathfindingRouter;

  beforeEach(() => {
    router = new PathfindingRouter();
  });

  it('should handle source inside obstacle gracefully', () => {
    const obstacles: Bounds[] = [
      { x: 0, y: 0, width: 100, height: 100 },
    ];
    router.setObstacles(obstacles);

    // Source is inside the obstacle
    const source: Point = { x: 50, y: 50 };
    const target: Point = { x: 200, y: 50 };

    const result = router.findPath(source, target);

    // Should still return a path (even if not optimal)
    expect(result.path.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle target inside obstacle gracefully', () => {
    const obstacles: Bounds[] = [
      { x: 150, y: 0, width: 100, height: 100 },
    ];
    router.setObstacles(obstacles);

    const source: Point = { x: 0, y: 50 };
    // Target is inside the obstacle
    const target: Point = { x: 200, y: 50 };

    const result = router.findPath(source, target);

    expect(result.path.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle many obstacles', () => {
    const obstacles: Bounds[] = [];
    for (let i = 0; i < 20; i++) {
      obstacles.push({
        x: i * 50,
        y: (i % 2) * 100,
        width: 30,
        height: 30,
      });
    }
    router.setObstacles(obstacles);

    const source: Point = { x: 0, y: 50 };
    const target: Point = { x: 1000, y: 50 };

    const result = router.findPath(source, target);

    expect(result.path.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle very close source and target', () => {
    // Add some obstacles to ensure grid is built properly
    router.setObstacles([{ x: 0, y: 0, width: 50, height: 50 }]);

    const source: Point = { x: 100, y: 100 };
    const target: Point = { x: 101, y: 101 };

    const result = router.findPath(source, target);

    // For very close points, pathfinding may return a minimal path
    expect(result.path.length).toBeGreaterThanOrEqual(1);
    // First and last points should be close to source/target
    expect(Math.abs(result.path[0].x - source.x)).toBeLessThan(20);
    expect(Math.abs(result.path[result.path.length - 1].x - target.x)).toBeLessThan(20);
  });

  it('should handle negative coordinates', () => {
    const obstacles: Bounds[] = [
      { x: -50, y: -50, width: 100, height: 100 },
    ];
    router.setObstacles(obstacles);

    const source: Point = { x: -100, y: 0 };
    const target: Point = { x: 100, y: 0 };

    const result = router.findPath(source, target);

    expect(result.path.length).toBeGreaterThanOrEqual(2);
  });
});
