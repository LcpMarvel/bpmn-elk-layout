# Skill: generate-bpmn-prompt

Generate a professional AI prompt template for ELK-BPMN JSON generation by analyzing test fixtures and schema.

## Description

This skill dynamically analyzes:
- All test fixtures in `packages/bpmn-elk-layout/test/fixtures/`
- The ELK-BPMN schema in `elk-bpmn-schema.json`

And generates a comprehensive prompt template that includes:
- Standard dimensions for all BPMN elements
- Event, task, and gateway type selection guides
- Structure patterns (single process vs collaboration)
- ID naming conventions
- Real examples extracted from fixtures
- Self-check validation list
- Common errors and solutions

## Trigger

Use this skill when:
- User asks to generate or update the BPMN prompt template
- User wants to create an AI prompt for BPMN diagram generation
- User mentions `/generate-bpmn-prompt` or similar

## Instructions

When this skill is triggered:

1. **Run the CLI command** to generate the prompt template:
   ```bash
   cd packages/bpmn-elk-layout && bun run build && bun run dist/bin/bpmn-elk-layout.js prompt-template -o ../../prompt-template.md
   ```

2. **Verify the output** by checking that `prompt-template.md` was created/updated in the project root.

3. **Report completion** to the user with:
   - Confirmation that the template was generated
   - Number of fixtures analyzed
   - Location of the output file

## Options

The CLI supports the following options:
- `-o, --output <file>`: Output file path
- `--fixtures <dir>`: Custom fixtures directory path
- `--schema <file>`: Custom schema file path

## Example Usage

```bash
bpmn-elk-layout prompt-template -o prompt-template.md
```

## Programmatic Usage

The generator can also be used programmatically:

```typescript
import { PromptTemplateGenerator, generatePromptTemplate } from 'bpmn-elk-layout';

// Using the class
const generator = new PromptTemplateGenerator({
  fixturesDir: './test/fixtures',
  schemaPath: './elk-bpmn-schema.json',
});
const template = await generator.generate();

// Or using the convenience function
const template = await generatePromptTemplate();
```
