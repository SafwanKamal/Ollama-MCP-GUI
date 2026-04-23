import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, ChatMessage, ToolCallEvent } from './app/types'
import { loadSession, loadSettings, saveSession, saveSettings } from './app/storage'
import { buildMcpServerUrl, mcpBaseNeedsAppendedToken } from './app/mcpUrl'
import { appendYouTubeThumbnailMarkdown } from './app/youtube'
import { backendSend, backendStart, onBackendEvent } from './app/backend'
import { deleteZapierToken, getZapierToken, setZapierToken } from './app/secrets'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './app/ui.css'

/** Zapier streamable MCP: base URL; keychain token is appended after `token=`. */
const MCP_EXAMPLE_ZAPIER_BASE = 'https://mcp.zapier.com/api/v1/connect?token='
/** Illustrative local / gateway URL (adjust to your server). */
const MCP_EXAMPLE_LOCAL = 'http://127.0.0.1:8000/mcp'

function now() {
  return Date.now()
}

function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`
}

type AppTab = 'settings' | 'tools' | 'chat'
export default function App() {
  const appWindow = useMemo(() => getCurrentWindow(), [])
  const [tab, setTab] = useState<AppTab>('settings')
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [{ messages, toolEvents, memorySummary, memoryCutoffMs }, setSession] = useState(() =>
    loadSession(),
  )
  const sessionRef = useRef<{
    messages: ChatMessage[]
    toolEvents: ToolCallEvent[]
    memorySummary: string
    memoryCutoffMs: number
  }>({ messages: [], toolEvents: [], memorySummary: '', memoryCutoffMs: 0 })
  const [draft, setDraft] = useState('')
  const [backendState, setBackendState] = useState<'starting' | 'ready' | 'exited' | 'error'>(
    'starting',
  )
  const backendStateRef = useRef<'starting' | 'ready' | 'exited' | 'error'>('starting')
  const lastBackendEventAtMsRef = useRef<number>(0)
  const didInitRef = useRef(false)
  const [zapierTokenPresent, setZapierTokenPresent] = useState<boolean>(false)
  const [zapierTokenDraft, setZapierTokenDraft] = useState<string>('')
  const [zapierTokenInfo, setZapierTokenInfo] = useState<string>('unknown')
  const [zapierTokenCached, setZapierTokenCached] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const importFileRef = useRef<HTMLInputElement | null>(null)
  const backendErrorsRef = useRef<string[]>([])
  const [activity, setActivity] = useState<string>('')
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const appShellRef = useRef<HTMLDivElement | null>(null)

  const pushBackendError = (line: string) => {
    if (!line) return
    backendErrorsRef.current = [...backendErrorsRef.current.slice(-49), line]
  }

  useEffect(() => {
    backendStateRef.current = backendState
  }, [backendState])

  useEffect(() => {
    // React StrictMode runs effects twice in dev; guard to avoid double-starting backend
    // and registering duplicate event listeners (which duplicates streaming output).
    if (didInitRef.current) return
    didInitRef.current = true

    let unlisten: null | (() => void) = null
    ;(async () => {
      try {
        // Listen first to avoid missing early init/status events.
        unlisten = await onBackendEvent((evt) => {
          lastBackendEventAtMsRef.current = Date.now()

          // If we receive any non-error event, the backend/event pipe is alive.
          if (evt.type !== 'error' && backendStateRef.current !== 'exited') {
            setBackendState('ready')
          }

          if (evt.type === 'status') {
            const state = String(evt.payload?.state ?? '')
            if (state === 'exited') setBackendState('exited')
            else if (state === 'error') setBackendState('error')
            else setBackendState('ready') // connecting/working/ready all mean the backend is alive
            const msg = String(evt.payload?.message ?? '')
            if (msg) setActivity(msg)
          }
          if (evt.type === 'backend_stderr') {
            const line = String(evt.payload?.line ?? '')
            if (line) {
              pushBackendError(line)
            }
          }
          if (evt.type === 'assistant_delta') {
            const delta = String(evt.payload?.delta ?? '')
            if (delta) {
              setIsGenerating(true)
              setActivity('Generating response…')
            }
            setSession((s) => {
              const last = s.messages[s.messages.length - 1]
              if (!last || last.role !== 'assistant') {
                const msg: ChatMessage = {
                  id: uid('msg'),
                  role: 'assistant',
                  createdAtMs: now(),
                  content: delta,
                }
                return { ...s, messages: [...s.messages, msg] }
              }
              const updated = { ...last, content: last.content + delta }
              return {
                ...s,
                messages: [...s.messages.slice(0, -1), updated],
              }
            })
          }
          if (evt.type === 'assistant_done') {
            setIsGenerating(false)
            setActivity('')
          }
          if (evt.type === 'context_compressed') {
            const summary = String(evt.payload?.memorySummary ?? '')
            const cutoff = Number(evt.payload?.memoryCutoffMs ?? 0)
            setSession((s) => ({
              ...s,
              memorySummary: summary,
              memoryCutoffMs: cutoff,
            }))
            pushBackendError(`Context compressed (${summary.length} chars).`)
          }
          if (evt.type === 'tool_call_pending') {
            const approvalId = String(evt.payload?.approvalId ?? uid('approval'))
            const toolName = String(evt.payload?.toolName ?? 'unknown')
            const argsJson = evt.payload?.args ?? {}
            setActivity(`Waiting for approval: ${toolName}`)
            setSession((s) => ({
              ...s,
              toolEvents: [
                ...s.toolEvents,
                {
                  id: approvalId,
                  createdAtMs: now(),
                  toolName,
                  argsJson,
                  status: 'pending',
                },
              ],
            }))
          }
          if (evt.type === 'tool_call_denied') {
            const approvalId = String(evt.payload?.approvalId ?? '')
            setSession((s) => ({
              ...s,
              toolEvents: s.toolEvents.map((t) =>
                t.id === approvalId ? { ...t, status: 'denied' } : t,
              ),
            }))
          }
          if (evt.type === 'tool_call_started') {
            const approvalId = String(evt.payload?.approvalId ?? '')
            const toolName = String(evt.payload?.toolName ?? 'tool')
            setActivity(`Calling tool: ${toolName}`)
            setSession((s) => ({
              ...s,
              toolEvents: s.toolEvents.map((t) =>
                t.id === approvalId ? { ...t, status: 'running' } : t,
              ),
            }))
          }
          if (evt.type === 'tool_call_result') {
            const approvalId = String(evt.payload?.approvalId ?? '')
            const result = String(evt.payload?.result ?? '')
            setActivity('Tool result received…')
            setSession((s) => ({
              ...s,
              toolEvents: s.toolEvents.map((t) =>
                t.id === approvalId ? { ...t, status: 'done', resultText: result } : t,
              ),
            }))
          }
          if (evt.type === 'tool_call_error') {
            const approvalId = String(evt.payload?.approvalId ?? '')
            const err = String(evt.payload?.error ?? '')
            setActivity('Tool call failed.')
            setSession((s) => ({
              ...s,
              toolEvents: s.toolEvents.map((t) =>
                t.id === approvalId ? { ...t, status: 'error', errorText: err } : t,
              ),
            }))
          }
          if (evt.type === 'error') {
            const msg = String(evt.payload?.message ?? 'Unknown backend error')
            const details = evt.payload?.details ? String(evt.payload.details) : ''
            pushBackendError(msg)
            setSession((s) => ({
              ...s,
              messages: [
                ...s.messages,
                {
                  id: uid('msg'),
                  role: 'assistant',
                  createdAtMs: now(),
                  content: details ? `Backend error: ${msg}\n\n${details}` : `Backend error: ${msg}`,
                },
              ],
            }))
            setBackendState('error')
            setIsGenerating(false)
            setActivity('')
          }
        })

        await backendStart()
        // If invoke succeeded, consider backend alive (even if it hasn't emitted status yet).
        setBackendState('ready')

        // If we never receive any backend event, surface a clear error instead of staying "starting".
        lastBackendEventAtMsRef.current = Date.now()
        const startupDeadline = Date.now() + 20000
        const startupTimer = window.setInterval(() => {
          if (Date.now() >= startupDeadline && Date.now() - lastBackendEventAtMsRef.current >= 8000) {
            window.clearInterval(startupTimer)
            pushBackendError('Backend did not emit any events after launch.')
            pushBackendError(
              'If you built a release binary, the Python module may not be available on PATH. Try running via `npm run dev:tauri` or ensure Python + dependencies are installed.',
            )
            setBackendState('error')
          }
        }, 400)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        pushBackendError('Failed to start backend (invoke backend_start).')
        pushBackendError(msg)
        pushBackendError('Make sure you are running inside Tauri (not just `npm run dev`).')
        setBackendState('error')
      }
    })()

    return () => {
      unlisten?.()
    }
  }, [])


  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  useEffect(() => {
    void (async () => {
      try {
        const t = await getZapierToken()
        setZapierTokenPresent(Boolean(t))
        setZapierTokenInfo(t ? `${t.length} chars` : 'not set')
        setZapierTokenCached(t)
      } catch {
        setZapierTokenPresent(false)
        setZapierTokenInfo('read failed')
        setZapierTokenCached(null)
      }
    })()
  }, [])

  useEffect(() => {
    saveSession({ messages, toolEvents, memorySummary, memoryCutoffMs })
  }, [messages, toolEvents, memorySummary, memoryCutoffMs])

  useEffect(() => {
    sessionRef.current = { messages, toolEvents, memorySummary, memoryCutoffMs }
  }, [messages, toolEvents, memorySummary, memoryCutoffMs])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  // (Compact-mode / Chat-tab switching removed per request.)

  const statusPills = useMemo(() => {
    return [
      <span key="model">
        <span className="Highlight">Model</span>: {settings.model}
      </span>,
      <span key="ollama">
        <span className="Highlight">Ollama</span>:{' '}
        {settings.ollamaHost.replace(/^https?:\/\//, '')}
      </span>,
      <span key="hil">
        <span className="Highlight">HIL</span>: {settings.hilEnabled ? 'on' : 'off'}
      </span>,
      <span key="agent">
        <span className="Highlight">Agent</span>:{' '}
        {settings.agentMode ? `on (${settings.agentMaxSteps})` : 'off'}
      </span>,
    ]
  }, [settings])

  function clearSession() {
    setSession({ messages: [], toolEvents: [], memorySummary: '', memoryCutoffMs: 0 })
  }

  function appendMessage(msg: ChatMessage) {
    setSession((s) => ({ ...s, messages: [...s.messages, msg] }))
  }

  function handleSend() {
    if (isGenerating) return
    const text = draft.trim()
    if (!text) return

    const userMsg: ChatMessage = {
      id: uid('msg'),
      role: 'user',
      createdAtMs: now(),
      content: text,
    }
    appendMessage(userMsg)
    setDraft('')
    setIsGenerating(true)
    setActivity('Thinking…')

    const reqId = uid('req')
    void (async () => {
      const base = settings.mcpServerBaseUrl.trim()
      const token = zapierTokenCached?.trim() ?? null
      const needsKeychainToken = mcpBaseNeedsAppendedToken(base)
      if (needsKeychainToken && !token) {
        appendMessage({
          id: uid('msg'),
          role: 'assistant',
          createdAtMs: now(),
          content:
            'This MCP URL ends with an empty `token=` query. Save your token under Settings → “MCP token (keychain)”, or paste a complete MCP URL that does not need an appended token.',
        })
        setIsGenerating(false)
        setActivity('')
        return
      }
      const mcpServerUrl = buildMcpServerUrl(settings.mcpServerBaseUrl, token)
      if (!mcpServerUrl.trim()) {
        appendMessage({
          id: uid('msg'),
          role: 'assistant',
          createdAtMs: now(),
          content: 'Set an MCP server URL in Settings, then try again.',
        })
        setIsGenerating(false)
        setActivity('')
        return
      }

      const snapshot = sessionRef.current
      const fullMessages = [...snapshot.messages, userMsg]
      await backendSend({
        type: 'chat',
        id: reqId,
        payload: {
          text,
          model: settings.model,
          ollamaHost: settings.ollamaHost,
          mcpServerUrl,
          hilEnabled: settings.hilEnabled,
          agentMode: settings.agentMode,
          agentMaxSteps: settings.agentMaxSteps,
          history: [
            ...(snapshot.memorySummary
              ? [
                  {
                    role: 'system',
                    content:
                      'Conversation memory (compressed). Use this as context for everything that happened before the cutoff.\n\n' +
                      snapshot.memorySummary,
                  },
                ]
              : []),
            ...fullMessages
              .filter((m) => !snapshot.memoryCutoffMs || m.createdAtMs > snapshot.memoryCutoffMs)
              .map((m) => ({ role: m.role, content: m.content })),
          ],
        },
      })
    })()
  }

  async function compressContext() {
    if (messages.length === 0 && !memorySummary) return
    const cutoff = messages.length ? messages[messages.length - 1]!.createdAtMs : now()
    setActivity('Compressing context…')
    setIsGenerating(true)
    const reqId = uid('req')
    await backendSend({
      type: 'compress',
      id: reqId,
      payload: {
        model: settings.model,
        ollamaHost: settings.ollamaHost,
        memorySummary: memorySummary || '',
        memoryCutoffMs: memoryCutoffMs || 0,
        history: messages.map((m) => ({ role: m.role, content: m.content, createdAtMs: m.createdAtMs })),
        cutoffMs: cutoff,
      },
    })
  }

  const toolSummary = useMemo(() => {
    const running = toolEvents.filter((t) => t.status === 'running').length
    const pending = toolEvents.filter((t) => t.status === 'pending').length
    const done = toolEvents.filter((t) => t.status === 'done').length
    const err = toolEvents.filter((t) => t.status === 'error').length
    return { running, pending, done, err }
  }, [toolEvents])

  const pendingApprovals = useMemo(
    () => toolEvents.filter((t) => t.status === 'pending'),
    [toolEvents],
  )

  async function respondToApproval(approvalId: string, decision: 'approve' | 'deny') {
    const reqId = uid('req')
    setSession((s) => ({
      ...s,
      toolEvents: s.toolEvents.map((t) =>
        t.id === approvalId
          ? { ...t, status: decision === 'approve' ? 'approved' : 'denied' }
          : t,
      ),
    }))
    await backendSend({
      type: 'tool_approve',
      id: reqId,
      payload: { approvalId, decision },
    })
  }

  function exportSession() {
    const data = JSON.stringify({ messages, toolEvents, settings, memorySummary, memoryCutoffMs }, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ollmcp_gui_session_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function importSessionFile(file: File) {
    const text = await file.text()
    const parsed: unknown = JSON.parse(text)
    if (
      parsed &&
      typeof parsed === 'object' &&
      'messages' in parsed &&
      'toolEvents' in parsed
    ) {
      const p = parsed as Partial<{
        messages: unknown
        toolEvents: unknown
        memorySummary: unknown
        memoryCutoffMs: unknown
      }>
      setSession({
        messages: Array.isArray(p.messages) ? (p.messages as ChatMessage[]) : [],
        toolEvents: Array.isArray(p.toolEvents) ? (p.toolEvents as ToolCallEvent[]) : [],
        memorySummary: String(p.memorySummary ?? ''),
        memoryCutoffMs: Number(p.memoryCutoffMs ?? 0),
      })
    }
  }

  return (
    <>
      <div
        className="WindowDragBar"
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.button !== 0) return
          void appWindow.startDragging()
        }}
      />
      <div ref={appShellRef} className="AppShell">
        <section className="Panel">
          <div className="PanelHeader" data-tauri-drag-region>
            <div className="Tabs TabsLeft">
              <button
                className={`TabButton ${tab === 'settings' ? 'TabButtonActive' : ''}`}
                onClick={() => setTab('settings')}
              >
                Settings
              </button>
              <button
                className={`TabButton ${tab === 'tools' ? 'TabButtonActive' : ''}`}
                onClick={() => setTab('tools')}
              >
                Tools
              </button>
              <button
                className={`TabButton ${tab === 'chat' ? 'TabButtonActive' : ''}`}
                onClick={() => setTab('chat')}
              >
                Chat
              </button>
            </div>
            <div>
              <div className="Title">
                <span className="Highlight">Ollmcp</span> GUI
              </div>
              <div className="Subtle">MCP (streamable HTTP) + local Ollama</div>
            </div>
          </div>

          {tab === 'chat' ? (
            <div className="Chat">
              <div className="ChatHeader" data-tauri-drag-region>
                <div>
                  <div className="Title">Chat</div>
                  <div className="Subtle">Tool-aware chat (streaming soon)</div>
                </div>
                <div className="ChatHeaderRight">
                  <div className="Pill">
                    <span className="Highlight">Backend</span>: {backendState}
                  </div>
                  {statusPills.map((p, idx) => (
                    <div className="Pill" key={idx}>
                      {p}
                    </div>
                  ))}
                </div>
              </div>

              <div className="Messages">
                {messages.length === 0 ? (
                  <div className="Subtle">
                    Ask something once your MCP URL and Ollama are configured in Settings.
                  </div>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      className={`Msg ${m.role === 'user' ? 'MsgUser' : 'MsgAssistant'}`}
                    >
                      <div className="MsgMeta">
                        <span>{m.role}</span>
                        <span>{new Date(m.createdAtMs).toLocaleTimeString()}</span>
                      </div>
                      <div className="MsgContent">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children, ...props }) => {
                              const url = typeof href === 'string' ? href : ''
                              const isHttp = /^https?:\/\//i.test(url)
                              return (
                                <a
                                  {...props}
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  onClick={(e) => {
                                    if (!url) return
                                    if (isHttp) {
                                      e.preventDefault()
                                      void shellOpen(url)
                                    }
                                  }}
                                >
                                  {children}
                                </a>
                              )
                            },
                          }}
                        >
                          {appendYouTubeThumbnailMarkdown(m.content)}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ))
                )}

                {isGenerating ? (
                  <div className="TypingBubble" aria-label="Assistant is typing">
                    <div className="TypingDots" aria-hidden="true">
                      <span className="TypingDot" />
                      <span className="TypingDot" />
                      <span className="TypingDot" />
                    </div>
                  </div>
                ) : null}
                <div ref={messagesEndRef} />
              </div>

              {pendingApprovals.length ? (
                <div
                  style={{
                    margin: '0 14px 10px',
                    padding: 12,
                    borderRadius: 14,
                    border: '1px solid var(--accent-border)',
                    background: 'var(--accent-fill)',
                  }}
                >
                  <div className="Row" style={{ justifyContent: 'space-between' }}>
                    <div style={{ fontWeight: 650, color: 'var(--heading)' }}>
                      Approval required ({pendingApprovals.length})
                    </div>
                    <div className="Subtle">Human-in-the-loop is enabled</div>
                  </div>

                  {pendingApprovals.slice(0, 1).map((t) => (
                    <div key={t.id} style={{ marginTop: 10 }}>
                      <div className="Subtle">Tool</div>
                      <div style={{ fontWeight: 650, color: 'var(--heading)', marginTop: 2 }}>
                        {t.toolName}
                      </div>
                      <details style={{ marginTop: 8 }}>
                        <summary className="Subtle">arguments</summary>
                        <pre
                          style={{
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            margin: '8px 0 0',
                            padding: 10,
                            borderRadius: 12,
                            border: '1px solid var(--border)',
                            background: 'rgba(0,0,0,0.18)',
                          }}
                        >
                          {JSON.stringify(t.argsJson, null, 2)}
                        </pre>
                      </details>
                      <div className="Row" style={{ marginTop: 10 }}>
                        <button
                          className="Button"
                          onClick={() => void respondToApproval(t.id, 'approve')}
                        >
                          Approve
                        </button>
                        <button
                          className="Button ButtonDanger"
                          onClick={() => void respondToApproval(t.id, 'deny')}
                        >
                          Deny
                        </button>
                        <div className="Subtle" style={{ marginLeft: 'auto' }}>
                          {pendingApprovals.length > 1
                            ? `+${pendingApprovals.length - 1} more queued`
                            : ' '}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="Composer">
                {activity ? <div className="ComposerActivity">{activity}</div> : null}
                <div className="ComposerRow">
                  <input
                    className="Input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={isGenerating ? 'Generating…' : 'Ask something…'}
                    disabled={isGenerating}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleSend()
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="Button ComposerSend"
                    onClick={handleSend}
                    disabled={isGenerating}
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="PanelBody">
              {tab === 'settings' ? (
            <>
              <div className="Field">
                <div className="LabelRow">
                  <div className="Label">
                    <span className="Highlight">Ollama</span> host
                  </div>
                  <div className="Subtle">Usually `http://localhost:11434`</div>
                </div>
                <input
                  className="Input"
                  value={settings.ollamaHost}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, ollamaHost: e.target.value }))
                  }
                  placeholder="http://localhost:11434"
                />
              </div>

              <div className="Field">
                <div className="LabelRow">
                  <div className="Label">
                    <span className="Highlight">Model</span>
                  </div>
                  <div className="Subtle">e.g. `qwen3.5:4b`</div>
                </div>
                <input
                  className="Input"
                  value={settings.model}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, model: e.target.value }))
                  }
                  placeholder="qwen3.5:4b"
                />
              </div>

              <div className="Field">
                <div className="LabelRow">
                  <div className="Label">
                    <span className="Highlight">MCP</span> server URL
                  </div>
                  <div className="Subtle">Streamable HTTP endpoint</div>
                </div>
                <input
                  className="Input"
                  value={settings.mcpServerBaseUrl}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      mcpServerBaseUrl: e.target.value,
                    }))
                  }
                  placeholder="https://your-mcp-host/… or base URL ending with ?token="
                />
                <div className="ExampleUrlRow">
                  <span className="Subtle">Examples:</span>
                  <button
                    type="button"
                    className="Button ButtonSecondary"
                    onClick={() =>
                      setSettings((s) => ({ ...s, mcpServerBaseUrl: MCP_EXAMPLE_ZAPIER_BASE }))
                    }
                  >
                    Zapier (`…token=` + keychain)
                  </button>
                  <button
                    type="button"
                    className="Button ButtonSecondary"
                    onClick={() =>
                      setSettings((s) => ({ ...s, mcpServerBaseUrl: MCP_EXAMPLE_LOCAL }))
                    }
                  >
                    Local placeholder
                  </button>
                </div>
              </div>

              <div className="Field">
                <div className="LabelRow">
                  <div className="Label">MCP token (OS keychain, optional)</div>
                  <div className="Subtle">
                    {zapierTokenPresent ? 'saved' : 'not set'} · {zapierTokenInfo}
                  </div>
                </div>
                <div className="Subtle" style={{ marginBottom: 8 }}>
                  If the URL ends with <code style={{ fontSize: 11 }}>?token=</code> or{' '}
                  <code style={{ fontSize: 11 }}>&amp;token=</code> (empty), this token is appended.
                  For a full URL with no empty <code style={{ fontSize: 11 }}>token=</code>, leave
                  this unset.
                </div>
                <input
                  className="Input"
                  value={zapierTokenDraft}
                  onChange={(e) => setZapierTokenDraft(e.target.value)}
                  placeholder="paste token here"
                  type="password"
                />
                <div className="Row" style={{ marginTop: 8 }}>
                  <button
                    className="Button"
                    onClick={async () => {
                      try {
                        const token = zapierTokenDraft.trim()
                        if (!token) {
                          pushBackendError('Token is empty; nothing to save.')
                          return
                        }
                        if (
                          token.includes('Traceback') ||
                          token.includes('\n') ||
                          token.includes(' ') ||
                          token.length < 20
                        ) {
                          pushBackendError(
                            'Token looks invalid. Paste the raw token only (no spaces or newlines).',
                          )
                          return
                        }
                        await setZapierToken(token)
                        const reread = await getZapierToken()
                        setZapierTokenDraft('')
                        setZapierTokenPresent(Boolean(reread))
                        setZapierTokenInfo(reread ? `${reread.length} chars` : 'not set')
                        setZapierTokenCached(reread)
                        if (!reread) {
                          pushBackendError('Saved token but could not read it back from keychain.')
                        }
                      } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e)
                        pushBackendError(`Failed to save token to keychain: ${msg}`)
                      }
                    }}
                  >
                    Save token
                  </button>
                  <button
                    className="Button ButtonDanger"
                    onClick={async () => {
                      try {
                        await deleteZapierToken()
                        const reread = await getZapierToken()
                        setZapierTokenPresent(Boolean(reread))
                        setZapierTokenInfo(reread ? `${reread.length} chars` : 'not set')
                        setZapierTokenCached(reread)
                      } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e)
                        pushBackendError(`Failed to delete token from keychain: ${msg}`)
                      }
                    }}
                  >
                    Delete token
                  </button>
                </div>
              </div>

              <div className="Row" style={{ justifyContent: 'space-between' }}>
                <label className="Row" style={{ gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={settings.hilEnabled}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, hilEnabled: e.target.checked }))
                    }
                  />
                  <span className="Label">Human-in-the-loop approvals</span>
                </label>
              </div>

              <div className="Row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
                <label className="Row" style={{ gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={settings.agentMode}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, agentMode: e.target.checked }))
                    }
                  />
                  <span className="Label">Agent mode</span>
                </label>
                <input
                  className="Input"
                  style={{ width: 90, textAlign: 'right' }}
                  type="number"
                  min={1}
                  max={50}
                  value={settings.agentMaxSteps}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      agentMaxSteps: Math.max(1, Math.min(50, Number(e.target.value || 8))),
                    }))
                  }
                />
              </div>

              <div className="ActionGrid">
                <button className="Button ButtonSecondary" onClick={clearSession} title="Clear this chat session">
                  <span>Clear chat</span>
                </button>
                <button
                  className="Button ButtonSecondary"
                  onClick={() => void compressContext()}
                  title="Summarize earlier messages into a compact memory"
                >
                  <span>Compress chat</span>
                </button>
                <button className="Button ButtonSecondary" onClick={exportSession} title="Export session JSON">
                  <span>Export chat</span>
                </button>
                <button
                  className="Button ButtonSecondary"
                  onClick={() => importFileRef.current?.click()}
                  title="Import session JSON"
                >
                  <span>Import chat</span>
                </button>
                <input
                  ref={importFileRef}
                  type="file"
                  accept="application/json"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void importSessionFile(f)
                    e.currentTarget.value = ''
                  }}
                />
              </div>

              {/* removed obsolete "Next" hint */}
            </>
          ) : (
            <>
              <div className="Field">
                <div className="LabelRow">
                  <div className="Label">Tool activity</div>
                  <div className="Subtle">
                    pending {toolSummary.pending} · running {toolSummary.running} · done{' '}
                    {toolSummary.done} · error {toolSummary.err}
                  </div>
                </div>
              </div>

              {toolEvents.length === 0 ? (
                <div className="Subtle">No tool calls yet.</div>
              ) : (
                <div style={{ display: 'grid', gap: 10 }}>
                  {toolEvents
                    .slice()
                    .reverse()
                    .map((t: ToolCallEvent) => (
                      <div
                        key={t.id}
                        style={{
                          padding: 10,
                          border: '1px solid var(--border)',
                          borderRadius: 12,
                          background: 'rgba(255,255,255,0.04)',
                        }}
                      >
                        <div className="Row" style={{ justifyContent: 'space-between' }}>
                          <div style={{ fontWeight: 650, color: 'var(--heading)' }}>
                            {t.toolName}
                          </div>
                          <div className="Subtle">{t.status}</div>
                        </div>
                        <div className="Subtle" style={{ marginTop: 6 }}>
                          {t.server ? `server: ${t.server}` : 'server: (auto)'}
                        </div>
                        <details style={{ marginTop: 8 }}>
                          <summary className="Subtle">details</summary>
                          <pre
                            style={{
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              margin: '8px 0 0',
                              padding: 10,
                              borderRadius: 12,
                              border: '1px solid var(--border)',
                              background: 'rgba(0,0,0,0.15)',
                            }}
                          >
                            {JSON.stringify(
                              {
                                args: t.argsJson,
                                result: t.resultText,
                                error: t.errorText,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                        {t.status === 'pending' ? (
                          <div className="Row" style={{ marginTop: 8 }}>
                            <button
                              className="Button"
                              onClick={() => void respondToApproval(t.id, 'approve')}
                            >
                              Approve
                            </button>
                            <button
                              className="Button ButtonDanger"
                              onClick={() => void respondToApproval(t.id, 'deny')}
                            >
                              Deny
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                </div>
              )}
            </>
          )}
            </div>
          )}
        </section>
      </div>
    </>
  )
}
