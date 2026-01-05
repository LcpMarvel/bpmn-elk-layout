# bpmn-elk-layout

[![npm version](https://img.shields.io/npm/v/bpmn-elk-layout.svg)](https://www.npmjs.com/package/bpmn-elk-layout)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Convert ELK-BPMN JSON to standard BPMN 2.0 XML with automatic layout calculation.

```
ELK-BPMN JSON (AI-generated) → elkjs layout → BPMN 2.0 XML (with DI) → bpmn.io/Camunda
```

## Features

- 🎯 **Automatic Layout** - No manual coordinate calculation needed
- 🔄 **Full BPMN 2.0 Support** - Events, tasks, gateways, subprocesses, swimlanes
- 📐 **Smart Edge Routing** - Clean perpendicular connections with no overlaps
- 🏊 **Swimlane Support** - Pools, lanes, and collaborations
- 🛠️ **CLI & Library** - Use programmatically or from command line
- 📦 **Dual Format** - Works in both Node.js and browser environments

## Installation

```bash
npm install bpmn-elk-layout
# or
yarn add bpmn-elk-layout
# or
pnpm add bpmn-elk-layout
```

## Quick Start

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
npx bpmn-elk-layout convert input.json -f bpmn -o output.bpmn

# Convert to layouted JSON
npx bpmn-elk-layout convert input.json -f json -o output.json
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
        "bpmn": { "type": "startEvent", "name": "Start" }
      },
      {
        "id": "task_1",
        "bpmn": { "type": "userTask", "name": "Review Request" }
      },
      {
        "id": "end",
        "bpmn": { "type": "endEvent", "name": "End" }
      }
    ],
    "edges": [
      { "id": "flow_1", "sources": ["start"], "targets": ["task_1"] },
      { "id": "flow_2", "sources": ["task_1"], "targets": ["end"] }
    ]
  }]
}
```

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

## Node.js Usage

For Node.js environments with better performance using native ELK:

```typescript
import { BpmnElkLayout } from 'bpmn-elk-layout/node';

const converter = new BpmnElkLayout();
const xml = await converter.to_bpmn(elkBpmnJson);
```

## API Reference

### `BpmnElkLayout`

#### `to_bpmn(json: ElkBpmnGraph): Promise<string>`

Converts ELK-BPMN JSON to BPMN 2.0 XML string with diagram interchange (DI) information.

#### `to_json(json: ElkBpmnGraph): Promise<LayoutedGraph>`

Converts ELK-BPMN JSON to layouted JSON with calculated x, y coordinates.

## How It Works

1. **Parse** - Read ELK-BPMN JSON input
2. **Prepare** - Convert to ELK graph format with BPMN constraints
3. **Layout** - Run elkjs layout engine for automatic positioning
4. **Post-process** - Apply BPMN-specific adjustments (boundary events, lanes, etc.)
5. **Generate** - Output BPMN 2.0 XML with diagram information

## Dependencies

- [elkjs](https://github.com/kieler/elkjs) - Graph layout engine
- [bpmn-moddle](https://github.com/bpmn-io/bpmn-moddle) - BPMN XML serialization

## Requirements

- Node.js >= 18.0.0

## License

MIT

## Links

- [GitHub Repository](https://github.com/LcpMarvel/bpmn-elk-layout)
- [Issue Tracker](https://github.com/LcpMarvel/bpmn-elk-layout/issues)
- [ELK-BPMN JSON Schema](https://github.com/LcpMarvel/bpmn-elk-layout/blob/master/elk-bpmn-schema.json)