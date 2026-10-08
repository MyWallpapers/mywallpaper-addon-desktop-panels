import type {
  AddonValues, CanvasLayerApi, CanvasEditorInspectorAdapter, CanvasEditorSettingsPatch,
  SettingDefinition,
} from '../generated/mywallpaper-runtime'
import { configFits, constrain, newButton, parseCollection, type Client, type Collection, type PanelButton, type TargetEntry } from './model'
import { readCollection, splitCollection } from './storage'
import { translate } from './text'

export function createPanelInspector(layer: CanvasLayerApi, client: Client): CanvasEditorInspectorAdapter {
  let desktopEntries: TargetEntry[] = []
  let desktopSelection: string[] = []
  let imported: Collection | undefined
  const t = (text: string) => translate(text, layer.settings.get().language === 'fr'
    || layer.settings.get().language !== 'en' && navigator.language.startsWith('fr'))
  const collection = () => parseCollection(readCollection(layer.settings.get().collection,
    layer.deviceSettings.get().localBindings, layer.layerId))
  const button = (c: Collection, id: string) => {
    const found = c.buttons.find(item => item.id === id)
    if (!found) throw new Error('This button is no longer available.')
    return found
  }
  const field = (id: string, type: SettingDefinition['type'], label: string,
    rest: Partial<SettingDefinition> = {}): SettingDefinition => ({ id, type, label: t(label), ...rest })
  const action = (id: string, label: string): SettingDefinition =>
    field(id, 'button', label, { buttonLabel: t(label) })
  const section = (id: string, label: string, collapsed = false): SettingDefinition =>
    field(id, 'section', label, { defaultCollapsed: collapsed })
  const select = (id: string, label: string, options: [string, string][], value: string, parent?: string): SettingDefinition =>
    field(id, 'select', label, { default: value, parent,
      options: options.map(([value, text]) => ({ value, label: t(text) })) })
  const localScope = (value: string, media = false): 'layer' | 'device' => {
    try {
      const url = new URL(value)
      return !url.username && !url.password && (media ? url.protocol === 'https:'
        : ['https:', 'http:', 'mailto:'].includes(url.protocol)) ? 'layer' : 'device'
    } catch { return 'device' }
  }
  const patch = (c: Collection): CanvasEditorSettingsPatch => {
    const split = splitCollection(c, layer.deviceSettings.get().localBindings, layer.layerId)
    const layout = JSON.stringify(split.portable)
    const next: CanvasEditorSettingsPatch = {}
    if (layout !== layer.settings.get().collection) next.layer = { collection: layout }
    if (split.deviceSettings !== (layer.deviceSettings.get().localBindings ?? '{"version":1,"layers":{}}')) {
      next.device = { localBindings: split.deviceSettings }
    }
    return next
  }
  const append = (c: Collection, target?: TargetEntry) => {
    if (c.buttons.length >= 1024) throw new Error(t('La limite de 1024 boutons est atteinte.'))
    const b = newButton(c.buttons.length)
    if (target) { b.label = target.label; b.target = target.target; b.icon = target.kind === 'folder' ? 'folder' : 'app' }
    constrain(b, c); c.buttons.push(b)
  }

  return {
    get(targetId) {
      const c = collection()
      if (targetId === null) {
        const settings: SettingDefinition[] = [
          action('add', 'Ajouter un bouton'), action('desktop', 'Importer du bureau'),
          section('surface', 'Surface', true),
          field('opacity', 'range', 'Opacité', { parent: 'surface', min: .1, max: 1, step: .05, default: .7 }),
          select('language', 'Langue', [['auto', 'Automatique'], ['fr', 'Français'], ['en', 'English']], 'auto', 'surface'),
          { ...section('configuration', 'Configuration', true),
            description: t('Les chemins locaux restent sur cet appareil. Une sauvegarde JSON inclut ces chemins, sans les fichiers médias.') },
          { ...action('jsonImport', 'Importer un fichier'), parent: 'configuration' },
          { ...action('export', 'Exporter'), parent: 'configuration' },
        ]
        const values: AddonValues = { opacity: layer.settings.get().opacity ?? .7, language: layer.settings.get().language ?? 'auto' }
        if (desktopEntries.length) {
          settings.unshift(
            { ...section('desktopChoices', 'Choisir les raccourcis'), description: t('Les fichiers d’origine restent intacts.') },
            field('desktopSelection', 'select', 'Choisir les raccourcis', { parent: 'desktopChoices', default: [],
              multiple: true, maxItems: Math.max(1, 1024 - c.buttons.length),
              options: desktopEntries.map((entry, index) => ({ value: String(index),
                label: entry.label.replace(/[\p{C}]/gu, ' ').slice(0, 120) || 'Shortcut' })) }),
            { ...action('selectAll', 'Tout sélectionner'), parent: 'desktopChoices' },
            { ...action('importSelected', 'Importer la sélection'), parent: 'desktopChoices' },
            { ...action('cancelDesktop', 'Annuler l’import'), parent: 'desktopChoices' },
          )
          values.desktopSelection = desktopSelection
        }
        if (imported) settings.unshift(
          { ...section('importConfirmation', imported.buttons.length + ' ' + t('Boutons')),
            description: t('La disposition actuelle sera remplacée. Les chemins locaux du fichier restent sur cet appareil.') },
          { ...action('confirmImport', 'Confirmer le remplacement'), parent: 'importConfirmation' },
          { ...action('cancelImport', 'Annuler l’import'), parent: 'importConfirmation' },
        )
        return { settings, values }
      }
      const b = button(c, targetId)
      const settings: SettingDefinition[] = [
        field('label', 'string', 'Nom', { default: '' }),
        field('showLabel', 'boolean', 'Afficher le nom', { default: true }),
        section('appearance', 'Apparence'),
        select('shape', 'Forme', [['rectangle', 'Rectangle'], ['ellipse', 'Ellipse'], ['triangle', 'Triangle'], ['hexagon', 'Hexagone']], 'rectangle', 'appearance'),
        field('radius', 'range', 'Arrondi', { parent: 'appearance', min: 0, max: 128, step: 1, default: 20, showIf: { setting: 'shape', equals: 'rectangle' } }),
        field('color', 'color', 'Couleur', { parent: 'appearance', default: '#98bce8' }),
        select('icon', 'Icône', [['app', 'Application'], ['folder', 'Dossier'], ['file', 'Fichier'], ['link', 'Lien'], ['music', 'Musique'], ['image', 'Image']], 'app', 'appearance'),
        section('action', 'Action', true),
        field('target', 'string', 'Chemin ou lien', { parent: 'action', default: '', scope: localScope(b.target),
          description: t('Les chemins Windows restent locaux ; les liens HTTP(S) et mailto suivent la disposition.') }),
        field('arguments', 'string', 'Arguments', { parent: 'action', default: '', scope: 'device' }),
        section('media', 'Média', true),
        select('mediaKind', 'Type', [['none', 'Aucun'], ['image', 'Image'], ['video', 'Vidéo']], 'none', 'media'),
        ...(b.media.kind === 'none' ? [] : [
          field('mediaPath', 'string', 'Chemin ou lien HTTPS', { parent: 'media', default: '', scope: localScope(b.media.path, true) }),
          action('pickMedia', 'Choisir un média'),
        ]),
        field('hoverOnly', 'boolean', 'Vidéo au survol uniquement', { parent: 'media', default: true, showIf: { setting: 'mediaKind', equals: 'video' } }),
        section('geometry', 'Dimensions et position', true),
        field('position', 'vector2', 'Position', { parent: 'geometry', default: { x: 0, y: 0 }, axisLabels: ['X', 'Y'] }),
        field('size', 'vector2', 'Dimensions', { parent: 'geometry', default: { x: 200, y: 144 }, axisLabels: [t('Largeur'), t('Hauteur')] }),
        action('pickFile', 'Choisir un fichier ou une application'), action('pickFolder', 'Choisir un dossier'),
        action('launch', 'Tester le raccourci'), action('duplicate', 'Dupliquer'), action('delete', 'Supprimer'),
      ]
      const values: AddonValues = { label: b.label, showLabel: b.showLabel, shape: b.shape, radius: b.radius,
        color: b.color, icon: b.icon, target: b.target, arguments: b.arguments, mediaKind: b.media.kind,
        hoverOnly: b.media.hoverOnly, position: { x: b.x, y: b.y }, size: { x: b.width, y: b.height } }
      if (b.media.kind !== 'none') values.mediaPath = b.media.path
      return { settings, values }
    },
    change(targetId, values) {
      if (targetId === null) {
        if (Array.isArray(values.desktopSelection)) desktopSelection = values.desktopSelection as string[]
        const settings: AddonValues = {}
        for (const key of ['opacity', 'language']) if (values[key] !== undefined) settings[key] = values[key]!
        return Object.keys(settings).length ? { layer: settings } : undefined
      }
      const c = collection(), b = button(c, targetId)
      for (const [key, value] of Object.entries(values)) {
        if (key === 'mediaKind') b.media.kind = value as PanelButton['media']['kind']
        else if (key === 'mediaPath') b.media.path = (value as string).trim()
        else if (key === 'hoverOnly') b.media.hoverOnly = value as boolean
        else if (key === 'position' || key === 'size') {
          const v = value as { x: number; y: number }
          if (key === 'position') { b.x = v.x; b.y = v.y }
          else { b.width = v.x; b.height = v.y }
        } else (b as unknown as Record<string, unknown>)[key] = value
      }
      constrain(b, c)
      return patch(c)
    },
    async action(targetId, actionId) {
      let c = collection()
      if (targetId === null) {
        if (actionId === 'add') { append(c); return patch(c) }
        if (actionId === 'desktop') {
          desktopEntries = await client.request<TargetEntry[]>('desktopEntries')
          desktopSelection = []
          if (!desktopEntries.length) throw new Error(t('Aucun raccourci trouvé sur le bureau.'))
        } else if (actionId === 'selectAll') {
          desktopSelection = desktopEntries.map((_, index) => String(index)).slice(0, Math.max(0, 1024 - c.buttons.length))
        } else if (actionId === 'cancelDesktop') { desktopEntries = []; desktopSelection = [] }
        else if (actionId === 'importSelected') {
          for (const index of desktopSelection) {
            const entry = desktopEntries[Number(index)]
            if (entry && !c.buttons.some(b => b.target === entry.target)) append(c, entry)
          }
          desktopEntries = []; desktopSelection = []
          return patch(c)
        } else if (actionId === 'export') {
          const readable = JSON.stringify(c, null, 2)
          const configuration = configFits(readable) ? readable : JSON.stringify(c)
          if (!configFits(configuration)) throw new Error(t('La configuration est trop volumineuse.'))
          await client.request('exportConfiguration', { configuration })
        } else if (actionId === 'jsonImport') {
          // Native dialogs do not depend on a click crossing the add-on frame.
          const value = await client.request<string | null>('importConfiguration')
          if (value === null) return
          imported = parseCollection(value)
        } else if (actionId === 'cancelImport') imported = undefined
        else if (actionId === 'confirmImport' && imported) {
          c = imported; imported = undefined; return patch(c)
        }
        return
      }
      const b = button(c, targetId)
      if (actionId === 'duplicate') {
        if (c.buttons.length >= 1024) throw new Error(t('La limite de 1024 boutons est atteinte.'))
        const copy = structuredClone(b); copy.id = crypto.randomUUID(); copy.x += 24; copy.y += 24
        constrain(copy, c); c.buttons.push(copy)
      } else if (actionId === 'delete') c.buttons = c.buttons.filter(item => item.id !== targetId)
      else if (actionId === 'launch') {
        if (!b.target.trim()) throw new Error(t('Choisissez d’abord une cible.'))
        await client.request('open', { target: b.target, arguments: b.arguments }); return
      } else if (actionId === 'pickFile' || actionId === 'pickFolder') {
        const result = await client.request<{ target: string; label: string } | null>('pickTarget', { kind: actionId === 'pickFolder' ? 'folder' : 'file' })
        if (!result) return
        c = collection(); const latest = button(c, targetId)
        latest.target = result.target
        if (!latest.label || /^Button \d+$/.test(latest.label)) latest.label = result.label
        latest.icon = actionId === 'pickFolder' ? 'folder' : 'app'
      } else if (actionId === 'pickMedia') {
        const result = await client.request<{ path: string } | null>('pickMedia', { kind: b.media.kind })
        if (!result) return
        c = collection(); button(c, targetId).media.path = result.path
      }
      return patch(c)
    },
  }
}
