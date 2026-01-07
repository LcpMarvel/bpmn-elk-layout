'use client'

import { useState, useCallback, KeyboardEvent } from 'react'
import { Message } from '@/types'
import { MessageList } from './MessageList'

interface ChatPanelProps {
  messages: Message[]
  isLoading: boolean
  error: string | null
  onSendMessage: (content: string) => void
  isConfigured: boolean
}

export function ChatPanel({
  messages,
  isLoading,
  error,
  onSendMessage,
  isConfigured,
}: ChatPanelProps) {
  const [input, setInput] = useState('')

  const handleSend = useCallback(() => {
    if (input.trim() && !isLoading) {
      onSendMessage(input)
      setInput('')
    }
  }, [input, isLoading, onSendMessage])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd/Ctrl + Enter to send
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <MessageList messages={messages} />

      {/* Loading indicator */}
      {isLoading && (
        <div className="px-4 py-2 text-gray-500 flex items-center gap-2">
          <svg
            className="animate-spin h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span>Generating...</span>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="px-4 py-2 text-red-600 text-sm bg-red-50 border-t border-red-100">
          {error}
        </div>
      )}

      {/* Input area */}
      <div className="border-t p-4">
        {!isConfigured && (
          <div className="mb-2 text-sm text-amber-600 bg-amber-50 px-3 py-2 rounded">
            Please configure your DeepSeek API key in Settings
          </div>
        )}
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe the business process you want to generate..."
            disabled={!isConfigured || isLoading}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
            rows={3}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || !isConfigured || isLoading}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors self-end"
          >
            Send
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          Press Cmd/Ctrl + Enter to send
        </p>
      </div>
    </div>
  )
}
