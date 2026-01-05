/**
 * Diagram Builder
 * Handles building the visual diagram (shapes and edges) from a layouted graph.
 * This module is responsible for converting layouted node positions into
 * BPMN DI (Diagram Interchange) format.
 */

import type { LayoutedGraph } from '../types/elk-output';
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

  /**
   * Build the diagram model from a layouted graph
   */
  build(graph: LayoutedGraph, definitions: DefinitionsModel): DiagramModel {
    // Reset all maps
    this.boundaryEventPositions.clear();
    this.nodePositions.clear();
    this.nodeOffsets.clear();
    this.nodeBpmn.clear();

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
  private storeNodeBpmn(nodeId: string, bpmn: NodeBpmnInfo): void {
    this.nodeBpmn.set(nodeId, bpmn);
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
    const totalLength = calculatePathLength(waypoints);
    const halfLength = totalLength / 2;

    // Walk along the path to find the midpoint
    let accumulatedLength = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const wpCurrent = waypoints[i];
      const wpNext = waypoints[i + 1];
      if (!wpCurrent || !wpNext) continue;
      const segmentLength = distance(wpCurrent, wpNext);
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
}
