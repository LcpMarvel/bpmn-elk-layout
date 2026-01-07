export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface Settings {
  apiKey: string
  temperature: number
  topK: number
}

export interface ChatRequest {
  messages: Array<{ role: string; content: string }>
  apiKey: string
  temperature: number
  topK: number
}

export interface ChatResponse {
  content: string
  error?: string
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  temperature: 0.7,
  topK: 50,
}
