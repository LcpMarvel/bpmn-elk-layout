'use client'

import { Message } from '@/types'
import { CodeBlock } from './CodeBlock'

interface MessageListProps {
  messages: Message[]
}

/**
 * Check if content looks like JSON
 */
function isJsonContent(content: string): boolean {
  const trimmed = content.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

/**
 * Extract JSON from content if it exists
 */
function extractJsonFromContent(content: string): { json: string | null; text: string } {
  // Try to find JSON in markdown code block
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    const jsonPart = codeBlockMatch[1].trim()
    const textBefore = content.substring(0, codeBlockMatch.index).trim()
    const textAfter = content.substring(codeBlockMatch.index! + codeBlockMatch[0].length).trim()
    const text = [textBefore, textAfter].filter(Boolean).join('\n')
    return { json: jsonPart, text }
  }

  // Check if entire content is JSON
  if (isJsonContent(content)) {
    return { json: content, text: '' }
  }

  return { json: null, text: content }
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        <p>Start a conversation to generate BPMN diagrams</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((message) => {
        const isUser = message.role === 'user'
        const { json, text } = isUser
          ? { json: null, text: message.content }
          : extractJsonFromContent(message.content)

        return (
          <div
            key={message.id}
            className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-4 py-2 ${
                isUser
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-900'
              }`}
            >
              {/* Text content */}
              {text && (
                <p className="whitespace-pre-wrap break-words">{text}</p>
              )}

              {/* JSON code block */}
              {json && (
                <div className={text ? 'mt-2' : ''}>
                  <CodeBlock code={json} language="json" />
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
