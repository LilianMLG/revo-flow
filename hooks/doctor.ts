// /revo-flow doctor et /revo-flow version (docs/rd-v3/README.md §2.2) : ce que le mod a détecté sur le projet courant et ce qu'il y fera.
// Module PUR : aucun accès à `$`, tout entre en paramètres (la collecte, en lecture seule, est dans register.tsx). Rien ne lève.
// Du texte aligné comme la maquette, pas de Markdown.
import type { AgentDef } from '../types/agents'
import type { CacheStats } from '../types/cache'
import type { ProjetVerif, VerifCommande, VerifMode, VerifOutil } from '../types/verif'
import { CRAP_SEUIL } from './verif/crap'
import { commandLabel } from './verif/detect'
import { baseFor } from './verif/base'
import { durationOf } from './verif/runner'
import { commandeText, type WebDispo } from './verif/web'

/** Largeur de la colonne des titres (« Stack », « Typage »…) : la maquette aligne le reste dessous. */
const TITRE = 13
/** Au plus tant de manifestes cités après la stack. */
const MANIFESTES_MAX = 5

/** Les entrées de doctorText : tout ce que la commande a collecté, sans rien lancer de ce que la porte lance. */
export type DoctorInput = {
  /** Le nom du projet ; absent = aucun projet git reconnu ici. */
  nom?: string
  /** graph.projet.stack (« Nuxt 3, Pinia, vitest » ; « inconnue » ou absent si le projet n'a pas de graphe). */
  stack?: string
  /** Les manifestes et fichiers de configuration présents (manifestsOf). */
  manifestes: string[]
  /** Les commandes de la porte : celles confirmées du projet, sinon celles que detectCommands trouve maintenant. */
  commandes: VerifCommande[]
  /** confirmee : commandes déjà confirmées, manifestes inchangés ; a-confirmer : détectées, la question viendra au premier flow. */
  confirmation: 'confirmee' | 'a-confirmer'
  /** projet.verif du graphe : durées apprises (durationOf) et bases de référence (baseFor). */
  verif?: ProjetVerif
  /** Le commit courant (HEAD), pour retrouver sa base de référence. */
  commit?: string
  /** Les options du mod. */
  mode: VerifMode
  crap: boolean
  cache: boolean
  agentsActif: boolean
  /** computeStats du graphe ; null = pas de graphe. */
  stats: CacheStats | null
  /** Flows au journal du graphe (graph.journal). */
  journal: number
  /** Les agents installés (catalogue) ; vide si l'option est coupée. */
  agents: AgentDef[]
  /** Les pièges d'environnement, déjà complets (detectCommands, flutterVersionTrap). */
  pieges: string[]
  /** La preuve web : option, serveur de dev détecté, REVO_WEB_LOGIN défini ; absent = rubrique non affichée. */
  web?: WebDispo
}

const LIBELLE: Record<VerifOutil, string> = { generation: 'Génération', format: 'Format', lint: 'Lint', typage: 'Typage', tests: 'Tests', qualite: 'CRAP' }

/** Une durée courte : « < 1 s », « 40 s », « 2 min 05 s ». */
function duree(ms: number): string {
  if (ms < 1000) return '< 1 s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`
const ligne = (titre: string, texte: string) => `${titre.padEnd(TITRE)}${texte}`.trimEnd()
/** Les lignes suivantes d'une rubrique, alignées sous la première. */
const suite = (texte: string) => `${' '.repeat(TITRE)}${texte}`

/**
 * Les manifestes et fichiers de configuration à citer : package.json, pubspec.yaml, puis les configurations de la racine
 * (nuxt.config.ts, vitest.config.ts, eslint.config.mjs…), puis les CI et autres manifestes lus. `read` : chemin → texte (undefined = absent).
 */
export function manifestsOf(files: string[], read: Record<string, string | undefined>): string[] {
  const presents = Object.keys(read).filter(p => read[p] !== undefined)
  const racine = files.filter(f => /^(nuxt|vite|vitest|jest|eslint|playwright|tailwind)\.config\.[cm]?[jt]s$/.test(f) || /^\.eslintrc(\.(c?js|json|ya?ml))?$/.test(f)).sort()
  const tete = ['package.json', 'pubspec.yaml'].filter(p => presents.includes(p))
  const tous = [...new Set([...tete, ...racine, ...presents.filter(p => !tete.includes(p)).sort()])]
  return tous.length > MANIFESTES_MAX ? [...tous.slice(0, MANIFESTES_MAX), '…'] : tous
}

/** « Nuxt 3, Pinia, vitest » devient « Nuxt 3 + Pinia + vitest ». */
const stackText = (stack: string) => stack.split(',').map(s => s.trim()).filter(Boolean).join(' + ')

/** La commande telle qu'un humain la tape : sans les formats machine, sans les options de couverture ; {fichiers} reste lisible. */
function shortArgv(argv: string[]): string {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!
    if (t === '-f' && argv[i + 1] === 'json') i++
    else if (/^--(run|passWithNoTests|json|machine|reporter=.*|format=machine|coverage.*|coverageReporters=.*|coverageDirectory=.*|coverage-path=.*)$/.test(t)) continue
    else out.push(/\s/.test(t) ? `"${t}"` : t)
  }
  return out.join(' ')
}

/** D'où vient la commande : « CI .gitlab-ci.yml », « script lint », « déduit (biome.json) ». */
function sourceText(c: VerifCommande): string {
  if (c.source === 'ci') return `CI${c.origine ? ` ${c.origine}` : ''}`
  if (c.source === 'script') return c.origine || 'script'
  if (c.source === 'orchestrateur') return 'orchestrateur'
  return `déduit${c.origine ? ` (${c.origine})` : ''}`
}

/** Les lignes Lint, Typage, Tests… : la commande, puis d'où elle vient, sa portée, sa durée connue. */
function commandLines(commandes: VerifCommande[], verif: ProjetVerif | undefined): string[] {
  const lancees = commandes.filter(c => c.format !== 'crap')
  const largeur = Math.max(0, ...lancees.map(c => (shortArgv(c.argv) || commandLabel(c)).length))
  const vus = new Set<VerifOutil>()
  return lancees.map(c => {
    const ms = durationOf(verif, c.id)
    const parts = [
      sourceText(c),
      ...(c.portee === 'projet' ? ['projet entier'] : []),
      ...(c.portee === 'lies' ? ['tests liés aux fichiers du flow'] : []),
      ...(ms ? [`≈ ${duree(ms)} en moyenne`] : []),
      ...(c.outil === 'tests' ? [c.argv.some(t => t.startsWith('--coverage')) ? 'couverture mesurée' : 'sans couverture'] : []),
      ...(c.declencheur ? [`si un fichier ${c.declencheur.replace(/^\*\*\//, '')} change`] : []),
      ...(c.exclus?.length ? [`exclus : ${c.exclus.join(', ')}`] : []),
    ]
    const titre = vus.has(c.outil) ? '' : LIBELLE[c.outil]
    vus.add(c.outil)
    return ligne(titre, `${(shortArgv(c.argv) || commandLabel(c)).padEnd(largeur)}  ${parts.join(' · ')}`)
  })
}

/** La rubrique CRAP : actif avec son seuil, ou pourquoi il ne mesure rien. */
function crapLine(input: DoctorInput): string {
  const c = input.commandes.find(x => x.format === 'crap')
  if (!input.crap) return ligne('CRAP', 'désactivé (option crap)')
  if (c) return ligne('CRAP', `actif (seuil ${c.seuil ?? CRAP_SEUIL})`)
  const testeur = input.commandes.some(x => x.outil === 'tests')
  return ligne('CRAP', testeur ? 'option active, mais les tests liés ne mesurent pas leur couverture : aucun score' : 'option active, mais aucun test lié à lancer : aucun score')
}

/** La rubrique Porte : le mode, et si les commandes sont déjà confirmées. */
function gateLine(input: DoctorInput, nb: number): string {
  if (input.mode === 'off') return ligne('Porte', 'désactivée (option verif) : aucune vérification ne sera lancée')
  if (nb === 0)
    return ligne('Porte', 'ne fera rien : aucune vérification reconnue (ni CI, ni script lint / typecheck / test, ni outil connu) ; un flow se terminera « non vérifié »')
  const mode = input.mode === 'observer' ? 'observer (affiche, ne bloque jamais)' : 'bloquer (refuse de conclure tant qu\'une erreur nouvelle subsiste)'
  const conf = input.confirmation === 'confirmee' ? 'commandes confirmées' : 'commandes à confirmer au premier flow'
  return ligne('Porte', `${mode} · ${conf}`)
}

/** La rubrique Base : erreurs préexistantes par commande au commit courant. */
function baseLine(input: DoctorInput): string {
  const commit = input.commit?.trim() ?? ''
  const court = commit.slice(0, 7)
  if (!commit) return ligne('Base', 'pas de commit : aucune base de référence')
  const base = baseFor(input.verif, commit)
  if (!base) return ligne('Base', `commit ${court}, pas encore de base : elle se prend pendant la planification du prochain flow`)
  const nom = (id: string) => input.commandes.find(c => c.id === id)?.outil ?? id
  const parts = base.commandes.map((id, i) => {
    const n = base.signatures.filter(s => s.slice(0, s.indexOf('|')) === id).length
    return i === 0 ? `${n} ${n > 1 ? 'erreurs préexistantes' : 'erreur préexistante'} (${LIBELLE[nom(id) as VerifOutil]?.toLowerCase() ?? id})` : `${n} (${LIBELLE[nom(id) as VerifOutil]?.toLowerCase() ?? id})`
  })
  return ligne('Base', `commit ${court}${parts.length ? `, ${parts.join(', ')}` : ''}`)
}

/** La rubrique Cache : taille du graphe, fiches, journal. */
function cacheLine(input: DoctorInput): string {
  const s = input.stats
  const fin = input.cache ? '' : ' · option cache désactivée : rien n\'est injecté aux agents'
  if (!s) return ligne('Cache', `pas encore de graphe : il se construit au premier flow ou avec /revo-flow cache${fin}`)
  return ligne('Cache', `graphe de ${plural(s.fichiers, 'fichier')}, ${plural(s.features, 'fiche')}, ${plural(input.journal, 'flow')} au journal${fin}`)
}

/** La rubrique Agents : combien, d'où, et s'ils sont proposés au plan. */
function agentsLine(input: DoctorInput): string {
  if (!input.agentsActif) return ligne('Agents', 'option agents désactivée : rien n\'est lu ni proposé, general-purpose comme avant')
  if (input.agents.length === 0) return ligne('Agents', 'aucun agent installé : general-purpose et Explore seulement')
  const parSource = new Map<string, number>()
  for (const d of input.agents) {
    const k = d.source === 'plugin' ? (d.plugin ?? 'plugin') : d.source === 'projet' ? 'projet' : 'personnels'
    parSource.set(k, (parSource.get(k) ?? 0) + 1)
  }
  const detail = [...parSource.entries()].map(([k, n]) => `${k} ×${n}`).join(', ')
  return ligne('Agents', `${input.agents.length} installés (${detail}), proposés au plan`)
}

/** La rubrique Web : la commande du serveur de dev et son port, les outils du vérificateur, la connexion de test. */
function webLines(w: WebDispo): string[] {
  if (w.option === 'off') return [ligne('Web', 'preuve web désactivée (option web)')]
  const s = w.serveur
  if (!s) return [ligne('Web', 'aucun serveur de dev détecté (pas de script dev) : pas de preuve web')]
  const outils = w.option === 'devtools' ? 'extension Claude in Chrome, ou Chrome DevTools MCP (npx chrome-devtools-mcp)' : 'extension Claude in Chrome'
  const port = s.port ? `port ${s.port}` : 'port inconnu (lu dans la sortie)'
  const login = w.login
    ? 'REVO_WEB_LOGIN défini : le serveur de dev connaît le compte de test (revo-flow ne le lit jamais)'
    : 'REVO_WEB_LOGIN absent : si l’app demande une connexion, définissez-la pour le serveur de dev ; revo-flow ne la lit jamais'
  return [ligne('Web', `${commandeText(s)} · ${port} · ${s.origine} · preuve web au vérificateur sur votre accord · outils : ${outils}`), suite(login)]
}

/**
 * Le texte de /revo-flow doctor. Sans projet : le dit, et dit que la porte ne fera rien. Avec un projet : stack, porte, une ligne par
 * commande, CRAP, base de référence, cache, agents, pièges.
 */
export function doctorText(input: DoctorInput): string {
  if (!input.nom) {
    return [
      'revo-flow doctor',
      'Aucun projet git reconnu ici.',
      '',
      'La porte de vérification ne fera rien : sans projet, revo-flow n\'a ni commande à détecter, ni base de référence, ni cache ; un flow se terminera « non vérifié ».',
      'Ouvrez Claude Code dans un dépôt git, puis relancez /revo-flow doctor.',
    ].join('\n')
  }
  const lignes = [`revo-flow doctor · ${input.nom}`]
  const stack = input.stack && input.stack !== 'inconnue' ? stackText(input.stack) : 'non reconnue'
  lignes.push(ligne('Stack', `${stack}${input.manifestes.length ? ` (${input.manifestes.join(', ')})` : ''}`))
  lignes.push(gateLine(input, input.commandes.filter(c => c.format !== 'crap').length))
  lignes.push(...commandLines(input.commandes, input.verif))
  lignes.push(crapLine(input))
  lignes.push(baseLine(input))
  lignes.push(cacheLine(input))
  lignes.push(agentsLine(input))
  if (input.web) lignes.push(...webLines(input.web))
  if (input.pieges.length === 0) lignes.push(ligne('Pièges', 'aucun'))
  else input.pieges.forEach((p, i) => lignes.push(i === 0 ? ligne('Pièges', p) : suite(p)))
  return lignes.join('\n')
}

/** La version lue dans le texte de .claude-plugin/plugin.json ; undefined si le texte manque ou est illisible. */
export function pluginVersion(text: string | undefined): string | undefined {
  try {
    const v = (JSON.parse(text ?? 'null') as { version?: unknown } | null)?.version
    return typeof v === 'string' && v ? v : undefined
  } catch {
    return undefined
  }
}

/** Le texte de /revo-flow version. */
export const versionText = (version: string | undefined): string => (version ? `revo-flow ${version}` : 'revo-flow : version illisible (.claude-plugin/plugin.json introuvable ou invalide)')
