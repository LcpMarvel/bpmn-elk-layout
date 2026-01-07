import fs from 'fs'
import path from 'path'

// Read system prompt from prompt-template.md at build time
let cachedPrompt: string | null = null

export function getSystemPrompt(): string {
  if (cachedPrompt) {
    return cachedPrompt
  }

  // Path to prompt-template.md in monorepo root
  const promptPath = path.join(process.cwd(), '..', '..', 'prompt-template.md')

  try {
    cachedPrompt = fs.readFileSync(promptPath, 'utf-8')
    return cachedPrompt
  } catch (error) {
    console.error('Failed to read prompt-template.md:', error)
    // Fallback to a minimal prompt
    return `You are a BPMN diagram generator. Generate ELK-BPMN JSON based on user descriptions.

Rules:
1. All IDs must be ASCII only (no Chinese characters in IDs)
2. Chinese names go in the "name" field
3. Output pure JSON without markdown code blocks
4. Ensure all edges reference nodes that exist in children arrays`
  }
}
