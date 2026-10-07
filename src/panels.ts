import type { AddonValues } from '../generated/mywallpaper-runtime'
import { icon } from './icons'
import { MAX_CONFIG_BYTES, clamp, constrain, emptyCollection, newButton, parseCollection, type Client, type Collection, type PanelButton, type TargetEntry } from './model'

interface Options { settings: AddonValues; collection: unknown; save(c: Collection): Promise<void>; thumbnail?: boolean }
const en: Record<string, string> = {
  'Modifier': 'Edit', 'Terminer': 'Done', 'Annuler': 'Cancel', 'Ajouter': 'Add', 'Importer du bureau': 'Import desktop shortcuts',
  'Boutons': 'Buttons', 'Votre bureau, à votre façon.': 'Your desktop, your way.', 'Ajouter un bouton': 'Add a button',
  'Créez votre premier raccourci.': 'Create your first shortcut.', 'Choisissez une forme, un visuel et une action.': 'Choose a shape, a visual and an action.',
  'Sélectionnez un bouton pour le modifier.': 'Select a button to edit it.', 'Nom': 'Name', 'Afficher le nom': 'Show label',
  'Action': 'Action', 'Fichier ou application': 'File or application', 'Dossier': 'Folder', 'Chemin Windows ou lien HTTPS': 'Windows path or HTTPS link',
  'Arguments de l’application': 'Application arguments', 'Arguments': 'Arguments', 'Forme': 'Shape', 'Rectangle': 'Rectangle',
  'Ellipse': 'Ellipse', 'Triangle': 'Triangle', 'Hexagone': 'Hexagon', 'Arrondi': 'Corner radius', 'Couleur': 'Color', 'Icône': 'Icon',
  'Application': 'Application', 'Fichier': 'File', 'Lien': 'Link', 'Musique': 'Music', 'Image': 'Image', 'Visuel': 'Visual',
  'Aucun': 'None', 'Vidéo': 'Video', 'Choisir un média': 'Choose media', 'Lien HTTPS du média': 'HTTPS media link',
  'Vidéo au survol uniquement': 'Play video only on hover', 'Dimensions et position': 'Size and position', 'Largeur': 'Width', 'Hauteur': 'Height',
  'Dupliquer': 'Duplicate', 'Supprimer': 'Delete', 'Importer un fichier': 'Import a file',
  'Exporter': 'Export', 'Configuration': 'Configuration',
  'La disposition suit le wallpaper. Les chemins locaux restent sur ce PC.': 'The layout follows the wallpaper. Local paths stay on this PC.',
  'Disposition enregistrée.': 'Layout saved.', 'Un nom est nécessaire.': 'Enter a label.', 'Choisissez d’abord une cible.': 'Choose a target first.',
  'Fermer': 'Close', 'Choisir les raccourcis': 'Choose shortcuts', 'Les fichiers d’origine restent intacts.': 'Original files remain unchanged.',
  'Tout sélectionner': 'Select all', 'Aucun raccourci trouvé sur le bureau.': 'No desktop shortcuts found.',
  'Lancer ce bouton': 'Launch this button', 'Modifications non enregistrées': 'Unsaved changes',
  'Abandonner les modifications ?': 'Discard unsaved changes?', 'Impossible d’enregistrer. Réessayez.': 'Could not save. Try again.',
  'Impossible de charger la configuration.': 'Could not load configuration.', 'Déplacer': 'Move', 'Redimensionner': 'Resize',
  'Enregistrement…': 'Saving…', 'Chargement…': 'Loading…', 'Choisissez un bouton dans la liste ou sur le canvas.': 'Choose a button in the list or on the canvas.',
  'La configuration est trop volumineuse.': 'The configuration is too large.',
}
const h = (value: unknown): string => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export function createPanels(root: HTMLElement, client: Client, options: Options) {
  let settings = options.settings
  let saved = emptyCollection()
  let draft: Collection | undefined
  let selected: string | undefined
  let editing = false
  let dirty = false
  let busy = false
  let disposed = false
  let revision = 0
  let loadError = false
  let scale = 1
  let stage: HTMLElement | undefined
  let viewport: HTMLElement | undefined
  let activeVideo: HTMLVideoElement | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  const blobs = new Map<string, { path: string; bytes: number; promise: Promise<string> }>()
  let mediaBytes = 0
  const objectUrls = new Set<string>()
  const videos = new Set<HTMLVideoElement>()
  const autoplay = new Map<HTMLVideoElement, () => void>()
  let observer: IntersectionObserver | undefined
  let dialog: HTMLDialogElement | undefined
  let resize: ResizeObserver | undefined
  const host = document.createElement('div')
  host.className = 'dp-app'
  root.append(host)
  const toast = document.createElement('div')
  toast.className = 'dp-toast'; toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite')
  host.append(toast)
  const body = document.createElement('div'); body.className = 'dp-body'; host.prepend(body)
  const french = () => settings.language === 'fr' || (settings.language !== 'en' && navigator.language.startsWith('fr'))
  const t = (s: string): string => french() ? s : (en[s] ?? s)
  const current = () => draft ?? saved
  const buttonHtml = (name: string, label: string, action: string, cls = '', disabled = false): string =>
    '<button type="button" class="dp-control ' + cls + '" data-action="' + action + '"' + (disabled ? ' disabled' : '') + '>' + icon(name) + '<span>' + h(t(label)) + '</span></button>'
  const selectedButton = () => current().buttons.find(b => b.id === selected)
  function notice(message: string) {
    if (disposed) return
    toast.textContent = message; toast.classList.add('is-visible')
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 5500)
  }
  function read(value: unknown) {
    try { saved = value === undefined ? emptyCollection() : parseCollection(value); loadError = false }
    catch { loadError = true; notice(t('Impossible de charger la configuration.')); return false }
    return true
  }
  read(options.collection)
  const setDirty = () => { dirty = true }

  async function mediaUrl(path: string, kind: string): Promise<string> {
    if (/^https:\/\//i.test(path)) {
      const u = new URL(path); if (u.username || u.password) throw new Error('Media URLs cannot contain credentials.')
      return u.href
    }
    // Built-in, licensed thumbnail/preview artwork is the only bundled URL accepted here.
    if (options.thumbnail || path.startsWith('/assets/') || path.includes('/assets/demo-cover')) return path
    const key = kind + ':' + path
    let cached = blobs.get(key)
    if (cached) { blobs.delete(key); blobs.set(key, cached); return cached.promise }
    const entry = { path, bytes: 0, promise: Promise.resolve('') }
    entry.promise = (async () => {
        const info = await client.request<{ size: number; mime: string }>('mediaInfo', { path })
        const limit = kind === 'video' ? 64 * 1024 * 1024 : 12 * 1024 * 1024
        if (!Number.isInteger(info.size) || info.size < 1 || info.size > limit || !(kind === 'video' ? info.mime.startsWith('video/') : info.mime.startsWith('image/'))) throw new Error('Unsupported or oversized media.')
        if (disposed || blobs.get(key) !== entry) throw new Error('Media no longer used.')
        entry.bytes = info.size; mediaBytes += info.size
        for (const [oldKey, old] of blobs) {
          if (mediaBytes <= 96 * 1024 * 1024 && blobs.size <= 48) break
          if (oldKey !== key) evictMedia(oldKey, old)
        }
        if (mediaBytes > 96 * 1024 * 1024) throw new Error('Too many media are loading. Try again shortly.')
        const chunks: Uint8Array<ArrayBuffer>[] = []
        for (let offset = 0; offset < info.size;) {
          if (disposed || blobs.get(key) !== entry || !current().buttons.some(b => b.media.path === path)) throw new Error('Media no longer used.')
          const chunk = await client.request<{ data: string; eof: boolean }>('mediaChunk', { path, offset })
          const binary = atob(chunk.data)
          if (!binary.length || binary.length > 256 * 1024 || offset + binary.length > info.size) throw new Error('Invalid media chunk.')
          const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          chunks.push(bytes); offset += bytes.length
          if (chunk.eof && offset !== info.size) throw new Error('Media file changed. Choose it again.')
        }
        if (disposed || !blobs.has(key)) throw new Error('Media no longer used.')
        const url = URL.createObjectURL(new Blob(chunks, { type: info.mime })); objectUrls.add(url)
        return url
      })().catch(e => { if (blobs.get(key) === entry) { blobs.delete(key); mediaBytes -= entry.bytes }; throw e })
    blobs.set(key, entry)
    return entry.promise
  }
  function evictMedia(key: string, entry: { bytes: number; promise: Promise<string> }) {
    blobs.delete(key); mediaBytes -= entry.bytes
    void entry.promise.then(url => { URL.revokeObjectURL(url); objectUrls.delete(url) }).catch(() => {})
  }
  function releaseUnusedMedia() {
    const used = new Set(current().buttons.filter(b => b.media.kind !== 'none').map(b => b.media.path))
    for (const [key, entry] of blobs) if (!used.has(entry.path)) evictMedia(key, entry)
  }
  function geometry(el: HTMLElement, b: PanelButton) {
    el.style.left = b.x + 'px'; el.style.top = b.y + 'px'; el.style.width = b.width + 'px'; el.style.height = b.height + 'px'
    el.style.setProperty('--button-color', b.color); el.style.setProperty('--button-radius', b.radius + 'px')
    el.classList.toggle('is-compact', b.height < 100)
    el.classList.toggle('is-tiny', b.width < 72 && b.showLabel)
    el.style.setProperty('--button-padding', Math.min(24, b.width * .12, b.height * .16) + 'px')
    el.dataset.shape = b.shape
    const outline = el.querySelector<SVGElement>('.dp-shape-outline')
    if (outline) {
      outline.setAttribute('viewBox', '0 0 ' + b.width + ' ' + b.height)
      outline.querySelector('polygon')!.setAttribute('points', b.shape === 'triangle'
        ? (b.width / 2) + ',2 ' + (b.width - 2) + ',' + (b.height - 2) + ' 2,' + (b.height - 2)
        : (b.width / 4) + ',2 ' + (b.width * .75) + ',2 ' + (b.width - 2) + ',' + (b.height / 2) + ' ' + (b.width * .75) + ',' + (b.height - 2) + ' ' + (b.width / 4) + ',' + (b.height - 2) + ' 2,' + (b.height / 2))
    }
  }
  function fit() {
    if (!viewport || !stage) return
    const c = current(), rect = viewport.getBoundingClientRect()
    scale = Math.min(rect.width / c.width, rect.height / c.height)
    stage.style.width = c.width + 'px'; stage.style.height = c.height + 'px'
    stage.style.transform = 'translate(-50%, -50%) scale(' + scale + ')'
  }
  function stopVideos() {
    videos.forEach(v => { v.pause(); v.removeAttribute('src'); v.load() }); videos.clear(); autoplay.clear(); activeVideo = undefined
  }
  function render() {
    revision++; stopVideos(); observer?.disconnect(); resize?.disconnect()
    host.classList.toggle('is-editing', editing)
    host.classList.toggle('is-thumbnail', !!options.thumbnail)
    host.style.setProperty('--surface-opacity', String(typeof settings.opacity === 'number' ? settings.opacity : 0.7))
    host.setAttribute('lang', french() ? 'fr' : 'en')
    const c = current()
    body.innerHTML = (editing ? '<header class="dp-editor-header"><div class="dp-editor-title">Desktop Panels <span>' + h(t('Boutons')) + '</span></div><div class="dp-toolbar">' + buttonHtml('plus', 'Ajouter', 'add') + buttonHtml('import', 'Importer du bureau', 'desktop', 'dp-import-desktop') + '</div><div class="dp-editor-finish">' + buttonHtml('close', 'Annuler', 'cancel', '', busy) + buttonHtml('check', busy ? 'Enregistrement…' : 'Terminer', 'done', 'dp-primary', busy) + '</div></header><div class="dp-workspace"><aside class="dp-list"><div class="dp-list-heading">' + h(t('Boutons')) + '</div><div class="dp-list-items">' + c.buttons.map(b => '<button class="dp-list-row' + (b.id === selected ? ' is-selected' : '') + '" data-select="' + h(b.id) + '" aria-pressed="' + String(b.id === selected) + '">' + icon(b.icon) + '<span>' + h(b.label) + '</span></button>').join('') + '</div><details class="dp-local"><summary>' + h(t('Configuration')) + '</summary>' + buttonHtml('import', 'Importer un fichier', 'jsonImport') + buttonHtml('export', 'Exporter', 'export') + '<p>' + h(t('La disposition suit le wallpaper. Les chemins locaux restent sur ce PC.')) + '</p></details></aside><div class="dp-canvas-column"><div class="dp-canvas-label"><span>' + h(t('Votre bureau, à votre façon.')) + '</span><span>' + c.width + ' × ' + c.height + '</span></div><div class="dp-viewport"><div class="dp-stage"></div></div></div><aside class="dp-inspector"></aside></div>' : '<div class="dp-viewport"><div class="dp-stage"></div></div>' + (!options.thumbnail && c.buttons.length === 0 ? '<div class="dp-empty"><div>' + icon('app') + '</div><h2>' + h(t('Créez votre premier raccourci.')) + '</h2><p>' + h(t('Choisissez une forme, un visuel et une action.')) + '</p>' + buttonHtml('plus', 'Ajouter un bouton', 'edit') + '</div>' : ''))
    viewport = body.querySelector('.dp-viewport') as HTMLElement
    stage = body.querySelector('.dp-stage') as HTMLElement
    resize = new ResizeObserver(fit); resize.observe(viewport); fit()
    observer = new IntersectionObserver(entries => entries.forEach(entry => {
      const el = entry.target as HTMLElement
      const load = loaders.get(el)
      if (el instanceof HTMLVideoElement) el.dataset.visible = String(entry.isIntersecting)
      if (entry.isIntersecting) { load?.(); if (el.tagName !== 'VIDEO') observer?.unobserve(el) }
      else if (el instanceof HTMLVideoElement) el.pause()
    }), { root: viewport, rootMargin: '80px' })
    const loaders = new Map<Element, () => void>()
    for (const b of c.buttons) {
      const el = document.createElement('button'); el.type = 'button'; el.className = 'dp-panel'
      el.dataset.id = b.id; el.setAttribute('aria-label', b.label || t('Lancer ce bouton')); el.title = b.label
      geometry(el, b)
      const media = document.createElement('span'); media.className = 'dp-panel-media'; el.append(media)
      const foreground = document.createElement('span'); foreground.className = 'dp-panel-content'
      foreground.innerHTML = icon(b.icon) + (b.showLabel ? '<span>' + h(b.label) + '</span>' : '')
      el.append(foreground); stage.append(el)
      if (b.shape === 'triangle' || b.shape === 'hexagon') {
        el.insertAdjacentHTML('beforeend', '<svg class="dp-shape-outline" preserveAspectRatio="none" aria-hidden="true"><polygon fill="none" vector-effect="non-scaling-stroke"/></svg>')
        geometry(el, b)
      }
      const mediaRevision = revision
      if (b.media.kind === 'image' && b.media.path) {
          const img = document.createElement('img'); img.alt = ''; img.decoding = 'async'; img.referrerPolicy = 'no-referrer'; media.append(img)
        loaders.set(img, () => { void mediaUrl(b.media.path, 'image').then(url => { if (!disposed && revision === mediaRevision) img.src = url }).catch(() => { if (revision === mediaRevision) el.classList.add('has-media-error') }) })
        observer.observe(img)
      } else if (b.media.kind === 'video' && b.media.path) {
        const v = document.createElement('video'); v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'none'; v.setAttribute('aria-hidden', 'true'); videos.add(v); media.append(v)
        let loading: Promise<void> | undefined
        const play = async () => {
          if (b.media.hoverOnly) { activeVideo?.pause(); activeVideo = v }
          loading ??= mediaUrl(b.media.path, 'video').then(url => { if (!disposed && revision === mediaRevision) v.src = url }).catch(error => { loading = undefined; throw error })
          try {
            await loading
            if (!disposed && revision === mediaRevision && (!b.media.hoverOnly || (activeVideo === v && el.matches(':hover, :focus-visible'))) && document.visibilityState === 'visible') await v.play()
          } catch { if (revision === mediaRevision) el.classList.add('has-media-error') }
        }
        if (b.media.hoverOnly) {
          el.addEventListener('mouseenter', () => void play()); el.addEventListener('focus', () => void play())
          el.addEventListener('mouseleave', () => v.pause()); el.addEventListener('blur', () => v.pause())
        } else { const resume = () => void play(); autoplay.set(v, resume); loaders.set(v, resume); observer.observe(v) }
      }
      el.addEventListener('click', () => editing ? select(b.id) : void launch(b))
      if (editing) {
        el.classList.toggle('is-selected', b.id === selected)
        el.addEventListener('pointerdown', event => drag(event, b, el, false))
        el.addEventListener('keydown', event => {
          if (!event.key.startsWith('Arrow')) return
          event.preventDefault(); const step = event.shiftKey ? 10 : 1
          if (event.key === 'ArrowLeft') b.x -= step
          if (event.key === 'ArrowRight') b.x += step
          if (event.key === 'ArrowUp') b.y -= step
          if (event.key === 'ArrowDown') b.y += step
          constrain(b, c); geometry(el, b); setDirty(); updateGeometryInputs()
        })
        if (b.id === selected) {
          const handle = document.createElement('span'); handle.className = 'dp-resize-handle'; handle.title = t('Redimensionner'); handle.setAttribute('aria-hidden', 'true')
          handle.addEventListener('pointerdown', event => { event.stopPropagation(); drag(event, b, el, true) }); el.append(handle)
        }
      }
    }
    body.querySelectorAll<HTMLElement>('[data-select]').forEach(el => el.addEventListener('click', () => select(el.dataset.select!)))
    body.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(el => el.addEventListener('click', () => void action(el.dataset.action!)))
    inspector()
    releaseUnusedMedia()
  }
  function select(id: string) {
    if (!editing || selected === id) return
    selected = id; render()
  }
  function drag(event: PointerEvent, b: PanelButton, el: HTMLElement, resizing: boolean) {
    if (event.button !== 0 || busy) return
    event.preventDefault()
    if (selected !== b.id) { selected = b.id; inspector(); body.querySelectorAll('[data-select]').forEach(row => row.classList.toggle('is-selected', (row as HTMLElement).dataset.select === b.id)); body.querySelectorAll('.dp-panel').forEach(panel => panel.classList.toggle('is-selected', (panel as HTMLElement).dataset.id === b.id)) }
    const start = { x: event.clientX, y: event.clientY, bx: b.x, by: b.y, width: b.width, height: b.height }
    const pointerScale = scale || 1
    el.setPointerCapture(event.pointerId)
    const move = (e: PointerEvent) => {
      const dx = (e.clientX - start.x) / pointerScale, dy = (e.clientY - start.y) / pointerScale
      if (resizing) { b.width = start.width + dx; b.height = start.height + dy }
      else { b.x = start.bx + dx; b.y = start.by + dy }
      constrain(b, current()); geometry(el, b); setDirty(); updateGeometryInputs()
    }
    const end = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); render() }
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end)
  }
  function updateGeometryInputs() {
    const b = selectedButton(); if (!b) return
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      const input = body.querySelector<HTMLInputElement>('[data-field="' + key + '"]'); if (input && document.activeElement !== input) input.value = String(b[key])
    }
  }
  function inspector() {
    const aside = body.querySelector('.dp-inspector'); if (!aside) return
    const b = selectedButton()
    if (!b) { aside.innerHTML = '<div class="dp-inspector-empty">' + icon('move') + '<p>' + h(t('Choisissez un bouton dans la liste ou sur le canvas.')) + '</p></div>'; return }
    const input = (key: string, label: string, value: unknown, type = 'text', extra = '') => '<label class="dp-field"><span>' + h(t(label)) + '</span><input data-field="' + key + '" type="' + type + '" value="' + h(value) + '" ' + extra + '></label>'
    const selectHtml = (key: string, label: string, value: string, choices: string[][]) => '<label class="dp-field"><span>' + h(t(label)) + '</span><select data-field="' + key + '">' + choices.map(([v, l]) => '<option value="' + v + '"' + (v === value ? ' selected' : '') + '>' + h(t(l)) + '</option>').join('') + '</select></label>'
    const check = (key: string, label: string, value: boolean) => '<label class="dp-check"><input data-field="' + key + '" type="checkbox"' + (value ? ' checked' : '') + '><span>' + h(t(label)) + '</span></label>'
    aside.innerHTML = '<div class="dp-inspector-heading">' + h(b.label) + '<div>' + buttonHtml('copy', 'Dupliquer', 'duplicate', 'dp-icon-control') + buttonHtml('trash', 'Supprimer', 'delete', 'dp-icon-control') + '</div></div>'
      + '<section>' + input('label', 'Nom', b.label, 'text', 'maxlength="120"') + check('showLabel', 'Afficher le nom', b.showLabel) + '</section>'
      + '<section><h3>' + h(t('Action')) + '</h3>' + input('target', 'Chemin Windows ou lien HTTPS', b.target) + '<div class="dp-picker-row">' + buttonHtml('file', 'Fichier ou application', 'pickFile') + buttonHtml('folder', 'Dossier', 'pickFolder') + '</div><details><summary>' + h(t('Arguments de l’application')) + '</summary>' + input('arguments', 'Arguments', b.arguments) + '</details></section>'
      + '<section><h3>' + h(t('Forme')) + '</h3>' + selectHtml('shape', 'Forme', b.shape, [['rectangle', 'Rectangle'], ['ellipse', 'Ellipse'], ['triangle', 'Triangle'], ['hexagon', 'Hexagone']])
      + '<div class="dp-pair">' + input('radius', 'Arrondi', b.radius, 'number', 'min="0" max="128" step="1"' + (b.shape !== 'rectangle' ? ' disabled' : '')) + input('color', 'Couleur', b.color, 'color') + '</div>'
      + selectHtml('icon', 'Icône', b.icon, [['app', 'Application'], ['folder', 'Dossier'], ['file', 'Fichier'], ['link', 'Lien'], ['music', 'Musique'], ['image', 'Image']]) + '</section>'
      + '<section><h3>' + h(t('Visuel')) + '</h3>' + selectHtml('mediaKind', 'Visuel', b.media.kind, [['none', 'Aucun'], ['image', 'Image'], ['video', 'Vidéo']])
      + (b.media.kind !== 'none' ? buttonHtml(b.media.kind === 'video' ? 'play' : 'image', 'Choisir un média', 'pickMedia') + input('mediaPath', 'Lien HTTPS du média', b.media.path) + (b.media.kind === 'video' ? check('hoverOnly', 'Vidéo au survol uniquement', b.media.hoverOnly) : '') : '') + '</section>'
      + '<section><h3>' + h(t('Dimensions et position')) + '</h3><div class="dp-pair">' + input('x', 'X', b.x, 'number', 'min="0" max="' + current().width + '" step="1"') + input('y', 'Y', b.y, 'number', 'min="0" max="' + current().height + '" step="1"') + input('width', 'Largeur', b.width, 'number', 'min="32" max="' + current().width + '" step="1"') + input('height', 'Hauteur', b.height, 'number', 'min="32" max="' + current().height + '" step="1"') + '</div></section>'
    aside.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(el => el.addEventListener('click', () => void action(el.dataset.action!)))
    aside.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach(el => {
      const applyValue = () => {
      if (busy) return
      const field = el.dataset.field!
      if (field === 'showLabel' || field === 'hoverOnly') {
        if (field === 'hoverOnly') b.media.hoverOnly = (el as HTMLInputElement).checked
        else b.showLabel = (el as HTMLInputElement).checked
      } else if (['x', 'y', 'width', 'height', 'radius'].includes(field)) {
        const value = Number(el.value); if (!el.value || !Number.isFinite(value)) { el.value = String(b[field as 'x']); return }
        b[field as 'x' | 'y' | 'width' | 'height' | 'radius'] = field === 'radius' ? clamp(value, 0, 128) : value
        constrain(b, current())
      } else if (field === 'mediaKind') b.media.kind = el.value as PanelButton['media']['kind']
      else if (field === 'mediaPath') b.media.path = el.value.trim()
      else (b as unknown as Record<string, unknown>)[field] = el.value
      setDirty()
      if (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.type === 'checkbox')) render()
      else {
        const panel = [...body.querySelectorAll<HTMLElement>('.dp-panel')].find(item => item.dataset.id === b.id)
        if (panel) {
          geometry(panel, b)
          if (field === 'label') { panel.setAttribute('aria-label', b.label); panel.title = b.label; const label = panel.querySelector('.dp-panel-content > span'); if (label) label.textContent = b.label }
        }
        const row = [...body.querySelectorAll<HTMLElement>('[data-select]')].find(item => item.dataset.select === b.id)?.querySelector('span')
        if (field === 'label' && row) row.textContent = b.label
      }
      }
      el.addEventListener(el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.type === 'checkbox') ? 'change' : 'input', applyValue)
    })
  }
  async function launch(b: PanelButton) {
    if (!b.target.trim()) { notice(t('Choisissez d’abord une cible.')); return }
    try { await client.request('open', { target: b.target, arguments: b.arguments }) }
    catch (e) { notice(e instanceof Error ? e.message : String(e)) }
  }
  function edit() {
    if (options.thumbnail || editing) return
    if (loadError) { notice(t('Impossible de charger la configuration.')); return }
    draft = structuredClone(saved); editing = true; dirty = false; selected = draft.buttons[0]?.id; render()
  }
  function add(target?: TargetEntry) {
    if (!draft || draft.buttons.length >= 1024) return
    const b = newButton(draft.buttons.length)
    if (target) { b.label = target.label; b.target = target.target; b.icon = target.kind === 'folder' ? 'folder' : 'app' }
    constrain(b, draft); draft.buttons.push(b); selected = b.id; setDirty()
  }
  async function desktopImport() {
    const entries = await client.request<TargetEntry[]>('desktopEntries')
    if (disposed || !editing) return
    if (!entries.length) { notice(t('Aucun raccourci trouvé sur le bureau.')); return }
    dialog?.remove(); dialog = document.createElement('dialog'); dialog.className = 'dp-import-dialog'
    dialog.innerHTML = '<form method="dialog"><h2>' + h(t('Choisir les raccourcis')) + '</h2><p>' + h(t('Les fichiers d’origine restent intacts.')) + '</p><label class="dp-check dp-select-all"><input type="checkbox" data-all><span>' + h(t('Tout sélectionner')) + '</span></label><div class="dp-import-items">' + entries.map((entry, i) => '<label class="dp-check"><input type="checkbox" value="' + i + '" data-entry>' + icon(entry.kind === 'folder' ? 'folder' : 'file') + '<span>' + h(entry.label) + '</span></label>').join('') + '</div><div class="dp-dialog-footer"><button class="dp-control" value="cancel">' + h(t('Annuler')) + '</button><button class="dp-control dp-primary" value="import">' + h(t('Importer du bureau')) + '</button></div></form>'
    host.append(dialog)
    const thisDialog = dialog
    thisDialog.querySelector<HTMLInputElement>('[data-all]')!.addEventListener('change', e => thisDialog.querySelectorAll<HTMLInputElement>('[data-entry]').forEach(el => { el.checked = (e.target as HTMLInputElement).checked }))
    thisDialog.addEventListener('close', () => {
      if (thisDialog.returnValue === 'import' && draft) {
        thisDialog.querySelectorAll<HTMLInputElement>('[data-entry]:checked').forEach(el => { const entry = entries[Number(el.value)]; if (!draft!.buttons.some(b => b.target === entry.target)) add(entry) })
        render()
      }
      thisDialog.remove(); if (dialog === thisDialog) dialog = undefined
    }, { once: true })
    thisDialog.showModal()
  }
  async function action(name: string) {
    if (disposed || busy) return
    const b = selectedButton()
    try {
      if (name === 'edit') edit()
      else if (name === 'add') { add(); render() }
      else if (name === 'cancel') {
        if (dirty && !window.confirm(t('Abandonner les modifications ?'))) return
        editing = false; draft = undefined; dirty = false; render()
      } else if (name === 'done' && draft) {
        if (draft.buttons.some(item => !item.label.trim())) { notice(t('Un nom est nécessaire.')); return }
        const next = parseCollection(JSON.stringify(draft)); busy = true; render()
        try {
          await options.save(next); if (disposed) return
          saved = next; draft = undefined; dirty = false; editing = false; notice(t('Disposition enregistrée.'))
        } finally { busy = false; if (!disposed) render() }
      } else if (name === 'desktop') await desktopImport()
      else if (name === 'duplicate' && b && draft) {
        const copy = structuredClone(b); copy.id = crypto.randomUUID(); copy.x += 24; copy.y += 24; constrain(copy, draft)
        if (draft.buttons.length < 1024) { draft.buttons.push(copy); selected = copy.id; setDirty(); render() }
      } else if (name === 'delete' && b && draft) {
        draft.buttons = draft.buttons.filter(item => item.id !== b.id); selected = draft.buttons[0]?.id; setDirty(); render()
      } else if ((name === 'pickFile' || name === 'pickFolder') && b) {
        const result = await client.request<{ target: string; label: string } | null>('pickTarget', { kind: name === 'pickFolder' ? 'folder' : 'file' })
        if (disposed || !editing || !result) return
        b.target = result.target; if (!b.label || b.label.startsWith('Button ')) b.label = result.label
        b.icon = name === 'pickFolder' ? 'folder' : 'app'; setDirty(); render()
      } else if (name === 'pickMedia' && b) {
        const result = await client.request<{ path: string } | null>('pickMedia', { kind: b.media.kind })
        if (disposed || !editing || !result) return
        b.media.path = result.path; setDirty(); render()
      } else if (name === 'export') {
        const url = URL.createObjectURL(new Blob([JSON.stringify(current(), null, 2)], { type: 'application/json' }))
        const a = document.createElement('a'); a.href = url; a.download = 'desktop-panels.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      } else if (name === 'jsonImport' && draft) {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'
        input.addEventListener('change', () => {
          const file = input.files?.[0]; if (!file) return
          if (file.size > MAX_CONFIG_BYTES) { notice(t('La configuration est trop volumineuse.')); return }
          void file.text().then(value => { if (!disposed && editing) { draft = parseCollection(value); selected = draft.buttons[0]?.id; setDirty(); render() } }).catch(error => notice(String(error)))
        }, { once: true }); input.click()
      }
    } catch (error) { if (!disposed) notice(error instanceof Error ? error.message : String(error)) }
  }
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') videos.forEach(v => v.pause())
    else autoplay.forEach((resume, v) => { if (v.dataset.visible === 'true') resume() })
  }
  document.addEventListener('visibilitychange', onVisibility)
  render()
  return {
    edit, notice,
    exportConfiguration() { void action('export') },
    importConfiguration() { edit(); if (editing) void action('jsonImport') },
    configure(values: AddonValues) { settings = values; if (!disposed) render() },
    load(value: unknown) { if (!disposed && !editing && read(value)) render() },
    dispose() {
      disposed = true; revision++; clearTimeout(toastTimer); observer?.disconnect(); resize?.disconnect(); dialog?.remove()
      document.removeEventListener('visibilitychange', onVisibility); stopVideos()
      objectUrls.forEach(url => URL.revokeObjectURL(url)); blobs.clear(); objectUrls.clear(); host.remove()
    },
  }
}
