import assert from 'node:assert/strict'
import test from 'node:test'
import type { AddonValues, CanvasLayerApi, CanvasEditorSettingsPatch } from '../generated/mywallpaper-runtime'
import { createPanelInspector } from '../src/inspector.ts'
import { nativeClient } from '../src/client.ts'
import { emptyCollection, newButton, type Client } from '../src/model.ts'
import { readCollection, splitCollection } from '../src/storage.ts'

function fixture(client?: Client) {
  const c = emptyCollection()
  const b = newButton(0)
  b.target = 'C:\\Apps\\Example.exe'
  b.arguments = '--profile private'
  b.media = { kind: 'image', path: 'C:\\Pictures\\tile.png', hoverOnly: true }
  c.buttons.push(b)
  const otherRoot = JSON.stringify({ version: 1, layers: { 'root-other': {
    other: { target: 'C:\\Apps\\Other.exe', arguments: '--other' },
  } } })
  const initial = splitCollection(c, otherRoot, 'root-one')
  let values: AddonValues = { collection: JSON.stringify(initial.portable), language: 'en' }
  let device: AddonValues = { localBindings: initial.deviceSettings }
  const layer = { layerId: 'root-one', settings: { get: () => values }, deviceSettings: { get: () => device } } as unknown as CanvasLayerApi
  const inspector = createPanelInspector(layer, client ?? {
    request: async () => { throw new Error('Unexpected native request') }, close() {},
  })
  const apply = (patch: CanvasEditorSettingsPatch | void) => {
    if (patch?.device) device = { ...device, ...patch.device }
    if (patch?.layer) values = { ...values, ...patch.layer }
  }
  const current = () => JSON.parse(readCollection(values.collection, device.localBindings, layer.layerId))
  return { inspector, id: b.id, apply, current, values: () => values, device: () => device }
}

test('native properties round-trip existing data and keep private references on the device', () => {
  const f = fixture()
  const controls = f.inspector.get(f.id)
  assert.equal(controls.values.target, 'C:\\Apps\\Example.exe')
  assert.equal(controls.settings.find(field => field.id === 'arguments')?.scope, 'device')
  f.apply(f.inspector.change(f.id, { label: 'New shortcut', shape: 'ellipse',
    color: '#abcdef', position: { x: 150, y: 160 }, size: { x: 220, y: 120 } }))
  const b = f.current().buttons[0]
  assert.deepEqual([b.label, b.shape, b.color, b.x, b.y, b.width, b.height],
    ['New shortcut', 'ellipse', '#abcdef', 150, 160, 220, 120])
  assert.equal(b.arguments, '--profile private')
  assert.equal(b.media.path, 'C:\\Pictures\\tile.png')
  assert.equal(String(f.values().collection).includes('C:\\\\'), false)
  f.apply(f.inspector.change(f.id, { target: 'https://example.com', arguments: '' }))
  assert.equal(JSON.parse(String(f.values().collection)).buttons[0].target, 'https://example.com')
  assert.equal(f.inspector.get(f.id).settings.find(field => field.id === 'target')?.scope, 'layer')
  assert.equal(JSON.parse(String(f.device().localBindings)).layers['root-one'][f.id].target, undefined)
})

test('duplicate and delete preserve private bindings without changing other roots', async () => {
  const f = fixture()
  const backup = f.device().localBindings
  f.apply(await f.inspector.action!(f.id, 'duplicate'))
  const copy = f.current().buttons[1]
  assert.notEqual(copy.id, f.id)
  assert.equal(copy.target, 'C:\\Apps\\Example.exe')
  assert.equal(copy.arguments, '--profile private')
  assert.equal(copy.media.path, 'C:\\Pictures\\tile.png')
  f.apply(await f.inspector.action!(copy.id, 'delete'))
  assert.equal(f.current().buttons.length, 1)
  assert.equal(f.device().localBindings, backup)
  f.apply(await f.inspector.action!(f.id, 'delete'))
  assert.equal(f.current().buttons.length, 0)
  assert.equal(JSON.parse(String(f.device().localBindings)).layers['root-one'], undefined)
  assert.deepEqual(JSON.parse(String(f.device().localBindings)).layers['root-other'], {
    other: { target: 'C:\\Apps\\Other.exe', arguments: '--other' },
  })
  assert.ok(f.inspector.get(null).settings.some(field => field.id === 'add'))
})

test('desktop import is explicit, de-duplicates targets and splits local paths', async () => {
  let nativeCalls = 0
  const f = fixture({
    async request(action) {
      nativeCalls++
      assert.equal(action, 'desktopEntries')
      return [{ target: 'C:\\Apps\\Example.exe', label: 'Already added', kind: 'file' },
        { target: 'C:\\Users\\Test\\Desktop\\Folder', label: 'Folder', kind: 'folder' }] as never
    },
    close() {},
  })
  await f.inspector.action!(null, 'desktop')
  assert.equal(f.current().buttons.length, 1)
  assert.ok(f.inspector.get(null).settings.some(field => field.id === 'desktopSelection' && field.multiple))
  await f.inspector.action!(null, 'selectAll')
  f.apply(await f.inspector.action!(null, 'importSelected'))
  assert.equal(nativeCalls, 1)
  assert.equal(f.current().buttons.length, 2)
  assert.equal(f.current().buttons[1].icon, 'folder')
  assert.equal(f.inspector.get(null).settings.some(field => field.id === 'desktopSelection'), false)
  assert.equal(String(f.values().collection).includes('C:\\\\Users'), false)
})

test('one batch updates panel settings and preserves the layout', () => {
  const f = fixture()
  const before = f.values().collection
  const patch = f.inspector.change(null, { opacity: .45, language: 'fr' })
  assert.deepEqual(patch, { layer: { opacity: .45, language: 'fr' } })
  f.apply(patch)
  assert.equal(f.values().collection, before)
  assert.equal(f.inspector.get(null).values.opacity, .45)
})

test('native JSON import requires confirmation and export explicitly includes local references', async () => {
  const source = emptyCollection()
  const b = newButton(0)
  b.label = 'Imported shortcut'
  b.target = 'C:\\Local\\App.exe'
  b.arguments = '--private'
  source.buttons.push(b)
  let selected: string | null = JSON.stringify(source)
  let exported: unknown
  const f = fixture({
    async request(action, input) {
      if (action === 'importConfiguration') return selected as never
      assert.equal(action, 'exportConfiguration')
      exported = JSON.parse(input!.configuration as string)
      return null as never
    }, close() {},
  })
  await f.inspector.action!(null, 'jsonImport')
  assert.notEqual(f.current().buttons[0].label, b.label)
  assert.ok(f.inspector.get(null).settings.some(field => field.id === 'confirmImport'))
  f.apply(await f.inspector.action!(null, 'confirmImport'))
  assert.equal(f.current().buttons[0].label, b.label)
  assert.equal(String(f.values().collection).includes('C:\\\\Local'), false)
  assert.equal(f.current().buttons[0].target, b.target)
  await f.inspector.action!(null, 'export')
  assert.deepEqual(exported, f.current())
  selected = null
  await f.inspector.action!(null, 'jsonImport')
  assert.equal(f.inspector.get(null).settings.some(field => field.id === 'confirmImport'), false)
  selected = '{"version":2}'
  await assert.rejects(f.inspector.action!(null, 'jsonImport'))
  assert.equal(f.current().buttons[0].target, b.target)
})

test('a native action waits for SDK attachment instead of rejecting its initial availability snapshot', async () => {
  let connected = 0
  let onMessage: (message: Record<string, unknown>) => void = () => {}
  const layer = { native: { companion: { available: false, async connect() {
    connected++
    await Promise.resolve()
    return {
      onMessage(listener: typeof onMessage) { onMessage = listener; return () => {} },
      onStateChange() { return () => {} }, close() {},
      async send(message: Record<string, unknown>) {
        onMessage({ kind: 'panels.result', requestId: message.requestId, ok: true, result: null })
      },
    }
  } } } } as unknown as CanvasLayerApi
  const client = nativeClient(layer)
  assert.equal(await client.request('importConfiguration'), null)
  assert.equal(connected, 1)
  client.close()
})
