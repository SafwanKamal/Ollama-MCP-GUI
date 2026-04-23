import { invoke } from '@tauri-apps/api/core'

export async function setZapierToken(token: string) {
  await invoke('secret_set_zapier_token', { token })
}

export async function getZapierToken(): Promise<string | null> {
  const res = (await invoke('secret_get_zapier_token')) as string | null
  return res
}

export async function deleteZapierToken() {
  await invoke('secret_delete_zapier_token')
}

