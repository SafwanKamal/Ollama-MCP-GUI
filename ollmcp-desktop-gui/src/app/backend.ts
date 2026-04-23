import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

export type BackendEvent = {
  type: string
  id?: string
  requestId?: string
  payload?: Record<string, unknown>
}

export async function backendStart() {
  await invoke('backend_start')
}

export async function backendSend(msg: unknown) {
  await invoke('backend_send', { msg })
}

export function onBackendEvent(cb: (evt: BackendEvent) => void) {
  return listen<string>('backend:event', (e) => {
    try {
      const parsed = JSON.parse(e.payload) as BackendEvent
      cb(parsed)
    } catch {
      cb({ type: 'error', payload: { message: 'Failed to parse backend event', raw: e.payload } })
    }
  })
}

