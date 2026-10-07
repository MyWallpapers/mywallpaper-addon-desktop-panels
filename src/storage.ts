import { configFits, emptyCollection, type Collection } from './model'

interface DeviceStore { version: 1; layers: Record<string, Collection> }
function decode(value: unknown): DeviceStore {
  if (value === undefined) return { version: 1, layers: {} }
  if (typeof value !== 'string' || !configFits(value)) throw new Error('Invalid local configuration.')
  const store = JSON.parse(value) as DeviceStore
  if (!store || store.version !== 1 || !store.layers || typeof store.layers !== 'object' || Array.isArray(store.layers)) throw new Error('Unsupported local configuration.')
  return store
}
export function readLayer(value: unknown, layerId: string): string {
  try {
    const store = decode(value)
    return JSON.stringify(Object.hasOwn(store.layers, layerId) ? store.layers[layerId] : emptyCollection())
  } catch { return '' } // The editor blocks changes instead of overwriting unreadable data.
}
export function writeLayer(value: unknown, layerId: string, collection: Collection): string {
  const store = decode(value)
  const result = JSON.stringify({ version: 1, layers: { ...store.layers, [layerId]: collection } })
  if (!configFits(result)) throw new Error('Local configuration is too large. Remove unused buttons or export a backup.')
  return result
}
