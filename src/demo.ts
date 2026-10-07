import type { Client, Collection } from './model'
import { newButton } from './model'
import cover from '../assets/demo-cover.webp'

export function demoCollection(): Collection {
  const specs = [
    { label: 'Applications', x: 80, y: 110, width: 280, height: 188, color: '#99bde8', icon: 'app', target: 'https://mywallpaper.online' },
    { label: 'Documents', x: 80, y: 318, width: 280, height: 130, color: '#b3addf', icon: 'folder', target: 'https://mywallpaper.online' },
    { label: 'Créations', x: 380, y: 110, width: 360, height: 338, color: '#f4ba96', icon: 'image', target: 'https://mywallpaper.online', media: { kind: 'image', path: cover, hoverOnly: true } },
    { label: 'Musique', x: 760, y: 110, width: 188, height: 188, color: '#e2bace', icon: 'music', target: 'https://mywallpaper.online', shape: 'ellipse' },
    { label: 'Explorer', x: 760, y: 318, width: 280, height: 130, color: '#a2cebf', icon: 'link', target: 'https://mywallpaper.online' },
  ]
  return { version: 1, width: 1600, height: 900, buttons: specs.map((spec, i) => ({ ...newButton(i), ...spec } as ReturnType<typeof newButton>)) }
}
export function demoClient(notice: (message: string) => void): Client {
  return {
    async request<T>(action: string): Promise<T> {
      if (action === 'open') { notice('Aperçu : aucune application ni aucun fichier n’est ouvert.'); return null as T }
      throw new Error('Passez à l’aperçu Windows pour choisir de vrais fichiers et importer vos raccourcis.')
    },
    close() {},
  }
}
