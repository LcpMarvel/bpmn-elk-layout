'use client'

import { useState, useCallback } from 'react'
import { Message, Settings } from '@/types'

interface UseChatReturn {
  messages: Message[]
  currentCode: string | null
  isLoading: boolean
  error: string | null
  sendMessage: (content: string) => Promise<void>
  reset: () => void
}

/**
 * Extract JSON from AI response
 * The AI should output pure JSON, but handle markdown code blocks just in case
 */
function extractJson(content: string): string | null {
  // First, try to parse as pure JSON
  const trimmed = content.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return trimmed
    } catch {
      // Not valid JSON, continue to try other methods
    }
  }

  // Try to extract from markdown code block
  const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonBlockMatch) {
    const extracted = jsonBlockMatch[1].trim()
    try {
      JSON.parse(extracted)
      return extracted
    } catch {
      // Not valid JSON
    }
  }

  // Try to find JSON object in the content
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      JSON.parse(jsonMatch[0])
      return jsonMatch[0]
    } catch {
      // Not valid JSON
    }
  }

  return null
}

export function useChat(settings: Settings): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([])
  const [currentCode, setCurrentCode] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isLoading) return

      const userMessage: Message = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: content.trim(),
        timestamp: Date.now(),
      }

      setMessages((prev) => [...prev, userMessage])
      setIsLoading(true)
      setError(null)

      try {
        // Build context: all user messages + latest code
        const allMessages = [...messages, userMessage]

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages: allMessages,
            currentCode,
            apiKey: settings.apiKey,
            temperature: settings.temperature,
            topK: settings.topK,
          }),
        })

        const data = await response.json()

        if (!response.ok) {
          throw new Error(data.error || 'Failed to send message')
        }

        const aiContent = data.content

        // Extract JSON from response
        const extractedJson = extractJson(aiContent)
        if (extractedJson) {
          setCurrentCode(extractedJson)
        }

        const assistantMessage: Message = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: aiContent,
          timestamp: Date.now(),
        }

        setMessages((prev) => [...prev, assistantMessage])
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error'
        setError(errorMessage)
      } finally {
        setIsLoading(false)
      }
    },
    [messages, currentCode, settings, isLoading]
  )

  const reset = useCallback(() => {
    setMessages([])
    setCurrentCode(null)
    setError(null)
  }, [])

  return {
    messages,
    currentCode,
    isLoading,
    error,
    sendMessage,
    reset,
  }
}
