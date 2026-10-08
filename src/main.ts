import './styles.css'
import type { CanvasAddonMountContext, CanvasEditorTargetGeometry } from '../generated/mywallpaper-runtime'
import { nativeClient } from './client'
import { demoClient, demoCollection } from './demo'
import { createEditorTargets, sameEditorGeometry, updateEditorTarget } from './editorTargets'
import { emptyCollection } from './model'
import { createPanels } from './panels'
import { readCollection, readPortableCollection, splitCollection } from './storage'

export function mount({ layer, runtime }: CanvasAddonMountContext): () => void {
  const thumbnail = runtime.mode === 'thumbnail'
  const client = thumbnail ? demoClient(() => {}) : nativeClient(layer)
  const collection = () => readCollection(layer.settings.get().collection, layer.deviceSettings.get().localBindings, layer.layerId)
  const portableCollection = () => readPortableCollection(layer.settings.get().collection)
  const rootBounds = () => {
    const rect = layer.root.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }
  let app: ReturnType<typeof createPanels>
  let panelEditing = false
  let disposed = false
  let editorRegistrationGeneration = 0
  let editorTargetCleanup: (() => void) | undefined
  let editorResizeObserver: ResizeObserver | undefined
  const editor = layer.editor
  const clearEditorTargets = () => {
    editorRegistrationGeneration++
    const cleanup = editorTargetCleanup
    editorTargetCleanup = undefined
    cleanup?.()
  }
  const refreshEditorTargets = () => {
    const generation = ++editorRegistrationGeneration
    if (disposed || thumbnail || panelEditing || !editor) {
      const cleanup = editorTargetCleanup
      editorTargetCleanup = undefined
      cleanup?.()
      return
    }

    let portable
    try { portable = portableCollection() } catch { portable = emptyCollection() }
    const targets = createEditorTargets(portable, rootBounds())
    const initialGeometry = new Map(targets.map(target => [target.id, target.geometry]))
    editorTargetCleanup = editor.registerTargets(targets, event => {
      if (event.phase === 'cancel') {
        initialGeometry.set(event.targetId, event.geometry)
        app.previewTarget(event.targetId)
        return
      }
      if (disposed || panelEditing || generation !== editorRegistrationGeneration) return

      let update
      try { update = updateEditorTarget(portable, event, rootBounds()) } catch { update = undefined }
      if (!update) {
        app.previewTarget(event.targetId)
        return
      }
      app.previewTarget(event.targetId, {
        x: update.button.x,
        y: update.button.y,
        width: update.button.width,
        height: update.button.height,
      })
      if (event.phase === 'preview') return

      const original = initialGeometry.get(event.targetId)
      if (!update.changed || !original || sameEditorGeometry(original, event.geometry)) {
        app.previewTarget(event.targetId)
        return
      }
      initialGeometry.set(event.targetId, event.geometry)
      return { collection: JSON.stringify(update.collection) }
    })
  }

  app = createPanels(layer.root, client, {
    settings: layer.settings.get(), collection: thumbnail ? JSON.stringify(demoCollection()) : collection(),
    onEditingChange(editing, reason) {
      panelEditing = editing
      if (editing) clearEditorTargets()
      else {
        if (reason === 'cancel') app.load(collection())
        refreshEditorTargets()
      }
    },
    async save(c) {
      const split = splitCollection(c, layer.deviceSettings.get().localBindings, layer.layerId)
      await layer.deviceSettings.set({ localBindings: split.deviceSettings })
      await layer.settings.set({ collection: JSON.stringify(split.portable) })
    }, thumbnail,
  })
  const stops = [
    layer.actions.on('editButtons', () => app.edit()),
    layer.actions.on('importButtons', () => app.importConfiguration()),
    layer.actions.on('exportButtons', () => app.exportConfiguration()),
    layer.settings.subscribe(values => {
      app.configure(values)
      if (!thumbnail) app.load(collection())
      refreshEditorTargets()
    }),
    layer.deviceSettings.subscribe(() => { if (!thumbnail) app.load(collection()) }),
  ]
  if (editor && !thumbnail && typeof ResizeObserver !== 'undefined') {
    editorResizeObserver = new ResizeObserver(refreshEditorTargets)
    editorResizeObserver.observe(layer.root)
  }
  refreshEditorTargets()
  const cleanup = () => {
    if (disposed) return
    disposed = true; stops.forEach(stop => stop()); editorResizeObserver?.disconnect(); clearEditorTargets()
    app.dispose(); client.close()
  }
  const stop = layer.lifecycle.onDispose(cleanup)
  return () => { stop(); cleanup() }
}
