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

// Debug flag for layout logging
const DEBUG = typeof process !== 'undefined' && process.env?.['DEBUG'] === 'true';

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

export interface DataAssociationModel {
  id: string;
  sourceRef: string;
  targetRef?: string;  // Optional for dataInputAssociation (target is implicit)
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
  // For data associations (BPMN spec: child elements of activity)
  dataInputAssociations?: DataAssociationModel[];
  dataOutputAssociations?: DataAssociationModel[];
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
  // Map to track node BPMN metadata for gateway detection
  private nodeBpmn: Map<string, { type?: string }> = new Map();

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
    this.nodeBpmn.clear();

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
      messageFlows: (collab.edges ?? [])
        .filter((e): e is typeof e & { sources: [string, ...string[]]; targets: [string, ...string[]] } =>
          e.sources[0] !== undefined && e.targets[0] !== undefined)
        .map((e) => ({
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

    // Collect data associations and attach to flow elements (BPMN spec compliance)
    this.collectDataAssociations(participant.edges ?? [], process.flowElements);

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

    // Collect data associations and attach to flow elements (BPMN spec compliance)
    this.collectDataAssociations(processNode.edges ?? [], process.flowElements);

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

      // Skip nested process - traverse its children and edges
      // This handles the case where participant > children > [process > children: [flowNodes]]
      if (child.bpmn?.type === 'process') {
        this.collectFlowElements(child.children ?? [], elements);
        this.collectSequenceFlows(child.edges ?? [], elements);
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
            associationDirection: (edge.bpmn as { associationDirection?: string })?.associationDirection ?? 'None',
          },
        });
      }
    }
  }

  /**
   * Collect data associations from edges and attach them to flow elements
   * Per BPMN 2.0 spec: dataInputAssociation/dataOutputAssociation are child elements of Activity
   */
  private collectDataAssociations(edges: EdgeNode[], elements: FlowElementModel[]): void {
    // Build a map of element IDs to their models for quick lookup
    const elementMap = new Map<string, FlowElementModel>();
    for (const element of elements) {
      elementMap.set(element.id, element);
    }

    for (const edge of edges) {
      const edgeType = edge.bpmn?.type;

      if (edgeType === 'dataInputAssociation') {
        // dataInputAssociation: data object (source) -> task (target)
        // The association is a child of the TARGET task
        const targetId = edge.targets[0];
        const sourceId = edge.sources[0];
        if (!targetId || !sourceId) continue;
        const targetElement = elementMap.get(targetId);

        if (targetElement) {
          if (!targetElement.dataInputAssociations) {
            targetElement.dataInputAssociations = [];
          }
          targetElement.dataInputAssociations.push({
            id: edge.id,
            sourceRef: sourceId,
          });
        }
      } else if (edgeType === 'dataOutputAssociation') {
        // dataOutputAssociation: task (source) -> data object (target)
        // The association is a child of the SOURCE task
        const sourceId = edge.sources[0];
        const targetId = edge.targets[0];
        if (!sourceId || !targetId) continue;
        const sourceElement = elementMap.get(sourceId);

        if (sourceElement) {
          if (!sourceElement.dataOutputAssociations) {
            sourceElement.dataOutputAssociations = [];
          }
          sourceElement.dataOutputAssociations.push({
            id: edge.id,
            sourceRef: sourceId,
            targetRef: targetId,
          });
        }
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
   * @param insideParticipant - Whether we are inside a participant container
   */
  private collectShapesAndEdges(
    node: LayoutedNode,
    shapes: ShapeModel[],
    edges: EdgeModel[],
    offsetX: number = 0,
    offsetY: number = 0,
    insideParticipant: boolean = false
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

      // Store node BPMN metadata for gateway detection
      if (node.bpmn) {
        this.storeNodeBpmn(node.id, { type: node.bpmn.type });
      }

      // Store the offset used for this node (needed for edge coordinate transformation)
      this.nodeOffsets.set(node.id, { x: offsetX, y: offsetY });

      shapes.push(this.buildShape(node, offsetX, offsetY));
    }

    // Calculate offset for children
    // Containers that offset their children: pools (participants), lanes, and expanded subprocesses
    const isExpandedSubprocess = node.bpmn?.isExpanded === true &&
      (node.bpmn?.type === 'subProcess' || node.bpmn?.type === 'transaction' ||
       node.bpmn?.type === 'adHocSubProcess' || node.bpmn?.type === 'eventSubProcess' ||
       (node.bpmn as { triggeredByEvent?: boolean })?.triggeredByEvent === true);

    const isPoolOrLane = node.bpmn?.type === 'participant' || node.bpmn?.type === 'lane';

    // Process nested inside participant also acts as a container for coordinate offsets
    const isNestedProcess = node.bpmn?.type === 'process' && insideParticipant;

    const isContainer = isExpandedSubprocess || isPoolOrLane || isNestedProcess;

    const childOffsetX = isContainer ? offsetX + (node.x ?? 0) : offsetX;
    const childOffsetY = isContainer ? offsetY + (node.y ?? 0) : offsetY;

    // Track if we're entering a participant
    const childInsideParticipant = insideParticipant || node.bpmn?.type === 'participant';

    // Process children
    if (node.children) {
      for (const child of node.children) {
        this.collectShapesAndEdges(child as LayoutedNode, shapes, edges, childOffsetX, childOffsetY, childInsideParticipant);
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
   * Store node BPMN metadata for later gateway detection
   */
  private storeNodeBpmn(nodeId: string, bpmn: { type?: string }): void {
    this.nodeBpmn.set(nodeId, bpmn);
  }

  /**
   * Find node BPMN metadata by id
   */
  private findNodeBpmn(nodeId: string): { type?: string } | undefined {
    return this.nodeBpmn.get(nodeId);
  }

  /**
   * Adjust an edge endpoint to connect to a gateway's diamond shape
   * Gateway diamonds have 4 corners: left, top, right, bottom
   */
  private adjustGatewayEndpoint(
    endpoint: PointModel,
    adjacentPoint: PointModel,
    gatewayPos: { x: number; y: number; width: number; height: number },
    isSource: boolean
  ): PointModel {
    const gatewayCenterX = gatewayPos.x + gatewayPos.width / 2;
    const gatewayCenterY = gatewayPos.y + gatewayPos.height / 2;
    const tolerance = 1; // Tolerance for corner detection

    if (DEBUG) {
      console.log(`[BPMN] adjustGatewayEndpoint: isSource=${isSource}`);
      console.log(`  endpoint: (${endpoint.x}, ${endpoint.y})`);
      console.log(`  gatewayPos: x=${gatewayPos.x}, y=${gatewayPos.y}, w=${gatewayPos.width}, h=${gatewayPos.height}`);
      console.log(`  gatewayCenter: (${gatewayCenterX}, ${gatewayCenterY})`);
      console.log(`  right edge x: ${gatewayPos.x + gatewayPos.width}`);
    }

    // Diamond corners (at midpoints of bounding box edges)
    const leftCorner = { x: gatewayPos.x, y: gatewayCenterY };
    const rightCorner = { x: gatewayPos.x + gatewayPos.width, y: gatewayCenterY };
    const topCorner = { x: gatewayCenterX, y: gatewayPos.y };
    const bottomCorner = { x: gatewayCenterX, y: gatewayPos.y + gatewayPos.height };

    // Check if endpoint is already at a diamond corner (no adjustment needed)
    // Left corner: x at left edge AND y at center
    if (Math.abs(endpoint.x - gatewayPos.x) < tolerance &&
        Math.abs(endpoint.y - gatewayCenterY) < tolerance) {
      if (DEBUG) console.log(`  -> Already at LEFT corner, no adjustment`);
      return endpoint;
    }
    // Right corner: x at right edge AND y at center
    if (Math.abs(endpoint.x - (gatewayPos.x + gatewayPos.width)) < tolerance &&
        Math.abs(endpoint.y - gatewayCenterY) < tolerance) {
      if (DEBUG) console.log(`  -> Already at RIGHT corner, no adjustment`);
      return endpoint;
    }
    // Top corner: y at top edge AND x at center
    if (Math.abs(endpoint.y - gatewayPos.y) < tolerance &&
        Math.abs(endpoint.x - gatewayCenterX) < tolerance) {
      if (DEBUG) console.log(`  -> Already at TOP corner, no adjustment`);
      return endpoint;
    }
    // Bottom corner: y at bottom edge AND x at center
    if (Math.abs(endpoint.y - (gatewayPos.y + gatewayPos.height)) < tolerance &&
        Math.abs(endpoint.x - gatewayCenterX) < tolerance) {
      if (DEBUG) console.log(`  -> Already at BOTTOM corner, no adjustment`);
      return endpoint;
    }

    if (DEBUG) {
      console.log(`  -> NOT at corner, will adjust`);
    }

    // Endpoint is NOT at a corner - calculate intersection with diamond edge
    const result = this.calculateDiamondIntersection(endpoint, gatewayPos, gatewayCenterX, gatewayCenterY, isSource, adjacentPoint);
    if (DEBUG) {
      console.log(`  -> Adjusted to: (${result.x}, ${result.y})`);
    }
    return result;
  }

  /**
   * Calculate the intersection point with the diamond edge
   */
  private calculateDiamondIntersection(
    endpoint: PointModel,
    gatewayPos: { x: number; y: number; width: number; height: number },
    gatewayCenterX: number,
    gatewayCenterY: number,
    isSource: boolean,
    adjacentPoint: PointModel
  ): PointModel {
    const tolerance = 1;

    const leftCorner = { x: gatewayPos.x, y: gatewayCenterY };
    const rightCorner = { x: gatewayPos.x + gatewayPos.width, y: gatewayCenterY };
    const topCorner = { x: gatewayCenterX, y: gatewayPos.y };
    const bottomCorner = { x: gatewayCenterX, y: gatewayPos.y + gatewayPos.height };

    // Determine which side based on endpoint position relative to gateway
    const isOnLeftEdge = Math.abs(endpoint.x - gatewayPos.x) < tolerance;
    const isOnRightEdge = Math.abs(endpoint.x - (gatewayPos.x + gatewayPos.width)) < tolerance;
    const isOnTopEdge = Math.abs(endpoint.y - gatewayPos.y) < tolerance;
    const isOnBottomEdge = Math.abs(endpoint.y - (gatewayPos.y + gatewayPos.height)) < tolerance;

    const halfWidth = gatewayPos.width / 2;
    const halfHeight = gatewayPos.height / 2;

    if (isOnLeftEdge || isOnRightEdge) {
      // Endpoint is on left or right edge of bounding box but not at corner
      // Calculate diamond edge intersection at this Y position
      const yDistFromCenter = Math.abs(endpoint.y - gatewayCenterY);

      if (yDistFromCenter >= halfHeight) {
        // Outside diamond vertically - snap to corner
        return isOnLeftEdge ? leftCorner : rightCorner;
      }

      // Diamond edge equation: |x - centerX| / halfWidth + |y - centerY| / halfHeight = 1
      const xOffsetFromCenter = halfWidth * (1 - yDistFromCenter / halfHeight);
      const intersectX = isOnLeftEdge
        ? gatewayCenterX - xOffsetFromCenter
        : gatewayCenterX + xOffsetFromCenter;

      return { x: intersectX, y: endpoint.y };
    }

    if (isOnTopEdge || isOnBottomEdge) {
      // Endpoint is on top or bottom edge of bounding box but not at corner
      // Calculate diamond edge intersection at this X position
      const xDistFromCenter = Math.abs(endpoint.x - gatewayCenterX);

      if (xDistFromCenter >= halfWidth) {
        // Outside diamond horizontally - snap to corner
        return isOnTopEdge ? topCorner : bottomCorner;
      }

      const yOffsetFromCenter = halfHeight * (1 - xDistFromCenter / halfWidth);
      const intersectY = isOnTopEdge
        ? gatewayCenterY - yOffsetFromCenter
        : gatewayCenterY + yOffsetFromCenter;

      return { x: endpoint.x, y: intersectY };
    }

    // Endpoint is not on any edge - use approach direction to determine corner
    const dx = isSource ? adjacentPoint.x - endpoint.x : endpoint.x - adjacentPoint.x;
    const dy = isSource ? adjacentPoint.y - endpoint.y : endpoint.y - adjacentPoint.y;

    if (Math.abs(dx) > Math.abs(dy)) {
      // Horizontal approach
      if (isSource) {
        return dx > 0 ? rightCorner : leftCorner;
      } else {
        return dx > 0 ? leftCorner : rightCorner;
      }
    } else {
      // Vertical approach
      if (isSource) {
        return dy > 0 ? bottomCorner : topCorner;
      } else {
        return dy > 0 ? topCorner : bottomCorner;
      }
    }
  }

  /**
   * Estimate number of lines needed for a label based on text and width
   * Uses approximate character width of 14px for CJK and 7px for ASCII
   */
  private estimateLabelLines(text: string, maxWidth: number): number {
    if (!text || maxWidth <= 0) return 1;

    let currentLineWidth = 0;
    let lines = 1;

    for (const char of text) {
      // CJK characters are wider
      const charWidth = char.charCodeAt(0) > 255 ? 14 : 7;

      if (currentLineWidth + charWidth > maxWidth) {
        lines++;
        currentLineWidth = charWidth;
      } else {
        currentLineWidth += charWidth;
      }
    }

    return lines;
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
      if (!label) return shape;
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
        const labelWidth = label?.width ?? 100;
        // Calculate label height based on text content (may need multiple lines)
        // Use bpmn.name as the display text since that's what bpmn-js renders
        const labelText = node.bpmn?.name ?? label?.text ?? '';
        const estimatedLines = this.estimateLabelLines(labelText, labelWidth);
        const labelHeight = estimatedLines * 14; // 14px per line

        // Position label above the gateway diamond, horizontally centered
        // Adjust Y position upward based on label height
        shape.label = {
          bounds: {
            x: absoluteX + (nodeWidth - labelWidth) / 2,
            y: absoluteY - labelHeight - 4, // 4px gap above the diamond
            width: labelWidth,
            height: labelHeight,
          },
        };
      } else if (label?.x !== undefined && label?.y !== undefined) {
        // For other elements, use ELK-calculated position (relative to node, converted to absolute)
        shape.label = {
          bounds: {
            x: absoluteX + label.x,
            y: absoluteY + label.y,
            width: label?.width ?? 100,
            height: label?.height ?? 20,
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

    // Check if source is a boundary event
    const bePosition = sourceId ? this.boundaryEventPositions.get(sourceId) : undefined;
    const targetPosition = targetId ? this.nodePositions.get(targetId) : undefined;

    // Check if source or target is a gateway (for diamond shape adjustment)
    const sourceNode = sourceId ? this.findNodeBpmn(sourceId) : undefined;
    const targetNode = targetId ? this.findNodeBpmn(targetId) : undefined;
    const sourceIsGateway = this.isGatewayType(sourceNode?.type);
    const targetIsGateway = this.isGatewayType(targetNode?.type);

    let waypoints: PointModel[] = [];

    // Check if edge has pre-calculated sections with bendPoints (from obstacle avoidance)
    const hasPreCalculatedSections = edge.sections &&
      edge.sections.length > 0 &&
      edge.sections[0]?.bendPoints &&
      edge.sections[0].bendPoints.length > 0;

    if (DEBUG && bePosition) {
      console.log(`[BPMN] buildEdge ${edge.id}: preCalculated=${hasPreCalculatedSections}`);
    }

    if (bePosition && targetPosition && !hasPreCalculatedSections) {
      // Source is a boundary event without pre-calculated routing - calculate simple waypoints
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

      // Adjust endpoints for gateway diamond shapes
      // This calculates the actual intersection with the diamond edge to maintain
      // visual separation when multiple edges connect to the same gateway side
      if (waypoints.length >= 2) {
        // Adjust start point if source is a gateway
        if (sourceIsGateway && sourceId) {
          const sourcePos = this.nodePositions.get(sourceId);
          if (sourcePos) {
            const wp0 = waypoints[0];
            const wp1 = waypoints[1];
            if (wp0 && wp1) {
              waypoints[0] = this.adjustGatewayEndpoint(
                wp0,
                wp1,
              sourcePos,
                true // isSource
              );
              // No adjacent point adjustment needed - the intersection calculation
              // preserves the original Y (or X) coordinate, maintaining orthogonality
            }
          }
        }

        // Adjust end point if target is a gateway
        if (targetIsGateway && targetId) {
          const targetPos = this.nodePositions.get(targetId);
          if (targetPos) {
            const lastIdx = waypoints.length - 1;
            const prevIdx = lastIdx - 1;
            const wpLast = waypoints[lastIdx];
            const wpPrev = waypoints[prevIdx];
            if (wpLast && wpPrev) {
              waypoints[lastIdx] = this.adjustGatewayEndpoint(
                wpLast,
                wpPrev,
              targetPos,
                false // isSource
              );
              // No adjacent point adjustment needed - the intersection calculation
              // preserves the original Y (or X) coordinate, maintaining orthogonality
            }
          }
        }
      }
    }

    const edgeModel: EdgeModel = {
      id: `${edge.id}_di`,
      bpmnElement: edge.id,
      waypoints,
    };

    // Add label if present - center it on the edge
    if (edge.labels && edge.labels.length > 0) {
      const label = edge.labels[0];
      const labelWidth = label?.width ?? 50;
      const labelHeight = label?.height ?? 14;

      // Calculate edge midpoint for label placement
      const labelPos = this.calculateEdgeLabelPosition(waypoints, labelWidth, labelHeight);

      edgeModel.label = {
        bounds: {
          x: labelPos.x,
          y: labelPos.y,
          width: labelWidth,
          height: labelHeight,
        },
      };
    }

    return edgeModel;
  }

  /**
   * Calculate label position centered on the edge
   * Places label at the midpoint of the edge, offset above the line
   */
  private calculateEdgeLabelPosition(
    waypoints: PointModel[],
    labelWidth: number,
    labelHeight: number
  ): { x: number; y: number } {
    if (waypoints.length < 2) {
      return { x: 0, y: 0 };
    }

    // Find the midpoint segment of the edge
    const totalLength = this.calculatePathLength(waypoints);
    const halfLength = totalLength / 2;

    // Walk along the path to find the midpoint
    let accumulatedLength = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const wpCurrent = waypoints[i];
      const wpNext = waypoints[i + 1];
      if (!wpCurrent || !wpNext) continue;
      const segmentLength = this.distance(wpCurrent, wpNext);
      const nextAccumulated = accumulatedLength + segmentLength;

      if (nextAccumulated >= halfLength) {
        // Midpoint is in this segment
        const ratio = (halfLength - accumulatedLength) / segmentLength;
        const midX = wpCurrent.x + (wpNext.x - wpCurrent.x) * ratio;
        const midY = wpCurrent.y + (wpNext.y - wpCurrent.y) * ratio;

        // Determine if segment is horizontal or vertical
        const dx = wpNext.x - wpCurrent.x;
        const dy = wpNext.y - wpCurrent.y;

        if (Math.abs(dy) < Math.abs(dx)) {
          // Horizontal segment - place label above the line
          return {
            x: midX - labelWidth / 2,
            y: midY - labelHeight - 4, // 4px above the line
          };
        } else {
          // Vertical segment - place label to the left of the line
          return {
            x: midX - labelWidth - 4, // 4px to the left
            y: midY - labelHeight / 2,
          };
        }
      }
      accumulatedLength = nextAccumulated;
    }

    // Fallback: use the geometric center
    const lastPoint = waypoints[waypoints.length - 1];
    return {
      x: (lastPoint?.x ?? 0) - labelWidth / 2,
      y: (lastPoint?.y ?? 0) - labelHeight - 4,
    };
  }

  /**
   * Calculate total path length
   */
  private calculatePathLength(waypoints: PointModel[]): number {
    let length = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const wp1 = waypoints[i];
      const wp2 = waypoints[i + 1];
      if (wp1 && wp2) {
        length += this.distance(wp1, wp2);
      }
    }
    return length;
  }

  /**
   * Calculate distance between two points
   */
  private distance(p1: PointModel, p2: PointModel): number {
    return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
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
  labels?: Array<{ text?: string; x?: number; y?: number; width?: number; height?: number }>;
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
