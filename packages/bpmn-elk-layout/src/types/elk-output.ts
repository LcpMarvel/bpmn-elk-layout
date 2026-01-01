/**
 * ELK Layout Output Types
 * Types for the result of ELK layout calculation (with coordinates)
 */

import type {
  ElkBpmnGraph,
  Collaboration,
  Participant,
  Lane,
  Process,
  FlowNode,
  SequenceFlow,
  MessageFlow,
  DataAssociation,
  BoundaryEvent,
  Artifact,
  Label,
} from './elk-bpmn';

// ============================================================================
// Layouted Types (with x, y coordinates)
// ============================================================================

export interface Point {
  x: number;
  y: number;
}

export interface EdgeSection {
  id?: string;
  startPoint: Point;
  endPoint: Point;
  bendPoints?: Point[];
  incomingShape?: string;
  outgoingShape?: string;
  incomingSections?: string[];
  outgoingSections?: string[];
}

// ============================================================================
// Layouted Graph (root)
// ============================================================================

export interface LayoutedGraph extends ElkBpmnGraph {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children: (LayoutedCollaboration | LayoutedProcess)[];
}

// ============================================================================
// Layouted Collaboration & Participant
// ============================================================================

export interface LayoutedCollaboration extends Omit<Collaboration, 'children' | 'edges'> {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children: LayoutedParticipant[];
  edges?: LayoutedMessageFlow[];
}

export interface LayoutedParticipant extends Omit<Participant, 'children' | 'edges'> {
  x: number;
  y: number;
  width: number;
  height: number;
  children?: (LayoutedLane | LayoutedFlowNode)[];
  edges?: LayoutedSequenceFlow[];
}

// ============================================================================
// Layouted Lane
// ============================================================================

export interface LayoutedLane extends Omit<Lane, 'children'> {
  x: number;
  y: number;
  width: number;
  height: number;
  children?: (LayoutedLane | LayoutedFlowNode)[];
}

// ============================================================================
// Layouted Process
// ============================================================================

export interface LayoutedProcess extends Omit<Process, 'children' | 'edges' | 'artifacts'> {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: (LayoutedLane | LayoutedFlowNode)[];
  edges?: (LayoutedSequenceFlow | LayoutedDataAssociation)[];
  artifacts?: LayoutedArtifact[];
}

// ============================================================================
// Layouted Flow Node
// ============================================================================

export interface LayoutedFlowNode extends Omit<FlowNode, 'children' | 'edges' | 'boundaryEvents' | 'labels'> {
  x: number;
  y: number;
  width: number;
  height: number;
  children?: LayoutedFlowNode[];
  edges?: LayoutedSequenceFlow[];
  boundaryEvents?: LayoutedBoundaryEvent[];
  labels?: LayoutedLabel[];
}

export interface LayoutedBoundaryEvent extends Omit<BoundaryEvent, 'labels'> {
  x: number;
  y: number;
  width: number;
  height: number;
  labels?: LayoutedLabel[];
}

export interface LayoutedLabel extends Label {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ============================================================================
// Layouted Edges
// ============================================================================

export interface LayoutedSequenceFlow extends Omit<SequenceFlow, 'labels'> {
  sections: EdgeSection[];
  labels?: LayoutedLabel[];
  container?: string;
}

export interface LayoutedMessageFlow extends Omit<MessageFlow, 'labels'> {
  sections: EdgeSection[];
  labels?: LayoutedLabel[];
  container?: string;
}

export interface LayoutedDataAssociation extends DataAssociation {
  sections: EdgeSection[];
  container?: string;
}

// ============================================================================
// Layouted Artifacts
// ============================================================================

export interface LayoutedArtifact extends Omit<Artifact, 'labels'> {
  x: number;
  y: number;
  width: number;
  height: number;
  labels?: LayoutedLabel[];
}

// ============================================================================
// Type Guards for Layouted Types
// ============================================================================

export function isLayoutedCollaboration(
  child: LayoutedCollaboration | LayoutedProcess
): child is LayoutedCollaboration {
  return child.bpmn.type === 'collaboration';
}

export function isLayoutedProcess(
  child: LayoutedCollaboration | LayoutedProcess
): child is LayoutedProcess {
  return child.bpmn.type === 'process';
}

export function isLayoutedLane(
  child: LayoutedLane | LayoutedFlowNode
): child is LayoutedLane {
  return child.bpmn.type === 'lane';
}

export function isLayoutedFlowNode(
  child: LayoutedLane | LayoutedFlowNode
): child is LayoutedFlowNode {
  return child.bpmn.type !== 'lane';
}
