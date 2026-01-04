import { describe, it, expect } from 'vitest';
import { ElkGraphPreparer } from '../../../src/layout/preparation/elk-graph-preparer';
import type { ElkBpmnGraph } from '../../../src/types';

describe('ElkGraphPreparer', () => {
  const preparer = new ElkGraphPreparer();

  describe('prepare', () => {
    it('should prepare simple graph for ELK', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'task1', bpmn: { type: 'task' }, width: 100, height: 80 },
              { id: 'task2', bpmn: { type: 'task' }, width: 100, height: 80 },
            ],
            edges: [
              { id: 'edge1', sources: ['task1'], targets: ['task2'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      expect(result.id).toBe('root');
      expect(result.children).toBeDefined();
      expect(result.children?.length).toBe(1);
    });

    it('should apply user options', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [],
      };

      const result = preparer.prepare(graph, { 'elk.direction': 'DOWN' });

      expect(result.layoutOptions?.['elk.direction']).toBe('DOWN');
    });

    it('should force RIGHT direction for cross-pool collaborations', () => {
      const graph: ElkBpmnGraph = {
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
              { id: 'edge1', sources: ['task1'], targets: ['task2'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      expect(result.layoutOptions?.['elk.direction']).toBe('RIGHT');
    });
  });

  describe('hasCrossPoolCollaboration', () => {
    it('should return false for graph without collaboration', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [],
          },
        ],
      } as unknown as ElkBpmnGraph;

      expect(preparer.hasCrossPoolCollaboration(graph)).toBe(false);
    });

    it('should return false for collaboration with single pool', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              { id: 'pool1', bpmn: { type: 'participant' }, children: [] },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      expect(preparer.hasCrossPoolCollaboration(graph)).toBe(false);
    });

    it('should return false for collaboration with only messageFlow', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              { id: 'pool1', bpmn: { type: 'participant' }, children: [] },
              { id: 'pool2', bpmn: { type: 'participant' }, children: [] },
            ],
            edges: [
              { id: 'msg1', sources: ['pool1'], targets: ['pool2'], bpmn: { type: 'messageFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      expect(preparer.hasCrossPoolCollaboration(graph)).toBe(false);
    });

    it('should return true for collaboration with sequenceFlow between pools', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              { id: 'pool1', bpmn: { type: 'participant' }, children: [] },
              { id: 'pool2', bpmn: { type: 'participant' }, children: [] },
            ],
            edges: [
              { id: 'edge1', sources: ['task1'], targets: ['task2'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      expect(preparer.hasCrossPoolCollaboration(graph)).toBe(true);
    });

    it('should return true for collaboration with dataInputAssociation', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'collab',
            bpmn: { type: 'collaboration' },
            children: [
              { id: 'pool1', bpmn: { type: 'participant' }, children: [] },
              { id: 'pool2', bpmn: { type: 'participant' }, children: [] },
            ],
            edges: [
              { id: 'edge1', sources: ['data1'], targets: ['task1'], bpmn: { type: 'dataInputAssociation' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      expect(preparer.hasCrossPoolCollaboration(graph)).toBe(true);
    });
  });

  describe('collectBoundaryEventTargets', () => {
    it('should collect target nodes from boundary event edges', () => {
      const node = {
        id: 'process1',
        bpmn: { type: 'process' },
        children: [
          {
            id: 'task1',
            bpmn: { type: 'task' },
            boundaryEvents: [
              { id: 'boundary1', bpmn: { type: 'boundaryEvent' } },
            ],
          },
          { id: 'errorHandler', bpmn: { type: 'task' } },
        ],
        edges: [
          { id: 'edge1', sources: ['boundary1'], targets: ['errorHandler'], bpmn: { type: 'sequenceFlow' } },
        ],
      };

      const targets = preparer.collectBoundaryEventTargets(node as any);

      expect(targets.has('errorHandler')).toBe(true);
    });

    it('should return empty set when no boundary events', () => {
      const node = {
        id: 'process1',
        bpmn: { type: 'process' },
        children: [
          { id: 'task1', bpmn: { type: 'task' } },
        ],
        edges: [],
      };

      const targets = preparer.collectBoundaryEventTargets(node as any);

      expect(targets.size).toBe(0);
    });

    it('should handle nested boundary events', () => {
      const node = {
        id: 'process1',
        bpmn: { type: 'process' },
        children: [
          {
            id: 'subprocess1',
            bpmn: { type: 'subProcess', isExpanded: true },
            children: [
              {
                id: 'task1',
                bpmn: { type: 'task' },
                boundaryEvents: [
                  { id: 'boundary1', bpmn: { type: 'boundaryEvent' } },
                ],
              },
            ],
            edges: [
              { id: 'edge1', sources: ['boundary1'], targets: ['handler1'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      };

      const targets = preparer.collectBoundaryEventTargets(node as any);

      expect(targets.has('handler1')).toBe(true);
    });
  });

  describe('node preparation', () => {
    it('should add boundary events as siblings', () => {
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
                width: 100,
                height: 80,
                boundaryEvents: [
                  { id: 'boundary1', bpmn: { type: 'boundaryEvent' }, width: 36, height: 36 },
                ],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      // Both task and boundary event should be at the same level
      const process = result.children?.[0];
      expect(process?.children?.some(c => c.id === 'task1')).toBe(true);
      expect(process?.children?.some(c => c.id === 'boundary1')).toBe(true);
    });

    it('should add padding for expanded subprocesses', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'subprocess1',
            bpmn: { type: 'subProcess', isExpanded: true },
            width: 300,
            height: 200,
            children: [
              { id: 'task1', bpmn: { type: 'task' }, width: 100, height: 80 },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      const subprocess = result.children?.[0];
      expect(subprocess?.layoutOptions?.['elk.padding']).toBe('[top=30,left=12,bottom=30,right=12]');
    });

    it('should add left padding for pools with lanes', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'pool1',
            bpmn: { type: 'participant' },
            width: 500,
            height: 300,
            children: [
              {
                id: 'lane1',
                bpmn: { type: 'lane' },
                children: [
                  { id: 'task1', bpmn: { type: 'task' }, width: 100, height: 80 },
                ],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      const pool = result.children?.[0];
      expect(pool?.layoutOptions?.['elk.padding']).toContain('left=30');
    });

    it('should add left padding for pools without lanes', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'pool1',
            bpmn: { type: 'participant' },
            width: 500,
            height: 200,
            children: [
              { id: 'task1', bpmn: { type: 'task' }, width: 100, height: 80 },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      const pool = result.children?.[0];
      expect(pool?.layoutOptions?.['elk.padding']).toContain('left=55');
    });
  });

  describe('lane flattening', () => {
    it('should flatten lane contents to pool level', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'pool1',
            bpmn: { type: 'participant' },
            width: 500,
            height: 300,
            children: [
              {
                id: 'lane1',
                bpmn: { type: 'lane' },
                children: [
                  { id: 'task1', bpmn: { type: 'task' }, width: 100, height: 80 },
                ],
              },
              {
                id: 'lane2',
                bpmn: { type: 'lane' },
                children: [
                  { id: 'task2', bpmn: { type: 'task' }, width: 100, height: 80 },
                ],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      const pool = result.children?.[0];
      // Tasks should be at pool level, not inside lanes
      expect(pool?.children?.some(c => c.id === 'task1')).toBe(true);
      expect(pool?.children?.some(c => c.id === 'task2')).toBe(true);
      // Lanes should not be in the ELK graph
      expect(pool?.children?.some(c => c.id === 'lane1')).toBe(false);
    });

    it('should handle nested lanes', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'pool1',
            bpmn: { type: 'participant' },
            children: [
              {
                id: 'lane1',
                bpmn: { type: 'lane' },
                children: [
                  {
                    id: 'nestedLane1',
                    bpmn: { type: 'lane' },
                    children: [
                      { id: 'task1', bpmn: { type: 'task' }, width: 100, height: 80 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      const pool = result.children?.[0];
      expect(pool?.children?.some(c => c.id === 'task1')).toBe(true);
    });
  });

  describe('cross-pool collaboration flattening', () => {
    it('should flatten pool contents to collaboration level', () => {
      const graph: ElkBpmnGraph = {
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
                  { id: 'task1', bpmn: { type: 'task' }, width: 100, height: 80 },
                ],
              },
              {
                id: 'pool2',
                bpmn: { type: 'participant' },
                children: [
                  { id: 'task2', bpmn: { type: 'task' }, width: 100, height: 80 },
                ],
              },
            ],
            edges: [
              { id: 'edge1', sources: ['task1'], targets: ['task2'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      const collab = result.children?.[0];
      // Tasks should be at collaboration level
      expect(collab?.children?.some(c => c.id === 'task1')).toBe(true);
      expect(collab?.children?.some(c => c.id === 'task2')).toBe(true);
    });

    it('should include black box pools as nodes', () => {
      const graph: ElkBpmnGraph = {
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
                  { id: 'task1', bpmn: { type: 'task' }, width: 100, height: 80 },
                ],
              },
              {
                id: 'blackBoxPool',
                bpmn: { type: 'participant', isBlackBox: true },
                children: [],
              },
            ],
            edges: [
              { id: 'edge1', sources: ['task1'], targets: ['blackBoxPool'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      const collab = result.children?.[0];
      // Black box pool should be included as a node
      expect(collab?.children?.some(c => c.id === 'blackBoxPool')).toBe(true);
    });
  });

  describe('edge preparation', () => {
    it('should copy edges to ELK format', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'task1', bpmn: { type: 'task' }, width: 100, height: 80 },
              { id: 'task2', bpmn: { type: 'task' }, width: 100, height: 80 },
            ],
            edges: [
              {
                id: 'edge1',
                sources: ['task1'],
                targets: ['task2'],
                bpmn: { type: 'sequenceFlow' },
                labels: [{ text: 'Yes', width: 20, height: 14 }],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      const process = result.children?.[0];
      expect(process?.edges?.length).toBe(1);
      expect(process?.edges?.[0].id).toBe('edge1');
      expect(process?.edges?.[0].labels?.[0].text).toBe('Yes');
    });
  });

  describe('label width estimation', () => {
    it('should handle labels without explicit width', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'task1',
            bpmn: { type: 'task' },
            width: 100,
            height: 80,
            labels: [{ text: 'Test Label' }],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      const task = result.children?.[0];
      expect(task?.labels?.[0].width).toBeGreaterThan(0);
    });

    it('should estimate wider width for CJK characters', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'task1',
            bpmn: { type: 'task' },
            width: 100,
            height: 80,
            labels: [{ text: '测试任务' }], // 4 CJK chars = 4 * 14 = 56
          },
          {
            id: 'task2',
            bpmn: { type: 'task' },
            width: 100,
            height: 80,
            labels: [{ text: 'Task' }], // 4 ASCII chars = 4 * 7 = 28, min 30
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      const task1Label = result.children?.[0]?.labels?.[0];
      const task2Label = result.children?.[1]?.labels?.[0];
      // CJK labels should be wider than ASCII with same character count
      expect(task1Label?.width).toBeGreaterThan(task2Label?.width ?? 0);
    });
  });

  describe('ports', () => {
    it('should copy ports to ELK format', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'task1',
            bpmn: { type: 'task' },
            width: 100,
            height: 80,
            ports: [
              { id: 'port1', width: 10, height: 10 },
              { id: 'port2' },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const result = preparer.prepare(graph);

      const task = result.children?.[0];
      expect(task?.ports?.length).toBe(2);
      expect(task?.ports?.[0].id).toBe('port1');
      expect(task?.ports?.[1].width).toBe(10); // Default width
    });
  });
});
