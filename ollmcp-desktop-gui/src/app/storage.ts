import type { AppSettings, ChatMessage, ToolCallEvent } from './types'

const SETTINGS_KEY = 'ollmcp_gui_settings_v1'
const SESSION_KEY = 'ollmcp_gui_session_v1'

export type PersistedSession = {
  messages: ChatMessage[]
  toolEvents: ToolCallEvent[]
  memorySummary: string
  memoryCutoffMs: number
}

export function loadSettings(): AppSettings {
  const raw = localStorage.getItem(SETTINGS_KEY)
  if (!raw) {
    return {
      ollamaHost: 'http://localhost:11434',
      model: 'qwen3.5:4b',
      mcpServerBaseUrl: 'https://mcp.zapier.com/api/v1/connect?token=',
      hilEnabled: true,
      agentMode: false,
      agentMaxSteps: 8,
    }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings> & Record<string, unknown>

    const getString = (k: string) => {
      const v = parsed[k]
      return typeof v === 'string' ? v : undefined
    }

    // Migration from older field names.
    const base =
      getString('mcpServerBaseUrl') ??
      getString('zapierMcpBaseUrl') ??
      getString('zapierMcpServerUrl') ??
      'https://mcp.zapier.com/api/v1/connect?token='
    const maxStepsRaw = Number(parsed.agentMaxSteps ?? 8)
    const maxSteps = Number.isFinite(maxStepsRaw)
      ? Math.max(1, Math.min(50, Math.trunc(maxStepsRaw)))
      : 8
    return {
      ollamaHost: String(parsed.ollamaHost ?? 'http://localhost:11434'),
      model: String(parsed.model ?? 'qwen3.5:4b'),
      mcpServerBaseUrl: String(base),
      hilEnabled: Boolean(parsed.hilEnabled ?? true),
      agentMode: Boolean(parsed.agentMode ?? false),
      agentMaxSteps: maxSteps,
    }
  } catch {
    localStorage.removeItem(SETTINGS_KEY)
    return loadSettings()
  }
}

export function saveSettings(settings: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function loadSession(): PersistedSession {
  const raw = localStorage.getItem(SESSION_KEY)
  if (!raw) return { messages: [], toolEvents: [], memorySummary: '', memoryCutoffMs: 0 }
  try {
    const parsed = JSON.parse(raw) as PersistedSession
    return {
      messages: parsed.messages ?? [],
      toolEvents: parsed.toolEvents ?? [],
      memorySummary: String(parsed.memorySummary ?? ''),
      memoryCutoffMs: Number(parsed.memoryCutoffMs ?? 0),
    }
  } catch {
    localStorage.removeItem(SESSION_KEY)
    return { messages: [], toolEvents: [], memorySummary: '', memoryCutoffMs: 0 }
  }
}

export function saveSession(session: PersistedSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

