import type {
  CanvasEditorTarget,
  CanvasEditorTargetGeometry,
  CanvasEditorTargetTransformEvent,
} from '../generated/mywallpaper-runtime'
import { constrain, type Collection, type PanelButton } from './model'

export interface LayerRootBounds {
  width: number
  height: number
}

export interface PanelGeometry {
  x: number
  y: number
  width: number
  height: number
}

export interface EditorTargetUpdate {
  collection: Collection
  button: PanelButton
  changed: boolean
}

interface FittedCanvas {
  scale: number
  offsetX: number
  offsetY: number
}

// The host caps one Canvas child-target registration at 256 items.
const MAX_REGISTERED_TARGETS = 256

function fittedCanvas(collection: Collection, bounds: LayerRootBounds): FittedCanvas | undefined {
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0) return undefined
  const scale = Math.min(bounds.width / collection.width, bounds.height / collection.height)
  if (!Number.isFinite(scale) || scale <= 0) return undefined
  return {
    scale,
    offsetX: (bounds.width - collection.width * scale) / 2,
    offsetY: (bounds.height - collection.height * scale) / 2,
  }
}

const percent = (value: number, extent: number): number => Number((value / extent * 100).toFixed(4))

function toRootGeometry(
  button: PanelButton,
  collection: Collection,
  bounds: LayerRootBounds,
): CanvasEditorTargetGeometry | undefined {
  const fit = fittedCanvas(collection, bounds)
  if (!fit) return undefined
  const widthPercent = percent(button.width * fit.scale, bounds.width)
  const heightPercent = percent(button.height * fit.scale, bounds.height)
  return {
    xPercent: Math.min(percent(fit.offsetX + button.x * fit.scale, bounds.width), 100 - widthPercent),
    yPercent: Math.min(percent(fit.offsetY + button.y * fit.scale, bounds.height), 100 - heightPercent),
    widthPercent,
    heightPercent,
    rotation: 0,
  }
}

function boundedLabel(value: string, index: number): string {
  const source = value.trim() || `Button ${index + 1}`
  let result = ''
  for (const character of source) {
    if (result.length + character.length > 80) break
    result += character
  }
  return result || `Button ${index + 1}`
}

/** Build host targets from the portable layer value only; bindings never enter the target contract. */
export function createEditorTargets(
  collection: Collection,
  bounds: LayerRootBounds,
): CanvasEditorTarget[] {
  return collection.buttons.slice(0, MAX_REGISTERED_TARGETS).flatMap((button, index) => {
    const geometry = toRootGeometry(button, collection, bounds)
    return geometry ? [{
      id: button.id,
      label: boundedLabel(button.label, index),
      geometry,
      canMove: true,
      canResize: true,
      canRotate: false,
    }] : []
  })
}

function fromRootGeometry(
  geometry: CanvasEditorTargetGeometry,
  collection: Collection,
  bounds: LayerRootBounds,
): PanelGeometry | undefined {
  if (![geometry.xPercent, geometry.yPercent, geometry.widthPercent, geometry.heightPercent, geometry.rotation]
    .every(Number.isFinite) || geometry.widthPercent <= 0 || geometry.heightPercent <= 0
    || Math.abs(geometry.rotation) > 0.0001) return undefined
  const fit = fittedCanvas(collection, bounds)
  if (!fit) return undefined
  return {
    x: (geometry.xPercent / 100 * bounds.width - fit.offsetX) / fit.scale,
    y: (geometry.yPercent / 100 * bounds.height - fit.offsetY) / fit.scale,
    width: geometry.widthPercent / 100 * bounds.width / fit.scale,
    height: geometry.heightPercent / 100 * bounds.height / fit.scale,
  }
}

/** Apply an editor event to a validated portable value, cloning only its target button. */
export function updateEditorTarget(
  collection: Collection,
  event: CanvasEditorTargetTransformEvent,
  bounds: LayerRootBounds,
): EditorTargetUpdate | undefined {
  if (event.action !== 'move' && event.action !== 'resize') return undefined
  const index = collection.buttons.findIndex(item => item.id === event.targetId)
  if (index < 0) return undefined
  const geometry = fromRootGeometry(event.geometry, collection, bounds)
  if (!geometry) return undefined
  const button = { ...collection.buttons[index]! }
  const before = { x: button.x, y: button.y, width: button.width, height: button.height }
  button.x = geometry.x
  button.y = geometry.y
  button.width = geometry.width
  button.height = geometry.height
  constrain(button, collection)
  const buttons = collection.buttons.slice()
  buttons[index] = button
  return {
    collection: { ...collection, buttons },
    button,
    changed: button.x !== before.x || button.y !== before.y
      || button.width !== before.width || button.height !== before.height,
  }
}

export function sameEditorGeometry(
  left: CanvasEditorTargetGeometry,
  right: CanvasEditorTargetGeometry,
): boolean {
  return left.xPercent === right.xPercent && left.yPercent === right.yPercent
    && left.widthPercent === right.widthPercent && left.heightPercent === right.heightPercent
    && left.rotation === right.rotation
}
