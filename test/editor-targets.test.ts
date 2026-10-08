import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorTargets, updateEditorTarget } from '../src/editorTargets.ts'
import { emptyCollection } from '../src/model.ts'
import { readPortableCollection, splitCollection } from '../src/storage.ts'

function buttonCollection() {
  const collection = emptyCollection()
  collection.buttons.push({
    id: 'panel-one', label: 'WhatsApp', target: '', arguments: '',
    x: 160, y: 90, width: 320, height: 180, shape: 'rectangle', radius: 20,
    color: '#98bce8', icon: 'app', showLabel: true,
    media: { kind: 'none', path: '', hoverOnly: true },
  })
  return collection
}

test('child target bounds map through the layer-root letterbox and back without mutating saved data', () => {
  const collection = buttonCollection()
  collection.buttons.push({ ...structuredClone(collection.buttons[0]!), id: 'panel-two', x: 560 })
  const bounds = { width: 1000, height: 1000 }
  const [target] = createEditorTargets(collection, bounds)

  assert.deepEqual(target.geometry, {
    xPercent: 10, yPercent: 27.5, widthPercent: 20, heightPercent: 11.25, rotation: 0,
  })
  assert.equal(target.id, 'panel-one')
  assert.equal(target.canMove, true)
  assert.equal(target.canResize, true)
  assert.equal(target.canRotate, false)
  assert.deepEqual(Object.keys(target).sort(), ['canMove', 'canResize', 'canRotate', 'geometry', 'id', 'label'])

  const update = updateEditorTarget(collection, {
    targetId: target.id, action: 'move', phase: 'commit',
    geometry: { ...target.geometry, xPercent: target.geometry.xPercent + 5, yPercent: target.geometry.yPercent + 2 },
    previousGeometry: target.geometry,
  }, bounds)

  assert.deepEqual(
    update && [update.button.x, update.button.y, update.button.width, update.button.height],
    [240, 122, 320, 180],
  )
  assert.equal(update?.changed, true)
  assert.notEqual(update?.collection, collection)
  assert.notEqual(update?.collection.buttons, collection.buttons)
  assert.notEqual(update?.collection.buttons[0], collection.buttons[0])
  assert.equal(update?.collection.buttons[1], collection.buttons[1])
  assert.equal(collection.buttons[0]?.x, 160)
  assert.equal(collection.buttons[0]?.y, 90)

  const edge = buttonCollection()
  edge.buttons[0]!.x = edge.width - edge.buttons[0]!.width
  edge.buttons[0]!.y = edge.height - edge.buttons[0]!.height
  const [edgeTarget] = createEditorTargets(edge, { width: 1365, height: 768 })
  assert.ok(edgeTarget.geometry.xPercent + edgeTarget.geometry.widthPercent <= 100.000001)
  assert.ok(edgeTarget.geometry.yPercent + edgeTarget.geometry.heightPercent <= 100.000001)
})

test('child geometry updates stay in portable settings and leave private device bindings untouched', () => {
  const local = buttonCollection()
  local.buttons[0]!.target = 'C:\\Users\\Rayan\\Desktop\\WhatsApp.lnk'
  local.buttons[0]!.arguments = '--profile personal'
  local.buttons[0]!.media = {
    kind: 'image', path: 'C:\\Users\\Rayan\\Pictures\\wallpaper.png', hoverOnly: true,
  }
  const split = splitCollection(local, undefined, 'personal-root')
  const deviceSettingsBefore = split.deviceSettings
  const portable = readPortableCollection(split.portable)
  const [target] = createEditorTargets(portable, { width: 1000, height: 1000 })
  const update = updateEditorTarget(portable, {
    targetId: target.id, action: 'resize', phase: 'commit',
    geometry: { ...target.geometry, widthPercent: target.geometry.widthPercent + 2 },
    previousGeometry: target.geometry,
  }, { width: 1000, height: 1000 })

  assert.ok(update)
  const serializedPatch = JSON.stringify(update.collection)
  assert.ok(!serializedPatch.includes('C:\\Users'))
  assert.ok(!serializedPatch.includes('--profile personal'))
  assert.equal(update.collection.buttons[0]?.target, '')
  assert.equal(update.collection.buttons[0]?.arguments, '')
  assert.equal(update.collection.buttons[0]?.media.path, '')
  assert.equal(split.deviceSettings, deviceSettingsBefore)
  assert.deepEqual(JSON.parse(split.deviceSettings).layers['personal-root']['panel-one'], {
    target: 'C:\\Users\\Rayan\\Desktop\\WhatsApp.lnk',
    arguments: '--profile personal',
    mediaPath: 'C:\\Users\\Rayan\\Pictures\\wallpaper.png',
  })
})

test('unsupported rotation cannot change child data', () => {
  const collection = buttonCollection()
  const [target] = createEditorTargets(collection, { width: 1600, height: 900 })
  const update = updateEditorTarget(collection, {
    targetId: target.id, action: 'rotate', phase: 'commit',
    geometry: { ...target.geometry, rotation: 15 },
    previousGeometry: target.geometry,
  }, { width: 1600, height: 900 })

  assert.equal(update, undefined)
  assert.equal(collection.buttons[0]?.x, 160)
  assert.equal(collection.buttons[0]?.y, 90)
})

test('host registration bounds labels and exposes every supported collection item', () => {
  const collection = buttonCollection()
  collection.buttons[0]!.label = 'W'.repeat(120)
  for (let index = 1; index < 1024; index++) {
    collection.buttons.push({ ...structuredClone(collection.buttons[0]!), id: `panel-${index}` })
  }

  const targets = createEditorTargets(collection, { width: 1600, height: 900 })
  assert.equal(targets.length, 1024)
  assert.equal(targets[0]?.label.length, 80)
  assert.equal(targets.at(-1)?.id, 'panel-1023')
})
