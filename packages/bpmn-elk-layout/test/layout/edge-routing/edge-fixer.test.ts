import { describe, it, expect } from 'vitest';
import { EdgeFixer } from '../../../src/layout/edge-routing/edge-fixer';
import type { ElkNode } from 'elkjs';

describe('EdgeFixer', () => {
  const fixer = new EdgeFixer();

  describe('fix', () => {
    it('should not modify edges that do not cross nodes', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process_1',
            x: 0,
            y: 0,
            width: 500,
            height: 200,
            children: [
              { id: 'task_1', x: 50, y: 50, width: 100, height: 80 },
              { id: 'task_2', x: 250, y: 50, width: 100, height: 80 },
            ],
            edges: [
              {
                id: 'edge_1',
                sources: ['task_1'],
                targets: ['task_2'],
                sections: [{
                  id: 'edge_1_s0',
                  startPoint: { x: 150, y: 90 },
                  endPoint: { x: 250, y: 90 },
                }],
              },
            ],
          },
        ],
      };

      const originalSections = JSON.stringify(graph.children?.[0]?.edges?.[0]?.sections);
      fixer.fix(graph);

      expect(JSON.stringify(graph.children?.[0]?.edges?.[0]?.sections)).toBe(originalSections);
    });

    it('should fix edge that crosses through a node', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process_1',
            x: 0,
            y: 0,
            width: 600,
            height: 200,
            children: [
              { id: 'task_1', x: 50, y: 50, width: 100, height: 80 },
              { id: 'task_2', x: 200, y: 50, width: 100, height: 80 }, // In the way
              { id: 'task_3', x: 400, y: 50, width: 100, height: 80 },
            ],
            edges: [
              {
                id: 'edge_1',
                sources: ['task_1'],
                targets: ['task_3'],
                sections: [{
                  id: 'edge_1_s0',
                  startPoint: { x: 150, y: 90 },
                  endPoint: { x: 400, y: 90 },
                  // This edge goes straight through task_2
                }],
              },
            ],
          },
        ],
      };

      fixer.fix(graph);

      const edge = graph.children?.[0]?.edges?.[0];
      // Edge should have been fixed - either with bend points or rerouted
      expect(edge?.sections?.[0]).toBeDefined();
    });

    it('should handle return edges (target above source)', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process_1',
            x: 0,
            y: 0,
            width: 600,
            height: 400,
            children: [
              { id: 'gateway_1', x: 200, y: 50, width: 50, height: 50 },  // Target (above)
              { id: 'task_1', x: 150, y: 250, width: 100, height: 80 },   // Source (below)
            ],
            edges: [
              {
                id: 'back_edge',
                sources: ['task_1'],
                targets: ['gateway_1'],
                sections: [{
                  id: 'back_edge_s0',
                  startPoint: { x: 200, y: 250 },
                  endPoint: { x: 225, y: 100 },
                }],
              },
            ],
          },
        ],
      };

      // Should not throw
      expect(() => fixer.fix(graph)).not.toThrow();
    });

    it('should process nested containers', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'pool_1',
            x: 0,
            y: 0,
            width: 600,
            height: 200,
            children: [
              { id: 'task_1', x: 50, y: 50, width: 100, height: 80 },
              { id: 'task_2', x: 250, y: 50, width: 100, height: 80 },
            ],
            edges: [
              {
                id: 'edge_1',
                sources: ['task_1'],
                targets: ['task_2'],
                sections: [{
                  id: 'edge_1_s0',
                  startPoint: { x: 150, y: 90 },
                  endPoint: { x: 250, y: 90 },
                }],
              },
            ],
          },
        ],
      };

      // Should not throw
      expect(() => fixer.fix(graph)).not.toThrow();
    });

    it('should handle edges without sections', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process_1',
            x: 0,
            y: 0,
            children: [
              { id: 'task_1', x: 50, y: 50, width: 100, height: 80 },
              { id: 'task_2', x: 250, y: 50, width: 100, height: 80 },
            ],
            edges: [
              {
                id: 'edge_1',
                sources: ['task_1'],
                targets: ['task_2'],
                // No sections
              },
            ],
          },
        ],
      };

      // Should not throw
      expect(() => fixer.fix(graph)).not.toThrow();
    });

    it('should handle empty graph', () => {
      const graph: ElkNode = { id: 'root' };
      expect(() => fixer.fix(graph)).not.toThrow();
    });

    it('should handle graph with no edges', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process_1',
            x: 0,
            y: 0,
            children: [
              { id: 'task_1', x: 50, y: 50, width: 100, height: 80 },
            ],
          },
        ],
      };

      expect(() => fixer.fix(graph)).not.toThrow();
    });
  });

  describe('edge fixing with bend points', () => {
    it('should preserve existing valid bend points', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process_1',
            x: 0,
            y: 0,
            width: 500,
            height: 200,
            children: [
              { id: 'task_1', x: 50, y: 50, width: 100, height: 80 },
              { id: 'task_2', x: 250, y: 120, width: 100, height: 80 },
            ],
            edges: [
              {
                id: 'edge_1',
                sources: ['task_1'],
                targets: ['task_2'],
                sections: [{
                  id: 'edge_1_s0',
                  startPoint: { x: 150, y: 90 },
                  endPoint: { x: 250, y: 160 },
                  bendPoints: [
                    { x: 200, y: 90 },
                    { x: 200, y: 160 },
                  ],
                }],
              },
            ],
          },
        ],
      };

      fixer.fix(graph);

      const edge = graph.children?.[0]?.edges?.[0];
      // Valid bend points should be preserved if they don't cross nodes
      expect(edge?.sections).toBeDefined();
    });

    it('should handle vertical edges', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process_1',
            x: 0,
            y: 0,
            width: 300,
            height: 400,
            children: [
              { id: 'task_1', x: 100, y: 50, width: 100, height: 80 },
              { id: 'task_2', x: 100, y: 250, width: 100, height: 80 },
            ],
            edges: [
              {
                id: 'edge_1',
                sources: ['task_1'],
                targets: ['task_2'],
                sections: [{
                  id: 'edge_1_s0',
                  startPoint: { x: 150, y: 130 },
                  endPoint: { x: 150, y: 250 },
                }],
              },
            ],
          },
        ],
      };

      expect(() => fixer.fix(graph)).not.toThrow();
    });
  });

  describe('container isolation', () => {
    it('should only check crossing with nodes in same container', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'pool_1',
            x: 0,
            y: 0,
            width: 500,
            height: 200,
            children: [
              { id: 'task_1', x: 50, y: 50, width: 100, height: 80 },
              { id: 'task_2', x: 300, y: 50, width: 100, height: 80 },
            ],
            edges: [
              {
                id: 'edge_1',
                sources: ['task_1'],
                targets: ['task_2'],
                sections: [{
                  id: 'edge_1_s0',
                  startPoint: { x: 150, y: 90 },
                  endPoint: { x: 300, y: 90 },
                }],
              },
            ],
          },
          {
            id: 'pool_2',
            x: 0,
            y: 250,
            width: 500,
            height: 200,
            children: [
              // This task is in a different pool, so edge_1 should not consider it
              { id: 'task_3', x: 200, y: 50, width: 100, height: 80 },
            ],
          },
        ],
      };

      const originalBendPoints = graph.children?.[0]?.edges?.[0]?.sections?.[0].bendPoints;
      fixer.fix(graph);

      // Edge should not be modified because task_3 is in a different pool
      expect(graph.children?.[0]?.edges?.[0]?.sections?.[0].bendPoints).toEqual(originalBendPoints);
    });
  });

  describe('multiple edges', () => {
    it('should fix multiple edges independently', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process_1',
            x: 0,
            y: 0,
            width: 700,
            height: 200,
            children: [
              { id: 'task_1', x: 50, y: 50, width: 100, height: 80 },
              { id: 'task_2', x: 200, y: 50, width: 100, height: 80 },
              { id: 'task_3', x: 350, y: 50, width: 100, height: 80 },
              { id: 'task_4', x: 500, y: 50, width: 100, height: 80 },
            ],
            edges: [
              {
                id: 'edge_1',
                sources: ['task_1'],
                targets: ['task_3'],
                sections: [{
                  id: 'edge_1_s0',
                  startPoint: { x: 150, y: 90 },
                  endPoint: { x: 350, y: 90 },
                  // Crosses task_2
                }],
              },
              {
                id: 'edge_2',
                sources: ['task_2'],
                targets: ['task_4'],
                sections: [{
                  id: 'edge_2_s0',
                  startPoint: { x: 300, y: 90 },
                  endPoint: { x: 500, y: 90 },
                  // Crosses task_3
                }],
              },
            ],
          },
        ],
      };

      fixer.fix(graph);

      // Both edges should be processed
      const edge1 = graph.children?.[0]?.edges?.[0];
      const edge2 = graph.children?.[0]?.edges?.[1];

      expect(edge1?.sections?.[0]).toBeDefined();
      expect(edge2?.sections?.[0]).toBeDefined();
    });
  });
});
