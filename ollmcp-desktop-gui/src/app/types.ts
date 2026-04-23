export type Role = 'user' | 'assistant' | 'system' | 'tool'

export type ChatMessage = {
  id: string
  role: Role
  createdAtMs: number
  content: string
}

export type ToolCallEvent = {
  id: string
  createdAtMs: number
  server?: string
  toolName: string
  argsJson: unknown
  status: 'pending' | 'approved' | 'running' | 'done' | 'error' | 'denied'
  resultText?: string
  errorText?: string
}

export type AppSettings = {
  ollamaHost: string
  model: string
  /** MCP streamable HTTP endpoint (full URL), or a base URL ending with `token=` to append keychain token. */
  mcpServerBaseUrl: string
  hilEnabled: boolean
  agentMode: boolean
  agentMaxSteps: number
}

