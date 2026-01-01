/**
 * CLI for bpmn-elk-layout
 */

import { program } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { BpmnElkLayout } from './converter';
import { PromptTemplateGenerator } from './prompt-generator';
import type { ElkLayoutOptions } from './types';

// Get version from package.json
const VERSION = '1.0.0';

program
  .name('bpmn-elk-layout')
  .description('Convert ELK-BPMN JSON to BPMN 2.0 XML with automatic layout')
  .version(VERSION);

program
  .command('convert <input>')
  .description('Convert ELK-BPMN JSON to BPMN XML or layouted JSON')
  .option('-o, --output <file>', 'Output file path (default: stdout)')
  .option('-f, --format <format>', 'Output format: bpmn or json', 'bpmn')
  .option('--elk-options <json>', 'ELK layout options as JSON string')
  .option('--elk-direction <direction>', 'Flow direction: RIGHT, DOWN, LEFT, UP')
  .option('--elk-spacing <number>', 'Node spacing')
  .option('--elk-layer-spacing <number>', 'Layer spacing')
  .option('--pretty', 'Pretty print JSON output', true)
  .action(async (input: string, options: ConvertOptions) => {
    try {
      // Read input
      let content: string;
      if (input === '-') {
        // Read from stdin
        content = await readStdin();
      } else {
        content = await readFile(input, 'utf-8');
      }

      // Parse JSON
      let elkBpmnJson: unknown;
      try {
        elkBpmnJson = JSON.parse(content);
      } catch {
        console.error('Error: Invalid JSON input');
        process.exit(1);
      }

      // Build ELK options
      const elkOptions = buildElkOptions(options);

      // Create converter
      const converter = new BpmnElkLayout({ elkOptions });

      // Convert based on format
      let result: string;
      if (options.format === 'json') {
        const layouted = await converter.to_json(elkBpmnJson as Parameters<typeof converter.to_json>[0]);
        result = JSON.stringify(layouted, null, options.pretty ? 2 : 0);
      } else {
        result = await converter.to_bpmn(elkBpmnJson as Parameters<typeof converter.to_bpmn>[0]);
      }

      // Write output
      if (options.output) {
        await writeFile(options.output, result);
        console.error(`Output written to ${options.output}`);
      } else {
        console.log(result);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('validate <input>')
  .description('Validate ELK-BPMN JSON structure')
  .action(async (input: string) => {
    try {
      const content = await readFile(input, 'utf-8');
      const json = JSON.parse(content);

      // Basic validation
      const errors: string[] = [];

      if (!json.id) {
        errors.push('Missing required field: id');
      }
      if (!json.children || !Array.isArray(json.children)) {
        errors.push('Missing or invalid field: children (must be an array)');
      }
      if (json.children && json.children.length === 0) {
        errors.push('children array is empty');
      }

      // Check children have required fields
      if (json.children) {
        for (let i = 0; i < json.children.length; i++) {
          const child = json.children[i];
          if (!child.id) {
            errors.push(`children[${i}]: Missing required field: id`);
          }
          if (!child.bpmn) {
            errors.push(`children[${i}]: Missing required field: bpmn`);
          } else if (!child.bpmn.type) {
            errors.push(`children[${i}].bpmn: Missing required field: type`);
          }
        }
      }

      if (errors.length > 0) {
        console.error('Validation failed:');
        errors.forEach((err) => console.error(`  - ${err}`));
        process.exit(1);
      }

      console.log('Validation passed!');
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('prompt-template')
  .description('Generate AI prompt template for ELK-BPMN JSON generation')
  .option('-o, --output <file>', 'Output file path (default: stdout)')
  .option('--fixtures <dir>', 'Fixtures directory path')
  .option('--schema <file>', 'Schema file path')
  .action(async (options: PromptTemplateOptions) => {
    try {
      const generator = new PromptTemplateGenerator({
        fixturesDir: options.fixtures,
        schemaPath: options.schema,
      });

      const template = await generator.generate();

      if (options.output) {
        await writeFile(options.output, template);
        console.error(`Template written to ${options.output}`);
      } else {
        console.log(template);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();

// Helper functions

interface ConvertOptions {
  output?: string;
  format: 'bpmn' | 'json';
  elkOptions?: string;
  elkDirection?: string;
  elkSpacing?: string;
  elkLayerSpacing?: string;
  pretty?: boolean;
}

interface PromptTemplateOptions {
  output?: string;
  fixtures?: string;
  schema?: string;
}

function buildElkOptions(options: ConvertOptions): ElkLayoutOptions | undefined {
  const elkOptions: ElkLayoutOptions = {};
  let hasOptions = false;

  // Parse JSON options
  if (options.elkOptions) {
    try {
      const parsed = JSON.parse(options.elkOptions);
      Object.assign(elkOptions, parsed);
      hasOptions = true;
    } catch {
      console.error('Warning: Invalid --elk-options JSON, ignoring');
    }
  }

  // Individual options
  if (options.elkDirection) {
    elkOptions['elk.direction'] = options.elkDirection as ElkLayoutOptions['elk.direction'];
    hasOptions = true;
  }

  if (options.elkSpacing) {
    const spacing = parseInt(options.elkSpacing, 10);
    if (!isNaN(spacing)) {
      elkOptions['elk.spacing.nodeNode'] = spacing;
      hasOptions = true;
    }
  }

  if (options.elkLayerSpacing) {
    const spacing = parseInt(options.elkLayerSpacing, 10);
    if (!isNaN(spacing)) {
      elkOptions['elk.layered.spacing.nodeNodeBetweenLayers'] = spacing;
      hasOptions = true;
    }
  }

  return hasOptions ? elkOptions : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}
