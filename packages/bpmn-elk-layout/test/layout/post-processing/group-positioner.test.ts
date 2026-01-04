import { describe, it, expect } from 'vitest';
import { GroupPositioner, GROUP_TYPE } from '../../../src/layout/post-processing/group-positioner';
import type { ElkBpmnGraph } from '../../../src/types';
import type { ElkNode } from 'elkjs';

describe('GroupPositioner', () => {
  const positioner = new GroupPositioner();

  describe('GROUP_TYPE', () => {
    it('should be "group"', () => {
      expect(GROUP_TYPE).toBe('group');
    });
  });

  describe('collectInfo', () => {
    it('should collect group info from graph', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'task1', bpmn: { type: 'task' } },
              { id: 'task2', bpmn: { type: 'task' } },
              {
                id: 'group1',
                bpmn: {
                  type: 'group',
                  name: 'My Group',
                  groupedElements: ['task1', 'task2'],
                  padding: 30,
                },
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const info = positioner.collectInfo(graph);

      expect(info.size).toBe(1);
      expect(info.get('group1')).toEqual({
        groupedElements: ['task1', 'task2'],
        padding: 30,
        name: 'My Group',
        parentId: 'process1',
      });
    });

    it('should use default padding when not specified', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              {
                id: 'group1',
                bpmn: {
                  type: 'group',
                  groupedElements: ['task1'],
                },
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const info = positioner.collectInfo(graph);

      expect(info.get('group1')?.padding).toBe(20);
    });

    it('should handle graph with no groups', () => {
      const graph: ElkBpmnGraph = {
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

      const info = positioner.collectInfo(graph);
      expect(info.size).toBe(0);
    });

    it('should collect nested groups', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              {
                id: 'subprocess1',
                bpmn: { type: 'subProcess' },
                children: [
                  {
                    id: 'nestedGroup',
                    bpmn: {
                      type: 'group',
                      groupedElements: ['innerTask'],
                    },
                  },
                ],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const info = positioner.collectInfo(graph);

      expect(info.size).toBe(1);
      expect(info.get('nestedGroup')?.parentId).toBe('subprocess1');
    });
  });

  describe('removeFromGraph', () => {
    it('should remove group nodes from graph', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'task1', bpmn: { type: 'task' } },
              { id: 'group1', bpmn: { type: 'group' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const groupInfo = new Map([
        ['group1', { groupedElements: ['task1'], padding: 20, parentId: 'process1' }],
      ]);

      positioner.removeFromGraph(graph, groupInfo);

      const process = (graph.children as Array<{ children?: Array<{ id: string }> }>)[0];
      expect(process.children?.length).toBe(1);
      expect(process.children?.[0].id).toBe('task1');
    });

    it('should remove edges connected to groups', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'task1', bpmn: { type: 'task' } },
              { id: 'group1', bpmn: { type: 'group' } },
            ],
            edges: [
              { id: 'edge1', sources: ['task1'], targets: ['group1'], bpmn: { type: 'association' } },
              { id: 'edge2', sources: ['task1'], targets: ['task2'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const groupInfo = new Map([
        ['group1', { groupedElements: [], padding: 20, parentId: 'process1' }],
      ]);

      positioner.removeFromGraph(graph, groupInfo);

      const process = (graph.children as Array<{ edges?: Array<{ id: string }> }>)[0];
      expect(process.edges?.length).toBe(1);
      expect(process.edges?.[0].id).toBe('edge2');
    });
  });

  describe('reposition', () => {
    it('should reposition group to surround grouped elements', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'task1', x: 100, y: 100, width: 100, height: 80 },
          { id: 'task2', x: 250, y: 100, width: 100, height: 80 },
          { id: 'group1', x: 0, y: 0, width: 50, height: 50 },
        ],
      };

      const groupInfo = new Map([
        ['group1', { groupedElements: ['task1', 'task2'], padding: 20, parentId: 'root' }],
      ]);

      positioner.reposition(graph, groupInfo, {} as ElkBpmnGraph);

      const group = graph.children?.find(c => c.id === 'group1');
      expect(group?.x).toBe(100 - 20); // task1.x - padding
      expect(group?.y).toBe(100 - 20); // task1.y - padding
      expect(group?.width).toBe(250 + 100 - 100 + 40); // (task2.x + task2.width) - task1.x + 2*padding
      expect(group?.height).toBe(80 + 40); // task height + 2*padding
    });

    it('should keep position for groups with no elements', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'group1', x: 50, y: 50, width: 100, height: 100 },
        ],
      };

      const groupInfo = new Map([
        ['group1', { groupedElements: [], padding: 20, parentId: 'root' }],
      ]);

      positioner.reposition(graph, groupInfo, {} as ElkBpmnGraph);

      const group = graph.children?.find(c => c.id === 'group1');
      expect(group?.x).toBe(50); // Unchanged
      expect(group?.y).toBe(50); // Unchanged
    });

    it('should handle nested elements in lanes', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'lane1',
            x: 50,
            y: 50,
            width: 400,
            height: 200,
            children: [
              { id: 'task1', x: 20, y: 20, width: 100, height: 80 },
            ],
          },
          { id: 'group1', x: 0, y: 0, width: 50, height: 50 },
        ],
      };

      const groupInfo = new Map([
        ['group1', { groupedElements: ['task1'], padding: 10, parentId: 'root' }],
      ]);

      positioner.reposition(graph, groupInfo, {} as ElkBpmnGraph);

      const group = graph.children?.find(c => c.id === 'group1');
      // Group should account for lane offset: lane.x + task.x = 50 + 20 = 70
      expect(group?.x).toBe(70 - 10); // 60
      expect(group?.y).toBe(70 - 10); // 60 (50 + 20 = 70, then -10 padding)
    });

    it('should do nothing when groupInfo is empty', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'task1', x: 100, y: 100, width: 100, height: 80 },
        ],
      };

      const originalChildren = [...(graph.children ?? [])];

      positioner.reposition(graph, new Map(), {} as ElkBpmnGraph);

      expect(graph.children).toEqual(originalChildren);
    });
  });
});
