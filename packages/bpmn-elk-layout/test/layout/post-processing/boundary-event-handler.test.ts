import { describe, it, expect } from 'vitest';
import { BoundaryEventHandler } from '../../../src/layout/post-processing/boundary-event';
import type { ElkBpmnGraph } from '../../../src/types';
import type { ElkNode } from 'elkjs';

describe('BoundaryEventHandler', () => {
  const handler = new BoundaryEventHandler();

  describe('collectInfo', () => {
    it('should collect boundary event info from graph', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              {
                id: 'task1',
                bpmn: { type: 'task', name: 'Task 1' },
                boundaryEvents: [
                  { id: 'be1', attachedToRef: 'task1', bpmn: { type: 'boundaryEvent' } },
                  { id: 'be2', attachedToRef: 'task1', bpmn: { type: 'boundaryEvent' } },
                ],
              },
              { id: 'errorHandler', bpmn: { type: 'task', name: 'Error Handler' } },
            ],
            edges: [
              { id: 'edge1', sources: ['be1'], targets: ['errorHandler'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const info = handler.collectInfo(graph);

      expect(info.size).toBe(2);
      expect(info.get('be1')).toEqual({
        attachedToRef: 'task1',
        targets: ['errorHandler'],
        boundaryIndex: 0,
        totalBoundaries: 2,
      });
      expect(info.get('be2')).toEqual({
        attachedToRef: 'task1',
        targets: [],
        boundaryIndex: 1,
        totalBoundaries: 2,
      });
    });

    it('should handle graph with no boundary events', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'task1', bpmn: { type: 'task' } },
              { id: 'task2', bpmn: { type: 'task' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const info = handler.collectInfo(graph);
      expect(info.size).toBe(0);
    });

    it('should collect multiple targets for a boundary event', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              {
                id: 'task1',
                bpmn: { type: 'task' },
                boundaryEvents: [
                  { id: 'be1', attachedToRef: 'task1', bpmn: { type: 'boundaryEvent' } },
                ],
              },
              { id: 'handler1', bpmn: { type: 'task' } },
              { id: 'handler2', bpmn: { type: 'task' } },
            ],
            edges: [
              { id: 'edge1', sources: ['be1'], targets: ['handler1'], bpmn: { type: 'sequenceFlow' } },
              { id: 'edge2', sources: ['be1'], targets: ['handler2'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const info = handler.collectInfo(graph);
      expect(info.get('be1')?.targets).toEqual(['handler1', 'handler2']);
    });
  });

  describe('identifyNodesToMove', () => {
    it('should identify target nodes that need to be moved', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'task1',
            x: 100,
            y: 50,
            width: 100,
            height: 80,
          },
          {
            id: 'errorHandler',
            x: 250,
            y: 50,
            width: 100,
            height: 80,
          },
        ],
        edges: [
          { id: 'edge1', sources: ['be1'], targets: ['errorHandler'] },
        ],
      };

      // sizedGraph with BPMN type information
      const sizedGraph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'task1', bpmn: { type: 'task' } },
              { id: 'errorHandler', bpmn: { type: 'task' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const boundaryEventInfo = new Map([
        ['be1', {
          attachedToRef: 'task1',
          targets: ['errorHandler'],
          boundaryIndex: 0,
          totalBoundaries: 1,
        }],
      ]);

      const movedNodes = handler.identifyNodesToMove(graph, boundaryEventInfo, sizedGraph);

      expect(movedNodes.size).toBe(1);
      expect(movedNodes.has('errorHandler')).toBe(true);

      const moveInfo = movedNodes.get('errorHandler')!;
      // Target should be moved below the boundary event
      expect(moveInfo.newY).toBeGreaterThan(50 + 80); // Below task1 bottom
      expect(moveInfo.offset).toBeGreaterThan(0);
      expect(moveInfo.newX).toBeDefined();
    });

    it('should handle multiple boundary events on same task', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'task1',
            x: 100,
            y: 50,
            width: 150,
            height: 80,
          },
          {
            id: 'handler1',
            x: 120,
            y: 50,
            width: 100,
            height: 80,
          },
          {
            id: 'handler2',
            x: 230,
            y: 50,
            width: 100,
            height: 80,
          },
        ],
        edges: [
          { id: 'edge1', sources: ['be1'], targets: ['handler1'] },
          { id: 'edge2', sources: ['be2'], targets: ['handler2'] },
        ],
      };

      // sizedGraph with BPMN type information
      const sizedGraph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'task1', bpmn: { type: 'task' } },
              { id: 'handler1', bpmn: { type: 'task' } },
              { id: 'handler2', bpmn: { type: 'task' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const boundaryEventInfo = new Map([
        ['be1', {
          attachedToRef: 'task1',
          targets: ['handler1'],
          boundaryIndex: 0,
          totalBoundaries: 2,
        }],
        ['be2', {
          attachedToRef: 'task1',
          targets: ['handler2'],
          boundaryIndex: 1,
          totalBoundaries: 2,
        }],
      ]);

      const movedNodes = handler.identifyNodesToMove(graph, boundaryEventInfo, sizedGraph);

      expect(movedNodes.size).toBe(2);
      expect(movedNodes.has('handler1')).toBe(true);
      expect(movedNodes.has('handler2')).toBe(true);
    });

    it('should return empty map when no boundary events have targets', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'task1',
            x: 100,
            y: 50,
            width: 100,
            height: 80,
          },
        ],
      };

      // sizedGraph with BPMN type information
      const sizedGraph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'task1', bpmn: { type: 'task' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const boundaryEventInfo = new Map([
        ['be1', {
          attachedToRef: 'task1',
          targets: [],
          boundaryIndex: 0,
          totalBoundaries: 1,
        }],
      ]);

      const movedNodes = handler.identifyNodesToMove(graph, boundaryEventInfo, sizedGraph);
      expect(movedNodes.size).toBe(0);
    });
  });

  describe('applyNodeMoves', () => {
    it('should apply node moves to graph', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'task1', x: 100, y: 50, width: 100, height: 80 },
          { id: 'handler', x: 250, y: 50, width: 100, height: 80 },
        ],
      };

      const movedNodes = new Map([
        ['handler', { newY: 200, offset: 150, newX: 150 }],
      ]);

      handler.applyNodeMoves(graph, movedNodes);

      const handlerNode = graph.children?.find(c => c.id === 'handler');
      expect(handlerNode?.y).toBe(200);
      expect(handlerNode?.x).toBe(150);
    });

    it('should apply moves to nested nodes', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process',
            children: [
              { id: 'handler', x: 100, y: 50, width: 100, height: 80 },
            ],
          },
        ],
      };

      const movedNodes = new Map([
        ['handler', { newY: 200, offset: 150 }],
      ]);

      handler.applyNodeMoves(graph, movedNodes);

      const processNode = graph.children?.[0];
      const handlerNode = processNode?.children?.find(c => c.id === 'handler');
      expect(handlerNode?.y).toBe(200);
    });

    it('should not modify nodes not in movedNodes', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'task1', x: 100, y: 50, width: 100, height: 80 },
          { id: 'handler', x: 250, y: 50, width: 100, height: 80 },
        ],
      };

      const movedNodes = new Map([
        ['handler', { newY: 200, offset: 150 }],
      ]);

      handler.applyNodeMoves(graph, movedNodes);

      const task1 = graph.children?.find(c => c.id === 'task1');
      expect(task1?.y).toBe(50);
      expect(task1?.x).toBe(100);
    });
  });

  describe('recalculateEdgesForMovedNodes', () => {
    it('should recalculate edges for moved nodes', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'task1', x: 100, y: 50, width: 100, height: 80 },
          { id: 'handler', x: 150, y: 200, width: 100, height: 80 },
        ],
        edges: [
          {
            id: 'edge1',
            sources: ['be1'],
            targets: ['handler'],
            sections: [
              { id: 'section1', startPoint: { x: 150, y: 130 }, endPoint: { x: 200, y: 200 } },
            ],
          },
        ],
      };

      const movedNodes = new Map([
        ['handler', { newY: 200, offset: 150, newX: 150 }],
      ]);

      const boundaryEventInfo = new Map([
        ['be1', {
          attachedToRef: 'task1',
          targets: ['handler'],
          boundaryIndex: 0,
          totalBoundaries: 1,
        }],
      ]);

      handler.recalculateEdgesForMovedNodes(graph, movedNodes, boundaryEventInfo);

      // Edge sections should be recalculated
      const edge = graph.edges?.[0];
      expect(edge?.sections).toBeDefined();
      expect(edge?.sections?.[0]?.startPoint).toBeDefined();
      expect(edge?.sections?.[0]?.endPoint).toBeDefined();
    });

    it('should handle edges within nested nodes', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process',
            children: [
              { id: 'task1', x: 100, y: 50, width: 100, height: 80 },
              { id: 'handler', x: 150, y: 200, width: 100, height: 80 },
            ],
            edges: [
              {
                id: 'edge1',
                sources: ['be1'],
                targets: ['handler'],
                sections: [],
              },
            ],
          },
        ],
      };

      const movedNodes = new Map([
        ['handler', { newY: 200, offset: 150 }],
      ]);

      const boundaryEventInfo = new Map([
        ['be1', {
          attachedToRef: 'task1',
          targets: ['handler'],
          boundaryIndex: 0,
          totalBoundaries: 1,
        }],
      ]);

      // Should not throw
      expect(() => {
        handler.recalculateEdgesForMovedNodes(graph, movedNodes, boundaryEventInfo);
      }).not.toThrow();
    });
  });
});
