import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, PluginOptions, Register, SessionContextUsage } from 'claude-code'

import type { Activity, Context, Flow, FlowAgent, Lead } from '../types'
import type { CacheHit, CacheStats, Feature, FlowCache, Graph, LearnContext, LearnInput } from '../types/cache'
import {
  autoFiche,
  briefText,
  candidatesText,
  completeFiche,
  computeStats,
  featureText,
  freshness,
  graphText,
  learn,
  matchRequest,
  neighborsText,
  recordUsage as recordCacheUsage,
  searchText,
  servedFiles,
  tokensOf,
} from './cache/graph'
import { buildMechanical, deleteGraph, fileTokens, isOutdated, listGraphs, loadGraph, refreshGraph, resolveProject, saveGraph, type Io } from './cache/store'
import {
  CACHE_TOOL,
  EMPTY,
  LEAD_BRIEF,
  MODELS,
  PLAN_TOOL,
  PLUGIN,
  STEP_TOOL,
  addUsage,
  agentBrief,
  allFinished,
  applyStep,
  applyTodos,
  costUsd,
  dayKey,
  describeCall,
  dispatchText,
  draftTitle,
  euros,
  finishTasks,
  firstSentence,
  leadBrief,
  flowPercent,
  flowRecap,
  fmtDuration,
  isTally,
  matchAgent,
  modelLabel,
  parsePlan,
  planQuestion,
  progress,
  remainingTasks,
  shortPath,
  slug,
  total,
  weekKey,
  type PlanInput,
  type Usage,
} from './lib'
import {
  DesktopBand,
  DesktopPane,
  MobileBand,
  MobilePane,
  TerminalBand,
  TerminalPane,
  TerminalTurnLine,
  pixels,
  type PaneActions,
  type ViewData,
} from './views'

type $ = EngineInterface

const PANE = 'revo-flow'
const LEAD0: Lead = { modelId: '', tokens: EMPTY, costUsd: 0 }

// ── État partagé (redessine les vues quand il change) ────────────────────

const flowA = atom({ plugin: 'revo-flow', key: 'flow' } as const, null)
const leadA = atom({ plugin: 'revo-flow', key: 'lead' } as const, LEAD0)
const isBusy = atom({ plugin: 'revo-flow', key: 'isBusy' } as const, false)
const tokens = atom({ plugin: 'revo-flow', key: 'tokens' } as const, null)
const limits = atom({ plugin: 'revo-flow', key: 'limits' } as const, [])
const sessionUsage = atom({ plugin: 'revo-flow', key: 'session' } as const, EMPTY)
const entries = atom({ plugin: 'revo-flow', key: 'entries' } as const, [])
const lastTurnA = atom({ plugin: 'revo-flow', key: 'lastTurn' } as const, null)
const contextA = atom({ plugin: 'revo-flow', key: 'context' } as const, null)
const sessionCostA = atom({ plugin: 'revo-flow', key: 'sessionCostUsd' } as const, 0)
const cacheStatsA = atom({ plugin: 'revo-flow', key: 'cacheStats' } as const, null)
const flowCacheA = atom({ plugin: 'revo-flow', key: 'flowCache' } as const, null)
const cacheOpenA = atom({ plugin: 'revo-flow', key: 'cacheOpen' } as const, false)

/** Les options du plugin (userConfig), fixées pour ce chargement : un changement recharge le module. */
const opts = { validerPlan: true, conflits: 'avertir' as 'avertir' | 'refuser', notifier: true, cache: true }

/** Les agents prévus déjà attribués à un appel Agent : deux lancements en parallèle ne prennent jamais le même. */
const claimed = new Set<string>()
/** Le tour en cours de l'orchestrateur, pour pouvoir l'interrompre ($.turn.abort ne prend que celui-là). */
let leadTurnId: string | undefined
/** La validation du plan en attente : les boutons du panneau peuvent y répondre à la place du dialogue. */
let pendingDecision: ((d: Decision) => void) | undefined
/** La réponse à la validation du plan ; note = ce que l'utilisateur a tapé à la place d'un choix. */
type Decision = { isLaunched: boolean; note?: string }
/** La vérification périodique de l'état des agents tourne-t-elle déjà (une par chargement du module) ? */
let isWatching = false

function watchAgents($: $) {
  if (isWatching) return
  isWatching = true
  $.clock.every(3000, () => void syncAgents($).catch(() => undefined))
}

// ── Flow ─────────────────────────────────────────────────────────────────

function setFlow($: $, change: (f: Flow) => Flow) {
  return update($, flowA, f => (f ? change(f) : f))
}

function setAgent($: $, key: string, change: (a: FlowAgent) => FlowAgent) {
  return setFlow($, f => ({ ...f, agents: f.agents.map(a => (a.key === key ? change(a) : a)) }))
}

/** Qui agit : « lead » pour le fil principal, la clé de l'agent prévu pour un sous-agent du flow, rien sinon. */
function whoIs(flow: Flow, agentId: string | undefined) {
  if (!agentId) return 'lead'
  return flow.agents.find(a => a.agentId === agentId)?.key
}

async function setActivity($: $, who: string, patch: Activity) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Activity
  if (who === 'lead') await update($, leadA, l => ({ ...l, ...clean }))
  else await setAgent($, who, a => ({ ...a, ...clean }))
}

/** Le dernier segment d'un chemin : le nom du dossier. */
const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

async function gitBranch($: $, root: string) {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

/** L'en-tête projet · branche : le dépôt de la session, sinon le nom du dossier courant sans branche. */
async function projectHeader($: $): Promise<{ project: string; branch: string }> {
  let cwd = ''
  try {
    cwd = (await $.fs.stat('.', { resolve: true })).realPath ?? ''
  } catch {
    // dossier illisible : on s'en passe
  }
  const repo = await $.session.repo().catch(() => null)
  if (!repo) return { project: baseName(cwd), branch: '' }
  // La racine d'un worktree est celle du dépôt principal : la branche se lit là où l'on travaille.
  return { project: baseName(repo.root), branch: await gitBranch($, cwd || repo.root) }
}

async function registerTools($: $) {
  await $.tool.register({
    name: 'plan',
    description:
      "revo-flow, réservé à l'orchestrateur : enregistre le plan de la demande et l'équipe de sous-agents (modèle, effort et tâches de chacun). À appeler une fois, après avoir lu les specs et avant de lancer les agents.",
    inputSchema: {
      type: 'object',
      properties: {
        titre: { type: 'string', description: 'Titre court de la feature (3 à 8 mots)' },
        resume: { type: 'string', description: 'Le plan en 1 à 3 phrases' },
        agents: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              nom: { type: 'string', description: 'Nom court et unique, repris tel quel comme description de l’appel Agent' },
              role: { type: 'string' },
              type: { type: 'string', description: 'Type de sous-agent : general-purpose (défaut), Explore…' },
              modele: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] },
              effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] },
              pourquoi: { type: 'string', description: 'Pourquoi ce modèle et cet effort, en une phrase' },
              taches: {
                type: 'array',
                minItems: 1,
                maxItems: 12,
                items: {
                  type: 'object',
                  properties: {
                    titre: { type: 'string' },
                    type: { type: 'string', enum: ['analyse', 'codage', 'test', 'review', 'doc', 'deploy'] },
                  },
                  required: ['titre'],
                },
              },
            },
            required: ['nom', 'modele', 'effort', 'taches'],
          },
        },
      },
      required: ['titre', 'agents'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'step',
    description:
      'revo-flow : un sous-agent signale où il en est dans SA liste de tâches (numérotée à partir de 1). Fait avancer sa barre de progression.',
    inputSchema: {
      type: 'object',
      properties: {
        tache: { type: 'number', description: 'Numéro de la tâche, à partir de 1' },
        statut: { type: 'string', enum: ['en_cours', 'fait', 'echec'] },
      },
      required: ['tache', 'statut'],
    },
    isDeferred: false,
  })
}

// ── Tokens : session, jour, semaine ──────────────────────────────────────

async function loadTokens($: $) {
  const now = new Date(await $.clock.now())
  const dk = dayKey(now)
  const wk = weekKey(now)
  const day = await $.store.get(`day:${dk}`)
  const week = await $.store.get(`week:${wk}`)
  await update($, tokens, () => ({ dayKey: dk, weekKey: wk, day: isTally(day) ? day : EMPTY, week: isTally(week) ? week : EMPTY }))
}

async function recordUsage($: $, u: Usage | undefined) {
  if (!u) return
  await update($, sessionUsage, t => addUsage(t, u))
  const now = new Date(await $.clock.now())
  const dk = `day:${dayKey(now)}`
  const wk = `week:${weekKey(now)}`
  await $.store.set(dk, addUsage(await $.store.get(dk), u))
  await $.store.set(wk, addUsage(await $.store.get(wk), u))
  await loadTokens($)
}

/** Garde 60 jours et 8 semaines d'historique. */
async function purge($: $) {
  const now = await $.clock.now()
  const oldDay = `day:${dayKey(new Date(now - 60 * 86400000))}`
  const oldWeek = `week:${weekKey(new Date(now - 8 * 7 * 86400000))}`
  for (const key of await $.store.keys()) {
    if ((key.startsWith('day:') && key < oldDay) || (key.startsWith('week:') && key < oldWeek)) await $.store.delete(key)
  }
}

/** Une seule fois : reprend les cumuls jour/semaine de vel-parcours, pour ne pas repartir de zéro. */
async function migrate($: $) {
  if ((await $.store.get('migrated')) === true) return
  try {
    const home = (await $.env.get('USERPROFILE')) ?? ''
    const dir = `${home}/.claude/plugins/store`
    if (home) {
      for (const f of await $.fs.list(dir)) {
        if (f.kind !== 'file' || !f.name.startsWith('vel-parcours_') || !f.name.endsWith('.json')) continue
        const data = JSON.parse(await $.fs.read(`${dir}/${f.name}`)) as Record<string, unknown>
        for (const [key, value] of Object.entries(data)) {
          if ((key.startsWith('day:') || key.startsWith('week:')) && isTally(value)) await $.store.set(key, value)
        }
      }
    }
  } catch {
    // rien à reprendre
  }
  await $.store.set('migrated', true)
}

// ── Fichiers modifiés ────────────────────────────────────────────────────

/** Le texte que l'agent a écrit juste avant cet appel d'outil, dans le même tour. */
async function precedingText($: $, toolUseId: string | undefined, agentId: string | undefined) {
  const rows = agentId ? await $.session.messages({ agentId }) : await $.session.messages()
  if (!Array.isArray(rows)) return ''
  let i = rows.findIndex(m => m.role === 'assistant' && m.toolUses.some(t => t.tool_use_id === toolUseId))
  if (i < 0) i = rows.length - 1
  for (let j = i; j >= 0; j--) {
    const m = rows[j]!
    if (m.role === 'user' && !m.toolResults?.length) break
    if (m.role === 'assistant' && m.text.trim()) return m.text
  }
  return ''
}

async function setReason($: $, path: string, reason: string) {
  await update($, entries, list => list.map(x => (x.path === path ? { ...x, reason } : x)))
}

/**
 * Le fichier modifié entre dans la liste tout de suite, avec qui l'a modifié (pour repérer les conflits) ;
 * sa raison (le texte écrit juste avant) suit, hors de l'outil.
 */
async function markFile($: $, path: string, by: string, toolUseId: string | undefined, agentId: string | undefined) {
  const at = await $.clock.now()
  const rel = shortPath(path)
  await update($, entries, list => {
    const old = list.find(x => x.path === path)
    return [...list.filter(x => x.path !== path), { ...old, path, rel, reason: old?.reason ?? '…', count: (old?.count ?? 0) + 1, at, by }].slice(-100)
  })
  $.clock.after(0, async () => {
    try {
      const text = await precedingText($, toolUseId, agentId)
      await setReason($, path, text ? firstSentence(text) : '—')
    } catch {
      await setReason($, path, '—')
    }
  })
}

/**
 * Un autre agent, encore au travail, a déjà modifié ce fichier : selon l'option « conflits », on prévient
 * (toast et marque sur l'entrée) ou on refuse (le texte du refus est renvoyé). Le fil principal n'est pas
 * un agent : ses propres modifications ne bloquent personne.
 */
async function checkConflict($: $, path: string, who: string): Promise<string | undefined> {
  const entry = (await read($, entries)).find(x => x.path === path)
  if (!entry?.by || entry.by === who) return undefined
  const other = (await read($, flowA))?.agents.find(a => a.key === entry.by && a.status === 'running')
  if (!other) return undefined
  if (opts.conflits === 'refuser') {
    return `revo-flow : ce fichier est en cours de modification par l’agent « ${other.name} » ; coordonne-toi ou attends sa fin.`
  }
  $.ui.toast(`⚠ ${entry.rel} : fichier aussi modifié par « ${other.name} »`)
  await update($, entries, list =>
    list.map(x => (x.path === path ? { ...x, conflict: [...new Set([...(x.conflict ?? []), other.key])] } : x)),
  )
  return undefined
}

// ── Notifications ────────────────────────────────────────────────────────

/** Une notification système si l'option « notifier » est active ; quand elle ne part pas, un toast. */
async function notify($: $, text: string) {
  if (!opts.notifier) return
  try {
    const sent = await $.ui.notify(text, { title: 'revo-flow' })
    if (!sent.isSent) $.ui.toast(text)
  } catch {
    $.ui.toast(text)
  }
}

/** Le flow est fini : phase done, heure de fin, et une notification avec la durée, le coût et les fichiers. */
async function finishFlow($: $) {
  const flow = await read($, flowA)
  if (!flow || flow.phase === 'done') return
  const now = await $.clock.now()
  await setFlow($, f => ({ ...f, phase: 'done', endedAt: now }))
  const lead = await read($, leadA)
  const cost = lead.costUsd + flow.agents.reduce((sum, a) => sum + a.costUsd, 0)
  const files = (await read($, entries)).length
  await closeFlowCache($).catch(() => undefined)
  const note = endNote ? ` · ${endNote}` : ''
  await notify($, `« ${flow.title} » terminé · ${fmtDuration(now - flow.startedAt)} · ${euros(cost)} · ${files} fichier${files > 1 ? 's' : ''}${note}`)
}

// ── Cache projet ─────────────────────────────────────────────────────────

type ProjectRef = NonNullable<Awaited<ReturnType<typeof resolveProject>>>

/** Les accès du cache au moteur : store.ts ne reçoit jamais `$`, que le moteur ne suit pas à travers un import (sinon tout le module est refusé). */
function ioOf($: $): Io {
  return {
    fs: {
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      list: path => $.fs.list(path),
      exists: path => $.fs.exists(path),
      stat: path => $.fs.stat(path),
    },
    run: (argv, init) => $.process.run(argv, init),
    now: () => $.clock.now(),
    home: async () => (await $.env.get('USERPROFILE').catch(() => undefined)) || (await $.env.get('HOME').catch(() => undefined)) || undefined,
    repo: () => $.session.repo(),
    root: () => $.session.root(),
  }
}

/** Le préfixe de description des sous-agents qui construisent des fiches : exemptés du plan, hors flow. */
const BUILDER = 'revo-flow-cache'
/** Le type d'agent enregistré pour construire les fiches : `revo-flow:cache-indexer`. */
const INDEXER = 'cache-indexer'
/** Un rafraîchissement du graphe (hash git) au plus toutes les 30 s. */
const REFRESH_MS = 30_000
/** Coût estimé d'une fiche construite : tokens de la candidate × 2,5 $/M (écriture de cache Sonnet) + 0,05 $. */
const buildUsd = (tok: number) => (tok * 2.5) / 1_000_000 + 0.05
/** Taille supposée d'une feature dont on ne connaît pas les fichiers. */
const UNKNOWN_TOK = 30_000

const INDEXER_PROMPT = `Tu construis des fiches de features pour le cache revo-flow d'un projet. La tâche donne la ou les features, le projet et sa racine.
Pour chaque feature :
1. Trouve ses fichiers : outil ${CACHE_TOOL} action « chercher » (requete = l'identifiant ou ses mots-clés, projet = la racine donnée).
2. Lis ces fichiers et leurs voisins utiles (action « voisins », chemin relatif à la racine) avec Read, Grep et Glob, sans rien modifier.
3. Appelle ${CACHE_TOOL} action « apprendre » (avec projet) : feature (identifiant court), titre, alias (les mots qu'un développeur emploierait), resume (600 caractères au plus), flux (les étapes, dans l'ordre), entrees (points d'entrée : routes, pages, mutations), fichiers avec leur rôle (coeur, ui, store, service, test, doc, peripherique…), pieges, deps (autres features).
Ne cite que des fichiers qui existent. Découpe une feature de plus de 40k tokens en sous-features, une fiche chacune.
Termine par une ligne par fiche apprise.`

/** Les graphes déjà lus, par projet : on ne relit ni ne rafraîchit le fichier à chaque appel. */
const graphCache = new Map<string, { cle: string; graph: Graph; refreshedAt: number }>()
/** Le projet du flow courant : sa racine rend relatifs les chemins lus. */
let flowRef: ProjectRef | undefined
/** Le projet montré par la dernière commande cache, pour les vues hors flow. */
let shownRef: ProjectRef | undefined
/** Les fiches apprises par l'outil pendant le flow courant : sans elles, une fiche auto sert de filet. */
const learned = { flowId: '', features: [] as string[] }
/** Ce que la notification de fin de flow dit du cache : « fiche x apprise » ou « fiche auto x ». */
let endNote = ''
/** Les sous-agents qui construisent des fiches, par agentId : leur consommation et ce qu'ils ont appris. */
type Builder = { features: string[]; cle: string; nom: string; model: string; tokens: number; costUsd: number; learned: string[] }
const builders = new Map<string, Builder>()
/** Le dernier build lancé : sa ligne de coût dans les vues. */
let lastBuild: CacheStats['build']
/** `revo-flow:cache-indexer` a pu être enregistré ; sinon repli sur general-purpose avec le prompt complet. */
let hasIndexer = false

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const texts = (v: unknown) => (Array.isArray(v) ? v.map(text).filter(Boolean) : [])
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`
const frac = (n: number) => n.toFixed(2).replace('.', ',')

/** Un chemin rendu relatif à la racine du projet (séparateurs « / ») ; rien s'il est ailleurs. */
function relTo(root: string, path: string): string | undefined {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const p = norm(path)
  if (!p) return undefined
  if (r && p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return p.slice(r.length + 1)
  if (!/^([a-z]:)?\//i.test(p)) return p.replace(/^\.\//, '')
  return undefined
}

function keepGraph(graph: Graph, now: number) {
  graphCache.set(graph.projet.cle, { cle: graph.projet.cle, graph, refreshedAt: now })
  return graph
}

/**
 * Le graphe du projet : relu et rafraîchi (hash git) au plus toutes les 30 s, sauf `force`.
 * S'il n'existe pas, la couche mécanique se construit tout de suite avec `build` (moins de 2 s, sans LLM).
 */
async function graphOf($: $, ref: ProjectRef, opt: { build?: boolean; force?: boolean } = {}): Promise<Graph | null> {
  const now = await $.clock.now()
  const held = graphCache.get(ref.cle)
  if (held && !opt.force && now - held.refreshedAt < REFRESH_MS) return held.graph
  let graph = (await loadGraph(ioOf($), ref).catch(() => null)) ?? held?.graph ?? null
  if (graph && isOutdated(graph)) {
    graph = await saveGraph(ioOf($), await buildMechanical(ioOf($), ref, graph))
  } else if (graph) {
    const r = await refreshGraph(ioOf($), graph)
    graph = r.graph
    if (r.changed.length || r.removed.length) graph = await saveGraph(ioOf($), r.graph).catch(() => r.graph)
  } else if (opt.build) {
    graph = await saveGraph(ioOf($), await buildMechanical(ioOf($), ref))
  }
  return graph ? keepGraph(graph, now) : null
}

/** Une fiche d'après son identifiant, son titre ou un alias. */
function findFeature(graph: Graph, id: string): Feature | undefined {
  const s = slug(id)
  if (!s) return undefined
  const all = Object.values(graph.features)
  return graph.features[id] ?? graph.features[s] ?? all.find(f => slug(f.titre) === s || f.alias.some(a => slug(a) === s))
}

/** Le projet du flow courant, retrouvé après un rechargement du module. */
async function flowRefOf($: $, fc: FlowCache | null): Promise<ProjectRef | undefined> {
  if (!fc) return undefined
  if (flowRef?.cle === fc.cle) return flowRef
  const ref = await resolveProject(ioOf($)).catch(() => undefined)
  if (ref?.cle === fc.cle) flowRef = ref
  return flowRef?.cle === fc.cle ? flowRef : undefined
}

/** Les stats des vues, recalculées après chaque changement du flow ou du graphe : le flow courant d'abord. */
async function refreshStats($: $) {
  try {
    const fc = await read($, flowCacheA)
    const cle = fc?.cle ?? shownRef?.cle
    const graph = cle ? (graphCache.get(cle)?.graph ?? null) : null
    const nom = graph?.projet.nom ?? (flowRef?.cle === cle ? flowRef?.nom : shownRef?.nom) ?? ''
    const stats = computeStats(graph, fc, nom)
    await update($, cacheStatsA, () => (stats && lastBuild ? { ...stats, build: lastBuild } : stats))
  } catch {
    // les stats ne doivent jamais gêner le reste
  }
}

/** Ce que le cache vient de servir pendant le flow : fichiers (hits) et tokens injectés. */
async function served($: $, cle: string, hits: readonly CacheHit[], injected: number, feature?: string) {
  const fc = await read($, flowCacheA)
  if (!fc || fc.cle !== cle) return
  await update($, flowCacheA, f =>
    f ? { ...f, servis: [...f.servis, ...hits], injecte: f.injecte + injected, ...(f.feature || !feature ? {} : { feature }) } : f,
  )
  await refreshStats($)
}

/** Un Read réussi pendant le flow : le chemin relatif, sa taille en tokens (ou limit × 12 caractères / 4), qui l'a lu. */
function noteRead($: $, path: string, limit: unknown, who: string) {
  $.clock.after(0, async () => {
    try {
      const fc = await read($, flowCacheA)
      const ref = await flowRefOf($, fc)
      const p = ref ? relTo(ref.racine, path) : undefined
      if (!fc || !ref || !p) return
      const tok = typeof limit === 'number' && limit > 0 ? Math.round((limit * 12) / 4) : await fileTokens(ioOf($), ref.racine, p)
      await update($, flowCacheA, f => (f && f.cle === fc.cle ? { ...f, lus: [...f.lus, { p, tok, par: who }].slice(-500) } : f))
      await refreshStats($)
    } catch {
      // la mesure ne doit jamais gêner l'outil
    }
  })
}

async function registerCacheTool($: $) {
  await $.tool.register({
    name: 'cache',
    description:
      "revo-flow : le cache du projet (graphe des fichiers et fiches de features). Une carte, pas la vérité : vérifie dans le code ce que tu affirmes ou modifies. Actions : chercher (requete : mots-clés → les features et fichiers pertinents, une ligne chacun) ; feature (feature : identifiant → la fiche : résumé, flux, points d'entrée, fichiers et rôles, pièges, fraîcheur) ; voisins (chemin relatif à la racine, profondeur 1 ou 2 → ce que le fichier utilise et qui l'utilise, à essayer avant un grep « qui utilise X ») ; apprendre (feature, titre, alias, resume, flux, entrees, fichiers [{p, role}], pieges [{txt, p}], deps, corrections → enregistre ou complète la fiche, avec les chemins rejetés) ; oublier (feature → supprime la fiche) ; candidates (features repérées sans fiche, avec leur taille). projet : facultatif, nom ou chemin d'un autre projet (défaut : le projet courant).",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['chercher', 'feature', 'voisins', 'apprendre', 'oublier', 'candidates'] },
        projet: { type: 'string', description: 'Nom ou chemin du projet ; le projet courant par défaut' },
        requete: { type: 'string', description: 'chercher : mots-clés' },
        feature: { type: 'string', description: 'feature, apprendre, oublier : identifiant court de la feature (ex. double-session)' },
        chemin: { type: 'string', description: 'voisins : chemin du fichier, relatif à la racine du projet' },
        profondeur: { type: 'number', description: 'voisins : 1 (défaut) ou 2' },
        titre: { type: 'string' },
        alias: { type: 'array', items: { type: 'string' } },
        resume: { type: 'string', description: '600 caractères au plus' },
        flux: { type: 'array', items: { type: 'string' }, description: 'Les étapes, dans l’ordre' },
        entrees: { type: 'array', items: { type: 'string' }, description: 'Points d’entrée : routes, pages, mutations' },
        fichiers: {
          type: 'array',
          items: { type: 'object', properties: { p: { type: 'string' }, role: { type: 'string' } }, required: ['p'] },
        },
        pieges: {
          type: 'array',
          items: { type: 'object', properties: { txt: { type: 'string' }, p: { type: 'string' } }, required: ['txt'] },
        },
        deps: { type: 'array', items: { type: 'string' } },
        corrections: { type: 'array', items: { type: 'string' }, description: 'Ce que le cache disait de faux' },
      },
      required: ['action'],
    },
    isDeferred: false,
  })
}

/** L'agent de construction des fiches : Sonnet medium, en arrière-plan, lecture seule plus l'outil cache. */
async function registerIndexer($: $) {
  // Sans agent.register (API plus ancienne, refus d'un hook), le build retombe sur general-purpose.
  try {
    await $.agent.register({
      name: INDEXER,
      description: 'revo-flow : construit les fiches de features du cache d’un projet (lancé par /revo-flow cache build).',
      prompt: INDEXER_PROMPT,
      tools: ['Read', 'Grep', 'Glob', CACHE_TOOL],
      model: 'sonnet',
      effort: 'medium',
      background: true,
    })
    hasIndexer = true
  } catch {
    hasIndexer = false
  }
}

type CacheCall = Record<string, unknown> & { agentId?: string }

/** L'outil cache : la réponse en texte compact, les hits et les tokens injectés comptés pour le flow. */
async function cacheTool($: $, e: CacheCall): Promise<string> {
  const action = text(e.action).toLowerCase()
  const projet = text(e.projet)
  const ref = await resolveProject(ioOf($), projet || undefined)
  if (!ref) return `revo-flow cache : projet ${projet ? `« ${projet} » ` : 'courant '}introuvable (il faut un dossier suivi par git).`
  const graph = await graphOf($, ref, { build: true })
  if (!graph) return `revo-flow cache : le graphe de ${ref.nom} n’a pas pu être construit (git requis).`
  const flow = await read($, flowA)
  const live = flow && flow.phase !== 'done' ? flow : null
  const builder = e.agentId ? builders.get(e.agentId) : undefined
  const who = (live ? whoIs(live, e.agentId) : undefined) ?? (builder ? BUILDER : (e.agentId ?? 'lead'))
  let answer: string
  let hits: CacheHit[] = []
  let feature: string | undefined
  switch (action) {
    case 'chercher': {
      const q = text(e.requete) || text(e.feature)
      if (!q) return 'revo-flow cache : « requete » manquante (des mots-clés).'
      answer = searchText(graph, q)
      break
    }
    case 'feature': {
      const id = text(e.feature) || text(e.requete)
      const f = findFeature(graph, id)
      if (!f) {
        answer = `Pas de fiche « ${id} » dans le cache de ${ref.nom}.\n${searchText(graph, id)}`
        break
      }
      answer = featureText(graph, f)
      hits = servedFiles(graph, f, who)
      feature = f.id
      break
    }
    case 'voisins': {
      const raw = text(e.chemin)
      if (!raw) return 'revo-flow cache : « chemin » manquant (relatif à la racine du projet).'
      const depth = Math.min(2, Math.max(1, Math.round(Number(e.profondeur) || 1)))
      answer = neighborsText(graph, relTo(ref.racine, raw) ?? raw, depth)
      break
    }
    case 'apprendre':
      return learnTool($, e, ref, graph, live, builder)
    case 'oublier': {
      const f = findFeature(graph, text(e.feature))
      if (!f) return `revo-flow cache : pas de fiche « ${text(e.feature)} » dans ${ref.nom}, rien à oublier.`
      const { [f.id]: _gone, ...rest } = graph.features
      keepGraph(await saveGraph(ioOf($), { ...graph, features: rest }), await $.clock.now())
      await refreshStats($)
      return `revo-flow cache : fiche « ${f.titre} » oubliée.`
    }
    case 'candidates':
      answer = candidatesText(graph)
      break
    default:
      return `revo-flow cache : action « ${action} » inconnue (chercher, feature, voisins, apprendre, oublier, candidates).`
  }
  await served($, ref.cle, hits, tokensOf(answer), feature)
  return answer
}

/** `apprendre` : la fiche est écrite (chemins inconnus rejetés), avec qui l'a apprise, sur quel modèle, à quelle confiance. */
async function learnTool($: $, e: CacheCall, ref: ProjectRef, graph: Graph, live: Flow | null, builder: Builder | undefined) {
  const id = slug(text(e.feature) || text(e.titre))
  if (!id) return 'revo-flow cache : « feature » manquante (identifiant court, ex. double-session).'
  const now = await $.clock.now()
  const isLead = live !== null && !e.agentId
  const modele = e.agentId
    ? (live?.agents.find(a => a.agentId === e.agentId)?.modelId ?? builder?.model)
    : (await read($, leadA)).modelId || (await $.session.model().catch(() => ''))
  const ctx: LearnContext = {
    source: builder ? 'build' : live ? `flow:${live.id}` : 'manuel',
    ...(modele ? { modele } : {}),
    commit: graph.projet.indexe.commit,
    branche: graph.projet.indexe.branche,
    le: new Date(now).toISOString(),
    ...(builder ? { confiance: 0.75 } : isLead ? { confiance: 0.9 } : {}),
  }
  const obj = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [])
  const input: LearnInput = {
    feature: id,
    ...(text(e.titre) ? { titre: text(e.titre) } : {}),
    ...(text(e.resume) ? { resume: text(e.resume) } : {}),
    alias: texts(e.alias),
    flux: texts(e.flux),
    entrees: texts(e.entrees),
    fichiers: obj(e.fichiers)
      .map(f => ({ p: relTo(ref.racine, text(f.p)) ?? text(f.p), ...(text(f.role) ? { role: text(f.role) } : {}) }))
      .filter(f => f.p),
    pieges: obj(e.pieges)
      .map(x => ({ txt: text(x.txt), ...(text(x.p) ? { p: relTo(ref.racine, text(x.p)) ?? text(x.p) } : {}) }))
      .filter(x => x.txt),
    deps: texts(e.deps),
    corrections: texts(e.corrections),
  }
  const { graph: next, rejected } = learn(graph, input, ctx)
  const saved = keepGraph(await saveGraph(ioOf($), next), now)
  if (live) {
    if (learned.flowId !== live.id) Object.assign(learned, { flowId: live.id, features: [] })
    if (!learned.features.includes(id)) learned.features.push(id)
  }
  if (builder && !builder.learned.includes(id)) builder.learned.push(id)
  await refreshStats($)
  const f = saved.features[id]
  return [
    `revo-flow cache : fiche « ${f?.titre ?? id} » apprise (${plural(f?.fichiers.length ?? 0, 'fichier')}).`,
    ...(rejected.length ? [`Chemins rejetés, inconnus du projet : ${rejected.join(', ')}`] : []),
  ].join('\n')
}

/** Au lancement d'un flow : la mesure repart de zéro, puis le brief du cache (avec confirmation si une fiche correspond). */
async function startFlowCache($: $, flowId: string, request: string): Promise<string | undefined> {
  await update($, flowCacheA, () => null)
  Object.assign(learned, { flowId, features: [] })
  endNote = ''
  flowRef = await resolveProject(ioOf($)).catch(() => undefined)
  const ref = flowRef
  if (!ref) {
    await refreshStats($)
    return undefined
  }
  // La mesure (tokens lus) tourne même sans cache : c'est la baseline.
  await update($, flowCacheA, () => ({ cle: ref.cle, servis: [], lus: [], injecte: 0 }))
  if (!opts.cache) return undefined
  const graph = await graphOf($, ref, { build: true }).catch(() => null)
  if (!graph) return undefined
  const m = matchRequest(graph, request)
  let f = m ? graph.features[m.id] : undefined
  if (f) {
    const q = `Je pense qu’il s’agit de « ${f.titre} » (confiance ${frac(freshness(graph, f).confiance)}) : utiliser la fiche du cache ?`
    // Sans personne à qui demander (claude -p), la fiche est utilisée.
    const answer = await $.ui.ask(q, { options: ['Utiliser', 'Ignorer'], header: 'revo-flow' }).catch(() => 'Utiliser')
    if (answer !== 'Utiliser') f = undefined
  }
  const brief = briefText(graph, f)
  const hits = f ? servedFiles(graph, f, 'brief') : []
  await update($, flowCacheA, fc => (fc ? { ...fc, servis: hits, injecte: tokensOf(brief), ...(f ? { feature: f.id } : {}) } : fc))
  await refreshStats($)
  return brief
}

/**
 * Tous les agents ont fini et l'orchestrateur conclut : s'il n'a appelé « apprendre » pour aucune feature,
 * revo-flow écrit une fiche minimale (fichiers modifiés : coeur ; fichiers lus : peripherique). Ce n'est qu'un filet.
 */
async function learnAtEnd($: $, flow: Flow) {
  endNote = ''
  if (!opts.cache) return
  if (learned.flowId === flow.id && learned.features.length) {
    const n = learned.features.length
    endNote = `fiche${n > 1 ? 's' : ''} « ${learned.features.join(' », « ')} » apprise${n > 1 ? 's' : ''}`
    return
  }
  const fc = await read($, flowCacheA)
  const ref = await flowRefOf($, fc)
  if (!fc || !ref) return
  const graph = await graphOf($, ref, { force: true })
  if (!graph) return
  const changed = [...new Set((await read($, entries)).map(x => relTo(ref.racine, x.path)).filter((p): p is string => !!p))]
  const seen = [...new Set(fc.lus.map(l => l.p))].filter(p => !changed.includes(p))
  const files = [...changed.map(p => ({ p, role: 'coeur' })), ...seen.map(p => ({ p, role: 'peripherique' }))]
  if (files.length === 0) return
  const id = fc.feature ?? (slug(flow.title) || `flow-${flow.id}`)
  const now = await $.clock.now()
  const modele = (await read($, leadA)).modelId
  const ctx: LearnContext = {
    source: `flow:${flow.id}`,
    ...(modele ? { modele } : {}),
    commit: graph.projet.indexe.commit,
    branche: graph.projet.indexe.branche,
    le: new Date(now).toISOString(),
    confiance: 0.5,
  }
  keepGraph(await saveGraph(ioOf($), autoFiche(graph, id, files, ctx)), now)
  endNote = `fiche auto « ${id} »`
}

/** Le flow est fini : usages et gains dans le graphe, fiche servie complétée des fichiers lus, baseline des flows sans fiche. */
async function closeFlowCache($: $) {
  const fc = await read($, flowCacheA)
  if (!fc) return
  if (fc.servis.length === 0) {
    const sizes = new Map(fc.lus.map(l => [l.p, l.tok] as const))
    const key = `baseline:${fc.cle}`
    const prev = (await $.store.get(key)) as { flows?: unknown; lus?: unknown } | undefined
    const num = (v: unknown) => (typeof v === 'number' ? v : 0)
    await $.store.set(key, { flows: num(prev?.flows) + 1, lus: num(prev?.lus) + [...sizes.values()].reduce((a, b) => a + b, 0) })
  }
  if (!opts.cache) return
  const ref = await flowRefOf($, fc)
  const graph = ref ? await graphOf($, ref) : null
  if (!graph) return
  let next = recordCacheUsage(graph, fc)
  if (fc.feature && next.features[fc.feature]) next = completeFiche(next, fc.feature, [...new Set(fc.lus.map(l => l.p))])
  keepGraph(await saveGraph(ioOf($), next), await $.clock.now())
  await refreshStats($)
}

/** Rappel après compaction : la fiche servie et les features connues du projet. */
function cacheRecap(fc: FlowCache | null): string | undefined {
  const graph = fc && opts.cache ? graphCache.get(fc.cle)?.graph : undefined
  if (!fc || !graph) return undefined
  const ids = Object.keys(graph.features)
  return `Cache revo-flow (${graph.projet.nom}) : ${fc.feature ? `fiche servie « ${fc.feature} » ; ` : ''}features connues : ${ids.join(', ') || 'aucune'}. Outil ${CACHE_TOOL}.`
}

// ── Commande cache ───────────────────────────────────────────────────────

/** Confirmation par dialogue ; sans personne à qui demander, `fallback`. */
const confirm = ($: $, question: string, yes: string, no: string, fallback: boolean) =>
  $.ui.ask(question, { options: [yes, no], header: 'revo-flow' }).then(
    a => a === yes,
    () => fallback,
  )

const NO_PROJECT = 'revo-flow cache : pas de projet git ici. /revo-flow cache <projet> pour un autre projet.'

/**
 * `/revo-flow cache …` (alias `graphe`). Grammaire stricte : seul, un projet connu, build, clear, ou au plus
 * 3 mots-clés ; sinon rien, et c'est une demande ordinaire (« cache le bouton panier en ES »).
 */
async function cacheCommand($: $, word: string, rest: string): Promise<{ text: string } | undefined> {
  const words = rest ? rest.split(/\s+/) : []
  const head = (words[0] ?? '').toLowerCase()
  if (words.length === 0) return showGraph($, undefined)
  if (head === 'build') return buildCommand($, words.slice(1))
  if (head === 'clear') return clearCommand($, words.slice(1).join(' '))
  if (words.length === 1) {
    const ref = await knownProject($, rest)
    if (ref) return showGraph($, ref)
  }
  if (words.length <= 3 || word === 'graphe') return searchCommand($, rest)
  return undefined
}

/** Un projet connu : un graphe déjà construit, ou un dossier de projet dont le nom est exactement celui-là. */
async function knownProject($: $, name: string): Promise<ProjectRef | undefined> {
  const s = slug(name.split(/[\\/]/).pop() ?? name)
  const known = (await listGraphs(ioOf($)).catch(() => [])).some(g => g.cle === name || slug(g.cle) === slug(name))
  const ref = await resolveProject(ioOf($), name).catch(() => undefined)
  if (!ref) return undefined
  return known || ref.cle === name || slug(ref.nom) === s || ref.racine === name ? ref : undefined
}

async function showGraph($: $, target: ProjectRef | undefined) {
  const ref = target ?? (await resolveProject(ioOf($)).catch(() => undefined))
  if (!ref) return { text: NO_PROJECT }
  const graph = await graphOf($, ref, { build: true })
  if (!graph) return { text: `revo-flow cache : le graphe de ${ref.nom} n’a pas pu être construit (git requis).` }
  shownRef = ref
  const fc = await read($, flowCacheA)
  const stats = computeStats(graph, fc?.cle === ref.cle ? fc : null, ref.nom)
  await update($, cacheStatsA, () => (stats && lastBuild ? { ...stats, build: lastBuild } : stats))
  await update($, cacheOpenA, () => true)
  let isShown = false
  try {
    isShown = (await openPane($)).isPlaced
  } catch {
    // sans panneau, le texte suffit
  }
  const head = `revo-flow cache · ${graph.projet.nom} : ${plural(Object.keys(graph.fichiers).length, 'fichier')}, ${plural(Object.keys(graph.features).length, 'fiche')}${isShown ? ' · détail dans le panneau' : ''}`
  return { text: `${head}\n\n${graphText(graph, stats)}` }
}

async function searchCommand($: $, q: string) {
  const ref = await resolveProject(ioOf($)).catch(() => undefined)
  if (!ref) return { text: NO_PROJECT }
  const graph = await graphOf($, ref, { build: true })
  if (!graph) return { text: `revo-flow cache : le graphe de ${ref.nom} n’a pas pu être construit (git requis).` }
  const m = matchRequest(graph, q)
  const f = m ? graph.features[m.id] : undefined
  return { text: [searchText(graph, q), ...(f ? ['', featureText(graph, f)] : [])].join('\n') }
}

async function clearCommand($: $, feature: string) {
  const ref = await resolveProject(ioOf($)).catch(() => undefined)
  if (!ref) return { text: NO_PROJECT }
  const graph = graphCache.get(ref.cle)?.graph ?? (await loadGraph(ioOf($), ref).catch(() => null))
  if (!graph) return { text: `revo-flow cache : aucun graphe pour ${ref.nom}, rien à supprimer.` }
  if (feature) {
    const f = findFeature(graph, feature)
    if (!f) return { text: `revo-flow cache : pas de fiche « ${feature} » dans ${ref.nom}.` }
    // Sans confirmation possible, rien n'est supprimé.
    if (!(await confirm($, `Supprimer la fiche « ${f.titre} » du cache de ${ref.nom} ?`, 'Supprimer', 'Garder', false))) {
      return { text: 'revo-flow cache : rien n’a été supprimé.' }
    }
    const { [f.id]: _gone, ...rest } = graph.features
    keepGraph(await saveGraph(ioOf($), { ...graph, features: rest }), await $.clock.now())
    await refreshStats($)
    return { text: `revo-flow cache : fiche « ${f.titre} » supprimée de ${ref.nom}.` }
  }
  const n = Object.keys(graph.features).length
  if (!(await confirm($, `Supprimer tout le cache de ${ref.nom} (graphe et ${plural(n, 'fiche')}) ?`, 'Supprimer', 'Garder', false))) {
    return { text: 'revo-flow cache : rien n’a été supprimé.' }
  }
  await deleteGraph(ioOf($), ref.cle)
  graphCache.delete(ref.cle)
  await refreshStats($)
  return { text: `revo-flow cache : cache de ${ref.nom} supprimé (graphe et ${plural(n, 'fiche')}).` }
}

/** La taille d'une feature connue : la somme des tokens de ses fichiers. */
function featureTok(graph: Graph, f: Feature | undefined): number | undefined {
  if (!f) return undefined
  const sizes = f.fichiers.map(x => (graph.fichiers[x.p] as { tok?: unknown } | undefined)?.tok)
  const sum = sizes.reduce<number>((a, t) => a + (typeof t === 'number' ? t : 0), 0)
  return sum > 0 ? sum : undefined
}

/**
 * `cache build` : la couche mécanique, puis les candidates et leur coût. `build <feature>`, `--top N`, `--tout` :
 * un sous-agent en arrière-plan écrit les fiches, après confirmation du coût estimé.
 */
async function buildCommand($: $, args: string[]) {
  const ref = await resolveProject(ioOf($)).catch(() => undefined)
  if (!ref) return { text: NO_PROJECT }
  const now = await $.clock.now()
  if (args.length === 0) {
    const prev = graphCache.get(ref.cle)?.graph ?? (await loadGraph(ioOf($), ref).catch(() => null)) ?? undefined
    const graph = keepGraph(await saveGraph(ioOf($), await buildMechanical(ioOf($), ref, prev)), now)
    shownRef = ref
    await refreshStats($)
    return {
      text: `revo-flow cache · ${ref.nom} : couche mécanique construite (${plural(Object.keys(graph.fichiers).length, 'fichier')}).\n\n${candidatesText(graph)}\n\n/revo-flow cache build <feature> | --top N | --tout : écrire les fiches (sous-agent en arrière-plan).`,
    }
  }
  const graph = await graphOf($, ref, { build: true })
  if (!graph) return { text: `revo-flow cache : le graphe de ${ref.nom} n’a pas pu être construit (git requis).` }
  const flag = (args[0] ?? '').toLowerCase()
  const ranked = [...graph.candidates].sort((a, b) => b.commits - a.commits)
  let targets: { id: string; tok: number }[]
  if (flag === '--top') targets = ranked.slice(0, Math.min(20, Math.max(1, Math.round(Number(args[1]) || 5))))
  else if (flag === '--tout') targets = ranked
  else {
    const name = args.join(' ')
    const c = graph.candidates.find(x => x.id === name || slug(x.id) === slug(name))
    const f = findFeature(graph, name)
    targets = [{ id: c?.id ?? f?.id ?? slug(name), tok: c?.tok ?? featureTok(graph, f) ?? UNKNOWN_TOK }]
  }
  targets = targets.map(t => ({ id: t.id, tok: t.tok }))
  if (targets.length === 0) return { text: `revo-flow cache : aucune candidate à construire pour ${ref.nom}.` }
  const usd = targets.reduce((sum, t) => sum + buildUsd(t.tok), 0)
  const what = targets.length === 1 ? `la fiche « ${targets[0]!.id} »` : `${targets.length} fiches (${targets.map(t => t.id).join(', ')})`
  const warn = flag === '--tout' ? ' --tout est déconseillé : une partie des fiches ne servira jamais.' : ''
  // Sans personne à qui demander, la commande vaut accord : c'est l'utilisateur qui l'a tapée.
  if (!(await confirm($, `Construire ${what} pour ${ref.nom} : ≈ ${euros(usd)} (sous-agent en arrière-plan).${warn} Lancer ?`, 'Construire', 'Annuler', true))) {
    return { text: 'revo-flow cache : construction annulée.' }
  }
  return spawnBuilder($, ref, targets, usd)
}

async function spawnBuilder($: $, ref: ProjectRef, targets: { id: string; tok: number }[], usd: number) {
  // Cache désactivé : l'outil n'a pas été proposé, l'agent en a besoin.
  if (!opts.cache) await registerCacheTool($).catch(() => undefined)
  const ids = targets.map(t => t.id)
  const list = targets.map(t => `- ${t.id} (≈ ${Math.round(t.tok / 1000)}k tokens)`).join('\n')
  const task = [
    targets.length === 1
      ? `Construis la fiche de la feature « ${ids[0]} » du projet « ${ref.nom} » pour le cache revo-flow.`
      : `Construis les fiches de ces features du projet « ${ref.nom} » pour le cache revo-flow, l'une après l'autre :\n${list}`,
    `Racine du projet : ${ref.racine} (les chemins du cache y sont relatifs). Passe projet = "${ref.racine}" à chaque appel de ${CACHE_TOOL}.`,
  ].join('\n')
  const small = targets.every(t => t.tok < 10_000)
  const r = await $.agent.spawn({
    prompt: hasIndexer ? task : `${INDEXER_PROMPT}\n\n${task}`,
    description: `${BUILDER} ${ids.join(' ')}`.slice(0, 80),
    subagentType: hasIndexer ? `${PLUGIN}:${INDEXER}` : 'general-purpose',
    model: small ? 'haiku' : 'sonnet',
  })
  if (r.deny !== undefined) return { text: `revo-flow cache : le sous-agent n’a pas pu partir (${r.deny}).` }
  // Sans agentId (un hook a répondu sans lancer de boucle), rien à suivre : la fiche arrivera quand même par l'outil.
  if (r.agentId) builders.set(r.agentId, { features: ids, cle: ref.cle, nom: ref.nom, model: r.model, tokens: 0, costUsd: 0, learned: [] })
  lastBuild = { feature: ids.join(', '), tokens: 0, costUsd: 0 }
  shownRef = ref
  await refreshStats($)
  watchAgents($)
  return {
    text: `revo-flow cache : construction de ${ids.length === 1 ? `« ${ids[0]} »` : plural(ids.length, 'fiche')} lancée en arrière-plan (${modelLabel(r.model)}, ≈ ${euros(usd)}). Une notification suivra.`,
  }
}

/** Un sous-agent de construction a fini : notification avec les fiches apprises. */
async function endBuilder($: $, agentId: string, failed: boolean) {
  const b = builders.get(agentId)
  if (!b) return
  builders.delete(agentId)
  const n = b.learned.length
  const msg = failed
    ? `cache ${b.nom} : construction en échec${n ? ` (${plural(n, 'fiche')} apprise${n > 1 ? 's' : ''} avant)` : ''}`
    : n
      ? `cache ${b.nom} : fiche${n > 1 ? 's' : ''} « ${b.learned.join(' », « ')} » apprise${n > 1 ? 's' : ''}`
      : `cache ${b.nom} : construction finie sans fiche apprise`
  $.ui.toast(msg)
  await notify($, msg)
  await refreshStats($)
}

/** L'état réel des sous-agents de construction : fini quand Claude Code le dit, ou quand il a quitté la liste. */
async function syncBuilders($: $) {
  if (builders.size === 0) return
  const list = await $.agent.list()
  for (const id of [...builders.keys()]) {
    const info = list.find(x => x.id === id)
    if (!info || ENDED.has(info.status)) await endBuilder($, id, info !== undefined && info.status !== 'completed')
  }
}

// ── Fenêtre latérale ─────────────────────────────────────────────────────

async function isPaneShown($: $) {
  return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
}

const openPane = ($: $) => $.ui.open({ id: PANE, title: 'revo-flow', columns: 56 })

async function viewData($: $): Promise<ViewData> {
  return {
    flow: await read($, flowA),
    lead: await read($, leadA),
    busy: await read($, isBusy),
    entries: await read($, entries),
    tokens: await read($, tokens),
    session: await read($, sessionUsage),
    limits: await read($, limits),
    now: await $.clock.now(),
    lastTurn: await read($, lastTurnA),
    context: await read($, contextA),
    sessionCostUsd: await read($, sessionCostA),
    cache: await read($, cacheStatsA),
    cacheOpen: await read($, cacheOpenA),
  }
}

/** Les boutons du panneau. */
function paneActions($: $): PaneActions {
  return {
    clear: () => update($, entries, () => []),
    stopAll: () => stopAll($),
    stopAgent: key => stopAgent($, key),
    retryAgent: key => retryAgent($, key),
    approvePlan: () => approvePlan($),
    cancelPlan: () => cancelPlan($),
    toggleCache: () => update($, cacheOpenA, v => !v),
  }
}

/** La fenêtre de contexte telle que la barre d'état la lit ; rien tant qu'aucune réponse ne l'a mesurée. */
function contextOf(c: SessionContextUsage): Context | null {
  if (c.tokens === undefined) return null
  return { percent: c.percent ?? Math.round((c.tokens / c.window) * 100), tokens: c.tokens, window: c.window }
}

const ENDED = new Set(['completed', 'failed', 'killed'])

/** Un agent a fini : ses tâches sont closes, son heure de fin notée. */
async function endAgent($: $, key: string, failed: boolean) {
  const now = await $.clock.now()
  await setAgent($, key, x => ({ ...x, status: failed ? 'failed' : 'done', isDoing: false, endedAt: now, tasks: finishTasks(x.tasks, failed) }))
}

/** Tous les agents ont fini pendant l'exécution : l'orchestrateur passe à la vérification. */
const toReview = ($: $) => setFlow($, f => (f.phase === 'running' && allFinished(f) ? { ...f, phase: 'review' } : f))

/**
 * L'état réel des sous-agents, lu auprès de Claude Code : la fin d'un tour ne veut pas dire que l'agent a fini
 * (un agent en arrière-plan termine des tours et continue). Seuls completed, failed ou killed le terminent.
 */
async function syncAgents($: $) {
  await syncBuilders($).catch(() => undefined)
  const flow = await read($, flowA)
  const running = flow?.agents.filter(a => a.agentId && a.status === 'running') ?? []
  if (running.length === 0) return
  const list = await $.agent.list()
  for (const a of running) {
    const info = list.find(x => x.id === a.agentId)
    // Sorti de la liste : on ne le tient pour fini que si son dernier tour s'est terminé.
    const isEnded = info ? ENDED.has(info.status) : a.hasEndedTurn === true
    if (!isEnded) continue
    const failed = (info !== undefined && info.status !== 'completed') || a.tasks.some(t => t.status === 'failed')
    await endAgent($, a.key, failed)
    if (failed) await notify($, `agent « ${a.name} » en échec`)
  }
  await toReview($)
}

// ── Arrêt, relance et validation du plan ─────────────────────────────────

/** Arrête un sous-agent en cours avec TaskStop, comme le modèle le ferait, et le marque en échec. */
async function stopAgent($: $, key: string) {
  const a = (await read($, flowA))?.agents.find(x => x.key === key)
  if (!a || a.status !== 'running') return
  if (a.agentId) {
    try {
      await $.tool.call({ tool: 'TaskStop', task_id: a.agentId })
    } catch {
      // déjà fini, ou plus connu de Claude Code : on le marque quand même
    }
  }
  await endAgent($, key, true)
  await toReview($)
}

/** Arrête tous les agents en cours, puis interrompt le tour de l'orchestrateur s'il tourne. */
async function stopAll($: $) {
  for (const a of (await read($, flowA))?.agents ?? []) if (a.status === 'running') await stopAgent($, a.key)
  const turnId = leadTurnId
  leadTurnId = undefined
  if (turnId) await $.turn.abort({ turnId }).catch(() => undefined)
}

/**
 * Relance un agent : il redevient « en attente » (nouvelle tentative), ses tâches non faites repartent de zéro,
 * et l'orchestrateur reçoit la consigne de le relancer avec l'outil Agent.
 */
async function retryAgent($: $, key: string) {
  const a = (await read($, flowA))?.agents.find(x => x.key === key)
  if (!a) return
  if (a.status === 'running') await stopAgent($, key)
  claimed.delete(key)
  const tasks = a.tasks.map(t => (t.status === 'completed' ? t : { ...t, status: 'pending' as const }))
  await setAgent($, key, ({ agentId: _id, startedAt: _start, endedAt: _end, ...x }) => ({
    ...x,
    status: 'waiting',
    attempts: (x.attempts ?? 1) + 1,
    tasks,
    isDoing: false,
    hasReported: false,
    hasEndedTurn: false,
  }))
  // Le flow n'est plus fini : il repart en exécution.
  await setFlow($, ({ endedAt: _end, ...f }) => ({ ...f, phase: f.phase === 'review' || f.phase === 'done' ? 'running' : f.phase }))
  const left = remainingTasks({ ...a, tasks })
    .map(t => t.title)
    .join(' ; ')
  void $.prompt
    .submit({
      text: `revo-flow : relance l’agent « ${a.name} » avec l’outil Agent (description = son nom exact) pour ses tâches restantes : ${left}`,
      asUser: true,
    })
    .catch(() => undefined)
}

const CANCELLED =
  'revo-flow : plan annulé par l’utilisateur. Demande-lui ce qu’il faut changer, puis propose un nouveau plan avec l’outil plan.'

/** Le plan est refusé : retour à la planification, sans agents. */
async function resetPlan($: $) {
  claimed.clear()
  await setFlow($, f => ({ ...f, phase: 'planning', agents: [], isApproved: false }))
}

/** Bouton « Lancer » : répond au dialogue en attente, sinon valide le plan posé. */
async function approvePlan($: $) {
  if (pendingDecision) return pendingDecision({ isLaunched: true })
  await setFlow($, f => (f.phase === 'dispatch' ? { ...f, isApproved: true } : f))
}

/** Bouton « Annuler » : répond au dialogue en attente, sinon renvoie le plan (pas encore lancé) à la planification. */
async function cancelPlan($: $) {
  if (pendingDecision) return pendingDecision({ isLaunched: false })
  const flow = await read($, flowA)
  if (!flow || flow.phase !== 'dispatch' || flow.agents.some(a => a.agentId)) return
  await resetPlan($)
  void $.prompt.submit({ text: CANCELLED, asUser: true }).catch(() => undefined)
}

/**
 * Demande à l'utilisateur de valider le plan. Le dialogue ou un bouton du panneau répond, le premier des deux.
 * Sans personne à qui demander (-p) ou dialogue fermé, le plan part : la validation ne doit jamais bloquer le flow.
 * Un texte libre (« Other ») vaut refus, transmis au modèle.
 */
function decide($: $, plan: PlanInput): Promise<Decision> {
  return new Promise(resolve => {
    let isSettled = false
    const settle = (d: Decision) => {
      if (isSettled) return
      isSettled = true
      if (pendingDecision === settle) pendingDecision = undefined
      resolve(d)
    }
    pendingDecision = settle
    $.ui.ask(planQuestion(plan), { options: ['Lancer', 'Annuler'], header: 'revo-flow' }).then(
      answer => settle(answer === 'Lancer' ? { isLaunched: true } : answer === 'Annuler' ? { isLaunched: false } : { isLaunched: false, note: answer }),
      () => settle({ isLaunched: true }),
    )
  })
}

function statusText(flow: Flow | null) {
  if (!flow) return 'revo-flow : aucun flow en cours. Lance /revo-flow <ta demande>.'
  const head = `revo-flow · ${flow.title} — ${flow.phase === 'planning' ? 'planification' : flow.phase === 'done' ? 'terminé' : `${flowPercent(flow)} %`}`
  const rows = flow.agents.map(a => {
    const p = progress(a.tasks, a.status, a.status === 'running')
    return `  ${a.name} (${MODELS[a.model].label} · ${a.effort}) ${p.count}${p.label ? ` — ${p.label}` : ''} [${a.status}]`
  })
  return [head, ...rows].join('\n')
}

function readOptions(o: PluginOptions) {
  opts.validerPlan = o.validerPlan !== false
  opts.conflits = o.conflits === 'refuser' ? 'refuser' : 'avertir'
  opts.notifier = o.notifier !== false
  opts.cache = o.cache !== false
}

// ── Les hooks ────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  readOptions(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'revo-flow',
      description:
        'revo-flow <demande> : l’orchestrateur lit les specs, fait le plan, répartit les tâches entre des sous-agents et suit chacun dans le panneau · statut · panneau · stop · cache [projet | build [feature | --top N | --tout] | clear [feature] | mot-clé] : le graphe et les fiches de features du projet',
      argumentHint: '<demande> | statut | panneau | stop | cache [projet | build [feature|--top N|--tout] | clear [feature] | mot-clé]',
      // statut, panneau, stop et cache répondent tout de suite, même pendant un tour ; une nouvelle demande part
      // par prompt.submit, qui attend de toute façon que la session soit libre.
      immediate: true,
    })
    // Les outils ne sont déclarés qu'au premier /revo-flow ; après un rechargement en plein flow, on les redéclare.
    if (await read($, flowA)) await registerTools($)
    // L'outil cache, lui, est là dès le début : l'orchestrateur, ses agents et l'agent de construction s'en servent.
    if (opts.cache) await registerCacheTool($).catch(() => undefined)
    await registerIndexer($)
    await migrate($)
    await purge($)
    await loadTokens($)
    const usage = await $.session.usage()
    await update($, limits, () => usage.rateLimits.map(l => ({ ...l })))
    await update($, contextA, () => contextOf(usage.context))
    await update($, sessionCostA, () => usage.cost?.usd ?? 0)
    watchAgents($)
    return next(e)
  })

  on('command.run', { command: 'revo-flow' }, async ($, e) => {
    const args = e.args.trim()
    const word = args.toLowerCase()
    const flow = await read($, flowA)

    if (!args || word === 'statut' || word === 'status') return { text: statusText(flow) }
    if (word === 'stop') {
      let isStopped = false
      if (flow?.agents.some(a => a.status === 'running')) {
        // Sans personne à qui demander, on arrête tout : c'est ce que « stop » veut dire.
        const answer = await $.ui
          .ask('Des agents revo-flow tournent encore. Les arrêter ?', { options: ['Tout arrêter', 'Garder les agents'], header: 'revo-flow' })
          .catch(() => 'Tout arrêter')
        isStopped = answer !== 'Garder les agents'
      } else isStopped = flow !== null && leadTurnId !== undefined
      if (isStopped) await stopAll($)
      await update($, flowA, () => null)
      if (await isPaneShown($)) await $.ui.close({ id: PANE })
      return {
        text: isStopped
          ? 'revo-flow : flow arrêté, agents et orchestrateur interrompus ; barre et panneau retirés.'
          : 'revo-flow : flow arrêté, barre et panneau retirés. Les agents déjà lancés continuent jusqu’au bout.',
      }
    }
    if (word === 'panneau') {
      if (await isPaneShown($)) {
        await setFlow($, f => ({ ...f, isPaneClosed: true }))
        await $.ui.close({ id: PANE })
        return { text: 'revo-flow : panneau masqué. /revo-flow panneau pour le rouvrir.' }
      }
      await setFlow($, f => ({ ...f, isPaneClosed: false }))
      const opened = await openPane($)
      return { text: opened.isPlaced ? 'revo-flow : panneau affiché.' : `revo-flow : panneau en attente (${opened.reason}).` }
    }
    // `cache …` / `graphe …` : le cache projet. Hors de la grammaire stricte, c'est une demande ordinaire.
    const cmd = /^(cache|graphe)(?:\s+([\s\S]*))?$/i.exec(args)
    if (cmd) {
      try {
        const done = await cacheCommand($, cmd[1]!.toLowerCase(), (cmd[2] ?? '').trim())
        if (done) return done
      } catch (err) {
        return { text: `revo-flow cache : ${errText(err)}` }
      }
    }

    watchAgents($)
    // Une nouvelle demande : le panneau s'ouvre sur « En attente du plan d'exécution » ; les agents n'y entrent qu'avec le plan.
    await registerTools($)
    if (opts.cache) await registerCacheTool($).catch(() => undefined)
    const now = await $.clock.now()
    const { project, branch } = await projectHeader($)
    claimed.clear()
    await update($, flowA, () => ({
      id: String(now),
      request: args,
      title: draftTitle(args),
      summary: '',
      project,
      branch,
      phase: 'planning' as const,
      startedAt: now,
      agents: [],
    }))
    const model = await $.session.model()
    await update($, leadA, () => ({ ...LEAD0, modelId: model }))
    await update($, entries, () => [])
    try {
      if (!(await isPaneShown($))) await openPane($)
    } catch {
      // le panneau ne doit jamais bloquer la demande
    }
    // Le brief du cache (si une fiche correspond, après confirmation) ; sans graphe possible, on continue sans.
    const brief = await startFlowCache($, String(now), args).catch(() => undefined)
    // Le rôle d'orchestrateur est une note cachée laissée au modèle par la commande ; la demande part ensuite
    // comme si l'utilisateur l'avait tapée. Sans /revo-flow, rien de tout cela n'est ajouté.
    $.clock.after(0, () => void $.prompt.submit({ text: args, asUser: true }).catch(() => undefined))
    return {
      text: `revo-flow : ${modelLabel(model)} lit la demande et les specs, puis prépare le plan et l’équipe d’agents…`,
      context: brief ? [LEAD_BRIEF, brief] : [opts.cache ? LEAD_BRIEF : leadBrief(false)],
    }
  })

  on('turn.start', async ($, e, next) => {
    // Le dernier tour de l'orchestrateur se compte même hors flow : la ligne de fin de tour en a besoin.
    if (e.agentId === undefined) {
      leadTurnId = e.turnId
      const at = await $.clock.now()
      await update($, lastTurnA, () => ({ at, durationMs: 0, tokens: EMPTY, modelId: '', costUsd: 0, isLive: true }))
    }
    if (await read($, flowA)) await update($, isBusy, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (leadTurnId === e.turnId) leadTurnId = undefined
      const at = await $.clock.now()
      // La fin du tour fait foi : son usage (toutes requêtes comprises) remplace le cumul, s'il est connu.
      const u = e.usage
      await update($, lastTurnA, t => ({
        at: t?.at ?? at - e.durationMs,
        durationMs: e.durationMs,
        isLive: false,
        tokens: u ? addUsage(EMPTY, u) : (t?.tokens ?? EMPTY),
        costUsd: u ? costUsd(u.model, u) : (t?.costUsd ?? 0),
        modelId: u?.model ?? t?.modelId ?? '',
      }))
    }
    // Un sous-agent de construction de fiches : fini seulement quand Claude Code le dit.
    if (e.agentId && builders.has(e.agentId)) {
      await syncBuilders($).catch(() => undefined)
      return next(e)
    }
    const flow = await read($, flowA)
    if (!flow) {
      if (!e.agentId) await update($, isBusy, () => false)
      return next(e)
    }
    if (e.agentId) {
      const a = flow.agents.find(x => x.agentId === e.agentId)
      if (a) {
        await setAgent($, a.key, x => ({ ...x, hasEndedTurn: true, isDoing: false }))
        await syncAgents($)
      }
      return next(e)
    }
    await update($, isBusy, () => false)
    // Interrompu avant même le plan : il n'y a rien à suivre, le flow est abandonné.
    if (e.reason === 'aborted' && flow.phase === 'planning') {
      await update($, flowA, () => null)
      $.ui.toast('revo-flow : flow annulé')
      return next(e)
    }
    await update($, leadA, l => ({ ...l, isDoing: false }))
    await syncAgents($)
    // L'orchestrateur a fini son tour après que tous les agents ont fini : c'était sa conclusion.
    const now = await read($, flowA)
    if (now && (now.phase === 'review' || now.phase === 'running') && allFinished(now)) {
      // Sans « apprendre » pendant le flow, une fiche minimale automatique (le filet), puis la fin.
      await learnAtEnd($, now).catch(() => undefined)
      await finishFlow($)
    }
    return next(e)
  })

  // Chaque requête : l'effort choisi pour le sous-agent, et les tokens attribués à qui les a consommés.
  on('turn.step', async function* ($, e, next) {
    const flow = await read($, flowA)
    const a = flow && e.agentId ? flow.agents.find(x => x.agentId === e.agentId) : undefined
    // Un modèle sans effort n'en reçoit pas : on ne fixe l'effort que là où la requête en porte un.
    const step = a && e.effort !== undefined ? { ...e, effort: a.effort } : e
    const r = yield* next(step)
    try {
      const u = r.usage ?? undefined
      await recordUsage($, u)
      if (u && !e.agentId) {
        await update($, lastTurnA, t =>
          t?.isLive ? { ...t, modelId: step.model, tokens: addUsage(t.tokens, u), costUsd: t.costUsd + costUsd(step.model, u) } : t,
        )
      }
      const b = u && e.agentId ? builders.get(e.agentId) : undefined
      if (b && u) {
        // Un sous-agent de construction : ses tokens et son coût, pour la ligne « build » des vues.
        b.tokens += total(addUsage(EMPTY, u))
        b.costUsd += costUsd(step.model, u)
        b.model = step.model
        lastBuild = { feature: b.features.join(', '), tokens: b.tokens, costUsd: b.costUsd }
        await refreshStats($)
      }
      if (flow && u) {
        if (!e.agentId) {
          await update($, leadA, l => ({
            ...l,
            modelId: step.model,
            ...(step.effort !== undefined ? { effort: String(step.effort) } : {}),
            tokens: addUsage(l.tokens, u),
            costUsd: l.costUsd + costUsd(step.model, u),
          }))
        } else if (a) {
          const now = await $.clock.now()
          await setAgent($, a.key, x => ({
            ...x,
            hasEndedTurn: false,
            lastActiveAt: now,
            modelId: step.model,
            tokens: addUsage(x.tokens, u),
            costUsd: x.costUsd + costUsd(step.model, u),
          }))
        }
      }
    } catch {
      // le comptage ne doit jamais gêner le tour
    }
    return r
  })

  // Un sous-agent lancé par l'orchestrateur : son modèle, et ses tâches ajoutées à son prompt.
  on('agent.spawn', async ($, e, next) => {
    // L'agent de construction des fiches du cache : ni refusé avant le plan, ni inscrit dans le flow.
    if ([e.description, e.name ?? ''].some(s => s.startsWith(BUILDER)) || e.subagentType === `${PLUGIN}:${INDEXER}`) return next(e)
    const flow = await read($, flowA)
    if (!flow || e.fork || e.workflow || e.isTeammate || e.parentAgentId) return next(e)
    // Pas d'agent avant le plan : l'orchestrateur lit les specs lui-même, pose le plan, puis lance l'équipe.
    if (flow.phase === 'planning') {
      return {
        deny: `revo-flow : aucun sous-agent avant le plan. Lis les specs toi-même, appelle ${PLAN_TOOL}, puis lance les agents prévus.`,
      }
    }
    if (flow.phase === 'dispatch' && !flow.isApproved) {
      return { deny: 'revo-flow : le plan attend la validation de l’utilisateur. Attends sa réponse avant de lancer les agents.' }
    }
    const a = matchAgent(
      flow.agents.filter(x => !claimed.has(x.key)),
      e.description,
      e.name,
    )
    if (!a) return next(e)
    claimed.add(a.key)
    const r = await next({ ...e, model: MODELS[a.model].id, prompt: `${e.prompt}\n\n${agentBrief(a, opts.cache)}` })
    if (r.deny !== undefined || !r.agentId) {
      claimed.delete(a.key)
      return r
    }
    const agentId = r.agentId
    const now = await $.clock.now()
    await setAgent($, a.key, x => ({
      ...x,
      agentId,
      modelId: r.model,
      status: 'running',
      startedAt: now,
      lastActiveAt: now,
      attempts: x.attempts ?? 1,
    }))
    await setFlow($, f => (f.phase === 'dispatch' ? { ...f, phase: 'running' } : f))
    // L'exécution commence : c'est maintenant que le panneau s'ouvre.
    try {
      const shown = await read($, flowA)
      if (shown && !shown.isPaneClosed && !(await isPaneShown($))) await openPane($)
    } catch {
      // le panneau ne doit jamais gêner le lancement
    }
    return r
  })

  // L'orchestrateur pose son plan : les agents, leur modèle, leur effort et leurs tâches. Selon l'option
  // « validerPlan », l'utilisateur le valide avant que l'outil ne réponde : aucun agent ne part sans son accord.
  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    const flow = await read($, flowA)
    if (!flow) return { deny: 'revo-flow : aucun flow en cours. L’utilisateur doit lancer /revo-flow <demande>.' }
    if (e.agentId) return { deny: 'revo-flow : seul l’orchestrateur pose le plan.' }
    if (flow.agents.some(a => a.agentId)) return { deny: 'revo-flow : le plan est déjà en cours d’exécution, il ne peut plus être remplacé.' }
    const parsed = parsePlan(e as unknown as Record<string, unknown>)
    if ('error' in parsed) return { deny: `Plan refusé : ${parsed.error}` }
    const { plan } = parsed
    claimed.clear()
    await setFlow($, f => ({
      ...f,
      title: plan.title,
      summary: plan.summary,
      phase: 'dispatch',
      isApproved: !opts.validerPlan,
      agents: plan.agents.map(a => ({ ...a, status: 'waiting' as const, tokens: EMPTY, costUsd: 0 })),
    }))
    if (opts.validerPlan) {
      const d = await decide($, plan)
      if (!d.isLaunched) {
        await resetPlan($)
        return { result: (d.note ? `${CANCELLED} Sa réponse : « ${d.note} »` : CANCELLED) as never }
      }
      await setFlow($, f => ({ ...f, isApproved: true }))
    }
    return { result: dispatchText(plan) as never }
  }).catch(() => ({ deny: 'revo-flow : le plan n’a pas pu être enregistré, réessaie.' }))

  // Un sous-agent signale une tâche : sa barre avance.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { tache?: unknown; statut?: unknown; agent?: unknown }
    const flow = await read($, flowA)
    const a = flow?.agents.find(x => (e.agentId ? x.agentId === e.agentId : x.key === slug(String(input.agent ?? ''))))
    if (!a) return { result: 'revo-flow : pas de liste de tâches revo-flow pour cet agent, rien à suivre.' as never }
    const n = Number(input.tache)
    const statut = String(input.statut ?? 'en_cours')
    const tasks = applyStep(a.tasks, n, statut)
    if (!tasks) return { deny: `revo-flow : « tache » doit être un numéro entre 1 et ${a.tasks.length}.` }
    await setAgent($, a.key, x => ({ ...x, tasks, hasReported: true }))
    return { result: `ok — tâche ${Math.round(n)}/${a.tasks.length} (${tasks[Math.round(n) - 1]!.title}) : ${statut}` as never }
  }).catch(() => ({ result: 'revo-flow : suivi indisponible, continue tes tâches.' as never }))

  // L'outil cache : autorisé en planification et hors flow ; aucune exception ne remonte, l'erreur est dite en texte.
  on('tool.call', { tool: CACHE_TOOL }, async ($, e) => {
    try {
      return { result: (await cacheTool($, e as unknown as CacheCall)) as never }
    } catch (err) {
      return { result: `revo-flow cache : ${errText(err)}` as never }
    }
  }).catch(() => ({ result: 'revo-flow cache : indisponible pour l’instant, continue sans.' as never }))

  // L'agent de construction n'est lancé que par /revo-flow cache build : le modèle ne le voit pas.
  on('agent.offer', { agent: `${PLUGIN}:${INDEXER}` }, () => ({ isOffered: false }))

  // Ce que chacun fait en direct, et les fichiers modifiés : seulement pendant un flow.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool === PLAN_TOOL || tool === STEP_TOOL) return next(e)
    const flow = await read($, flowA)
    const who = flow && flow.phase !== 'done' ? whoIs(flow, e.agentId) : undefined
    if (!who) return next(e)
    const input = e as unknown as Record<string, unknown>
    const label = describeCall(tool, input)
    const isEdit = tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit'
    const path = isEdit ? String(input.file_path ?? input.notebook_path ?? '') : ''
    if (path) {
      const deny = await checkConflict($, path, who).catch(() => undefined)
      if (deny) return { deny }
    }
    try {
      await setActivity($, who, { doing: label, isDoing: true, filePath: path, reason: path ? '…' : '' })
      if (who !== 'lead') {
        const now = await $.clock.now()
        await setAgent($, who, a => ({ ...a, lastActiveAt: now }))
      }
    } catch {
      // le suivi ne doit jamais gêner l'outil
    }

    const ran = await next(e)
    const failed = ran.deny !== undefined || ran.isError === true
    try {
      const done = failed ? `✗ ${label}` : label
      const prev = who === 'lead' ? await read($, leadA) : (await read($, flowA))?.agents.find(a => a.key === who)
      await setActivity($, who, { isDoing: false, history: [...(prev?.history ?? []), done].slice(-3) })
      if (!failed && path) await markFile($, path, who, e.tool_use_id, e.agentId)
      // La mesure du cache : ce qui est réellement lu pendant le flow, hors du chemin de l'outil.
      if (!failed && tool === 'Read' && typeof input.file_path === 'string') noteRead($, input.file_path, input.limit, who)
      // Un agent qui tient un TodoWrite calqué sur sa liste, sans passer par l'outil step : on suit quand même.
      if (!failed && tool === 'TodoWrite' && who !== 'lead') {
        await setAgent($, who, a => {
          const tasks = a.hasReported ? undefined : applyTodos(a.tasks, input.todos)
          return tasks ? { ...a, tasks } : a
        })
      }
    } catch {
      // idem
    }
    return ran
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await update($, limits, () => e.rateLimits.map(l => ({ ...l })))
    if (e.changed.includes('context')) await update($, contextA, () => contextOf(e.context))
    if (e.changed.includes('cost') && e.cost) {
      const usd = e.cost.usd
      await update($, sessionCostA, () => usd)
    }
    return next(e)
  })

  // Après une compaction de la conversation principale, en plein flow : le résumé peut perdre le rôle
  // d'orchestrateur et l'état des agents ; on les rajoute en fin de conversation, comme un message de l'utilisateur.
  // precompute n'installe rien : la compaction qui reprendra ce résultat repassera par ici.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute' || !r.messages) return r
    const flow = await read($, flowA)
    if (!flow || flow.phase === 'done') return r
    const recap = flowRecap(flow, opts.cache ? cacheRecap(await read($, flowCacheA)) : false)
    return { ...r, messages: [...r.messages, { role: 'user' as const, text: recap, toolUses: [] }] }
  })

  // Fermé par la croix ou Échap : on ne le rouvre plus tout seul pendant ce flow.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await setFlow($, f => ({ ...f, isPaneClosed: true }))
    return next(e)
  })

  // La barre dans le chat : les étapes de l'orchestrateur et l'avancement global, seulement pendant un flow.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, flowA))) return next(e)
    const d = await viewData($)
    if (e.surface === 'desktop' || e.surface === 'vscode') {
      return DesktopBand($.ui.resolve(e) as unknown as Elements['desktop'], d, pixels(e.props.bodyColumns)) ?? next(e)
    }
    if (e.surface === 'mobile') return MobileBand($.ui.resolve(e) as unknown as Elements['mobile'], d, pixels(e.props.bodyColumns)) ?? next(e)
    if (e.surface === 'terminal') return TerminalBand($.ui.resolve(e) as unknown as Elements['terminal'], d) ?? next(e)
    return next(e)
  })

  // Le panneau : l'orchestrateur et chaque sous-agent avec sa propre barre, les fichiers, la consommation.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const d = await viewData($)
    const actions = paneActions($)
    if (e.surface === 'desktop' || e.surface === 'vscode') {
      return DesktopPane($.ui.resolve(e) as unknown as Elements['desktop'], d, actions, e.props.bodyColumns)
    }
    if (e.surface === 'mobile') return MobilePane($.ui.resolve(e) as unknown as Elements['mobile'], d, actions, e.props.bodyColumns)
    if (e.surface === 'terminal') return TerminalPane($.ui.resolve(e) as unknown as Elements['terminal'], d, actions)
    return next(e)
  })

  // La ligne de fin de tour (« Baked for 3s ») : durée, tokens et coût du dernier tour de l'orchestrateur.
  // Elle n'a pas d'identifiant de tour : seule celle dont la durée est celle du dernier tour est remplacée,
  // les lignes des tours précédents restent celles du moteur.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const lastTurn = await read($, lastTurnA)
    if (!lastTurn || lastTurn.isLive || Math.abs(lastTurn.durationMs - e.props.durationMs) > 1500) return next(e)
    const d = await viewData($)
    const props = { word: e.props.word, durationMs: e.props.durationMs }
    return TerminalTurnLine($.ui.resolve(e) as unknown as Elements['terminal'], d, props) ?? next(e)
  })
}
