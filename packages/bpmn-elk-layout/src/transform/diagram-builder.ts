/**
 * Diagram Builder
 * Handles building the visual diagram (shapes and edges) from a layouted graph.
 * This module is responsible for converting layouted node positions into
 * BPMN DI (Diagram Interchange) format.
 */

import type { LayoutedGraph } from '../types/elk-output';
import type { IoSpecification } from '../types/elk-bpmn';
import type {
  DiagramModel,
  ShapeModel,
  EdgeModel,
  PointModel,
  DefinitionsModel,
  LayoutedNode,
  LayoutedEdge,
  NodePosition,
  NodeOffset,
  NodeBpmnInfo,
} from './model-types';
import { isDebugEnabled } from '../utils/debug';
import {
  adjustGatewayEndpoint,
  distance,
  calculatePathLength,
} from '../layout/edge-routing';

// ============================================================================
// Diagram Builder
// ============================================================================

export class DiagramBuilder {
  // Map to track boundary event positions: id -> { x, y, width, height }
  private boundaryEventPositions: Map<string, NodePosition> = new Map();
  // Map to track all node positions for edge routing: id -> { x, y, width, height }
  private nodePositions: Map<string, NodePosition> = new Map();
  // Map to track the offset used for each node (for edge coordinate transformation)
  private nodeOffsets: Map<string, NodeOffset> = new Map();
  // Map to track node BPMN metadata for gateway detection
  private nodeBpmn: Map<string, NodeBpmnInfo> = new Map();
  // List of already placed edge labels for collision detection
  private placedEdgeLabels: Array<{ x: number; y: number; width: number; height: number }> = [];

  /**
   * Build the diagram model from a layouted graph
   */
  build(graph: LayoutedGraph, definitions: DefinitionsModel): DiagramModel {
    // Reset placed edge labels for each build
    this.placedEdgeLabels = [];
    // Reset all maps
    this.boundaryEventPositions.clear();
    this.nodePositions.clear();
    this.nodeOffsets.clear();
    this.nodeBpmn.clear();

    const shapes: ShapeModel[] = [];
    const edges: EdgeModel[] = [];

    // Find the main bpmn element for the plane
    const mainElement = definitions.rootElements[0];
    if (!mainElement) {
      throw new Error('Cannot create BPMN diagram: definitions.rootElements is empty. The graph must contain at least one process or collaboration.');
    }
    const planeElement = mainElement.type === 'collaboration' ? mainElement.id : mainElement.id;

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
   * Get stored node positions (for external access if needed)
   */
  getNodePositions(): Map<string, NodePosition> {
    return this.nodePositions;
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
      // Use visual height if available (for nodes with ioSpecification, ELK height includes extra space for data objects)
      const bpmnAny = node.bpmn as { _visualHeight?: number } | undefined;
      const nodeHeight = bpmnAny?._visualHeight ?? node.height ?? 80;

      // Store node position for edge routing
      // For events, include the label area below the node in the bounds
      // to help edge labels avoid overlapping with node labels
      let effectiveHeight = nodeHeight;
      if (this.isEventType(node.bpmn?.type) && node.labels && node.labels.length > 0) {
        // Events have labels below them - extend the effective height
        const labelHeight = node.labels[0]?.height ?? 14;
        effectiveHeight = nodeHeight + 4 + labelHeight; // 4px gap + label height
      }

      // Store visualHeight when node has ioSpecification (ELK layout uses larger height for spacing)
      // This is used by buildEdge to adjust edge endpoints to connect to the visual node border
      const nodePosition: NodePosition = {
        x: absoluteX,
        y: absoluteY,
        width: nodeWidth,
        height: effectiveHeight,
      };
      if (bpmnAny?._visualHeight !== undefined) {
        nodePosition.visualHeight = bpmnAny._visualHeight;
      }
      this.nodePositions.set(node.id, nodePosition);

      // Store node BPMN metadata for gateway detection
      if (node.bpmn) {
        this.storeNodeBpmn(node.id, { type: node.bpmn.type });
      }

      // Store the offset used for this node (needed for edge coordinate transformation)
      this.nodeOffsets.set(node.id, { x: offsetX, y: offsetY });

      shapes.push(this.buildShape(node, offsetX, offsetY));

      // Process ioSpecification dataInput/dataOutput shapes for tasks/activities only
      // These are visual representations of task inputs/outputs positioned around the task
      // Skip for process-level ioSpecification (process type should not have visual data shapes)
      const nodeType = node.bpmn?.type;
      const isTaskOrActivity = nodeType && (
        nodeType.includes('Task') ||
        nodeType === 'task' ||
        nodeType === 'callActivity' ||
        nodeType === 'subProcess' ||
        nodeType === 'transaction' ||
        nodeType === 'adHocSubProcess'
      );

      if (isTaskOrActivity) {
        const ioSpec = (node.bpmn as { ioSpecification?: IoSpecification } | undefined)?.ioSpecification;
        if (ioSpec) {
          this.buildIoSpecificationShapes(node, ioSpec, shapes, edges, absoluteX, absoluteY, nodeWidth, nodeHeight);
        }
      }
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
  private storeNodeBpmn(nodeId: string, bpmn: NodeBpmnInfo): void {
    this.nodeBpmn.set(nodeId, bpmn);
  }

  /**
   * Build shapes for ioSpecification dataInputs and dataOutputs
   * Positions: dataInputs below-left of the task (stacked vertically),
   *            dataOutputs below-right of the task (stacked vertically)
   * Only the topmost item in each stack has a dashed association edge to the task
   */
  private buildIoSpecificationShapes(
    node: LayoutedNode,
    ioSpec: IoSpecification,
    shapes: ShapeModel[],
    edges: EdgeModel[],
    taskX: number,
    taskY: number,
    taskWidth: number,
    taskHeight: number
  ): void {
    // Data object dimensions (same as dataObjectReference)
    const dataWidth = 36;
    const dataHeight = 50;
    const gapBelow = 20; // Gap between task and first data object (vertical)
    const verticalSpacing = 24; // Spacing between stacked data objects (includes label space)
    const labelHeight = 14;

    // Position dataInputs below the task, aligned to the left side, stacked vertically
    const dataInputs = ioSpec.dataInputs ?? [];
    const inputStartX = taskX; // Start from task's left edge

    dataInputs.forEach((dataInput, index) => {
      const inputId = dataInput.id ?? `${node.id}_input_${index}`;
      const inputX = inputStartX;
      const inputY = taskY + taskHeight + gapBelow + index * (dataHeight + verticalSpacing);

      // Store position for edge routing
      this.nodePositions.set(inputId, {
        x: inputX,
        y: inputY,
        width: dataWidth,
        height: dataHeight,
      });

      const shape: ShapeModel = {
        id: `${inputId}_di`,
        bpmnElement: inputId,
        bounds: {
          x: inputX,
          y: inputY,
          width: dataWidth,
          height: dataHeight,
        },
      };

      // Add label below the data object
      if (dataInput.name) {
        const labelWidth = Math.max(dataWidth, this.estimateTextWidth(dataInput.name));
        shape.label = {
          bounds: {
            x: inputX + (dataWidth - labelWidth) / 2,
            y: inputY + dataHeight + 4,
            width: labelWidth,
            height: labelHeight,
          },
        };
      }

      shapes.push(shape);

      // Only the first (topmost) dataInput gets an edge to the task
      if (index === 0) {
        // Create dashed edge from dataInput to task (arrow pointing to task)
        // bpmnElement references the auto-generated dataInputAssociation
        const assocId = `${inputId}_assoc`;
        const inputCenterX = inputX + dataWidth / 2;
        const inputTopY = inputY;
        const taskBottomY = taskY + taskHeight;

        // Simple vertical connection from data object top to task bottom
        edges.push({
          id: `${assocId}_di`,
          bpmnElement: assocId,
          waypoints: [
            { x: inputCenterX, y: inputTopY },
            { x: inputCenterX, y: taskBottomY },
          ],
        });
      }
    });

    // Position dataOutputs below the task, aligned to the right side, stacked vertically
    const dataOutputs = ioSpec.dataOutputs ?? [];
    const outputStartX = taskX + taskWidth - dataWidth; // Align to right edge

    dataOutputs.forEach((dataOutput, index) => {
      const outputId = dataOutput.id ?? `${node.id}_output_${index}`;
      const outputX = outputStartX;
      const outputY = taskY + taskHeight + gapBelow + index * (dataHeight + verticalSpacing);

      // Store position for edge routing
      this.nodePositions.set(outputId, {
        x: outputX,
        y: outputY,
        width: dataWidth,
        height: dataHeight,
      });

      const shape: ShapeModel = {
        id: `${outputId}_di`,
        bpmnElement: outputId,
        bounds: {
          x: outputX,
          y: outputY,
          width: dataWidth,
          height: dataHeight,
        },
      };

      // Add label below the data object
      if (dataOutput.name) {
        const labelWidth = Math.max(dataWidth, this.estimateTextWidth(dataOutput.name));
        shape.label = {
          bounds: {
            x: outputX + (dataWidth - labelWidth) / 2,
            y: outputY + dataHeight + 4,
            width: labelWidth,
            height: labelHeight,
          },
        };
      }

      shapes.push(shape);

      // Only the first (topmost) dataOutput gets an edge from the task
      if (index === 0) {
        // Create dashed edge from task to dataOutput (arrow pointing to dataOutput)
        // bpmnElement references the auto-generated dataOutputAssociation
        const assocId = `${outputId}_assoc`;
        const outputCenterX = outputX + dataWidth / 2;
        const outputTopY = outputY;
        const taskBottomY = taskY + taskHeight;

        // Simple vertical connection from task bottom to data object top
        edges.push({
          id: `${assocId}_di`,
          bpmnElement: assocId,
          waypoints: [
            { x: outputCenterX, y: taskBottomY },
            { x: outputCenterX, y: outputTopY },
          ],
        });
      }
    });
  }

  /**
   * Estimate text width for label sizing (simplified)
   */
  private estimateTextWidth(text: string): number {
    let width = 0;
    for (const char of text) {
      // CJK characters are wider
      if (char.charCodeAt(0) > 255) {
        width += 14;
      } else {
        width += 7;
      }
    }
    return Math.max(36, Math.min(width, 150));
  }

  /**
   * Find node BPMN metadata by id
   */
  private findNodeBpmn(nodeId: string): NodeBpmnInfo | undefined {
    return this.nodeBpmn.get(nodeId);
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
    // Use visual height if available (for nodes with ioSpecification, ELK height includes extra space)
    const bpmnAny = node.bpmn as { _visualHeight?: number } | undefined;
    const visualHeight = bpmnAny?._visualHeight ?? node.height ?? 80;

    const shape: ShapeModel = {
      id: `${node.id}_di`,
      bpmnElement: node.id,
      bounds: {
        x: absoluteX,
        y: absoluteY,
        width: node.width ?? 100,
        height: visualHeight,
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

    // Add label positioning for elements that need external labels
    // Priority: use explicit labels data if present, otherwise generate from bpmn.name
    const nodeWidth = node.width ?? 36;
    const nodeHeight = bpmnAny?._visualHeight ?? node.height ?? 36;
    const label = node.labels?.[0];
    const labelText = node.bpmn?.name ?? label?.text ?? '';

    if (this.isEventType(node.bpmn?.type) && labelText) {
      // For events (circles), position the label below the shape (bpmn-js default behavior)
      const labelWidth = label?.width ?? 100;
      const labelHeight = label?.height ?? 14;

      // Position label below the event circle, horizontally centered (using absolute coords)
      shape.label = {
        bounds: {
          x: absoluteX + (nodeWidth - labelWidth) / 2,
          y: absoluteY + nodeHeight + 4, // 4px gap below the circle
          width: labelWidth,
          height: labelHeight,
        },
      };
    } else if (this.isGatewayType(node.bpmn?.type) && labelText) {
      // For gateways (diamonds), position the label above the shape to avoid overlap with nodes below
      const labelWidth = label?.width ?? 100;
      // Calculate label height based on text content (may need multiple lines)
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
      // For other elements with explicit label positioning, use ELK-calculated position
      shape.label = {
        bounds: {
          x: absoluteX + label.x,
          y: absoluteY + label.y,
          width: label?.width ?? 100,
          height: label?.height ?? 20,
        },
      };
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

    if (isDebugEnabled() && bePosition) {
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
              waypoints[0] = adjustGatewayEndpoint(
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
              waypoints[lastIdx] = adjustGatewayEndpoint(
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

      // Adjust endpoints for nodes with ioSpecification (visualHeight)
      // ELK calculates waypoints based on the enlarged layout height (which includes space for data objects),
      // but we need to connect to the visual node border, not the layout center
      this.adjustEndpointsForVisualHeight(waypoints, sourceId, targetId);
    }

    // Ensure all waypoint segments are orthogonal (no diagonal lines)
    // Insert bend points where needed to convert diagonals to L-shaped routes
    this.ensureOrthogonalWaypoints(waypoints);

    // Ensure endpoints connect perpendicular to node borders
    // This adds bend points if the last/first segment isn't perpendicular
    this.ensurePerpendicularEndpoints(
      waypoints,
      sourceId,
      targetId,
      sourceIsGateway,
      targetIsGateway
    );

    const edgeModel: EdgeModel = {
      id: `${edge.id}_di`,
      bpmnElement: edge.id,
      waypoints,
    };

    // Add label if present - use smart positioning on longest segment
    if (edge.labels && edge.labels.length > 0) {
      const label = edge.labels[0];
      const labelWidth = label?.width ?? 50;
      const labelHeight = label?.height ?? 14;

      // Always use our smart label positioning (ELK's positions are often poor)
      const labelPos = this.calculateSmartLabelPosition(
        waypoints,
        labelWidth,
        labelHeight,
        sourceId,
        targetId
      );

      // Register this label position for collision detection with other edge labels
      this.placedEdgeLabels.push({
        x: labelPos.x,
        y: labelPos.y,
        width: labelWidth,
        height: labelHeight,
      });

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
   * Adjust edge endpoints for nodes with ioSpecification (visualHeight)
   *
   * When a node has ioSpecification, ELK uses an enlarged height for layout (to make space for data objects).
   * However, the edge endpoints should connect to the visual node border, not based on the layout height.
   *
   * This method adjusts endpoint Y coordinates and also adjusts adjacent waypoints if they were
   * on the same horizontal line, to maintain horizontal segments without introducing extra bends.
   */
  private adjustEndpointsForVisualHeight(
    waypoints: PointModel[],
    sourceId?: string,
    targetId?: string
  ): void {
    if (waypoints.length < 2) return;

    const tolerance = 5;

    // Adjust source endpoint if source has visualHeight
    if (sourceId) {
      const sourcePos = this.nodePositions.get(sourceId);
      if (sourcePos?.visualHeight !== undefined) {
        const firstWp = waypoints[0];
        const secondWp = waypoints[1];
        if (firstWp && secondWp) {
          const nodeRight = sourcePos.x + sourcePos.width;
          const nodeLeft = sourcePos.x;
          const visualBottom = sourcePos.y + sourcePos.visualHeight;
          const visualCenterY = sourcePos.y + sourcePos.visualHeight / 2;

          // Check if leaving from left or right side (horizontal connection)
          if (Math.abs(firstWp.x - nodeRight) < tolerance || Math.abs(firstWp.x - nodeLeft) < tolerance) {
            const oldY = firstWp.y;
            const newY = visualCenterY;
            // Horizontal exit - adjust Y to visual center
            firstWp.y = newY;
            // If second waypoint was on the same horizontal line, adjust it too to maintain horizontal segment
            // BUT only if second waypoint is NOT the last waypoint (i.e., not connecting directly to target)
            if (Math.abs(secondWp.y - oldY) < tolerance && waypoints.length > 2) {
              secondWp.y = newY;
            }
          } else if (firstWp.y > visualBottom) {
            // Leaving from below visual bottom - clamp to visual bottom
            firstWp.y = visualBottom;
          }
        }
      }
    }

    // Adjust target endpoint if target has visualHeight
    if (targetId) {
      const targetPos = this.nodePositions.get(targetId);
      if (targetPos?.visualHeight !== undefined) {
        const lastIdx = waypoints.length - 1;
        const lastWp = waypoints[lastIdx];
        const prevWp = waypoints[lastIdx - 1];
        if (lastWp && prevWp) {
          const nodeLeft = targetPos.x;
          const nodeRight = targetPos.x + targetPos.width;
          const visualBottom = targetPos.y + targetPos.visualHeight;
          const visualCenterY = targetPos.y + targetPos.visualHeight / 2;

          // Check if entering from left or right side (horizontal connection)
          if (Math.abs(lastWp.x - nodeLeft) < tolerance || Math.abs(lastWp.x - nodeRight) < tolerance) {
            const oldY = lastWp.y;
            const newY = visualCenterY;
            // Horizontal entry - adjust Y to visual center
            lastWp.y = newY;
            // If previous waypoint was on the same horizontal line, adjust it too to maintain horizontal segment
            // BUT only if previous waypoint is NOT the first waypoint (i.e., not connecting directly from source)
            if (Math.abs(prevWp.y - oldY) < tolerance && waypoints.length > 2) {
              prevWp.y = newY;
            }
          } else if (lastWp.y > visualBottom) {
            // Entering from below visual bottom - clamp to visual bottom
            lastWp.y = visualBottom;
          }
        }
      }
    }
  }

  /**
   * Calculate smart label position on the edge
   * Strategy:
   * 1. Find the longest segment of the edge (best visibility)
   * 2. Place label at the midpoint of that segment
   * 3. Offset based on segment direction, avoiding overlap with source/target nodes
   */
  private calculateSmartLabelPosition(
    waypoints: PointModel[],
    labelWidth: number,
    labelHeight: number,
    sourceId?: string,
    targetId?: string
  ): { x: number; y: number } {
    if (waypoints.length < 2) {
      return { x: 0, y: 0 };
    }

    // Get source and target node positions for collision avoidance
    const sourcePos = sourceId ? this.nodePositions.get(sourceId) : undefined;
    const targetPos = targetId ? this.nodePositions.get(targetId) : undefined;

    // Find the longest segment that is not too close to source/target
    let bestSegmentIndex = -1;
    let bestSegmentLength = 0;

    for (let i = 0; i < waypoints.length - 1; i++) {
      const wpCurrent = waypoints[i];
      const wpNext = waypoints[i + 1];
      if (!wpCurrent || !wpNext) continue;

      const segmentLength = distance(wpCurrent, wpNext);

      // Skip very short segments
      if (segmentLength < 30) continue;

      // Calculate segment midpoint
      const midX = (wpCurrent.x + wpNext.x) / 2;
      const midY = (wpCurrent.y + wpNext.y) / 2;

      // Check if midpoint is too close to source or target node
      const tooCloseToSource = sourcePos && this.isPointNearNode(midX, midY, sourcePos, 20);
      const tooCloseToTarget = targetPos && this.isPointNearNode(midX, midY, targetPos, 20);

      if (!tooCloseToSource && !tooCloseToTarget && segmentLength > bestSegmentLength) {
        bestSegmentLength = segmentLength;
        bestSegmentIndex = i;
      }
    }

    // If no good segment found, fall back to longest segment
    if (bestSegmentIndex < 0) {
      for (let i = 0; i < waypoints.length - 1; i++) {
        const wpCurrent = waypoints[i];
        const wpNext = waypoints[i + 1];
        if (!wpCurrent || !wpNext) continue;

        const segmentLength = distance(wpCurrent, wpNext);
        if (segmentLength > bestSegmentLength) {
          bestSegmentLength = segmentLength;
          bestSegmentIndex = i;
        }
      }
    }

    if (bestSegmentIndex < 0) {
      bestSegmentIndex = 0;
    }

    const wpStart = waypoints[bestSegmentIndex];
    const wpEnd = waypoints[bestSegmentIndex + 1];

    if (!wpStart || !wpEnd) {
      return { x: 0, y: 0 };
    }

    // Calculate midpoint of the chosen segment
    const midX = (wpStart.x + wpEnd.x) / 2;
    const midY = (wpStart.y + wpEnd.y) / 2;

    // Determine segment direction
    const dx = wpEnd.x - wpStart.x;
    const dy = wpEnd.y - wpStart.y;
    const isHorizontal = Math.abs(dx) > Math.abs(dy);
    const segmentLength = Math.sqrt(dx * dx + dy * dy);

    // Label offset from the edge line
    const offset = 5;

    if (isHorizontal) {
      // Horizontal segment - place label above the line by default
      let labelX = midX - labelWidth / 2;
      let labelY = midY - labelHeight - offset;

      // Check if label would overlap with any nearby node, if so place below
      const labelBounds = { x: labelX, y: labelY, width: labelWidth, height: labelHeight };
      if (this.labelOverlapsAnyNode(labelBounds)) {
        labelY = midY + offset;
      }

      return { x: labelX, y: labelY };
    } else {
      // Vertical segment - for long vertical segments (like message flows),
      // place label at various positions to avoid overlap with nodes AND other edge labels

      // For long segments (like message flows), try multiple positions
      // to find one that doesn't overlap with nodes or other labels
      const positions = segmentLength > 80
        ? [0.35, 0.5, 0.65, 0.2, 0.8, 0.15, 0.85]
        : [0.5];

      // Try each position with both right and left placement
      for (const ratio of positions) {
        const testY = wpStart.y + (wpEnd.y - wpStart.y) * ratio - labelHeight / 2;

        // Try right side
        const boundsRight = { x: midX + offset, y: testY, width: labelWidth, height: labelHeight };
        if (!this.labelOverlapsAnyNode(boundsRight) && !this.labelOverlapsAnyEdgeLabel(boundsRight)) {
          return { x: midX + offset, y: testY };
        }

        // Try left side
        const boundsLeft = { x: midX - labelWidth - offset, y: testY, width: labelWidth, height: labelHeight };
        if (!this.labelOverlapsAnyNode(boundsLeft) && !this.labelOverlapsAnyEdgeLabel(boundsLeft)) {
          return { x: midX - labelWidth - offset, y: testY };
        }
      }

      // Fallback: use midpoint, but offset Y if overlapping with other labels
      let labelX = midX + offset;
      let labelY = midY - labelHeight / 2;

      // If overlapping with existing label, try different Y offsets
      for (let yOffset = 0; yOffset <= 100; yOffset += 20) {
        for (const side of [1, -1]) { // right side, then left side
          for (const yDir of [0, 1, -1]) { // no offset, down, up
            const testX = side === 1 ? midX + offset : midX - labelWidth - offset;
            const testY = labelY + yDir * yOffset;
            const testBounds = { x: testX, y: testY, width: labelWidth, height: labelHeight };

            if (!this.labelOverlapsAnyEdgeLabel(testBounds)) {
              // Found a position that doesn't overlap with other labels
              // Check node overlap is secondary - we prefer no label overlap
              if (!this.labelOverlapsAnyNode(testBounds)) {
                return { x: testX, y: testY };
              }
              // Even if overlapping node, use this if no label overlap
              labelX = testX;
              labelY = testY;
            }
          }
        }
      }

      return { x: labelX, y: labelY };
    }
  }

  /**
   * Check if a point is near a node (within padding distance)
   */
  private isPointNearNode(
    x: number,
    y: number,
    nodePos: NodePosition,
    padding: number
  ): boolean {
    return (
      x >= nodePos.x - padding &&
      x <= nodePos.x + nodePos.width + padding &&
      y >= nodePos.y - padding &&
      y <= nodePos.y + nodePos.height + padding
    );
  }

  /**
   * Check if a label bounds overlaps with any node
   */
  private labelOverlapsAnyNode(labelBounds: { x: number; y: number; width: number; height: number }): boolean {
    for (const nodePos of this.nodePositions.values()) {
      if (this.boundsOverlap(labelBounds, nodePos)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a label bounds overlaps with any already placed edge label
   */
  private labelOverlapsAnyEdgeLabel(labelBounds: { x: number; y: number; width: number; height: number }): boolean {
    for (const placedLabel of this.placedEdgeLabels) {
      if (this.boundsOverlap(labelBounds, placedLabel)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if two rectangles overlap
   */
  private boundsOverlap(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number }
  ): boolean {
    return !(
      a.x + a.width < b.x ||
      b.x + b.width < a.x ||
      a.y + a.height < b.y ||
      b.y + b.height < a.y
    );
  }

  /**
   * Ensure all waypoint segments are orthogonal (horizontal or vertical)
   * If a diagonal segment is found, insert intermediate bend points to create
   * an L-shaped orthogonal path.
   *
   * Strategy: For diagonal segments, we use "horizontal first" - go horizontally
   * to the target X, then vertically to the target Y.
   */
  private ensureOrthogonalWaypoints(waypoints: PointModel[]): void {
    if (waypoints.length < 2) return;

    const tolerance = 1; // Allow 1px tolerance for floating point errors
    let i = 0;

    while (i < waypoints.length - 1) {
      const current = waypoints[i];
      const next = waypoints[i + 1];
      if (!current || !next) {
        i++;
        continue;
      }

      const dx = Math.abs(next.x - current.x);
      const dy = Math.abs(next.y - current.y);

      // Check if this segment is diagonal (both dx and dy are significant)
      if (dx > tolerance && dy > tolerance) {
        // Insert a bend point to make it orthogonal
        // Use "horizontal first" strategy: go to next.x first, then to next.y
        const bendPoint: PointModel = { x: next.x, y: current.y };
        waypoints.splice(i + 1, 0, bendPoint);
        // Don't increment i - we need to check the newly created segment
        // But the next iteration will check (current -> bendPoint) which is horizontal
        // So we can safely increment to check the next pair
        i++;
      } else {
        i++;
      }
    }
  }

  /**
   * Detect which side of a node a point is connected to.
   * Returns 'top', 'bottom', 'left', 'right', or 'unknown'.
   *
   * First tries exact match with tolerance, then falls back to closest edge detection.
   */
  private detectConnectionSide(
    point: PointModel,
    nodeBounds: NodePosition,
    _isGateway: boolean = false
  ): 'top' | 'bottom' | 'left' | 'right' | 'unknown' {
    const exactTolerance = 3;
    const maxTolerance = 15; // Maximum distance to consider for closest edge

    const nodeTop = nodeBounds.y;
    const nodeBottom = nodeBounds.y + nodeBounds.height;
    const nodeLeft = nodeBounds.x;
    const nodeRight = nodeBounds.x + nodeBounds.width;

    // For regular nodes, check rectangular edges
    // First, try exact match with small tolerance
    if (Math.abs(point.y - nodeTop) <= exactTolerance) return 'top';
    if (Math.abs(point.y - nodeBottom) <= exactTolerance) return 'bottom';
    if (Math.abs(point.x - nodeLeft) <= exactTolerance) return 'left';
    if (Math.abs(point.x - nodeRight) <= exactTolerance) return 'right';

    // If no exact match, find the closest edge
    const distToTop = Math.abs(point.y - nodeTop);
    const distToBottom = Math.abs(point.y - nodeBottom);
    const distToLeft = Math.abs(point.x - nodeLeft);
    const distToRight = Math.abs(point.x - nodeRight);

    const minDist = Math.min(distToTop, distToBottom, distToLeft, distToRight);

    // Only use closest edge if it's within reasonable distance
    if (minDist > maxTolerance) return 'unknown';

    // Return the closest edge
    if (minDist === distToTop) return 'top';
    if (minDist === distToBottom) return 'bottom';
    if (minDist === distToLeft) return 'left';
    return 'right';
  }

  /**
   * Detect connection side for gateway based on edge direction.
   * When point is on a diagonal edge of the diamond, use the adjacent point to determine direction.
   */
  private detectGatewayConnectionSide(
    point: PointModel,
    adjacentPoint: PointModel,
    nodeBounds: NodePosition,
    isSource: boolean
  ): 'top' | 'bottom' | 'left' | 'right' {
    const centerX = nodeBounds.x + nodeBounds.width / 2;
    const centerY = nodeBounds.y + nodeBounds.height / 2;
    const nodeTop = nodeBounds.y;
    const nodeBottom = nodeBounds.y + nodeBounds.height;
    const nodeLeft = nodeBounds.x;
    const nodeRight = nodeBounds.x + nodeBounds.width;

    // Calculate distances to each diamond corner
    const distToTopCorner = Math.abs(point.x - centerX) + Math.abs(point.y - nodeTop);
    const distToBottomCorner = Math.abs(point.x - centerX) + Math.abs(point.y - nodeBottom);
    const distToLeftCorner = Math.abs(point.x - nodeLeft) + Math.abs(point.y - centerY);
    const distToRightCorner = Math.abs(point.x - nodeRight) + Math.abs(point.y - centerY);

    const minDist = Math.min(distToTopCorner, distToBottomCorner, distToLeftCorner, distToRightCorner);

    // If clearly closest to one corner, use that
    const tolerance = 5;
    if (distToTopCorner <= minDist + tolerance && distToTopCorner < distToBottomCorner - tolerance &&
        distToTopCorner < distToLeftCorner - tolerance && distToTopCorner < distToRightCorner - tolerance) {
      return 'top';
    }
    if (distToBottomCorner <= minDist + tolerance && distToBottomCorner < distToTopCorner - tolerance &&
        distToBottomCorner < distToLeftCorner - tolerance && distToBottomCorner < distToRightCorner - tolerance) {
      return 'bottom';
    }
    if (distToLeftCorner <= minDist + tolerance && distToLeftCorner < distToTopCorner - tolerance &&
        distToLeftCorner < distToBottomCorner - tolerance && distToLeftCorner < distToRightCorner - tolerance) {
      return 'left';
    }
    if (distToRightCorner <= minDist + tolerance && distToRightCorner < distToTopCorner - tolerance &&
        distToRightCorner < distToBottomCorner - tolerance && distToRightCorner < distToLeftCorner - tolerance) {
      return 'right';
    }

    // Ambiguous case: use edge direction to decide
    // For source: look at direction TO adjacentPoint
    // For target: look at direction FROM adjacentPoint
    const dx = isSource ? (adjacentPoint.x - point.x) : (point.x - adjacentPoint.x);
    const dy = isSource ? (adjacentPoint.y - point.y) : (point.y - adjacentPoint.y);

    // If edge is more horizontal, prefer left/right connection
    // If edge is more vertical, prefer top/bottom connection
    if (Math.abs(dx) > Math.abs(dy)) {
      // Horizontal direction - use left or right
      return dx > 0 ? 'right' : 'left';
    } else {
      // Vertical direction - use top or bottom
      return dy > 0 ? 'bottom' : 'top';
    }
  }

  /**
   * Ensure edge endpoints connect perpendicular to node borders.
   * - Connection to top/bottom: last segment must be vertical (same x)
   * - Connection to left/right: last segment must be horizontal (same y)
   *
   * When inserting bend points, we also update the previous waypoint to maintain
   * orthogonality (no diagonal lines).
   */
  private ensurePerpendicularEndpoints(
    waypoints: PointModel[],
    sourceId: string | undefined,
    targetId: string | undefined,
    sourceIsGateway: boolean = false,
    targetIsGateway: boolean = false
  ): void {
    if (waypoints.length < 2) return;

    const tolerance = 2;
    const minBendOffset = 15; // Minimum distance for bend point from endpoint

    // Process target endpoint (end of edge)
    if (targetId) {
      const targetPos = this.nodePositions.get(targetId);
      if (targetPos) {
        const lastIdx = waypoints.length - 1;
        const endPoint = waypoints[lastIdx];
        const prevPoint = waypoints[lastIdx - 1];

        if (endPoint && prevPoint) {
          const side = targetIsGateway
            ? this.detectGatewayConnectionSide(endPoint, prevPoint, targetPos, false)
            : this.detectConnectionSide(endPoint, targetPos, false);

          if (side === 'top' || side === 'bottom') {
            // Vertical edge - last segment must be vertical (x should be same)
            if (Math.abs(endPoint.x - prevPoint.x) > tolerance) {
              // Need to insert a bend point to make it vertical
              // Calculate bend point Y position
              const bendY = side === 'top'
                ? endPoint.y - minBendOffset
                : endPoint.y + minBendOffset;

              // Insert bend point and update previous point to maintain orthogonality
              // Path: ... -> prevPoint -> bendPoint -> endPoint
              // bendPoint.x = endPoint.x (vertical final segment)
              // bendPoint.y = bendY
              // prevPoint needs to have y = bendY to make prevPoint->bendPoint horizontal
              const bendPoint: PointModel = { x: endPoint.x, y: bendY };
              waypoints.splice(lastIdx, 0, bendPoint);

              // Update prevPoint's y to match bendY for orthogonality
              prevPoint.y = bendY;
            }
          } else if (side === 'left' || side === 'right') {
            // Horizontal edge - last segment must be horizontal (y should be same)
            if (Math.abs(endPoint.y - prevPoint.y) > tolerance) {
              // Need to insert a bend point to make it horizontal
              const bendX = side === 'left'
                ? endPoint.x - minBendOffset
                : endPoint.x + minBendOffset;

              const bendPoint: PointModel = { x: bendX, y: endPoint.y };
              waypoints.splice(lastIdx, 0, bendPoint);

              // Update prevPoint's x to match bendX for orthogonality
              prevPoint.x = bendX;
            }
          }
        }
      }
    }

    // Process source endpoint (start of edge)
    if (sourceId) {
      // Check both nodePositions and boundaryEventPositions for source
      const sourcePos = this.nodePositions.get(sourceId) ?? this.boundaryEventPositions.get(sourceId);
      if (sourcePos) {
        const startPoint = waypoints[0];
        const nextPoint = waypoints[1];

        if (startPoint && nextPoint) {
          const side = sourceIsGateway
            ? this.detectGatewayConnectionSide(startPoint, nextPoint, sourcePos, true)
            : this.detectConnectionSide(startPoint, sourcePos, false);

          if (side === 'top' || side === 'bottom') {
            // Vertical edge - first segment must be vertical (x should be same)
            if (Math.abs(startPoint.x - nextPoint.x) > tolerance) {
              // Need to insert a bend point to make it vertical
              const bendY = side === 'top'
                ? startPoint.y - minBendOffset
                : startPoint.y + minBendOffset;

              const bendPoint: PointModel = { x: startPoint.x, y: bendY };
              waypoints.splice(1, 0, bendPoint);

              // Update nextPoint's y to match bendY for orthogonality
              nextPoint.y = bendY;
            }
          } else if (side === 'left' || side === 'right') {
            // Horizontal edge - first segment must be horizontal (y should be same)
            if (Math.abs(startPoint.y - nextPoint.y) > tolerance) {
              // Need to insert a bend point to make it horizontal
              const bendX = side === 'left'
                ? startPoint.x - minBendOffset
                : startPoint.x + minBendOffset;

              const bendPoint: PointModel = { x: bendX, y: startPoint.y };
              waypoints.splice(1, 0, bendPoint);

              // Update nextPoint's x to match bendX for orthogonality
              nextPoint.x = bendX;
            }
          }
        }
      }
    }
  }
}
