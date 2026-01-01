/**
 * Prompt Template Generator for ELK-BPMN JSON
 *
 * Dynamically analyzes test fixtures and schema to generate
 * a comprehensive AI prompt template for ELK-BPMN JSON generation.
 */

import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_SIZES,
  DEFAULT_ELK_OPTIONS,
  EVENT_TYPES,
  TASK_TYPES,
  GATEWAY_TYPES,
  SUBPROCESS_TYPES,
} from './types/bpmn-constants';

// ============================================================================
// Types
// ============================================================================

export interface PromptGeneratorOptions {
  /** Path to fixtures directory */
  fixturesDir?: string;
  /** Path to ELK-BPMN schema file */
  schemaPath?: string;
}

interface FixtureAnalysis {
  totalFixtures: number;
  eventTypes: Set<string>;
  eventDefinitionTypes: Set<string>;
  taskTypes: Set<string>;
  gatewayTypes: Set<string>;
  subprocessTypes: Set<string>;
  hasCollaborations: boolean;
  hasLanes: boolean;
  hasBoundaryEvents: boolean;
  hasMessageFlows: boolean;
  hasConditionExpressions: boolean;
  hasTimerDefinitions: boolean;
  hasLoopCharacteristics: boolean;
  examples: {
    simpleProcess?: unknown;
    collaboration?: unknown;
  };
}

interface SchemaInfo {
  version: string;
  title: string;
  eventDefinitionTypes: string[];
  taskTypes: string[];
  gatewayTypes: string[];
  subprocessTypes: string[];
}

// ============================================================================
// PromptTemplateGenerator Class
// ============================================================================

export class PromptTemplateGenerator {
  private options: Required<PromptGeneratorOptions>;

  constructor(options: PromptGeneratorOptions = {}) {
    // Get package root directory
    // When running from dist/, we need to go up to find test/fixtures
    const currentDir = dirname(fileURLToPath(import.meta.url));

    // Check if we're in dist/ or src/
    const isInDist = currentDir.includes('/dist');
    const packageRoot = isInDist
      ? join(currentDir, '..', '..')  // dist/bin -> package root
      : join(currentDir, '..');        // src -> package root
    const projectRoot = join(packageRoot, '../..');

    this.options = {
      fixturesDir: options.fixturesDir || join(packageRoot, 'test/fixtures'),
      schemaPath: options.schemaPath || join(projectRoot, 'elk-bpmn-schema.json'),
    };
  }

  /**
   * Analyze all fixture files to extract patterns and examples
   */
  async analyzeFixtures(): Promise<FixtureAnalysis> {
    const analysis: FixtureAnalysis = {
      totalFixtures: 0,
      eventTypes: new Set(),
      eventDefinitionTypes: new Set(),
      taskTypes: new Set(),
      gatewayTypes: new Set(),
      subprocessTypes: new Set(),
      hasCollaborations: false,
      hasLanes: false,
      hasBoundaryEvents: false,
      hasMessageFlows: false,
      hasConditionExpressions: false,
      hasTimerDefinitions: false,
      hasLoopCharacteristics: false,
      examples: {},
    };

    const files = await readdir(this.options.fixturesDir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    for (const file of jsonFiles) {
      const content = await readFile(join(this.options.fixturesDir, file), 'utf-8');
      const fixture = JSON.parse(content);
      analysis.totalFixtures++;

      this.analyzeNode(fixture, analysis);

      // Extract example fixtures
      if (file.includes('simple-process') && !analysis.examples.simpleProcess) {
        analysis.examples.simpleProcess = fixture;
      }
      if (file.includes('collaboration-simple') && !analysis.examples.collaboration) {
        analysis.examples.collaboration = fixture;
      }
    }

    return analysis;
  }

  /**
   * Recursively analyze a node and its children
   */
  private analyzeNode(node: Record<string, unknown>, analysis: FixtureAnalysis): void {
    if (!node || typeof node !== 'object') return;

    const bpmn = node['bpmn'] as Record<string, unknown> | undefined;
    if (bpmn && bpmn['type']) {
      const type = bpmn['type'] as string;

      // Categorize types
      if (EVENT_TYPES.includes(type as (typeof EVENT_TYPES)[number])) {
        analysis.eventTypes.add(type);
        if (bpmn['eventDefinitionType']) {
          analysis.eventDefinitionTypes.add(bpmn['eventDefinitionType'] as string);
        }
      } else if (TASK_TYPES.includes(type as (typeof TASK_TYPES)[number])) {
        analysis.taskTypes.add(type);
      } else if (GATEWAY_TYPES.includes(type as (typeof GATEWAY_TYPES)[number])) {
        analysis.gatewayTypes.add(type);
      } else if (SUBPROCESS_TYPES.includes(type as (typeof SUBPROCESS_TYPES)[number])) {
        analysis.subprocessTypes.add(type);
      } else if (type === 'collaboration') {
        analysis.hasCollaborations = true;
      } else if (type === 'lane') {
        analysis.hasLanes = true;
      } else if (type === 'messageFlow') {
        analysis.hasMessageFlows = true;
      }

      // Check for specific features
      if (bpmn['timerEventDefinition']) {
        analysis.hasTimerDefinitions = true;
      }
      if (bpmn['loopCharacteristics']) {
        analysis.hasLoopCharacteristics = true;
      }
      if (bpmn['conditionExpression']) {
        analysis.hasConditionExpressions = true;
      }
    }

    // Check for boundary events
    const boundaryEvents = node['boundaryEvents'] as unknown[] | undefined;
    if (Array.isArray(boundaryEvents) && boundaryEvents.length > 0) {
      analysis.hasBoundaryEvents = true;
      for (const be of boundaryEvents) {
        this.analyzeNode(be as Record<string, unknown>, analysis);
      }
    }

    // Recurse into children
    const children = node['children'] as unknown[] | undefined;
    if (Array.isArray(children)) {
      for (const child of children) {
        this.analyzeNode(child as Record<string, unknown>, analysis);
      }
    }

    // Recurse into edges
    const edges = node['edges'] as unknown[] | undefined;
    if (Array.isArray(edges)) {
      for (const edge of edges) {
        this.analyzeNode(edge as Record<string, unknown>, analysis);
        const edgeBpmn = (edge as Record<string, unknown>)['bpmn'] as Record<string, unknown> | undefined;
        if (edgeBpmn?.['conditionExpression']) {
          analysis.hasConditionExpressions = true;
        }
      }
    }
  }

  /**
   * Load and parse the schema file
   */
  async loadSchema(): Promise<SchemaInfo> {
    const content = await readFile(this.options.schemaPath, 'utf-8');
    const schema = JSON.parse(content);

    return {
      version: schema.version || '2.0.0',
      title: schema.title || 'ELK-BPMN Extended Schema',
      eventDefinitionTypes: schema.definitions?.bpmnEvent?.properties?.eventDefinitionType?.enum || [],
      taskTypes: schema.definitions?.bpmnTask?.properties?.type?.enum || [],
      gatewayTypes: schema.definitions?.bpmnGateway?.properties?.type?.enum || [],
      subprocessTypes: schema.definitions?.bpmnSubProcess?.properties?.type?.enum || [],
    };
  }

  /**
   * Generate the complete prompt template
   */
  async generate(): Promise<string> {
    const [analysis, schema] = await Promise.all([this.analyzeFixtures(), this.loadSchema()]);

    return this.buildTemplate(analysis, schema);
  }

  /**
   * Build the final template string
   * Output is a clean system prompt that can be directly copied to AI
   */
  private buildTemplate(analysis: FixtureAnalysis, schema: SchemaInfo): string {
    const sections: string[] = [];

    // System Prompt intro
    sections.push(this.generateSystemPrompt());

    // Output Format
    sections.push(this.generateOutputFormat());

    // Standard Dimensions
    sections.push(this.generateDimensions());

    // Structure Hierarchy
    sections.push(this.generateStructure());

    // Event Type Guide
    sections.push(this.generateEventGuide(schema));

    // Task Type Guide
    sections.push(this.generateTaskGuide(schema));

    // Gateway Rules
    sections.push(this.generateGatewayRules());

    // ID Naming Conventions
    sections.push(this.generateNamingConventions());

    // Important Rules
    sections.push(this.generateImportantRules());

    // User Prompt Template
    sections.push(this.generateUserPromptTemplate());

    // Example
    sections.push(this.generateExample(analysis));

    // Self-Check List
    sections.push(this.generateSelfCheckList());

    // Common Errors
    sections.push(this.generateCommonErrors());

    return sections.join('\n\n');
  }

  private generateSystemPrompt(): string {
    return `You are a professional BPMN 2.0 process modeling expert. Your task is to convert user's business process descriptions into ELK-BPMN extended format JSON.

Core capabilities:
1. Understand complex business processes and convert to standard BPMN elements
2. Correctly use various events, tasks, gateways, and subprocesses
3. Handle multi-participant collaborations and message exchanges
4. Set up conditional branches and exception handling`;
  }

  private generateOutputFormat(): string {
    return `Output Format Requirements:
1. Output must be valid JSON
2. Follow ELK-BPMN Extended Schema v2.0
3. Each node must contain id, bpmn, width, height
4. Edges must contain id, sources, targets, bpmn
5. Conditional branches must contain conditionExpression`;
  }

  private generateDimensions(): string {
    const items = [
      `- All events: ${DEFAULT_SIZES.EVENT.width}x${DEFAULT_SIZES.EVENT.height}`,
      `- All tasks: ${DEFAULT_SIZES.TASK.width}x${DEFAULT_SIZES.TASK.height} (can be 120-150 wide for long names)`,
      `- All gateways: ${DEFAULT_SIZES.GATEWAY.width}x${DEFAULT_SIZES.GATEWAY.height}`,
      `- Collapsed subprocess: ${DEFAULT_SIZES.SUBPROCESS_COLLAPSED.width}x${DEFAULT_SIZES.SUBPROCESS_COLLAPSED.height}`,
      `- Expanded subprocess: minimum ${DEFAULT_SIZES.SUBPROCESS_EXPANDED_MIN.width}x${DEFAULT_SIZES.SUBPROCESS_EXPANDED_MIN.height}`,
      `- Data object: ${DEFAULT_SIZES.DATA_OBJECT.width}x${DEFAULT_SIZES.DATA_OBJECT.height}`,
      `- Data store: ${DEFAULT_SIZES.DATA_STORE.width}x${DEFAULT_SIZES.DATA_STORE.height}`,
    ];

    return `Standard Dimensions (Required):\n${items.join('\n')}`;
  }

  private generateStructure(): string {
    return `Structure Hierarchy:

Multi-Pool Collaboration Structure:
definitions
└── collaboration
    ├── participant (Pool 1)
    │   ├── lane (swimlane)
    │   │   └── flowNode
    │   └── edges[] (sequence flows)
    ├── participant (Pool 2)
    │   └── ...
    └── edges[] (message flows, cross-Pool)

Single Process Structure:
definitions
└── process
    ├── flowNode
    └── edges[] (sequence flows)`;
  }

  private generateEventGuide(schema: SchemaInfo): string {
    const rows = [
      '| Process natural start | startEvent | none |',
      '| Start on message received | startEvent | message |',
      '| Start on timer | startEvent | timer |',
      '| Start on condition | startEvent | conditional |',
      '| Start on signal | startEvent | signal |',
      '| Normal process end | endEvent | none |',
      '| End with message | endEvent | message |',
      '| End with error | endEvent | error |',
      '| Terminate all branches | endEvent | terminate |',
      '| Cancel transaction | endEvent | cancel |',
      '| Trigger escalation | endEvent | escalation |',
      '| Trigger compensation | endEvent | compensation |',
      '| Wait for message | intermediateCatchEvent | message |',
      '| Wait for time | intermediateCatchEvent | timer |',
      '| Wait for signal | intermediateCatchEvent | signal |',
      '| Wait for condition | intermediateCatchEvent | conditional |',
      '| Link catch | intermediateCatchEvent | link |',
      '| Send message | intermediateThrowEvent | message |',
      '| Send signal | intermediateThrowEvent | signal |',
      '| Link throw | intermediateThrowEvent | link |',
      '| Activity timeout | boundaryEvent | timer |',
      '| Activity error | boundaryEvent | error |',
      '| Activity message | boundaryEvent | message |',
      '| Activity escalation | boundaryEvent | escalation |',
    ];

    return `Event Type Selection Guide:

| Scenario | Event Type | eventDefinitionType |
|-----|---------|-------------------|
${rows.join('\n')}`;
  }

  private generateTaskGuide(schema: SchemaInfo): string {
    const rows = [
      '| Requires human action | userTask |',
      '| Call API/service | serviceTask |',
      '| Execute script | scriptTask |',
      '| Send message/notification | sendTask |',
      '| Wait to receive message | receiveTask |',
      '| Manual operation outside system | manualTask |',
      '| Call business rule/DMN | businessRuleTask |',
      '| Generic task | task |',
    ];

    return `Task Type Selection Guide:

| Scenario | Task Type |
|-----|---------|
${rows.join('\n')}`;
  }

  private generateGatewayRules(): string {
    return `Gateway Usage Rules:

1. Exclusive Gateway (exclusiveGateway)
   - Must specify default attribute pointing to default outgoing flow
   - Other outgoing flows must have conditionExpression
   - Takes only one path (XOR semantics)

2. Parallel Gateway (parallelGateway)
   - Use for both forking and joining
   - No conditions needed
   - Takes all paths (AND semantics)

3. Inclusive Gateway (inclusiveGateway)
   - Can take one or more paths
   - Requires condition expressions
   - Takes at least one path (OR semantics)

4. Event-Based Gateway (eventBasedGateway)
   - Followed by multiple intermediate catch events
   - Whichever event occurs first determines the path
   - Commonly used for message waiting or timeout handling

5. Complex Gateway (complexGateway)
   - Custom activation condition
   - Uses activationCondition expression`;
  }

  private generateNamingConventions(): string {
    const items = [
      '- Pool: pool_[department/role]',
      '- Lane: lane_[role]',
      '- Start event: start_[description]',
      '- End event: end_[description]',
      '- Intermediate catch event: catch_[description]',
      '- Intermediate throw event: throw_[description]',
      '- Boundary event: boundary_[trigger_type]_[description]',
      '- Task: task_[action]',
      '- Gateway: gateway_[condition]',
      '- Subprocess: subprocess_[description]',
      '- Sequence flow: flow_[number] or flow_[description]',
      '- Message flow: msgflow_[description]',
      '- Message definition: msg_[description]',
      '- Signal definition: signal_[description]',
      '- Error definition: error_[description]',
    ];

    return `ID Naming Conventions:\n${items.join('\n')}`;
  }

  private generateImportantRules(): string {
    return `Important Rules:

1. Sequence Flow vs Message Flow
   - Cross-lane connections (within same Pool) are sequence flows, in participant.edges
   - Cross-Pool connections are message flows, must be in collaboration.edges
   - Message flows can only connect elements in different Pools

2. Process Reference
   - Each Pool must specify processRef
   - processRef value should uniquely identify the participant's process

3. Condition Expressions
   - Conditional branches after exclusive/inclusive gateways need conditionExpression (except default)
   - Conditions use body field to store expression content

4. Event Constraints
   - Start events have no incoming edges, end events have no outgoing edges
   - Boundary events defined in boundaryEvents array with attachedToRef

5. Interrupting vs Non-Interrupting
   - Boundary events are interrupting by default (isInterrupting: true)
   - Non-interrupting boundary events set isInterrupting: false

6. Timer Configuration
   - Use timerEventDefinition object
   - Supports timeDate (fixed time), timeDuration (duration), timeCycle (cycle)

7. Message Reference
   - Message events should set messageRef to reference global message definition
   - Global messages defined in root node's messages array`;
  }

  private generateUserPromptTemplate(): string {
    return `User Input Format Template:

Please generate ELK-BPMN format JSON based on the following business process description:

【Process Name】
{process name}

【Departments/Roles】
- {Department1}: {Role1}, {Role2}
- {Department2}: {Role3}
...

【Process Steps】
1. {step description}
2. {step description}
...

【Conditional Branches】(if any)
- {condition1}: {handling}
- {condition2}: {handling}

【Exception Handling】(if any)
- {exception scenario}: {handling}

【Cross-Department Interactions】(if any)
- {DepartmentA} → {DepartmentB}: {interaction content}

【Timer/Timeout Requirements】(if any)
- {timer trigger description}
- {timeout handling description}

Generation Requirements:
1. All participating departments as separate Pools
2. Roles within each department as Lanes
3. Correctly set sequence flows and message flows
4. Include condition expressions
5. Properly handle exceptions and timeouts`;
  }

  private generateExample(analysis: FixtureAnalysis): string {
    const simpleProcess = {
      id: 'definitions_example',
      layoutOptions: DEFAULT_ELK_OPTIONS,
      children: [
        {
          id: 'process_example',
          bpmn: { type: 'process', name: 'Example Process', isExecutable: true },
          children: [
            {
              id: 'start_1',
              width: 36,
              height: 36,
              bpmn: { type: 'startEvent', eventDefinitionType: 'none', name: 'Start' },
              labels: [{ text: 'Start' }],
            },
            {
              id: 'task_1',
              width: 100,
              height: 80,
              bpmn: { type: 'userTask', name: 'Approval' },
              labels: [{ text: 'Approval' }],
            },
            {
              id: 'gateway_1',
              width: 50,
              height: 50,
              bpmn: { type: 'exclusiveGateway', name: 'Approved?', default: 'flow_reject' },
              labels: [{ text: 'Approved?' }],
            },
            {
              id: 'task_2',
              width: 100,
              height: 80,
              bpmn: { type: 'serviceTask', name: 'Execute' },
              labels: [{ text: 'Execute' }],
            },
            {
              id: 'end_1',
              width: 36,
              height: 36,
              bpmn: { type: 'endEvent', eventDefinitionType: 'none', name: 'Done' },
              labels: [{ text: 'Done' }],
            },
            {
              id: 'end_2',
              width: 36,
              height: 36,
              bpmn: { type: 'endEvent', eventDefinitionType: 'none', name: 'Rejected' },
              labels: [{ text: 'Rejected' }],
            },
          ],
          edges: [
            { id: 'flow_1', sources: ['start_1'], targets: ['task_1'], bpmn: { type: 'sequenceFlow' } },
            { id: 'flow_2', sources: ['task_1'], targets: ['gateway_1'], bpmn: { type: 'sequenceFlow' } },
            {
              id: 'flow_approve',
              sources: ['gateway_1'],
              targets: ['task_2'],
              bpmn: {
                type: 'sequenceFlow',
                name: 'Approved',
                conditionExpression: { type: 'tFormalExpression', body: '${approved}' },
              },
              labels: [{ text: 'Approved' }],
            },
            {
              id: 'flow_reject',
              sources: ['gateway_1'],
              targets: ['end_2'],
              bpmn: { type: 'sequenceFlow', name: 'Rejected', isDefault: true },
              labels: [{ text: 'Rejected' }],
            },
            { id: 'flow_3', sources: ['task_2'], targets: ['end_1'], bpmn: { type: 'sequenceFlow' } },
          ],
        },
      ],
    };

    return `Simple Example:\n\n\`\`\`json\n${JSON.stringify(simpleProcess, null, 2)}\n\`\`\``;
  }

  private generateSelfCheckList(): string {
    const items = [
      '1. Each Pool has unique processRef',
      '2. Message flows only in collaboration.edges',
      '3. Sequence flows only in participant.edges or process.edges',
      '4. All IDs are unique and follow naming conventions',
      '5. IDs in sources and targets exist in children',
      '6. Exclusive/inclusive gateways have default outgoing flow',
      '7. Non-default outgoing flows have conditionExpression',
      '8. Start events have no incoming edges, end events have no outgoing edges',
      '9. All nodes have width and height',
      '10. Boundary events have attachedToRef',
      '11. Timer events have timerEventDefinition',
      '12. Message events have messageRef',
    ];

    return `Self-Check List (verify after generation):\n${items.join('\n')}`;
  }

  private generateCommonErrors(): string {
    return `Common Errors:

Error 1: Sequence flow in collaboration level
"collaboration": { "edges": [{ "bpmn": { "type": "sequenceFlow" } }] }
Correct: Sequence flows should be in participant.edges

Error 2: Message flow in participant level
"participant": { "edges": [{ "bpmn": { "type": "messageFlow" } }] }
Correct: Message flows should be in collaboration.edges

Error 3: Missing gateway default outgoing flow
{ "bpmn": { "type": "exclusiveGateway" } }
Correct: { "bpmn": { "type": "exclusiveGateway", "default": "flow_default" } }

Error 4: Boundary event missing attachedToRef
"boundaryEvents": [{ "id": "boundary_timer", "bpmn": {...} }]
Correct: Must set "attachedToRef": "task_1"`;
  }
}

// ============================================================================
// Factory function for convenience
// ============================================================================

export async function generatePromptTemplate(options?: PromptGeneratorOptions): Promise<string> {
  const generator = new PromptTemplateGenerator(options);
  return generator.generate();
}
