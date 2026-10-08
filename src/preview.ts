import './styles.css'
import './preview.css'
import { previewClient } from './client'
import { demoClient, demoCollection } from './demo'
import { emptyCollection } from './model'
import { createPanels } from './panels'

const params = new URLSearchParams(location.search)
const demo = params.get('demo') !== '0'
const preview = document.querySelector<HTMLElement>('#preview')!
preview.innerHTML = '<header class="dp-preview-header"><div><strong>Desktop Panels</strong><span>MyWallpaper · ' + (demo ? 'aperçu visuel' : 'Windows local') + '</span></div><nav><a href="' + (demo ? '/?demo=0' : '/?demo=1') + '">' + (demo ? 'Utiliser mes fichiers Windows' : 'Aperçu visuel') + '</a></nav></header><main class="dp-preview-desktop" id="desktop"></main><footer class="dp-preview-footer">' + (demo ? 'Disposition d’exemple : les actions ne lancent rien. Les réglages s’effectuent dans la sidebar MyWallpaper.' : 'Compagnon local requis. Les raccourcis d’origine restent intacts.') + '</footer>'
const key = 'mywallpaper.desktop-panels.preview.' + (demo ? 'demo' : 'local')
let value: string | null = null
try { value = localStorage.getItem(key) } catch {}
let widget: ReturnType<typeof createPanels>
const client = demo ? demoClient(message => widget.notice(message)) : previewClient()
widget = createPanels(document.querySelector<HTMLElement>('#desktop')!, client, {
  settings: { opacity: .72, language: 'fr' },
  collection: value ?? JSON.stringify(demo ? demoCollection() : emptyCollection()),
})
window.addEventListener('pagehide', () => { widget.dispose(); client.close() }, { once: true })
