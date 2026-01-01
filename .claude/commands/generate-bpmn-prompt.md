# generate-bpmn-prompt

Generate AI prompt template for ELK-BPMN JSON by analyzing fixtures and schema.

## Usage

Run this command to generate or update the `prompt-template.md` file in the project root.

## Instructions

1. Build the bpmn-elk-layout package:
   ```bash
   cd packages/bpmn-elk-layout && bun run build
   ```

2. Run the prompt-template CLI command:
   ```bash
   cd packages/bpmn-elk-layout && bun run bin/bpmn-elk-layout.js prompt-template --lang zh -o ../../prompt-template.md
   ```

3. Verify the output file was created at `prompt-template.md`

4. Report to the user:
   - The template was generated successfully
   - It analyzed all fixtures in `packages/bpmn-elk-layout/test/fixtures/`
   - It referenced `elk-bpmn-schema.json` for schema constraints

## Options

For English output, use `--lang en`:
```bash
bun run bin/bpmn-elk-layout.js prompt-template --lang en -o ../../prompt-template.md
```
