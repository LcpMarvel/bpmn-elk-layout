const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'

interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface DeepSeekRequest {
  model: string
  messages: DeepSeekMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stream?: boolean
  response_format?: { type: 'json_object' | 'text' }
}

interface DeepSeekResponse {
  id: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string
    }
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export async function callDeepSeek(
  messages: DeepSeekMessage[],
  apiKey: string,
  temperature: number = 0.7,
  topK: number = 50
): Promise<string> {
  const request: DeepSeekRequest = {
    model: 'deepseek-reasoner',
    messages,
    temperature,
    top_p: Math.min(topK / 100, 1), // Convert topK to top_p (0-1 range)
    stream: false,
    response_format: { type: 'json_object' },
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`)
  }

  const data: DeepSeekResponse = await response.json()

  if (!data.choices || data.choices.length === 0) {
    throw new Error('No response from DeepSeek API')
  }

  return data.choices[0].message.content
}
