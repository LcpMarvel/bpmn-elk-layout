import { describe, it, expect } from 'vitest';
import { PoolArranger } from '../../../src/layout/post-processing/pool-arranger';
import type { ElkBpmnGraph } from '../../../src/types';
import type { ElkNode } from 'elkjs';

describe('PoolArranger', () => {
  const arranger = new PoolArranger();

  describe('rearrange', () => {
    it('should stack pools vertically within collaboration', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            children: [
              {
                id: 'pool1',
                x: 0,
                y: 0,
                width: 500,
                height: 150,
                children: [
                  { id: 'task1', x: 50, y: 30, width: 100, height: 80 },
                ],
                edges: [],
              },
              {
                id: 'pool2',
                x: 0,
                y: 0,
                width: 500,
                height: 150,
                children: [
                  { id: 'task2', x: 50, y: 30, width: 100, height: 80 },
                ],
                edges: [],
              },
            ],
            edges: [],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              {
                id: 'pool1',
                bpmn: { type: 'participant', name: 'Pool 1' },
                children: [
                  { id: 'task1', bpmn: { type: 'task' } },
                ],
              },
              {
                id: 'pool2',
                bpmn: { type: 'participant', name: 'Pool 2' },
                children: [
                  { id: 'task2', bpmn: { type: 'task' } },
                ],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      const collab = layouted.children?.[0];
      const pool1 = collab?.children?.find(c => c.id === 'pool1');
      const pool2 = collab?.children?.find(c => c.id === 'pool2');

      expect(pool1?.y).toBe(0);
      expect(pool2?.y).toBeGreaterThan(0);
      // Pools should have same width
      expect(pool1?.width).toBe(pool2?.width);
    });

    it('should handle black box pools', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            children: [
              {
                id: 'pool1',
                x: 0,
                y: 0,
                width: 500,
                height: 60,
                children: [],
                edges: [],
              },
            ],
            edges: [],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              {
                id: 'pool1',
                bpmn: { type: 'participant', name: 'External', isBlackBox: true },
                children: [],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      const pool = layouted.children?.[0]?.children?.[0];
      expect(pool?.height).toBe(60);
    });

    it('should not modify non-collaboration children', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process1',
            children: [
              { id: 'task1', x: 50, y: 50, width: 100, height: 80 },
            ],
          },
        ],
      };

      const original: ElkBpmnGraph = {
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

      const before = JSON.stringify(layouted);
      arranger.rearrange(layouted, original);
      expect(JSON.stringify(layouted)).toBe(before);
    });

    it('should handle empty children', () => {
      const layouted: ElkNode = { id: 'root' };
      const original: ElkBpmnGraph = { id: 'root' } as ElkBpmnGraph;

      expect(() => arranger.rearrange(layouted, original)).not.toThrow();
    });
  });

  describe('stacking and sizing', () => {
    it('should calculate pool width based on content', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            children: [
              {
                id: 'pool1',
                x: 0,
                y: 0,
                width: 300,
                height: 150,
                children: [
                  { id: 'task1', x: 50, y: 30, width: 100, height: 80 },
                ],
                edges: [],
              },
              {
                id: 'pool2',
                x: 0,
                y: 0,
                width: 600,
                height: 150,
                children: [
                  { id: 'task2', x: 50, y: 30, width: 100, height: 80 },
                  { id: 'task3', x: 300, y: 30, width: 100, height: 80 },
                ],
                edges: [],
              },
            ],
            edges: [],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              {
                id: 'pool1',
                bpmn: { type: 'participant' },
                children: [{ id: 'task1', bpmn: { type: 'task' } }],
              },
              {
                id: 'pool2',
                bpmn: { type: 'participant' },
                children: [
                  { id: 'task2', bpmn: { type: 'task' } },
                  { id: 'task3', bpmn: { type: 'task' } },
                ],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      const pool1 = layouted.children?.[0]?.children?.find(c => c.id === 'pool1');
      const pool2 = layouted.children?.[0]?.children?.find(c => c.id === 'pool2');

      // Both pools should have the same width (max of the two + extra)
      expect(pool1?.width).toBe(pool2?.width);
      expect(pool1?.width).toBeGreaterThan(300);
    });

    it('should add extra height for non-lane pools', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            children: [
              {
                id: 'pool1',
                x: 0,
                y: 0,
                width: 500,
                height: 120,
                children: [
                  { id: 'task1', x: 50, y: 20, width: 100, height: 80 },
                ],
                edges: [],
              },
            ],
            edges: [],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              {
                id: 'pool1',
                bpmn: { type: 'participant' },
                children: [{ id: 'task1', bpmn: { type: 'task' } }],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      const pool = layouted.children?.[0]?.children?.[0];
      // Pool height should include extra height
      expect(pool?.height).toBe(120 + 80); // original + poolExtraHeight
    });
  });

  describe('message flows', () => {
    it('should recalculate message flows between pools', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            children: [
              {
                id: 'pool1',
                x: 0,
                y: 0,
                width: 500,
                height: 150,
                children: [
                  { id: 'task1', x: 100, y: 35, width: 100, height: 80 },
                ],
                edges: [],
              },
              {
                id: 'pool2',
                x: 0,
                y: 0,
                width: 500,
                height: 150,
                children: [
                  { id: 'task2', x: 100, y: 35, width: 100, height: 80 },
                ],
                edges: [],
              },
            ],
            edges: [
              {
                id: 'msgFlow1',
                sources: ['task1'],
                targets: ['task2'],
                sections: [],
              },
            ],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              {
                id: 'pool1',
                bpmn: { type: 'participant' },
                children: [{ id: 'task1', bpmn: { type: 'task' } }],
              },
              {
                id: 'pool2',
                bpmn: { type: 'participant' },
                children: [{ id: 'task2', bpmn: { type: 'task' } }],
              },
            ],
            edges: [
              {
                id: 'msgFlow1',
                sources: ['task1'],
                targets: ['task2'],
                bpmn: { type: 'messageFlow' },
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      const edge = layouted.children?.[0]?.edges?.[0];
      expect(edge?.sections).toBeDefined();
      expect(edge?.sections?.length).toBeGreaterThan(0);
      expect(edge?.sections?.[0].startPoint).toBeDefined();
      expect(edge?.sections?.[0].endPoint).toBeDefined();
    });

    it('should handle message flows with labels', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            children: [
              {
                id: 'pool1',
                x: 0,
                y: 0,
                width: 500,
                height: 150,
                children: [
                  { id: 'task1', x: 100, y: 35, width: 100, height: 80 },
                ],
                edges: [],
              },
              {
                id: 'pool2',
                x: 0,
                y: 0,
                width: 500,
                height: 150,
                children: [
                  { id: 'task2', x: 100, y: 35, width: 100, height: 80 },
                ],
                edges: [],
              },
            ],
            edges: [
              {
                id: 'msgFlow1',
                sources: ['task1'],
                targets: ['task2'],
                sections: [],
                labels: [{ id: 'label1', text: 'Request', width: 50, height: 14, x: 0, y: 0 }],
              },
            ],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              {
                id: 'pool1',
                bpmn: { type: 'participant' },
                children: [{ id: 'task1', bpmn: { type: 'task' } }],
              },
              {
                id: 'pool2',
                bpmn: { type: 'participant' },
                children: [{ id: 'task2', bpmn: { type: 'task' } }],
              },
            ],
            edges: [
              {
                id: 'msgFlow1',
                sources: ['task1'],
                targets: ['task2'],
                bpmn: { type: 'messageFlow' },
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      const edge = layouted.children?.[0]?.edges?.[0];
      expect(edge?.labels?.[0].x).toBeDefined();
      expect(edge?.labels?.[0].y).toBeDefined();
    });
  });

  describe('cross-pool edges (flattened layouts)', () => {
    it('should handle collaboration with cross-pool sequence flows', () => {
      // Simulating a flattened layout where all nodes are at collab level
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            children: [
              { id: 'task1', x: 100, y: 50, width: 100, height: 80 },
              { id: 'task2', x: 300, y: 50, width: 100, height: 80 },
              { id: 'task3', x: 100, y: 200, width: 100, height: 80 },
            ],
            edges: [
              { id: 'edge1', sources: ['task1'], targets: ['task2'], sections: [] },
              { id: 'edge2', sources: ['task1'], targets: ['task3'], sections: [] },
            ],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              {
                id: 'pool1',
                bpmn: { type: 'participant' },
                children: [
                  { id: 'task1', bpmn: { type: 'task' } },
                  { id: 'task2', bpmn: { type: 'task' } },
                ],
              },
              {
                id: 'pool2',
                bpmn: { type: 'participant' },
                children: [
                  { id: 'task3', bpmn: { type: 'task' } },
                ],
              },
            ],
            edges: [
              { id: 'edge1', sources: ['task1'], targets: ['task2'], bpmn: { type: 'sequenceFlow' } },
              { id: 'edge2', sources: ['task1'], targets: ['task3'], bpmn: { type: 'messageFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      const collab = layouted.children?.[0];
      // After rearrangement, pools should be created
      expect(collab?.children?.some(c => c.id === 'pool1')).toBe(true);
      expect(collab?.children?.some(c => c.id === 'pool2')).toBe(true);
    });
  });

  describe('pool ordering', () => {
    it('should maintain pool order from original', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            children: [
              {
                id: 'pool2',
                x: 0,
                y: 0,
                width: 500,
                height: 150,
                children: [],
                edges: [],
              },
              {
                id: 'pool1',
                x: 0,
                y: 0,
                width: 500,
                height: 150,
                children: [],
                edges: [],
              },
            ],
            edges: [],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              {
                id: 'pool1',
                bpmn: { type: 'participant' },
                children: [],
              },
              {
                id: 'pool2',
                bpmn: { type: 'participant' },
                children: [],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      const collab = layouted.children?.[0];
      const pool1 = collab?.children?.find(c => c.id === 'pool1');
      const pool2 = collab?.children?.find(c => c.id === 'pool2');

      // Pool1 should come before pool2 (original order)
      expect(pool1?.y).toBeLessThan(pool2?.y ?? Infinity);
    });
  });

  describe('pools with lanes', () => {
    it('should preserve lane-based pool width', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            children: [
              {
                id: 'pool1',
                x: 0,
                y: 0,
                width: 700,
                height: 300,
                children: [
                  {
                    id: 'lane1',
                    x: 30,
                    y: 0,
                    width: 670,
                    height: 150,
                    children: [
                      { id: 'task1', x: 50, y: 30, width: 100, height: 80 },
                    ],
                  },
                  {
                    id: 'lane2',
                    x: 30,
                    y: 150,
                    width: 670,
                    height: 150,
                    children: [
                      { id: 'task2', x: 50, y: 30, width: 100, height: 80 },
                    ],
                  },
                ],
                edges: [],
              },
            ],
            edges: [],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              {
                id: 'pool1',
                bpmn: { type: 'participant' },
                children: [
                  {
                    id: 'lane1',
                    bpmn: { type: 'lane' },
                    children: [{ id: 'task1', bpmn: { type: 'task' } }],
                  },
                  {
                    id: 'lane2',
                    bpmn: { type: 'lane' },
                    children: [{ id: 'task2', bpmn: { type: 'task' } }],
                  },
                ],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      const pool = layouted.children?.[0]?.children?.[0];
      // For pools with lanes, width should be preserved (no extra width added)
      expect(pool?.width).toBe(700);
    });
  });

  describe('sequence flow routing', () => {
    it('should route horizontal sequence flows', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            children: [
              {
                id: 'pool1',
                x: 0,
                y: 0,
                width: 500,
                height: 150,
                children: [
                  { id: 'task1', x: 100, y: 35, width: 100, height: 80 },
                  { id: 'task2', x: 300, y: 35, width: 100, height: 80 },
                ],
                edges: [],
              },
            ],
            edges: [
              {
                id: 'seqFlow1',
                sources: ['task1'],
                targets: ['task2'],
                sections: [],
              },
            ],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              {
                id: 'pool1',
                bpmn: { type: 'participant' },
                children: [
                  { id: 'task1', bpmn: { type: 'task' } },
                  { id: 'task2', bpmn: { type: 'task' } },
                ],
              },
            ],
            edges: [
              {
                id: 'seqFlow1',
                sources: ['task1'],
                targets: ['task2'],
                bpmn: { type: 'sequenceFlow' },
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      const edge = layouted.children?.[0]?.edges?.[0];
      const startPoint = edge?.sections?.[0].startPoint;
      const endPoint = edge?.sections?.[0].endPoint;

      expect(startPoint).toBeDefined();
      expect(endPoint).toBeDefined();
      // For horizontal flow, start should be on the right of source
      expect(startPoint?.x).toBeGreaterThan(100);
    });

    it('should route backward sequence flows', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            children: [
              {
                id: 'pool1',
                x: 0,
                y: 0,
                width: 500,
                height: 150,
                children: [
                  { id: 'task1', x: 300, y: 35, width: 100, height: 80 },
                  { id: 'task2', x: 100, y: 35, width: 100, height: 80 },
                ],
                edges: [],
              },
            ],
            edges: [
              {
                id: 'seqFlow1',
                sources: ['task1'],
                targets: ['task2'],
                sections: [],
              },
            ],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              {
                id: 'pool1',
                bpmn: { type: 'participant' },
                children: [
                  { id: 'task1', bpmn: { type: 'task' } },
                  { id: 'task2', bpmn: { type: 'task' } },
                ],
              },
            ],
            edges: [
              {
                id: 'seqFlow1',
                sources: ['task1'],
                targets: ['task2'],
                bpmn: { type: 'sequenceFlow' },
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      const edge = layouted.children?.[0]?.edges?.[0];
      // Backward flow should have bend points to route around
      expect(edge?.sections?.[0].bendPoints).toBeDefined();
      expect(edge?.sections?.[0].bendPoints?.length).toBeGreaterThan(0);
    });
  });

  describe('collaboration dimensions', () => {
    it('should update collaboration dimensions after stacking', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            width: 0,
            height: 0,
            children: [
              {
                id: 'pool1',
                x: 0,
                y: 0,
                width: 500,
                height: 150,
                children: [],
                edges: [],
              },
              {
                id: 'pool2',
                x: 0,
                y: 0,
                width: 500,
                height: 200,
                children: [],
                edges: [],
              },
            ],
            edges: [],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              {
                id: 'pool1',
                bpmn: { type: 'participant', isBlackBox: true },
                children: [],
              },
              {
                id: 'pool2',
                bpmn: { type: 'participant', isBlackBox: true },
                children: [],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      const collab = layouted.children?.[0];
      // Collaboration height should be sum of pool heights (black boxes keep their height)
      expect(collab?.height).toBe(150 + 200); // Black box pools keep original height
      // Collaboration width should match pool widths
      expect(collab?.width).toBeDefined();
      expect(collab?.width).toBeGreaterThan(0);
    });
  });
});
