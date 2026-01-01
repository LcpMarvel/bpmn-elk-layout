# bpmn-with-elk

Convert ELK-BPMN JSON to standard BPMN 2.0 XML with automatic layout calculation.

```
ELK-BPMN JSON (AI-generated) → elkjs layout → BPMN 2.0 XML (with DI) → bpmn.io/Camunda
```

## Packages

| Package | Description |
|---------|-------------|
| [`bpmn-elk-layout`](./packages/bpmn-elk-layout) | Core library - converts ELK-BPMN JSON to BPMN XML |
| [`bpmn-viewer`](./apps/bpmn-viewer) | React demo app for testing conversions |

## Quick Start

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Run tests
bun run test

# Start viewer dev server
bun run dev
```

## Usage

### As a Library

```typescript
import { BpmnElkLayout } from 'bpmn-elk-layout';

const converter = new BpmnElkLayout();

// Convert to BPMN XML
const xml = await converter.to_bpmn(elkBpmnJson);

// Or get layouted JSON with coordinates
const layouted = await converter.to_json(elkBpmnJson);
```

### CLI

```bash
# Convert to BPMN XML
bpmn-elk-layout convert input.json -f bpmn -o output.bpmn

# Convert to layouted JSON
bpmn-elk-layout convert input.json -f json -o output.json
```

## Input Format (ELK-BPMN JSON)

The input is standard ELK JSON extended with a `bpmn` field for BPMN semantics:

```json
{
  "id": "definitions",
  "children": [{
    "id": "process_1",
    "bpmn": { "type": "process", "name": "My Process" },
    "children": [
      {
        "id": "start",
        "width": 36,
        "height": 36,
        "bpmn": { "type": "startEvent", "name": "Start" }
      },
      {
        "id": "task_1",
        "width": 100,
        "height": 80,
        "bpmn": { "type": "userTask", "name": "Review Request", "assignee": "${reviewer}" }
      }
    ],
    "edges": [
      { "id": "flow_1", "sources": ["start"], "targets": ["task_1"] }
    ]
  }]
}
```

See [`elk-bpmn-schema.json`](./elk-bpmn-schema.json) for the complete schema.

## BPMN 2.0 Coverage

### Events
- Start/End/Intermediate events (catch & throw)
- Boundary events (interrupting & non-interrupting)
- Event definitions: None, Message, Timer, Error, Escalation, Cancel, Compensation, Conditional, Link, Signal, Terminate, Multiple, ParallelMultiple

### Activities
- Tasks: User, Service, Script, Business Rule, Send, Receive, Manual
- SubProcesses: Embedded, Event, Transaction, Ad-hoc
- Call Activity with parameter mapping
- Loop & Multi-instance (parallel/sequential)

### Gateways
- Exclusive, Parallel, Inclusive, Event-based, Complex
- Default flow support

### Data & Artifacts
- Data Object, Data Store, Data Input/Output
- Text Annotation, Group
- Data Association

### Swimlanes
- Participant/Pool (including black-box)
- Lane (with nesting support)
- Collaboration with Message Flows

## Development

```bash
# Run tests with snapshots
cd packages/bpmn-elk-layout
bun run test

# Update snapshots
bun run test -- -u

# Watch mode
bun run test:watch

# Type check
bun run lint
```

### Test Structure

```
packages/bpmn-elk-layout/test/
├── fixtures/           # Input: ELK-BPMN JSON files
├── __snapshots__/      # Output: BPMN XML snapshots
└── __screenshots__/    # Output: PNG renders for visual verification
```

## Dependencies

- [elkjs](https://github.com/kieler/elkjs) - Graph layout engine
- [bpmn-moddle](https://github.com/bpmn-io/bpmn-moddle) - BPMN XML serialization
- [bpmn-js](https://github.com/bpmn-io/bpmn-js) - Diagram visualization (viewer only)

## License

MIT
