/**
 * ELK Layout Engine Wrapper
 */

import ELK from 'elkjs';
import type { ElkNode, ElkExtendedEdge, LayoutOptions } from 'elkjs';
import type { ElkBpmnGraph, ElkLayoutOptions } from '../types';
import type { LayoutedGraph } from '../types/elk-output';
import { mergeElkOptions } from './default-options';
import { applyDefaultSizesToGraph } from './size-defaults';

// Debug flag for layout logging
const DEBUG = typeof process !== 'undefined' && process.env?.DEBUG === 'true';

export interface ElkLayouterOptions {
  elkOptions?: ElkLayoutOptions;
}

export class ElkLayouter {
  private elk: ELK;
  private userOptions: ElkLayoutOptions;

  constructor(options?: ElkLayouterOptions) {
    this.elk = new ELK();
    this.userOptions = options?.elkOptions ?? {};
  }

  /**
   * Run ELK layout on the graph
   */
  async layout(graph: ElkBpmnGraph): Promise<LayoutedGraph> {
    // Deep clone to avoid mutating the original
    const graphCopy = JSON.parse(JSON.stringify(graph)) as ElkBpmnGraph;

    // Apply default sizes to all nodes
    const sizedGraph = this.applyDefaultSizes(graphCopy);

    // Collect boundary event info for post-processing
    const boundaryEventInfo = this.collectBoundaryEventInfo(sizedGraph);

    // Collect artifact association info for post-processing
    const artifactInfo = this.collectArtifactInfo(sizedGraph);

    // Collect Group info for post-processing (Groups will be repositioned after layout)
    const groupInfo = this.collectGroupInfo(sizedGraph);

    // Prepare graph for ELK (convert to ELK format)
    const elkGraph = this.prepareForElk(sizedGraph);

    // Run ELK layout
    let layoutedElkGraph = await this.elk.layout(elkGraph);

    // Check if boundary event targets need repositioning
    const movedNodes = this.identifyNodesToMove(layoutedElkGraph, boundaryEventInfo);

    if (movedNodes.size > 0) {
      // Move nodes and recalculate affected edges
      this.applyNodeMoves(layoutedElkGraph, movedNodes);
      this.recalculateEdgesForMovedNodes(layoutedElkGraph, movedNodes, boundaryEventInfo);
    }

    // Reposition artifacts (data objects, data stores, annotations) to be near their associated tasks
    this.repositionArtifacts(layoutedElkGraph, artifactInfo);

    // Rearrange lanes to stack vertically within pools (ELK's partitioning doesn't do this correctly)
    this.rearrangeLanes(layoutedElkGraph, sizedGraph);

    // Rearrange pools to stack vertically within collaborations
    this.rearrangePools(layoutedElkGraph, sizedGraph);

    // Reposition Groups to surround their grouped elements
    this.repositionGroups(layoutedElkGraph, groupInfo, sizedGraph);

    // Recalculate artifact edges with obstacle avoidance
    this.recalculateArtifactEdgesWithObstacleAvoidance(layoutedElkGraph, artifactInfo);

    // Fix edges that cross through nodes (especially return edges in complex flows)
    this.fixEdgesCrossingNodes(layoutedElkGraph);

    // Merge layout results back with BPMN metadata
    return this.mergeLayoutResults(sizedGraph, layoutedElkGraph);
  }

  /**
   * Collect boundary event information for post-processing
   * Returns a map of boundary event ID -> { attachedToRef, targets: string[], boundaryIndex, totalBoundaries }
   */
  private collectBoundaryEventInfo(graph: ElkBpmnGraph): Map<string, { attachedToRef: string; targets: string[]; boundaryIndex: number; totalBoundaries: number }> {
    const info = new Map<string, { attachedToRef: string; targets: string[]; boundaryIndex: number; totalBoundaries: number }>();
    const edgeMap = new Map<string, string[]>(); // source -> targets

    // First pass: collect all edges by source
    const collectEdges = (node: NodeWithBpmn) => {
      if (node.edges) {
        for (const edge of node.edges) {
          const source = edge.sources[0];
          if (!edgeMap.has(source)) {
            edgeMap.set(source, []);
          }
          edgeMap.get(source)!.push(edge.targets[0]);
        }
      }
      if (node.children) {
        for (const child of node.children) {
          collectEdges(child as NodeWithBpmn);
        }
      }
    };

    // Second pass: collect boundary events and their targets
    const collectBoundaryEvents = (node: NodeWithBpmn) => {
      if (node.boundaryEvents) {
        const totalBoundaries = node.boundaryEvents.length;
        node.boundaryEvents.forEach((be, index) => {
          const targets = edgeMap.get(be.id) || [];
          info.set(be.id, {
            attachedToRef: be.attachedToRef,
            targets,
            boundaryIndex: index,
            totalBoundaries,
          });
        });
      }
      if (node.children) {
        for (const child of node.children) {
          collectBoundaryEvents(child as NodeWithBpmn);
        }
      }
    };

    for (const child of graph.children ?? []) {
      collectEdges(child as NodeWithBpmn);
      collectBoundaryEvents(child as NodeWithBpmn);
    }

    return info;
  }

  /**
   * Artifact types that should be repositioned above their associated tasks
   */
  private static ARTIFACT_TYPES = new Set([
    'dataObject',
    'dataObjectReference',
    'dataStoreReference',
    'dataInput',
    'dataOutput',
    'textAnnotation',
  ]);

  /**
   * Group type - should not participate in ELK layout
   */
  private static GROUP_TYPE = 'group';

  /**
   * Collect Group information for post-processing
   * Returns a map of group ID -> { groupedElements, padding, name }
   */
  private collectGroupInfo(graph: ElkBpmnGraph): Map<string, { groupedElements: string[]; padding: number; name?: string; parentId: string }> {
    const info = new Map<string, { groupedElements: string[]; padding: number; name?: string; parentId: string }>();

    const collectFromNode = (node: NodeWithBpmn, parentId: string) => {
      if (node.children) {
        for (const child of node.children) {
          const childNode = child as NodeWithBpmn;
          if (childNode.bpmn?.type === ElkLayouter.GROUP_TYPE) {
            const bpmn = childNode.bpmn as { groupedElements?: string[]; padding?: number; name?: string };
            info.set(childNode.id, {
              groupedElements: bpmn.groupedElements ?? [],
              padding: bpmn.padding ?? 20,
              name: bpmn.name,
              parentId,
            });
          }
          // Recurse into children
          collectFromNode(childNode, childNode.id);
        }
      }
    };

    for (const child of graph.children ?? []) {
      collectFromNode(child as NodeWithBpmn, (child as NodeWithBpmn).id);
    }

    return info;
  }

  /**
   * Collect artifact information for post-processing
   * Returns a map of artifact ID -> associated task ID
   */
  private collectArtifactInfo(graph: ElkBpmnGraph): Map<string, { associatedTaskId: string; isInput: boolean }> {
    const info = new Map<string, { associatedTaskId: string; isInput: boolean }>();

    const collectFromNode = (node: NodeWithBpmn) => {
      // Build a set of artifact IDs in this node
      const artifactIds = new Set<string>();
      if (node.children) {
        for (const child of node.children) {
          const childNode = child as NodeWithBpmn;
          if (childNode.bpmn && ElkLayouter.ARTIFACT_TYPES.has(childNode.bpmn.type)) {
            artifactIds.add(childNode.id);
          }
        }
      }

      // Find associations between artifacts and tasks from edges
      if (node.edges) {
        for (const edge of node.edges) {
          const sourceId = edge.sources[0];
          const targetId = edge.targets[0];
          const edgeType = (edge as { bpmn?: { type?: string } }).bpmn?.type;

          // Data input association: artifact -> task
          if (edgeType === 'dataInputAssociation' || edgeType === 'association') {
            if (artifactIds.has(sourceId)) {
              info.set(sourceId, { associatedTaskId: targetId, isInput: true });
            }
          }
          // Data output association: task -> artifact
          if (edgeType === 'dataOutputAssociation') {
            if (artifactIds.has(targetId)) {
              info.set(targetId, { associatedTaskId: sourceId, isInput: false });
            }
          }
        }
      }

      // Recurse into children
      if (node.children) {
        for (const child of node.children) {
          collectFromNode(child as NodeWithBpmn);
        }
      }
    };

    for (const child of graph.children ?? []) {
      collectFromNode(child as NodeWithBpmn);
    }

    return info;
  }

  /**
   * Reposition artifacts to be above their associated tasks
   */
  private repositionArtifacts(
    graph: ElkNode,
    artifactInfo: Map<string, { associatedTaskId: string; isInput: boolean }>
  ): void {
    // Build node map
    const nodeMap = new Map<string, ElkNode>();
    const buildNodeMap = (node: ElkNode) => {
      nodeMap.set(node.id, node);
      if (node.children) {
        for (const child of node.children) {
          buildNodeMap(child);
        }
      }
    };
    buildNodeMap(graph);

    // Track horizontal offset for each task (for multiple artifacts)
    const taskInputOffsets = new Map<string, number>();
    const taskOutputOffsets = new Map<string, number>();

    // Reposition each artifact
    for (const [artifactId, info] of artifactInfo) {
      const artifactNode = nodeMap.get(artifactId);
      const taskNode = nodeMap.get(info.associatedTaskId);

      if (!artifactNode || !taskNode) continue;
      if (taskNode.x === undefined || taskNode.y === undefined) continue;

      const artifactWidth = artifactNode.width ?? 36;
      const artifactHeight = artifactNode.height ?? 50;
      const taskWidth = taskNode.width ?? 100;

      // Position artifact above the task
      // Input artifacts on the left, output artifacts on the right
      let newX: number;
      if (info.isInput) {
        const currentOffset = taskInputOffsets.get(info.associatedTaskId) ?? 0;
        newX = taskNode.x + currentOffset;
        taskInputOffsets.set(info.associatedTaskId, currentOffset + artifactWidth + 15);
      } else {
        const currentOffset = taskOutputOffsets.get(info.associatedTaskId) ?? 0;
        newX = taskNode.x + taskWidth + 15 + currentOffset; // Position to the right of task
        taskOutputOffsets.set(info.associatedTaskId, currentOffset + artifactWidth + 15);
      }
      const newY = taskNode.y - artifactHeight - 20; // 20px gap above task

      artifactNode.x = newX;
      artifactNode.y = newY;
    }

    // Recalculate edges for repositioned artifacts
    this.recalculateArtifactEdges(graph, artifactInfo, nodeMap);
  }

  /**
   * Recalculate edges connected to repositioned artifacts
   */
  private recalculateArtifactEdges(
    graph: ElkNode,
    artifactInfo: Map<string, { associatedTaskId: string; isInput: boolean }>,
    nodeMap: Map<string, ElkNode>
  ): void {
    const processEdges = (node: ElkNode) => {
      if (node.edges) {
        for (const edge of node.edges) {
          const sourceId = edge.sources?.[0];
          const targetId = edge.targets?.[0];

          // Check if this edge involves an artifact
          const sourceIsArtifact = artifactInfo.has(sourceId);
          const targetIsArtifact = artifactInfo.has(targetId);

          if (sourceIsArtifact || targetIsArtifact) {
            const sourceNode = nodeMap.get(sourceId);
            const targetNode = nodeMap.get(targetId);

            if (sourceNode && targetNode) {
              this.recalculateArtifactEdge(edge, sourceNode, targetNode, sourceIsArtifact);
            }
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          processEdges(child);
        }
      }
    };
    processEdges(graph);
  }

  /**
   * Recalculate a single artifact edge (simple version - will be replaced by obstacle avoidance)
   */
  private recalculateArtifactEdge(
    edge: ElkExtendedEdge,
    source: ElkNode,
    target: ElkNode,
    sourceIsArtifact: boolean
  ): void {
    const sx = source.x ?? 0;
    const sy = source.y ?? 0;
    const sw = source.width ?? 36;
    const sh = source.height ?? 50;

    const tx = target.x ?? 0;
    const ty = target.y ?? 0;
    const tw = target.width ?? 100;
    const th = target.height ?? 80;

    let startPoint: { x: number; y: number };
    let endPoint: { x: number; y: number };

    if (sourceIsArtifact) {
      // Artifact -> Task (input): artifact is above/left of task
      // Start from bottom of artifact, end at top of task
      startPoint = { x: sx + sw / 2, y: sy + sh };
      endPoint = { x: Math.min(Math.max(sx + sw / 2, tx), tx + tw), y: ty };
    } else {
      // Task -> Artifact (output): artifact is above/right of task
      // Start from top-right of task, end at bottom of artifact
      const artifactCenterX = tx + tw / 2;
      startPoint = { x: Math.min(sx + sw, artifactCenterX), y: sy };
      endPoint = { x: artifactCenterX, y: ty + th };
    }

    edge.sections = [{
      id: `${edge.id}_section_0`,
      startPoint,
      endPoint,
      bendPoints: [],
    }];
  }

  /**
   * Remove Groups from the graph before ELK layout
   * Groups will be repositioned after layout based on their grouped elements
   */
  private removeGroupsFromGraph(
    graph: ElkBpmnGraph,
    groupInfo: Map<string, { groupedElements: string[]; padding: number; name?: string; parentId: string }>
  ): void {
    const groupIds = new Set(groupInfo.keys());

    const removeFromNode = (node: NodeWithBpmn) => {
      if (node.children) {
        node.children = node.children.filter((child) => {
          const childNode = child as NodeWithBpmn;
          return !groupIds.has(childNode.id);
        });

        // Recurse into remaining children
        for (const child of node.children) {
          removeFromNode(child as NodeWithBpmn);
        }
      }

      // Also remove edges that connect to groups
      if (node.edges) {
        node.edges = node.edges.filter((edge) => {
          const sourceId = edge.sources[0];
          const targetId = edge.targets[0];
          return !groupIds.has(sourceId) && !groupIds.has(targetId);
        });
      }
    };

    for (const child of graph.children ?? []) {
      removeFromNode(child as NodeWithBpmn);
    }
  }

  /**
   * Reposition Groups to surround their grouped elements
   * Modifies existing Group nodes in the layouted graph
   */
  private repositionGroups(
    graph: ElkNode,
    groupInfo: Map<string, { groupedElements: string[]; padding: number; name?: string; parentId: string }>,
    originalGraph: ElkBpmnGraph
  ): void {
    if (groupInfo.size === 0) return;

    // Build node map for position lookups
    const nodeMap = new Map<string, ElkNode>();
    const parentMap = new Map<string, ElkNode>(); // node id -> parent container

    const buildNodeMap = (node: ElkNode, parent?: ElkNode) => {
      nodeMap.set(node.id, node);
      if (parent) {
        parentMap.set(node.id, parent);
      }
      if (node.children) {
        for (const child of node.children) {
          buildNodeMap(child, node);
        }
      }
    };
    buildNodeMap(graph);

    // Process each group
    for (const [groupId, info] of groupInfo) {
      // Find the existing group node in the layouted graph
      const groupNode = nodeMap.get(groupId);
      if (!groupNode) continue;

      // If no grouped elements specified, keep the ELK-calculated position
      if (info.groupedElements.length === 0) continue;

      // Calculate bounding box of grouped elements
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      for (const elementId of info.groupedElements) {
        const elementNode = nodeMap.get(elementId);
        if (!elementNode || elementNode.x === undefined || elementNode.y === undefined) continue;

        // Get position of the element relative to the same parent container as the group
        // Elements might be nested in lanes, so we need to traverse up to the group's parent
        let absX = elementNode.x ?? 0;
        let absY = elementNode.y ?? 0;
        let currentParent = parentMap.get(elementId);
        const groupParent = parentMap.get(groupId);

        // Traverse up to find common ancestor or group's parent
        while (currentParent && currentParent !== groupParent && currentParent.id !== info.parentId) {
          absX += currentParent.x ?? 0;
          absY += currentParent.y ?? 0;
          currentParent = parentMap.get(currentParent.id);
        }

        const w = elementNode.width ?? 100;
        const h = elementNode.height ?? 80;

        minX = Math.min(minX, absX);
        minY = Math.min(minY, absY);
        maxX = Math.max(maxX, absX + w);
        maxY = Math.max(maxY, absY + h);
      }

      // Check if we found any valid elements
      if (minX === Infinity) continue;

      // Add padding
      const padding = info.padding;
      minX -= padding;
      minY -= padding;
      maxX += padding;
      maxY += padding;

      // Update the group node's position and size
      groupNode.x = minX;
      groupNode.y = minY;
      groupNode.width = maxX - minX;
      groupNode.height = maxY - minY;
    }
  }

  /**
   * Recalculate artifact edges with obstacle avoidance
   * Implements orthogonal routing that avoids crossing other elements
   */
  private recalculateArtifactEdgesWithObstacleAvoidance(
    graph: ElkNode,
    artifactInfo: Map<string, { associatedTaskId: string; isInput: boolean }>
  ): void {
    // Build node map for position lookups
    const nodeMap = new Map<string, ElkNode>();
    const buildNodeMap = (node: ElkNode) => {
      nodeMap.set(node.id, node);
      if (node.children) {
        for (const child of node.children) {
          buildNodeMap(child);
        }
      }
    };
    buildNodeMap(graph);

    // Collect all obstacles (non-artifact nodes)
    const obstacles: Array<{ x: number; y: number; width: number; height: number; id: string }> = [];
    const collectObstacles = (node: ElkNode) => {
      if (node.x !== undefined && node.y !== undefined && !artifactInfo.has(node.id)) {
        // Skip groups (they're just visual overlays)
        const isGroup = node.id.includes('group');
        if (!isGroup) {
          obstacles.push({
            x: node.x,
            y: node.y,
            width: node.width ?? 100,
            height: node.height ?? 80,
            id: node.id,
          });
        }
      }
      if (node.children) {
        for (const child of node.children) {
          collectObstacles(child);
        }
      }
    };
    collectObstacles(graph);

    // Process edges
    const processEdges = (node: ElkNode) => {
      if (node.edges) {
        for (const edge of node.edges) {
          const sourceId = edge.sources?.[0];
          const targetId = edge.targets?.[0];

          // Check if this edge involves an artifact
          const sourceIsArtifact = artifactInfo.has(sourceId);
          const targetIsArtifact = artifactInfo.has(targetId);

          if (sourceIsArtifact || targetIsArtifact) {
            const sourceNode = nodeMap.get(sourceId);
            const targetNode = nodeMap.get(targetId);

            if (sourceNode && targetNode) {
              this.recalculateArtifactEdgeWithObstacles(
                edge,
                sourceNode,
                targetNode,
                sourceIsArtifact,
                obstacles.filter(o => o.id !== sourceId && o.id !== targetId)
              );
            }
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          processEdges(child);
        }
      }
    };
    processEdges(graph);
  }

  /**
   * Recalculate a single artifact edge with orthogonal routing and obstacle avoidance
   */
  private recalculateArtifactEdgeWithObstacles(
    edge: ElkExtendedEdge,
    source: ElkNode,
    target: ElkNode,
    sourceIsArtifact: boolean,
    obstacles: Array<{ x: number; y: number; width: number; height: number; id: string }>
  ): void {
    const sx = source.x ?? 0;
    const sy = source.y ?? 0;
    const sw = source.width ?? 36;
    const sh = source.height ?? 50;

    const tx = target.x ?? 0;
    const ty = target.y ?? 0;
    const tw = target.width ?? 100;
    const th = target.height ?? 80;

    // Determine connection points based on relative positions
    let startPoint: { x: number; y: number };
    let endPoint: { x: number; y: number };
    const bendPoints: Array<{ x: number; y: number }> = [];

    const sourceCenterX = sx + sw / 2;
    const sourceCenterY = sy + sh / 2;
    const targetCenterX = tx + tw / 2;
    const targetCenterY = ty + th / 2;

    // Determine if we're going up, down, left, or right
    const goingRight = targetCenterX > sourceCenterX + sw / 2;
    const goingLeft = targetCenterX < sourceCenterX - sw / 2;
    const goingDown = targetCenterY > sourceCenterY + sh / 2;
    const goingUp = targetCenterY < sourceCenterY - sh / 2;

    if (sourceIsArtifact) {
      // Artifact is source (data input association: artifact -> task)
      if (goingDown) {
        // Source above target: exit from bottom, enter from top
        startPoint = { x: sourceCenterX, y: sy + sh };
        endPoint = { x: targetCenterX, y: ty };

        // Check for obstacles and route around them
        const routeY = this.findClearVerticalPath(startPoint.x, startPoint.y, endPoint.y, obstacles);
        if (Math.abs(startPoint.x - endPoint.x) > 5 || routeY !== null) {
          if (routeY !== null && routeY !== startPoint.y && routeY !== endPoint.y) {
            bendPoints.push({ x: startPoint.x, y: routeY });
            bendPoints.push({ x: endPoint.x, y: routeY });
          } else {
            // Simple L-shaped routing
            const midY = (startPoint.y + endPoint.y) / 2;
            bendPoints.push({ x: startPoint.x, y: midY });
            bendPoints.push({ x: endPoint.x, y: midY });
          }
        }
      } else if (goingUp) {
        // Source below target: exit from top, enter from bottom
        startPoint = { x: sourceCenterX, y: sy };
        endPoint = { x: targetCenterX, y: ty + th };

        const midY = (startPoint.y + endPoint.y) / 2;
        if (Math.abs(startPoint.x - endPoint.x) > 5) {
          bendPoints.push({ x: startPoint.x, y: midY });
          bendPoints.push({ x: endPoint.x, y: midY });
        }
      } else if (goingRight) {
        // Source left of target: exit from right, enter from left
        startPoint = { x: sx + sw, y: sourceCenterY };
        endPoint = { x: tx, y: targetCenterY };

        // Route with obstacle avoidance
        this.addOrthogonalBendPoints(startPoint, endPoint, bendPoints, obstacles, 'horizontal');
      } else {
        // Source right of target: exit from left, enter from right
        startPoint = { x: sx, y: sourceCenterY };
        endPoint = { x: tx + tw, y: targetCenterY };

        this.addOrthogonalBendPoints(startPoint, endPoint, bendPoints, obstacles, 'horizontal');
      }
    } else {
      // Task is source (data output association: task -> artifact)
      if (goingUp) {
        // Target above source: exit from top, enter from bottom
        startPoint = { x: sourceCenterX, y: sy };
        endPoint = { x: targetCenterX, y: ty + th };

        const midY = (startPoint.y + endPoint.y) / 2;
        if (Math.abs(startPoint.x - endPoint.x) > 5) {
          bendPoints.push({ x: startPoint.x, y: midY });
          bendPoints.push({ x: endPoint.x, y: midY });
        }
      } else if (goingDown) {
        // Target below source: exit from bottom, enter from top
        startPoint = { x: sourceCenterX, y: sy + sh };
        endPoint = { x: targetCenterX, y: ty };

        const midY = (startPoint.y + endPoint.y) / 2;
        if (Math.abs(startPoint.x - endPoint.x) > 5) {
          bendPoints.push({ x: startPoint.x, y: midY });
          bendPoints.push({ x: endPoint.x, y: midY });
        }
      } else if (goingRight) {
        // Target right of source: exit from right, enter from left
        startPoint = { x: sx + sw, y: sourceCenterY };
        endPoint = { x: tx, y: targetCenterY };

        this.addOrthogonalBendPoints(startPoint, endPoint, bendPoints, obstacles, 'horizontal');
      } else {
        // Target left of source: exit from left, enter from right
        startPoint = { x: sx, y: sourceCenterY };
        endPoint = { x: tx + tw, y: targetCenterY };

        this.addOrthogonalBendPoints(startPoint, endPoint, bendPoints, obstacles, 'horizontal');
      }
    }

    edge.sections = [{
      id: `${edge.id}_section_0`,
      startPoint,
      endPoint,
      bendPoints: bendPoints.length > 0 ? bendPoints : undefined,
    }];
  }

  /**
   * Find a clear vertical path that avoids obstacles
   */
  private findClearVerticalPath(
    x: number,
    startY: number,
    endY: number,
    obstacles: Array<{ x: number; y: number; width: number; height: number }>
  ): number | null {
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);
    const margin = 10;

    // Check if any obstacle blocks the vertical path
    for (const obs of obstacles) {
      const obsLeft = obs.x - margin;
      const obsRight = obs.x + obs.width + margin;
      const obsTop = obs.y;
      const obsBottom = obs.y + obs.height;

      // Check if x is within obstacle's horizontal range
      if (x >= obsLeft && x <= obsRight) {
        // Check if obstacle is in our vertical path
        if (obsBottom > minY && obsTop < maxY) {
          // Found an obstacle - return a Y that goes around it
          // Prefer going below the obstacle if there's more space
          const spaceAbove = obsTop - minY;
          const spaceBelow = maxY - obsBottom;

          if (spaceBelow > spaceAbove && obsBottom + margin < maxY) {
            return obsBottom + margin;
          } else if (obsTop - margin > minY) {
            return obsTop - margin;
          }
        }
      }
    }

    return null; // No obstacle found, direct path is clear
  }

  /**
   * Add orthogonal bend points with obstacle avoidance
   */
  private addOrthogonalBendPoints(
    start: { x: number; y: number },
    end: { x: number; y: number },
    bendPoints: Array<{ x: number; y: number }>,
    obstacles: Array<{ x: number; y: number; width: number; height: number }>,
    primaryDirection: 'horizontal' | 'vertical'
  ): void {
    const margin = 15;

    // Check if direct path (with one bend) crosses any obstacle
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;

    // Try different routing strategies
    const strategies: Array<{ points: Array<{ x: number; y: number }>; score: number }> = [];

    // Strategy 1: Horizontal first, then vertical
    const s1: Array<{ x: number; y: number }> = [
      { x: midX, y: start.y },
      { x: midX, y: end.y },
    ];
    strategies.push({ points: s1, score: this.scoreRoute(start, s1, end, obstacles) });

    // Strategy 2: Vertical first, then horizontal
    const s2: Array<{ x: number; y: number }> = [
      { x: start.x, y: midY },
      { x: end.x, y: midY },
    ];
    strategies.push({ points: s2, score: this.scoreRoute(start, s2, end, obstacles) });

    // Strategy 3: Route above obstacles
    const maxObstacleTop = Math.min(...obstacles.map(o => o.y), start.y, end.y);
    const routeAboveY = maxObstacleTop - margin;
    const s3: Array<{ x: number; y: number }> = [
      { x: start.x, y: routeAboveY },
      { x: end.x, y: routeAboveY },
    ];
    strategies.push({ points: s3, score: this.scoreRoute(start, s3, end, obstacles) });

    // Strategy 4: Route below obstacles
    const maxObstacleBottom = Math.max(...obstacles.map(o => o.y + o.height), start.y, end.y);
    const routeBelowY = maxObstacleBottom + margin;
    const s4: Array<{ x: number; y: number }> = [
      { x: start.x, y: routeBelowY },
      { x: end.x, y: routeBelowY },
    ];
    strategies.push({ points: s4, score: this.scoreRoute(start, s4, end, obstacles) });

    // Strategy 5: Route to the right of obstacles
    const maxObstacleRight = Math.max(...obstacles.map(o => o.x + o.width), start.x, end.x);
    const routeRightX = maxObstacleRight + margin;
    const s5: Array<{ x: number; y: number }> = [
      { x: routeRightX, y: start.y },
      { x: routeRightX, y: end.y },
    ];
    strategies.push({ points: s5, score: this.scoreRoute(start, s5, end, obstacles) });

    // Choose the best strategy (lowest score = fewer crossings + shorter path)
    strategies.sort((a, b) => a.score - b.score);
    const best = strategies[0];

    // Only add bend points if they're significantly different from start/end
    for (const bp of best.points) {
      if (Math.abs(bp.x - start.x) > 5 || Math.abs(bp.y - start.y) > 5) {
        if (Math.abs(bp.x - end.x) > 5 || Math.abs(bp.y - end.y) > 5) {
          bendPoints.push(bp);
        }
      }
    }
  }

  /**
   * Score a route based on obstacle crossings and path length
   */
  private scoreRoute(
    start: { x: number; y: number },
    bendPoints: Array<{ x: number; y: number }>,
    end: { x: number; y: number },
    obstacles: Array<{ x: number; y: number; width: number; height: number }>
  ): number {
    let score = 0;
    const crossingPenalty = 1000;
    const lengthWeight = 0.1;

    // Build full path
    const path = [start, ...bendPoints, end];

    // Check for crossings with each obstacle
    for (const obs of obstacles) {
      for (let i = 0; i < path.length - 1; i++) {
        if (this.segmentIntersectsRect(path[i], path[i + 1], obs)) {
          score += crossingPenalty;
        }
      }
    }

    // Add path length to score
    for (let i = 0; i < path.length - 1; i++) {
      const dx = path[i + 1].x - path[i].x;
      const dy = path[i + 1].y - path[i].y;
      score += Math.sqrt(dx * dx + dy * dy) * lengthWeight;
    }

    return score;
  }

  /**
   * Check if a line segment intersects a rectangle
   */
  private segmentIntersectsRect(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    rect: { x: number; y: number; width: number; height: number }
  ): boolean {
    const margin = 5;
    const left = rect.x - margin;
    const right = rect.x + rect.width + margin;
    const top = rect.y - margin;
    const bottom = rect.y + rect.height + margin;

    // Check if both points are on the same side of the rectangle
    if ((p1.x < left && p2.x < left) || (p1.x > right && p2.x > right)) return false;
    if ((p1.y < top && p2.y < top) || (p1.y > bottom && p2.y > bottom)) return false;

    // Check if segment is horizontal or vertical
    if (Math.abs(p1.x - p2.x) < 1) {
      // Vertical segment
      const x = p1.x;
      const minY = Math.min(p1.y, p2.y);
      const maxY = Math.max(p1.y, p2.y);
      return x >= left && x <= right && maxY >= top && minY <= bottom;
    }

    if (Math.abs(p1.y - p2.y) < 1) {
      // Horizontal segment
      const y = p1.y;
      const minX = Math.min(p1.x, p2.x);
      const maxX = Math.max(p1.x, p2.x);
      return y >= top && y <= bottom && maxX >= left && minX <= right;
    }

    // For diagonal segments (shouldn't happen in orthogonal routing)
    return true; // Assume intersection if not axis-aligned
  }

  /**
   * Identify nodes that need to be moved below their attached boundary event parent
   * Returns a map of node ID -> new position info
   */
  private identifyNodesToMove(
    graph: ElkNode,
    boundaryEventInfo: Map<string, { attachedToRef: string; targets: string[]; boundaryIndex: number; totalBoundaries: number }>
  ): Map<string, { newY: number; offset: number; newX?: number }> {
    const movedNodes = new Map<string, { newY: number; offset: number; newX?: number }>();

    // Build a map of node IDs to their ELK nodes
    const nodeMap = new Map<string, ElkNode>();
    // Build edge map: source -> targets
    const edgeMap = new Map<string, string[]>();

    const buildMaps = (node: ElkNode) => {
      nodeMap.set(node.id, node);
      if (node.edges) {
        for (const edge of node.edges) {
          const source = edge.sources?.[0];
          const target = edge.targets?.[0];
          if (source && target) {
            if (!edgeMap.has(source)) {
              edgeMap.set(source, []);
            }
            edgeMap.get(source)!.push(target);
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          buildMaps(child);
        }
      }
    };
    buildMaps(graph);

    // Collect all boundary events with targets
    const boundaryEventsWithTargets: Array<{
      beId: string;
      info: { attachedToRef: string; targets: string[]; boundaryIndex: number; totalBoundaries: number };
      attachedNode: ElkNode;
      beX: number; // Calculated boundary event X position
    }> = [];

    for (const [beId, info] of boundaryEventInfo) {
      if (info.targets.length === 0) continue;
      const attachedNode = nodeMap.get(info.attachedToRef);
      if (!attachedNode || attachedNode.y === undefined || attachedNode.height === undefined) continue;

      // Calculate boundary event X position
      const attachedX = attachedNode.x ?? 0;
      const attachedWidth = attachedNode.width ?? 100;
      const spacing = attachedWidth / (info.totalBoundaries + 1);
      const beX = attachedX + spacing * (info.boundaryIndex + 1);

      boundaryEventsWithTargets.push({ beId, info, attachedNode, beX });
    }

    // Sort all boundary events by their X position (left to right)
    // This ensures boundary event branches are stacked top-to-bottom in left-to-right order
    boundaryEventsWithTargets.sort((a, b) => {
      const xDiff = a.beX - b.beX;
      if (Math.abs(xDiff) > 1) return xDiff;
      // Same X position: sort by boundaryIndex
      return a.info.boundaryIndex - b.info.boundaryIndex;
    });

    // Find the global bottom Y of all attached nodes (boundary events extend below their parent)
    let globalBottomY = 0;
    for (const be of boundaryEventsWithTargets) {
      const attachedBottom = (be.attachedNode.y ?? 0) + (be.attachedNode.height ?? 80);
      // Boundary event extends 18px below task (beHeight/2 for 36px boundary event)
      const beBottom = attachedBottom + 18;
      globalBottomY = Math.max(globalBottomY, beBottom);
    }

    // Minimum gap between boundary event bottom and target top
    const minGap = 35;
    // Global currentY for all boundary event branches - starts below the lowest boundary event
    let currentY = globalBottomY + minGap;

    // Process all boundary events in sorted order (left to right by X position)
    for (const beEntry of boundaryEventsWithTargets) {
      const { info, attachedNode, beX } = beEntry;

      if (DEBUG) {
        console.log(`[BPMN] Processing boundary event at X=${beX} for ${info.attachedToRef}`);
      }

      for (const targetId of info.targets) {
        const targetNode = nodeMap.get(targetId);
        if (!targetNode || targetNode.y === undefined) continue;

        const targetWidth = targetNode.width ?? 100;
        const targetHeight = targetNode.height ?? 80;

        // Calculate new x position: align target's center with boundary event's center
        const newX = beX - targetWidth / 2;

        // Use the global currentY position (incremented for each boundary event branch)
        const newY = currentY;
        const offset = newY - (targetNode.y ?? 0);
        movedNodes.set(targetId, { newY, offset, newX });

        if (DEBUG) {
          console.log(`[BPMN] Moving ${targetId}: (${targetNode.x},${targetNode.y}) -> (${newX},${newY})`);
        }

        // Also move downstream nodes by the same y offset and aligned horizontally
        this.propagateMovement(targetId, offset, nodeMap, edgeMap, movedNodes, newX);

        // Calculate total height of this branch (target + downstream nodes)
        let branchHeight = targetHeight;
        const downstreamTargets = edgeMap.get(targetId) || [];
        for (const downId of downstreamTargets) {
          const downNode = nodeMap.get(downId);
          if (downNode) {
            branchHeight += 40 + (downNode.height ?? 36); // gap + node height
          }
        }

        // Move global currentY down for the next boundary event's targets
        currentY += branchHeight + 40; // Add gap between branches
      }
    }

    return movedNodes;
  }

  /**
   * Propagate movement to downstream nodes
   */
  private propagateMovement(
    sourceId: string,
    offset: number,
    nodeMap: Map<string, ElkNode>,
    edgeMap: Map<string, string[]>,
    movedNodes: Map<string, { newY: number; offset: number; newX?: number }>,
    sourceNewX?: number
  ): void {
    const sourceNode = nodeMap.get(sourceId);
    const sourceWidth = sourceNode?.width ?? 100;

    const targets = edgeMap.get(sourceId) || [];
    for (const targetId of targets) {
      // Skip if already moved
      if (movedNodes.has(targetId)) continue;

      const targetNode = nodeMap.get(targetId);
      if (!targetNode || targetNode.y === undefined) continue;

      const targetWidth = targetNode.width ?? 36; // End events are typically 36px
      const newY = targetNode.y + offset;

      // Position downstream node to the right of source (aligned with source's right edge)
      let newX: number | undefined;
      if (sourceNewX !== undefined) {
        // Align downstream node to be to the right of the source
        newX = sourceNewX + sourceWidth + 20;
      }

      movedNodes.set(targetId, { newY, offset, newX });

      // Recursively propagate to downstream nodes
      this.propagateMovement(targetId, offset, nodeMap, edgeMap, movedNodes, newX);
    }
  }

  /**
   * Apply node moves to the layouted graph
   */
  private applyNodeMoves(
    graph: ElkNode,
    movedNodes: Map<string, { newY: number; offset: number; newX?: number }>
  ): void {
    const applyMoves = (node: ElkNode) => {
      const moveInfo = movedNodes.get(node.id);
      if (moveInfo && node.y !== undefined) {
        node.y = moveInfo.newY;
        if (moveInfo.newX !== undefined) {
          node.x = moveInfo.newX;
        }
      }
      if (node.children) {
        for (const child of node.children) {
          applyMoves(child);
        }
      }
    };
    applyMoves(graph);
  }

  /**
   * Recalculate edge waypoints for edges connected to moved nodes
   * Implements orthogonal routing with obstacle avoidance
   */
  private recalculateEdgesForMovedNodes(
    graph: ElkNode,
    movedNodes: Map<string, { newY: number; offset: number; newX?: number }>,
    boundaryEventInfo: Map<string, { attachedToRef: string; targets: string[]; boundaryIndex: number; totalBoundaries: number }>
  ): void {
    // Build node map for position lookups (including boundary events)
    const nodeMap = new Map<string, ElkNode>();
    const buildNodeMap = (node: ElkNode) => {
      nodeMap.set(node.id, node);
      if (node.children) {
        for (const child of node.children) {
          buildNodeMap(child);
        }
      }
      // Also include boundary events
      if ((node as { boundaryEvents?: ElkNode[] }).boundaryEvents) {
        for (const be of (node as { boundaryEvents: ElkNode[] }).boundaryEvents) {
          nodeMap.set(be.id, be);
        }
      }
    };
    buildNodeMap(graph);

    // Get all obstacle IDs: attached nodes + all moved nodes
    const obstacleIds = new Set<string>();
    for (const [, info] of boundaryEventInfo) {
      obstacleIds.add(info.attachedToRef);
    }
    // Add all moved nodes as obstacles (they may block edge paths)
    for (const [nodeId] of movedNodes) {
      obstacleIds.add(nodeId);
    }

    // Calculate correct boundary event positions (they are attached to the bottom of their parent)
    const boundaryEventPositions = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const [beId, info] of boundaryEventInfo) {
      const attachedNode = nodeMap.get(info.attachedToRef);
      if (attachedNode && attachedNode.x !== undefined && attachedNode.y !== undefined) {
        const attachedX = attachedNode.x;
        const attachedY = attachedNode.y;
        const attachedWidth = attachedNode.width ?? 100;
        const attachedHeight = attachedNode.height ?? 80;
        const beWidth = 36;
        const beHeight = 36;

        // Calculate position on the bottom edge of the attached node
        const spacing = attachedWidth / (info.totalBoundaries + 1);
        const beX = attachedX + spacing * (info.boundaryIndex + 1) - beWidth / 2;
        const beY = attachedY + attachedHeight - beHeight / 2;

        boundaryEventPositions.set(beId, { x: beX, y: beY, width: beWidth, height: beHeight });
      }
    }

    // Find and recalculate edges in each node
    const processEdges = (node: ElkNode) => {
      if (node.edges) {
        for (const edge of node.edges) {
          const sourceId = edge.sources?.[0];
          const targetId = edge.targets?.[0];

          // Recalculate if source OR target was moved, OR source is a boundary event
          const sourceMoved = sourceId && movedNodes.has(sourceId);
          const targetMoved = targetId && movedNodes.has(targetId);
          const sourceIsBoundaryEvent = sourceId && boundaryEventInfo.has(sourceId);

          if (sourceMoved || targetMoved || sourceIsBoundaryEvent) {
            let sourceNode = nodeMap.get(sourceId);
            const targetNode = nodeMap.get(targetId);

            // For boundary events, use the calculated position
            if (sourceIsBoundaryEvent && boundaryEventPositions.has(sourceId)) {
              const bePos = boundaryEventPositions.get(sourceId)!;
              sourceNode = { ...sourceNode, ...bePos } as ElkNode;
            }

            if (sourceNode && targetNode) {
              this.recalculateEdgeWithObstacleAvoidance(
                edge,
                sourceNode,
                targetNode,
                obstacleIds,
                nodeMap
              );
            }
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          processEdges(child);
        }
      }
    };
    processEdges(graph);
  }

  /**
   * Recalculate edge waypoints with orthogonal routing that avoids obstacles
   */
  private recalculateEdgeWithObstacleAvoidance(
    edge: ElkExtendedEdge,
    source: ElkNode,
    target: ElkNode,
    obstacleIds: Set<string>,
    nodeMap: Map<string, ElkNode>
  ): void {
    const sx = (source.x ?? 0);
    const sy = (source.y ?? 0);
    const sw = (source.width ?? 100);
    const sh = (source.height ?? 80);

    const tx = (target.x ?? 0);
    const ty = (target.y ?? 0);
    const tw = (target.width ?? 36);
    const th = (target.height ?? 36);

    // Find relevant obstacles
    const obstacles: { x: number; y: number; width: number; height: number }[] = [];
    for (const obsId of obstacleIds) {
      const obs = nodeMap.get(obsId);
      if (obs && obs.x !== undefined && obs.y !== undefined) {
        obstacles.push({
          x: obs.x,
          y: obs.y,
          width: obs.width ?? 100,
          height: obs.height ?? 80,
        });
      }
    }

    if (DEBUG) {
      console.log(`[BPMN] Edge ${edge.id}: (${sx},${sy}) -> (${tx},${ty}), obstacles: ${obstacles.length}`);
    }

    // Determine routing strategy based on relative positions
    const waypoints: { x: number; y: number }[] = [];

    // Source is below target (moved node connecting to main flow)
    if (sy > ty + th) {
      // Find the rightmost edge we need to clear
      let clearX = tx + tw;
      for (const obs of obstacles) {
        const obsRight = obs.x + obs.width;
        // If obstacle is between source and target vertically
        if (obs.y < sy && obs.y + obs.height > ty) {
          clearX = Math.max(clearX, obsRight + 30);
        }
      }

      // Route: right from source -> right past obstacles -> up -> left to target
      const startX = sx + sw;
      const startY = sy + sh / 2;
      const endX = tx + tw;
      const endY = ty + th / 2;

      waypoints.push({ x: startX, y: startY }); // Exit right from source

      if (clearX > startX) {
        // Need to go further right to clear obstacles
        waypoints.push({ x: clearX, y: startY }); // Go right
        waypoints.push({ x: clearX, y: endY }); // Go up
      } else {
        // Direct vertical routing
        waypoints.push({ x: startX, y: endY });
      }

      waypoints.push({ x: endX, y: endY }); // Enter target from right
    } else if (ty > sy + sh) {
      // Target is below source - route down from source to target
      // Exit from bottom of source, enter from top of target
      const startX = sx + sw / 2;
      const startY = sy + sh;
      const endX = tx + tw / 2;
      const endY = ty;

      waypoints.push({ x: startX, y: startY }); // Exit from bottom of source

      // Check if there are obstacles between source and target
      // that would be crossed by a simple orthogonal route
      const obstaclesToAvoid: { x: number; y: number; width: number; height: number }[] = [];
      for (const obs of obstacles) {
        // Skip if obstacle is the source or target itself
        if (obs.x === sx && obs.y === sy) continue;
        if (obs.x === tx && obs.y === ty) continue;

        // Check if obstacle is in the vertical path between source and target
        const obsBottom = obs.y + obs.height;
        const obsRight = obs.x + obs.width;

        // Obstacle is between source bottom and target top vertically
        if (obs.y <= endY && obsBottom >= startY) {
          // Check horizontal overlap with the path (use wider margin)
          const pathMinX = Math.min(startX, endX) - 40;
          const pathMaxX = Math.max(startX, endX) + 40;
          if (obs.x <= pathMaxX && obsRight >= pathMinX) {
            obstaclesToAvoid.push(obs);
          }
        }
      }

      if (obstaclesToAvoid.length > 0) {
        // Find the leftmost X we need to route through to avoid ALL obstacles
        // including obstacles that might be in the vertical path of the detour
        let avoidX = startX;

        // First pass: find initial avoidX based on direct obstacles
        for (const obs of obstaclesToAvoid) {
          avoidX = Math.min(avoidX, obs.x - 30);
        }

        // Second pass: check if the detour path itself crosses any obstacles
        // and adjust avoidX further left if needed
        for (const obs of obstacles) {
          // Skip source and target
          if (obs.x === sx && obs.y === sy) continue;
          if (obs.x === tx && obs.y === ty) continue;

          const obsBottom = obs.y + obs.height;
          const obsRight = obs.x + obs.width;

          // Check if obstacle is in the vertical range of the detour (startY to endY)
          if (obs.y <= endY && obsBottom >= startY) {
            // Check if obstacle blocks the current avoidX path
            if (obs.x <= avoidX + 20 && obsRight >= avoidX - 20) {
              // Need to go further left to avoid this obstacle too
              avoidX = Math.min(avoidX, obs.x - 30);
            }
          }
        }

        if (DEBUG) {
          console.log(`[BPMN] Avoiding ${obstaclesToAvoid.length} obstacles, avoidX=${avoidX}`);
        }

        // Route: down -> left to avoid -> down -> right to target
        const midY1 = startY + 20;
        waypoints.push({ x: startX, y: midY1 });
        waypoints.push({ x: avoidX, y: midY1 });
        waypoints.push({ x: avoidX, y: endY - 20 });
        waypoints.push({ x: endX, y: endY - 20 });
      } else {
        // No obstacles - simple orthogonal route
        const midY = (startY + endY) / 2;
        waypoints.push({ x: startX, y: midY });
        waypoints.push({ x: endX, y: midY });
      }

      waypoints.push({ x: endX, y: endY }); // Enter top of target
    } else {
      // Default: simple orthogonal routing (left-to-right)
      const startX = sx + sw;
      const startY = sy + sh / 2;
      const endX = tx;
      const endY = ty + th / 2;

      waypoints.push({ x: startX, y: startY });

      // Add midpoint for orthogonal routing
      const midX = (startX + endX) / 2;
      waypoints.push({ x: midX, y: startY });
      waypoints.push({ x: midX, y: endY });

      waypoints.push({ x: endX, y: endY });
    }

    // Update edge sections
    if (waypoints.length >= 2) {
      edge.sections = [{
        id: `${edge.id}_section_0`,
        startPoint: waypoints[0],
        endPoint: waypoints[waypoints.length - 1],
        bendPoints: waypoints.slice(1, -1),
      }];

      if (DEBUG) {
        console.log(`[BPMN] Waypoints for ${edge.id}: ${JSON.stringify(waypoints)}`);
      }
    }
  }

  /**
   * Apply default sizes to all nodes in the graph
   */
  private applyDefaultSizes(graph: ElkBpmnGraph): ElkBpmnGraph {
    // Process all children recursively
    if (graph.children) {
      graph.children = graph.children.map((child) => {
        return this.applyDefaultSizesRecursive(child);
      });
    }
    return graph;
  }

  private applyDefaultSizesRecursive<T extends object>(node: T): T {
    const result = { ...node };

    // Apply sizes if this is a node with bpmn type
    if ('bpmn' in result && 'id' in result) {
      const bpmn = (result as { bpmn: { type: string; name?: string; isExpanded?: boolean } }).bpmn;
      const nodeResult = result as { width?: number; height?: number };

      // Get default size based on type
      const defaultSize = this.getDefaultSizeForType(bpmn.type, bpmn.name, bpmn.isExpanded);

      if (nodeResult.width === undefined) {
        nodeResult.width = defaultSize.width;
      }
      if (nodeResult.height === undefined) {
        nodeResult.height = defaultSize.height;
      }
    }

    // Process children recursively
    if ('children' in result && Array.isArray((result as { children: unknown[] }).children)) {
      (result as { children: unknown[] }).children = (result as { children: object[] }).children.map(
        (child) => this.applyDefaultSizesRecursive(child)
      );
    }

    // Process boundary events
    if ('boundaryEvents' in result && Array.isArray((result as { boundaryEvents: unknown[] }).boundaryEvents)) {
      const boundaryEvents = (result as { boundaryEvents: object[] }).boundaryEvents;
      (result as { boundaryEvents: unknown[] }).boundaryEvents = boundaryEvents.map(
        (be) => this.applyDefaultSizesRecursive(be)
      );

      // Ensure host node is wide enough to accommodate all boundary events with spacing
      // Each boundary event is 36px wide, and we need at least 20px spacing between them
      const beCount = boundaryEvents.length;
      if (beCount > 1) {
        const beWidth = 36;
        const beSpacing = 20;
        // Need: margin + (beWidth + spacing) * beCount - spacing + margin
        // Simplified: (beCount * (beWidth + beSpacing)) + margin
        const minWidth = beCount * (beWidth + beSpacing) + beSpacing;
        const nodeResult = result as { width?: number };
        if (nodeResult.width !== undefined && nodeResult.width < minWidth) {
          nodeResult.width = minWidth;
        }
      }
    }

    // Process artifacts
    if ('artifacts' in result && Array.isArray((result as { artifacts: unknown[] }).artifacts)) {
      (result as { artifacts: unknown[] }).artifacts = (result as { artifacts: object[] }).artifacts.map(
        (artifact) => this.applyDefaultSizesRecursive(artifact)
      );
    }

    return result;
  }

  /**
   * Estimate label width based on text content
   * Uses approximate character width of 8px for CJK and 7px for ASCII
   */
  private estimateLabelWidth(text?: string): number {
    if (!text) return 50;

    let width = 0;
    for (const char of text) {
      // CJK characters are wider
      if (char.charCodeAt(0) > 255) {
        width += 14; // ~14px for CJK characters
      } else {
        width += 7; // ~7px for ASCII characters
      }
    }

    return Math.max(30, Math.min(width, 200)); // Clamp between 30 and 200
  }

  private getDefaultSizeForType(type: string, name?: string, isExpanded?: boolean): { width: number; height: number } {
    // Expanded subprocesses
    if (isExpanded === true) {
      return { width: 300, height: 200 };
    }

    // Events
    if (type.includes('Event')) {
      return { width: 36, height: 36 };
    }

    // Gateways
    if (type.includes('Gateway')) {
      return { width: 50, height: 50 };
    }

    // Tasks and activities
    if (type.includes('Task') || type === 'task' || type === 'callActivity') {
      const nameLen = name?.length ?? 0;
      if (nameLen > 12) return { width: 150, height: 80 };
      if (nameLen > 8) return { width: 120, height: 80 };
      return { width: 100, height: 80 };
    }

    // Collapsed subprocesses
    if (type === 'subProcess' || type === 'transaction' || type === 'adHocSubProcess' || type === 'eventSubProcess') {
      return { width: 100, height: 80 };
    }

    // Data objects
    if (type === 'dataObject' || type === 'dataObjectReference' || type === 'dataInput' || type === 'dataOutput') {
      return { width: 36, height: 50 };
    }

    // Data store
    if (type === 'dataStoreReference') {
      return { width: 50, height: 50 };
    }

    // Text annotation
    if (type === 'textAnnotation') {
      return { width: 100, height: 30 };
    }

    // Participant/Pool - let ELK calculate
    if (type === 'participant') {
      return { width: 680, height: 200 };
    }

    // Lane - let ELK calculate
    if (type === 'lane') {
      return { width: 680, height: 150 };
    }

    // Default
    return { width: 100, height: 80 };
  }

  /**
   * Prepare the graph for ELK layout
   * - Merge layout options
   * - Convert to ELK-compatible format
   */
  private prepareForElk(graph: ElkBpmnGraph): ElkNode {
    let layoutOptions = mergeElkOptions(this.userOptions, graph.layoutOptions);

    // Check if this graph contains a cross-pool collaboration
    // If so, force RIGHT direction for better horizontal layout
    if (this.hasCrossPoolCollaboration(graph)) {
      layoutOptions = {
        ...layoutOptions,
        'elk.direction': 'RIGHT',
      };
    }

    return {
      id: graph.id,
      layoutOptions: layoutOptions as LayoutOptions,
      children: this.prepareChildrenForElk(graph.children),
    };
  }

  /**
   * Check if the graph contains a collaboration with cross-pool sequence flows
   */
  private hasCrossPoolCollaboration(graph: ElkBpmnGraph): boolean {
    if (!graph.children) return false;

    for (const child of graph.children) {
      const node = child as unknown as NodeWithBpmn;
      if (node.bpmn?.type !== 'collaboration') continue;

      // Check if collaboration has multiple pools
      const pools = (node.children as NodeWithBpmn[] | undefined)?.filter(
        c => c.bpmn?.type === 'participant'
      ) ?? [];
      if (pools.length <= 1) continue;

      // Check if collaboration has cross-pool sequence flows
      const hasCrossPoolFlows = node.edges?.some(
        edge => edge.bpmn?.type === 'sequenceFlow' ||
                edge.bpmn?.type === 'dataInputAssociation' ||
                edge.bpmn?.type === 'dataOutputAssociation'
      );

      if (hasCrossPoolFlows) return true;
    }

    return false;
  }

  /**
   * Collect all boundary event IDs and their target nodes from edges
   */
  private collectBoundaryEventTargets(node: NodeWithBpmn): Set<string> {
    const boundaryEventIds = new Set<string>();
    const targetNodeIds = new Set<string>();

    // Collect boundary event IDs from this node and children
    const collectBoundaryEventIds = (n: NodeWithBpmn) => {
      if (n.boundaryEvents) {
        for (const be of n.boundaryEvents) {
          boundaryEventIds.add(be.id);
        }
      }
      if (n.children) {
        for (const child of n.children) {
          collectBoundaryEventIds(child as NodeWithBpmn);
        }
      }
    };
    collectBoundaryEventIds(node);

    // Find edges where source is a boundary event
    const findTargets = (n: NodeWithBpmn) => {
      if (n.edges) {
        for (const edge of n.edges) {
          const sourceId = edge.sources[0];
          if (boundaryEventIds.has(sourceId)) {
            // This edge starts from a boundary event
            targetNodeIds.add(edge.targets[0]);
          }
        }
      }
      if (n.children) {
        for (const child of n.children) {
          findTargets(child as NodeWithBpmn);
        }
      }
    };
    findTargets(node);

    return targetNodeIds;
  }

  private prepareChildrenForElk(children: ElkBpmnGraph['children']): ElkNode[] {
    if (!children) return [];

    const result: ElkNode[] = [];

    for (const child of children) {
      const node = child as unknown as NodeWithBpmn;
      result.push(this.prepareNodeForElk(node));

      // Add boundary events as sibling nodes (not children of the task)
      // This allows ELK to route edges from boundary events correctly
      if (node.boundaryEvents && node.boundaryEvents.length > 0) {
        for (const be of node.boundaryEvents) {
          result.push({
            id: be.id,
            width: be.width ?? 36,
            height: be.height ?? 36,
          });
        }
      }
    }

    return result;
  }

  private prepareNodeForElk(node: NodeWithBpmn): ElkNode {
    let layoutOptions = node.layoutOptions as LayoutOptions | undefined;

    // For expanded subprocesses, add top padding for the label header
    const isExpandedSubprocess = node.bpmn?.isExpanded === true &&
      (node.bpmn?.type === 'subProcess' || node.bpmn?.type === 'transaction' ||
       node.bpmn?.type === 'adHocSubProcess' || node.bpmn?.type === 'eventSubProcess');

    if (isExpandedSubprocess) {
      layoutOptions = {
        ...layoutOptions,
        'elk.padding': '[top=30,left=12,bottom=30,right=12]',
      } as LayoutOptions;
    }

    // Check if this is a collaboration with multiple pools and cross-pool sequence flow edges
    // Only flatten nodes when there are actual sequenceFlow edges crossing pools
    // (messageFlow edges are normal for collaborations and don't require flattening)
    const isCollaboration = node.bpmn?.type === 'collaboration';
    const hasMultiplePools = isCollaboration &&
      (node.children?.filter((c: NodeWithBpmn) => c.bpmn?.type === 'participant').length ?? 0) > 1;

    // Check if any collaboration-level edges are sequenceFlow (cross-pool flow)
    const hasCrossPoolSequenceFlows = isCollaboration && node.edges?.some(
      (edge) => edge.bpmn?.type === 'sequenceFlow' ||
                edge.bpmn?.type === 'dataInputAssociation' ||
                edge.bpmn?.type === 'dataOutputAssociation'
    );

    if (isCollaboration && hasCrossPoolSequenceFlows && hasMultiplePools) {
      // For collaborations with cross-pool edges, flatten all pool contents
      // to collaboration level for unified layout
      layoutOptions = {
        ...layoutOptions,
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.padding': '[top=12,left=12,bottom=12,right=12]',
      } as LayoutOptions;

      const elkNode: ElkNode = {
        id: node.id,
        width: node.width,
        height: node.height,
        layoutOptions,
      };

      // Flatten all pool contents to collaboration level
      const childNodes: ElkNode[] = [];
      this.extractNodesFromPools(node.children as NodeWithBpmn[], childNodes);
      elkNode.children = childNodes;

      // Copy edges to ELK format
      if (node.edges && node.edges.length > 0) {
        elkNode.edges = node.edges.map((edge) => ({
          id: edge.id,
          sources: edge.sources,
          targets: edge.targets,
          layoutOptions: edge.layoutOptions as LayoutOptions | undefined,
          labels: edge.labels?.map((l) => ({
            text: l.text,
            width: l.width ?? 50,
            height: l.height ?? 14,
          })),
        })) as ElkExtendedEdge[];
      }

      return elkNode;
    }

    // Check if this is a pool (participant)
    const isPool = node.bpmn?.type === 'participant';
    const hasLanes = isPool &&
      node.children?.some((c: NodeWithBpmn) => c.bpmn?.type === 'lane');

    if (hasLanes) {
      // For pools with lanes, use a different layout strategy:
      // - Use partitioning to create horizontal swim lanes (rows, not columns)
      // - Set direction to RIGHT for flow within lanes
      // - Use 'elk.partitioning.activate' with vertical partitions
      layoutOptions = {
        ...layoutOptions,
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        // Remove partitioning - we'll handle lane stacking differently
        'elk.partitioning.activate': 'false',
        // Add padding for lane header (left side)
        'elk.padding': '[top=12,left=30,bottom=12,right=12]',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      } as LayoutOptions;
    } else if (isPool) {
      // For pools without lanes, still add left padding for pool label
      layoutOptions = {
        ...layoutOptions,
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        // Add padding for pool header (left side) - 55px to accommodate vertical label
        'elk.padding': '[top=12,left=55,bottom=12,right=12]',
      } as LayoutOptions;
    }

    // Check if this is a lane
    const isLane = node.bpmn?.type === 'lane';
    if (isLane) {
      // For lanes, don't set separate layout algorithm - let parent pool handle layout
      // Just set padding for content spacing
      layoutOptions = {
        'elk.padding': '[top=12,left=12,bottom=12,right=12]',
      } as LayoutOptions;
    }

    const elkNode: ElkNode = {
      id: node.id,
      width: node.width,
      height: node.height,
      layoutOptions,
    };

    // Process children (including boundary events as siblings)
    if (node.children && node.children.length > 0) {
      const childNodes: ElkNode[] = [];

      // For pools with lanes, flatten all lane contents to pool level for unified layout
      // This allows ELK to consider cross-lane edges when positioning nodes
      if (hasLanes) {
        // Recursively extract all flow nodes from lanes (including nested lanes)
        this.extractNodesFromLanes(node.children as NodeWithBpmn[], childNodes);
      } else {
        // Normal processing for non-lane containers
        for (const child of node.children) {
          const childNode = child as NodeWithBpmn;
          childNodes.push(this.prepareNodeForElk(childNode));

          // Add boundary events as siblings
          if (childNode.boundaryEvents && childNode.boundaryEvents.length > 0) {
            for (const be of childNode.boundaryEvents) {
              childNodes.push({
                id: be.id,
                width: be.width ?? 36,
                height: be.height ?? 36,
              });
            }
          }
        }
      }
      elkNode.children = childNodes;
    }

    // Process edges
    if (node.edges && node.edges.length > 0) {
      elkNode.edges = node.edges.map((edge) => ({
        id: edge.id,
        sources: edge.sources,
        targets: edge.targets,
        layoutOptions: edge.layoutOptions as LayoutOptions | undefined,
        labels: edge.labels?.map((l) => ({
          text: l.text,
          width: l.width ?? 50,
          height: l.height ?? 14,
        })),
      })) as ElkExtendedEdge[];
    }

    // Boundary events are added as siblings (not children) for ELK edge routing
    // Their actual visual positions are recalculated in model-builder.ts

    // Process labels - ensure all labels have dimensions (ELK requires this)
    if (node.labels && node.labels.length > 0) {
      elkNode.labels = node.labels.map((l) => ({
        text: l.text,
        width: l.width ?? this.estimateLabelWidth(l.text),
        height: l.height ?? 14,
      }));
    }

    // Process ports
    if (node.ports && node.ports.length > 0) {
      elkNode.ports = node.ports.map((p) => ({
        id: p.id,
        width: p.width ?? 10,
        height: p.height ?? 10,
      }));
    }

    return elkNode;
  }

  /**
   * Recursively extract all flow nodes from lanes (including nested lanes)
   * and add them to the result array for unified ELK layout
   */
  /**
   * Extract all flow nodes from pools to flatten them for unified layout
   * This is used for collaborations with cross-pool edges
   */
  private extractNodesFromPools(children: NodeWithBpmn[], result: ElkNode[]): void {
    for (const child of children) {
      if (child.bpmn?.type === 'participant') {
        // Check if this is an empty/black box pool
        const isEmpty = !child.children || child.children.length === 0;

        if (isEmpty) {
          // Add the pool itself as a node (for message flows targeting the pool)
          result.push({
            id: child.id,
            width: child.width ?? 680,
            height: child.height ?? 60,
          });
        } else {
          // Extract nodes from this pool
          // Check if pool has lanes
          const hasLanes = child.children.some((c: NodeWithBpmn) => c.bpmn?.type === 'lane');
          if (hasLanes) {
            this.extractNodesFromLanes(child.children as NodeWithBpmn[], result);
          } else {
            // Direct children of pool (no lanes)
            for (const poolChild of child.children) {
              const node = poolChild as NodeWithBpmn;
              result.push(this.prepareNodeForElk(node));

              // Add boundary events as siblings
              if (node.boundaryEvents && node.boundaryEvents.length > 0) {
                for (const be of node.boundaryEvents) {
                  result.push({
                    id: be.id,
                    width: be.width ?? 36,
                    height: be.height ?? 36,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  private extractNodesFromLanes(children: NodeWithBpmn[], result: ElkNode[]): void {
    for (const child of children) {
      if (child.bpmn?.type === 'lane') {
        // Recursively extract from nested lanes
        if (child.children) {
          this.extractNodesFromLanes(child.children as NodeWithBpmn[], result);
        }
      } else {
        // Non-lane node - add to result
        result.push(this.prepareNodeForElk(child));

        // Add boundary events as siblings
        if (child.boundaryEvents && child.boundaryEvents.length > 0) {
          for (const be of child.boundaryEvents) {
            result.push({
              id: be.id,
              width: be.width ?? 36,
              height: be.height ?? 36,
            });
          }
        }
      }
    }
  }

  /**
   * Rearrange lanes to stack vertically within pools
   * After ELK layout, nodes are flattened to pool level. This function:
   * 1. Groups nodes back into their original lanes
   * 2. Stacks lanes vertically
   * 3. Recalculates edge waypoints
   */
  private rearrangeLanes(layouted: ElkNode, original: ElkBpmnGraph): void {
    const laneHeaderWidth = 30;
    const lanePadding = 0; // No extra padding - tight fit
    const laneExtraWidth = 50; // Extra width for each lane
    const laneExtraHeight = 80; // Extra height for each lane

    // Build a map of node ID -> deepest lane ID (for nested lanes)
    const buildNodeToLaneMap = (children: NodeWithBpmn[], map: Map<string, string>) => {
      for (const child of children) {
        if (child.bpmn?.type === 'lane') {
          // Check if this lane has nested lanes
          const hasNestedLanes = child.children?.some((c: NodeWithBpmn) => c.bpmn?.type === 'lane');
          if (hasNestedLanes) {
            // Recurse into nested lanes
            buildNodeToLaneMap(child.children as NodeWithBpmn[], map);
          } else if (child.children) {
            // Leaf lane - map its children to this lane
            for (const node of child.children) {
              map.set((node as NodeWithBpmn).id, child.id);
            }
          }
        }
      }
    };

    // Recursively build lane structure with positioned nodes
    const buildLaneStructure = (
      origChildren: NodeWithBpmn[],
      layoutedNodes: Map<string, ElkNode>,
      nodeToLane: Map<string, string>,
      startY: number,
      maxRight: number
    ): { lanes: ElkNode[]; totalHeight: number } => {
      const lanes: ElkNode[] = [];
      let currentY = startY;

      // Filter to get only lanes and sort by partition
      const origLanes = origChildren.filter(c => c.bpmn?.type === 'lane');
      origLanes.sort((a, b) => {
        const partA = a.layoutOptions?.['elk.partitioning.partition'];
        const partB = b.layoutOptions?.['elk.partitioning.partition'];
        return (partA !== undefined ? Number(partA) : 0) - (partB !== undefined ? Number(partB) : 0);
      });

      for (const origLane of origLanes) {
        const hasNestedLanes = origLane.children?.some((c: NodeWithBpmn) => c.bpmn?.type === 'lane');

        if (hasNestedLanes) {
          // Recursively process nested lanes
          // Nested lanes are offset by laneHeaderWidth inside their parent,
          // so they need reduced width to avoid overflow
          const nestedWidth = maxRight - laneHeaderWidth;
          const nested = buildLaneStructure(
            origLane.children as NodeWithBpmn[],
            layoutedNodes,
            nodeToLane,
            0,
            nestedWidth
          );

          // Ensure nested lanes fill parent lane width (minus header)
          for (const nestedLane of nested.lanes) {
            nestedLane.width = nestedWidth;
          }

          const laneNode: ElkNode = {
            id: origLane.id,
            x: laneHeaderWidth,
            y: currentY,
            width: maxRight, // Fill full width
            height: nested.totalHeight, // Tight fit
            children: nested.lanes,
          };
          lanes.push(laneNode);
          currentY += laneNode.height!;
        } else {
          // Leaf lane - collect its nodes
          const nodesInLane: ElkNode[] = [];
          if (origLane.children) {
            for (const child of origLane.children) {
              const node = layoutedNodes.get((child as NodeWithBpmn).id);
              if (node) nodesInLane.push(node);
            }
          }

          // Calculate lane height based on content + extra height
          let minY = Infinity, maxY = 0;
          for (const node of nodesInLane) {
            minY = Math.min(minY, node.y ?? 0);
            maxY = Math.max(maxY, (node.y ?? 0) + (node.height ?? 80));
          }
          // Add extra height to each lane
          const contentHeight = nodesInLane.length > 0 ? maxY - minY : 50;
          const laneHeight = contentHeight + laneExtraHeight;

          // Center content vertically within the lane
          const yOffset = nodesInLane.length > 0 ? (laneExtraHeight / 2) - minY : 0;
          for (const node of nodesInLane) {
            node.y = (node.y ?? 0) + yOffset;
          }

          const laneNode: ElkNode = {
            id: origLane.id,
            x: laneHeaderWidth,
            y: currentY,
            width: maxRight,
            height: laneHeight,
            children: nodesInLane,
          };
          lanes.push(laneNode);
          currentY += laneHeight;
        }
      }

      return { lanes, totalHeight: currentY - startY };
    };

    const processPool = (pool: ElkNode, origPool: NodeWithBpmn | undefined) => {
      if (!pool.children || !origPool?.children) return;

      // Check if this pool has lanes
      const hasLanes = (origPool.children as NodeWithBpmn[]).some(c => c.bpmn?.type === 'lane');
      if (!hasLanes) return;

      // Build node -> lane mapping (handles nested lanes)
      const nodeToLane = new Map<string, string>();
      buildNodeToLaneMap(origPool.children as NodeWithBpmn[], nodeToLane);

      // Get layouted nodes (flattened at pool level after ELK)
      const layoutedNodes = new Map<string, ElkNode>();
      for (const child of pool.children) {
        layoutedNodes.set(child.id, child);
      }

      // Calculate max content width
      let maxRight = 0;
      for (const child of pool.children) {
        maxRight = Math.max(maxRight, (child.x ?? 0) + (child.width ?? 100));
      }

      // Calculate pool width (content width + extra width)
      const poolContentWidth = maxRight + laneExtraWidth;

      // Build lane structure - lanes fill the full pool width
      const result = buildLaneStructure(
        origPool.children as NodeWithBpmn[],
        layoutedNodes,
        nodeToLane,
        0,
        poolContentWidth // Lanes fill full width
      );

      // Update pool - lanes fill the entire pool, no gaps
      pool.children = result.lanes;
      pool.width = laneHeaderWidth + poolContentWidth;
      pool.height = result.totalHeight;

      // Recalculate edge waypoints
      if (pool.edges) {
        this.recalculatePoolEdges(pool, result.lanes);
      }
    };

    // Find pools in collaborations and process them
    if (layouted.children) {
      for (let i = 0; i < layouted.children.length; i++) {
        const child = layouted.children[i];
        const origChild = original.children?.[i] as NodeWithBpmn | undefined;

        // Check if this is a collaboration with pools
        if (origChild?.bpmn?.type === 'collaboration' && child.children) {
          for (let j = 0; j < child.children.length; j++) {
            const pool = child.children[j];
            const origPool = (origChild.children as NodeWithBpmn[] | undefined)?.[j];
            if (origPool?.bpmn?.type === 'participant') {
              processPool(pool, origPool);
            }
          }
        } else if (origChild?.bpmn?.type === 'participant') {
          // Direct pool (not in collaboration)
          processPool(child, origChild);
        }
      }
    }
  }

  /**
   * Rearrange nested lanes within a parent lane
   */
  private rearrangeNestedLanes(lane: ElkNode, origLane: NodeWithBpmn | undefined): void {
    if (!lane.children) return;

    // Check if this lane has nested lanes
    const nestedLanes: ElkNode[] = [];
    const nonLanes: ElkNode[] = [];

    for (const child of lane.children) {
      const origChild = origLane?.children?.find((c: NodeWithBpmn) => c.id === child.id) as NodeWithBpmn | undefined;
      if (origChild?.bpmn?.type === 'lane') {
        nestedLanes.push(child);
      } else {
        nonLanes.push(child);
      }
    }

    if (nestedLanes.length > 0) {
      // Stack nested lanes vertically
      let currentY = 12;
      let maxWidth = 0;

      for (const nestedLane of nestedLanes) {
        const contentHeight = this.calculateContentHeight(nestedLane);
        const laneHeight = Math.max(contentHeight + 24, 60);

        nestedLane.x = 30; // Nested lane header offset
        nestedLane.y = currentY;
        nestedLane.height = laneHeight;

        const contentWidth = this.calculateContentWidth(nestedLane);
        nestedLane.width = contentWidth + 24;
        maxWidth = Math.max(maxWidth, nestedLane.width ?? 0);

        currentY += laneHeight;
      }

      // Update all nested lanes to have the same width
      for (const nestedLane of nestedLanes) {
        nestedLane.width = maxWidth;
      }

      // Update parent lane dimensions
      lane.width = 30 + maxWidth + 12;
      lane.height = currentY + 12;
    }
  }

  /**
   * Calculate the width needed to contain all children of a node
   */
  private calculateContentWidth(node: ElkNode): number {
    if (!node.children || node.children.length === 0) {
      return 100; // Default minimum width
    }

    let maxRight = 0;
    for (const child of node.children) {
      const right = (child.x ?? 0) + (child.width ?? 100);
      maxRight = Math.max(maxRight, right);
    }

    return maxRight;
  }

  /**
   * Calculate the height needed to contain all children of a node
   */
  private calculateContentHeight(node: ElkNode): number {
    if (!node.children || node.children.length === 0) {
      return 60; // Default minimum height
    }

    let maxBottom = 0;
    for (const child of node.children) {
      const bottom = (child.y ?? 0) + (child.height ?? 80);
      maxBottom = Math.max(maxBottom, bottom);
    }

    return maxBottom;
  }

  /**
   * Recalculate edge waypoints after lanes have been rearranged
   */
  private recalculatePoolEdges(pool: ElkNode, lanes: ElkNode[]): void {
    if (!pool.edges) return;

    // Build a map of node positions within the pool
    const nodePositions = new Map<string, { x: number; y: number; width: number; height: number }>();

    const collectNodePositions = (container: ElkNode, offsetX: number, offsetY: number) => {
      if (container.children) {
        for (const child of container.children) {
          const absX = offsetX + (child.x ?? 0);
          const absY = offsetY + (child.y ?? 0);
          nodePositions.set(child.id, {
            x: absX,
            y: absY,
            width: child.width ?? 100,
            height: child.height ?? 80,
          });
          // Recursively collect from nested containers
          collectNodePositions(child, absX, absY);
        }
      }
    };

    // Collect positions from all lanes
    for (const lane of lanes) {
      collectNodePositions(lane, lane.x ?? 0, lane.y ?? 0);
    }

    // Recalculate edge waypoints
    for (const edge of pool.edges) {
      const sourceId = edge.sources?.[0];
      const targetId = edge.targets?.[0];

      const sourcePos = sourceId ? nodePositions.get(sourceId) : undefined;
      const targetPos = targetId ? nodePositions.get(targetId) : undefined;

      if (sourcePos && targetPos) {
        // Calculate connection points
        const startX = sourcePos.x + sourcePos.width;
        const startY = sourcePos.y + sourcePos.height / 2;
        const endX = targetPos.x;
        const endY = targetPos.y + targetPos.height / 2;

        // Create new waypoints
        const waypoints: Array<{ x: number; y: number }> = [];
        waypoints.push({ x: startX, y: startY });

        // Add bend points for orthogonal routing if source and target are in different lanes
        if (Math.abs(startY - endY) > 10) {
          const midX = (startX + endX) / 2;
          waypoints.push({ x: midX, y: startY });
          waypoints.push({ x: midX, y: endY });
        }

        waypoints.push({ x: endX, y: endY });

        // Update edge sections
        // Mark as pool-relative coords (model-builder should use pool offset, not source node offset)
        (edge as ElkExtendedEdge & { _poolRelativeCoords?: boolean })._poolRelativeCoords = true;
        edge.sections = [{
          id: `${edge.id}_s0`,
          startPoint: { x: startX, y: startY },
          endPoint: { x: endX, y: endY },
          bendPoints: waypoints.length > 2 ? waypoints.slice(1, -1) : undefined,
        }];
      }
    }
  }

  /**
   * Rearrange pools (participants) to stack vertically within collaborations
   * Also recalculates message flow edges after repositioning
   */
  /**
   * Rearrange pools within collaborations that had cross-pool edges
   * After unified layout, nodes need to be grouped back into their pools
   * Key improvement: Don't use ELK's Y bounds directly, instead compact nodes vertically
   */
  private rearrangeCollaborationWithCrossPoolEdges(
    collab: ElkNode,
    origCollab: NodeWithBpmn
  ): void {
    if (!collab.children || !origCollab.children) return;

    const poolHeaderWidth = 55;
    const poolPaddingX = 25;
    const poolPaddingY = 20;
    const minPoolHeight = 100; // Minimum pool height for content pools

    // Build map of node ID -> pool ID and identify artifacts
    const nodeToPool = new Map<string, string>();
    const artifactIds = new Set<string>();
    for (const origPool of origCollab.children as NodeWithBpmn[]) {
      if (origPool.bpmn?.type === 'participant' && origPool.children) {
        const hasLanes = origPool.children.some((c: NodeWithBpmn) => c.bpmn?.type === 'lane');
        if (hasLanes) {
          // Recursively map nodes in lanes
          const mapNodesInLanes = (children: NodeWithBpmn[]) => {
            for (const child of children) {
              if (child.bpmn?.type === 'lane') {
                if (child.children) mapNodesInLanes(child.children as NodeWithBpmn[]);
              } else {
                nodeToPool.set(child.id, origPool.id);
                if (ElkLayouter.ARTIFACT_TYPES.has(child.bpmn?.type)) {
                  artifactIds.add(child.id);
                }
              }
            }
          };
          mapNodesInLanes(origPool.children as NodeWithBpmn[]);
        } else {
          for (const child of origPool.children) {
            const childNode = child as NodeWithBpmn;
            nodeToPool.set(childNode.id, origPool.id);
            if (ElkLayouter.ARTIFACT_TYPES.has(childNode.bpmn?.type)) {
              artifactIds.add(childNode.id);
            }
          }
        }
      }
    }

    // Get layouted nodes (flattened at collaboration level)
    const layoutedNodes = new Map<string, ElkNode>();
    for (const child of collab.children) {
      layoutedNodes.set(child.id, child);
    }

    // Group nodes by pool and calculate X bounds (excluding artifacts for bounds calculation)
    const poolNodesMap = new Map<string, ElkNode[]>();
    const poolXBounds = new Map<string, { minX: number; maxX: number }>();

    // Also track GLOBAL minX across all pools for alignment
    let globalMinX = Infinity;

    for (const [nodeId, poolId] of nodeToPool) {
      const node = layoutedNodes.get(nodeId);
      if (!node) continue;

      // Group nodes by pool
      if (!poolNodesMap.has(poolId)) {
        poolNodesMap.set(poolId, []);
      }
      poolNodesMap.get(poolId)!.push(node);

      // Track X bounds only (exclude artifacts from bounds calculation)
      if (!artifactIds.has(nodeId)) {
        const x = node.x ?? 0;
        const w = node.width ?? 100;
        const bounds = poolXBounds.get(poolId) ?? { minX: Infinity, maxX: 0 };
        bounds.minX = Math.min(bounds.minX, x);
        bounds.maxX = Math.max(bounds.maxX, x + w);
        poolXBounds.set(poolId, bounds);

        // Track global minX
        globalMinX = Math.min(globalMinX, x);
      }
    }

    // Sort pools by original order (or partition)
    const origPools = (origCollab.children as NodeWithBpmn[]).filter(c => c.bpmn?.type === 'participant');
    origPools.sort((a, b) => {
      const partA = a.layoutOptions?.['elk.partitioning.partition'];
      const partB = b.layoutOptions?.['elk.partitioning.partition'];
      if (partA !== undefined && partB !== undefined) {
        return Number(partA) - Number(partB);
      }
      return 0;
    });

    // Calculate max content width across all pools using global minX
    let globalMaxX = 0;
    for (const bounds of poolXBounds.values()) {
      globalMaxX = Math.max(globalMaxX, bounds.maxX);
    }
    const maxContentWidth = globalMaxX - globalMinX;
    const poolWidth = poolHeaderWidth + maxContentWidth + poolPaddingX * 2;

    // Build pool structures and stack vertically
    const pools: ElkNode[] = [];
    let currentY = 0;

    for (const origPool of origPools) {
      const poolNodes = poolNodesMap.get(origPool.id) ?? [];
      const isBlackBox = origPool.bpmn?.isBlackBox === true || !origPool.children?.length;

      if (isBlackBox) {
        // Black box pool (no content)
        pools.push({
          id: origPool.id,
          x: 0,
          y: currentY,
          width: poolWidth,
          height: 60,
          children: [],
        });
        currentY += 60;
      } else {
        // Separate artifacts from regular nodes
        const regularNodes = poolNodes.filter(n => !artifactIds.has(n.id));
        const artifactNodes = poolNodes.filter(n => artifactIds.has(n.id));

        // Calculate pool height based on max node height (not Y spread!)
        // All nodes in a pool should be vertically centered
        let maxNodeHeight = 0;
        for (const node of regularNodes) {
          maxNodeHeight = Math.max(maxNodeHeight, node.height ?? 80);
        }
        const poolHeight = Math.max(minPoolHeight, maxNodeHeight + poolPaddingY * 2);

        // Reposition regular nodes: use GLOBAL minX for alignment, vertically center in pool
        const adjustedNodes: ElkNode[] = [];
        for (const node of regularNodes) {
          const nodeHeight = node.height ?? 80;
          // Center node vertically in pool
          const newY = (poolHeight - nodeHeight) / 2;
          // Adjust X relative to GLOBAL minX (preserves horizontal alignment across pools)
          const newX = poolHeaderWidth + (node.x ?? 0) - globalMinX + poolPaddingX;

          adjustedNodes.push({
            ...node,
            x: newX,
            y: newY,
          });
        }

        // Position artifacts relative to their associated tasks
        for (const artifact of artifactNodes) {
          // Find associated task and association type from original edges
          const { task: associatedTask, isInput } = this.findArtifactAssociatedTaskWithType(
            artifact.id,
            origCollab.edges ?? [],
            adjustedNodes
          );

          if (associatedTask) {
            const artifactWidth = artifact.width ?? 36;
            const artifactHeight = artifact.height ?? 50;
            const taskX = associatedTask.x ?? 0;
            const taskY = associatedTask.y ?? 0;
            const taskWidth = associatedTask.width ?? 100;
            const taskHeight = associatedTask.height ?? 80;

            let newX: number, newY: number;

            if (isInput) {
              // Input association: position artifact to the right of the task (output side)
              // This avoids overlapping with elements to the left (like start events)
              newX = taskX + taskWidth + 15;
              newY = taskY + (taskHeight - artifactHeight) / 2;
            } else {
              // Output association: position artifact below and to the right of the task
              newX = taskX + taskWidth + 15;
              newY = taskY + (taskHeight - artifactHeight) / 2;
            }

            adjustedNodes.push({
              ...artifact,
              x: newX,
              y: Math.max(5, newY),
            });
          } else {
            // Fallback: use global minX alignment
            const newX = poolHeaderWidth + (artifact.x ?? 0) - globalMinX + poolPaddingX;
            const artifactHeight = artifact.height ?? 50;
            const newY = (poolHeight - artifactHeight) / 2;

            adjustedNodes.push({
              ...artifact,
              x: newX,
              y: newY,
            });
          }
        }

        pools.push({
          id: origPool.id,
          x: 0,
          y: currentY,
          width: poolWidth,
          height: poolHeight,
          children: adjustedNodes,
        });
        currentY += poolHeight;
      }
    }

    // Update collaboration
    collab.children = pools;
    collab.width = poolWidth;
    collab.height = currentY;

    // Recalculate edge waypoints
    if (collab.edges) {
      const nodePositions = new Map<string, { x: number; y: number; width: number; height: number }>();

      // Collect absolute positions of all nodes
      for (const pool of pools) {
        const poolX = pool.x ?? 0;
        const poolY = pool.y ?? 0;

        // Store pool position for message flows to black box pools
        nodePositions.set(pool.id, {
          x: poolX,
          y: poolY,
          width: pool.width ?? 680,
          height: pool.height ?? 200,
        });

        if (pool.children) {
          for (const child of pool.children) {
            nodePositions.set(child.id, {
              x: poolX + (child.x ?? 0),
              y: poolY + (child.y ?? 0),
              width: child.width ?? 100,
              height: child.height ?? 80,
            });
          }
        }
      }

      this.recalculateMessageFlows(collab.edges, nodePositions, pools, origCollab.edges);
    }
  }

  private rearrangePools(layouted: ElkNode, original: ElkBpmnGraph): void {
    // Find collaboration nodes
    if (!layouted.children) return;

    for (let i = 0; i < layouted.children.length; i++) {
      const child = layouted.children[i];
      const origChild = original.children?.[i] as NodeWithBpmn | undefined;

      // Check if this is a collaboration
      if (origChild?.bpmn?.type === 'collaboration' && child.children && child.children.length > 0) {
        // Check if this collaboration had cross-pool edges (nodes were flattened)
        const hasCrossPoolEdges = origChild.edges && origChild.edges.length > 0;
        const hasMultiplePools = (origChild.children as NodeWithBpmn[] | undefined)?.filter(
          c => c.bpmn?.type === 'participant'
        ).length > 1;

        // Check if children were flattened (most pools are not present in layouted result)
        // Count how many original pools are in the layouted children
        const origPools = (origChild.children as NodeWithBpmn[] | undefined)?.filter(
          c => c.bpmn?.type === 'participant'
        ) ?? [];
        const poolIdsInLayouted = new Set(child.children.map(c => c.id));
        const poolsFoundInLayouted = origPools.filter(p => poolIdsInLayouted.has(p.id)).length;
        // If most pools are missing from layouted children, nodes were flattened
        // (Black box pools may still be present as nodes)
        const childrenAreFlattened = poolsFoundInLayouted < origPools.length / 2;

        if (hasCrossPoolEdges && hasMultiplePools && childrenAreFlattened) {
          // Nodes were flattened to collaboration level, need to rearrange into pools
          this.rearrangeCollaborationWithCrossPoolEdges(child, origChild);
        } else {
          this.stackPoolsVertically(child, origChild);
        }
      }
    }
  }

  /**
   * Stack pools vertically within a collaboration
   */
  private stackPoolsVertically(collab: ElkNode, origCollab: NodeWithBpmn): void {
    if (!collab.children || collab.children.length === 0) return;

    // Extra dimensions for pools (same as lanes)
    const poolExtraWidth = 50;
    const poolExtraHeight = 80;

    const pools: ElkNode[] = [];
    const origPoolMap = new Map<string, NodeWithBpmn>();

    // Collect pools and build original pool map
    for (const child of collab.children) {
      const origPool = origCollab.children?.find((c: NodeWithBpmn) => c.id === child.id) as NodeWithBpmn | undefined;
      if (origPool?.bpmn?.type === 'participant') {
        pools.push(child);
        origPoolMap.set(child.id, origPool);
      }
    }

    if (pools.length === 0) return;

    // Sort pools by original order (or use the order from original children)
    const poolOrder = new Map<string, number>();
    origCollab.children?.forEach((c: NodeWithBpmn, idx: number) => {
      if (c.bpmn?.type === 'participant') {
        poolOrder.set(c.id, idx);
      }
    });
    pools.sort((a, b) => (poolOrder.get(a.id) ?? 0) - (poolOrder.get(b.id) ?? 0));

    // Calculate the maximum width needed
    // Pools with lanes already have extra width added in processPool, so don't add again
    let maxPoolWidth = 0;
    for (const pool of pools) {
      const origPool = origPoolMap.get(pool.id);
      const hasLanes = (origPool?.children as NodeWithBpmn[] | undefined)?.some(c => c.bpmn?.type === 'lane');
      if (hasLanes) {
        // Pool with lanes - width already includes extra width from processPool
        maxPoolWidth = Math.max(maxPoolWidth, pool.width ?? 680);
      } else {
        // Pool without lanes - add extra width here
        maxPoolWidth = Math.max(maxPoolWidth, (pool.width ?? 680) + poolExtraWidth);
      }
    }

    // Stack pools vertically
    const poolSpacing = 0; // No gap between pools (they share borders)
    let currentY = 0;

    // Build a map of node positions within pools for message flow calculation
    const nodePositions = new Map<string, { x: number; y: number; width: number; height: number }>();

    for (const pool of pools) {
      const origPool = origPoolMap.get(pool.id);
      const isBlackBox = origPool?.bpmn?.isBlackBox === true;
      const hasLanes = (origPool?.children as NodeWithBpmn[] | undefined)?.some(c => c.bpmn?.type === 'lane');

      // Set pool position
      pool.x = 0;
      pool.y = currentY;

      // For black box pools, use a minimal height
      if (isBlackBox) {
        pool.width = maxPoolWidth;
        pool.height = pool.height ?? 60;
      } else if (hasLanes) {
        // Pool with lanes - already processed by rearrangeLanes, just set width
        pool.width = maxPoolWidth;
      } else {
        // Pool without lanes - add extra width and height
        pool.width = maxPoolWidth;
        pool.height = (pool.height ?? 200) + poolExtraHeight;

        // Center content vertically within the enlarged pool
        this.offsetPoolChildren(pool, poolExtraHeight / 2);
      }

      // Store pool position for message flow routing
      nodePositions.set(pool.id, {
        x: pool.x,
        y: pool.y,
        width: pool.width ?? 680,
        height: pool.height ?? 200,
      });

      // Collect positions of all nodes within this pool (including those in lanes)
      this.collectNodePositionsInPool(pool, pool.x, pool.y, nodePositions);

      currentY += (pool.height ?? 200) + poolSpacing;
    }

    // Update collaboration dimensions
    collab.width = maxPoolWidth;
    collab.height = currentY - poolSpacing; // Remove trailing spacing

    // Recalculate message flow edges (pass original edges for type info)
    if (collab.edges && origCollab.edges) {
      this.recalculateMessageFlows(collab.edges, nodePositions, pools, origCollab.edges);
    }
  }

  /**
   * Offset all children within a pool by a given y amount for vertical centering
   */
  private offsetPoolChildren(pool: ElkNode, offsetY: number): void {
    if (!pool.children) return;

    for (const child of pool.children) {
      if (child.y !== undefined) {
        child.y += offsetY;
      }
      // Recursively offset nested children (for lanes)
      this.offsetPoolChildren(child, 0); // Don't double-offset nested children
    }

    // Also offset edges within the pool
    if (pool.edges) {
      for (const edge of pool.edges) {
        if (edge.sections) {
          for (const section of edge.sections) {
            if (section.startPoint) {
              section.startPoint.y += offsetY;
            }
            if (section.endPoint) {
              section.endPoint.y += offsetY;
            }
            if (section.bendPoints) {
              for (const bp of section.bendPoints) {
                bp.y += offsetY;
              }
            }
          }
        }
      }
    }
  }

  /**
   * Collect node positions within a pool (including nested lanes)
   */
  private collectNodePositionsInPool(
    container: ElkNode,
    offsetX: number,
    offsetY: number,
    positions: Map<string, { x: number; y: number; width: number; height: number }>
  ): void {
    if (!container.children) return;

    for (const child of container.children) {
      const absX = offsetX + (child.x ?? 0);
      const absY = offsetY + (child.y ?? 0);

      positions.set(child.id, {
        x: absX,
        y: absY,
        width: child.width ?? 100,
        height: child.height ?? 80,
      });

      // Recursively collect from nested containers (lanes, etc.)
      this.collectNodePositionsInPool(child, absX, absY, positions);
    }
  }

  /**
   * Recalculate edge waypoints after pools have been repositioned
   * Handles both sequence flows (horizontal routing) and message flows (vertical routing)
   */
  private recalculateMessageFlows(
    edges: ElkExtendedEdge[],
    nodePositions: Map<string, { x: number; y: number; width: number; height: number }>,
    pools: ElkNode[],
    originalEdges?: Array<{ id: string; sources: string[]; targets: string[]; bpmn?: { type?: string } }>
  ): void {
    // Build edge type map from original edges (ELK edges lose bpmn type info)
    const edgeTypeMap = new Map<string, string>();
    if (originalEdges) {
      for (const origEdge of originalEdges) {
        if (origEdge.bpmn?.type) {
          edgeTypeMap.set(origEdge.id, origEdge.bpmn.type);
        }
      }
    }

    // Build pool Y ranges for routing
    const poolYRanges: Array<{ id: string; minY: number; maxY: number }> = [];
    for (const pool of pools) {
      poolYRanges.push({
        id: pool.id,
        minY: pool.y ?? 0,
        maxY: (pool.y ?? 0) + (pool.height ?? 100),
      });
    }

    for (const edge of edges) {
      const sourceId = edge.sources?.[0];
      const targetId = edge.targets?.[0];
      // Get edge type from original edges map, fallback to edge's own bpmn property
      const edgeType = edgeTypeMap.get(edge.id) ?? (edge as { bpmn?: { type?: string } }).bpmn?.type;

      const sourcePos = sourceId ? nodePositions.get(sourceId) : undefined;
      const targetPos = targetId ? nodePositions.get(targetId) : undefined;

      if (!sourcePos || !targetPos) continue;

      // Determine if this is a sequence flow or message flow
      const isSequenceFlow = edgeType === 'sequenceFlow';
      const isMessageFlow = edgeType === 'messageFlow';
      const isDataAssociation = edgeType === 'dataInputAssociation' || edgeType === 'dataOutputAssociation';

      let startX: number, startY: number, endX: number, endY: number;
      const waypoints: Array<{ x: number; y: number }> = [];

      if (isSequenceFlow) {
        // Sequence flows: smart connection points based on relative positions
        const sourceCenterX = sourcePos.x + sourcePos.width / 2;
        const sourceCenterY = sourcePos.y + sourcePos.height / 2;
        const targetCenterX = targetPos.x + targetPos.width / 2;
        const targetCenterY = targetPos.y + targetPos.height / 2;

        const goingRight = targetCenterX > sourceCenterX;
        const goingDown = targetCenterY > sourceCenterY + 30;
        const goingUp = targetCenterY < sourceCenterY - 30;
        const sameLevel = !goingDown && !goingUp;

        if (goingRight) {
          if (sameLevel) {
            // Same level: exit RIGHT, enter LEFT
            startX = sourcePos.x + sourcePos.width;
            startY = sourceCenterY;
            endX = targetPos.x;
            endY = targetCenterY;

            waypoints.push({ x: startX, y: startY });
            if (Math.abs(startY - endY) > 10) {
              const midX = (startX + endX) / 2;
              waypoints.push({ x: midX, y: startY });
              waypoints.push({ x: midX, y: endY });
            }
            waypoints.push({ x: endX, y: endY });
          } else if (goingDown) {
            // Going down-right: exit BOTTOM, enter LEFT
            startX = sourceCenterX;
            startY = sourcePos.y + sourcePos.height;
            endX = targetPos.x;
            endY = targetCenterY;

            waypoints.push({ x: startX, y: startY });
            // Route: down to target Y level, then right to enter from left
            waypoints.push({ x: startX, y: endY });
            waypoints.push({ x: endX, y: endY });
          } else {
            // Going up-right: exit TOP, enter LEFT
            startX = sourceCenterX;
            startY = sourcePos.y;
            endX = targetPos.x;
            endY = targetCenterY;

            waypoints.push({ x: startX, y: startY });
            // Route: up to target Y level, then right to enter from left
            waypoints.push({ x: startX, y: endY });
            waypoints.push({ x: endX, y: endY });
          }
        } else {
          // Going left (backward connection)
          startX = sourcePos.x;
          startY = sourceCenterY;
          endX = targetPos.x + targetPos.width;
          endY = targetCenterY;

          waypoints.push({ x: startX, y: startY });

          // Loop below the elements for backward flows
          const loopY = Math.max(sourcePos.y + sourcePos.height, targetPos.y + targetPos.height) + 30;
          waypoints.push({ x: startX, y: loopY });
          waypoints.push({ x: endX, y: loopY });

          waypoints.push({ x: endX, y: endY });
        }
      } else if (isMessageFlow) {
        // Message flows: vertical routing between pools with L-shaped path
        if (sourcePos.y + sourcePos.height < targetPos.y) {
          // Source above target - connect bottom of source to top of target
          startX = sourcePos.x + sourcePos.width / 2;
          startY = sourcePos.y + sourcePos.height;
          endX = targetPos.x + targetPos.width / 2;
          endY = targetPos.y;
        } else {
          // Target above source - connect top of source to bottom of target
          startX = sourcePos.x + sourcePos.width / 2;
          startY = sourcePos.y;
          endX = targetPos.x + targetPos.width / 2;
          endY = targetPos.y + targetPos.height;
        }

        waypoints.push({ x: startX, y: startY });

        // L-shaped routing
        const horizontalDist = Math.abs(startX - endX);
        if (horizontalDist > 5) {
          // For large horizontal distances, route closer to target to avoid crossing other elements
          // For small distances, use midpoint for cleaner appearance
          const routeY = horizontalDist > 200 ? endY - 20 : (startY + endY) / 2;
          waypoints.push({ x: startX, y: routeY });
          waypoints.push({ x: endX, y: routeY });
        }

        waypoints.push({ x: endX, y: endY });
      } else if (isDataAssociation) {
        // Hide data associations in cross-pool collaborations completely
        // Data objects are positioned adjacent to their tasks, so no arrows needed
        (edge as ElkExtendedEdge & { _absoluteCoords?: boolean })._absoluteCoords = true;
        edge.sections = [];
        continue;
      } else {
        // Default: same as sequence flow
        startX = sourcePos.x + sourcePos.width;
        startY = sourcePos.y + sourcePos.height / 2;
        endX = targetPos.x;
        endY = targetPos.y + targetPos.height / 2;

        waypoints.push({ x: startX, y: startY });
        if (Math.abs(startY - endY) > 10) {
          const midX = (startX + endX) / 2;
          waypoints.push({ x: midX, y: startY });
          waypoints.push({ x: midX, y: endY });
        }
        waypoints.push({ x: endX, y: endY });
      }

      // Update edge sections
      (edge as ElkExtendedEdge & { _absoluteCoords?: boolean })._absoluteCoords = true;
      edge.sections = [{
        id: `${edge.id}_s0`,
        startPoint: waypoints[0],
        endPoint: waypoints[waypoints.length - 1],
        bendPoints: waypoints.length > 2 ? waypoints.slice(1, -1) : undefined,
      }];

      // Update label positions
      if (edge.labels && edge.labels.length > 0) {
        const midIdx = Math.floor(waypoints.length / 2);
        const labelPoint = waypoints[midIdx] ?? waypoints[0];
        for (const label of edge.labels) {
          const labelWidth = label.width ?? 50;
          const labelHeight = label.height ?? 14;
          label.x = labelPoint.x - labelWidth / 2;
          label.y = labelPoint.y - labelHeight - 5;
        }
      }
    }
  }

  /**
   * Find the task associated with an artifact (data object, annotation, etc.)
   * Returns the adjusted node position and whether it's an input association
   */
  private findArtifactAssociatedTaskWithType(
    artifactId: string,
    edges: Array<{ id: string; sources: string[]; targets: string[]; bpmn?: { type?: string } }>,
    adjustedNodes: ElkNode[]
  ): { task: ElkNode | undefined; isInput: boolean } {
    // Build node map from adjusted nodes
    const nodeMap = new Map<string, ElkNode>();
    for (const node of adjustedNodes) {
      nodeMap.set(node.id, node);
    }

    // Find edges where artifact is source (dataInputAssociation) or target (dataOutputAssociation)
    for (const edge of edges) {
      const edgeType = edge.bpmn?.type;

      // Data input: artifact -> task
      if (edgeType === 'dataInputAssociation' || edgeType === 'association') {
        if (edge.sources.includes(artifactId)) {
          const targetId = edge.targets[0];
          const targetNode = nodeMap.get(targetId);
          if (targetNode) return { task: targetNode, isInput: true };
        }
      }

      // Data output: task -> artifact
      if (edgeType === 'dataOutputAssociation') {
        if (edge.targets.includes(artifactId)) {
          const sourceId = edge.sources[0];
          const sourceNode = nodeMap.get(sourceId);
          if (sourceNode) return { task: sourceNode, isInput: false };
        }
      }
    }

    return { task: undefined, isInput: false };
  }

  /**
   * Fix edges that cross through nodes by rerouting them around obstacles.
   * This is a post-processing step to fix edges that ELK didn't route properly,
   * especially for return edges (edges going from bottom to top).
   */
  private fixEdgesCrossingNodes(graph: ElkNode): void {
    // Build a map of all actual flow node positions (tasks, gateways, events - NOT containers)
    const nodePositions = new Map<string, { x: number; y: number; width: number; height: number }>();
    const collectNodePositions = (node: ElkNode, offsetX: number = 0, offsetY: number = 0) => {
      // After ELK layout, bpmn property may be undefined on the layouted nodes
      // So we use ID patterns to identify flow nodes vs containers
      const id = node.id || '';

      // Flow node ID patterns (tasks, gateways, events)
      const flowNodePatterns = [
        /^task_/, /^gateway_/, /^start_/, /^end_/,
        /^boundary_/, /^subprocess_/, /^call_/,
        /^intermediate_/, /^event_/,
      ];
      const isFlowNode = flowNodePatterns.some(pattern => pattern.test(id));

      // Container ID patterns
      const containerPatterns = [
        /^definitions_/, /^collaboration_/, /^pool_/, /^participant_/,
        /^lane_/, /^process_/, /^LaneSet_/,
      ];
      const isContainer = containerPatterns.some(pattern => pattern.test(id));

      // For flow nodes, store their absolute position
      if (isFlowNode && node.x !== undefined && node.y !== undefined) {
        const absX = offsetX + node.x;
        const absY = offsetY + node.y;
        nodePositions.set(node.id, {
          x: absX,
          y: absY,
          width: node.width ?? 100,
          height: node.height ?? 80,
        });
      }

      // Recursively process children with accumulated offset
      if (node.children) {
        // Always accumulate offsets from parent nodes
        const newOffsetX = offsetX + (node.x ?? 0);
        const newOffsetY = offsetY + (node.y ?? 0);
        for (const child of node.children) {
          collectNodePositions(child, newOffsetX, newOffsetY);
        }
      }
    };
    collectNodePositions(graph);

    // Process all edges in the graph
    const processEdges = (node: ElkNode, containerOffsetX: number = 0, containerOffsetY: number = 0) => {
      if (node.edges) {
        for (const edge of node.edges) {
          if (edge.sections && edge.sections.length > 0) {
            this.fixEdgeIfCrossing(edge, nodePositions, containerOffsetX, containerOffsetY);
          }
        }
      }

      const bpmn = (node as unknown as { bpmn?: { type: string } }).bpmn;
      const isContainer = bpmn?.type === 'lane' || bpmn?.type === 'participant' || bpmn?.type === 'collaboration' || bpmn?.type === 'process';

      if (node.children) {
        const newOffsetX = isContainer ? containerOffsetX + (node.x ?? 0) : containerOffsetX;
        const newOffsetY = isContainer ? containerOffsetY + (node.y ?? 0) : containerOffsetY;
        for (const child of node.children) {
          processEdges(child, newOffsetX, newOffsetY);
        }
      }
    };
    processEdges(graph);
  }

  /**
   * Check if an edge crosses any node and fix it if so
   */
  private fixEdgeIfCrossing(
    edge: ElkExtendedEdge,
    nodePositions: Map<string, { x: number; y: number; width: number; height: number }>,
    containerOffsetX: number,
    containerOffsetY: number
  ): void {
    const section = edge.sections![0];
    const sourceId = edge.sources?.[0];
    const targetId = edge.targets?.[0];

    // Convert waypoints to absolute positions
    const waypoints: { x: number; y: number }[] = [
      { x: containerOffsetX + section.startPoint.x, y: containerOffsetY + section.startPoint.y },
    ];
    if (section.bendPoints) {
      for (const bp of section.bendPoints) {
        waypoints.push({ x: containerOffsetX + bp.x, y: containerOffsetY + bp.y });
      }
    }
    waypoints.push({ x: containerOffsetX + section.endPoint.x, y: containerOffsetY + section.endPoint.y });

    // Check each segment of the edge for crossings
    const crossedNodes: string[] = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const p1 = waypoints[i];
      const p2 = waypoints[i + 1];

      for (const [nodeId, pos] of nodePositions) {
        // Skip source and target nodes for intermediate segments
        if (nodeId === sourceId || nodeId === targetId) continue;

        if (this.segmentCrossesNode(p1, p2, pos)) {
          crossedNodes.push(nodeId);
        }
      }
    }

    // Also check if the edge path crosses THROUGH the target node (not just connects to it)
    // This happens when the edge enters the target from the "wrong" direction
    const targetPos = nodePositions.get(targetId!);
    const sourcePos = nodePositions.get(sourceId!);

    if (DEBUG && edge.id?.includes('back')) {
      console.log(`[BPMN] Edge ${edge.id}: sourceId=${sourceId}, targetId=${targetId}`);
      console.log(`[BPMN] Edge ${edge.id}: sourcePos=${JSON.stringify(sourcePos)}, targetPos=${JSON.stringify(targetPos)}`);
      console.log(`[BPMN] Edge ${edge.id}: waypoints.length=${waypoints.length}`);
    }

    if (targetPos && sourcePos && waypoints.length >= 2) {
      // Check the last segment before entering the target
      const lastWaypoint = waypoints[waypoints.length - 1];
      const secondLastWaypoint = waypoints[waypoints.length - 2];

      // If this is a return edge (target above source) and the last segment is horizontal
      // going through the target, we need to reroute
      const isReturnEdge = targetPos.y + targetPos.height < sourcePos.y;

      if (DEBUG && edge.id?.includes('back')) {
        console.log(`[BPMN] Edge ${edge.id}: isReturnEdge=${isReturnEdge}, target=(${targetPos.x},${targetPos.y},${targetPos.width},${targetPos.height}), source=(${sourcePos.x},${sourcePos.y})`);
        console.log(`[BPMN] Edge ${edge.id}: lastWaypoint=(${lastWaypoint.x},${lastWaypoint.y}), secondLast=(${secondLastWaypoint.x},${secondLastWaypoint.y})`);
      }

      if (isReturnEdge) {
        // Check if the horizontal segment crosses through the target interior
        if (Math.abs(secondLastWaypoint.y - lastWaypoint.y) < 5) {
          // Horizontal segment
          const segY = secondLastWaypoint.y;
          const segMinX = Math.min(secondLastWaypoint.x, lastWaypoint.x);
          const segMaxX = Math.max(secondLastWaypoint.x, lastWaypoint.x);

          if (DEBUG && edge.id?.includes('back')) {
            console.log(`[BPMN] Edge ${edge.id}: horizontal seg y=${segY}, x=${segMinX}-${segMaxX}`);
            console.log(`[BPMN] Edge ${edge.id}: target y range: ${targetPos.y}-${targetPos.y + targetPos.height}`);
            console.log(`[BPMN] Edge ${edge.id}: target x range: ${targetPos.x}-${targetPos.x + targetPos.width}`);
          }

          // Check if segment passes through target interior
          if (segY > targetPos.y && segY < targetPos.y + targetPos.height) {
            if (segMinX < targetPos.x + targetPos.width && segMaxX > targetPos.x) {
              // The segment passes through the target - this needs fixing
              crossedNodes.push(targetId! + ' (target)');
            }
          }
        }
      }
    }

    if (crossedNodes.length === 0) return;

    if (DEBUG) {
      console.log(`[BPMN] Edge ${edge.id} crosses nodes: ${crossedNodes.join(', ')}`);
    }

    // sourcePos and targetPos were already retrieved above
    if (!sourcePos || !targetPos) return;

    // Collect obstacles (all crossed nodes plus nearby nodes)
    const obstacles: { x: number; y: number; width: number; height: number; id: string }[] = [];
    for (const [nodeId, pos] of nodePositions) {
      if (nodeId === sourceId || nodeId === targetId) continue;
      obstacles.push({ ...pos, id: nodeId });
    }

    // Determine if this is a return edge (target is above source)
    const isReturnEdge = targetPos.y + targetPos.height < sourcePos.y;

    // For return edges that cross through target, adjust endpoint to enter from right side
    const crossesThroughTarget = crossedNodes.some(n => n.includes('(target)'));
    if (isReturnEdge && crossesThroughTarget) {
      // Original endpoint enters from left side of target
      // Move it to enter from right side: add target width
      const targetWidth = targetPos.width;
      section.endPoint = {
        x: section.endPoint.x + targetWidth,
        y: section.endPoint.y,
      };
    }

    // Get the adjusted endpoints in absolute coordinates
    const originalStart = {
      x: containerOffsetX + section.startPoint.x,
      y: containerOffsetY + section.startPoint.y,
    };
    const originalEnd = {
      x: containerOffsetX + section.endPoint.x,
      y: containerOffsetY + section.endPoint.y,
    };

    // Calculate new bend points that avoid obstacles
    const newBendPoints = this.calculateAvoidingBendPoints(
      originalStart,
      originalEnd,
      sourcePos,
      targetPos,
      obstacles,
      isReturnEdge
    );

    // Convert bend points back to relative coordinates
    const relativeBendPoints = newBendPoints.map(bp => ({
      x: bp.x - containerOffsetX,
      y: bp.y - containerOffsetY,
    }));

    section.bendPoints = relativeBendPoints.length > 0 ? relativeBendPoints : undefined;

    if (DEBUG) {
      console.log(`[BPMN] Fixed edge ${edge.id} with ${relativeBendPoints.length} bend points`);
    }
  }

  /**
   * Check if a line segment crosses through a node
   */
  private segmentCrossesNode(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    node: { x: number; y: number; width: number; height: number }
  ): boolean {
    const margin = 5; // Small margin for detection
    const nodeLeft = node.x - margin;
    const nodeRight = node.x + node.width + margin;
    const nodeTop = node.y - margin;
    const nodeBottom = node.y + node.height + margin;

    // Check if segment is horizontal
    if (Math.abs(p1.y - p2.y) < 1) {
      const segY = p1.y;
      const segMinX = Math.min(p1.x, p2.x);
      const segMaxX = Math.max(p1.x, p2.x);

      // Segment crosses if: y is within node's vertical range AND segment spans node's horizontal range
      if (segY > nodeTop && segY < nodeBottom) {
        if (segMinX < nodeRight && segMaxX > nodeLeft) {
          // Check if segment actually passes through the interior (not just touching edges)
          const interiorLeft = node.x + margin;
          const interiorRight = node.x + node.width - margin;
          if (segMinX < interiorRight && segMaxX > interiorLeft) {
            return true;
          }
        }
      }
    }

    // Check if segment is vertical
    if (Math.abs(p1.x - p2.x) < 1) {
      const segX = p1.x;
      const segMinY = Math.min(p1.y, p2.y);
      const segMaxY = Math.max(p1.y, p2.y);

      // Segment crosses if: x is within node's horizontal range AND segment spans node's vertical range
      if (segX > nodeLeft && segX < nodeRight) {
        if (segMinY < nodeBottom && segMaxY > nodeTop) {
          // Check if segment actually passes through the interior
          const interiorTop = node.y + margin;
          const interiorBottom = node.y + node.height - margin;
          if (segMinY < interiorBottom && segMaxY > interiorTop) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Calculate bend points that avoid obstacles while preserving original start/end points
   */
  private calculateAvoidingBendPoints(
    originalStart: { x: number; y: number },
    originalEnd: { x: number; y: number },
    source: { x: number; y: number; width: number; height: number },
    target: { x: number; y: number; width: number; height: number },
    obstacles: { x: number; y: number; width: number; height: number; id: string }[],
    isReturnEdge: boolean
  ): { x: number; y: number }[] {
    const margin = 20;
    const bendPoints: { x: number; y: number }[] = [];

    if (isReturnEdge) {
      // Return edge: source is below target
      // Strategy: go right past all obstacles, go up, then connect to original end

      // Find the rightmost x we need to clear (including source, target, and all obstacles in between)
      let clearX = Math.max(source.x + source.width, target.x + target.width) + margin;

      for (const obs of obstacles) {
        // Check if obstacle is in the vertical range between source and target
        const obsBottom = obs.y + obs.height;
        if (obs.y < source.y + source.height && obsBottom > target.y) {
          clearX = Math.max(clearX, obs.x + obs.width + margin);
        }
      }

      // Also ensure we clear the target node itself (since the original path crossed it)
      clearX = Math.max(clearX, target.x + target.width + margin);

      // Bend points: right from start -> up -> left toward end
      bendPoints.push({ x: clearX, y: originalStart.y }); // Go right at start height
      bendPoints.push({ x: clearX, y: originalEnd.y });   // Go up to end height
    } else {
      // Normal edge: source is above or level with target
      // Simple L-shaped routing through midpoint
      const midX = (originalStart.x + originalEnd.x) / 2;
      bendPoints.push({ x: midX, y: originalStart.y });
      bendPoints.push({ x: midX, y: originalEnd.y });
    }

    return bendPoints;
  }

  /**
   * Merge ELK layout results back with original BPMN metadata
   */
  private mergeLayoutResults(
    original: ElkBpmnGraph,
    layouted: ElkNode
  ): LayoutedGraph {
    const result: LayoutedGraph = {
      ...original,
      x: layouted.x,
      y: layouted.y,
      width: layouted.width,
      height: layouted.height,
      children: [],
    };

    // Merge children by ID
    if (original.children && layouted.children) {
      const layoutedChildMap = new Map(layouted.children.map((c) => [c.id, c]));

      result.children = original.children.map((origChild) => {
        const layoutedChild = layoutedChildMap.get(origChild.id);
        if (layoutedChild) {
          return this.mergeNodeResults(
            origChild as unknown as NodeWithBpmn,
            layoutedChild
          );
        }
        return origChild as unknown as LayoutedGraph['children'][number];
      });
    }

    return result;
  }

  private mergeNodeResults(original: NodeWithBpmn, layouted: ElkNode): NodeWithBpmn {
    const result: NodeWithBpmn = {
      ...original,
      x: layouted.x ?? 0,
      y: layouted.y ?? 0,
      width: layouted.width ?? original.width,
      height: layouted.height ?? original.height,
    };

    // Merge children
    if (original.children && layouted.children) {
      // Filter out boundary events from layouted children
      const layoutedChildMap = new Map(layouted.children.map((c) => [c.id, c]));

      result.children = original.children.map((origChild) => {
        const layoutedChild = layoutedChildMap.get(origChild.id);
        if (layoutedChild) {
          return this.mergeNodeResults(origChild as NodeWithBpmn, layoutedChild);
        }
        return origChild;
      });
    }

    // Keep boundary events as-is (their positions are calculated in model-builder.ts)
    if (original.boundaryEvents) {
      result.boundaryEvents = original.boundaryEvents;
    }

    // Merge edges
    if (original.edges && layouted.edges) {
      const layoutedEdgeMap = new Map(layouted.edges.map((e) => [e.id, e]));

      result.edges = original.edges.map((origEdge) => {
        const layoutedEdge = layoutedEdgeMap.get(origEdge.id);
        if (layoutedEdge) {
          if (DEBUG && layoutedEdge.sections?.[0]?.bendPoints?.length) {
            console.log(`[BPMN] Merge ${origEdge.id}: bendPoints=${JSON.stringify(layoutedEdge.sections[0].bendPoints)}`);
          }
          const mergedEdge: typeof origEdge & { _absoluteCoords?: boolean; _poolRelativeCoords?: boolean } = {
            ...origEdge,
            sections: layoutedEdge.sections ?? [],
            labels: origEdge.labels?.map((label, idx) => {
              const layoutedLabel = layoutedEdge.labels?.[idx];
              if (layoutedLabel) {
                return {
                  ...label,
                  x: layoutedLabel.x ?? 0,
                  y: layoutedLabel.y ?? 0,
                  width: layoutedLabel.width ?? label.width ?? 50,
                  height: layoutedLabel.height ?? label.height ?? 14,
                };
              }
              return label;
            }),
          };
          // Preserve the _absoluteCoords flag for message flows
          if ((layoutedEdge as { _absoluteCoords?: boolean })._absoluteCoords) {
            mergedEdge._absoluteCoords = true;
          }
          // Preserve the _poolRelativeCoords flag for pool edges
          if ((layoutedEdge as { _poolRelativeCoords?: boolean })._poolRelativeCoords) {
            mergedEdge._poolRelativeCoords = true;
          }
          return mergedEdge;
        }
        return origEdge;
      });
    }

    // Merge labels
    if (original.labels && layouted.labels) {
      result.labels = original.labels.map((label, idx) => {
        const layoutedLabel = layouted.labels?.[idx];
        if (layoutedLabel) {
          return {
            ...label,
            x: layoutedLabel.x ?? 0,
            y: layoutedLabel.y ?? 0,
            width: layoutedLabel.width ?? label.width,
            height: layoutedLabel.height ?? label.height,
          };
        }
        return label;
      });
    }

    return result;
  }
}

// Internal type for nodes with bpmn field
interface NodeWithBpmn {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  bpmn: { type: string; name?: string; isExpanded?: boolean };
  layoutOptions?: ElkLayoutOptions;
  children?: (NodeWithBpmn | object)[];
  edges?: Array<{
    id: string;
    sources: string[];
    targets: string[];
    layoutOptions?: ElkLayoutOptions;
    labels?: Array<{ text?: string; width?: number; height?: number; x?: number; y?: number }>;
    sections?: unknown[];
  }>;
  boundaryEvents?: Array<{
    id: string;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    attachedToRef: string;
    bpmn: object;
    labels?: Array<{ text?: string }>;
  }>;
  labels?: Array<{ text?: string; width?: number; height?: number; x?: number; y?: number }>;
  ports?: Array<{ id: string; width?: number; height?: number; x?: number; y?: number }>;
  artifacts?: object[];
}
