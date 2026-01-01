/**
 * bpmn-elk-layout
 *
 * Convert ELK-BPMN JSON to BPMN 2.0 XML with automatic layout
 *
 * @example
 * ```typescript
 * import { BpmnElkLayout } from 'bpmn-elk-layout';
 *
 * const converter = new BpmnElkLayout({
 *   elkOptions: {
 *     'elk.direction': 'RIGHT',
 *     'elk.spacing.nodeNode': 50,
 *   },
 * });
 *
 * // Convert to BPMN XML
 * const bpmnXml = await converter.to_bpmn(elkBpmnJson);
 *
 * // Or get layouted JSON with coordinates
 * const layoutedJson = await converter.to_json(elkBpmnJson);
 * ```
 */

// Main converter class
export { BpmnElkLayout, type BpmnElkLayoutOptions } from './converter';

// Prompt template generator
export {
  PromptTemplateGenerator,
  generatePromptTemplate,
  type PromptGeneratorOptions,
} from './prompt-generator';

// Types
export type {
  // Input types
  ElkBpmnGraph,
  ElkLayoutOptions,
  Collaboration,
  Participant,
  Lane,
  Process,
  FlowNode,
  BpmnEvent,
  BpmnTask,
  BpmnGateway,
  BpmnSubProcess,
  BpmnCallActivity,
  SequenceFlow,
  MessageFlow,
  BoundaryEvent,
  Artifact,
  // Global definitions
  MessageDefinition,
  SignalDefinition,
  ErrorDefinition,
  EscalationDefinition,
  // Event definitions
  TimerEventDefinition,
  ConditionalEventDefinition,
  LinkEventDefinition,
  // Loop characteristics
  LoopCharacteristics,
  // Type guards
  isCollaboration,
  isProcess,
  isLane,
  isFlowNode,
  isEvent,
  isTask,
  isGateway,
  isSubProcess,
  isCallActivity,
} from './types';

// Output types
export type {
  LayoutedGraph,
  LayoutedCollaboration,
  LayoutedParticipant,
  LayoutedLane,
  LayoutedProcess,
  LayoutedFlowNode,
  LayoutedSequenceFlow,
  LayoutedMessageFlow,
  Point,
  EdgeSection,
} from './types/elk-output';

// Constants
export {
  DEFAULT_SIZES,
  BPMN_ELEMENT_MAP,
  EVENT_DEFINITION_MAP,
  BPMN_NAMESPACES,
  DEFAULT_ELK_OPTIONS,
  EVENT_TYPES,
  TASK_TYPES,
  GATEWAY_TYPES,
  SUBPROCESS_TYPES,
  ARTIFACT_TYPES,
  FLOW_TYPES,
} from './types/bpmn-constants';
