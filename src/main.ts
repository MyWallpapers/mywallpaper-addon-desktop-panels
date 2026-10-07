import './styles.css'
import type { CanvasAddonMountContext } from '../generated/mywallpaper-runtime'
import { nativeClient } from './client'
import { demoClient, demoCollection } from './demo'
import { createPanels } from './panels'
import { readLayer, writeLayer } from './storage'

export function mount({ layer, runtime }: CanvasAddonMountContext): () => void {
  const thumbnail = runtime.mode === 'thumbnail'
  const client = thumbnail ? demoClient(() => {}) : nativeClient(layer)
  const app = createPanels(layer.root, client, {
    settings: layer.settings.get(), collection: thumbnail ? JSON.stringify(demoCollection()) : readLayer(layer.deviceSettings.get().collection, layer.layerId),
    save: c => layer.deviceSettings.set({ collection: writeLayer(layer.deviceSettings.get().collection, layer.layerId, c) }), thumbnail,
  })
  const stops = [
    layer.actions.on('editButtons', () => app.edit()),
    layer.settings.subscribe(values => app.configure(values)),
    layer.deviceSettings.subscribe(values => app.load(readLayer(values.collection, layer.layerId))),
  ]
  let disposed = false
  const cleanup = () => {
    if (disposed) return
    disposed = true; stops.forEach(stop => stop()); app.dispose(); client.close()
  }
  const stop = layer.lifecycle.onDispose(cleanup)
  return () => { stop(); cleanup() }
}
