import { configFits, emptyCollection, parseCollection, type Collection } from './model'

export interface ButtonBindings {
  target?: string
  arguments?: string
  mediaPath?: string
}

export interface CollectionSplit {
  /** Layout and shareable URLs to store with the wallpaper layer. */
  portable: Collection
  /** Updated local deviceSettings value, keyed by layer and button IDs. */
  deviceSettings: string
}

interface DeviceStore {
  version: 1
  layers: Record<string, Record<string, ButtonBindings>>
}

const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key)
const record = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)
const emptyRecord = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

function requireLayerId(layerId: string): void {
  if (typeof layerId !== 'string' || layerId.length < 1 || layerId.length > 256) {
    throw new Error('Invalid layer identifier.')
  }
}

function collectionValue(value: unknown): Collection {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof serialized !== 'string') throw new Error('Invalid button collection.')
  return parseCollection(serialized)
}

function copyBindings(value: unknown): Record<string, Record<string, ButtonBindings>> {
  if (!record(value)) throw new Error('Invalid local bindings.')
  const layers = emptyRecord<Record<string, ButtonBindings>>()
  for (const [layerId, rawButtons] of Object.entries(value)) {
    requireLayerId(layerId)
    if (!record(rawButtons)) throw new Error('Invalid local button bindings.')
    const buttons = emptyRecord<ButtonBindings>()
    for (const [buttonId, rawBinding] of Object.entries(rawButtons)) {
      if (!/^[\w-]{1,80}$/.test(buttonId) || !record(rawBinding)) {
        throw new Error('Invalid local button binding.')
      }
      const binding: ButtonBindings = {}
      for (const key of Object.keys(rawBinding)) {
        if (key !== 'target' && key !== 'arguments' && key !== 'mediaPath') {
          throw new Error('Unsupported local button binding.')
        }
        const item = rawBinding[key]
        if (typeof item !== 'string' || item.length < 1 || item.length > 32768) {
          throw new Error('Invalid local button binding value.')
        }
        binding[key] = item
      }
      if (Object.keys(binding).length > 0) buttons[buttonId] = binding
    }
    if (Object.keys(buttons).length > 0) layers[layerId] = buttons
  }
  return layers
}

function decode(value: unknown): DeviceStore {
  if (value === undefined) return { version: 1, layers: emptyRecord() }
  if (typeof value !== 'string' || !configFits(value)) throw new Error('Invalid local bindings.')
  const parsed: unknown = JSON.parse(value)
  if (!record(parsed) || parsed['version'] !== 1) throw new Error('Unsupported local bindings.')
  return { version: 1, layers: copyBindings(parsed['layers']) }
}

function encode(store: DeviceStore): string {
  const value = JSON.stringify(store)
  if (!configFits(value)) throw new Error('Local configuration is too large. Remove unused buttons or export a backup.')
  return value
}

function publicUrl(value: string, protocols: readonly string[]): boolean {
  if (!value || value !== value.trim()) return false
  try {
    const url = new URL(value)
    return protocols.includes(url.protocol.toLowerCase())
      && !url.username && !url.password
      && (url.protocol.toLowerCase() !== 'mailto:' || url.pathname.length > 0)
  } catch { return false }
}

function mergeBindings(collection: Collection, bindings: Record<string, ButtonBindings> | undefined): Collection {
  if (!bindings) return collection
  for (const button of collection.buttons) {
    if (!own(bindings, button.id)) continue
    const binding = bindings[button.id]!
    if (binding.target !== undefined) button.target = binding.target
    if (binding.arguments !== undefined) button.arguments = binding.arguments
    if (binding.mediaPath !== undefined) button.media.path = binding.mediaPath
  }
  return parseCollection(JSON.stringify(collection))
}

function portableCollectionValue(value: unknown): Collection {
  const collection = collectionValue(value)
  for (const button of collection.buttons) {
    if (!publicUrl(button.target, ['http:', 'https:', 'mailto:'])) button.target = ''
    button.arguments = ''
    if (!publicUrl(button.media.path, ['https:'])) button.media.path = ''
  }
  return collection
}

/** Split an editor collection into portable layer data and private device bindings. */
export function splitCollection(value: unknown, deviceValue: unknown, layerId: string): CollectionSplit {
  requireLayerId(layerId)
  const portable = collectionValue(value)
  const bindings = emptyRecord<ButtonBindings>()

  for (const button of portable.buttons) {
    const local: ButtonBindings = {}
    if (!publicUrl(button.target, ['http:', 'https:', 'mailto:'])) {
      if (button.target) local.target = button.target
      button.target = ''
    }
    if (button.arguments) local.arguments = button.arguments
    button.arguments = ''

    if (!publicUrl(button.media.path, ['https:'])) {
      if (button.media.path) local.mediaPath = button.media.path
      button.media.path = ''
    }
    if (Object.keys(local).length > 0) bindings[button.id] = local
  }

  const store = decode(deviceValue)
  if (Object.keys(bindings).length > 0) store.layers[layerId] = bindings
  else delete store.layers[layerId]
  return { portable, deviceSettings: encode(store) }
}

/** Read the wallpaper-owned value without merging any machine-local bindings. */
export function readPortableCollection(value: unknown): Collection {
  return value === undefined ? emptyCollection() : portableCollectionValue(value)
}

/** Recombine the portable layout and private bindings for the editor/runtime. */
export function readCollection(portableValue: unknown, deviceValue: unknown, layerId: string): string {
  try {
    requireLayerId(layerId)
    const store = decode(deviceValue)
    const portable = readPortableCollection(portableValue)
    return JSON.stringify(mergeBindings(portable, own(store.layers, layerId) ? store.layers[layerId] : undefined))
  } catch {
    return '' // Keep the editor's existing invalid-data guard effective.
  }
}
