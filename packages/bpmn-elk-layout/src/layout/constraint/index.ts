/**
 * Constraint-based Layout Module
 * Provides declarative constraint-based layout using Cassowary algorithm.
 */

export {
  ConstraintSolver,
  generateBpmnConstraints,
  type LayoutConstraint,
  type AlignXConstraint,
  type AlignYConstraint,
  type LeftOfConstraint,
  type RightOfConstraint,
  type AboveConstraint,
  type BelowConstraint,
  type NoOverlapConstraint,
  type FixedPositionConstraint,
  type InContainerConstraint,
  type MinDistanceConstraint,
  type ConstraintStrength,
  type ConstraintSolverOptions,
  type BpmnConstraintGeneratorOptions,
} from './constraint-solver';
