import type { AddonValues } from '../generated/mywallpaper-runtime'
import { icon } from './icons'
import type { PanelGeometry } from './editorTargets'
import { emptyCollection, parseCollection, type Client, type PanelButton } from './model'
import { translate } from './text'

interface Options {
  settings: AddonValues
  collection: unknown
  thumbnail?: boolean
}
const h = (value: unknown): string => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export function createPanels(root: HTMLElement, client: Client, options: Options) {
  let settings = options.settings
  let saved = emptyCollection()
  let disposed = false
  let revision = 0
  let stage: HTMLElement | undefined
  let viewport: HTMLElement | undefined
  let activeVideo: HTMLVideoElement | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  const blobs = new Map<string, { path: string; bytes: number; promise: Promise<string> }>()
  let mediaBytes = 0
  const objectUrls = new Set<string>()
  const videos = new Set<HTMLVideoElement>()
  const autoplay = new Map<HTMLVideoElement, () => void>()
  const targetPreviews = new Map<string, PanelGeometry>()
  let observer: IntersectionObserver | undefined
  let resize: ResizeObserver | undefined
  const host = document.createElement('div')
  host.className = 'dp-app'
  root.append(host)
  const toast = document.createElement('div')
  toast.className = 'dp-toast'; toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite')
  host.append(toast)
  const body = document.createElement('div'); body.className = 'dp-body'; host.prepend(body)
  const french = () => settings.language === 'fr' || (settings.language !== 'en' && navigator.language.startsWith('fr'))
  const t = (s: string): string => translate(s, french())
  const current = () => saved
  function notice(message: string) {
    if (disposed) return
    toast.textContent = message; toast.classList.add('is-visible')
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 5500)
  }
  function read(value: unknown) {
    try { saved = value === undefined ? emptyCollection() : parseCollection(value) }
    catch { notice(t('Impossible de charger la configuration.')); return false }
    return true
  }
  read(options.collection)

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
  function geometry(el: HTMLElement, b: PanelButton, layout: PanelGeometry = b) {
    el.style.left = layout.x + 'px'; el.style.top = layout.y + 'px'; el.style.width = layout.width + 'px'; el.style.height = layout.height + 'px'
    el.style.setProperty('--button-color', b.color); el.style.setProperty('--button-radius', b.radius + 'px')
    el.classList.toggle('is-compact', layout.height < 100)
    el.classList.toggle('is-tiny', layout.width < 72 && b.showLabel)
    el.style.setProperty('--button-padding', Math.min(24, layout.width * .12, layout.height * .16) + 'px')
    el.dataset.shape = b.shape
    const outline = el.querySelector<SVGElement>('.dp-shape-outline')
    if (outline) {
      outline.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height)
      outline.querySelector('polygon')!.setAttribute('points', b.shape === 'triangle'
        ? (layout.width / 2) + ',2 ' + (layout.width - 2) + ',' + (layout.height - 2) + ' 2,' + (layout.height - 2)
        : (layout.width / 4) + ',2 ' + (layout.width * .75) + ',2 ' + (layout.width - 2) + ',' + (layout.height / 2) + ' ' + (layout.width * .75) + ',' + (layout.height - 2) + ' ' + (layout.width / 4) + ',' + (layout.height - 2) + ' 2,' + (layout.height / 2))
    }
  }
  function fit() {
    if (!viewport || !stage) return
    const c = current(), rect = viewport.getBoundingClientRect()
    const scale = Math.min(rect.width / c.width, rect.height / c.height)
    stage.style.width = c.width + 'px'; stage.style.height = c.height + 'px'
    stage.style.transform = 'translate(-50%, -50%) scale(' + scale + ')'
  }
  function stopVideos() {
    videos.forEach(v => { v.pause(); v.removeAttribute('src'); v.load() }); videos.clear(); autoplay.clear(); activeVideo = undefined
  }
  function render() {
    revision++; stopVideos(); observer?.disconnect(); resize?.disconnect()
    host.classList.toggle('is-thumbnail', !!options.thumbnail)
    host.style.setProperty('--surface-opacity', String(typeof settings.opacity === 'number' ? settings.opacity : 0.7))
    host.setAttribute('lang', french() ? 'fr' : 'en')
    const c = current()
    body.innerHTML = '<div class="dp-viewport"><div class="dp-stage"></div></div>' + (!options.thumbnail && c.buttons.length === 0
      ? '<div class="dp-empty"><div>' + icon('app') + '</div><h2>' + h(t('Créez votre premier raccourci.')) + '</h2><p>' + h(t('Ajoutez et configurez vos boutons dans la sidebar MyWallpaper.')) + '</p></div>' : '')
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
      geometry(el, b, targetPreviews.get(b.id))
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
      el.addEventListener('click', () => void launch(b))
    }
    releaseUnusedMedia()
  }
  async function launch(b: PanelButton) {
    if (!b.target.trim()) { notice(t('Choisissez d’abord une cible.')); return }
    try { await client.request('open', { target: b.target, arguments: b.arguments }) }
    catch (e) { notice(e instanceof Error ? e.message : String(e)) }
  }
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') videos.forEach(v => v.pause())
    else autoplay.forEach((resume, v) => { if (v.dataset.visible === 'true') resume() })
  }
  document.addEventListener('visibilitychange', onVisibility)
  render()
  return {
    notice,
    previewTarget(id: string, preview?: PanelGeometry) {
      const button = current().buttons.find(item => item.id === id)
      if (!button) { targetPreviews.delete(id); return }
      if (preview) targetPreviews.set(id, { ...preview })
      else targetPreviews.delete(id)
      // Collection IDs are validated against /^[\w-]{1,80}$/ before rendering.
      const element = stage?.querySelector<HTMLElement>('.dp-panel[data-id="' + id + '"]')
      if (element) geometry(element, button, targetPreviews.get(id))
    },
    configure(values: AddonValues) {
      const changedLanguage = settings.language !== values.language
      settings = values
      if (changedLanguage && !disposed) render()
      host.style.setProperty('--surface-opacity', String(typeof settings.opacity === 'number' ? settings.opacity : 0.7))
      host.setAttribute('lang', french() ? 'fr' : 'en')
    },
    load(value: unknown) {
      if (disposed) return
      // Settings and device bindings may update together; avoid rebuilding twice.
      const previous = JSON.stringify(saved)
      if (!read(value) || JSON.stringify(saved) === previous) return
      targetPreviews.clear(); render()
    },
    dispose() {
      disposed = true; revision++; clearTimeout(toastTimer); observer?.disconnect(); resize?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility); stopVideos(); targetPreviews.clear()
      objectUrls.forEach(url => URL.revokeObjectURL(url)); blobs.clear(); objectUrls.clear(); host.remove()
    },
  }
}
