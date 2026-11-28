// /revo-flow steward : les règles maison de .claude/skills/steward/SKILL.md, lues par le suivi local de /ship et /steward (Mac, Linux)
// et par PR Steward dans le cloud pour maintenir une PR (CI, conflits, commentaires). Tirées de ce que revo-flow a appris du projet :
// papercuts répétés, commandes de vérification confirmées, tests instables, pièges.
// Pur : des textes, aucun accès disque ni processus ; rien ne lève, une entrée bizarre rend une valeur sûre.

import type { VerifCommande } from '../types/verif'
import type { Papercut } from './papercut'
import { argvText } from './verif/detect'

/** Le chemin du fichier, relatif à la racine du projet. */
export const STEWARD_PATH = '.claude/skills/steward/SKILL.md'

export const STEWARD_DEBUT = '<!-- revo-flow:steward debut -->'
export const STEWARD_FIN = '<!-- revo-flow:steward fin -->'

/** Au plus ce nombre de règles tirées des papercuts. */
export const STEWARD_PAPERCUTS_MAX = 15
/** Un papercut devient une règle à partir de ce nombre de signalements (un motif doit revenir). */
export const STEWARD_VU_MIN = 2

const FRONTMATTER = [
  '---',
  'name: steward',
  "description: Règles maison pour s'occuper des PR de ce dépôt",
  'user-invocable: false',
  'disable-model-invocation: true',
  '---',
]
const INTRO = 'Règles maison pour maintenir les PR de ce dépôt (CI, conflits, commentaires de revue).'
const NOTE = '<!-- Généré par /revo-flow steward : ce bloc est réécrit à chaque fois ; écris tes propres règles hors des marqueurs. -->'
const VIDE = "<!-- Rien encore : revo-flow n'a pas appris de règle sur ce projet (papercuts répétés, commandes de vérification confirmées, tests instables). -->"

const OUTILS_AVANT_PUSH = new Set(['lint', 'typage', 'tests'])

export type StewardEntree = { papercuts: Papercut[]; commandes: VerifCommande[]; instables: string[]; pieges?: string[] }

/** Un texte sur une ligne, sans marqueur de commentaire HTML (il casserait le bloc) ; '' pour autre chose qu'une chaîne. */
function ligne(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim()
}

/** Un code en ligne markdown : sans accent grave à l'intérieur. */
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``

const liste = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/** Les plus vus d'abord, puis les plus récents (comme papercutBrief). */
const parImportance = (a: Papercut, b: Papercut): number => b.vu - a.vu || (a.le < b.le ? 1 : a.le > b.le ? -1 : 0)

const estPapercutRetenu = (p: unknown): p is Papercut => {
  const x = p as Papercut
  return !!x && typeof x === 'object' && x.cible === 'projet' && typeof x.vu === 'number' && x.vu >= STEWARD_VU_MIN && typeof x.le === 'string'
}

/** Une règle par papercut répété : le problème, puis le contournement ou, à défaut, le correctif ; '' sans rien d'actionnable. */
function reglePapercut(p: Papercut): string {
  const quoi = ligne(p.quoi)
  const obtenu = ligne(p.obtenu)
  const remede = ligne(p.contournement) ? `Contournement : ${ligne(p.contournement)}` : ligne(p.correctif) ? `Correctif à faire : ${ligne(p.correctif)}` : ''
  if (!remede || !quoi || !obtenu) return ''
  const outil = ligne(p.outil)
  return `${outil ? `${code(outil)} : ` : ''}${quoi} → ${obtenu}. ${remede}`
}

function reglesPapercuts(list: unknown): string[] {
  const gardes = liste<unknown>(list).filter(estPapercutRetenu).sort(parImportance)
  return gardes.map(reglePapercut).filter(Boolean).slice(0, STEWARD_PAPERCUTS_MAX)
}

/** argv sans les jetons du flow : « {fichiers} » retiré, un jeton « {sorties} » retiré avec l'option qui le précède. */
function argvSansJetons(argv: string[]): { argv: string[]; fichiers: boolean } {
  const out: string[] = []
  let fichiers = false
  for (const t of argv) {
    if (t === '{fichiers}') fichiers = true
    else if (t.includes('{sorties}')) {
      const prev = out[out.length - 1]
      if (prev && prev.startsWith('-') && !prev.includes('=')) out.pop()
    } else out.push(t)
  }
  return { argv: out, fichiers }
}

/** « Avant de pousser un correctif, lance `npm run lint`. » pour une commande lint, typage ou tests ; '' sinon. */
function regleCommande(c: VerifCommande): string {
  if (!c || typeof c !== 'object' || !OUTILS_AVANT_PUSH.has(c.outil) || c.format === 'crap') return ''
  const brut = liste<unknown>(c.argv).filter((t): t is string => typeof t === 'string')
  const { argv, fichiers } = argvSansJetons(brut)
  const texte = ligne(argvText(argv))
  if (!texte) return ''
  return `Avant de pousser un correctif, lance ${code(texte)}${fichiers ? ' sur les fichiers modifiés' : ''}.`
}

const regleInstable = (x: unknown): string => {
  const t = ligne(x)
  return t ? `${code(t)} est instable : relance-le une fois avant d'en chercher la cause.` : ''
}

/** Les règles du bloc, dans l'ordre : commandes, instables, pièges, papercuts ; sans doublon. */
export function stewardRegles(entree: StewardEntree): string[] {
  const e = (entree && typeof entree === 'object' ? entree : {}) as Partial<StewardEntree>
  const toutes = [
    ...liste<VerifCommande>(e.commandes).map(regleCommande),
    ...liste<unknown>(e.instables).map(regleInstable),
    ...liste<unknown>(e.pieges).map(ligne),
    ...reglesPapercuts(e.papercuts),
  ]
  return [...new Set(toutes.filter(Boolean))]
}

/** Le bloc généré, marqueurs compris, lignes séparées par `eol`. */
function bloc(regles: string[], eol: string): string {
  const corps = regles.length ? regles.map(r => `- ${r}`) : [VIDE]
  return [STEWARD_DEBUT, NOTE, ...corps, STEWARD_FIN].join(eol)
}

/** Le texte existant avec le bloc remplacé (ou ajouté à la fin) ; tout le reste gardé tel quel. */
function remplaceBloc(existant: string, b: string, eol: string): string {
  const debut = existant.indexOf(STEWARD_DEBUT)
  if (debut < 0) return `${existant}${existant.endsWith('\n') ? '' : eol}${eol}${b}${eol}`
  const fin = existant.indexOf(STEWARD_FIN, debut)
  if (fin < 0) return `${existant.slice(0, debut)}${b}${eol}`
  return `${existant.slice(0, debut)}${b}${existant.slice(fin + STEWARD_FIN.length)}`
}

/**
 * Le texte de SKILL.md : absent (ou vide), le frontmatter, une ligne d'intro et le bloc ; existant, seul le bloc entre les marqueurs est
 * remplacé (ou ajouté à la fin s'il n'y en a pas), le reste est gardé octet pour octet. Idempotent : pas de date dans le bloc.
 * regles = le nombre de règles générées.
 */
export function stewardSkill(existant: string | undefined, entree: StewardEntree): { texte: string; regles: number } {
  const regles = stewardRegles(entree)
  const ex = typeof existant === 'string' && existant.trim() ? existant : undefined
  const eol = ex?.includes('\r\n') ? '\r\n' : '\n'
  const b = bloc(regles, eol)
  const texte = ex === undefined ? [...FRONTMATTER, '', INTRO, '', b, ''].join(eol) : remplaceBloc(ex, b, eol)
  return { texte, regles: regles.length }
}
