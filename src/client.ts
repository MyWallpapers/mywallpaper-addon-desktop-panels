import type { CanvasLayerApi, NativeConnection, JsonValue } from '../generated/mywallpaper-runtime'
import type { Client } from './model'

export function nativeClient(layer: CanvasLayerApi): Client {
  let connection: Promise<NativeConnection> | undefined
  let disposed = false
  let unsubscribe: (() => void) | undefined
  let unsubscribeState: (() => void) | undefined
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const rejectAll = (message: string) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)) }
    pending.clear()
  }
  async function connect(): Promise<NativeConnection> {
    if (disposed) throw new Error('The add-on is closed.')
    if (!layer.native.companion.available) throw new Error('Activate the Windows companion in MyWallpaper to open local shortcuts.')
    if (!connection) {
      connection = layer.native.companion.connect().then(c => {
        if (disposed) { c.close(); throw new Error('The add-on is closed.') }
        unsubscribe = c.onMessage(payload => {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.kind !== 'panels.result' || typeof payload.requestId !== 'string') return
          const p = pending.get(payload.requestId)
          if (!p) return
          pending.delete(payload.requestId); clearTimeout(p.timer)
          if (payload.ok === true) p.resolve(payload.result)
          else p.reject(new Error(typeof payload.error === 'string' ? payload.error : 'The Windows action failed.'))
        })
        unsubscribeState = c.onStateChange(state => {
          if (state === 'failed' || state === 'closed') {
            unsubscribe?.(); unsubscribeState?.(); connection = undefined
            rejectAll('The Windows companion disconnected. Try again.')
          }
        })
        return c
      }).catch(error => { connection = undefined; throw error })
    }
    return connection
  }
  return {
    async request<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
      const c = await connect()
      const requestId = crypto.randomUUID()
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('The Windows action timed out. Try again.')) }, action.startsWith('pick') ? 180000 : 20000)
        pending.set(requestId, { resolve: v => resolve(v as T), reject, timer })
        c.send({ kind: 'panels.command', requestId, action, input } as JsonValue).catch(error => {
          clearTimeout(timer); pending.delete(requestId); reject(error)
        })
      })
    },
    close() {
      disposed = true; rejectAll('The add-on is closed.'); unsubscribe?.(); unsubscribeState?.()
      void connection?.then(c => c.close()).catch(() => {})
    },
  }
}

/** Only the standalone preview uses a loopback HTTP bridge. The published add-on uses host IPC. */
export function previewClient(): Client {
  const controller = new AbortController()
  let token: Promise<string> | undefined
  const base = 'http://localhost:5195'
  return {
    async request<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
      token ??= fetch(base + '/session', { signal: controller.signal }).then(async r => {
        if (!r.ok) throw new Error('Start the local Windows preview companion.')
        const data = await r.json() as { token: string }; return data.token
      }).catch(e => { token = undefined; throw e })
      const r = await fetch(base + '/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panels-Token': await token }, body: JSON.stringify({ action, input }), signal: controller.signal })
      const data = await r.json() as { ok: boolean; result: T; error?: string }
      if (!r.ok || !data.ok) throw new Error(data.error ?? 'The local Windows action failed.')
      return data.result
    },
    close: () => controller.abort(),
  }
}
