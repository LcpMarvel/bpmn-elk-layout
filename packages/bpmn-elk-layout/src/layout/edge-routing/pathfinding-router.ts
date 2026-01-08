/**
 * Pathfinding Router
 * Uses pathfinding library (A* algorithm) for obstacle-avoiding edge routing.
 * Provides better edge routing quality compared to simple obstacle detection.
 */

import PF from 'pathfinding';
import type { Bounds, Point } from '../../types/internal';

// ============================================================================
// Types
// ============================================================================

export interface PathfindingOptions {
  /** Grid cell size in pixels (smaller = more precise but slower) */
  cellSize: number;
  /** Margin around obstacles */
  obstacleMargin: number;
  /** Allow diagonal movement (usually false for BPMN orthogonal routing) */
  allowDiagonal: boolean;
  /** Padding around the grid bounds */
  gridPadding: number;
}

const DEFAULT_OPTIONS: PathfindingOptions = {
  cellSize: 10,
  obstacleMargin: 5,
  allowDiagonal: false,
  gridPadding: 50,
};

export interface RouteResult {
  /** Path points in absolute coordinates */
  path: Point[];
  /** Whether a valid path was found */
  success: boolean;
}

// ============================================================================
// Pathfinding Router
// ============================================================================

/**
 * Router that uses A* pathfinding for obstacle-avoiding edge routing
 */
export class PathfindingRouter {
  private options: PathfindingOptions;
  private obstacles: Bounds[] = [];
  private gridBounds: Bounds | null = null;
  private grid: PF.Grid | null = null;
  private finder: PF.AStarFinder;

  constructor(options?: Partial<PathfindingOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.finder = new PF.AStarFinder({
      allowDiagonal: this.options.allowDiagonal,
      dontCrossCorners: true,
    });
  }

  /**
   * Set obstacles (nodes that edges should avoid)
   */
  setObstacles(obstacles: Bounds[]): void {
    this.obstacles = obstacles.map((obs) => ({
      x: obs.x - this.options.obstacleMargin,
      y: obs.y - this.options.obstacleMargin,
      width: obs.width + this.options.obstacleMargin * 2,
      height: obs.height + this.options.obstacleMargin * 2,
    }));

    // Calculate grid bounds
    this.calculateGridBounds();

    // Build the grid
    this.buildGrid();
  }

  /**
   * Find a path between two points avoiding obstacles
   */
  findPath(source: Point, target: Point): RouteResult {
    if (!this.grid || !this.gridBounds) {
      return { path: [source, target], success: false };
    }

    // Convert points to grid coordinates
    const startGrid = this.toGridCoords(source);
    const endGrid = this.toGridCoords(target);

    // Clamp to grid bounds
    const gridWidth = this.grid.width;
    const gridHeight = this.grid.height;

    const clampedStart = {
      x: Math.max(0, Math.min(gridWidth - 1, startGrid.x)),
      y: Math.max(0, Math.min(gridHeight - 1, startGrid.y)),
    };
    const clampedEnd = {
      x: Math.max(0, Math.min(gridWidth - 1, endGrid.x)),
      y: Math.max(0, Math.min(gridHeight - 1, endGrid.y)),
    };

    // Clone grid for pathfinding (finder modifies the grid)
    const gridClone = this.grid.clone();

    // Ensure start and end cells are walkable
    gridClone.setWalkableAt(clampedStart.x, clampedStart.y, true);
    gridClone.setWalkableAt(clampedEnd.x, clampedEnd.y, true);

    // Find path
    const gridPath = this.finder.findPath(
      clampedStart.x,
      clampedStart.y,
      clampedEnd.x,
      clampedEnd.y,
      gridClone
    );

    if (gridPath.length === 0) {
      // No path found, return direct line
      return { path: [source, target], success: false };
    }

    // Convert grid path to absolute coordinates
    const absolutePath = gridPath.map(([gx, gy]) => this.toAbsoluteCoords({ x: gx, y: gy }));

    // Simplify the path (remove redundant points)
    const simplifiedPath = this.simplifyPath(absolutePath);

    // Ensure start and end points are exact
    if (simplifiedPath.length > 0) {
      simplifiedPath[0] = source;
      simplifiedPath[simplifiedPath.length - 1] = target;
    }

    return { path: simplifiedPath, success: true };
  }

  /**
   * Find an orthogonal path (only horizontal and vertical segments)
   */
  findOrthogonalPath(source: Point, target: Point): RouteResult {
    const result = this.findPath(source, target);

    if (!result.success) {
      // Create a simple orthogonal path
      return {
        path: this.createSimpleOrthogonalPath(source, target),
        success: false,
      };
    }

    // Orthogonalize the path
    const orthogonalPath = this.orthogonalizePath(result.path);

    return { path: orthogonalPath, success: true };
  }

  /**
   * Route an edge from source node to target node
   */
  routeEdge(
    sourceNode: Bounds,
    targetNode: Bounds,
    sourcePort?: 'top' | 'bottom' | 'left' | 'right',
    targetPort?: 'top' | 'bottom' | 'left' | 'right'
  ): RouteResult {
    // Determine connection points
    const source = this.getConnectionPoint(sourceNode, sourcePort ?? this.getBestSourcePort(sourceNode, targetNode));
    const target = this.getConnectionPoint(targetNode, targetPort ?? this.getBestTargetPort(sourceNode, targetNode));

    return this.findOrthogonalPath(source, target);
  }

  // ============================================================================
  // Private: Grid Building
  // ============================================================================

  private calculateGridBounds(): void {
    if (this.obstacles.length === 0) {
      this.gridBounds = { x: 0, y: 0, width: 100, height: 100 };
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const obs of this.obstacles) {
      minX = Math.min(minX, obs.x);
      minY = Math.min(minY, obs.y);
      maxX = Math.max(maxX, obs.x + obs.width);
      maxY = Math.max(maxY, obs.y + obs.height);
    }

    const padding = this.options.gridPadding;
    this.gridBounds = {
      x: minX - padding,
      y: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    };
  }

  private buildGrid(): void {
    if (!this.gridBounds) return;

    const cellSize = this.options.cellSize;
    const gridWidth = Math.ceil(this.gridBounds.width / cellSize);
    const gridHeight = Math.ceil(this.gridBounds.height / cellSize);

    // Create grid with all cells walkable
    this.grid = new PF.Grid(gridWidth, gridHeight);

    // Mark obstacle cells as unwalkable
    for (const obs of this.obstacles) {
      const startX = Math.floor((obs.x - this.gridBounds.x) / cellSize);
      const startY = Math.floor((obs.y - this.gridBounds.y) / cellSize);
      const endX = Math.ceil((obs.x + obs.width - this.gridBounds.x) / cellSize);
      const endY = Math.ceil((obs.y + obs.height - this.gridBounds.y) / cellSize);

      for (let gx = startX; gx < endX; gx++) {
        for (let gy = startY; gy < endY; gy++) {
          if (gx >= 0 && gx < gridWidth && gy >= 0 && gy < gridHeight) {
            this.grid.setWalkableAt(gx, gy, false);
          }
        }
      }
    }
  }

  // ============================================================================
  // Private: Coordinate Conversion
  // ============================================================================

  private toGridCoords(point: Point): { x: number; y: number } {
    if (!this.gridBounds) return { x: 0, y: 0 };

    return {
      x: Math.round((point.x - this.gridBounds.x) / this.options.cellSize),
      y: Math.round((point.y - this.gridBounds.y) / this.options.cellSize),
    };
  }

  private toAbsoluteCoords(gridPoint: { x: number; y: number }): Point {
    if (!this.gridBounds) return { x: 0, y: 0 };

    return {
      x: gridPoint.x * this.options.cellSize + this.gridBounds.x,
      y: gridPoint.y * this.options.cellSize + this.gridBounds.y,
    };
  }

  // ============================================================================
  // Private: Path Processing
  // ============================================================================

  private simplifyPath(path: Point[]): Point[] {
    if (path.length <= 2) return path;

    const result: Point[] = [path[0]];

    for (let i = 1; i < path.length - 1; i++) {
      const prev = path[i - 1];
      const curr = path[i];
      const next = path[i + 1];

      // Check if direction changes
      const dx1 = curr.x - prev.x;
      const dy1 = curr.y - prev.y;
      const dx2 = next.x - curr.x;
      const dy2 = next.y - curr.y;

      // Normalize directions
      const dir1x = dx1 === 0 ? 0 : dx1 / Math.abs(dx1);
      const dir1y = dy1 === 0 ? 0 : dy1 / Math.abs(dy1);
      const dir2x = dx2 === 0 ? 0 : dx2 / Math.abs(dx2);
      const dir2y = dy2 === 0 ? 0 : dy2 / Math.abs(dy2);

      // Keep point if direction changes
      if (dir1x !== dir2x || dir1y !== dir2y) {
        result.push(curr);
      }
    }

    result.push(path[path.length - 1]);
    return result;
  }

  private orthogonalizePath(path: Point[]): Point[] {
    if (path.length <= 1) return path;

    const result: Point[] = [path[0]];

    for (let i = 1; i < path.length; i++) {
      const prev = result[result.length - 1];
      const curr = path[i];

      // If not already orthogonal, add intermediate point
      if (prev.x !== curr.x && prev.y !== curr.y) {
        // Prefer horizontal-then-vertical routing
        result.push({ x: curr.x, y: prev.y });
      }

      result.push(curr);
    }

    return result;
  }

  private createSimpleOrthogonalPath(source: Point, target: Point): Point[] {
    // Simple L-shaped or Z-shaped path
    const midX = (source.x + target.x) / 2;

    if (source.y === target.y) {
      return [source, target];
    }

    if (source.x === target.x) {
      return [source, target];
    }

    // Create a path with intermediate points
    return [
      source,
      { x: midX, y: source.y },
      { x: midX, y: target.y },
      target,
    ];
  }

  // ============================================================================
  // Private: Connection Points
  // ============================================================================

  private getConnectionPoint(node: Bounds, port: 'top' | 'bottom' | 'left' | 'right'): Point {
    switch (port) {
      case 'top':
        return { x: node.x + node.width / 2, y: node.y };
      case 'bottom':
        return { x: node.x + node.width / 2, y: node.y + node.height };
      case 'left':
        return { x: node.x, y: node.y + node.height / 2 };
      case 'right':
        return { x: node.x + node.width, y: node.y + node.height / 2 };
    }
  }

  private getBestSourcePort(source: Bounds, target: Bounds): 'top' | 'bottom' | 'left' | 'right' {
    const sourceCenterX = source.x + source.width / 2;
    const sourceCenterY = source.y + source.height / 2;
    const targetCenterX = target.x + target.width / 2;
    const targetCenterY = target.y + target.height / 2;

    const dx = targetCenterX - sourceCenterX;
    const dy = targetCenterY - sourceCenterY;

    if (Math.abs(dx) > Math.abs(dy)) {
      return dx > 0 ? 'right' : 'left';
    } else {
      return dy > 0 ? 'bottom' : 'top';
    }
  }

  private getBestTargetPort(source: Bounds, target: Bounds): 'top' | 'bottom' | 'left' | 'right' {
    const sourceCenterX = source.x + source.width / 2;
    const sourceCenterY = source.y + source.height / 2;
    const targetCenterX = target.x + target.width / 2;
    const targetCenterY = target.y + target.height / 2;

    const dx = sourceCenterX - targetCenterX;
    const dy = sourceCenterY - targetCenterY;

    if (Math.abs(dx) > Math.abs(dy)) {
      return dx > 0 ? 'right' : 'left';
    } else {
      return dy > 0 ? 'bottom' : 'top';
    }
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Route multiple edges with obstacle avoidance
 */
export function routeEdges(
  edges: Array<{
    id: string;
    source: Bounds;
    target: Bounds;
    sourcePort?: 'top' | 'bottom' | 'left' | 'right';
    targetPort?: 'top' | 'bottom' | 'left' | 'right';
  }>,
  obstacles: Bounds[],
  options?: Partial<PathfindingOptions>
): Map<string, Point[]> {
  const router = new PathfindingRouter(options);
  router.setObstacles(obstacles);

  const results = new Map<string, Point[]>();

  for (const edge of edges) {
    const result = router.routeEdge(edge.source, edge.target, edge.sourcePort, edge.targetPort);
    results.set(edge.id, result.path);
  }

  return results;
}

/**
 * Find a path between two points avoiding obstacles
 */
export function findPathAvoidingObstacles(
  source: Point,
  target: Point,
  obstacles: Bounds[],
  options?: Partial<PathfindingOptions>
): Point[] {
  const router = new PathfindingRouter(options);
  router.setObstacles(obstacles);
  const result = router.findOrthogonalPath(source, target);
  return result.path;
}
