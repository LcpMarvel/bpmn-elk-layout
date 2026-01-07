import { NextRequest, NextResponse } from 'next/server'
import { getSystemPrompt } from '@/lib/system-prompt'
import { buildContext } from '@/lib/context-builder'
import { callDeepSeek } from '@/lib/deepseek'
import { Message } from '@/types'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      messages,
      currentCode,
      apiKey,
      temperature = 0.7,
      topK = 50,
    } = body as {
      messages: Message[]
      currentCode: string | null
      apiKey: string
      temperature: number
      topK: number
    }

    // Validate API key
    if (!apiKey || apiKey.trim().length === 0) {
      return NextResponse.json(
        { error: 'API key is required. Please configure it in settings.' },
        { status: 400 }
      )
    }

    // Validate messages
    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: 'No messages provided' },
        { status: 400 }
      )
    }

    // Get system prompt
    const systemPrompt = getSystemPrompt()

    // Build context
    const context = buildContext(systemPrompt, messages, currentCode)

    // Call DeepSeek API
    const content = await callDeepSeek(context, apiKey, temperature, topK)

    return NextResponse.json({ content })
  } catch (error) {
    console.error('Chat API error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
