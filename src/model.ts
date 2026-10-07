export type Shape = 'rectangle' | 'ellipse' | 'triangle' | 'hexagon'
export type ButtonIcon = 'app' | 'folder' | 'file' | 'link' | 'music' | 'image'
export interface PanelButton {
  id: string
  label: string
  target: string
  arguments: string
  x: number
  y: number
  width: number
  height: number
  shape: Shape
  radius: number
  color: string
  icon: ButtonIcon
  showLabel: boolean
  media: { kind: 'none' | 'image' | 'video'; path: string; hoverOnly: boolean }
}
export interface Collection { version: 1; width: number; height: number; buttons: PanelButton[] }
export interface TargetEntry { target: string; label: string; kind: 'file' | 'folder' }
export interface Client {
  request<T>(action: string, input?: Record<string, unknown>): Promise<T>
  close(): void
}
// Keep room for host metadata in the process-v2 initial single-chunk record.
export const MAX_CONFIG_BYTES = 512 * 1024
export const configFits = (value: string): boolean => value.length <= MAX_CONFIG_BYTES && new TextEncoder().encode(value).byteLength <= MAX_CONFIG_BYTES
export const emptyCollection = (): Collection => ({ version: 1, width: 1600, height: 900, buttons: [] })
export const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n))
export function newButton(index: number): PanelButton {
  return {
    id: crypto.randomUUID(), label: 'Button ' + (index + 1), target: '', arguments: '',
    x: 64 + (index % 5) * 224, y: 64 + Math.floor(index / 5) * 176,
    width: 200, height: 144, shape: 'rectangle', radius: 20, color: '#98bce8', icon: 'app',
    showLabel: true, media: { kind: 'none', path: '', hoverOnly: true },
  }
}
const shapes: Shape[] = ['rectangle', 'ellipse', 'triangle', 'hexagon']
const icons: ButtonIcon[] = ['app', 'folder', 'file', 'link', 'music', 'image']
const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
export function parseCollection(value: unknown): Collection {
  if (typeof value !== 'string' || !configFits(value)) throw new Error('Invalid or oversized button data.')
  const data = JSON.parse(value) as Collection
  if (!data || data.version !== 1 || !finite(data.width, 320, 16384) || !finite(data.height, 240, 16384)
    || !Array.isArray(data.buttons) || data.buttons.length > 1024) throw new Error('Unsupported button data.')
  const ids = new Set<string>()
  for (const b of data.buttons) {
    if (!b || typeof b.id !== 'string' || !/^[\w-]{1,80}$/.test(b.id) || ids.has(b.id)
      || typeof b.label !== 'string' || b.label.length > 120 || typeof b.target !== 'string' || b.target.length > 32768
      || typeof b.arguments !== 'string' || b.arguments.length > 32768 || !finite(b.x, 0, data.width)
      || !finite(b.y, 0, data.height) || !finite(b.width, 32, data.width) || !finite(b.height, 32, data.height)
      || !shapes.includes(b.shape) || !icons.includes(b.icon) || !finite(b.radius, 0, 128)
      || typeof b.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(b.color) || typeof b.showLabel !== 'boolean'
      || !b.media || !['none', 'image', 'video'].includes(b.media.kind) || typeof b.media.path !== 'string'
      || b.media.path.length > 32768 || typeof b.media.hoverOnly !== 'boolean') throw new Error('Invalid button properties.')
    ids.add(b.id)
    constrain(b, data)
  }
  return data
}
export function constrain(b: PanelButton, c: Collection): void {
  b.width = clamp(Math.round(b.width), 32, c.width)
  b.height = clamp(Math.round(b.height), 32, c.height)
  b.x = clamp(Math.round(b.x), 0, c.width - b.width)
  b.y = clamp(Math.round(b.y), 0, c.height - b.height)
}
