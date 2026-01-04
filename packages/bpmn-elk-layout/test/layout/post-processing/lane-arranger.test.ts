import { describe, it, expect } from 'vitest';
import { LaneArranger } from '../../../src/layout/post-processing/lane-arranger';
import type { ElkBpmnGraph } from '../../../src/types';
import type { ElkNode } from 'elkjs';

describe('LaneArranger', () => {
  const arranger = new LaneArranger();

  describe('calculateContentWidth', () => {
    it('should calculate width based on children', () => {
      const node: ElkNode = {
        id: 'container',
        children: [
          { id: 'child1', x: 10, y: 0, width: 100, height: 80 },
          { id: 'child2', x: 150, y: 0, width: 100, height: 80 },
        ],
      };

      expect(arranger.calculateContentWidth(node)).toBe(250); // 150 + 100
    });

    it('should return default for empty container', () => {
      const node: ElkNode = {
        id: 'container',
        children: [],
      };

      expect(arranger.calculateContentWidth(node)).toBe(100);
    });

    it('should return default for no children', () => {
      const node: ElkNode = { id: 'container' };
      expect(arranger.calculateContentWidth(node)).toBe(100);
    });
  });

  describe('calculateContentHeight', () => {
    it('should calculate height based on children', () => {
      const node: ElkNode = {
        id: 'container',
        children: [
          { id: 'child1', x: 0, y: 10, width: 100, height: 80 },
          { id: 'child2', x: 0, y: 120, width: 100, height: 80 },
        ],
      };

      expect(arranger.calculateContentHeight(node)).toBe(200); // 120 + 80
    });

    it('should return default for empty container', () => {
      const node: ElkNode = {
        id: 'container',
        children: [],
      };

      expect(arranger.calculateContentHeight(node)).toBe(60);
    });
  });

  describe('rearrange', () => {
    it('should arrange lanes vertically within pool', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'pool1',
            x: 0,
            y: 0,
            width: 500,
            height: 300,
            children: [
              { id: 'task1', x: 50, y: 50, width: 100, height: 80 },
              { id: 'task2', x: 200, y: 50, width: 100, height: 80 },
              { id: 'task3', x: 50, y: 150, width: 100, height: 80 },
            ],
            edges: [],
          },
        ],
      };

      const original: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'pool1',
            bpmn: { type: 'participant', name: 'Pool 1' },
            children: [
              {
                id: 'lane1',
                bpmn: { type: 'lane', name: 'Lane 1' },
                layoutOptions: { 'elk.partitioning.partition': 0 },
                children: [
                  { id: 'task1', bpmn: { type: 'task' } },
                  { id: 'task2', bpmn: { type: 'task' } },
                ],
              },
              {
                id: 'lane2',
                bpmn: { type: 'lane', name: 'Lane 2' },
                layoutOptions: { 'elk.partitioning.partition': 1 },
                children: [
                  { id: 'task3', bpmn: { type: 'task' } },
                ],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      arranger.rearrange(layouted, original);

      // Pool should have lanes as children
      const pool = layouted.children?.[0];
      expect(pool?.children?.length).toBe(2);

      // Lanes should be stacked vertically
      const lane1 = pool?.children?.find(c => c.id === 'lane1');
      const lane2 = pool?.children?.find(c => c.id === 'lane2');

      expect(lane1?.y).toBe(0);
      expect(lane2?.y).toBeGreaterThan(0);
      expect(lane2?.y).toBe(lane1?.height);
    });

    it('should handle pools in collaborations', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'collab',
            children: [
              {
                id: 'pool1',
                children: [
                  { id: 'task1', x: 50, y: 50, width: 100, height: 80 },
                ],
                edges: [],
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
                  {
                    id: 'lane1',
                    bpmn: { type: 'lane' },
                    children: [
                      { id: 'task1', bpmn: { type: 'task' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      // Should not throw
      expect(() => arranger.rearrange(layouted, original)).not.toThrow();
    });

    it('should not modify pools without lanes', () => {
      const layouted: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'pool1',
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
            id: 'pool1',
            bpmn: { type: 'participant' },
            children: [
              { id: 'task1', bpmn: { type: 'task' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const childrenBefore = [...(layouted.children?.[0]?.children ?? [])];
      arranger.rearrange(layouted, original);

      expect(layouted.children?.[0]?.children).toEqual(childrenBefore);
    });
  });

  describe('rearrangeNested', () => {
    it('should stack nested lanes vertically', () => {
      const lane: ElkNode = {
        id: 'parentLane',
        children: [
          { id: 'nestedLane1', x: 0, y: 0, width: 200, height: 100, children: [{ id: 'n1', x: 10, y: 10, width: 50, height: 50 }] },
          { id: 'nestedLane2', x: 0, y: 0, width: 200, height: 100, children: [{ id: 'n2', x: 10, y: 10, width: 50, height: 50 }] },
        ],
      };

      const origLane = {
        id: 'parentLane',
        bpmn: { type: 'lane' },
        children: [
          { id: 'nestedLane1', bpmn: { type: 'lane' } },
          { id: 'nestedLane2', bpmn: { type: 'lane' } },
        ],
      };

      arranger.rearrangeNested(lane, origLane as any);

      const nested1 = lane.children?.find(c => c.id === 'nestedLane1');
      const nested2 = lane.children?.find(c => c.id === 'nestedLane2');

      expect(nested1?.y).toBe(12);
      expect(nested2?.y).toBeGreaterThan(nested1?.y ?? 0);
    });

    it('should handle lanes without children', () => {
      const lane: ElkNode = { id: 'lane' };
      expect(() => arranger.rearrangeNested(lane, undefined)).not.toThrow();
    });
  });
});
