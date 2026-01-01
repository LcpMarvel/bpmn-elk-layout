/**
 * BPMN Constants and Mappings
 */

// ============================================================================
// Default Element Sizes
// ============================================================================

export const DEFAULT_SIZES = {
  // Events (all types)
  EVENT: { width: 36, height: 36 },

  // Tasks (all types)
  TASK: { width: 100, height: 80 },
  TASK_WIDE: { width: 120, height: 80 },
  TASK_WIDER: { width: 150, height: 80 },

  // Gateways (all types)
  GATEWAY: { width: 50, height: 50 },

  // SubProcesses
  SUBPROCESS_COLLAPSED: { width: 100, height: 80 },
  SUBPROCESS_EXPANDED_MIN: { width: 300, height: 200 },

  // Data Objects
  DATA_OBJECT: { width: 36, height: 50 },
  DATA_STORE: { width: 50, height: 50 },

  // Text Annotation
  TEXT_ANNOTATION: { width: 100, height: 30 },
} as const;

// ============================================================================
// BPMN Element Type to XML Element Mapping
// ============================================================================

export const BPMN_ELEMENT_MAP = {
  // Events (bpmn-moddle uses PascalCase)
  startEvent: 'bpmn:StartEvent',
  endEvent: 'bpmn:EndEvent',
  intermediateCatchEvent: 'bpmn:IntermediateCatchEvent',
  intermediateThrowEvent: 'bpmn:IntermediateThrowEvent',
  boundaryEvent: 'bpmn:BoundaryEvent',

  // Tasks
  task: 'bpmn:Task',
  userTask: 'bpmn:UserTask',
  serviceTask: 'bpmn:ServiceTask',
  scriptTask: 'bpmn:ScriptTask',
  businessRuleTask: 'bpmn:BusinessRuleTask',
  sendTask: 'bpmn:SendTask',
  receiveTask: 'bpmn:ReceiveTask',
  manualTask: 'bpmn:ManualTask',

  // Gateways
  exclusiveGateway: 'bpmn:ExclusiveGateway',
  parallelGateway: 'bpmn:ParallelGateway',
  inclusiveGateway: 'bpmn:InclusiveGateway',
  eventBasedGateway: 'bpmn:EventBasedGateway',
  complexGateway: 'bpmn:ComplexGateway',

  // SubProcesses
  subProcess: 'bpmn:SubProcess',
  transaction: 'bpmn:Transaction',
  adHocSubProcess: 'bpmn:AdHocSubProcess',
  eventSubProcess: 'bpmn:SubProcess', // Same element, different attribute

  // Call Activity
  callActivity: 'bpmn:CallActivity',

  // Artifacts
  dataObject: 'bpmn:DataObject',
  dataObjectReference: 'bpmn:DataObjectReference',
  dataInput: 'bpmn:DataInput',
  dataOutput: 'bpmn:DataOutput',
  dataStoreReference: 'bpmn:DataStoreReference',
  textAnnotation: 'bpmn:TextAnnotation',
  group: 'bpmn:Group',

  // Flows
  sequenceFlow: 'bpmn:SequenceFlow',
  messageFlow: 'bpmn:MessageFlow',
  dataInputAssociation: 'bpmn:DataInputAssociation',
  dataOutputAssociation: 'bpmn:DataOutputAssociation',
  association: 'bpmn:Association',

  // Containers
  collaboration: 'bpmn:Collaboration',
  participant: 'bpmn:Participant',
  process: 'bpmn:Process',
  lane: 'bpmn:Lane',
  laneSet: 'bpmn:LaneSet',
} as const;

// ============================================================================
// Event Definition Type to XML Element Mapping
// ============================================================================

export const EVENT_DEFINITION_MAP = {
  none: null,
  message: 'bpmn:MessageEventDefinition',
  timer: 'bpmn:TimerEventDefinition',
  error: 'bpmn:ErrorEventDefinition',
  escalation: 'bpmn:EscalationEventDefinition',
  cancel: 'bpmn:CancelEventDefinition',
  compensation: 'bpmn:CompensateEventDefinition',
  conditional: 'bpmn:ConditionalEventDefinition',
  link: 'bpmn:LinkEventDefinition',
  signal: 'bpmn:SignalEventDefinition',
  terminate: 'bpmn:TerminateEventDefinition',
  multiple: null, // Multiple event definitions
  parallelMultiple: null, // Multiple parallel event definitions
} as const;

// ============================================================================
// BPMN XML Namespaces
// ============================================================================

export const BPMN_NAMESPACES = {
  bpmn: 'http://www.omg.org/spec/BPMN/20100524/MODEL',
  bpmndi: 'http://www.omg.org/spec/BPMN/20100524/DI',
  dc: 'http://www.omg.org/spec/DD/20100524/DC',
  di: 'http://www.omg.org/spec/DD/20100524/DI',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  camunda: 'http://camunda.org/schema/1.0/bpmn',
} as const;

// ============================================================================
// Default ELK Layout Options
// ============================================================================

export const DEFAULT_ELK_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': 50,
  'elk.spacing.edgeNode': 30,
  'elk.spacing.edgeEdge': 20,
  'elk.layered.spacing.nodeNodeBetweenLayers': 80,
  'elk.layered.spacing.edgeNodeBetweenLayers': 30,
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.edgeRouting': 'ORTHOGONAL',
} as const;

// ============================================================================
// Element Categories
// ============================================================================

export const EVENT_TYPES = [
  'startEvent',
  'endEvent',
  'intermediateCatchEvent',
  'intermediateThrowEvent',
  'boundaryEvent',
] as const;

export const TASK_TYPES = [
  'task',
  'userTask',
  'serviceTask',
  'scriptTask',
  'businessRuleTask',
  'sendTask',
  'receiveTask',
  'manualTask',
] as const;

export const GATEWAY_TYPES = [
  'exclusiveGateway',
  'parallelGateway',
  'inclusiveGateway',
  'eventBasedGateway',
  'complexGateway',
] as const;

export const SUBPROCESS_TYPES = [
  'subProcess',
  'transaction',
  'adHocSubProcess',
  'eventSubProcess',
] as const;

export const ARTIFACT_TYPES = [
  'dataObject',
  'dataObjectReference',
  'dataInput',
  'dataOutput',
  'dataStoreReference',
  'textAnnotation',
  'group',
] as const;

export const FLOW_TYPES = [
  'sequenceFlow',
  'messageFlow',
  'dataInputAssociation',
  'dataOutputAssociation',
  'association',
] as const;

// ============================================================================
// Type Helpers
// ============================================================================

export type EventTypeString = (typeof EVENT_TYPES)[number];
export type TaskTypeString = (typeof TASK_TYPES)[number];
export type GatewayTypeString = (typeof GATEWAY_TYPES)[number];
export type SubProcessTypeString = (typeof SUBPROCESS_TYPES)[number];
export type ArtifactTypeString = (typeof ARTIFACT_TYPES)[number];
export type FlowTypeString = (typeof FLOW_TYPES)[number];
export type BpmnElementType = keyof typeof BPMN_ELEMENT_MAP;
