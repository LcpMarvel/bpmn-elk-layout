/**
 * Node.js-only exports
 *
 * These exports use Node.js APIs (fs, path) and cannot be used in browsers.
 *
 * @example
 * ```typescript
 * import { PromptTemplateGenerator, generatePromptTemplate } from 'bpmn-elk-layout/node';
 *
 * const template = await generatePromptTemplate();
 * ```
 */

// Re-export everything from main entry
export * from './index';

// Node.js only: Prompt template generator
export {
  PromptTemplateGenerator,
  generatePromptTemplate,
  type PromptGeneratorOptions,
} from './prompt-generator';
