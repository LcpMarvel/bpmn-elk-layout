/**
 * Unit tests for Compactor
 */

import { describe, it, expect } from 'vitest';
import {
  Compactor,
  compactHorizontal,
  compactVertical,
} from '../../../src/layout/post-processing/compactor';
import type { ElkNode } from 'elkjs';

describe('Compactor', () => {
  describe('compactHorizontal standalone function', () => {
    it('should compact nodes horizontally', () => {
      const nodes = [
        { id: 'a', x: 0, width: 100 },
        { id: 'b', x: 300, width: 100 }, // 200px gap
        { id: 'c', x: 600, width: 100 }, // 200px gap
      ];

      compactHorizontal(nodes, 50);

      expect(nodes[0].x).toBe(0);
      expect(nodes[1].x).toBe(150); // 0 + 100 + 50
      expect(nodes[2].x).toBe(300); // 150 + 100 + 50
    });

    it('should not move nodes that are already close enough', () => {
      const nodes = [
        { id: 'a', x: 0, width: 100 },
        { id: 'b', x: 120, width: 100 }, // Only 20px gap, less than minGap
      ];

      compactHorizontal(nodes, 50);

      expect(nodes[0].x).toBe(0);
      expect(nodes[1].x).toBe(120); // Should not move right
    });

    it('should handle empty array', () => {
      const nodes: Array<{ id: string; x: number; width: number }> = [];
      expect(() => compactHorizontal(nodes, 50)).not.toThrow();
    });

    it('should handle single node', () => {
      const nodes = [{ id: 'a', x: 100, width: 100 }];
      compactHorizontal(nodes, 50);
      expect(nodes[0].x).toBe(100);
    });
  });

  describe('compactVertical standalone function', () => {
    it('should compact nodes vertically', () => {
      const nodes = [
        { id: 'a', y: 0, height: 80 },
        { id: 'b', y: 200, height: 80 }, // 120px gap
        { id: 'c', y: 400, height: 80 }, // 120px gap
      ];

      compactVertical(nodes, 40);

      expect(nodes[0].y).toBe(0);
      expect(nodes[1].y).toBe(120); // 0 + 80 + 40
      expect(nodes[2].y).toBe(240); // 120 + 80 + 40
    });

    it('should not move nodes that are already close enough', () => {
      const nodes = [
        { id: 'a', y: 0, height: 80 },
        { id: 'b', y: 100, height: 80 }, // Only 20px gap
      ];

      compactVertical(nodes, 40);

      expect(nodes[0].y).toBe(0);
      expect(nodes[1].y).toBe(100); // Should not move down
    });

    it('should handle empty array', () => {
      const nodes: Array<{ id: string; y: number; height: number }> = [];
      expect(() => compactVertical(nodes, 40)).not.toThrow();
    });
  });

  describe('Compactor class', () => {
    it('should compact a simple graph', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'a', x: 0, y: 0, width: 100, height: 80 },
          { id: 'b', x: 300, y: 0, width: 100, height: 80 }, // Same Y, large X gap
          { id: 'c', x: 600, y: 0, width: 100, height: 80 },
        ],
      };

      const compactor = new Compactor({
        minHorizontalGap: 60,
        considerDependencies: false,
      });
      compactor.compact(graph);

      const nodeA = graph.children!.find((n) => n.id === 'a') as ElkNode;
      const nodeB = graph.children!.find((n) => n.id === 'b') as ElkNode;
      const nodeC = graph.children!.find((n) => n.id === 'c') as ElkNode;

      expect(nodeA.x).toBe(0);
      expect(nodeB.x).toBe(160); // 0 + 100 + 60
      expect(nodeC.x).toBe(320); // 160 + 100 + 60
    });

    it('should not compact nodes on different Y levels when checking vertical overlap', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'a', x: 0, y: 0, width: 100, height: 80 },
          { id: 'b', x: 300, y: 200, width: 100, height: 80 }, // Different Y level
        ],
      };

      const compactor = new Compactor({
        minHorizontalGap: 60,
        considerDependencies: false,
      });
      compactor.compact(graph);

      const nodeB = graph.children!.find((n) => n.id === 'b') as ElkNode;
      // Node B should not be compacted to 160 because it's on a different Y level
      // It should remain at original position since there's no overlap
      expect(nodeB.x).toBe(300);
    });

    it('should compact with dependency consideration', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'a', x: 0, y: 0, width: 100, height: 80 },
          { id: 'b', x: 400, y: 0, width: 100, height: 80 },
        ],
        edges: [
          {
            id: 'e1',
            sources: ['a'],
            targets: ['b'],
          },
        ],
      };

      const compactor = new Compactor({
        minHorizontalGap: 60,
        considerDependencies: true,
      });
      compactor.compact(graph);

      const nodeB = graph.children!.find((n) => n.id === 'b') as ElkNode;
      expect(nodeB.x).toBe(160); // 0 + 100 + 60
    });

    it('should handle graph with no children', () => {
      const graph: ElkNode = {
        id: 'root',
      };

      const compactor = new Compactor();
      expect(() => compactor.compact(graph)).not.toThrow();
    });

    it('should handle graph with empty children array', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [],
      };

      const compactor = new Compactor();
      expect(() => compactor.compact(graph)).not.toThrow();
    });

    it('should recursively compact nested graphs', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'subprocess',
            x: 0,
            y: 0,
            width: 800,
            height: 400,
            children: [
              { id: 'inner-a', x: 0, y: 0, width: 100, height: 80 },
              { id: 'inner-b', x: 300, y: 0, width: 100, height: 80 },
            ],
          },
        ],
      };

      const compactor = new Compactor({
        minHorizontalGap: 60,
        considerDependencies: false,
      });
      compactor.compact(graph);

      const subprocess = graph.children![0] as ElkNode;
      const innerB = subprocess.children!.find((n) => n.id === 'inner-b') as ElkNode;
      expect(innerB.x).toBe(160);
    });

    it('should respect custom options', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'a', x: 0, y: 0, width: 100, height: 80 },
          { id: 'b', x: 300, y: 0, width: 100, height: 80 },
        ],
      };

      const compactor = new Compactor({
        minHorizontalGap: 100,
        considerDependencies: false,
      });
      compactor.compact(graph);

      const nodeB = graph.children!.find((n) => n.id === 'b') as ElkNode;
      expect(nodeB.x).toBe(200); // 0 + 100 + 100 (larger gap)
    });

    it('should disable horizontal compaction when option is false', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'a', x: 0, y: 0, width: 100, height: 80 },
          { id: 'b', x: 300, y: 0, width: 100, height: 80 },
        ],
      };

      const compactor = new Compactor({
        compactHorizontal: false,
        considerDependencies: false,
      });
      compactor.compact(graph);

      const nodeB = graph.children!.find((n) => n.id === 'b') as ElkNode;
      expect(nodeB.x).toBe(300); // Should not move
    });
  });
});
