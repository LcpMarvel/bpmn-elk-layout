# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This monorepo converts ELK-BPMN JSON (AI-generated BPMN diagrams without coordinates) to standard BPMN 2.0 XML with automatic layout calculation. The workflow:

```
ELK-BPMN JSON → elkjs layout → BPMN 2.0 XML (with DI) → bpmn.io/Camunda
```

## Commands

```bash
# Root (uses bun workspaces)
bun install              # Install all dependencies
bun run build            # Build all packages
bun run test             # Run all tests
bun run dev              # Start bpmn-viewer dev server
bun run lint             # Type check all packages

# In packages/bpmn-elk-layout
bun run test             # Run vitest once
bun run test:watch       # Run vitest in watch mode
bun run test -- -u       # Update snapshots
```

## Architecture

### Packages

**`packages/bpmn-elk-layout`** - Core library (published npm package)
- `BpmnElkLayout.to_bpmn(json)` - Convert ELK-BPMN JSON to BPMN XML
- `BpmnElkLayout.to_json(json)` - Convert ELK-BPMN JSON to layouted JSON
- CLI: `bpmn-elk-layout convert <input> -f bpmn|json`

**`apps/bpmn-viewer`** - React demo app for testing conversions

### Source Structure (bpmn-elk-layout)

```
src/
├── converter.ts         # BpmnElkLayout main class (public API)
├── layout/              # ELK wrapper and size defaults
├── transform/           # Model building, reference/lane resolution
├── generators/          # BPMN XML generation
└── types/               # Input/output type definitions
```

### Data Flow

```
ElkBpmnGraph (input)
    ↓ ElkLayouter.layout()
LayoutedGraph (with x,y coordinates)
    ↓ ModelBuilder.build()
Intermediate model
    ↓ BpmnXmlGenerator.generate()
BPMN 2.0 XML string
```

## Testing

- Framework: Vitest with `globals: true`
- Test files: `test/**/*.test.ts`
- Snapshot tests: Place JSON in `test/fixtures/`, run tests to generate snapshots
- PNG screenshots: Auto-generated to `test/__screenshots__/` for visual inspection
- Test data reference: `apps/bpmn-viewer/test-data/` contains all BPMN element examples

### Test Commands

```bash
cd packages/bpmn-elk-layout

bun run test                              # Run all tests (generates PNG screenshots)
bun run test -- -u                        # Update snapshots
bun run test -- -t "01-all-events"        # Run specific fixture test
bun run test -- -t "simple-process"       # Run tests matching pattern
```

### Test Output Structure

```
test/
├── fixtures/                 # Input: ELK-BPMN JSON files
│   ├── 01-all-events.json
│   ├── 02-all-tasks.json
│   └── ...
├── __snapshots__/            # Output: BPMN XML snapshots (per fixture)
│   ├── 01-all-events.bpmn
│   ├── 02-all-tasks.bpmn
│   └── ...
└── __screenshots__/          # Output: PNG renders (git tracked)
    ├── 01-all-events.png
    ├── 02-all-tasks.png
    └── ...
```

Snapshots use `toMatchFileSnapshot()` so each fixture has its own `.bpmn` file for easier diffing and IDE syntax highlighting.

After running tests, open `test/__screenshots__/` to visually verify diagram rendering.

## Development Rules

**After modifying code in `bpmn-elk-layout`, always run snapshot tests:**
```bash
cd packages/bpmn-elk-layout && bun run test
```
This ensures changes don't break existing functionality. If snapshots fail unexpectedly, investigate before updating them.

**Do NOT use browser automation tools to preview diagrams.** The user will manually preview in the browser. Just make the code changes, run tests, and build.

## Key Dependencies

- `elkjs` - Graph layout engine
- `bpmn-moddle` - BPMN XML serialization
- `bpmn-js` - Diagram visualization (viewer app only)
