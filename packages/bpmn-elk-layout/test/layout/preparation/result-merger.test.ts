import { describe, it, expect } from 'vitest';
import { ResultMerger } from '../../../src/layout/preparation/result-merger';
import type { ElkBpmnGraph } from '../../../src/types';
import type { ElkNode } from 'elkjs';

describe('ResultMerger', () => {
  const merger = new ResultMerger();

  describe('merge', () => {
    it('should merge basic layout results', () => {
      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'task1',
            bpmn: { type: 'task', name: 'Task 1' },
          },
        ],
      } as unknown as ElkBpmnGraph;

      const layouted: ElkNode = {
        id: 'root',
        x: 0,
        y: 0,
        width: 500,
        height: 300,
        children: [
          { id: 'task1', x: 50, y: 50, width: 100, height: 80 },
        ],
      };

      const result = merger.merge(original, layouted);

      expect(result.width).toBe(500);
      expect(result.height).toBe(300);
      expect(result.children?.[0].x).toBe(50);
      expect(result.children?.[0].y).toBe(50);
    });

    it('should preserve BPMN metadata', () => {
      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'task1',
            bpmn: { type: 'task', name: 'Important Task' },
          },
        ],
      } as unknown as ElkBpmnGraph;

      const layouted: ElkNode = {
        id: 'root',
        children: [
          { id: 'task1', x: 50, y: 50, width: 100, height: 80 },
        ],
      };

      const result = merger.merge(original, layouted);

      expect((result.children?.[0] as any).bpmn.type).toBe('task');
      expect((result.children?.[0] as any).bpmn.name).toBe('Important Task');
    });

    it('should handle missing layouted children', () => {
      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          { id: 'task1', bpmn: { type: 'task' } },
          { id: 'task2', bpmn: { type: 'task' } },
        ],
      } as unknown as ElkBpmnGraph;

      const layouted: ElkNode = {
        id: 'root',
        children: [
          { id: 'task1', x: 50, y: 50, width: 100, height: 80 },
          // task2 is missing
        ],
      };

      const result = merger.merge(original, layouted);

      expect(result.children?.length).toBe(2);
      expect(result.children?.[0].x).toBe(50);
      // task2 should be returned as-is
      expect(result.children?.[1].x).toBeUndefined();
    });
  });

  describe('nested children', () => {
    it('should merge nested node positions', () => {
      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'subprocess1',
            bpmn: { type: 'subProcess', isExpanded: true },
            children: [
              { id: 'task1', bpmn: { type: 'task' } },
              { id: 'task2', bpmn: { type: 'task' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'subprocess1',
            x: 10,
            y: 10,
            width: 300,
            height: 200,
            children: [
              { id: 'task1', x: 20, y: 30, width: 100, height: 80 },
              { id: 'task2', x: 150, y: 30, width: 100, height: 80 },
            ],
          },
        ],
      };

      const result = merger.merge(original, layouted);

      const subprocess = result.children?.[0] as any;
      expect(subprocess.x).toBe(10);
      expect(subprocess.children[0].x).toBe(20);
      expect(subprocess.children[1].x).toBe(150);
    });
  });

  describe('boundary events', () => {
    it('should preserve boundary events', () => {
      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'task1',
            bpmn: { type: 'task' },
            boundaryEvents: [
              { id: 'boundary1', attachedToRef: 'task1', bpmn: { type: 'boundaryEvent' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const layouted: ElkNode = {
        id: 'root',
        children: [
          { id: 'task1', x: 50, y: 50, width: 100, height: 80 },
        ],
      };

      const result = merger.merge(original, layouted);

      expect((result.children?.[0] as any).boundaryEvents).toBeDefined();
      expect((result.children?.[0] as any).boundaryEvents[0].id).toBe('boundary1');
    });
  });

  describe('edges', () => {
    it('should merge edge sections', () => {
      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'task1', bpmn: { type: 'task' } },
              { id: 'task2', bpmn: { type: 'task' } },
            ],
            edges: [
              { id: 'edge1', sources: ['task1'], targets: ['task2'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process1',
            x: 0,
            y: 0,
            width: 400,
            height: 200,
            children: [
              { id: 'task1', x: 50, y: 60, width: 100, height: 80 },
              { id: 'task2', x: 250, y: 60, width: 100, height: 80 },
            ],
            edges: [
              {
                id: 'edge1',
                sources: ['task1'],
                targets: ['task2'],
                sections: [{
                  id: 'edge1_s0',
                  startPoint: { x: 150, y: 100 },
                  endPoint: { x: 250, y: 100 },
                }],
              },
            ],
          },
        ],
      };

      const result = merger.merge(original, layouted);

      const process = result.children?.[0] as any;
      expect(process.edges[0].sections).toBeDefined();
      expect(process.edges[0].sections[0].startPoint.x).toBe(150);
    });

    it('should merge edge labels', () => {
      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            edges: [
              {
                id: 'edge1',
                sources: ['task1'],
                targets: ['task2'],
                bpmn: { type: 'sequenceFlow' },
                labels: [{ text: 'Yes' }],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process1',
            x: 0,
            y: 0,
            edges: [
              {
                id: 'edge1',
                sources: ['task1'],
                targets: ['task2'],
                sections: [],
                labels: [{ text: 'Yes', x: 100, y: 50, width: 30, height: 14 }],
              },
            ],
          },
        ],
      };

      const result = merger.merge(original, layouted);

      const process = result.children?.[0] as any;
      expect(process.edges[0].labels[0].x).toBe(100);
      expect(process.edges[0].labels[0].y).toBe(50);
    });

    it('should preserve _absoluteCoords flag', () => {
      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            edges: [
              { id: 'msgFlow1', sources: ['pool1'], targets: ['pool2'], bpmn: { type: 'messageFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            x: 0,
            y: 0,
            edges: [
              {
                id: 'msgFlow1',
                sources: ['pool1'],
                targets: ['pool2'],
                sections: [],
                _absoluteCoords: true,
              } as any,
            ],
          },
        ],
      };

      const result = merger.merge(original, layouted);

      const collab = result.children?.[0] as any;
      expect(collab.edges[0]._absoluteCoords).toBe(true);
    });

    it('should preserve _poolRelativeCoords flag', () => {
      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'pool1',
            bpmn: { type: 'participant' },
            edges: [
              { id: 'edge1', sources: ['task1'], targets: ['task2'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'pool1',
            x: 0,
            y: 0,
            edges: [
              {
                id: 'edge1',
                sources: ['task1'],
                targets: ['task2'],
                sections: [],
                _poolRelativeCoords: true,
              } as any,
            ],
          },
        ],
      };

      const result = merger.merge(original, layouted);

      const pool = result.children?.[0] as any;
      expect(pool.edges[0]._poolRelativeCoords).toBe(true);
    });
  });

  describe('labels', () => {
    it('should merge node labels', () => {
      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'task1',
            bpmn: { type: 'task' },
            labels: [{ text: 'Task Label' }],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'task1',
            x: 50,
            y: 50,
            width: 100,
            height: 80,
            labels: [{ text: 'Task Label', x: 10, y: 5, width: 80, height: 14 }],
          },
        ],
      };

      const result = merger.merge(original, layouted);

      const task = result.children?.[0] as any;
      expect(task.labels[0].x).toBe(10);
      expect(task.labels[0].y).toBe(5);
    });
  });

  describe('width and height', () => {
    it('should use layouted dimensions', () => {
      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'task1',
            bpmn: { type: 'task' },
            width: 100,
            height: 80,
          },
        ],
      } as unknown as ElkBpmnGraph;

      const layouted: ElkNode = {
        id: 'root',
        children: [
          { id: 'task1', x: 50, y: 50, width: 120, height: 90 },
        ],
      };

      const result = merger.merge(original, layouted);

      expect(result.children?.[0].width).toBe(120);
      expect(result.children?.[0].height).toBe(90);
    });

    it('should fallback to original dimensions if not layouted', () => {
      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'task1',
            bpmn: { type: 'task' },
            width: 100,
            height: 80,
          },
        ],
      } as unknown as ElkBpmnGraph;

      const layouted: ElkNode = {
        id: 'root',
        children: [
          { id: 'task1', x: 50, y: 50 },
        ],
      };

      const result = merger.merge(original, layouted);

      expect(result.children?.[0].width).toBe(100);
      expect(result.children?.[0].height).toBe(80);
    });
  });
});
