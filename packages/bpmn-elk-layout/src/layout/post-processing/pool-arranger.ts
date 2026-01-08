/**
 * Pool Arranger
 * Handles rearranging pools (participants) within collaborations.
 * Uses ConstraintSolver for vertical stacking calculations.
 */

import type { ElkNode, ElkExtendedEdge } from 'elkjs';
import type { ElkBpmnGraph } from '../../types';
import type { NodeWithBpmn, Point, Bounds, ArtifactInfo } from '../../types/internal';
import { ARTIFACT_TYPES } from './artifact-positioner';
import { ConstraintSolver } from '../constraint';
import { isDebugEnabled, DEBUG } from '../../utils/debug';

/**
 * Handler for pool arrangement
 */
export class PoolArranger {
  private readonly poolHeaderWidth = 55;
  private readonly poolPaddingX = 25;
  private readonly poolPaddingY = 40;
  private readonly minPoolHeight = 100;
  private readonly poolExtraWidth = 140;
  private readonly poolExtraHeight = 80;

  /**
   * Rearrange pools within collaborations
   */
  rearrange(layouted: ElkNode, original: ElkBpmnGraph): void {
    if (!layouted.children) return;

    for (let i = 0; i < layouted.children.length; i++) {
      const child = layouted.children[i];
      const origChild = original.children?.[i] as NodeWithBpmn | undefined;

      // Check if this is a collaboration
      if (origChild?.bpmn?.type === 'collaboration' && child.children && child.children.length > 0) {
        // Check if this collaboration had cross-pool edges (nodes were flattened)
        const hasCrossPoolEdges = origChild.edges && origChild.edges.length > 0;
        const hasMultiplePools = ((origChild.children as NodeWithBpmn[] | undefined)?.filter(
          c => c.bpmn?.type === 'participant'
        ).length ?? 0) > 1;

        // Check if children were flattened
        const origPools = (origChild.children as NodeWithBpmn[] | undefined)?.filter(
          c => c.bpmn?.type === 'participant'
        ) ?? [];
        const poolIdsInLayouted = new Set(child.children.map(c => c.id));
        const poolsFoundInLayouted = origPools.filter(p => poolIdsInLayouted.has(p.id)).length;
        const childrenAreFlattened = poolsFoundInLayouted < origPools.length / 2;

        if (hasCrossPoolEdges && hasMultiplePools && childrenAreFlattened) {
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

    const pools: ElkNode[] = [];
    const origPoolMap = new Map<string, NodeWithBpmn>();

    // Collect pools and build original pool map
    for (const child of collab.children) {
      const origPool = origCollab.children?.find((c: unknown) => (c as NodeWithBpmn).id === child.id) as NodeWithBpmn | undefined;
      if (origPool?.bpmn?.type === 'participant') {
        pools.push(child);
        origPoolMap.set(child.id, origPool);
      }
    }

    if (pools.length === 0) return;

    // Sort pools by original order
    const poolOrder = new Map<string, number>();
    origCollab.children?.forEach((c: unknown, idx: number) => {
      const node = c as NodeWithBpmn;
      if (node.bpmn?.type === 'participant') {
        poolOrder.set(node.id, idx);
      }
    });
    pools.sort((a, b) => (poolOrder.get(a.id) ?? 0) - (poolOrder.get(b.id) ?? 0));

    // Calculate the maximum width needed
    let maxPoolWidth = 0;
    for (const pool of pools) {
      const origPool = origPoolMap.get(pool.id);
      const hasLanes = (origPool?.children as NodeWithBpmn[] | undefined)?.some(c => c.bpmn?.type === 'lane');
      if (hasLanes) {
        maxPoolWidth = Math.max(maxPoolWidth, pool.width ?? 680);
      } else {
        maxPoolWidth = Math.max(maxPoolWidth, (pool.width ?? 680) + this.poolExtraWidth);
      }
    }

    // Calculate heights and prepare pools
    const poolHeights = new Map<string, number>();
    for (const pool of pools) {
      const origPool = origPoolMap.get(pool.id);
      const isBlackBox = origPool?.bpmn?.isBlackBox === true;
      const hasLanes = (origPool?.children as NodeWithBpmn[] | undefined)?.some(c => c.bpmn?.type === 'lane');

      pool.width = maxPoolWidth;
      if (isBlackBox) {
        pool.height = 60;
      } else if (!hasLanes) {
        pool.height = (pool.height ?? 200) + this.poolExtraHeight;
        this.offsetPoolChildren(pool, this.poolExtraWidth / 2, this.poolExtraHeight / 2);
      }
      poolHeights.set(pool.id, pool.height ?? 200);
    }

    // Use ConstraintSolver for vertical stacking
    const solver = new ConstraintSolver();
    for (const pool of pools) {
      const height = poolHeights.get(pool.id) ?? 200;
      solver.addNode(pool.id, 0, 0, maxPoolWidth, height);
    }

    // Add below constraints for sequential stacking
    for (let i = 1; i < pools.length; i++) {
      solver.addConstraint({
        type: 'below',
        node: pools[i].id,
        reference: pools[i - 1].id,
        minGap: 0,
        strength: 'required',
      });
    }

    const positions = solver.solve();
    const nodePositions = new Map<string, Bounds>();

    // Apply solved positions
    let totalHeight = 0;
    for (const pool of pools) {
      const pos = positions.get(pool.id);
      pool.x = 0;
      pool.y = pos?.y ?? totalHeight;

      nodePositions.set(pool.id, {
        x: pool.x,
        y: pool.y,
        width: pool.width ?? 680,
        height: pool.height ?? 200,
      });

      this.collectNodePositionsInPool(pool, pool.x, pool.y, nodePositions);
      totalHeight = pool.y + (pool.height ?? 200);
    }

    // Update collaboration dimensions
    collab.width = maxPoolWidth;
    collab.height = totalHeight;

    // Recalculate message flows
    if (collab.edges && origCollab.edges) {
      this.recalculateMessageFlows(collab.edges, nodePositions, pools, origCollab.edges);
    }
  }

  /**
   * Rearrange collaboration with cross-pool edges
   */
  private rearrangeCollaborationWithCrossPoolEdges(
    collab: ElkNode,
    origCollab: NodeWithBpmn
  ): void {
    if (!collab.children || !origCollab.children) return;

    // Build map of node ID -> pool ID and identify artifacts
    const nodeToPool = new Map<string, string>();
    const artifactIds = new Set<string>();

    for (const origPool of origCollab.children as NodeWithBpmn[]) {
      if (origPool.bpmn?.type === 'participant' && origPool.children) {
        const hasLanes = origPool.children.some((c: unknown) => (c as NodeWithBpmn).bpmn?.type === 'lane');
        if (hasLanes) {
          const mapNodesInLanes = (children: NodeWithBpmn[]) => {
            for (const child of children) {
              if (child.bpmn?.type === 'lane') {
                if (child.children) mapNodesInLanes(child.children as NodeWithBpmn[]);
              } else {
                nodeToPool.set(child.id, origPool.id);
                if (ARTIFACT_TYPES.has(child.bpmn?.type)) {
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
            if (ARTIFACT_TYPES.has(childNode.bpmn?.type)) {
              artifactIds.add(childNode.id);
            }
          }
        }
      }
    }

    // Get layouted nodes
    const layoutedNodes = new Map<string, ElkNode>();
    for (const child of collab.children) {
      layoutedNodes.set(child.id, child);
    }

    // Group nodes by pool and calculate X bounds
    const poolNodesMap = new Map<string, ElkNode[]>();
    const poolXBounds = new Map<string, { minX: number; maxX: number }>();
    let globalMinX = Infinity;

    for (const [nodeId, poolId] of nodeToPool) {
      const node = layoutedNodes.get(nodeId);
      if (!node) continue;

      if (!poolNodesMap.has(poolId)) {
        poolNodesMap.set(poolId, []);
      }
      poolNodesMap.get(poolId)!.push(node);

      if (!artifactIds.has(nodeId)) {
        const x = node.x ?? 0;
        const w = node.width ?? 100;
        const bounds = poolXBounds.get(poolId) ?? { minX: Infinity, maxX: 0 };
        bounds.minX = Math.min(bounds.minX, x);
        bounds.maxX = Math.max(bounds.maxX, x + w);
        poolXBounds.set(poolId, bounds);
        globalMinX = Math.min(globalMinX, x);
      }
    }

    // Sort pools by original order
    const origPools = (origCollab.children as NodeWithBpmn[]).filter(c => c.bpmn?.type === 'participant');
    origPools.sort((a, b) => {
      const partA = a.layoutOptions?.['elk.partitioning.partition'];
      const partB = b.layoutOptions?.['elk.partitioning.partition'];
      if (partA !== undefined && partB !== undefined) {
        return Number(partA) - Number(partB);
      }
      return 0;
    });

    // Calculate max content width
    let globalMaxX = 0;
    for (const bounds of poolXBounds.values()) {
      globalMaxX = Math.max(globalMaxX, bounds.maxX);
    }
    const maxContentWidth = globalMaxX - globalMinX;
    const poolWidth = this.poolHeaderWidth + maxContentWidth + this.poolPaddingX * 2;

    // Build pool structures
    const pools: ElkNode[] = [];
    let currentY = 0;

    for (const origPool of origPools) {
      const poolNodes = poolNodesMap.get(origPool.id) ?? [];
      const isBlackBox = origPool.bpmn?.isBlackBox === true || !origPool.children?.length;

      if (isBlackBox) {
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
        const regularNodes = poolNodes.filter(n => !artifactIds.has(n.id));
        const artifactNodes = poolNodes.filter(n => artifactIds.has(n.id));

        let maxNodeHeight = 0;
        for (const node of regularNodes) {
          maxNodeHeight = Math.max(maxNodeHeight, node.height ?? 80);
        }
        const poolHeight = Math.max(this.minPoolHeight, maxNodeHeight + this.poolPaddingY * 2);

        const adjustedNodes: ElkNode[] = [];
        for (const node of regularNodes) {
          const nodeHeight = node.height ?? 80;
          const newY = (poolHeight - nodeHeight) / 2;
          const newX = this.poolHeaderWidth + (node.x ?? 0) - globalMinX + this.poolPaddingX;

          adjustedNodes.push({
            ...node,
            x: newX,
            y: newY,
          });
        }

        // Position artifacts
        for (const artifact of artifactNodes) {
          const { task: associatedTask, isInput } = this.findArtifactAssociatedTask(
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

            const newX = taskX + taskWidth + 15;
            const newY = taskY + (taskHeight - artifactHeight) / 2;

            adjustedNodes.push({
              ...artifact,
              x: newX,
              y: Math.max(5, newY),
            });
          } else {
            const newX = this.poolHeaderWidth + (artifact.x ?? 0) - globalMinX + this.poolPaddingX;
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

    // Recalculate edges
    if (collab.edges) {
      const nodePositions = new Map<string, Bounds>();

      for (const pool of pools) {
        const poolX = pool.x ?? 0;
        const poolY = pool.y ?? 0;

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

  /**
   * Offset all children within a pool
   */
  private offsetPoolChildren(pool: ElkNode, offsetX: number, offsetY: number): void {
    if (!pool.children) return;

    for (const child of pool.children) {
      if (child.x !== undefined) {
        child.x += offsetX;
      }
      if (child.y !== undefined) {
        child.y += offsetY;
      }
      this.offsetPoolChildren(child, 0, 0);
    }

    if (pool.edges) {
      for (const edge of pool.edges) {
        if (edge.sections) {
          for (const section of edge.sections) {
            if (section.startPoint) {
              section.startPoint.x += offsetX;
              section.startPoint.y += offsetY;
            }
            if (section.endPoint) {
              section.endPoint.x += offsetX;
              section.endPoint.y += offsetY;
            }
            if (section.bendPoints) {
              for (const bp of section.bendPoints) {
                bp.x += offsetX;
                bp.y += offsetY;
              }
            }
          }
        }
      }
    }
  }

  /**
   * Collect node positions within a pool
   */
  private collectNodePositionsInPool(
    container: ElkNode,
    offsetX: number,
    offsetY: number,
    positions: Map<string, Bounds>
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

      this.collectNodePositionsInPool(child, absX, absY, positions);
    }
  }

  /**
   * Recalculate message flows after pools have been repositioned
   */
  private recalculateMessageFlows(
    edges: ElkExtendedEdge[],
    nodePositions: Map<string, Bounds>,
    pools: ElkNode[],
    originalEdges?: Array<{ id: string; sources: string[]; targets: string[]; bpmn?: { type?: string } }>
  ): void {
    const edgeTypeMap = new Map<string, string>();
    if (originalEdges) {
      for (const origEdge of originalEdges) {
        if (origEdge.bpmn?.type) {
          edgeTypeMap.set(origEdge.id, origEdge.bpmn.type);
        }
      }
    }

    // Identify blackbox pools (pools with no children or very small height)
    const blackboxPoolIds = new Set<string>();
    for (const pool of pools) {
      const isBlackbox = !pool.children || pool.children.length === 0 || (pool.height ?? 0) <= 80;
      if (isBlackbox) {
        blackboxPoolIds.add(pool.id);
      }
    }

    for (const edge of edges) {
      const sourceId = edge.sources?.[0];
      const targetId = edge.targets?.[0];
      const edgeType = edgeTypeMap.get(edge.id) ?? (edge as { bpmn?: { type?: string } }).bpmn?.type;

      const sourcePos = sourceId ? nodePositions.get(sourceId) : undefined;
      const targetPos = targetId ? nodePositions.get(targetId) : undefined;

      if (!sourcePos || !targetPos) continue;

      const isSequenceFlow = edgeType === 'sequenceFlow';
      const isMessageFlow = edgeType === 'messageFlow';
      const isDataAssociation = edgeType === 'dataInputAssociation' || edgeType === 'dataOutputAssociation';

      const waypoints: Point[] = [];

      if (isSequenceFlow) {
        this.createSequenceFlowWaypoints(sourcePos, targetPos, waypoints);
      } else if (isMessageFlow) {
        this.createMessageFlowWaypoints(sourcePos, targetPos, waypoints, nodePositions, targetId, sourceId, blackboxPoolIds);
      } else if (isDataAssociation) {
        (edge as ElkExtendedEdge & { _absoluteCoords?: boolean })._absoluteCoords = true;
        edge.sections = [];
        continue;
      } else {
        this.createSequenceFlowWaypoints(sourcePos, targetPos, waypoints);
      }

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
   * Create waypoints for sequence flows
   */
  private createSequenceFlowWaypoints(
    sourcePos: Bounds,
    targetPos: Bounds,
    waypoints: Point[]
  ): void {
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
        const startX = sourcePos.x + sourcePos.width;
        const startY = sourceCenterY;
        const endX = targetPos.x;
        const endY = targetCenterY;

        waypoints.push({ x: startX, y: startY });
        if (Math.abs(startY - endY) > 10) {
          const midX = (startX + endX) / 2;
          waypoints.push({ x: midX, y: startY });
          waypoints.push({ x: midX, y: endY });
        }
        waypoints.push({ x: endX, y: endY });
      } else if (goingDown) {
        const startX = sourceCenterX;
        const startY = sourcePos.y + sourcePos.height;
        const endX = targetPos.x;
        const endY = targetCenterY;

        waypoints.push({ x: startX, y: startY });
        waypoints.push({ x: startX, y: endY });
        waypoints.push({ x: endX, y: endY });
      } else {
        const startX = sourceCenterX;
        const startY = sourcePos.y;
        const endX = targetPos.x;
        const endY = targetCenterY;

        waypoints.push({ x: startX, y: startY });
        waypoints.push({ x: startX, y: endY });
        waypoints.push({ x: endX, y: endY });
      }
    } else {
      const startX = sourcePos.x;
      const startY = sourceCenterY;
      const endX = targetPos.x + targetPos.width;
      const endY = targetCenterY;

      waypoints.push({ x: startX, y: startY });

      const loopY = Math.max(sourcePos.y + sourcePos.height, targetPos.y + targetPos.height) + 30;
      waypoints.push({ x: startX, y: loopY });
      waypoints.push({ x: endX, y: loopY });

      waypoints.push({ x: endX, y: endY });
    }
  }

  /**
   * Create waypoints for message flows
   * Routes message flows to avoid being too close to other nodes in the target pool
   */
  private createMessageFlowWaypoints(
    sourcePos: Bounds,
    targetPos: Bounds,
    waypoints: Point[],
    nodePositions: Map<string, Bounds>,
    targetId?: string,
    sourceId?: string,
    blackboxPoolIds?: Set<string>
  ): void {
    let startX: number, startY: number, endX: number, endY: number;

    const goingDown = sourcePos.y + sourcePos.height < targetPos.y;

    // Check if target/source is a blackbox participant using the passed set
    const isTargetBlackbox = targetId ? blackboxPoolIds?.has(targetId) ?? false : false;
    const isSourceBlackbox = sourceId ? blackboxPoolIds?.has(sourceId) ?? false : false;

    if (goingDown) {
      startX = sourcePos.x + sourcePos.width / 2;
      startY = sourcePos.y + sourcePos.height;

      // For blackbox targets, prefer connecting directly below the source if within target's X range
      if (isTargetBlackbox) {
        const targetLeft = targetPos.x;
        const targetRight = targetPos.x + targetPos.width;
        // Use source's X if it falls within target's range (with some margin)
        if (startX >= targetLeft + 20 && startX <= targetRight - 20) {
          endX = startX;
        } else {
          endX = targetPos.x + targetPos.width / 2;
        }
      } else {
        endX = targetPos.x + targetPos.width / 2;
      }
      endY = targetPos.y;
    } else {
      startX = sourcePos.x + sourcePos.width / 2;
      startY = sourcePos.y;

      // For blackbox targets, prefer connecting directly above the source if within target's X range
      if (isTargetBlackbox) {
        const targetLeft = targetPos.x;
        const targetRight = targetPos.x + targetPos.width;
        if (startX >= targetLeft + 20 && startX <= targetRight - 20) {
          endX = startX;
        } else {
          endX = targetPos.x + targetPos.width / 2;
        }
      } else {
        endX = targetPos.x + targetPos.width / 2;
      }
      endY = targetPos.y + targetPos.height;
    }

    // Similarly, for blackbox sources, adjust startX to align with endX if possible
    if (isSourceBlackbox) {
      const sourceLeft = sourcePos.x;
      const sourceRight = sourcePos.x + sourcePos.width;
      if (endX >= sourceLeft + 20 && endX <= sourceRight - 20) {
        startX = endX;
      }
    }

    // Patterns to identify containers (pools, lanes, etc.) vs flow nodes
    const containerPatterns = [/^pool_/, /^participant_/, /^lane_/, /^process_/, /^collaboration_/];
    const minClearance = 25; // Minimum distance to keep from nodes

    // Calculate the Y range of source and target pools (approximate)
    const sourcePoolYMin = sourcePos.y - 50;
    const sourcePoolYMax = sourcePos.y + sourcePos.height + 50;
    const targetPoolYMin = targetPos.y - 50;
    const targetPoolYMax = targetPos.y + targetPos.height + 50;

    // First, check if a straight vertical line from startX would hit any obstacles
    // This applies to ALL message flows, not just those with horizontal distance
    const fullVerticalMinY = Math.min(startY, endY);
    const fullVerticalMaxY = Math.max(startY, endY);

    // Collect all nodes that would block a straight vertical path at startX
    const nodesBlockingDirectPath: Array<{ id: string; bounds: Bounds }> = [];
    for (const [nodeId, bounds] of nodePositions) {
      if (nodeId === targetId || nodeId === sourceId) continue;

      // Skip container nodes
      const isContainer = containerPatterns.some(pattern => pattern.test(nodeId));
      if (isContainer) continue;

      const nodeLeft = bounds.x;
      const nodeRight = bounds.x + bounds.width;
      const nodeTop = bounds.y;
      const nodeBottom = bounds.y + bounds.height;

      // Skip nodes in source/target pool
      const inSourcePool = nodeTop >= sourcePoolYMin && nodeBottom <= sourcePoolYMax;
      const inTargetPool = nodeTop >= targetPoolYMin && nodeBottom <= targetPoolYMax;
      if (inSourcePool || inTargetPool) continue;

      // Check if node blocks the vertical line at startX
      const overlapsVerticalLine = startX >= nodeLeft - minClearance && startX <= nodeRight + minClearance;
      const nodeInVerticalRange = nodeBottom > fullVerticalMinY && nodeTop < fullVerticalMaxY;

      if (overlapsVerticalLine && nodeInVerticalRange) {
        nodesBlockingDirectPath.push({ id: nodeId, bounds });
      }
    }

    // If there are obstacles in the direct path, we need to find a clear route
    let finalRouteX = startX;
    if (nodesBlockingDirectPath.length > 0) {
      // Find a clear X position that avoids ALL obstacles in the vertical path
      // Try both left and right directions and pick the one with smaller shift

      // Collect all obstacle X ranges
      const allObstacles: Array<{ left: number; right: number }> = [];
      for (const { bounds } of nodesBlockingDirectPath) {
        allObstacles.push({
          left: bounds.x - minClearance,
          right: bounds.x + bounds.width + minClearance,
        });
      }

      // Also check for other nodes that might be in the way at potential route positions
      // We need to find a gap that's clear all the way down
      for (const [nodeId, bounds] of nodePositions) {
        if (nodeId === targetId || nodeId === sourceId) continue;
        const isContainer = containerPatterns.some(pattern => pattern.test(nodeId));
        if (isContainer) continue;

        const nodeTop = bounds.y;
        const nodeBottom = bounds.y + bounds.height;
        const inSourcePool = nodeTop >= sourcePoolYMin && nodeBottom <= sourcePoolYMax;
        const inTargetPool = nodeTop >= targetPoolYMin && nodeBottom <= targetPoolYMax;
        if (inSourcePool || inTargetPool) continue;

        const nodeInVerticalRange = nodeBottom > fullVerticalMinY && nodeTop < fullVerticalMaxY;
        if (nodeInVerticalRange) {
          allObstacles.push({
            left: bounds.x - minClearance,
            right: bounds.x + bounds.width + minClearance,
          });
        }
      }

      // Sort obstacles by left edge
      allObstacles.sort((a, b) => a.left - b.left);

      // Merge overlapping obstacles
      const mergedObstacles: Array<{ left: number; right: number }> = [];
      for (const obs of allObstacles) {
        if (mergedObstacles.length === 0) {
          mergedObstacles.push({ ...obs });
        } else {
          const last = mergedObstacles[mergedObstacles.length - 1];
          if (obs.left <= last.right) {
            last.right = Math.max(last.right, obs.right);
          } else {
            mergedObstacles.push({ ...obs });
          }
        }
      }

      // Find the best route X - either to the left of all obstacles or to the right
      // or in a gap between obstacles
      let bestRouteX = startX;
      let bestShift = Infinity;

      // Option 1: Go to the left of all obstacles
      if (mergedObstacles.length > 0) {
        const leftMost = mergedObstacles[0].left;
        if (leftMost > 20) { // Make sure we don't go off the diagram
          const shiftNeeded = Math.abs(startX - leftMost);
          if (shiftNeeded < bestShift) {
            bestShift = shiftNeeded;
            bestRouteX = leftMost;
          }
        }
      }

      // Option 2: Go to the right of all obstacles
      if (mergedObstacles.length > 0) {
        const rightMost = mergedObstacles[mergedObstacles.length - 1].right;
        const shiftNeeded = Math.abs(startX - rightMost);
        if (shiftNeeded < bestShift) {
          bestShift = shiftNeeded;
          bestRouteX = rightMost;
        }
      }

      // Option 3: Find a gap between obstacles that's close to startX
      for (let i = 0; i < mergedObstacles.length - 1; i++) {
        const gapLeft = mergedObstacles[i].right;
        const gapRight = mergedObstacles[i + 1].left;
        const gapWidth = gapRight - gapLeft;

        if (gapWidth >= 10) { // Minimum gap width
          const gapCenter = (gapLeft + gapRight) / 2;
          const shiftNeeded = Math.abs(startX - gapCenter);
          if (shiftNeeded < bestShift) {
            bestShift = shiftNeeded;
            bestRouteX = gapCenter;
          }
        }
      }

      finalRouteX = bestRouteX;
    }

    // Now determine if we need horizontal routing
    const horizontalDist = Math.abs(startX - endX);

    waypoints.push({ x: startX, y: startY });

    // Check if we need to route around obstacles (finalRouteX differs from startX)
    // This only applies when startX and endX are close (blackbox case)
    const needsObstacleAvoidance = Math.abs(finalRouteX - startX) > 5 && horizontalDist <= 5;

    if (needsObstacleAvoidance) {
      // Route around obstacles for blackbox: go horizontally to finalRouteX, then vertically, then horizontally to endX
      waypoints.push({ x: finalRouteX, y: startY });
      waypoints.push({ x: finalRouteX, y: endY });
      if (Math.abs(finalRouteX - endX) > 5) {
        waypoints.push({ x: endX, y: endY });
      }
    } else if (horizontalDist > 5) {
      // Normal horizontal routing (source and target at different X)
      let routeY = horizontalDist > 200 ? endY - 20 : (startY + endY) / 2;

      // Adjust routeY to avoid nodes in the horizontal path
      if (targetId) {
        const minX = Math.min(startX, endX);
        const maxX = Math.max(startX, endX);

        for (const [nodeId, bounds] of nodePositions) {
          if (nodeId === targetId || nodeId === sourceId) continue;

          const nodeLeft = bounds.x;
          const nodeRight = bounds.x + bounds.width;
          const nodeTop = bounds.y;
          const nodeBottom = bounds.y + bounds.height;

          const overlapsHorizontally = nodeRight > minX && nodeLeft < maxX;

          if (overlapsHorizontally) {
            if (goingDown) {
              if (routeY >= nodeTop && routeY <= nodeBottom) {
                routeY = Math.min(routeY, nodeTop - minClearance);
              } else if (nodeTop > startY && nodeTop < endY) {
                routeY = Math.min(routeY, nodeTop - minClearance);
              }
            } else {
              if (routeY >= nodeTop && routeY <= nodeBottom) {
                routeY = Math.min(routeY, nodeTop - minClearance);
              } else if (nodeTop < startY && nodeBottom > endY) {
                routeY = Math.min(routeY, nodeTop - minClearance);
              }
            }
          }
        }

        // Keep routeY in reasonable range
        if (goingDown) {
          routeY = Math.max(routeY, startY + 10);
          routeY = Math.min(routeY, endY - 10);
        } else {
          routeY = Math.max(routeY, endY + 10);
          routeY = Math.min(routeY, startY - 10);
        }
      }

      waypoints.push({ x: startX, y: routeY });
      waypoints.push({ x: endX, y: routeY });
      waypoints.push({ x: endX, y: endY });
    } else {
      // Direct vertical path - no obstacles and same X position
      waypoints.push({ x: endX, y: endY });
    }
  }

  /**
   * Find the task associated with an artifact
   */
  private findArtifactAssociatedTask(
    artifactId: string,
    edges: Array<{ id: string; sources: string[]; targets: string[]; bpmn?: { type?: string } }>,
    adjustedNodes: ElkNode[]
  ): { task: ElkNode | undefined; isInput: boolean } {
    const nodeMap = new Map<string, ElkNode>();
    for (const node of adjustedNodes) {
      nodeMap.set(node.id, node);
    }

    for (const edge of edges) {
      const edgeType = edge.bpmn?.type;

      if (edgeType === 'dataInputAssociation' || edgeType === 'association') {
        if (edge.sources.includes(artifactId)) {
          const targetId = edge.targets[0];
          const targetNode = nodeMap.get(targetId);
          if (targetNode) return { task: targetNode, isInput: true };
        }
      }

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
}
