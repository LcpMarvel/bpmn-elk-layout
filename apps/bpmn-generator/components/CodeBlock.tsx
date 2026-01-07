'use client'

import { useState, useCallback } from 'react'

interface CodeBlockProps {
  code: string
  language?: string
  maxHeight?: string
}

export function CodeBlock({
  code,
  language = 'json',
  maxHeight = '300px',
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [code])

  return (
    <div className="relative group">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 px-2 py-1 text-xs bg-gray-700 text-gray-300 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-gray-600"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <pre
        className="code-block bg-gray-800 text-gray-100 rounded p-3 overflow-auto"
        style={{ maxHeight }}
      >
        <code className={`language-${language}`}>{code}</code>
      </pre>
    </div>
  )
}
