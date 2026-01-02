/**
 * BPMN XML Generator
 * Generates BPMN 2.0 XML from the intermediate model using bpmn-moddle
 */

import BpmnModdle from 'bpmn-moddle';
import type {
  BpmnModel,
  DefinitionsModel,
  DiagramModel,
  ProcessModel,
  CollaborationModel,
  FlowElementModel,
  ArtifactModel,
  ShapeModel,
  EdgeModel,
  LaneSetInfo,
  LaneInfo,
} from '../transform/model-builder';
import { BPMN_ELEMENT_MAP, EVENT_DEFINITION_MAP } from '../types/bpmn-constants';

// Type definitions for bpmn-moddle elements
interface ModdleElement {
  $type: string;
  id?: string;
  [key: string]: unknown;
}

export class BpmnXmlGenerator {
  private moddle: BpmnModdle;

  constructor() {
    this.moddle = new BpmnModdle();
  }

  /**
   * Generate BPMN 2.0 XML from the model
   */
  async generate(model: BpmnModel): Promise<string> {
    // Build the definitions element
    const definitions = this.buildDefinitions(model.definitions, model.diagram);

    // Serialize to XML
    const { xml } = await this.moddle.toXML(definitions, {
      format: true,
      preamble: true,
    });

    return xml;
  }

  /**
   * Build the root definitions element
   */
  private buildDefinitions(def: DefinitionsModel, diagram: DiagramModel): ModdleElement {
    const definitions = this.moddle.create('bpmn:Definitions', {
      id: def.id,
      targetNamespace: def.targetNamespace,
      exporter: def.exporter,
      exporterVersion: def.exporterVersion,
    });

    const rootElements: ModdleElement[] = [];

    // Add global definitions (messages, signals, errors, escalations)
    for (const msg of def.messages) {
      rootElements.push(
        this.moddle.create('bpmn:Message', {
          id: msg.id,
          name: msg.name,
        })
      );
    }

    for (const sig of def.signals) {
      rootElements.push(
        this.moddle.create('bpmn:Signal', {
          id: sig.id,
          name: sig.name,
        })
      );
    }

    for (const err of def.errors) {
      rootElements.push(
        this.moddle.create('bpmn:Error', {
          id: err.id,
          name: err.name,
          errorCode: err.errorCode,
        })
      );
    }

    for (const esc of def.escalations) {
      rootElements.push(
        this.moddle.create('bpmn:Escalation', {
          id: esc.id,
          name: esc.name,
          escalationCode: esc.escalationCode,
        })
      );
    }

    // Add root elements (collaborations and processes)
    for (const element of def.rootElements) {
      if (element.type === 'collaboration') {
        rootElements.push(this.buildCollaboration(element));
      } else if (element.type === 'process') {
        rootElements.push(this.buildProcess(element));
      }
    }

    definitions.rootElements = rootElements;

    // Add diagram
    definitions.diagrams = [this.buildDiagram(diagram)];

    return definitions;
  }

  /**
   * Build a collaboration element
   */
  private buildCollaboration(collab: CollaborationModel): ModdleElement {
    const collaboration = this.moddle.create('bpmn:Collaboration', {
      id: collab.id,
      name: collab.name,
      isClosed: collab.isClosed,
    });

    // Add participants
    collaboration.participants = collab.participants.map((p) => {
      const participant = this.moddle.create('bpmn:Participant', {
        id: p.id,
        name: p.name,
        processRef: p.processRef ? { id: p.processRef } : undefined,
      });

      if (p.participantMultiplicity) {
        participant.participantMultiplicity = this.moddle.create(
          'bpmn:ParticipantMultiplicity',
          {
            minimum: p.participantMultiplicity.minimum,
            maximum: p.participantMultiplicity.maximum,
          }
        );
      }

      return participant;
    });

    // Add message flows
    collaboration.messageFlows = collab.messageFlows.map((mf) =>
      this.moddle.create('bpmn:MessageFlow', {
        id: mf.id,
        name: mf.name,
        sourceRef: { id: mf.sourceRef },
        targetRef: { id: mf.targetRef },
        messageRef: mf.messageRef ? { id: mf.messageRef } : undefined,
      })
    );

    return collaboration;
  }

  /**
   * Build a process element
   */
  private buildProcess(process: ProcessModel): ModdleElement {
    const bpmnProcess = this.moddle.create('bpmn:Process', {
      id: process.id,
      name: process.name,
      isExecutable: process.isExecutable ?? true,
      processType: process.processType,
      isClosed: process.isClosed,
    });

    const flowElements: ModdleElement[] = [];

    // Add lane set if present
    if (process.laneSet) {
      bpmnProcess.laneSets = [this.buildLaneSet(process.laneSet)];
    }

    // Add flow elements
    for (const element of process.flowElements) {
      flowElements.push(this.buildFlowElement(element));
    }

    bpmnProcess.flowElements = flowElements;

    // Add artifacts
    if (process.artifacts.length > 0) {
      bpmnProcess.artifacts = process.artifacts.map((a) => this.buildArtifact(a));
    }

    return bpmnProcess;
  }

  /**
   * Build a lane set
   */
  private buildLaneSet(laneSet: LaneSetInfo): ModdleElement {
    const bpmnLaneSet = this.moddle.create('bpmn:LaneSet', {
      id: laneSet.id,
    });

    bpmnLaneSet.lanes = laneSet.lanes.map((lane) => this.buildLane(lane));

    return bpmnLaneSet;
  }

  /**
   * Build a lane
   */
  private buildLane(lane: LaneInfo): ModdleElement {
    const bpmnLane = this.moddle.create('bpmn:Lane', {
      id: lane.id,
      name: lane.name,
    });

    // Add flow node references
    bpmnLane.flowNodeRef = lane.flowNodeRefs.map((ref) => ({ id: ref }));

    // Add child lane set if present
    if (lane.childLaneSet) {
      bpmnLane.childLaneSet = this.buildLaneSet(lane.childLaneSet);
    }

    return bpmnLane;
  }

  /**
   * Build a flow element (event, task, gateway, subprocess, sequence flow)
   */
  private buildFlowElement(element: FlowElementModel): ModdleElement {
    const elementType = BPMN_ELEMENT_MAP[element.type as keyof typeof BPMN_ELEMENT_MAP];
    if (!elementType) {
      throw new Error(`Unknown element type: ${element.type}`);
    }

    const bpmnElement = this.moddle.create(elementType, {
      id: element.id,
      name: element.name,
    });

    // Add incoming/outgoing references
    if (element.incoming.length > 0) {
      bpmnElement.incoming = element.incoming.map((id) => ({ id }));
    }
    if (element.outgoing.length > 0) {
      bpmnElement.outgoing = element.outgoing.map((id) => ({ id }));
    }

    // Handle specific element types
    this.applyElementProperties(bpmnElement, element);

    // Add data associations (BPMN 2.0 spec: child elements of Activity)
    this.applyDataAssociations(bpmnElement, element);

    return bpmnElement;
  }

  /**
   * Apply element-specific properties
   */
  private applyElementProperties(bpmnElement: ModdleElement, element: FlowElementModel): void {
    const props = element.properties;

    // Events
    if (element.type.includes('Event')) {
      this.applyEventProperties(bpmnElement, element);
    }

    // Tasks
    if (element.type.includes('Task') || element.type === 'task') {
      this.applyTaskProperties(bpmnElement, props);
    }

    // Gateways
    if (element.type.includes('Gateway')) {
      this.applyGatewayProperties(bpmnElement, props);
    }

    // SubProcesses
    if (element.type === 'subProcess' || element.type === 'transaction' ||
        element.type === 'adHocSubProcess' || element.type === 'eventSubProcess') {
      this.applySubProcessProperties(bpmnElement, props);

      // Add nested flow elements for expanded subprocesses
      if (element.flowElements && element.flowElements.length > 0) {
        bpmnElement.flowElements = element.flowElements.map((fe) => this.buildFlowElement(fe));
      }
      if (element.artifacts && element.artifacts.length > 0) {
        bpmnElement.artifacts = element.artifacts.map((a) => this.buildArtifact(a));
      }
    }

    // Call Activity
    if (element.type === 'callActivity') {
      this.applyCallActivityProperties(bpmnElement, props);
    }

    // Boundary Event
    if (element.type === 'boundaryEvent') {
      bpmnElement.attachedToRef = { id: element.attachedToRef };
      bpmnElement.cancelActivity = element.cancelActivity ?? true;
    }

    // Sequence Flow
    if (element.type === 'sequenceFlow') {
      this.applySequenceFlowProperties(bpmnElement, props);
    }

    // Loop characteristics
    if (props.loopCharacteristics) {
      bpmnElement.loopCharacteristics = this.buildLoopCharacteristics(
        props.loopCharacteristics as LoopCharacteristicsProps
      );
    }
  }

  /**
   * Apply event-specific properties
   */
  private applyEventProperties(bpmnElement: ModdleElement, element: FlowElementModel): void {
    const props = element.properties;
    const eventDefType = props.eventDefinitionType as string | undefined;

    if (!eventDefType || eventDefType === 'none') {
      return;
    }

    const eventDefElementType = EVENT_DEFINITION_MAP[eventDefType as keyof typeof EVENT_DEFINITION_MAP];
    if (!eventDefElementType) {
      return;
    }

    const eventDef = this.moddle.create(eventDefElementType, {});

    // Apply event definition specific properties
    switch (eventDefType) {
      case 'message':
        if (props.messageRef) {
          eventDef.messageRef = { id: props.messageRef as string };
        }
        break;
      case 'signal':
        if (props.signalRef) {
          eventDef.signalRef = { id: props.signalRef as string };
        }
        break;
      case 'error':
        if (props.errorRef) {
          eventDef.errorRef = { id: props.errorRef as string };
        }
        break;
      case 'escalation':
        if (props.escalationRef) {
          eventDef.escalationRef = { id: props.escalationRef as string };
        }
        break;
      case 'timer':
        if (props.timerEventDefinition) {
          const timerDef = props.timerEventDefinition as TimerEventDefinitionProps;
          if (timerDef.timeDate) {
            eventDef.timeDate = this.moddle.create('bpmn:FormalExpression', {
              body: timerDef.timeDate,
            });
          }
          if (timerDef.timeDuration) {
            eventDef.timeDuration = this.moddle.create('bpmn:FormalExpression', {
              body: timerDef.timeDuration,
            });
          }
          if (timerDef.timeCycle) {
            eventDef.timeCycle = this.moddle.create('bpmn:FormalExpression', {
              body: timerDef.timeCycle,
            });
          }
        }
        break;
      case 'conditional':
        if (props.conditionalEventDefinition) {
          const condDef = props.conditionalEventDefinition as ConditionalEventDefinitionProps;
          if (condDef.condition) {
            eventDef.condition = this.moddle.create('bpmn:FormalExpression', {
              language: condDef.condition.language,
              body: condDef.condition.body,
            });
          }
        }
        break;
      case 'link':
        if (props.linkEventDefinition) {
          const linkDef = props.linkEventDefinition as LinkEventDefinitionProps;
          eventDef.name = linkDef.name;
          if (linkDef.target) {
            eventDef.target = { id: linkDef.target };
          }
        }
        break;
    }

    bpmnElement.eventDefinitions = [eventDef];
  }

  /**
   * Apply task-specific properties
   */
  private applyTaskProperties(bpmnElement: ModdleElement, props: Record<string, unknown>): void {
    // User Task properties (Camunda extensions would go here)
    // For standard BPMN, we just set the basic properties
    if (props.implementation) {
      bpmnElement.implementation = props.implementation;
    }

    // Script Task
    if (props.script) {
      const script = props.script as ScriptProps;
      bpmnElement.scriptFormat = script.scriptFormat;
      bpmnElement.script = script.script;
    }

    // Send/Receive Task
    if (props.messageRef) {
      bpmnElement.messageRef = { id: props.messageRef as string };
    }
    if (props.instantiate !== undefined) {
      bpmnElement.instantiate = props.instantiate;
    }
  }

  /**
   * Apply gateway-specific properties
   */
  private applyGatewayProperties(bpmnElement: ModdleElement, props: Record<string, unknown>): void {
    if (props.gatewayDirection) {
      bpmnElement.gatewayDirection = props.gatewayDirection;
    }
    if (props.default) {
      bpmnElement.default = { id: props.default as string };
    }
    if (props.instantiate !== undefined) {
      bpmnElement.instantiate = props.instantiate;
    }
    if (props.eventGatewayType) {
      bpmnElement.eventGatewayType = props.eventGatewayType;
    }
    if (props.activationCondition) {
      bpmnElement.activationCondition = this.moddle.create('bpmn:FormalExpression', {
        body: props.activationCondition as string,
      });
    }
  }

  /**
   * Apply subprocess-specific properties
   */
  private applySubProcessProperties(bpmnElement: ModdleElement, props: Record<string, unknown>): void {
    if (props.triggeredByEvent !== undefined) {
      bpmnElement.triggeredByEvent = props.triggeredByEvent;
    }

    // AdHoc SubProcess
    if (props.adHocOrdering) {
      bpmnElement.ordering = props.adHocOrdering;
    }
    if (props.adHocCompletionCondition) {
      bpmnElement.completionCondition = this.moddle.create('bpmn:FormalExpression', {
        body: props.adHocCompletionCondition as string,
      });
    }
    if (props.cancelRemainingInstances !== undefined) {
      bpmnElement.cancelRemainingInstances = props.cancelRemainingInstances;
    }

    // Transaction
    if (props.transactionProtocol) {
      bpmnElement.protocol = props.transactionProtocol;
    }
  }

  /**
   * Apply call activity properties
   */
  private applyCallActivityProperties(bpmnElement: ModdleElement, props: Record<string, unknown>): void {
    if (props.calledElement) {
      bpmnElement.calledElement = props.calledElement;
    }
  }

  /**
   * Apply sequence flow properties
   */
  private applySequenceFlowProperties(bpmnElement: ModdleElement, props: Record<string, unknown>): void {
    bpmnElement.sourceRef = { id: props.sourceRef as string };
    bpmnElement.targetRef = { id: props.targetRef as string };

    if (props.conditionExpression) {
      const condExpr = props.conditionExpression as ConditionExpressionProps;
      bpmnElement.conditionExpression = this.moddle.create('bpmn:FormalExpression', {
        language: condExpr.language,
        body: condExpr.body,
      });
    }
  }

  /**
   * Apply data associations (BPMN 2.0 spec: dataInputAssociation/dataOutputAssociation are child elements of Activity)
   */
  private applyDataAssociations(bpmnElement: ModdleElement, element: FlowElementModel): void {
    // Add dataInputAssociations
    if (element.dataInputAssociations && element.dataInputAssociations.length > 0) {
      bpmnElement.dataInputAssociations = element.dataInputAssociations.map((assoc) => {
        const dataInputAssoc = this.moddle.create('bpmn:DataInputAssociation', {
          id: assoc.id,
        });
        // sourceRef is an array of references
        dataInputAssoc.sourceRef = [{ id: assoc.sourceRef }];
        return dataInputAssoc;
      });
    }

    // Add dataOutputAssociations
    if (element.dataOutputAssociations && element.dataOutputAssociations.length > 0) {
      bpmnElement.dataOutputAssociations = element.dataOutputAssociations.map((assoc) => {
        const dataOutputAssoc = this.moddle.create('bpmn:DataOutputAssociation', {
          id: assoc.id,
        });
        // targetRef is a single reference
        if (assoc.targetRef) {
          dataOutputAssoc.targetRef = { id: assoc.targetRef };
        }
        return dataOutputAssoc;
      });
    }
  }

  /**
   * Build loop characteristics
   */
  private buildLoopCharacteristics(props: LoopCharacteristicsProps): ModdleElement {
    if (props.loopType === 'standard') {
      const loop = this.moddle.create('bpmn:StandardLoopCharacteristics', {
        testBefore: props.testBefore,
        loopMaximum: props.loopMaximum,
      });
      if (props.loopCondition) {
        loop.loopCondition = this.moddle.create('bpmn:FormalExpression', {
          body: props.loopCondition,
        });
      }
      return loop;
    }

    // Multi-instance (default)
    const multiInstance = this.moddle.create('bpmn:MultiInstanceLoopCharacteristics', {
      isSequential: props.isSequential ?? false,
    });

    if (props.loopCardinality) {
      multiInstance.loopCardinality = this.moddle.create('bpmn:FormalExpression', {
        body: props.loopCardinality,
      });
    }
    if (props.loopDataInputRef) {
      multiInstance.loopDataInputRef = { id: props.loopDataInputRef };
    }
    if (props.loopDataOutputRef) {
      multiInstance.loopDataOutputRef = { id: props.loopDataOutputRef };
    }
    if (props.completionCondition) {
      multiInstance.completionCondition = this.moddle.create('bpmn:FormalExpression', {
        body: props.completionCondition,
      });
    }

    return multiInstance;
  }

  /**
   * Build an artifact element
   */
  private buildArtifact(artifact: ArtifactModel): ModdleElement {
    const elementType = BPMN_ELEMENT_MAP[artifact.type as keyof typeof BPMN_ELEMENT_MAP];
    if (!elementType) {
      throw new Error(`Unknown artifact type: ${artifact.type}`);
    }

    const bpmnArtifact = this.moddle.create(elementType, {
      id: artifact.id,
      name: artifact.name,
    });

    // Apply artifact-specific properties
    const props = artifact.properties;

    if (artifact.type === 'textAnnotation') {
      bpmnArtifact.text = props.text as string | undefined;
      bpmnArtifact.textFormat = props.textFormat as string | undefined;
    }

    if (artifact.type === 'dataObjectReference' || artifact.type === 'dataObject') {
      if (props.isCollection !== undefined) {
        bpmnArtifact.isCollection = props.isCollection;
      }
      if (props.dataState) {
        const state = props.dataState as { name?: string };
        bpmnArtifact.dataState = this.moddle.create('bpmn:DataState', {
          name: state.name,
        });
      }
    }

    if (artifact.type === 'dataStoreReference') {
      if (props.capacity !== undefined) {
        bpmnArtifact.capacity = props.capacity;
      }
      if (props.isUnlimited !== undefined) {
        bpmnArtifact.isUnlimited = props.isUnlimited;
      }
    }

    if (artifact.type === 'group') {
      if (props.categoryValueRef) {
        bpmnArtifact.categoryValueRef = { id: props.categoryValueRef as string };
      }
    }

    if (artifact.type === 'association') {
      if (props.sourceRef) {
        bpmnArtifact.sourceRef = { id: props.sourceRef as string };
      }
      if (props.targetRef) {
        bpmnArtifact.targetRef = { id: props.targetRef as string };
      }
      if (props.associationDirection) {
        bpmnArtifact.associationDirection = props.associationDirection as string;
      }
    }

    return bpmnArtifact;
  }

  /**
   * Build the diagram element
   */
  private buildDiagram(diagram: DiagramModel): ModdleElement {
    const bpmnDiagram = this.moddle.create('bpmndi:BPMNDiagram', {
      id: diagram.id,
      name: diagram.name,
    });

    const plane = this.moddle.create('bpmndi:BPMNPlane', {
      id: diagram.plane.id,
      bpmnElement: { id: diagram.plane.bpmnElement },
    });

    const planeElements: ModdleElement[] = [];

    // Add shapes
    for (const shape of diagram.plane.shapes) {
      planeElements.push(this.buildShape(shape));
    }

    // Add edges
    for (const edge of diagram.plane.edges) {
      planeElements.push(this.buildEdge(edge));
    }

    plane.planeElement = planeElements;
    bpmnDiagram.plane = plane;

    return bpmnDiagram;
  }

  /**
   * Build a shape element
   */
  private buildShape(shape: ShapeModel): ModdleElement {
    const bpmnShape = this.moddle.create('bpmndi:BPMNShape', {
      id: shape.id,
      bpmnElement: { id: shape.bpmnElement },
    });

    bpmnShape.bounds = this.moddle.create('dc:Bounds', {
      x: shape.bounds.x,
      y: shape.bounds.y,
      width: shape.bounds.width,
      height: shape.bounds.height,
    });

    if (shape.isExpanded !== undefined) {
      bpmnShape.isExpanded = shape.isExpanded;
    }

    if (shape.isHorizontal !== undefined) {
      bpmnShape.isHorizontal = shape.isHorizontal;
    }

    if (shape.label?.bounds) {
      bpmnShape.label = this.moddle.create('bpmndi:BPMNLabel', {
        bounds: this.moddle.create('dc:Bounds', {
          x: shape.label.bounds.x,
          y: shape.label.bounds.y,
          width: shape.label.bounds.width,
          height: shape.label.bounds.height,
        }),
      });
    }

    return bpmnShape;
  }

  /**
   * Build an edge element
   */
  private buildEdge(edge: EdgeModel): ModdleElement {
    const bpmnEdge = this.moddle.create('bpmndi:BPMNEdge', {
      id: edge.id,
      bpmnElement: { id: edge.bpmnElement },
    });

    bpmnEdge.waypoint = edge.waypoints.map((wp) =>
      this.moddle.create('dc:Point', {
        x: wp.x,
        y: wp.y,
      })
    );

    if (edge.label?.bounds) {
      bpmnEdge.label = this.moddle.create('bpmndi:BPMNLabel', {
        bounds: this.moddle.create('dc:Bounds', {
          x: edge.label.bounds.x,
          y: edge.label.bounds.y,
          width: edge.label.bounds.width,
          height: edge.label.bounds.height,
        }),
      });
    }

    return bpmnEdge;
  }
}

// Property type definitions
interface TimerEventDefinitionProps {
  timeDate?: string;
  timeDuration?: string;
  timeCycle?: string;
}

interface ConditionalEventDefinitionProps {
  condition?: {
    type?: string;
    language?: string;
    body?: string;
  };
}

interface LinkEventDefinitionProps {
  name?: string;
  source?: string[];
  target?: string;
}

interface ScriptProps {
  scriptFormat?: string;
  script?: string;
  resultVariable?: string;
}

interface ConditionExpressionProps {
  type?: string;
  language?: string;
  body?: string;
}

interface LoopCharacteristicsProps {
  loopType?: 'standard' | 'multiInstance';
  isSequential?: boolean;
  loopCardinality?: string;
  loopDataInputRef?: string;
  loopDataOutputRef?: string;
  inputDataItem?: string;
  outputDataItem?: string;
  completionCondition?: string;
  loopCondition?: string;
  loopMaximum?: number;
  testBefore?: boolean;
}
