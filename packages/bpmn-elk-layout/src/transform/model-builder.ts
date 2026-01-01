/**
 * Model Builder
 * Builds the intermediate BPMN model from layouted ELK-BPMN graph
 */

import type { LayoutedGraph } from '../types/elk-output';
import type {
  MessageDefinition,
  SignalDefinition,
  ErrorDefinition,
  EscalationDefinition,
} from '../types';
import { ReferenceResolver } from './reference-resolver';
import { LaneResolver, type LaneSetInfo } from './lane-resolver';

// ============================================================================
// Model Types
// ============================================================================

export interface BpmnModel {
  definitions: DefinitionsModel;
  diagram: DiagramModel;
}

export interface DefinitionsModel {
  id: string;
  targetNamespace: string;
  exporter: string;
  exporterVersion: string;
  messages: MessageDefinition[];
  signals: SignalDefinition[];
  errors: ErrorDefinition[];
  escalations: EscalationDefinition[];
  rootElements: RootElement[];
}

export type RootElement = CollaborationModel | ProcessModel;

export interface CollaborationModel {
  type: 'collaboration';
  id: string;
  name?: string;
  isClosed?: boolean;
  participants: ParticipantModel[];
  messageFlows: MessageFlowModel[];
}

export interface ParticipantModel {
  id: string;
  name?: string;
  processRef?: string;
  isBlackBox?: boolean;
  participantMultiplicity?: { minimum?: number; maximum?: number };
}

export interface ProcessModel {
  type: 'process';
  id: string;
  name?: string;
  isExecutable?: boolean;
  processType?: string;
  isClosed?: boolean;
  laneSet?: LaneSetInfo;
  flowElements: FlowElementModel[];
  artifacts: ArtifactModel[];
}

export interface FlowElementModel {
  type: string;
  id: string;
  name?: string;
  incoming: string[];
  outgoing: string[];
  properties: Record<string, unknown>;
  // For boundary events
  attachedToRef?: string;
  cancelActivity?: boolean;
  // For subprocesses - nested content
  flowElements?: FlowElementModel[];
  artifacts?: ArtifactModel[];
}

export interface ArtifactModel {
  type: string;
  id: string;
  name?: string;
  properties: Record<string, unknown>;
}

export interface MessageFlowModel {
  id: string;
  name?: string;
  sourceRef: string;
  targetRef: string;
  messageRef?: string;
}

export interface SequenceFlowModel {
  id: string;
  name?: string;
  sourceRef: string;
  targetRef: string;
  conditionExpression?: {
    type?: string;
    language?: string;
    body?: string;
  };
  isDefault?: boolean;
}

export interface DiagramModel {
  id: string;
  name: string;
  plane: PlaneModel;
}

export interface PlaneModel {
  id: string;
  bpmnElement: string;
  shapes: ShapeModel[];
  edges: EdgeModel[];
}

export interface ShapeModel {
  id: string;
  bpmnElement: string;
  bounds: BoundsModel;
  isExpanded?: boolean;
  isHorizontal?: boolean;
  label?: LabelModel;
}

export interface EdgeModel {
  id: string;
  bpmnElement: string;
  waypoints: PointModel[];
  label?: LabelModel;
}

export interface BoundsModel {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PointModel {
  x: number;
  y: number;
}

export interface LabelModel {
  bounds?: BoundsModel;
}

// ============================================================================
// Model Builder
// ============================================================================

export class ModelBuilder {
  private refResolver: ReferenceResolver;
  private laneResolver: LaneResolver;
  // Map to track boundary event positions: id -> { x, y, width, height }
  private boundaryEventPositions: Map<string, { x: number; y: number; width: number; height: number }> = new Map();
  // Map to track all node positions for edge routing: id -> { x, y, width, height }
  private nodePositions: Map<string, { x: number; y: number; width: number; height: number }> = new Map();
  // Map to track the offset used for each node (for edge coordinate transformation)
  private nodeOffsets: Map<string, { x: number; y: number }> = new Map();

  constructor() {
    this.refResolver = new ReferenceResolver();
    this.laneResolver = new LaneResolver();
  }

  /**
   * Build the complete BPMN model from a layouted graph
   */
  build(graph: LayoutedGraph): BpmnModel {
    // Reset resolvers and position maps
    this.laneResolver.reset();
    this.boundaryEventPositions.clear();
    this.nodePositions.clear();

    // Resolve references first
    this.refResolver.resolve(graph);

    // Build definitions model
    const definitions = this.buildDefinitions(graph);

    // Build diagram model
    const diagram = this.buildDiagram(graph, definitions);

    return { definitions, diagram };
  }

  /**
   * Get the reference resolver
   */
  getRefResolver(): ReferenceResolver {
    return this.refResolver;
  }

  /**
   * Build definitions model
   */
  private buildDefinitions(graph: LayoutedGraph): DefinitionsModel {
    const definitions: DefinitionsModel = {
      id: graph.id,
      targetNamespace: graph.bpmn?.targetNamespace ?? 'http://bpmn.io/schema/bpmn',
      exporter: graph.bpmn?.exporter ?? 'bpmn-elk-layout',
      exporterVersion: graph.bpmn?.exporterVersion ?? '1.0.0',
      messages: graph.messages ?? [],
      signals: graph.signals ?? [],
      errors: graph.errors ?? [],
      escalations: graph.escalations ?? [],
      rootElements: [],
    };

    // Process top-level children
    for (const child of graph.children) {
      const bpmnType = (child as { bpmn: { type: string } }).bpmn.type;

      if (bpmnType === 'collaboration') {
        definitions.rootElements.push(this.buildCollaboration(child as CollaborationNode));

        // Also add processes for each non-black-box participant
        const collab = child as CollaborationNode;
        for (const participant of collab.children ?? []) {
          if (!participant.bpmn?.isBlackBox) {
            const processId = participant.bpmn?.processRef ?? `Process_${participant.id}`;
            definitions.rootElements.push(
              this.buildProcessFromParticipant(participant, processId)
            );
          }
        }
      } else if (bpmnType === 'process') {
        definitions.rootElements.push(this.buildProcess(child as ProcessNode));
      }
    }

    return definitions;
  }

  /**
   * Build collaboration model
   */
  private buildCollaboration(collab: CollaborationNode): CollaborationModel {
    return {
      type: 'collaboration',
      id: collab.id,
      name: collab.bpmn?.name,
      isClosed: collab.bpmn?.isClosed,
      participants: (collab.children ?? []).map((p) => ({
        id: p.id,
        name: p.bpmn?.name,
        processRef: p.bpmn?.processRef ?? `Process_${p.id}`,
        isBlackBox: p.bpmn?.isBlackBox,
        participantMultiplicity: p.bpmn?.participantMultiplicity,
      })),
      messageFlows: (collab.edges ?? []).map((e) => ({
        id: e.id,
        name: e.bpmn?.name,
        sourceRef: e.sources[0],
        targetRef: e.targets[0],
        messageRef: e.bpmn?.messageRef,
      })),
    };
  }

  /**
   * Build process model from participant
   */
  private buildProcessFromParticipant(
    participant: ParticipantNode,
    processId: string
  ): ProcessModel {
    const process: ProcessModel = {
      type: 'process',
      id: processId,
      name: participant.bpmn?.name,
      isExecutable: true,
      laneSet: this.laneResolver.resolve(participant),
      flowElements: [],
      artifacts: [],
    };

    // Collect all flow elements
    this.collectFlowElements(participant.children ?? [], process.flowElements);

    // Collect sequence flows
    this.collectSequenceFlows(participant.edges ?? [], process.flowElements);

    return process;
  }

  /**
   * Build process model
   */
  private buildProcess(processNode: ProcessNode): ProcessModel {
    const process: ProcessModel = {
      type: 'process',
      id: processNode.id,
      name: processNode.bpmn?.name,
      isExecutable: processNode.bpmn?.isExecutable ?? true,
      processType: processNode.bpmn?.processType,
      isClosed: processNode.bpmn?.isClosed,
      laneSet: this.laneResolver.resolve(processNode),
      flowElements: [],
      artifacts: [],
    };

    // Collect all flow elements
    this.collectFlowElements(processNode.children ?? [], process.flowElements);

    // Collect sequence flows
    this.collectSequenceFlows(processNode.edges ?? [], process.flowElements);

    // Collect artifacts
    if (processNode.artifacts) {
      for (const artifact of processNode.artifacts) {
        process.artifacts.push(this.buildArtifact(artifact));
      }
    }

    // Collect associations from edges
    this.collectAssociations(processNode.edges ?? [], process.artifacts);

    return process;
  }

  /**
   * Collect flow elements recursively
   */
  private collectFlowElements(children: ChildNode[], elements: FlowElementModel[]): void {
    for (const child of children) {
      // Skip lanes - just traverse their children
      if (child.bpmn?.type === 'lane') {
        this.collectFlowElements(child.children ?? [], elements);
        continue;
      }

      // Build flow element
      const flowElement = this.buildFlowElement(child);
      elements.push(flowElement);

      // For expanded subprocesses, collect nested elements into the subprocess itself
      if (child.bpmn?.isExpanded && child.children) {
        flowElement.flowElements = [];
        flowElement.artifacts = [];
        this.collectFlowElements(child.children, flowElement.flowElements);
        // Collect nested sequence flows into subprocess
        if (child.edges) {
          this.collectSequenceFlows(child.edges, flowElement.flowElements);
        }
      } else if (child.edges) {
        // Collect nested sequence flows for non-expanded containers
        this.collectSequenceFlows(child.edges, elements);
      }

      // Add boundary events (after subprocess content processing)
      if (child.boundaryEvents) {
        for (const be of child.boundaryEvents) {
          elements.push(this.buildBoundaryEvent(be));
        }
      }
    }
  }

  /**
   * Build a flow element model
   */
  private buildFlowElement(node: ChildNode): FlowElementModel {
    const incoming = this.refResolver.getIncomingSequenceFlows(node.id);
    const outgoing = this.refResolver.getOutgoingSequenceFlows(node.id);

    return {
      type: node.bpmn?.type ?? 'task',
      id: node.id,
      name: node.bpmn?.name,
      incoming,
      outgoing,
      properties: this.extractProperties(node.bpmn ?? {}),
    };
  }

  /**
   * Build a boundary event model
   */
  private buildBoundaryEvent(be: BoundaryEventNode): FlowElementModel {
    const incoming = this.refResolver.getIncomingSequenceFlows(be.id);
    const outgoing = this.refResolver.getOutgoingSequenceFlows(be.id);

    return {
      type: 'boundaryEvent',
      id: be.id,
      name: be.bpmn?.name,
      incoming,
      outgoing,
      attachedToRef: be.attachedToRef,
      cancelActivity: be.bpmn?.isInterrupting ?? be.bpmn?.cancelActivity ?? true,
      properties: this.extractProperties(be.bpmn ?? {}),
    };
  }

  /**
   * Collect sequence flows
   */
  private collectSequenceFlows(edges: EdgeNode[], elements: FlowElementModel[]): void {
    for (const edge of edges) {
      if (edge.bpmn?.type === 'sequenceFlow') {
        elements.push({
          type: 'sequenceFlow',
          id: edge.id,
          name: edge.bpmn?.name,
          incoming: [],
          outgoing: [],
          properties: {
            sourceRef: edge.sources[0],
            targetRef: edge.targets[0],
            conditionExpression: edge.bpmn?.conditionExpression,
            isDefault: edge.bpmn?.isDefault,
          },
        });
      }
    }
  }

  /**
   * Collect associations from edges
   */
  private collectAssociations(edges: EdgeNode[], artifacts: ArtifactModel[]): void {
    for (const edge of edges) {
      if (edge.bpmn?.type === 'association') {
        artifacts.push({
          type: 'association',
          id: edge.id,
          name: edge.bpmn?.name,
          properties: {
            sourceRef: edge.sources[0],
            targetRef: edge.targets[0],
            associationDirection: edge.bpmn?.associationDirection ?? 'None',
          },
        });
      }
    }
  }

  /**
   * Build an artifact model
   */
  private buildArtifact(artifact: ArtifactNode): ArtifactModel {
    return {
      type: artifact.bpmn?.type ?? 'textAnnotation',
      id: artifact.id,
      name: artifact.bpmn?.name,
      properties: this.extractProperties(artifact.bpmn ?? {}),
    };
  }

  /**
   * Extract properties from bpmn object (excluding type and name)
   */
  private extractProperties(bpmn: Record<string, unknown>): Record<string, unknown> {
    const { type, name, ...rest } = bpmn;
    return rest;
  }

  /**
   * Build diagram model
   */
  private buildDiagram(graph: LayoutedGraph, definitions: DefinitionsModel): DiagramModel {
    const shapes: ShapeModel[] = [];
    const edges: EdgeModel[] = [];

    // Find the main bpmn element for the plane
    const mainElement = definitions.rootElements[0];
    const planeElement = mainElement?.type === 'collaboration' ? mainElement.id : mainElement?.id ?? graph.id;

    // Build shapes and edges
    for (const child of graph.children) {
      this.collectShapesAndEdges(child as LayoutedNode, shapes, edges);
    }

    return {
      id: `BPMNDiagram_${graph.id}`,
      name: 'BPMNDiagram',
      plane: {
        id: `BPMNPlane_${graph.id}`,
        bpmnElement: planeElement,
        shapes,
        edges,
      },
    };
  }

  /**
   * Collect shapes and edges recursively
   * @param offsetX - Parent container's absolute X offset
   * @param offsetY - Parent container's absolute Y offset
   */
  private collectShapesAndEdges(
    node: LayoutedNode,
    shapes: ShapeModel[],
    edges: EdgeModel[],
    offsetX: number = 0,
    offsetY: number = 0
  ): void {
    // Add shape for this node (if it has coordinates)
    if (node.x !== undefined && node.y !== undefined) {
      const absoluteX = offsetX + node.x;
      const absoluteY = offsetY + node.y;
      const nodeWidth = node.width ?? 100;
      const nodeHeight = node.height ?? 80;

      // Store node position for edge routing
      this.nodePositions.set(node.id, {
        x: absoluteX,
        y: absoluteY,
        width: nodeWidth,
        height: nodeHeight,
      });

      // Store the offset used for this node (needed for edge coordinate transformation)
      this.nodeOffsets.set(node.id, { x: offsetX, y: offsetY });

      shapes.push(this.buildShape(node, offsetX, offsetY));
    }

    // Calculate offset for children
    // Containers that offset their children: pools (participants), lanes, and expanded subprocesses
    const isExpandedSubprocess = node.bpmn?.isExpanded === true &&
      (node.bpmn?.type === 'subProcess' || node.bpmn?.type === 'transaction' ||
       node.bpmn?.type === 'adHocSubProcess' || node.bpmn?.type === 'eventSubProcess' ||
       node.bpmn?.triggeredByEvent === true);

    const isPoolOrLane = node.bpmn?.type === 'participant' || node.bpmn?.type === 'lane';

    const isContainer = isExpandedSubprocess || isPoolOrLane;

    const childOffsetX = isContainer ? offsetX + (node.x ?? 0) : offsetX;
    const childOffsetY = isContainer ? offsetY + (node.y ?? 0) : offsetY;

    // Process children
    if (node.children) {
      for (const child of node.children) {
        this.collectShapesAndEdges(child as LayoutedNode, shapes, edges, childOffsetX, childOffsetY);
      }
    }

    // Process boundary events - position them on the bottom edge of the task
    if (node.boundaryEvents) {
      const nodeX = offsetX + (node.x ?? 0);
      const nodeY = offsetY + (node.y ?? 0);
      const nodeWidth = node.width ?? 100;
      const nodeHeight = node.height ?? 80;
      const beCount = node.boundaryEvents.length;

      node.boundaryEvents.forEach((be, index) => {
        const beWidth = be.width ?? 36;
        const beHeight = be.height ?? 36;

        // Calculate position on the bottom edge of the task
        // Distribute multiple boundary events evenly along the bottom
        const spacing = nodeWidth / (beCount + 1);
        const beX = nodeX + spacing * (index + 1) - beWidth / 2;
        const beY = nodeY + nodeHeight - beHeight / 2; // Half inside, half outside

        // Store boundary event position for edge routing
        this.boundaryEventPositions.set(be.id, {
          x: beX,
          y: beY,
          width: beWidth,
          height: beHeight,
        });

        shapes.push({
          id: `${be.id}_di`,
          bpmnElement: be.id,
          bounds: {
            x: beX,
            y: beY,
            width: beWidth,
            height: beHeight,
          },
        });
      });
    }

    // Process edges
    // Edge waypoints from ELK are relative to the source node's parent container,
    // not necessarily the edge's container. We use the source node's stored offset.
    if (node.edges) {
      for (const edge of node.edges) {
        if (edge.sections && edge.sections.length > 0) {
          // Check if edge has absolute coordinates (set by rearrangePools for message flows)
          const hasAbsoluteCoords = (edge as { _absoluteCoords?: boolean })._absoluteCoords === true;
          // Check if edge has pool-relative coordinates (set by recalculatePoolEdges for pool edges with lanes)
          const hasPoolRelativeCoords = (edge as { _poolRelativeCoords?: boolean })._poolRelativeCoords === true;

          if (hasAbsoluteCoords) {
            // Edge already has absolute coordinates - don't add offset
            edges.push(this.buildEdge(edge, 0, 0));
          } else if (hasPoolRelativeCoords) {
            // Edge waypoints are relative to pool (already include lane offsets within pool)
            // Use container's offset (pool's offset), not source node's offset
            edges.push(this.buildEdge(edge, offsetX + (node.x ?? 0), offsetY + (node.y ?? 0)));
          } else {
            const sourceId = edge.sources?.[0];
            // Use the source node's offset if available, otherwise fall back to childOffset
            const sourceOffset = sourceId ? this.nodeOffsets.get(sourceId) : undefined;
            const edgeOffsetX = sourceOffset?.x ?? childOffsetX;
            const edgeOffsetY = sourceOffset?.y ?? childOffsetY;
            edges.push(this.buildEdge(edge, edgeOffsetX, edgeOffsetY));
          }
        }
      }
    }
  }

  /**
   * Check if a node type is an event type
   */
  private isEventType(type?: string): boolean {
    if (!type) return false;
    return type.includes('Event') || type === 'startEvent' || type === 'endEvent' ||
           type === 'intermediateThrowEvent' || type === 'intermediateCatchEvent';
  }

  /**
   * Check if a node type is a gateway type
   */
  private isGatewayType(type?: string): boolean {
    if (!type) return false;
    return type.includes('Gateway');
  }

  /**
   * Build a shape model
   */
  private buildShape(node: LayoutedNode, offsetX: number = 0, offsetY: number = 0): ShapeModel {
    const absoluteX = offsetX + (node.x ?? 0);
    const absoluteY = offsetY + (node.y ?? 0);

    const shape: ShapeModel = {
      id: `${node.id}_di`,
      bpmnElement: node.id,
      bounds: {
        x: absoluteX,
        y: absoluteY,
        width: node.width ?? 100,
        height: node.height ?? 80,
      },
    };

    // Add isExpanded for subprocesses
    if (node.bpmn?.isExpanded !== undefined) {
      shape.isExpanded = node.bpmn.isExpanded;
    }

    // Add isHorizontal for pools/lanes
    if (node.bpmn?.type === 'participant' || node.bpmn?.type === 'lane') {
      shape.isHorizontal = true;
    }

    // Add label if present
    if (node.labels && node.labels.length > 0) {
      const label = node.labels[0];
      const nodeWidth = node.width ?? 36;
      const nodeHeight = node.height ?? 36;

      // For events (circles), position the label below the shape (bpmn-js default behavior)
      if (this.isEventType(node.bpmn?.type)) {
        const labelWidth = label.width ?? 100;
        const labelHeight = label.height ?? 14;

        // Position label below the event circle, horizontally centered (using absolute coords)
        shape.label = {
          bounds: {
            x: absoluteX + (nodeWidth - labelWidth) / 2,
            y: absoluteY + nodeHeight + 4, // 4px gap below the circle
            width: labelWidth,
            height: labelHeight,
          },
        };
      } else if (this.isGatewayType(node.bpmn?.type)) {
        // For gateways (diamonds), position the label above the shape (bpmn-js default behavior)
        const labelWidth = label.width ?? 100;
        const labelHeight = label.height ?? 14;

        // Position label above the gateway diamond, horizontally centered
        shape.label = {
          bounds: {
            x: absoluteX + (nodeWidth - labelWidth) / 2,
            y: absoluteY - labelHeight - 4, // 4px gap above the diamond
            width: labelWidth,
            height: labelHeight,
          },
        };
      } else if (label.x !== undefined && label.y !== undefined) {
        // For other elements, use ELK-calculated position (relative to node, converted to absolute)
        shape.label = {
          bounds: {
            x: absoluteX + label.x,
            y: absoluteY + label.y,
            width: label.width ?? 100,
            height: label.height ?? 20,
          },
        };
      }
    }

    return shape;
  }

  /**
   * Build an edge model
   */
  private buildEdge(edge: LayoutedEdge, offsetX: number = 0, offsetY: number = 0): EdgeModel {
    const sourceId = edge.sources?.[0];
    const targetId = edge.targets?.[0];

    // Check if source is a boundary event - need to recalculate waypoints
    const bePosition = sourceId ? this.boundaryEventPositions.get(sourceId) : undefined;
    const targetPosition = targetId ? this.nodePositions.get(targetId) : undefined;

    let waypoints: PointModel[] = [];

    if (bePosition && targetPosition) {
      // Source is a boundary event - calculate new waypoints
      // Start from bottom center of boundary event
      const startX = bePosition.x + bePosition.width / 2;
      const startY = bePosition.y + bePosition.height;

      // End at left center of target (or top center if target is below)
      let endX: number;
      let endY: number;

      // Determine connection point based on relative position
      if (targetPosition.y > bePosition.y + bePosition.height) {
        // Target is below - connect to top center
        endX = targetPosition.x + targetPosition.width / 2;
        endY = targetPosition.y;
      } else if (targetPosition.x > bePosition.x + bePosition.width) {
        // Target is to the right - connect to left center
        endX = targetPosition.x;
        endY = targetPosition.y + targetPosition.height / 2;
      } else if (targetPosition.x + targetPosition.width < bePosition.x) {
        // Target is to the left - connect to right center
        endX = targetPosition.x + targetPosition.width;
        endY = targetPosition.y + targetPosition.height / 2;
      } else {
        // Target is above - connect to bottom center
        endX = targetPosition.x + targetPosition.width / 2;
        endY = targetPosition.y + targetPosition.height;
      }

      waypoints.push({ x: startX, y: startY });

      // Add bend point if needed for orthogonal routing
      if (Math.abs(startX - endX) > 10 && Math.abs(startY - endY) > 10) {
        // Go down first, then turn
        const midY = startY + 20;
        waypoints.push({ x: startX, y: midY });
        waypoints.push({ x: endX, y: midY });
      }

      waypoints.push({ x: endX, y: endY });
    } else {
      // Normal edge - use ELK calculated waypoints
      for (const section of edge.sections) {
        // Start point
        waypoints.push({ x: offsetX + section.startPoint.x, y: offsetY + section.startPoint.y });

        // Bend points
        if (section.bendPoints) {
          for (const bp of section.bendPoints) {
            waypoints.push({ x: offsetX + bp.x, y: offsetY + bp.y });
          }
        }

        // End point
        waypoints.push({ x: offsetX + section.endPoint.x, y: offsetY + section.endPoint.y });
      }
    }

    const edgeModel: EdgeModel = {
      id: `${edge.id}_di`,
      bpmnElement: edge.id,
      waypoints,
    };

    // Add label if present
    if (edge.labels && edge.labels.length > 0) {
      const label = edge.labels[0];
      if (label.x !== undefined && label.y !== undefined) {
        edgeModel.label = {
          bounds: {
            x: offsetX + label.x,
            y: offsetY + label.y,
            width: label.width ?? 50,
            height: label.height ?? 14,
          },
        };
      }
    }

    return edgeModel;
  }
}

// Internal types
interface CollaborationNode {
  id: string;
  bpmn?: { type: 'collaboration'; name?: string; isClosed?: boolean };
  children?: ParticipantNode[];
  edges?: MessageFlowEdge[];
}

interface ParticipantNode {
  id: string;
  bpmn?: {
    type: 'participant';
    name?: string;
    processRef?: string;
    isBlackBox?: boolean;
    participantMultiplicity?: { minimum?: number; maximum?: number };
  };
  children?: ChildNode[];
  edges?: EdgeNode[];
}

interface ProcessNode {
  id: string;
  bpmn?: {
    type: 'process';
    name?: string;
    isExecutable?: boolean;
    processType?: string;
    isClosed?: boolean;
  };
  children?: ChildNode[];
  edges?: EdgeNode[];
  artifacts?: ArtifactNode[];
}

interface ChildNode {
  id: string;
  bpmn?: { type: string; name?: string; isExpanded?: boolean; [key: string]: unknown };
  children?: ChildNode[];
  edges?: EdgeNode[];
  boundaryEvents?: BoundaryEventNode[];
}

interface BoundaryEventNode {
  id: string;
  attachedToRef: string;
  bpmn?: { type: 'boundaryEvent'; name?: string; isInterrupting?: boolean; cancelActivity?: boolean; [key: string]: unknown };
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface EdgeNode {
  id: string;
  sources: string[];
  targets: string[];
  bpmn?: { type: string; name?: string; conditionExpression?: object; isDefault?: boolean; messageRef?: string };
  sections?: Array<{ startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }>;
  labels?: Array<{ x?: number; y?: number; width?: number; height?: number }>;
}

interface MessageFlowEdge {
  id: string;
  sources: string[];
  targets: string[];
  bpmn?: { type: 'messageFlow'; name?: string; messageRef?: string };
  sections?: Array<{ startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }>;
  labels?: Array<{ x?: number; y?: number; width?: number; height?: number }>;
}

interface ArtifactNode {
  id: string;
  bpmn?: { type: string; name?: string; [key: string]: unknown };
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface LayoutedNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  bpmn?: { type: string; name?: string; isExpanded?: boolean };
  children?: LayoutedNode[];
  edges?: LayoutedEdge[];
  boundaryEvents?: Array<{ id: string; x?: number; y?: number; width?: number; height?: number }>;
  labels?: Array<{ x?: number; y?: number; width?: number; height?: number }>;
}

interface LayoutedEdge {
  id: string;
  sources: string[];
  targets: string[];
  sections: Array<{
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints?: Array<{ x: number; y: number }>;
  }>;
  labels?: Array<{ x?: number; y?: number; width?: number; height?: number }>;
}
