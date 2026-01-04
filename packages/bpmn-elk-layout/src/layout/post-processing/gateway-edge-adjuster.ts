/**
 * Gateway Edge Adjuster
 * Adjusts edge endpoints that connect to gateways (diamond shapes).
 *
 * ELK calculates edge endpoints based on rectangular bounding boxes,
 * but gateways are diamond-shaped. This adjuster ensures edges connect
 * properly to the diamond's actual corners or edges.
 *
 * Gateway diamond has 4 corners:
 * - Left: (x, y + height/2)
 * - Top: (x + width/2, y)
 * - Right: (x + width, y + height/2)
 * - Bottom: (x + width/2, y + height)
 */

import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { Point, Bounds, NodeWithBpmn } from '../../types/internal';
import type { ElkBpmnGraph } from '../../types';
import { DEBUG } from '../../utils/debug';
import { distance, lineIntersection } from '../edge-routing/geometry-utils';

interface GatewayInfo {
  id: string;
  bounds: Bounds;
  corners: {
    left: Point;
    top: Point;
    right: Point;
    bottom: Point;
  };
}

/**
 * Handler for adjusting edge endpoints connecting to gateways
 */
export class GatewayEdgeAdjuster {
  /**
   * Adjust edges that connect to gateways
   * @param layoutedGraph - The ELK layouted graph (contains edge coordinates)
   * @param originalGraph - The original BPMN graph (contains bpmn metadata)
   */
  adjust(layoutedGraph: ElkNode, originalGraph: ElkBpmnGraph): void {
    // Collect all gateway positions from the layouted graph using original for type info
    const gateways = new Map<string, GatewayInfo>();

    this.collectGateways(layoutedGraph, originalGraph, gateways, 0, 0);

    if (gateways.size === 0) return;

    if (DEBUG) {
      console.log(`[BPMN] GatewayEdgeAdjuster: Found ${gateways.size} gateways`);
      for (const [id, info] of gateways) {
        console.log(`[BPMN]   - ${id}: bounds=(${info.bounds.x},${info.bounds.y},${info.bounds.width},${info.bounds.height})`);
      }
    }

    // Process all edges and adjust endpoints
    this.processEdges(layoutedGraph, originalGraph, gateways, 0, 0);
  }

  /**
   * Collect all gateway nodes and calculate their diamond corners
   * Uses originalGraph for BPMN type info and layoutedGraph for positions
   */
  private collectGateways(
    layoutedNode: ElkNode,
    originalNode: ElkBpmnGraph | NodeWithBpmn,
    gateways: Map<string, GatewayInfo>,
    offsetX: number,
    offsetY: number
  ): void {
    const bpmn = (originalNode as NodeWithBpmn).bpmn;

    // Check if this node is a gateway
    if (this.isGateway(bpmn?.type)) {
      const x = offsetX + (layoutedNode.x ?? 0);
      const y = offsetY + (layoutedNode.y ?? 0);
      const width = layoutedNode.width ?? 50;
      const height = layoutedNode.height ?? 50;

      gateways.set(layoutedNode.id, {
        id: layoutedNode.id,
        bounds: { x, y, width, height },
        corners: {
          left: { x: x, y: y + height / 2 },
          top: { x: x + width / 2, y: y },
          right: { x: x + width, y: y + height / 2 },
          bottom: { x: x + width / 2, y: y + height },
        },
      });
    }

    // Process children with accumulated offset
    if (layoutedNode.children && originalNode.children) {
      const isContainer = this.isContainer(bpmn?.type);
      const newOffsetX = isContainer ? offsetX + (layoutedNode.x ?? 0) : offsetX;
      const newOffsetY = isContainer ? offsetY + (layoutedNode.y ?? 0) : offsetY;

      // Create a map of original children by id for lookup
      const originalChildMap = new Map<string, NodeWithBpmn>();
      for (const child of originalNode.children) {
        const childNode = child as NodeWithBpmn;
        if (childNode.id) {
          originalChildMap.set(childNode.id, childNode);
        }
      }

      for (const layoutedChild of layoutedNode.children) {
        const originalChild = originalChildMap.get(layoutedChild.id);
        if (originalChild) {
          this.collectGateways(layoutedChild, originalChild, gateways, newOffsetX, newOffsetY);
        }
      }
    }
  }

  /**
   * Process all edges and adjust endpoints connecting to gateways
   */
  private processEdges(
    layoutedNode: ElkNode,
    originalNode: ElkBpmnGraph | NodeWithBpmn,
    gateways: Map<string, GatewayInfo>,
    offsetX: number,
    offsetY: number
  ): void {
    const bpmn = (originalNode as NodeWithBpmn).bpmn;

    if (layoutedNode.edges) {
      for (const edge of layoutedNode.edges) {
        if (edge.sections && edge.sections.length > 0) {
          this.adjustEdgeEndpoints(edge, gateways, offsetX, offsetY);
        }
      }
    }

    // Process children
    if (layoutedNode.children && originalNode.children) {
      const isContainer = this.isContainer(bpmn?.type);
      const newOffsetX = isContainer ? offsetX + (layoutedNode.x ?? 0) : offsetX;
      const newOffsetY = isContainer ? offsetY + (layoutedNode.y ?? 0) : offsetY;

      // Create a map of original children by id for lookup
      const originalChildMap = new Map<string, NodeWithBpmn>();
      for (const child of originalNode.children) {
        const childNode = child as NodeWithBpmn;
        if (childNode.id) {
          originalChildMap.set(childNode.id, childNode);
        }
      }

      for (const layoutedChild of layoutedNode.children) {
        const originalChild = originalChildMap.get(layoutedChild.id);
        if (originalChild) {
          this.processEdges(layoutedChild, originalChild, gateways, newOffsetX, newOffsetY);
        }
      }
    }
  }

  /**
   * Adjust edge endpoints if they connect to a gateway
   */
  private adjustEdgeEndpoints(
    edge: ElkExtendedEdge,
    gateways: Map<string, GatewayInfo>,
    offsetX: number,
    offsetY: number
  ): void {
    const section = edge.sections![0];
    const sourceId = edge.sources?.[0];
    const targetId = edge.targets?.[0];

    if (DEBUG) {
      console.log(`[BPMN] GatewayEdgeAdjuster: Processing edge ${edge.id}, offset=(${offsetX},${offsetY})`);
      console.log(`[BPMN]   sourceId=${sourceId}, targetId=${targetId}`);
      console.log(`[BPMN]   startPoint=(${section.startPoint.x},${section.startPoint.y}), endPoint=(${section.endPoint.x},${section.endPoint.y})`);
      console.log(`[BPMN]   available gateways: ${Array.from(gateways.keys()).join(', ')}`);
    }

    // Check if source is a gateway
    const sourceGateway = sourceId ? gateways.get(sourceId) : undefined;
    if (sourceGateway) {
      this.adjustStartPoint(section, sourceGateway, offsetX, offsetY);
    }

    // Check if target is a gateway
    const targetGateway = targetId ? gateways.get(targetId) : undefined;
    if (targetGateway) {
      if (DEBUG) {
        console.log(`[BPMN]   target gateway: ${targetId}, bounds=(${targetGateway.bounds.x},${targetGateway.bounds.y})`);
        console.log(`[BPMN]   left corner: (${targetGateway.corners.left.x},${targetGateway.corners.left.y})`);
      }
      this.adjustEndPoint(edge, section, targetGateway, offsetX, offsetY);
    }
  }

  /**
   * Adjust the start point of an edge leaving a gateway
   */
  private adjustStartPoint(
    section: NonNullable<ElkExtendedEdge['sections']>[0],
    gateway: GatewayInfo,
    offsetX: number,
    offsetY: number
  ): void {
    const startX = offsetX + section.startPoint.x;
    const startY = offsetY + section.startPoint.y;

    // Find which corner is closest to the current start point
    const corner = this.findClosestCorner(
      { x: startX, y: startY },
      gateway
    );

    // Adjust start point to the corner
    section.startPoint = {
      x: corner.x - offsetX,
      y: corner.y - offsetY,
    };

    // If there are bend points, adjust the first one to maintain orthogonal routing
    if (section.bendPoints && section.bendPoints.length > 0) {
      const firstBend = section.bendPoints[0];
      const adjustedStart = section.startPoint;

      // Check if we need to adjust the bend point for orthogonal routing
      if (Math.abs((offsetX + firstBend.x) - corner.x) < 20) {
        // Bend point is roughly aligned horizontally with corner
        firstBend.x = adjustedStart.x;
      } else if (Math.abs((offsetY + firstBend.y) - corner.y) < 20) {
        // Bend point is roughly aligned vertically with corner
        firstBend.y = adjustedStart.y;
      }
    }
  }

  /**
   * Adjust the end point of an edge entering a gateway
   */
  private adjustEndPoint(
    edge: ElkExtendedEdge,
    section: NonNullable<ElkExtendedEdge['sections']>[0],
    gateway: GatewayInfo,
    offsetX: number,
    offsetY: number
  ): void {
    const endX = offsetX + section.endPoint.x;
    const endY = offsetY + section.endPoint.y;

    // Determine approach direction from the previous point
    let prevPoint: Point;
    if (section.bendPoints && section.bendPoints.length > 0) {
      const lastBend = section.bendPoints[section.bendPoints.length - 1];
      prevPoint = { x: offsetX + lastBend.x, y: offsetY + lastBend.y };
    } else {
      prevPoint = { x: offsetX + section.startPoint.x, y: offsetY + section.startPoint.y };
    }

    // Calculate the approach direction
    const dx = endX - prevPoint.x;
    const dy = endY - prevPoint.y;

    // Determine which corner to use based on approach direction
    let targetCorner: Point;

    if (Math.abs(dx) > Math.abs(dy)) {
      // Horizontal approach - use left or right corner
      targetCorner = dx > 0 ? gateway.corners.left : gateway.corners.right;
    } else {
      // Vertical approach - use top or bottom corner
      targetCorner = dy > 0 ? gateway.corners.top : gateway.corners.bottom;
    }

    // Check if the endpoint is significantly off from the target corner
    const distToCorner = Math.sqrt(
      Math.pow(endX - targetCorner.x, 2) +
      Math.pow(endY - targetCorner.y, 2)
    );

    // If endpoint is close to a corner, snap to it
    if (distToCorner < 30) {
      const oldEndX = section.endPoint.x;
      const oldEndY = section.endPoint.y;

      section.endPoint = {
        x: targetCorner.x - offsetX,
        y: targetCorner.y - offsetY,
      };

      // Adjust the last bend point to maintain orthogonal routing
      if (section.bendPoints && section.bendPoints.length > 0) {
        const lastBend = section.bendPoints[section.bendPoints.length - 1];
        const newEnd = section.endPoint;

        // Check if last segment was horizontal
        if (Math.abs((offsetY + lastBend.y) - (offsetY + oldEndY)) < 5) {
          // Was horizontal, keep it horizontal to the new endpoint
          lastBend.y = newEnd.y;
        }
        // Check if last segment was vertical
        else if (Math.abs((offsetX + lastBend.x) - (offsetX + oldEndX)) < 5) {
          // Was vertical, keep it vertical to the new endpoint
          lastBend.x = newEnd.x;
        }
      }

      if (DEBUG) {
        console.log(`[BPMN] GatewayEdgeAdjuster: Adjusted edge ${edge.id} endpoint from (${endX},${endY}) to (${targetCorner.x},${targetCorner.y})`);
      }
    } else {
      // Endpoint is far from any corner - might need more complex routing
      // Try to find intersection with diamond edge
      const intersectionPoint = this.findDiamondIntersection(
        prevPoint,
        { x: endX, y: endY },
        gateway
      );

      if (intersectionPoint) {
        section.endPoint = {
          x: intersectionPoint.x - offsetX,
          y: intersectionPoint.y - offsetY,
        };

        if (DEBUG) {
          console.log(`[BPMN] GatewayEdgeAdjuster: Adjusted edge ${edge.id} endpoint to diamond intersection (${intersectionPoint.x},${intersectionPoint.y})`);
        }
      }
    }
  }

  /**
   * Find the closest corner of a gateway to a given point
   */
  private findClosestCorner(point: Point, gateway: GatewayInfo): Point {
    const corners = [
      gateway.corners.left,
      gateway.corners.top,
      gateway.corners.right,
      gateway.corners.bottom,
    ];

    let closest = corners[0];
    let minDist = distance(point, closest);

    for (let i = 1; i < corners.length; i++) {
      const dist = distance(point, corners[i]);
      if (dist < minDist) {
        minDist = dist;
        closest = corners[i];
      }
    }

    return closest;
  }

  /**
   * Find intersection point between a line segment and the diamond edges
   */
  private findDiamondIntersection(
    from: Point,
    to: Point,
    gateway: GatewayInfo
  ): Point | null {
    const { corners } = gateway;

    // Diamond edges
    const edges: [Point, Point][] = [
      [corners.left, corners.top],     // top-left edge
      [corners.top, corners.right],    // top-right edge
      [corners.right, corners.bottom], // bottom-right edge
      [corners.bottom, corners.left],  // bottom-left edge
    ];

    // Find intersection with each edge
    for (const [p1, p2] of edges) {
      const intersection = lineIntersection(from, to, p1, p2);
      if (intersection) {
        return intersection;
      }
    }

    return null;
  }

  /**
   * Check if a BPMN type is a gateway
   */
  private isGateway(type?: string): boolean {
    if (!type) return false;
    return [
      'exclusiveGateway',
      'parallelGateway',
      'inclusiveGateway',
      'eventBasedGateway',
      'complexGateway',
    ].includes(type);
  }

  /**
   * Check if a BPMN type is a container
   */
  private isContainer(type?: string): boolean {
    if (!type) return false;
    return [
      'lane',
      'participant',
      'collaboration',
      'process',
      'subProcess',
      'transaction',
      'adHocSubProcess',
      'eventSubProcess',
    ].includes(type);
  }
}
