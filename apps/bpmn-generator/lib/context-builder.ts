import { Message } from '@/types'

interface ContextMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Build context for DeepSeek API
 * - Include system prompt
 * - Properly alternate user/assistant messages (DeepSeek requires this)
 * - Include current code context
 */
export function buildContext(
  systemPrompt: string,
  messages: Message[],
  currentCode: string | null
): ContextMessage[] {
  const context: ContextMessage[] = []

  // System prompt
  context.push({
    role: 'system',
    content: systemPrompt,
  })

  // Collect user messages
  const userMessages = messages.filter(msg => msg.role === 'user')

  // Build alternating conversation
  // For each user message except the last, pair with a placeholder assistant response
  // The last user message is what we want AI to respond to
  for (let i = 0; i < userMessages.length; i++) {
    context.push({
      role: 'user',
      content: userMessages[i].content,
    })

    // Add assistant response after each user message except the last
    if (i < userMessages.length - 1) {
      // Use current code as context if available, otherwise use a simple acknowledgment
      if (currentCode && i === userMessages.length - 2) {
        // Put current code before the last user message
        context.push({
          role: 'assistant',
          content: currentCode,
        })
      } else {
        context.push({
          role: 'assistant',
          content: 'OK',
        })
      }
    }
  }

  return context
}
