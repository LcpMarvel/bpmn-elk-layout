export { ReferenceResolver } from './reference-resolver';
export { LaneResolver, type LaneInfo, type LaneSetInfo } from './lane-resolver';
export { ModelBuilder } from './model-builder';
export { DiagramBuilder } from './diagram-builder';

// Re-export all model types
export type {
  BpmnModel,
  DefinitionsModel,
  RootElement,
  CollaborationModel,
  ParticipantModel,
  ProcessModel,
  DataAssociationModel,
  FlowElementModel,
  ArtifactModel,
  MessageFlowModel,
  SequenceFlowModel,
  DiagramModel,
  PlaneModel,
  ShapeModel,
  EdgeModel,
  BoundsModel,
  PointModel,
  LabelModel,
  // Internal node types
  CollaborationNode,
  ParticipantNode,
  ProcessNode,
  ChildNode,
  BoundaryEventNode,
  EdgeNode,
  MessageFlowEdge,
  ArtifactNode,
  LayoutedNode,
  LayoutedEdge,
  // Position tracking types
  NodePosition,
  NodeOffset,
  NodeBpmnInfo,
} from './model-types';
