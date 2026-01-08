/**
 * Unit tests for TreeLayouter
 */

import { describe, it, expect } from 'vitest';
import {
  TreeLayouter,
  buildTree,
  layoutBoundaryBranch,
  type TreeNode,
} from '../../../src/layout/tree/tree-layouter';
import type { Bounds } from '../../../src/types/internal';

describe('TreeLayouter', () => {
  describe('layout', () => {
    it('should layout a single node', () => {
      const root: TreeNode = {
        id: 'root',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        children: [],
        prelim: 0,
        modifier: 0,
      };

      const layouter = new TreeLayouter();
      layouter.layout(root);

      // Single node should stay at origin after layout
      expect(root.x).toBe(0);
      expect(root.y).toBe(0);
    });

    it('should layout a tree with one level of children', () => {
      const root: TreeNode = {
        id: 'root',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        children: [
          {
            id: 'child1',
            x: 0,
            y: 0,
            width: 100,
            height: 80,
            children: [],
            prelim: 0,
            modifier: 0,
          },
          {
            id: 'child2',
            x: 0,
            y: 0,
            width: 100,
            height: 80,
            children: [],
            prelim: 0,
            modifier: 0,
          },
        ],
        prelim: 0,
        modifier: 0,
      };

      const layouter = new TreeLayouter({ horizontalGap: 40, verticalGap: 60 });
      layouter.layout(root);

      // Children should be on same Y level
      expect(root.children[0].y).toBe(root.children[1].y);
      // Children should be below root
      expect(root.children[0].y).toBeGreaterThan(root.y);
      // Child1 should be to the left of child2
      expect(root.children[0].x).toBeLessThan(root.children[1].x);
      // Root should be centered above children
      expect(root.x).toBeGreaterThan(root.children[0].x);
      expect(root.x).toBeLessThan(root.children[1].x);
    });

    it('should layout a deep tree', () => {
      const grandchild: TreeNode = {
        id: 'grandchild',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        children: [],
        prelim: 0,
        modifier: 0,
      };

      const child: TreeNode = {
        id: 'child',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        children: [grandchild],
        prelim: 0,
        modifier: 0,
      };

      const root: TreeNode = {
        id: 'root',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        children: [child],
        prelim: 0,
        modifier: 0,
      };

      const layouter = new TreeLayouter({ verticalGap: 60 });
      layouter.layout(root);

      // Each level should be progressively lower
      expect(root.y).toBeLessThan(child.y);
      expect(child.y).toBeLessThan(grandchild.y);
    });

    it('should handle direction RIGHT', () => {
      const root: TreeNode = {
        id: 'root',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        children: [
          {
            id: 'child1',
            x: 0,
            y: 0,
            width: 100,
            height: 80,
            children: [],
            prelim: 0,
            modifier: 0,
          },
        ],
        prelim: 0,
        modifier: 0,
      };

      const layouter = new TreeLayouter({ direction: 'RIGHT' });
      layouter.layout(root);

      // Child should be to the right of root
      expect(root.children[0].x).toBeGreaterThan(root.x);
    });
  });

  describe('applyOffset', () => {
    it('should offset all nodes in the tree', () => {
      const root: TreeNode = {
        id: 'root',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        children: [
          {
            id: 'child',
            x: 50,
            y: 100,
            width: 100,
            height: 80,
            children: [],
            prelim: 0,
            modifier: 0,
          },
        ],
        prelim: 0,
        modifier: 0,
      };

      const layouter = new TreeLayouter();
      layouter.applyOffset(root, 100, 200);

      expect(root.x).toBe(100);
      expect(root.y).toBe(200);
      expect(root.children[0].x).toBe(150);
      expect(root.children[0].y).toBe(300);
    });
  });

  describe('getTreeBounds', () => {
    it('should calculate correct bounds for a single node', () => {
      const root: TreeNode = {
        id: 'root',
        x: 50,
        y: 100,
        width: 100,
        height: 80,
        children: [],
        prelim: 0,
        modifier: 0,
      };

      const layouter = new TreeLayouter();
      const bounds = layouter.getTreeBounds(root);

      expect(bounds.x).toBe(50);
      expect(bounds.y).toBe(100);
      expect(bounds.width).toBe(100);
      expect(bounds.height).toBe(80);
    });

    it('should calculate correct bounds for a tree', () => {
      const root: TreeNode = {
        id: 'root',
        x: 100,
        y: 0,
        width: 100,
        height: 80,
        children: [
          {
            id: 'child1',
            x: 0,
            y: 100,
            width: 100,
            height: 80,
            children: [],
            prelim: 0,
            modifier: 0,
          },
          {
            id: 'child2',
            x: 200,
            y: 100,
            width: 100,
            height: 80,
            children: [],
            prelim: 0,
            modifier: 0,
          },
        ],
        prelim: 0,
        modifier: 0,
      };

      const layouter = new TreeLayouter();
      const bounds = layouter.getTreeBounds(root);

      expect(bounds.x).toBe(0);
      expect(bounds.y).toBe(0);
      expect(bounds.width).toBe(300); // 0 to 300
      expect(bounds.height).toBe(180); // 0 to 180
    });
  });
});

describe('buildTree', () => {
  it('should build a tree from node and edge maps', () => {
    const nodeMap = new Map<string, Bounds & { id: string }>([
      ['root', { id: 'root', x: 0, y: 0, width: 100, height: 80 }],
      ['child1', { id: 'child1', x: 0, y: 0, width: 100, height: 80 }],
      ['child2', { id: 'child2', x: 0, y: 0, width: 100, height: 80 }],
    ]);

    const edgeMap = new Map<string, string[]>([
      ['root', ['child1', 'child2']],
    ]);

    const tree = buildTree('root', nodeMap, edgeMap);

    expect(tree).not.toBeNull();
    expect(tree!.id).toBe('root');
    expect(tree!.children.length).toBe(2);
    expect(tree!.children[0].id).toBe('child1');
    expect(tree!.children[1].id).toBe('child2');
  });

  it('should return null for non-existent root', () => {
    const nodeMap = new Map<string, Bounds & { id: string }>();
    const edgeMap = new Map<string, string[]>();

    const tree = buildTree('nonexistent', nodeMap, edgeMap);

    expect(tree).toBeNull();
  });

  it('should handle cycles by using visited set', () => {
    const nodeMap = new Map<string, Bounds & { id: string }>([
      ['a', { id: 'a', x: 0, y: 0, width: 100, height: 80 }],
      ['b', { id: 'b', x: 0, y: 0, width: 100, height: 80 }],
    ]);

    // Cycle: a -> b -> a
    const edgeMap = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ]);

    const tree = buildTree('a', nodeMap, edgeMap);

    expect(tree).not.toBeNull();
    expect(tree!.children.length).toBe(1);
    expect(tree!.children[0].id).toBe('b');
    // The cycle back to 'a' should be broken
    expect(tree!.children[0].children.length).toBe(0);
  });

  it('should build a deep tree', () => {
    const nodeMap = new Map<string, Bounds & { id: string }>([
      ['root', { id: 'root', x: 0, y: 0, width: 100, height: 80 }],
      ['level1', { id: 'level1', x: 0, y: 0, width: 100, height: 80 }],
      ['level2', { id: 'level2', x: 0, y: 0, width: 100, height: 80 }],
      ['level3', { id: 'level3', x: 0, y: 0, width: 100, height: 80 }],
    ]);

    const edgeMap = new Map<string, string[]>([
      ['root', ['level1']],
      ['level1', ['level2']],
      ['level2', ['level3']],
    ]);

    const tree = buildTree('root', nodeMap, edgeMap);

    expect(tree).not.toBeNull();
    expect(tree!.children[0].id).toBe('level1');
    expect(tree!.children[0].children[0].id).toBe('level2');
    expect(tree!.children[0].children[0].children[0].id).toBe('level3');
  });
});

describe('layoutBoundaryBranch', () => {
  it('should layout a boundary branch relative to parent', () => {
    const nodeMap = new Map<string, Bounds & { id: string }>([
      ['target', { id: 'target', x: 0, y: 0, width: 100, height: 80 }],
      ['child', { id: 'child', x: 0, y: 0, width: 100, height: 80 }],
    ]);

    const edgeMap = new Map<string, string[]>([
      ['target', ['child']],
    ]);

    const parentNode: Bounds = { x: 100, y: 100, width: 200, height: 100 };

    const result = layoutBoundaryBranch(
      'target',
      nodeMap,
      edgeMap,
      parentNode,
      { horizontalGap: 40, verticalGap: 60 }
    );

    expect(result.size).toBe(2);
    expect(result.has('target')).toBe(true);
    expect(result.has('child')).toBe(true);

    // Target should be below parent
    const targetPos = result.get('target')!;
    expect(targetPos.y).toBeGreaterThan(parentNode.y + parentNode.height);

    // Child should be below target
    const childPos = result.get('child')!;
    expect(childPos.y).toBeGreaterThan(targetPos.y);
  });

  it('should return empty map for non-existent target', () => {
    const nodeMap = new Map<string, Bounds & { id: string }>();
    const edgeMap = new Map<string, string[]>();
    const parentNode: Bounds = { x: 100, y: 100, width: 200, height: 100 };

    const result = layoutBoundaryBranch(
      'nonexistent',
      nodeMap,
      edgeMap,
      parentNode
    );

    expect(result.size).toBe(0);
  });

  it('should center branch under parent', () => {
    const nodeMap = new Map<string, Bounds & { id: string }>([
      ['target', { id: 'target', x: 0, y: 0, width: 100, height: 80 }],
    ]);

    const edgeMap = new Map<string, string[]>();
    const parentNode: Bounds = { x: 100, y: 100, width: 200, height: 100 };

    const result = layoutBoundaryBranch(
      'target',
      nodeMap,
      edgeMap,
      parentNode
    );

    const targetPos = result.get('target')!;
    // Target should be roughly centered under parent
    const parentCenterX = parentNode.x + parentNode.width / 2;
    const targetCenterX = targetPos.x + 50; // 50 = target width / 2
    expect(Math.abs(parentCenterX - targetCenterX)).toBeLessThan(1);
  });
});
