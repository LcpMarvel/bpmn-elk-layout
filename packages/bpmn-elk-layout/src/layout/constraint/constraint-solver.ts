/**
 * Constraint-based Layout Solver
 * Uses kiwi.js (Cassowary algorithm) for declarative layout constraints.
 * Replaces imperative post-processing with declarative constraint specifications.
 *
 * Note: Cassowary has specific ordering requirements:
 * - Constraints should be added before edit variables
 * - Use a two-phase approach: collect all constraints, then solve
 */

import * as kiwi from 'kiwi.js';
import type { Bounds } from '../../types/internal';

// ============================================================================
// Constraint Types
// ============================================================================

/**
 * Constraint type definitions for BPMN layout
 */
export type LayoutConstraint =
  | AlignXConstraint
  | AlignYConstraint
  | LeftOfConstraint
  | RightOfConstraint
  | AboveConstraint
  | BelowConstraint
  | NoOverlapConstraint
  | FixedPositionConstraint
  | InContainerConstraint
  | MinDistanceConstraint;

export interface AlignXConstraint {
  type: 'alignX';
  nodes: string[];
  strength?: ConstraintStrength;
}

export interface AlignYConstraint {
  type: 'alignY';
  nodes: string[];
  strength?: ConstraintStrength;
}

export interface LeftOfConstraint {
  type: 'leftOf';
  node: string;
  reference: string;
  minGap: number;
  strength?: ConstraintStrength;
}

export interface RightOfConstraint {
  type: 'rightOf';
  node: string;
  reference: string;
  minGap: number;
  strength?: ConstraintStrength;
}

export interface AboveConstraint {
  type: 'above';
  node: string;
  reference: string;
  minGap: number;
  strength?: ConstraintStrength;
}

export interface BelowConstraint {
  type: 'below';
  node: string;
  reference: string;
  minGap: number;
  strength?: ConstraintStrength;
}

export interface NoOverlapConstraint {
  type: 'noOverlap';
  nodes: [string, string];
  margin: number;
  strength?: ConstraintStrength;
}

export interface FixedPositionConstraint {
  type: 'fixedPosition';
  node: string;
  x?: number;
  y?: number;
  strength?: ConstraintStrength;
}

export interface InContainerConstraint {
  type: 'inContainer';
  node: string;
  container: string;
  padding: number;
  strength?: ConstraintStrength;
}

export interface MinDistanceConstraint {
  type: 'minDistance';
  node1: string;
  node2: string;
  axis: 'x' | 'y';
  minDistance: number;
  strength?: ConstraintStrength;
}

export type ConstraintStrength = 'required' | 'strong' | 'medium' | 'weak';

// ============================================================================
// Node Variables
// ============================================================================

interface NodeVariables {
  x: kiwi.Variable;
  y: kiwi.Variable;
  width: number;
  height: number;
  initialX: number;
  initialY: number;
}

interface PendingConstraint {
  constraint: LayoutConstraint;
  strength: number;
}

// ============================================================================
// Constraint Solver
// ============================================================================

export interface ConstraintSolverOptions {
  /** Default strength for constraints without explicit strength */
  defaultStrength?: ConstraintStrength;
  /** Enable debug logging */
  debug?: boolean;
}

const DEFAULT_OPTIONS: ConstraintSolverOptions = {
  defaultStrength: 'strong',
  debug: false,
};

/**
 * Constraint-based layout solver using Cassowary algorithm
 *
 * Usage pattern:
 * 1. Add all nodes with addNode()
 * 2. Add all constraints with addConstraint()
 * 3. Call solve() to get results
 *
 * The solver handles the correct ordering internally.
 */
export class ConstraintSolver {
  private solver: kiwi.Solver | null = null;
  private variables: Map<string, NodeVariables>;
  private pendingConstraints: PendingConstraint[];
  private kiwiConstraints: kiwi.Constraint[];
  private options: ConstraintSolverOptions;
  private solved: boolean = false;

  constructor(options?: ConstraintSolverOptions) {
    this.variables = new Map();
    this.pendingConstraints = [];
    this.kiwiConstraints = [];
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Add a node to the solver
   * Note: Nodes are stored but not added to solver until solve() is called
   */
  addNode(
    id: string,
    initialX: number,
    initialY: number,
    width: number,
    height: number
  ): void {
    if (this.variables.has(id)) {
      if (this.options.debug) {
        console.log(`[Constraint] Node ${id} already exists, skipping`);
      }
      return;
    }

    const x = new kiwi.Variable(`${id}_x`);
    const y = new kiwi.Variable(`${id}_y`);

    // Store the node with initial values - will be added to solver in solve()
    this.variables.set(id, { x, y, width, height, initialX, initialY });

    if (this.options.debug) {
      console.log(`[Constraint] Added node ${id} at (${initialX}, ${initialY})`);
    }
  }

  /**
   * Add a node from bounds
   */
  addNodeFromBounds(id: string, bounds: Bounds): void {
    this.addNode(id, bounds.x, bounds.y, bounds.width, bounds.height);
  }

  /**
   * Add multiple nodes from a map
   */
  addNodesFromMap(nodes: Map<string, Bounds>): void {
    for (const [id, bounds] of nodes) {
      this.addNodeFromBounds(id, bounds);
    }
  }

  /**
   * Add a constraint
   * Note: Constraints are stored and applied when solve() is called
   */
  addConstraint(constraint: LayoutConstraint): boolean {
    // Check if all referenced nodes exist
    const nodeIds = this.getConstraintNodeIds(constraint);
    for (const id of nodeIds) {
      if (!this.variables.has(id)) {
        if (this.options.debug) {
          console.log(`[Constraint] Node ${id} not found for constraint`);
        }
        return false;
      }
    }

    if (constraint.type === 'noOverlap') {
      // NoOverlap is handled specially - it's a disjunctive constraint
      // Cassowary doesn't directly support disjunctions
      if (this.options.debug) {
        console.log(`[Constraint] noOverlap constraint requires special handling`);
      }
      return false;
    }

    const strength = this.getStrength(constraint.strength);
    this.pendingConstraints.push({ constraint, strength });
    return true;
  }

  /**
   * Get node IDs referenced by a constraint
   */
  private getConstraintNodeIds(constraint: LayoutConstraint): string[] {
    switch (constraint.type) {
      case 'alignX':
      case 'alignY':
        return constraint.nodes;
      case 'leftOf':
      case 'rightOf':
      case 'above':
      case 'below':
        return [constraint.node, constraint.reference];
      case 'fixedPosition':
        return [constraint.node];
      case 'inContainer':
        return [constraint.node, constraint.container];
      case 'minDistance':
        return [constraint.node1, constraint.node2];
      case 'noOverlap':
        return constraint.nodes;
      default:
        return [];
    }
  }

  /**
   * Add multiple constraints
   */
  addConstraints(constraints: LayoutConstraint[]): number {
    let successCount = 0;
    for (const constraint of constraints) {
      if (this.addConstraint(constraint)) {
        successCount++;
      }
    }
    return successCount;
  }

  /**
   * Build and solve the constraint system
   */
  solve(): Map<string, { x: number; y: number }> {
    if (this.solved) {
      // Return cached results
      const result = new Map<string, { x: number; y: number }>();
      for (const [id, vars] of this.variables) {
        result.set(id, {
          x: vars.x.value(),
          y: vars.y.value(),
        });
      }
      return result;
    }

    // Create fresh solver
    this.solver = new kiwi.Solver();
    this.kiwiConstraints = [];

    // Step 1: Add all kiwi constraints FIRST (before edit variables)
    for (const pending of this.pendingConstraints) {
      this.applyConstraint(pending.constraint, pending.strength);
    }

    // Step 2: Add edit variables and suggest initial values
    for (const [_id, vars] of this.variables) {
      this.solver.addEditVariable(vars.x, kiwi.Strength.weak);
      this.solver.addEditVariable(vars.y, kiwi.Strength.weak);
      this.solver.suggestValue(vars.x, vars.initialX);
      this.solver.suggestValue(vars.y, vars.initialY);
    }

    // Step 3: Solve
    try {
      this.solver.updateVariables();
      this.solved = true;
    } catch (error) {
      if (this.options.debug) {
        console.error(`[Constraint] Solver failed:`, error);
      }
    }

    const result = new Map<string, { x: number; y: number }>();
    for (const [id, vars] of this.variables) {
      result.set(id, {
        x: vars.x.value(),
        y: vars.y.value(),
      });
    }
    return result;
  }

  /**
   * Apply a constraint to the solver
   */
  private applyConstraint(constraint: LayoutConstraint, strength: number): boolean {
    try {
      switch (constraint.type) {
        case 'alignX':
          return this.addAlignXConstraint(constraint, strength);
        case 'alignY':
          return this.addAlignYConstraint(constraint, strength);
        case 'leftOf':
          return this.addLeftOfConstraint(constraint, strength);
        case 'rightOf':
          return this.addRightOfConstraint(constraint, strength);
        case 'above':
          return this.addAboveConstraint(constraint, strength);
        case 'below':
          return this.addBelowConstraint(constraint, strength);
        case 'fixedPosition':
          return this.addFixedPositionConstraint(constraint, strength);
        case 'inContainer':
          return this.addInContainerConstraint(constraint, strength);
        case 'minDistance':
          return this.addMinDistanceConstraint(constraint, strength);
        default:
          return false;
      }
    } catch (error) {
      if (this.options.debug) {
        console.error(`[Constraint] Failed to apply constraint:`, error);
      }
      return false;
    }
  }

  /**
   * Get full bounds including width and height
   */
  solveWithBounds(): Map<string, Bounds> {
    const positions = this.solve();
    const result = new Map<string, Bounds>();

    for (const [id, pos] of positions) {
      const vars = this.variables.get(id);
      if (vars) {
        result.set(id, {
          x: pos.x,
          y: pos.y,
          width: vars.width,
          height: vars.height,
        });
      }
    }

    return result;
  }

  /**
   * Clear all nodes and constraints
   */
  clear(): void {
    this.solver = null;
    this.variables.clear();
    this.pendingConstraints = [];
    this.kiwiConstraints = [];
    this.solved = false;
  }

  // ============================================================================
  // Private: Constraint Implementations
  // ============================================================================

  private addAlignXConstraint(
    constraint: AlignXConstraint,
    strength: number
  ): boolean {
    const nodes = constraint.nodes
      .map((id) => this.variables.get(id))
      .filter((v): v is NodeVariables => v !== undefined);

    if (nodes.length < 2) return false;

    // Align all X coordinates to the first node's X
    const referenceX = nodes[0].x;
    for (let i = 1; i < nodes.length; i++) {
      // x[i] == x[0] => x[i] - x[0] == 0
      // Expression: x[i] + (-1 * x[0]) + 0 == 0
      // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
      const c = new kiwi.Constraint(
        new kiwi.Expression(nodes[i].x, [-1, referenceX]),
        kiwi.Operator.Eq,
        0,
        strength
      );
      this.solver!.addConstraint(c);
      this.kiwiConstraints.push(c);
    }

    return true;
  }

  private addAlignYConstraint(
    constraint: AlignYConstraint,
    strength: number
  ): boolean {
    const nodes = constraint.nodes
      .map((id) => this.variables.get(id))
      .filter((v): v is NodeVariables => v !== undefined);

    if (nodes.length < 2) return false;

    // Align all Y coordinates to the first node's Y
    const referenceY = nodes[0].y;
    for (let i = 1; i < nodes.length; i++) {
      // y[i] == y[0] => y[i] - y[0] == 0
      // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
      const c = new kiwi.Constraint(
        new kiwi.Expression(nodes[i].y, [-1, referenceY]),
        kiwi.Operator.Eq,
        0,
        strength
      );
      this.solver!.addConstraint(c);
      this.kiwiConstraints.push(c);
    }

    return true;
  }

  private addLeftOfConstraint(
    constraint: LeftOfConstraint,
    strength: number
  ): boolean {
    const nodeVars = this.variables.get(constraint.node);
    const refVars = this.variables.get(constraint.reference);
    if (!nodeVars || !refVars) return false;

    // node.x + node.width + minGap <= reference.x
    // => reference.x - node.x >= node.width + minGap
    // => reference.x - node.x - (width + minGap) >= 0
    // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
    const minSeparation = nodeVars.width + constraint.minGap;
    const c = new kiwi.Constraint(
      new kiwi.Expression(refVars.x, [-1, nodeVars.x], -minSeparation),
      kiwi.Operator.Ge,
      0,
      strength
    );
    this.solver!.addConstraint(c);
    this.kiwiConstraints.push(c);

    return true;
  }

  private addRightOfConstraint(
    constraint: RightOfConstraint,
    strength: number
  ): boolean {
    const nodeVars = this.variables.get(constraint.node);
    const refVars = this.variables.get(constraint.reference);
    if (!nodeVars || !refVars) return false;

    // node.x >= reference.x + reference.width + minGap
    // node.x - reference.x - (width + minGap) >= 0
    // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
    const minSeparation = refVars.width + constraint.minGap;
    const c = new kiwi.Constraint(
      new kiwi.Expression(nodeVars.x, [-1, refVars.x], -minSeparation),
      kiwi.Operator.Ge,
      0,
      strength
    );
    this.solver!.addConstraint(c);
    this.kiwiConstraints.push(c);

    return true;
  }

  private addAboveConstraint(
    constraint: AboveConstraint,
    strength: number
  ): boolean {
    const nodeVars = this.variables.get(constraint.node);
    const refVars = this.variables.get(constraint.reference);
    if (!nodeVars || !refVars) return false;

    // node.y + node.height + minGap <= reference.y
    // reference.y - node.y - (height + minGap) >= 0
    // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
    const minSeparation = nodeVars.height + constraint.minGap;
    const c = new kiwi.Constraint(
      new kiwi.Expression(refVars.y, [-1, nodeVars.y], -minSeparation),
      kiwi.Operator.Ge,
      0,
      strength
    );
    this.solver!.addConstraint(c);
    this.kiwiConstraints.push(c);

    return true;
  }

  private addBelowConstraint(
    constraint: BelowConstraint,
    strength: number
  ): boolean {
    const nodeVars = this.variables.get(constraint.node);
    const refVars = this.variables.get(constraint.reference);
    if (!nodeVars || !refVars) return false;

    // node.y >= reference.y + reference.height + minGap
    // node.y - reference.y - (height + minGap) >= 0
    // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
    const minSeparation = refVars.height + constraint.minGap;
    const c = new kiwi.Constraint(
      new kiwi.Expression(nodeVars.y, [-1, refVars.y], -minSeparation),
      kiwi.Operator.Ge,
      0,
      strength
    );
    this.solver!.addConstraint(c);
    this.kiwiConstraints.push(c);

    return true;
  }

  private addFixedPositionConstraint(
    constraint: FixedPositionConstraint,
    strength: number
  ): boolean {
    const nodeVars = this.variables.get(constraint.node);
    if (!nodeVars) return false;

    if (constraint.x !== undefined) {
      // x == fixedX => x - fixedX == 0
      // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
      const c = new kiwi.Constraint(
        new kiwi.Expression(nodeVars.x, -constraint.x),
        kiwi.Operator.Eq,
        0,
        strength
      );
      this.solver!.addConstraint(c);
      this.kiwiConstraints.push(c);
    }

    if (constraint.y !== undefined) {
      // y == fixedY => y - fixedY == 0
      // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
      const c = new kiwi.Constraint(
        new kiwi.Expression(nodeVars.y, -constraint.y),
        kiwi.Operator.Eq,
        0,
        strength
      );
      this.solver!.addConstraint(c);
      this.kiwiConstraints.push(c);
    }

    return true;
  }

  private addInContainerConstraint(
    constraint: InContainerConstraint,
    strength: number
  ): boolean {
    const nodeVars = this.variables.get(constraint.node);
    const containerVars = this.variables.get(constraint.container);
    if (!nodeVars || !containerVars) return false;

    const padding = constraint.padding;

    // node.x >= container.x + padding
    // node.x - container.x - padding >= 0
    // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
    const leftC = new kiwi.Constraint(
      new kiwi.Expression(nodeVars.x, [-1, containerVars.x], -padding),
      kiwi.Operator.Ge,
      0,
      strength
    );
    this.solver!.addConstraint(leftC);
    this.kiwiConstraints.push(leftC);

    // node.y >= container.y + padding
    // node.y - container.y - padding >= 0
    // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
    const topC = new kiwi.Constraint(
      new kiwi.Expression(nodeVars.y, [-1, containerVars.y], -padding),
      kiwi.Operator.Ge,
      0,
      strength
    );
    this.solver!.addConstraint(topC);
    this.kiwiConstraints.push(topC);

    // node.x + node.width <= container.x + container.width - padding
    // container.x - node.x + (container.width - padding - node.width) >= 0
    // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
    const rightC = new kiwi.Constraint(
      new kiwi.Expression(
        containerVars.x,
        [-1, nodeVars.x],
        containerVars.width - padding - nodeVars.width
      ),
      kiwi.Operator.Ge,
      0,
      strength
    );
    this.solver!.addConstraint(rightC);
    this.kiwiConstraints.push(rightC);

    // node.y + node.height <= container.y + container.height - padding
    // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
    const bottomC = new kiwi.Constraint(
      new kiwi.Expression(
        containerVars.y,
        [-1, nodeVars.y],
        containerVars.height - padding - nodeVars.height
      ),
      kiwi.Operator.Ge,
      0,
      strength
    );
    this.solver!.addConstraint(bottomC);
    this.kiwiConstraints.push(bottomC);

    return true;
  }

  private addMinDistanceConstraint(
    constraint: MinDistanceConstraint,
    strength: number
  ): boolean {
    const node1Vars = this.variables.get(constraint.node1);
    const node2Vars = this.variables.get(constraint.node2);
    if (!node1Vars || !node2Vars) return false;

    if (constraint.axis === 'x') {
      // |node1.x - node2.x| >= minDistance
      // We need to handle this as: node1.x - node2.x >= minDistance OR node2.x - node1.x >= minDistance
      // Cassowary can't handle OR, so we use a soft constraint that prefers separation
      // This is a simplification - in practice, we rely on other constraints to maintain order

      // Use a weaker constraint: prefer node2.x > node1.x + width + minDistance
      // node2.x - node1.x - (width + minDistance) >= 0
      // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
      const size = node1Vars.width;
      const c = new kiwi.Constraint(
        new kiwi.Expression(
          node2Vars.x,
          [-1, node1Vars.x],
          -(size + constraint.minDistance)
        ),
        kiwi.Operator.Ge,
        0,
        strength
      );
      this.solver!.addConstraint(c);
      this.kiwiConstraints.push(c);
    } else {
      // node2.y - node1.y - (height + minDistance) >= 0
      // kiwi.Constraint(expr, op, rhs?, strength?) - pass 0 as rhs, strength as 4th arg
      const size = node1Vars.height;
      const c = new kiwi.Constraint(
        new kiwi.Expression(
          node2Vars.y,
          [-1, node1Vars.y],
          -(size + constraint.minDistance)
        ),
        kiwi.Operator.Ge,
        0,
        strength
      );
      this.solver!.addConstraint(c);
      this.kiwiConstraints.push(c);
    }

    return true;
  }

  // ============================================================================
  // Private: Helpers
  // ============================================================================

  private getStrength(strength?: ConstraintStrength): number {
    const s = strength ?? this.options.defaultStrength ?? 'strong';
    switch (s) {
      case 'required':
        return kiwi.Strength.required;
      case 'strong':
        return kiwi.Strength.strong;
      case 'medium':
        return kiwi.Strength.medium;
      case 'weak':
        return kiwi.Strength.weak;
      default:
        return kiwi.Strength.strong;
    }
  }
}

// ============================================================================
// BPMN Constraint Generator
// ============================================================================

export interface BpmnConstraintGeneratorOptions {
  /** Minimum horizontal gap between nodes */
  horizontalGap: number;
  /** Minimum vertical gap between nodes */
  verticalGap: number;
  /** Gap between boundary event targets and their parent */
  boundaryEventGap: number;
  /** Padding inside containers */
  containerPadding: number;
}

const DEFAULT_BPMN_OPTIONS: BpmnConstraintGeneratorOptions = {
  horizontalGap: 50,
  verticalGap: 40,
  boundaryEventGap: 50,
  containerPadding: 20,
};

/**
 * Generate BPMN-specific layout constraints
 */
export function generateBpmnConstraints(
  nodes: Map<string, Bounds>,
  edges: Array<{ source: string; target: string; type?: string }>,
  boundaryEvents: Array<{ id: string; attachedToRef: string; targetId?: string }>,
  lanes: Array<{ id: string; parentId: string }>,
  options?: Partial<BpmnConstraintGeneratorOptions>
): LayoutConstraint[] {
  const opts = { ...DEFAULT_BPMN_OPTIONS, ...options };
  const constraints: LayoutConstraint[] = [];

  // 1. Sequence flow direction constraints (source left of target)
  for (const edge of edges) {
    if (edge.type === 'sequenceFlow' || !edge.type) {
      if (nodes.has(edge.source) && nodes.has(edge.target)) {
        constraints.push({
          type: 'leftOf',
          node: edge.source,
          reference: edge.target,
          minGap: opts.horizontalGap,
          strength: 'strong',
        });
      }
    }
  }

  // 2. Boundary event targets below their attached tasks
  for (const be of boundaryEvents) {
    if (be.targetId && nodes.has(be.attachedToRef) && nodes.has(be.targetId)) {
      constraints.push({
        type: 'below',
        node: be.targetId,
        reference: be.attachedToRef,
        minGap: opts.boundaryEventGap,
        strength: 'required',
      });
    }
  }

  // 3. Lanes stacked vertically
  const lanesByParent = new Map<string, string[]>();
  for (const lane of lanes) {
    const parentLanes = lanesByParent.get(lane.parentId) || [];
    parentLanes.push(lane.id);
    lanesByParent.set(lane.parentId, parentLanes);
  }

  for (const [_parentId, laneIds] of lanesByParent) {
    for (let i = 1; i < laneIds.length; i++) {
      if (nodes.has(laneIds[i - 1]) && nodes.has(laneIds[i])) {
        constraints.push({
          type: 'below',
          node: laneIds[i],
          reference: laneIds[i - 1],
          minGap: 0,
          strength: 'required',
        });
      }
    }
  }

  return constraints;
}
