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
├── converter.ts              # BpmnElkLayout main class (public API)
├── layout/
│   ├── elk-layouter.ts       # Main layout orchestrator
│   ├── size-defaults.ts      # BPMN element size definitions
│   ├── default-options.ts    # ELK configuration
│   ├── preparation/          # Graph preparation and result merging
│   ├── post-processing/      # BPMN-specific layout adjustments
│   └── edge-routing/         # Edge routing and geometry utilities
├── transform/                # Model building, reference/lane resolution
├── generators/               # BPMN XML generation
└── types/
    ├── elk-bpmn.ts           # Input schema (public)
    ├── elk-output.ts         # Output types (public)
    └── internal.ts           # Internal layout types (geometry, info)
```

### Layout Pipeline

The `ElkLayouter` runs an 8-step pipeline:

1. **Apply default sizes** - Set dimensions for all BPMN elements
2. **Collect info** - Gather boundary events, artifacts, groups metadata
3. **Prepare for ELK** - Convert BPMN graph to ELK format
4. **Run ELK layout** - Execute elkjs layout engine
5. **Post-process** - Apply BPMN-specific adjustments:
   - Boundary event targets → repositioned below attached nodes
   - Artifacts → positioned near associated tasks
   - Lanes → stacked vertically within pools
   - Pools → stacked vertically in collaborations
   - Groups → resized to surround grouped elements
6. **Fix edges** - Reroute edges that cross through nodes
7. **Merge results** - Combine layout coordinates with BPMN metadata

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
├── __snapshots__/            # Output: BPMN XML snapshots (per fixture)
├── __screenshots__/          # Output: PNG renders (git tracked)
└── layout/                   # Unit tests for layout modules
    ├── preparation/          # Graph preparation tests
    ├── post-processing/      # Post-processor tests (boundary, artifact, etc.)
    └── edge-routing/         # Geometry and edge fixer tests
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

## Debugging

Enable layout debug logging with the `DEBUG` environment variable:

```bash
DEBUG=true bun run test -- -t "21-subprocess"
```

Debug output (prefixed with `[BPMN]`) includes:
- Boundary event grouping and target node movement
- Edge routing obstacle detection and avoidance calculation
- Edge sections merge verification
- buildEdge pre-calculated sections check

## Layout Principles

When modifying layout algorithms, follow these core principles:

1. **No Overlaps**: Nodes, labels, and edges must never overlap. This is a hard constraint.

2. **Edges Never Cross Nodes**: Edges can intersect with other edges, but must NEVER pass through any node element. This is a hard constraint. Route edges around nodes, not through them.

3. **Clean Edge Routing**: Edges should be simple and clean:
   - **Perpendicular connection**: Edges MUST connect perpendicular to the node border. When connecting to top/bottom of a node, the last segment must be vertical; when connecting to left/right side, the last segment must be horizontal. This is a hard constraint. It's acceptable to add more bends to achieve this.
   - Avoid unnecessary detours
   - Minimize edge crossings where possible (though crossings are allowed)
   - **Connection points must be ON the node**: Edge endpoints MUST land exactly on the node's border, never floating outside or inside. This is a hard constraint.
   - **Smart connection points**: Gateways have 4 corners (top, bottom, left, right) and tasks/events have 4 sides as potential connection points. Route edges to use different connection points to avoid overlapping edges. For example, when multiple edges enter a gateway from the left, use different corners (top-left corner vs bottom-left corner) based on the source node's vertical position

4. **Consistent Flow Direction**: Main process flow should follow a consistent direction:
   - Primary flow: left-to-right (preferred) or top-to-bottom
   - Exception branches (e.g., from boundary events) may flow downward or upward
   - Avoid backtracking in the main flow

5. **Compact Layout**: Efficiently use both horizontal and vertical space:
   - Branches that don't conflict in X-axis can share the same Y level
   - Branches that don't conflict in Y-axis can share the same X level
   - Avoid excessive whitespace

6. **Balanced Aspect Ratio**: The final diagram should have a reasonable width-to-height ratio:
   - Avoid extremely wide or extremely tall diagrams
   - A more square-ish layout is generally preferred over a long strip

7. **Alignment and Grouping**: Related elements should be visually organized:
   - Align nodes at the same logical level when possible
   - Keep related elements (e.g., parallel gateway branches) visually grouped
   - Maintain consistent spacing between similar elements

8. **Label Readability**: All labels must be clearly readable:
   - Labels should not overlap with edges or other labels
   - Edge labels should be positioned close to their edge without obscuring nodes
   - Sufficient padding around labels

9. **Boundary Event Branches**: When placing boundary event target branches:
   - Include the entire branch (target + downstream nodes) when calculating space requirements
   - Only stack vertically when horizontal space is insufficient
   - Align targets with their source boundary events

## Key Dependencies

- `elkjs` - Graph layout engine
- `bpmn-moddle` - BPMN XML serialization
- `bpmn-js` - Diagram visualization (viewer app only)
