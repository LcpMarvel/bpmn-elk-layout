/**
 * ELK Layout Engine Wrapper
 */

import ELK from 'elkjs';
import type { ElkNode, ElkExtendedEdge, LayoutOptions } from 'elkjs';
import type { ElkBpmnGraph, ElkLayoutOptions } from '../types';
import type { LayoutedGraph } from '../types/elk-output';
import { mergeElkOptions } from './default-options';
import { applyDefaultSizesToGraph } from './size-defaults';

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
   * Recalculate a single artifact edge
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

    // Collect all boundary events with targets and sort by their attached node's x position
    const boundaryEventsWithTargets: Array<{
      beId: string;
      info: { attachedToRef: string; targets: string[]; boundaryIndex: number; totalBoundaries: number };
      attachedNode: ElkNode;
    }> = [];

    for (const [beId, info] of boundaryEventInfo) {
      if (info.targets.length === 0) continue;
      const attachedNode = nodeMap.get(info.attachedToRef);
      if (!attachedNode || attachedNode.y === undefined || attachedNode.height === undefined) continue;
      boundaryEventsWithTargets.push({ beId, info, attachedNode });
    }

    // Sort by attached node's x position to determine horizontal ordering
    boundaryEventsWithTargets.sort((a, b) => (a.attachedNode.x ?? 0) - (b.attachedNode.x ?? 0));

    // Track used y positions to avoid vertical overlap
    const usedYRanges: Array<{ minY: number; maxY: number; x: number }> = [];

    // For each boundary event, check if targets need repositioning
    for (const beEntry of boundaryEventsWithTargets) {
      const { info, attachedNode } = beEntry;

      const attachedBottom = attachedNode.y! + attachedNode.height!;
      const attachedX = attachedNode.x ?? 0;
      const attachedWidth = attachedNode.width ?? 100;

      // Calculate boundary event position (same logic as model-builder.ts)
      const spacing = attachedWidth / (info.totalBoundaries + 1);
      const beX = attachedX + spacing * (info.boundaryIndex + 1);

      // Boundary event extends 18px below task (beHeight/2 for 36px boundary event)
      const beBottom = attachedBottom + 18;
      // Minimum gap between boundary event bottom and target top
      const minGap = 35;
      const minTargetY = beBottom + minGap;

      for (const targetId of info.targets) {
        const targetNode = nodeMap.get(targetId);
        if (!targetNode || targetNode.y === undefined) continue;

        const targetWidth = targetNode.width ?? 100;
        const targetHeight = targetNode.height ?? 80;

        // Calculate new x position: align target's center with boundary event's center
        // but offset slightly based on order to avoid complete stacking
        const newX = beX - targetWidth / 2;

        // Calculate new y position
        let newY = targetNode.y;
        if (targetNode.y < minTargetY) {
          newY = minTargetY;
        }

        // Check for vertical overlap with previously placed targets and adjust
        for (const range of usedYRanges) {
          // Check if there's horizontal and vertical overlap
          const horizontalOverlap = Math.abs(newX - range.x) < targetWidth + 20;
          const verticalOverlap = newY < range.maxY + 20 && newY + targetHeight > range.minY - 20;

          if (horizontalOverlap && verticalOverlap) {
            // Move this target below the conflicting one
            newY = range.maxY + 40;
          }
        }

        const offset = newY - (targetNode.y ?? 0);
        movedNodes.set(targetId, { newY, offset, newX });

        // Record the y range used by this target
        usedYRanges.push({ minY: newY, maxY: newY + targetHeight, x: newX });

        // Also move downstream nodes by the same y offset and aligned horizontally
        this.propagateMovement(targetId, offset, nodeMap, edgeMap, movedNodes, newX);
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

    // Get boundary event attached node IDs (obstacles to avoid)
    const obstacleIds = new Set<string>();
    for (const [, info] of boundaryEventInfo) {
      obstacleIds.add(info.attachedToRef);
    }

    // Find and recalculate edges in each node
    const processEdges = (node: ElkNode) => {
      if (node.edges) {
        for (const edge of node.edges) {
          const sourceId = edge.sources?.[0];
          const targetId = edge.targets?.[0];

          // Recalculate if source OR target was moved
          const sourceMoved = sourceId && movedNodes.has(sourceId);
          const targetMoved = targetId && movedNodes.has(targetId);

          if (sourceMoved || targetMoved) {
            const sourceNode = nodeMap.get(sourceId);
            const targetNode = nodeMap.get(targetId);

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

      // Route with orthogonal bend
      const midY = (startY + endY) / 2;
      waypoints.push({ x: startX, y: midY });
      waypoints.push({ x: endX, y: midY });

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
      (result as { boundaryEvents: unknown[] }).boundaryEvents = (result as { boundaryEvents: object[] }).boundaryEvents.map(
        (be) => this.applyDefaultSizesRecursive(be)
      );
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
    const layoutOptions = mergeElkOptions(this.userOptions, graph.layoutOptions);

    return {
      id: graph.id,
      layoutOptions: layoutOptions as LayoutOptions,
      children: this.prepareChildrenForElk(graph.children),
    };
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
  private rearrangePools(layouted: ElkNode, original: ElkBpmnGraph): void {
    // Find collaboration nodes
    if (!layouted.children) return;

    for (let i = 0; i < layouted.children.length; i++) {
      const child = layouted.children[i];
      const origChild = original.children?.[i] as NodeWithBpmn | undefined;

      // Check if this is a collaboration
      if (origChild?.bpmn?.type === 'collaboration' && child.children && child.children.length > 0) {
        this.stackPoolsVertically(child, origChild);
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

    // Recalculate message flow edges
    if (collab.edges) {
      this.recalculateMessageFlows(collab.edges, nodePositions, pools);
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
   * Recalculate message flow waypoints after pools have been repositioned
   * Waypoints are calculated as absolute coordinates, then we store a marker
   * to indicate model-builder should NOT add additional offsets
   */
  private recalculateMessageFlows(
    edges: ElkExtendedEdge[],
    nodePositions: Map<string, { x: number; y: number; width: number; height: number }>,
    pools: ElkNode[]
  ): void {
    for (const edge of edges) {
      const sourceId = edge.sources?.[0];
      const targetId = edge.targets?.[0];

      const sourcePos = sourceId ? nodePositions.get(sourceId) : undefined;
      const targetPos = targetId ? nodePositions.get(targetId) : undefined;

      if (!sourcePos || !targetPos) continue;

      // Determine connection points based on relative positions
      let startX: number, startY: number, endX: number, endY: number;

      // Message flows typically go between pools (vertically)
      // Source is usually above target or vice versa
      if (sourcePos.y + sourcePos.height < targetPos.y) {
        // Source is above target - connect bottom of source to top of target
        startX = sourcePos.x + sourcePos.width / 2;
        startY = sourcePos.y + sourcePos.height;
        endX = targetPos.x + targetPos.width / 2;
        endY = targetPos.y;
      } else if (targetPos.y + targetPos.height < sourcePos.y) {
        // Target is above source - connect top of source to bottom of target
        startX = sourcePos.x + sourcePos.width / 2;
        startY = sourcePos.y;
        endX = targetPos.x + targetPos.width / 2;
        endY = targetPos.y + targetPos.height;
      } else {
        // Same vertical level - connect right/left
        if (sourcePos.x < targetPos.x) {
          startX = sourcePos.x + sourcePos.width;
          startY = sourcePos.y + sourcePos.height / 2;
          endX = targetPos.x;
          endY = targetPos.y + targetPos.height / 2;
        } else {
          startX = sourcePos.x;
          startY = sourcePos.y + sourcePos.height / 2;
          endX = targetPos.x + targetPos.width;
          endY = targetPos.y + targetPos.height / 2;
        }
      }

      // Build waypoints - for vertical message flows, use direct path or L-shaped
      const waypoints: Array<{ x: number; y: number }> = [];
      waypoints.push({ x: startX, y: startY });

      // If horizontal distance is significant, add bend points for cleaner routing
      const horizontalDist = Math.abs(startX - endX);
      const verticalDist = Math.abs(startY - endY);

      if (horizontalDist > 20 && verticalDist > 20) {
        // L-shaped routing for message flows
        const midY = (startY + endY) / 2;
        waypoints.push({ x: startX, y: midY });
        waypoints.push({ x: endX, y: midY });
      }

      waypoints.push({ x: endX, y: endY });

      // Update edge sections
      // Mark this edge as having absolute coordinates (model-builder should not add offset)
      (edge as ElkExtendedEdge & { _absoluteCoords?: boolean })._absoluteCoords = true;
      edge.sections = [{
        id: `${edge.id}_s0`,
        startPoint: { x: startX, y: startY },
        endPoint: { x: endX, y: endY },
        bendPoints: waypoints.length > 2 ? waypoints.slice(1, -1) : undefined,
      }];

      // Update label positions to be centered on the message flow
      if (edge.labels && edge.labels.length > 0) {
        const midX = (startX + endX) / 2;
        const midY = (startY + endY) / 2;
        for (const label of edge.labels) {
          const labelWidth = label.width ?? 50;
          const labelHeight = label.height ?? 14;
          label.x = midX - labelWidth / 2;
          label.y = midY - labelHeight / 2 - 10; // Offset above the line
        }
      }
    }
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

    // Merge children
    if (original.children && layouted.children) {
      result.children = original.children.map((origChild, index) => {
        const layoutedChild = layouted.children?.[index];
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
