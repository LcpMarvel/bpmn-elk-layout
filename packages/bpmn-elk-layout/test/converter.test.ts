import { describe, it, expect } from 'vitest';
import { BpmnElkLayout } from '../src/converter';
import type { ElkBpmnGraph } from '../src/types';

describe('BpmnElkLayout', () => {
  describe('to_json', () => {
    it('should layout a simple process', async () => {
      const input: ElkBpmnGraph = {
        id: 'definitions_1',
        children: [
          {
            id: 'process_1',
            bpmn: { type: 'process', name: 'Simple Process', isExecutable: true },
            children: [
              {
                id: 'start_1',
                bpmn: { type: 'startEvent', eventDefinitionType: 'none', name: 'Start' },
              },
              {
                id: 'task_1',
                bpmn: { type: 'userTask', name: 'Do Something' },
              },
              {
                id: 'end_1',
                bpmn: { type: 'endEvent', eventDefinitionType: 'none', name: 'End' },
              },
            ],
            edges: [
              {
                id: 'flow_1',
                sources: ['start_1'],
                targets: ['task_1'],
                bpmn: { type: 'sequenceFlow' },
              },
              {
                id: 'flow_2',
                sources: ['task_1'],
                targets: ['end_1'],
                bpmn: { type: 'sequenceFlow' },
              },
            ],
          },
        ],
      };

      const converter = new BpmnElkLayout();
      const result = await converter.to_json(input);

      // Check that the process has coordinates
      expect(result.children).toHaveLength(1);
      const process = result.children[0] as { x?: number; y?: number; children?: Array<{ x: number; y: number }> };
      expect(process.children).toBeDefined();
      expect(process.children!.length).toBe(3);

      // Check that each node has coordinates
      for (const child of process.children!) {
        expect(child.x).toBeDefined();
        expect(child.y).toBeDefined();
        expect(typeof child.x).toBe('number');
        expect(typeof child.y).toBe('number');
      }
    });
  });

  describe('to_bpmn', () => {
    it('should generate valid BPMN XML from a simple process', async () => {
      const input: ElkBpmnGraph = {
        id: 'definitions_1',
        bpmn: {
          targetNamespace: 'http://example.com/bpmn',
          exporter: 'test',
          exporterVersion: '1.0.0',
        },
        children: [
          {
            id: 'process_1',
            bpmn: { type: 'process', name: 'Simple Process', isExecutable: true },
            children: [
              {
                id: 'start_1',
                bpmn: { type: 'startEvent', eventDefinitionType: 'none', name: 'Start' },
              },
              {
                id: 'task_1',
                bpmn: { type: 'userTask', name: 'Do Something' },
              },
              {
                id: 'end_1',
                bpmn: { type: 'endEvent', eventDefinitionType: 'none', name: 'End' },
              },
            ],
            edges: [
              {
                id: 'flow_1',
                sources: ['start_1'],
                targets: ['task_1'],
                bpmn: { type: 'sequenceFlow' },
              },
              {
                id: 'flow_2',
                sources: ['task_1'],
                targets: ['end_1'],
                bpmn: { type: 'sequenceFlow' },
              },
            ],
          },
        ],
      };

      const converter = new BpmnElkLayout();
      const xml = await converter.to_bpmn(input);

      // Basic structure checks
      expect(xml).toContain('<?xml');
      expect(xml).toContain('bpmn:definitions');
      expect(xml).toContain('bpmn:process');
      expect(xml).toContain('bpmn:startEvent');
      expect(xml).toContain('bpmn:userTask');
      expect(xml).toContain('bpmn:endEvent');
      expect(xml).toContain('bpmn:sequenceFlow');
      expect(xml).toContain('bpmndi:BPMNDiagram');
      expect(xml).toContain('bpmndi:BPMNPlane');
      expect(xml).toContain('bpmndi:BPMNShape');
      expect(xml).toContain('bpmndi:BPMNEdge');
      expect(xml).toContain('dc:Bounds');
      expect(xml).toContain('di:waypoint');

      // Check IDs are present
      expect(xml).toContain('id="start_1"');
      expect(xml).toContain('id="task_1"');
      expect(xml).toContain('id="end_1"');
      expect(xml).toContain('id="flow_1"');
      expect(xml).toContain('id="flow_2"');
    });

    it('should handle collaboration with multiple pools', async () => {
      const input: ElkBpmnGraph = {
        id: 'definitions_collab',
        children: [
          {
            id: 'collaboration_1',
            bpmn: { type: 'collaboration', name: 'Test Collaboration' },
            children: [
              {
                id: 'pool_a',
                bpmn: { type: 'participant', name: 'Pool A', processRef: 'process_a' },
                children: [
                  {
                    id: 'start_a',
                    bpmn: { type: 'startEvent', eventDefinitionType: 'none' },
                  },
                  {
                    id: 'task_a',
                    bpmn: { type: 'sendTask', name: 'Send Message' },
                  },
                ],
                edges: [
                  {
                    id: 'flow_a1',
                    sources: ['start_a'],
                    targets: ['task_a'],
                    bpmn: { type: 'sequenceFlow' },
                  },
                ],
              },
              {
                id: 'pool_b',
                bpmn: { type: 'participant', name: 'Pool B', processRef: 'process_b' },
                children: [
                  {
                    id: 'start_b',
                    bpmn: { type: 'startEvent', eventDefinitionType: 'message' },
                  },
                  {
                    id: 'task_b',
                    bpmn: { type: 'receiveTask', name: 'Receive Message' },
                  },
                ],
                edges: [
                  {
                    id: 'flow_b1',
                    sources: ['start_b'],
                    targets: ['task_b'],
                    bpmn: { type: 'sequenceFlow' },
                  },
                ],
              },
            ],
            edges: [
              {
                id: 'msg_flow_1',
                sources: ['task_a'],
                targets: ['start_b'],
                bpmn: { type: 'messageFlow', name: 'Request' },
              },
            ],
          },
        ],
      };

      const converter = new BpmnElkLayout();
      const xml = await converter.to_bpmn(input);

      // Check collaboration structure
      expect(xml).toContain('bpmn:collaboration');
      expect(xml).toContain('bpmn:participant');
      expect(xml).toContain('bpmn:messageFlow');
      expect(xml).toContain('id="pool_a"');
      expect(xml).toContain('id="pool_b"');
    });
  });

  describe('ELK options', () => {
    it('should apply custom ELK options', async () => {
      const input: ElkBpmnGraph = {
        id: 'definitions_1',
        children: [
          {
            id: 'process_1',
            bpmn: { type: 'process' },
            children: [
              { id: 'start_1', bpmn: { type: 'startEvent', eventDefinitionType: 'none' } },
              { id: 'end_1', bpmn: { type: 'endEvent', eventDefinitionType: 'none' } },
            ],
            edges: [
              { id: 'flow_1', sources: ['start_1'], targets: ['end_1'], bpmn: { type: 'sequenceFlow' } },
            ],
          },
        ],
      };

      const converter = new BpmnElkLayout({
        elkOptions: {
          'elk.direction': 'DOWN',
          'elk.spacing.nodeNode': 100,
        },
      });

      const result = await converter.to_json(input);

      // Just verify it doesn't throw and returns valid structure
      expect(result.children).toHaveLength(1);
    });
  });
});
