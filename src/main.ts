import './styles.css'
import type { CanvasAddonMountContext } from '../generated/mywallpaper-runtime'
import { nativeClient } from './client'
import { demoClient, demoCollection } from './demo'
import { createPanels } from './panels'
import { readCollection, splitCollection } from './storage'

export function mount({ layer, runtime }: CanvasAddonMountContext): () => void {
  const thumbnail = runtime.mode === 'thumbnail'
  const client = thumbnail ? demoClient(() => {}) : nativeClient(layer)
  const collection = () => readCollection(layer.settings.get().collection, layer.deviceSettings.get().localBindings, layer.layerId)
  const app = createPanels(layer.root, client, {
    settings: layer.settings.get(), collection: thumbnail ? JSON.stringify(demoCollection()) : collection(),
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
    layer.settings.subscribe(values => { app.configure(values); if (!thumbnail) app.load(collection()) }),
    layer.deviceSettings.subscribe(() => { if (!thumbnail) app.load(collection()) }),
  ]
  let disposed = false
  const cleanup = () => {
    if (disposed) return
    disposed = true; stops.forEach(stop => stop()); app.dispose(); client.close()
  }
  const stop = layer.lifecycle.onDispose(cleanup)
  return () => { stop(); cleanup() }
}
