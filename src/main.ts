import './styles.css'
import type { CanvasAddonMountContext } from '../generated/mywallpaper-runtime'
import { nativeClient } from './client'
import { demoClient, demoCollection } from './demo'
import { createEditorTargets, sameEditorGeometry, updateEditorTarget } from './editorTargets'
import { createPanelInspector } from './inspector'
import { createPanels } from './panels'
import { readCollection, readPortableCollection } from './storage'

export function mount({ layer, runtime }: CanvasAddonMountContext): () => void {
  const thumbnail = runtime.mode === 'thumbnail'
  const client = thumbnail ? demoClient(() => {}) : nativeClient(layer)
  const collection = () => readCollection(layer.settings.get().collection, layer.deviceSettings.get().localBindings, layer.layerId)
  const rootBounds = () => {
    const rect = layer.root.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }
  const app = createPanels(layer.root, client, { settings: layer.settings.get(),
    collection: thumbnail ? JSON.stringify(demoCollection()) : collection(), thumbnail })
  const inspector = createPanelInspector(layer, client)
  let disposed = false
  let generation = 0
  let targetFingerprint = ''
  let stopTargets: (() => void) | undefined
  const refreshTargets = () => {
    if (disposed || thumbnail || !layer.editor) return
    // Invalid persisted data must not silently turn into an empty, editable layout.
    let portable
    try { portable = readPortableCollection(layer.settings.get().collection) } catch { generation++; targetFingerprint = ''; stopTargets?.(); stopTargets = undefined; return }
    const targets = createEditorTargets(portable, rootBounds())
    const fingerprint = JSON.stringify(targets)
    if (fingerprint === targetFingerprint && stopTargets) return
    targetFingerprint = fingerprint
    const current = ++generation
    const initial = new Map(targets.map(target => [target.id, target.geometry]))
    stopTargets = layer.editor.registerTargets(targets, event => {
      if (event.phase === 'cancel') { app.previewTarget(event.targetId); return }
      if (disposed || current !== generation) return
      const update = updateEditorTarget(portable, event, rootBounds())
      if (!update) { app.previewTarget(event.targetId); return }
      app.previewTarget(event.targetId, { x: update.button.x, y: update.button.y,
        width: update.button.width, height: update.button.height })
      if (event.phase === 'preview') return
      const original = initial.get(event.targetId)
      if (!update.changed || !original || sameEditorGeometry(original, event.geometry)) {
        app.previewTarget(event.targetId); return
      }
      initial.set(event.targetId, event.geometry)
      // Geometry commits contain no private bindings and form one host history entry.
      return { collection: JSON.stringify(update.collection) }
    }, inspector)
  }
  const stops = [
    layer.settings.subscribe(values => { app.configure(values); if (!thumbnail) app.load(collection()); refreshTargets() }),
    layer.deviceSettings.subscribe(() => { if (!thumbnail) app.load(collection()) }),
  ]
  const resize = !thumbnail && layer.editor ? new ResizeObserver(refreshTargets) : undefined
  resize?.observe(layer.root)
  refreshTargets()
  const cleanup = () => {
    if (disposed) return
    disposed = true; generation++; stops.forEach(stop => stop()); resize?.disconnect(); stopTargets?.()
    app.dispose(); client.close()
  }
  const stop = layer.lifecycle.onDispose(cleanup)
  return () => { stop(); cleanup() }
}
