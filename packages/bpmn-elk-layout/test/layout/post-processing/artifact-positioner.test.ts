import { describe, it, expect } from 'vitest';
import { ArtifactPositioner, ARTIFACT_TYPES } from '../../../src/layout/post-processing/artifact-positioner';
import type { ElkBpmnGraph } from '../../../src/types';
import type { ElkNode } from 'elkjs';

describe('ArtifactPositioner', () => {
  const positioner = new ArtifactPositioner();

  describe('ARTIFACT_TYPES', () => {
    it('should include all artifact types', () => {
      expect(ARTIFACT_TYPES.has('dataObject')).toBe(true);
      expect(ARTIFACT_TYPES.has('dataObjectReference')).toBe(true);
      expect(ARTIFACT_TYPES.has('dataStoreReference')).toBe(true);
      expect(ARTIFACT_TYPES.has('textAnnotation')).toBe(true);
    });

    it('should not include non-artifact types', () => {
      expect(ARTIFACT_TYPES.has('task')).toBe(false);
      expect(ARTIFACT_TYPES.has('startEvent')).toBe(false);
      expect(ARTIFACT_TYPES.has('gateway')).toBe(false);
      // dataInput/dataOutput are not artifacts - they belong to ioSpecification
      expect(ARTIFACT_TYPES.has('dataInput')).toBe(false);
      expect(ARTIFACT_TYPES.has('dataOutput')).toBe(false);
    });
  });

  describe('collectInfo', () => {
    it('should collect artifact info from data input associations', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'dataObj1', bpmn: { type: 'dataObject', name: 'Input Data' } },
              { id: 'task1', bpmn: { type: 'task', name: 'Task 1' } },
            ],
            edges: [
              { id: 'edge1', sources: ['dataObj1'], targets: ['task1'], bpmn: { type: 'dataInputAssociation' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const info = positioner.collectInfo(graph);

      expect(info.size).toBe(1);
      expect(info.get('dataObj1')).toEqual({
        associatedTaskId: 'task1',
        isInput: true,
      });
    });

    it('should collect artifact info from data output associations', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'task1', bpmn: { type: 'task', name: 'Task 1' } },
              { id: 'dataStore1', bpmn: { type: 'dataStoreReference', name: 'Output Store' } },
            ],
            edges: [
              { id: 'edge1', sources: ['task1'], targets: ['dataStore1'], bpmn: { type: 'dataOutputAssociation' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const info = positioner.collectInfo(graph);

      expect(info.size).toBe(1);
      expect(info.get('dataStore1')).toEqual({
        associatedTaskId: 'task1',
        isInput: false,
      });
    });

    it('should handle graph with no artifacts', () => {
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
            edges: [
              { id: 'edge1', sources: ['task1'], targets: ['task2'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const info = positioner.collectInfo(graph);
      expect(info.size).toBe(0);
    });

    it('should handle association edge type', () => {
      const graph: ElkBpmnGraph = {
        id: 'root',
        children: [
          {
            id: 'process1',
            bpmn: { type: 'process' },
            children: [
              { id: 'annotation1', bpmn: { type: 'textAnnotation', name: 'Note' } },
              { id: 'task1', bpmn: { type: 'task', name: 'Task 1' } },
            ],
            edges: [
              { id: 'edge1', sources: ['annotation1'], targets: ['task1'], bpmn: { type: 'association' } },
            ],
          },
        ],
      } as unknown as ElkBpmnGraph;

      const info = positioner.collectInfo(graph);

      expect(info.size).toBe(1);
      expect(info.get('annotation1')?.isInput).toBe(true);
    });
  });

  describe('reposition', () => {
    it('should position input artifact above and left of task', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'dataObj1', x: 500, y: 500, width: 36, height: 50 },
          { id: 'task1', x: 100, y: 100, width: 100, height: 80 },
        ],
      };

      const artifactInfo = new Map([
        ['dataObj1', { associatedTaskId: 'task1', isInput: true }],
      ]);

      positioner.reposition(graph, artifactInfo);

      const dataObj = graph.children?.find(c => c.id === 'dataObj1');
      expect(dataObj?.x).toBe(100); // Aligned to left of task
      expect(dataObj?.y).toBe(100 - 50 - 20); // Above task with gap
    });

    it('should position output artifact to the right of task', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'task1', x: 100, y: 100, width: 100, height: 80 },
          { id: 'dataStore1', x: 500, y: 500, width: 50, height: 50 },
        ],
      };

      const artifactInfo = new Map([
        ['dataStore1', { associatedTaskId: 'task1', isInput: false }],
      ]);

      positioner.reposition(graph, artifactInfo);

      const dataStore = graph.children?.find(c => c.id === 'dataStore1');
      expect(dataStore?.x).toBe(100 + 100 + 15); // Right of task with gap
      expect(dataStore?.y).toBe(100 - 50 - 20); // Above task level
    });

    it('should handle multiple input artifacts for same task', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'dataObj1', x: 500, y: 500, width: 36, height: 50 },
          { id: 'dataObj2', x: 600, y: 600, width: 36, height: 50 },
          { id: 'task1', x: 100, y: 100, width: 100, height: 80 },
        ],
      };

      const artifactInfo = new Map([
        ['dataObj1', { associatedTaskId: 'task1', isInput: true }],
        ['dataObj2', { associatedTaskId: 'task1', isInput: true }],
      ]);

      positioner.reposition(graph, artifactInfo);

      const dataObj1 = graph.children?.find(c => c.id === 'dataObj1');
      const dataObj2 = graph.children?.find(c => c.id === 'dataObj2');

      // Both should be above task
      expect(dataObj1?.y).toBe(100 - 50 - 20);
      expect(dataObj2?.y).toBe(100 - 50 - 20);

      // They should be offset horizontally
      expect(dataObj1?.x).toBe(100);
      expect(dataObj2?.x).toBe(100 + 36 + 15);
    });

    it('should handle nested nodes', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process',
            children: [
              { id: 'dataObj1', x: 500, y: 500, width: 36, height: 50 },
              { id: 'task1', x: 100, y: 100, width: 100, height: 80 },
            ],
          },
        ],
      };

      const artifactInfo = new Map([
        ['dataObj1', { associatedTaskId: 'task1', isInput: true }],
      ]);

      positioner.reposition(graph, artifactInfo);

      const process = graph.children?.[0];
      const dataObj = process?.children?.find(c => c.id === 'dataObj1');
      expect(dataObj?.x).toBe(100);
      expect(dataObj?.y).toBe(100 - 50 - 20);
    });
  });

  describe('recalculateWithObstacleAvoidance', () => {
    it('should recalculate edges with obstacles', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          { id: 'dataObj1', x: 100, y: 20, width: 36, height: 50 },
          { id: 'task1', x: 100, y: 100, width: 100, height: 80 },
          { id: 'task2', x: 50, y: 50, width: 40, height: 40 }, // Obstacle
        ],
        edges: [
          {
            id: 'edge1',
            sources: ['dataObj1'],
            targets: ['task1'],
            sections: [],
          },
        ],
      };

      const artifactInfo = new Map([
        ['dataObj1', { associatedTaskId: 'task1', isInput: true }],
      ]);

      // Should not throw
      expect(() => {
        positioner.recalculateWithObstacleAvoidance(graph, artifactInfo);
      }).not.toThrow();

      // Edge should have sections
      const edge = graph.edges?.[0];
      expect(edge?.sections).toBeDefined();
      expect(edge?.sections?.length).toBeGreaterThan(0);
    });

    it('should handle edges in nested nodes', () => {
      const graph: ElkNode = {
        id: 'root',
        children: [
          {
            id: 'process',
            children: [
              { id: 'dataObj1', x: 100, y: 20, width: 36, height: 50 },
              { id: 'task1', x: 100, y: 100, width: 100, height: 80 },
            ],
            edges: [
              {
                id: 'edge1',
                sources: ['dataObj1'],
                targets: ['task1'],
                sections: [],
              },
            ],
          },
        ],
      };

      const artifactInfo = new Map([
        ['dataObj1', { associatedTaskId: 'task1', isInput: true }],
      ]);

      expect(() => {
        positioner.recalculateWithObstacleAvoidance(graph, artifactInfo);
      }).not.toThrow();
    });
  });
});
