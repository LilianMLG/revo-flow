// Les deux machines que les tests du cache simulent, quelle que soit celle qui les lance.
import { normalizePath } from './cache/store'

export type Os = {
  nom: string
  /** Les variables que lit le mod : USERPROFILE sous Windows, HOME seul sous macOS. */
  env: Record<string, string>
  /** Le dossier personnel, tel que l'hôte le donne. */
  home: string
  sep: string
}

export const WINDOWS: Os = { nom: 'Windows', env: { USERPROFILE: 'C:\\Users\\x' }, home: 'C:\\Users\\x', sep: '\\' }
export const MACOS: Os = { nom: 'macOS', env: { HOME: '/Users/x' }, home: '/Users/x', sep: '/' }
export const OSES = [WINDOWS, MACOS]

/** Un chemin de l'hôte, sous la forme native de os (sep). */
export const native = (os: Os, ...parts: string[]) => [os.home, ...parts].join(os.sep)

/**
 * La clé d'un chemin sur le disque en mémoire. L'hôte résout un chemin qu'il ne tient pas pour absolu contre le dossier courant :
 * sur macOS « C:/Users/x/a » arrive en « <cwd>/C:/Users/x/a », sous Windows « /Users/x/a » arrive en « C:\Users\x\a ».
 * On coupe donc tout jusqu'à la lettre de lecteur incluse : les deux formes donnent « /Users/x/a ».
 */
export function diskKey(p: string): string {
  const s = normalizePath(p)
  const i = s.search(/(^|\/)[A-Za-z]:\//)
  return i < 0 ? s : s.slice(s.indexOf(':', i) + 1)
}
