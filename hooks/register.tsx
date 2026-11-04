/**
 * Le cœur du mod : commande /revo-flow, outils plan, step, cache et verif, suivi des agents (lancement, attente, relance, arrêt),
 * vérification du flow (commandes confirmées, base de référence, porte de fin, tests gelés, vérificateur) et rendu du panneau.
 */
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, PluginOptions, Register, SessionContextUsage } from 'claude-code'

import type { Activity, Context, Flow, FlowAgent, Lead } from '../types'
import type { AgentDef, CatalogueIo } from '../types/agents'
import type { AgentInfo, CacheHit, CacheStats, DiffEntry, Feature, FlowCache, Graph, LearnContext, LearnInput, PerimeEntry } from '../types/cache'
import type {
  Critere,
  CritereVerdict,
  ProjetVerif,
  TestGele,
  Triche,
  VerifCommande,
  VerifEtatCommande,
  VerifFormat,
  VerifJournal,
  VerifMode,
  VerifOutil,
  VerifPortee,
  VerifResultat,
  VerifView,
  WebEtat,
  WebServeur,
  WebView,
  Appareil,
  MobileApp,
  MobileEtat,
  MobileView,
} from '../types/verif'
import {
  agentExtract,
  autoFiche,
  briefText,
  candidatesText,
  completeFiche,
  computeStats,
  diffText,
  extractFiles,
  featureText,
  freshness,
  graphText,
  isDraft,
  learn,
  matchRequest,
  matchZone,
  neighborHits,
  neighborsText,
  parseRerank,
  perimeOf,
  recordUsage as recordCacheUsage,
  refreshFiles,
  rerankPrompt,
  resolveKey,
  sameHash,
  searchHits,
  searchText,
  servedFiles,
  servedSubset,
  tokensOf,
} from './cache/graph'
import { catalogue, catalogueBrief, trouveAgent } from './agents/catalogue'
import {
  buildMechanical,
  deleteGraph,
  diffSince,
  fileTokens,
  isOutdated,
  listGraphs,
  loadGraph,
  normalizePath,
  parseStatus,
  refreshGraph,
  resolveProject,
  saveGraph,
  withDrift,
  type Io,
} from './cache/store'
import {
  CACHE_TOOL,
  EMPTY,
  MODELS,
  PLAN_TOOL,
  PLUGIN,
  STEP_TOOL,
  VERIFIER_TYPE,
  VERIF_TOOL,
  addUsage,
  agentBrief,
  allFinished,
  applyStep,
  applyTodos,
  bashReadFile,
  costUsd,
  dayKey,
  describeCall,
  dispatchText,
  draftTitle,
  euros,
  findAgent,
  finishTasks,
  firstSentence,
  pauseTasks,
  leadBrief,
  flowPercent,
  flowRecap,
  fmtDuration,
  isTally,
  isTester,
  isVerifier,
  matchAgent,
  modelLabel,
  parsePlan,
  planMarkdown,
  planQuestion,
  progress,
  remainingTasks,
  shortPath,
  slug,
  total,
  weekKey,
  addToJournal,
  historyText,
  type AgentCache,
  type JournalEntry,
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
} from './ui/views'
import { rapportMarkdown } from './rapport'
import { doctorText, manifestsOf, pluginVersion, versionText } from './doctor'
import { addBase, baseFor } from './verif/base'
import { CRAP_SEUIL } from './verif/crap'
import { MANIFESTES, SONDES, commandsQuestion, detectCommands, flutterVersionTrap, fvmVersion, manifestPaths, needsConfirm, withoutCrap } from './verif/detect'
import {
  TESTER_BRIEF,
  VERIFIER_PROMPT,
  detectCheats,
  freeze,
  frozenDenial,
  isTestFile,
  parseVerdicts,
  rehash,
  testerDenial,
  unfreeze,
  verifierBashAllowed,
  verifierTask,
} from './verif/garde'
import { reportText, summaryLine } from './verif/report'
import { purgeOutputs, runBase, runGate, type VerifIo } from './verif/runner'
import { hasGenAnnotation, withShell } from './verif/scope'
import {
  WEB_ATTENTE_MS,
  WEB_MANIFESTES,
  capturePath,
  commandeText,
  detectDevServer,
  extractPng,
  isScreenshotCall,
  isWebTool,
  portFatalInOutput,
  sansAnsi,
  urlFromOutput,
  verifierWebTask,
  webToolDenial,
  type WebDispo,
} from './verif/web'
import {
  EMULATEUR_ATTENTE_MS,
  EMULATEUR_SONDE_MS,
  MOBILE_ATTENTE_MS,
  MOBILE_MANIFESTES,
  MOBILE_MCP,
  MOBILE_SONDES,
  appFailedFromOutput,
  appReadyFromOutput,
  bootedDevice,
  captureCommands,
  commandeMobile,
  condenseUiTree,
  countIssues,
  detectMobileApp,
  deviceLabel,
  frameworkLabel,
  gestureCommand,
  isMobileMcpTool,
  launchCommands,
  listCommands,
  logCommand,
  mergeDevices,
  mobileToolDenial,
  rankDevices,
  runCommand,
  shutdownCommand,
  tailLines,
  treeCommands,
  verifierMobileTask,
  type MobileDispo,
} from './verif/mobile'
import { SNAPSHOT_PREFIX, isBeforeLaunch, isUnfinished, readSnapshot, resumeQuestion, resumedFlow, snapshotKey, snapshotOf, type FlowSnapshot } from './reprise'

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
const verifA = atom({ plugin: 'revo-flow', key: 'verif' } as const, null)
const verifFlowA = atom({ plugin: 'revo-flow', key: 'verifFlow' } as const, null)

/** Les options du plugin (userConfig), fixées pour ce chargement : un changement recharge le module. */
const opts = {
  validerPlan: true,
  conflits: 'avertir' as 'avertir' | 'refuser',
  notifier: true,
  cache: true,
  verif: 'bloquer' as VerifMode,
  crap: true,
  agents: true,
  web: 'extension' as 'extension' | 'devtools' | 'off',
  mobile: 'appareil' as 'appareil' | 'mcp' | 'off',
}

/** L'outil mobile de la preuve mobile (v3.1) : capture, arbre, journal, gestes, réservé au vérificateur. */
const MOBILE_TOOL = `mcp__${PLUGIN}__mobile`

/** Les agents installés sur ce Claude Code (projet, dossier personnel, plugins), lus au lancement du flow ; vide sans l'option agents. */
let agentsInstalles: AgentDef[] = []
/** Les types que le plan accepte toujours, catalogue ou non : les natifs de Claude Code et le vérificateur. */
const BASE_TYPES = ['general-purpose', 'Explore', 'Plan', 'claude-code-guide', VERIFIER_TYPE] as const

/** Les agents prévus déjà attribués à un appel Agent : deux lancements en parallèle ne prennent jamais le même. */
const claimed = new Set<string>()
/** Le tour en cours de l'orchestrateur, pour pouvoir l'interrompre ($.turn.abort ne prend que celui-là). */
let leadTurnId: string | undefined
/** Les éclaireurs (Explore avant le plan) : hors des agents prévus, leurs tokens et leur coût comptent pour l'orchestrateur. */
const scouts = new Set<string>()
/** Les tours de l'orchestrateur interrompus par stopAll : leur fin appartient à l'ancien flow, pas à celui qui l'a remplacé. */
const stoppedTurns = new Set<string>()
/** La validation du plan en attente : les boutons du panneau peuvent y répondre à la place du dialogue. */
let pendingDecision: ((d: Decision) => void) | undefined
/** La réponse à la validation du plan ; note = ce que l'utilisateur a tapé à la place d'un choix. */
type Decision = { isLaunched: boolean; note?: string }
/** Le dialogue de validation ouvert : sa question, et le plan en markdown à montrer en aperçu à côté des choix. */
let pendingPreview: { question: string; markdown: string } | undefined
/** La vérification périodique de l'état des agents tourne-t-elle déjà (une par chargement du module) ? */
let isWatching = false

function watchAgents($: $) {
  if (isWatching) return
  isWatching = true
  $.clock.every(3000, () => void syncAgents($).then(() => tick($)).catch(() => undefined))
}

/** Un agent au travail sans aucune requête depuis ce délai : prévenu une fois (toast et notification). */
const IDLE_WARN_MS = 180_000
/** Les agents déjà signalés inactifs (agentId), pour ne prévenir qu'une fois par silence. */
const idleWarned = new Set<string>()
/** La dernière ligne d'état posée, pour ne la réécrire que si elle change. */
let statusLine: string | undefined

/**
 * Toutes les 3 s : les durées et « inactif depuis » avancent seules (redessin tant qu'un agent tourne), un agent
 * silencieux depuis IDLE_WARN_MS est signalé une fois, et la ligne d'état sous le prompt suit le flow.
 */
async function tick($: $) {
  const flow = await read($, flowA)
  const running = flow?.agents.filter(a => a.status === 'running') ?? []
  if (running.length) $.ui.invalidate('ui.render')
  const now = await $.clock.now()
  for (const a of running) {
    if (!a.agentId || a.lastActiveAt === undefined) continue
    if (now - a.lastActiveAt < IDLE_WARN_MS) {
      idleWarned.delete(a.agentId)
      continue
    }
    if (idleWarned.has(a.agentId)) continue
    idleWarned.add(a.agentId)
    $.ui.toast(`revo-flow : « ${a.name} » inactif depuis ${fmtDuration(now - a.lastActiveAt)}`, { timeoutMs: 10_000 })
    await notify($, `« ${a.name} » inactif depuis ${fmtDuration(now - a.lastActiveAt)} : bloqué ? /revo-flow statut, ou Arrêter dans le panneau`)
  }
  // Pendant une commande de vérification, sa ligne passe devant celle du flow.
  const line = verifStatus ?? (flow && flow.phase !== 'done' ? await statusOf($, flow, running.length) : undefined)
  if (line !== statusLine) {
    statusLine = line
    $.ui.status(line)
  }
}

/** La ligne d'état sous le prompt : « revo-flow · titre · 62 % · 3 actifs · 0,41 € ». */
async function statusOf($: $, flow: Flow, running: number) {
  const cost = (await read($, leadA)).costUsd + flow.agents.reduce((n, a) => n + a.costUsd, 0)
  const step = flow.phase === 'planning' ? 'plan en préparation' : flow.phase === 'dispatch' ? 'plan à valider' : `${flowPercent(flow)} %`
  return `revo-flow · ${flow.title} · ${step}${running ? ` · ${running} actif${running > 1 ? 's' : ''}` : ''} · ${euros(cost)}`
}

// ── Flow ─────────────────────────────────────────────────────────────────

function setFlow($: $, change: (f: Flow) => Flow) {
  return update($, flowA, f => (f ? change(f) : f)).finally(() => void saveFlow($).catch(() => undefined))
}

/** La clé du dernier instantané écrit par ce module : effacée quand son flow finit, est arrêté ou remplacé. */
let savedId: string | undefined
/** Une écriture de l'instantané en cours ; again : le flow a encore changé pendant, une écriture de plus suffira. */
const saving = { isBusy: false, again: false }

/**
 * L'instantané du flow dans le store (reprise après redémarrage, reprise.ts) : réécrit à chaque changement du flow, effacé quand
 * il passe en done, est arrêté ou remplacé. Les écritures ne se chevauchent pas : celles demandées pendant une écriture n'en
 * font qu'une, avec l'état le plus récent.
 */
async function saveFlow($: $) {
  if (saving.isBusy) {
    saving.again = true
    return
  }
  saving.isBusy = true
  try {
    do {
      saving.again = false
      const flow = await read($, flowA)
      const live = flow && flow.phase !== 'done' && !flow.isStopped ? flow : null
      if (savedId && savedId !== live?.id) {
        await $.store.delete(snapshotKey(savedId))
        savedId = undefined
      }
      if (!live) continue
      const more = { verif: await read($, verifA), verifFlow: await read($, verifFlowA), flowCache: await read($, flowCacheA) }
      await $.store.set(snapshotKey(live.id), snapshotOf(await $.clock.now(), live, await read($, leadA), await read($, entries), more))
      savedId = live.id
    } while (saving.again)
  } finally {
    saving.isBusy = false
  }
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
              type: { type: 'string', description: 'Type de sous-agent : general-purpose (défaut), Explore, revo-flow:verifier, ou le type d’un agent installé du catalogue' },
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
        criteres: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string' },
          description:
            "Critères d'acceptation, 1 à 8 (facultatif) : une phrase chacun, vérifiable par une commande ou un test (« Un code promo expiré affiche une erreur sous le champ ») ; revo-flow les numérote C1 à C8",
        },
      },
      required: ['titre', 'agents'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'step',
    description:
      'revo-flow : un sous-agent signale où il en est dans SA liste de tâches (numérotée à partir de 1). Fait avancer sa barre de progression. ' +
      'en_cours au début de chaque tâche clôt la précédente, et la dernière est close quand il finit : fait est inutile. ' +
      'attente : la tâche dépend du travail d’un autre agent du plan qui n’a pas fini (nomme-le dans « attend ») ; termine ensuite ta réponse en disant ce qui manque, revo-flow te relancera quand il aura fini.',
    inputSchema: {
      type: 'object',
      properties: {
        tache: { type: 'number', description: 'Numéro de la tâche, à partir de 1' },
        statut: { type: 'string', enum: ['en_cours', 'fait', 'echec', 'attente'] },
        attend: { type: 'string', description: 'Avec statut attente : le nom de l’agent du plan dont tu attends le travail, ou ce qui manque' },
      },
      required: ['tache', 'statut'],
    },
    isDeferred: false,
  })
  if (opts.verif !== 'off') await registerVerifTool($)
  if (opts.verif !== 'off' && opts.mobile !== 'off') await registerMobileTool($)
}

/** L'outil mobile (v3.1) : ce que le vérificateur fait sur l'appareil pendant la preuve mobile, sous les yeux de l'utilisateur. */
async function registerMobileTool($: $) {
  await $.tool.register({
    name: 'mobile',
    description:
      'revo-flow : la preuve mobile (vérificateur seulement, après mcp__revo-flow__verif action mobile). Actions : capture (écrit capture-n.png dans les sorties du flow : lis-la avec Read pour la voir) ; arbre (les vues à l’écran, texte, id et centre de chacune ; Android) ; journal (exceptions, débordements et erreurs de l’app, erreurs logcat) ; toucher (x, y) ; glisser (x1, y1, x2, y2) ; texte (texte saisi dans le champ qui a le focus) ; touche (retour, accueil, entree). L’utilisateur regarde l’appareil en direct : une action à la fois, puis une capture.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['capture', 'arbre', 'journal', 'toucher', 'glisser', 'texte', 'touche'] },
        x: { type: 'number', description: 'toucher : abscisse en pixels de l’écran (centre donné par arbre)' },
        y: { type: 'number', description: 'toucher : ordonnée en pixels' },
        x1: { type: 'number', description: 'glisser : départ' },
        y1: { type: 'number' },
        x2: { type: 'number', description: 'glisser : arrivée' },
        y2: { type: 'number' },
        texte: { type: 'string', description: 'texte : ce qui est saisi' },
        touche: { type: 'string', enum: ['retour', 'accueil', 'entree'], description: 'touche : la touche pressée' },
      },
      required: ['action'],
    },
    isDeferred: false,
  })
}

/** L'outil verif (v2) : la vérification du flow, pour les agents (lancer, resultat) et l'orchestrateur (commandes, exception, degeler). */
async function registerVerifTool($: $) {
  await $.tool.register({
    name: 'verif',
    description:
      "revo-flow : la vérification du flow (lint, typage, tests liés ; comparée à la base de référence, seules les erreurs nouvelles comptent). Actions : lancer (sur tes fichiers modifiés, ou ceux de « fichiers » → les erreurs nouvelles de tes fichiers ; pour l'orchestrateur, tout le flow) ; resultat (le dernier rapport de la porte de fin) ; commandes (orchestrateur : commandes = la liste complète corrigée, ou commande + exclus = motifs de tests à exclure ; toujours reposée à l'utilisateur) ; exception (orchestrateur, motif → l'utilisateur décide de terminer non vérifié ou non) ; degeler (orchestrateur, fichiers + motif → l'utilisateur décide de dégeler des tests gelés) ; web : (vérificateur, projet web) demande le serveur de dev pour la preuve web → l’URL à utiliser, ou pourquoi non ; mobile : (vérificateur, app Flutter, React Native ou Expo) demande l’app sur un appareil (téléphone branché, émulateur ou simulateur) → quand elle est à l’écran, ou pourquoi non. Ta tâche dit laquelle des deux vaut pour ce projet.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['lancer', 'resultat', 'commandes', 'exception', 'degeler', 'web', 'mobile'] },
        fichiers: { type: 'array', items: { type: 'string' }, description: 'lancer : tes fichiers (défaut : ceux que tu as modifiés) ; degeler : les tests gelés à dégeler' },
        commandes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              outil: { type: 'string', enum: ['lint', 'typage', 'tests', 'format', 'generation', 'qualite'] },
              argv: {
                type: 'array',
                items: { type: 'string' },
                description: 'La commande mot à mot, sans shell ; "{fichiers}" = les fichiers du flow, "{sorties}" = le dossier des sorties du flow ; vide pour la commande crap',
              },
              portee: { type: 'string', enum: ['fichiers', 'lies', 'projet'] },
              format: { type: 'string', enum: ['eslint-json', 'tsc', 'vitest-json', 'jest-json', 'biome', 'dart-machine', 'flutter-json', 'texte', 'crap'] },
              seuil: { type: 'number', description: 'Commande crap (outil qualite, format crap) : le seuil du score CRAP, 30 par défaut' },
              declencheur: { type: 'string', description: 'Motif glob : la commande ne tourne que si un fichier du flow y correspond' },
              exclus: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'outil', 'argv', 'portee'],
          },
          description: 'commandes : la liste complète corrigée',
        },
        commande: { type: 'string', description: 'commandes : l’id de la commande dont exclure des tests' },
        exclus: { type: 'array', items: { type: 'string' }, description: 'commandes : motifs de tests à exclure (tests qui demandent un service)' },
        motif: { type: 'string', description: 'exception, degeler : pourquoi, en une phrase' },
      },
      required: ['action'],
    },
    isDeferred: false,
  })
}

/** Le nom du serveur MCP Chrome DevTools déclaré pour le vérificateur (option web devtools) : ses outils sont mcp__chrome-devtools__*. */
const DEVTOOLS_MCP = 'chrome-devtools'

/**
 * Le vérificateur (lot 2) : Sonnet medium, lecture seule (Edit, Write et NotebookEdit retirés ; son Bash est filtré dans
 * tool.call), prompt calibré. Proposé au modèle seulement pendant un flow vérifié (agent.offer).
 */
async function registerVerifier($: $) {
  if (opts.verif === 'off') return
  const spec = {
    name: 'verifier',
    description:
      'revo-flow : vérificateur en lecture seule. Juge chaque critère d’acceptation du plan (ok, ko, non vérifiable) avec une preuve exécutée. À lancer quand les implémenteurs ont fini.',
    prompt: VERIFIER_PROMPT,
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    model: 'sonnet' as const,
    effort: 'medium' as const,
  }
  // Option web devtools : le serveur MCP Chrome DevTools (navigateur isolé) ; option mobile mcp : le serveur mobile-mcp. Déclarés pour le
  // vérificateur seul (AgentSpec.mcpServers, cc:512) ; refusés par cette version de Claude Code, le vérificateur est enregistré sans eux
  // (l'extension et l'outil mobile de revo-flow restent possibles).
  const mcpServers: Record<string, { command: string; args: string[] }> = {}
  if (opts.web === 'devtools') mcpServers[DEVTOOLS_MCP] = { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--isolated'] }
  if (opts.mobile === 'mcp') mcpServers[MOBILE_MCP] = { command: 'npx', args: ['-y', '@mobilenext/mobile-mcp@latest'] }
  if (Object.keys(mcpServers).length) {
    try {
      await $.agent.register({ ...spec, mcpServers } as never)
      return
    } catch {
      // repli ci-dessous
    }
  }
  try {
    await $.agent.register(spec)
  } catch {
    // sans agent.register (API plus ancienne), pas de vérificateur : la porte mécanique reste la référence
  }
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
    return `revo-flow : ce fichier est en cours de modification par l’agent « ${other.name} » ; coordonne-toi ou attends sa fin (outil ${STEP_TOOL}, statut attente, attend = « ${other.name} »).`
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

/**
 * $.ui.ask, avec deux replis distincts quand il rejette : `headless` sans personne à qui demander (-p, SDK),
 * `dismissed` quand l'utilisateur ferme le dialogue (Échap) ; fermer vaut toujours « ne rien faire ».
 */
async function askOr($: $, question: string, options: string[], fallback: { headless: string; dismissed: string }): Promise<string> {
  return (await askHow($, question, options, fallback)).answer
}

/**
 * Le flow est fini : phase done, heure de fin, et une notification avec la durée, le coût, les fichiers et la vérification
 * (« vérifié ✓ », « non vérifié (typecheck ✗) »). Une porte encore à lancer ou en cours (observateur : elle tourne après la
 * conclusion) ne retarde ni la notification ni la fin du tour : les journaux (graphe et store) l'attendent en fond.
 */
async function finishFlow($: $) {
  const flow = await read($, flowA)
  if (!flow || flow.phase === 'done') return
  const now = await $.clock.now()
  await setFlow($, f => ({ ...f, phase: 'done', endedAt: now }))
  const lead = await read($, leadA)
  const cost = lead.costUsd + flow.agents.reduce((sum, a) => sum + a.costUsd, 0)
  const files = (await read($, entries)).length
  // Le serveur de dev de la preuve web s'arrête avec le flow, avant le journal (verifJournal) et le rapport : ils le disent arrêté,
  // captures comprises.
  await stopProofs($, gate?.flowId === flow.id ? gate : undefined)
  const g = gate && gate.flowId === flow.id && !flow.isStopped && gate.mode !== 'off' ? gate : undefined
  // La porte de l'état final : déjà prête (porte bloquante passée au Stop), ou lancée maintenant en fond.
  const pending = g ? ensureGate($).catch(() => undefined) : undefined
  const isReady = !g || (g.porte?.fini === true && g.porte.seq === g.seq)
  const verifP: Promise<VerifJournal | undefined> = g ? pending!.then(() => verifJournal(g)) : Promise.resolve(gate && gate.flowId === flow.id && !flow.isStopped ? verifJournal(gate) : undefined)
  const blocked = flow.agents.filter(a => a.status === 'blocked').length
  const seg = g ? (isReady ? verifSegment(g) : 'vérification en cours') : ''
  const note = `${blocked ? ` · ${blocked} agent${blocked > 1 ? 's' : ''} en attente` : ''}${endNote ? ` · ${endNote}` : ''}`
  await notify($, `« ${flow.title} » ${flow.isStopped ? 'arrêté' : 'terminé'}${seg ? ` · ${seg}` : ''} · ${fmtDuration(now - flow.startedAt)} · ${euros(cost)} · ${files} fichier${files > 1 ? 's' : ''}${note}`)
  const journals = Promise.all([
    closeFlowCache($, verifP).catch(() => undefined),
    journalize($, { ...flow, endedAt: now }, lead, files, verifP).catch(() => undefined),
    writeRapport($, { ...flow, endedAt: now }, lead, verifP, g ?? (gate?.flowId === flow.id ? gate : undefined)).catch(() => undefined),
  ])
  if (isReady) {
    await journals
    return
  }
  // Le résultat arrive après la notification : un toast le donne.
  void verifP
    .then(() => {
      const line = g ? verifSegment(g) : ''
      if (line) $.ui.toast(`revo-flow · « ${flow.title} » : ${line}`)
    })
    .catch(() => undefined)
}

/** Le journal des flows (store du plugin), les plus récents d'abord. */
const JOURNAL_KEY = 'journal'

/** Ajoute le flow fini au journal : durée, coût et sort de chaque agent, et la vérification, pour /revo-flow historique. */
async function journalize($: $, flow: Flow, lead: Lead, files: number, verifP: Promise<VerifJournal | undefined> = Promise.resolve(undefined)) {
  const entry: JournalEntry = {
    id: flow.id,
    title: flow.title,
    project: flow.project,
    branch: flow.branch,
    startedAt: flow.startedAt,
    durationMs: (flow.endedAt ?? flow.startedAt) - flow.startedAt,
    isStopped: flow.isStopped === true,
    files,
    lead: { modelId: lead.modelId, costUsd: lead.costUsd, tokens: total(lead.tokens) },
    agents: flow.agents.map(a => ({
      name: a.name,
      model: a.model,
      effort: a.effort,
      status: a.status,
      costUsd: a.costUsd,
      tokens: total(a.tokens),
      attempts: a.attempts ?? 1,
      durationMs: a.startedAt !== undefined && a.endedAt !== undefined ? a.endedAt - a.startedAt : 0,
    })),
  }
  const verif = await verifP.catch(() => undefined)
  const prev = await $.store.get(JOURNAL_KEY)
  await $.store.set(JOURNAL_KEY, addToJournal(prev, verif ? { ...entry, verif } : entry))
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

/**
 * Le type et le modèle d'un agent prévu, à son lancement. Un vérificateur garde son type imposé ; un agent installé (type du
 * catalogue) prend le type exact de sa définition et, si elle déclare un modèle, revo-flow n'en impose pas (le modèle de l'appel
 * reste tel que reçu) ; les autres reçoivent le modèle du plan.
 */
function spawnType(a: FlowAgent): { subagentType?: string; model?: string } {
  if (isVerifier(a)) return { subagentType: VERIFIER_TYPE, model: MODELS[a.model].id }
  const def = trouveAgent(agentsInstalles, a.subagentType)
  if (!def) return { model: MODELS[a.model].id }
  return def.model ? { subagentType: def.type } : { subagentType: def.type, model: MODELS[a.model].id }
}

/** L'effort déclaré par la définition d'un agent installé : revo-flow ne le remplace pas par celui du plan. */
const ownEffort = (a: FlowAgent) => !isVerifier(a) && !!trouveAgent(agentsInstalles, a.subagentType)?.effort

/**
 * Les types du plan, avec l'option agents : general-purpose, Explore, le vérificateur ou un agent du catalogue (mis à sa casse
 * exacte) ; un autre type est refusé, avec la liste des types connus, pour que l'orchestrateur corrige. Sans l'option, libres.
 */
async function withKnownTypes($: $, plan: PlanInput): Promise<{ plan: PlanInput } | { error: string }> {
  if (!opts.agents) return { plan }
  // Le module a pu être rechargé depuis le lancement : le catalogue se relit.
  if (agentsInstalles.length === 0) agentsInstalles = await loadAgents($).catch(() => [])
  const base = (t: string) => BASE_TYPES.find(b => b.toLowerCase() === t.toLowerCase())
  const agents: PlanInput['agents'] = []
  for (const a of plan.agents) {
    const type = base(a.subagentType) ?? trouveAgent(agentsInstalles, a.subagentType)?.type
    if (!type) {
      const known = [...BASE_TYPES, ...agentsInstalles.map(d => d.type)].join(', ')
      return { error: `agent « ${a.name} » : type « ${a.subagentType} » inconnu. Types connus : ${known}.` }
    }
    agents.push({ ...a, subagentType: type })
  }
  return { plan: { ...plan, agents } }
}

/** Les accès du catalogue des agents installés : comme ioOf, agents/catalogue.ts ne reçoit jamais `$`. */
function catalogueIoOf($: $): CatalogueIo {
  const io = ioOf($)
  return { read: io.fs.read, list: io.fs.list, exists: io.fs.exists, home: io.home }
}

/**
 * Le catalogue des agents installés, relu à chaque flow (un agent ajouté entre deux flows est vu) ; option agents désactivée ou
 * erreur : vide. La racine est celle de la session, sinon celle du dépôt.
 */
async function loadAgents($: $): Promise<AgentDef[]> {
  if (!opts.agents) return []
  const root = (await $.session.root().catch(() => undefined)) || (await $.session.repo().catch(() => null))?.root
  return root ? catalogue(catalogueIoOf($), root).catch(() => []) : []
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

/** Un fichier vient d'être modifié dans le projet : le graphe gardé sera revérifié par hash au prochain appel, sans attendre REFRESH_MS (L17). */
function staleGraph(cle: string | undefined) {
  const held = cle ? graphCache.get(cle) : undefined
  if (held) held.refreshedAt = 0
}

/**
 * La fiche avec sa dérive (withDrift : commits sur ses voisins depuis l'apprentissage), à calculer avant de la servir pour que freshness
 * applique la décroissance de confiance. Le graphe rendu est gardé sans toucher à l'heure de sa dernière vérification ; jamais d'exception.
 */
async function drifted($: $, graph: Graph, f: Feature): Promise<Graph> {
  // Calculée il y a moins de REFRESH_MS (un agent après l'autre) : pas de nouvel appel git.
  const at = Date.parse(graph.features[f.id]?.derive?.calcule ?? '')
  if (Number.isFinite(at) && (await $.clock.now()) - at < REFRESH_MS) return graph
  const next = await withDrift(ioOf($), graph, f).catch(() => graph)
  if (next === graph) return graph
  return keepGraph(next, graphCache.get(graph.projet.cle)?.refreshedAt ?? 0)
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
    // HEAD qui a bougé sans changement de contenu (un commit) : le commit indexé suit, sur le disque aussi.
    if (r.changed.length || r.removed.length || r.head) graph = await saveGraph(ioOf($), r.graph).catch(() => r.graph)
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

/** Tokens comptés par ligne d'un Read partiel : 8 à 10 en pratique (§1.2 L9). */
const LINE_TOK = 9

/**
 * Un fichier lu pendant le flow : le chemin relatif, sa taille en tokens, qui l'a lu. Read : le fichier entier, ou limit × LINE_TOK ;
 * Bash (cat, sed -n, head, tail d'un seul fichier) : la taille de la sortie, via 'bash'. Un chemin hors du projet n'est pas compté.
 */
function noteRead($: $, path: string, size: { limit?: unknown; tok?: number }, who: string, via?: 'bash') {
  $.clock.after(0, async () => {
    try {
      const fc = await read($, flowCacheA)
      const ref = await flowRefOf($, fc)
      const p = ref ? relTo(ref.racine, path) : undefined
      if (!fc || !ref || !p || /^(~|\.\.)(\/|$)/.test(p)) return
      const { limit, tok: known } = size
      const tok =
        typeof known === 'number' ? known : typeof limit === 'number' && limit > 0 ? Math.round(limit * LINE_TOK) : await fileTokens(ioOf($), ref.racine, p)
      const entry = { p, tok, par: who, ...(via ? { via } : {}) }
      await update($, flowCacheA, f => (f && f.cle === fc.cle ? { ...f, lus: [...f.lus, entry].slice(-500) } : f))
      await refreshStats($)
    } catch {
      // la mesure ne doit jamais gêner l'outil
    }
  })
}

/** La sortie d'un Grep ou d'un Glob pendant le flow : ses tokens s'ajoutent à FlowCache.outils (lectures non attribuables à un fichier). */
function noteToolOutput($: $, tok: number) {
  if (!(tok > 0)) return
  $.clock.after(0, async () => {
    try {
      await update($, flowCacheA, f => (f ? { ...f, outils: (f.outils ?? 0) + tok } : f))
      await refreshStats($)
    } catch {
      // idem
    }
  })
}

async function registerCacheTool($: $) {
  await $.tool.register({
    name: 'cache',
    description:
      "revo-flow : le cache du projet (graphe des fichiers et fiches de features). Une carte, pas la vérité : vérifie dans le code ce que tu affirmes ou modifies. Actions : chercher (requete : mots-clés → les features et fichiers pertinents, une ligne chacun) ; feature (feature : identifiant → la fiche : résumé, flux, points d'entrée, fichiers et rôles, pièges, fraîcheur) ; voisins (chemin relatif à la racine, profondeur 1 ou 2 → ce que le fichier utilise et qui l'utilise, à essayer avant un grep « qui utilise X ») ; diff (feature → le diff de ses fichiers modifiés depuis l'apprentissage, ou chemin → ce fichier seul) ; rafraichir (feature, fichiers = les chemins relus et toujours conformes à la fiche → leurs hash sont remis à jour, le reste de la fiche ne bouge pas) ; apprendre (feature, titre, alias, resume, flux, entrees, fichiers [{p, role}], pieges [{txt, p}], deps, corrections → enregistre ou complète la fiche, avec les chemins rejetés ; un champ absent garde sa valeur) ; oublier (feature → supprime la fiche) ; candidates (features repérées sans fiche, avec leur taille). projet : facultatif, nom ou chemin d'un autre projet (défaut : le projet courant).",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['chercher', 'feature', 'voisins', 'diff', 'rafraichir', 'apprendre', 'oublier', 'candidates'] },
        projet: { type: 'string', description: 'Nom ou chemin du projet ; le projet courant par défaut' },
        requete: { type: 'string', description: 'chercher : mots-clés' },
        feature: { type: 'string', description: 'feature, diff, rafraichir, apprendre, oublier : identifiant court de la feature (ex. double-session)' },
        chemin: { type: 'string', description: 'voisins, diff : chemin du fichier, relatif à la racine du projet' },
        profondeur: { type: 'number', description: 'voisins : 1 (défaut) ou 2' },
        titre: { type: 'string' },
        alias: { type: 'array', items: { type: 'string' } },
        resume: { type: 'string', description: '600 caractères au plus' },
        flux: { type: 'array', items: { type: 'string' }, description: 'Les étapes, dans l’ordre' },
        entrees: { type: 'array', items: { type: 'string' }, description: 'Points d’entrée : routes, pages, mutations' },
        fichiers: {
          type: 'array',
          items: { type: 'object', properties: { p: { type: 'string' }, role: { type: 'string' } }, required: ['p'] },
          description: 'apprendre : les fichiers et leur rôle ; rafraichir : les fichiers relus ({p}), toujours conformes à la fiche',
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
  // Écrire ou comparer des hash demande le graphe à jour : un fichier créé ou modifié par un agent il y a moins de
  // REFRESH_MS serait sinon inconnu (chemin rejeté) ou déclaré frais à tort.
  const force = action === 'apprendre' || action === 'rafraichir' || action === 'diff'
  const graph = await graphOf($, ref, { build: true, force })
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
      // Les fichiers listés comptent, à poids réduit, comme évités s'ils ne sont pas lus ensuite (L12).
      hits = searchHits(graph, q, who)
      break
    }
    case 'feature': {
      const id = text(e.feature) || text(e.requete)
      const found = findFeature(graph, id)
      if (!found) {
        answer = `Pas de fiche « ${id} » dans le cache de ${ref.nom}.\n${searchText(graph, id)}`
        break
      }
      const g = await drifted($, graph, found)
      const f = g.features[found.id] ?? found
      answer = featureText(g, f)
      hits = servedFiles(g, f, who)
      feature = f.id
      break
    }
    case 'voisins': {
      const raw = text(e.chemin)
      if (!raw) return 'revo-flow cache : « chemin » manquant (relatif à la racine du projet).'
      const depth = Math.min(2, Math.max(1, Math.round(Number(e.profondeur) || 1)))
      const p = relTo(ref.racine, raw) ?? raw
      answer = neighborsText(graph, p, depth)
      hits = neighborHits(graph, p, depth, who)
      break
    }
    case 'diff':
      answer = await diffTool($, e, ref, graph)
      break
    case 'rafraichir':
      answer = await refreshTool($, e, ref, graph)
      break
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
      return `revo-flow cache : action « ${action} » inconnue (chercher, feature, voisins, diff, rafraichir, apprendre, oublier, candidates).`
  }
  await served($, ref.cle, hits, tokensOf(answer), feature)
  return answer
}

/** Le nombre de fichiers comparés par un `diff` sur une fiche entière. */
const DIFF_FILES = 5

/** Les chemins passés à `rafraichir` : `fichiers` ([{p}] ou chaînes) et `chemin`, rendus relatifs à la racine. */
function pathsOf(e: CacheCall, root: string): string[] {
  const raw = [
    ...(Array.isArray(e.fichiers) ? e.fichiers : []).map(x => (typeof x === 'string' ? x : typeof x === 'object' && x !== null ? text((x as { p?: unknown }).p) : '')),
    text(e.chemin),
  ]
  return [...new Set(raw.map(p => text(p)).filter(Boolean).map(p => relTo(root, p) ?? p))]
}

/**
 * `diff` : ce qui a changé depuis l'apprentissage. Avec feature, ses fichiers périmés (5 au plus, dans l'ordre de la fiche) ;
 * avec chemin, ce fichier seul, comparé au hash appris par la fiche la plus récente qui le contient. Les diffs se calculent l'un après l'autre.
 */
async function diffTool($: $, e: CacheCall, ref: ProjectRef, graph: Graph): Promise<string> {
  const id = text(e.feature)
  const raw = text(e.chemin)
  let f: Feature | undefined
  let p: string | undefined
  let list: PerimeEntry[]
  if (id) {
    f = findFeature(graph, id)
    if (!f) return `revo-flow cache : pas de fiche « ${id} » dans ${ref.nom}, rien à comparer.`
    list = perimeOf(graph, f)
  } else if (raw) {
    const rel = relTo(ref.racine, raw) ?? raw
    p = resolveKey(graph, rel) ?? rel
    const key = p
    const owners = Object.values(graph.features)
      .filter(x => x.fichiers.some(ff => ff.p === key))
      .sort((a, b) => b.appris.le.localeCompare(a.appris.le))
    if (!owners.length) return `revo-flow cache : pas de fiche ne connaît ${key}, rien à comparer (relis le fichier).`
    const learnedHash = owners[0]!.fichiers.find(ff => ff.p === key)!.h
    const now = graph.fichiers[key]?.h ?? ''
    list = sameHash(learnedHash, now) ? [] : [{ p: key, depuis: learnedHash, nouveau: now }]
  } else {
    return 'revo-flow cache : « feature » ou « chemin » manquant pour diff.'
  }
  const shown = list.slice(0, DIFF_FILES)
  const diffs: DiffEntry[] = []
  for (const x of shown) diffs.push({ p: x.p, depuis: x.depuis, diff: await diffSince(ioOf($), graph.projet.racine, x.p, x.depuis, x.nouveau) })
  const rest = list.slice(DIFF_FILES).map(x => x.p)
  const answer = diffText(graph, f, p, diffs)
  return rest.length ? `${answer}\nAussi modifiés (action diff avec chemin) : ${rest.join(', ')}` : answer
}

/**
 * `rafraichir` : les fichiers relus et toujours conformes à la fiche reprennent leur hash courant (refreshFiles) ;
 * résumé, flux, pièges et confiance ne bougent pas. Le graphe est enregistré.
 */
async function refreshTool($: $, e: CacheCall, ref: ProjectRef, graph: Graph): Promise<string> {
  const id = text(e.feature)
  if (!id) return 'revo-flow cache : « feature » manquante pour rafraichir.'
  const f = findFeature(graph, id)
  if (!f) return `revo-flow cache : pas de fiche « ${id} » dans ${ref.nom}, rien à rafraîchir.`
  const paths = pathsOf(e, ref.racine)
  if (!paths.length) return `revo-flow cache : « fichiers » manquants (les chemins relus et toujours conformes à la fiche « ${f.id} »).`
  const now = await $.clock.now()
  const r = refreshFiles(graph, f.id, paths, { le: new Date(now).toISOString(), commit: graph.projet.indexe.commit, branche: graph.projet.indexe.branche })
  const unknown = r.unknown.length ? [`Chemins inconnus de la fiche (ignorés) : ${r.unknown.join(', ')}.`] : []
  if (!r.refreshed.length) return [`revo-flow cache : aucun des fichiers donnés n'appartient à la fiche « ${f.id} », rien de rafraîchi.`, ...unknown].join('\n')
  const saved = keepGraph(await saveGraph(ioOf($), r.graph), now)
  await refreshStats($)
  const left = (saved.features[f.id] ?? r.graph.features[f.id])?.perime.map(x => x.p) ?? []
  return [
    `revo-flow cache : fiche « ${f.id} » rafraîchie : ${plural(r.refreshed.length, 'fichier')} ; ${left.length ? `encore périmés : ${left.join(', ')}.` : 'fiche redevenue fraîche.'}`,
    ...unknown,
  ].join('\n')
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
    // Un champ absent de l'appel reste undefined : learn garde alors la valeur de la fiche (un tableau vide l'effacerait).
    ...(Array.isArray(e.alias) ? { alias: texts(e.alias) } : {}),
    ...(Array.isArray(e.flux) ? { flux: texts(e.flux) } : {}),
    ...(Array.isArray(e.entrees) ? { entrees: texts(e.entrees) } : {}),
    ...(Array.isArray(e.fichiers)
      ? {
          fichiers: obj(e.fichiers)
            .map(f => ({ p: relTo(ref.racine, text(f.p)) ?? text(f.p), ...(text(f.role) ? { role: text(f.role) } : {}) }))
            .filter(f => f.p),
        }
      : {}),
    ...(Array.isArray(e.pieges)
      ? {
          pieges: obj(e.pieges)
            .map(x => ({ txt: text(x.txt), ...(text(x.p) ? { p: relTo(ref.racine, text(x.p)) ?? text(x.p) } : {}) }))
            .filter(x => x.txt),
        }
      : {}),
    ...(Array.isArray(e.deps) ? { deps: texts(e.deps) } : {}),
    corrections: texts(e.corrections),
  }
  const { graph: next, rejected, refus, avertissement } = learn(graph, input, ctx)
  const rejectedLine = rejected.length ? [`Chemins rejetés, inconnus du projet : ${rejected.join(', ')}`] : []
  // Une nouvelle fiche sans aucun fichier connu n'est pas écrite : elle ne pourrait jamais devenir périmée.
  if (refus) return [`revo-flow cache : ${refus}`, ...rejectedLine].join('\n')
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
    ...(avertissement ? [`⚠ ${avertissement}`] : []),
    ...rejectedLine,
  ].join('\n')
}

/** Délai laissé à Haiku pour trancher la zone grise : au-delà, pas de fiche (le lancement ne doit pas attendre). */
const RERANK_MS = 5_000

/**
 * La fiche que vise la demande (matchZone) : zone nette, celle de BM25 ; zone grise, celle que Haiku choisit parmi les candidates
 * (rerankPrompt, parseRerank) ; échec, délai dépassé ou « aucune » : pas de fiche. Jamais d'exception.
 */
async function pickFeature($: $, graph: Graph, request: string): Promise<{ id: string; byHaiku: boolean } | undefined> {
  try {
    const z = matchZone(graph, request)
    if (z.zone === 'nette' && z.id) return { id: z.id, byHaiku: false }
    if (z.zone !== 'grise' || !z.candidats.length) return undefined
    const r = await $.model.complete({ model: 'haiku', prompt: rerankPrompt(request, z.candidats), maxTokens: 60, timeoutMs: RERANK_MS })
    const id = r.isAnswered ? parseRerank(r.text, z.candidats) : undefined
    return id && graph.features[id] ? { id, byHaiku: true } : undefined
  } catch {
    return undefined
  }
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
  // La mesure (tokens lus) tourne même sans cache : c'est la population « sans cache » du journal.
  await update($, flowCacheA, () => ({ cle: ref.cle, cache: opts.cache, servis: [], lus: [], outils: 0, injecte: 0 }))
  if (!opts.cache) return undefined
  let graph = await graphOf($, ref, { build: true }).catch(() => null)
  if (!graph) return undefined
  const picked = await pickFeature($, graph, request)
  let f = picked ? graph.features[picked.id] : undefined
  if (f) {
    graph = await drifted($, graph, f)
    f = graph.features[f.id] ?? f
    const by = picked?.byHaiku ? ' (proposée par Haiku)' : ''
    const q = `Je pense qu’il s’agit de « ${f.titre} »${by} (confiance ${frac(freshness(graph, f).confiance)}) : utiliser la fiche du cache ?`
    // Sans personne à qui demander (claude -p), la fiche est utilisée ; dialogue fermé : ignorée.
    const answer = await askOr($, q, ['Utiliser', 'Ignorer'], { headless: 'Utiliser', dismissed: 'Ignorer' })
    if (answer !== 'Utiliser') f = undefined
  }
  // Sans fiche : la carte à froid (fichiers probables pour la demande, avec leur résumé) plutôt qu'une liste de features seule.
  const brief = briefText(graph, f, undefined, request)
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
  const r = autoFiche(graph, id, files, ctx)
  if (r.graph === graph) return
  keepGraph(await saveGraph(ioOf($), r.graph), now)
  // La fiche écrite compte comme apprise par ce flow (journal : comparaison avant / après par feature).
  Object.assign(learned, { flowId: flow.id, features: [r.id] })
  endNote = r.rattachee ? `fiche auto « ${r.id} » (rattachée)` : `brouillon « ${r.id} »`
}

/**
 * Le flow est fini : son entrée dans le journal du graphe (cache actif ou non : c'est la mesure), usages et gains des fiches servies,
 * fiche servie complétée des fichiers lus. Cache désactivé : seulement si le graphe existe déjà (on ne le construit pas pour mesurer).
 */
async function closeFlowCache($: $, verifP: Promise<VerifJournal | undefined> = Promise.resolve(undefined)) {
  const fc = await read($, flowCacheA)
  if (!fc) return
  // Un flow arrêté n'est pas représentatif : ni journal, ni fiche complétée.
  const flow = await read($, flowA)
  if (flow?.isStopped === true) return
  const ref = await flowRefOf($, fc)
  if (!ref) return
  // Ce qui appartient à ce flow est lu tout de suite : la vérification peut finir après le lancement du flow suivant.
  const appris = flow && learned.flowId === flow.id ? [...learned.features] : []
  const verif = await verifP.catch(() => undefined)
  const graph = opts.cache ? await graphOf($, ref) : (graphCache.get(ref.cle)?.graph ?? (await loadGraph(ioOf($), ref).catch(() => null)))
  if (!graph) return
  const now = await $.clock.now()
  let next = recordCacheUsage(graph, fc, { le: new Date(now).toISOString(), appris }, verif ? { verif } : undefined)
  if (opts.cache && fc.feature && next.features[fc.feature]) next = completeFiche(next, fc.feature, [...new Set(fc.lus.map(l => l.p))])
  // Sans cache, le graphe n'a pas été revérifié par hash : il ne passe pas pour frais.
  keepGraph(await saveGraph(ioOf($), next), opts.cache ? now : (graphCache.get(ref.cle)?.refreshedAt ?? 0))
  await refreshStats($)
}

/**
 * L'extrait de la fiche servie qui concerne un sous-agent du flow (agentExtract) et les hits à enregistrer à son nom (par = sa clé).
 * Rien sans cache, sans fiche servie ou sans graphe ; jamais d'exception : l'extrait est un bonus, il ne doit pas gêner le lancement.
 */
async function agentCacheExtract($: $, a: FlowAgent, prompt: unknown): Promise<{ cle: string; text: string; hits: CacheHit[] } | undefined> {
  if (!opts.cache) return undefined
  try {
    const fc = await read($, flowCacheA)
    if (!fc?.feature) return undefined
    const ref = await flowRefOf($, fc)
    const fresh = ref ? await graphOf($, ref) : null
    const served = fresh?.features[fc.feature]
    if (!fresh || !served) return undefined
    const graph = await drifted($, fresh, served)
    const f = graph.features[served.id] ?? served
    const agent: AgentInfo = { name: a.name, tasks: a.tasks.map(t => t.title), prompt: typeof prompt === 'string' ? prompt : '' }
    const text = agentExtract(graph, f, agent)
    if (!text) return undefined
    return { cle: fc.cle, text, hits: servedSubset(graph, f, extractFiles(graph, f, agent), a.key) }
  } catch {
    return undefined
  }
}

/** Rappel après compaction : la fiche servie et les features connues du projet. */
/** Le paragraphe du cache d'un sous-agent : les consignes de recherche seulement si le projet a des fiches. */
async function agentCacheMode($: $): Promise<AgentCache> {
  if (!opts.cache) return false
  const fc = await read($, flowCacheA)
  const graph = fc ? graphCache.get(fc.cle)?.graph : undefined
  if (!graph) return 'fiches'
  return Object.keys(graph.features).length ? 'fiches' : 'graphe'
}

/** Au plus autant de features nommées dans le rappel après compaction (comme la ligne « features connues » du brief). */
const RECAP_MAX = 15

function cacheRecap(fc: FlowCache | null): string | undefined {
  const graph = fc && opts.cache ? graphCache.get(fc.cle)?.graph : undefined
  if (!fc || !graph) return undefined
  // Les brouillons (fiches auto non rattachées) restent hors du rappel, comme hors du brief.
  const ids = Object.values(graph.features)
    .filter(f => !isDraft(f))
    .map(f => f.id)
  const known = ids.length > RECAP_MAX ? `${ids.slice(0, RECAP_MAX).join(', ')}… (+${ids.length - RECAP_MAX})` : ids.join(', ')
  return `Cache revo-flow (${graph.projet.nom}) : ${fc.feature ? `fiche servie « ${fc.feature} » ; ` : ''}features connues : ${known || 'aucune'}. Outil ${CACHE_TOOL}.`
}

// ── Vérification du flow (v2, docs/rd-v2/conception.md) ──────────────────

/** Le plafond de block sur la porte de fin, par flow (§8) ; au-delà, l'utilisateur décide. */
const MAX_TENTATIVES = 3
/** Une commande au plus 10 min : la limite de $.process.run (cc:3591). */
const RUN_MAX_MS = 600_000
/** Les sorties complètes des 20 derniers flows sont gardées (~/.claude/revo-flow/verif/<flow>/). */
const SORTIES_GARDEES = 20
/** Les choix de la question des commandes (§4). */
const CONFIRM = ['Utiliser', 'Ajuster', 'Pas de vérification']
/** Les choix de la question de fin, plafond atteint ou exception demandée (§4). */
const FIN = ['Terminer non vérifié', 'Une tentative de plus', 'Voir le détail']

/**
 * La porte du flow courant, en mémoire : promesses (base, porte en cours) et décisions. Ce qui doit survivre à un
 * rechargement du mod (gel, critères, tentatives) est recopié dans l'atom verifFlow (persistVerif) ; la base en cours,
 * elle, est perdue (base absente : les erreurs sont « nouvelle ? »).
 */
type Gate = {
  flowId: string
  /** Le mode de ce flow : celui de l'option, observer (confirmé sans personne à qui demander) ou off (pas de vérification). */
  mode: VerifMode
  ref: ProjectRef
  /** Le commit de départ : la base de référence et le diff du flow s'y rattachent. */
  commit: string
  /** Les commandes proposées en attente de confirmation (Ajuster) : la question revient après `verif commandes`. */
  proposees?: { commandes: VerifCommande[]; pieges: string[]; hashes: Record<string, string> }
  /** Les chemins déjà modifiés (git status) au lancement : hors de la portée tant que le flow n'y touche pas. */
  saleAuDepart: Set<string>
  base?: Promise<void>
  baseEnCours?: boolean
  /** Un fichier a été modifié pendant que la base tournait : elle n'est pas gardée (elle compterait des erreurs du flow comme préexistantes). */
  baseSalie?: boolean
  /** Le compteur des modifications du flow (Edit, Write, Bash qui écrit) : une porte n'est réutilisée que s'il n'a pas bougé. */
  seq: number
  porte?: { seq: number; promesse: Promise<VerifResultat | undefined>; fini: boolean }
  dernier?: VerifResultat
  /** Les block rendus sur la porte de fin. */
  blocks: number
  /** Les tentatives accordées au-delà du plafond (« Une tentative de plus »). */
  encore: number
  /** Les fins de tour consécutives relancées par un block (stop_hook_active) : un garde-fou contre une boucle. */
  relances: number
  /** Les portes de fin évaluées (fins de tour de l'orchestrateur en conclusion). */
  portes: number
  premierRouge?: boolean
  /** Temps cumulé des portes globales du flow. */
  dureeMs: number
  /** La porte est levée : terminer non vérifié, sur décision de l'utilisateur ou sans personne à qui demander. */
  libre?: boolean
  /** Fini rouge sur décision de l'utilisateur (exception ou plafond). */
  accepte?: boolean
  /** revo-flow a planté pendant la dernière porte : elle s'est ouverte. */
  erreur?: boolean
  gel: TestGele[]
  /** Les tests gelés modifiés hors outil (Bash…), avec la réponse de l'utilisateur. */
  gelesModifies: { p: string; par: string; decision?: 'accepte' | 'refuse' }[]
  triches: Triche[]
  /** Les réponses de l'utilisateur sur les triches bloquantes, par « motif|fichier ». */
  decisions: Map<string, 'accepte' | 'refuse'>
  criteres: Critere[]
  verdicts?: CritereVerdict[]
  /** La preuve web (v3) : le serveur de dev demandé par le vérificateur ; absente tant qu'il ne l'a pas demandé. */
  web?: GateWeb
  /** La preuve mobile (v3.1) : l'app lancée sur un appareil à la demande du vérificateur ; absente tant qu'il ne l'a pas demandée. */
  mobile?: GateMobile
}
/**
 * L'app de la preuve mobile : app détectée, appareil accordé, etat (demarrage = émulateur, installation = build et pose, pret = à l'écran) ;
 * sortie = la fin de ce que `flutter run` (ou expo, react-native) a écrit (8 000 caractères) ; attente et enCours comme GateWeb ; stop
 * arrête l'app lancée par revo-flow ; emulateur = l'émulateur ou simulateur que revo-flow a démarré (éteint en fin de flow), stopEmulateur
 * ferme son processus quand il en a un ; vmService = l'URL du VM Service Dart annoncée ; prises = numéros de capture déjà donnés.
 */
type GateMobile = {
  app?: MobileApp
  appareil?: Appareil
  etat: MobileEtat
  captures: string[]
  sortie: string
  note?: string
  commande?: string
  attente?: Promise<void>
  enCours?: boolean
  stop?: () => Promise<void>
  emulateur?: Appareil
  stopEmulateur?: () => Promise<void>
  vmService?: string
  prises?: number
}
/**
 * Le serveur de dev de la preuve web : etat et url suivent son démarrage ; existant = déjà en marche (revo-flow ne l'arrête pas) ;
 * sortie = la fin de ce qu'il a écrit (8 000 caractères) ; attente = la dernière demande (un second appel l'attend), enCours tant
 * qu'elle n'a pas rendu ; stop arrête ce que revo-flow a lancé, jamais un serveur existant ; commande = celle de la vue restaurée
 * après un rechargement du mod (le serveur détecté est perdu) ; prises = les numéros de capture déjà donnés.
 */
type GateWeb = {
  serveur?: WebServeur
  etat: WebEtat
  url?: string
  existant?: boolean
  captures: string[]
  sortie: string
  note?: string
  commande?: string
  attente?: Promise<void>
  enCours?: boolean
  stop?: () => Promise<void>
  prises?: number
}
let gate: Gate | undefined
/** Les sous-agents vérificateurs (revo-flow:verifier) : leur Bash est filtré, leur réponse donne les verdicts. */
const verifierAgents = new Set<string>()
/** Les sous-agents testeurs en cours : tant qu'il y en a un, le hook d'édition se ferme en cas d'erreur. */
const testerAgents = new Set<string>()
/** La commande de vérification en cours, pour la ligne d'état : « revo-flow : typecheck… (≈ 45 s) ». */
let verifStatus: string | undefined
/** Les exécutions de vérification passent l'une après l'autre (agents et porte globale partagent la copie de travail). */
let verifQueue: Promise<unknown> = Promise.resolve()

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = verifQueue.then(fn, fn)
  verifQueue = p.catch(() => undefined)
  return p
}

/** La vue de la porte, si elle est encore celle de ce flow (un flow remplacé ne touche plus à l'écran). */
async function setView($: $, g: Gate, patch: Partial<VerifView>) {
  if (gate !== g) return
  await update($, verifA, v => (v ? { ...v, ...patch } : v))
}

/** Le gel, les critères et les tentatives dans l'atom verifFlow : ils survivent à un rechargement du mod. */
async function persistVerif($: $, g: Gate) {
  if (gate !== g) return
  await update($, verifFlowA, () => ({
    flowId: g.flowId,
    mode: g.mode,
    commit: g.commit,
    gel: g.gel,
    criteres: g.criteres,
    blocks: g.blocks,
    portes: g.portes,
    ...(g.accepte ? { accepte: true } : {}),
  }))
}

/** Les commandes confirmées du projet, telles que le graphe gardé les porte. */
/** projet.verif du graphe ; option « crap » coupée, sans la commande crap ni les flags de couverture (confirmées avant le changement d'option). */
const verifOf = (g: Gate): ProjetVerif | undefined => {
  const v = graphCache.get(g.ref.cle)?.graph.projet.verif
  return v && !opts.crap ? { ...v, commandes: withoutCrap(v.commandes) } : v
}

/** Modifie projet.verif du graphe et l'enregistre ; jamais d'exception (la vérification ne doit pas gêner le flow). */
async function saveVerif($: $, ref: ProjectRef, change: (v: ProjetVerif | undefined) => ProjetVerif) {
  try {
    const held = graphCache.get(ref.cle)
    const graph = held?.graph ?? (await graphOf($, ref))
    if (!graph) return
    const next = { ...graph, projet: { ...graph.projet, verif: change(graph.projet.verif) } }
    keepGraph(await saveGraph(ioOf($), next), held?.refreshedAt ?? (await $.clock.now()))
  } catch {
    // le graphe sera réécrit au prochain changement
  }
}

const isWindows = async ($: $) => Boolean(await $.env.get('USERPROFILE').catch(() => undefined))

/** Le dossier des sorties complètes : ~/.claude/revo-flow/verif (chaque flow dans son sous-dossier). */
async function verifDir($: $): Promise<string | undefined> {
  const home = await ioOf($).home()
  return home ? `${normalizePath(home)}/.claude/revo-flow/verif` : undefined
}

/**
 * Les accès du module de vérification au moteur, comme ioOf pour le cache : runner.ts ne reçoit jamais `$`. Un cwd relatif
 * est pris sous la racine ; une commande dure 10 min au plus ; remove ne supprime que sous ~/.claude/revo-flow/verif.
 */
async function verifIoOf($: $, g: Gate): Promise<VerifIo> {
  const os = (await isWindows($)) ? 'windows' : 'posix'
  const racine = normalizePath(g.ref.racine)
  const parent = (await verifDir($)) ?? `${racine}/.revo-flow-verif`
  const abs = (cwd: string) => (!cwd ? racine : /^([a-z]:)?[\\/]/i.test(cwd) ? cwd : `${racine}/${normalizePath(cwd)}`)
  return {
    run: async (argv, init) => {
      const r = await $.process.run(argv, { cwd: abs(init.cwd), timeoutMs: Math.max(1000, Math.min(RUN_MAX_MS, init.timeoutMs)) })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    },
    write: (path, text) => $.fs.write(path, text),
    read: path => $.fs.read(path),
    // Le fichier au commit de départ (score CRAP) : undefined s'il n'y était pas (ou si git échoue).
    show: async (commit, rel) => (await gitOut($, racine, ['show', `${commit}:${normalizePath(rel).replace(/^\.\//, '')}`])) || undefined,
    list: async dir => (await $.fs.list(dir)).map(e => e.name),
    remove: async path => {
      const p = normalizePath(path)
      if (!p.startsWith(`${parent}/`) || p.includes('/../')) return
      const argv = os === 'windows' ? ['cmd', '/c', 'rmdir', '/s', '/q', p.replace(/\//g, '\\')] : ['rm', '-rf', p]
      await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)
    },
    now: () => $.clock.now(),
    os,
    racine,
    sorties: `${parent}/${outputsName(g.flowId)}`,
  }
}

/**
 * Le dossier des sorties d'un flow : la date en tête (20261025T091500-<flow>), car purgeOutputs garde les derniers dans l'ordre
 * alphabétique des noms.
 */
function outputsName(flowId: string): string {
  const at = Number(flowId)
  const stamp = Number.isFinite(at) && at > 0 ? new Date(at).toISOString().replace(/[-:]/g, '').slice(0, 15) : '00000000T000000'
  return `${stamp}-${flowId}`
}

/** git dans la racine du projet, sans jamais lever : la sortie, ou '' en cas d'échec. */
async function gitOut($: $, racine: string, args: string[], stdin?: string): Promise<string> {
  try {
    const r = await $.process.run(['git', '-c', 'core.quotepath=false', ...args], { cwd: racine, timeoutMs: 15_000, ...(stdin !== undefined ? { stdin } : {}) })
    return r.exitCode === 0 ? r.stdout : ''
  } catch {
    return ''
  }
}

/** git hash-object des fichiers donnés (relatifs à la racine) : { chemin → hash } ; un fichier illisible est absent. */
async function hashFiles($: $, racine: string, paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!paths.length) return out
  const lines = (await gitOut($, racine, ['hash-object', '--stdin-paths'], `${paths.join('\n')}\n`)).split(/\r?\n/).filter(Boolean)
  if (lines.length === paths.length) {
    paths.forEach((p, i) => (out[p] = lines[i]!.trim()))
    return out
  }
  // Un chemin a échoué : un par un, pour ne perdre que celui-là.
  for (const p of paths) {
    const h = (await gitOut($, racine, ['hash-object', '--', p])).trim()
    if (h) out[p] = h
  }
  return out
}

/** Les fichiers modifiés de la copie de travail (git status), relatifs à la racine ; les supprimés n'y sont pas. */
async function dirtyPaths($: $, racine: string): Promise<string[]> {
  const out = await gitOut($, racine, ['status', '--porcelain', '-z', '--untracked-files=all'])
  return parseStatus(out)
    .filter(e => e.x !== 'D' && e.y !== 'D')
    .map(e => e.p)
}

/** La portée de la porte globale : les fichiers modifiés du flow (markFile), plus ceux que git status voit et qui ne l'étaient pas au lancement (Bash). */
async function flowScope($: $, g: Gate): Promise<string[]> {
  const marked = (await read($, entries)).map(x => relTo(g.ref.racine, x.path)).filter((p): p is string => !!p && !/^(~|\.\.)(\/|$)/.test(p))
  const status = (await dirtyPaths($, g.ref.racine)).filter(p => !g.saleAuDepart.has(p))
  return existing($, g, [...new Set([...marked, ...status])])
}

/** Les fichiers qui existent encore (un fichier supprimé pendant le flow ne se vérifie pas). */
async function existing($: $, g: Gate, paths: string[]): Promise<string[]> {
  const root = normalizePath(g.ref.racine)
  const kept = await Promise.all(paths.map(p => $.fs.exists(`${root}/${p}`).catch(() => true)))
  return paths.filter((_, i) => kept[i])
}

/** Les fichiers Dart de la portée dont une annotation demande build_runner (@riverpod, @freezed, part '*.g.dart'…) : `annotes` de runGate. */
async function annotesOf($: $, g: Gate, paths: string[]): Promise<string[]> {
  const root = normalizePath(g.ref.racine)
  const dart = paths.filter(p => p.endsWith('.dart')).slice(0, 200)
  const texts = await Promise.all(dart.map(p => ioOf($).fs.read(`${root}/${p}`).catch(() => '')))
  return dart.filter((_, i) => typeof texts[i] === 'string' && hasGenAnnotation(texts[i]!))
}

/** Les tests liés d'un fichier Dart : les fichiers qui le « testent » dans le graphe (arêtes teste, graph.ts:923). */
function testsOfGraph(graph: Graph | undefined): ((p: string) => string[]) | undefined {
  if (!graph) return undefined
  const rev = new Map<string, string[]>()
  for (const [t, node] of Object.entries(graph.fichiers)) {
    for (const to of node.out?.teste ?? []) rev.set(to, [...(rev.get(to) ?? []), t])
  }
  return p => rev.get(p) ?? []
}

/**
 * $.ui.ask avec la façon dont la réponse est venue : de l'utilisateur, du repli sans personne à qui demander (headless),
 * ou du repli dialogue fermé (Échap). Sert quand la réponse engage différemment (confirmé par l'utilisateur ou non).
 */
async function askHow(
  $: $,
  question: string,
  options: string[],
  fallback: { headless: string; dismissed: string },
): Promise<{ answer: string; how: 'utilisateur' | 'headless' | 'ferme' }> {
  try {
    return { answer: await $.ui.ask(question, { options, header: PLUGIN }), how: 'utilisateur' }
  } catch {
    const surfaces = await $.session.surfaces().catch(() => [])
    return surfaces.length === 0 ? { answer: fallback.headless, how: 'headless' } : { answer: fallback.dismissed, how: 'ferme' }
  }
}

/** Une question de la porte : affichée « en attente de votre réponse » dans le panneau tant qu'elle est ouverte. */
async function askGate($: $, g: Gate, question: string, options: string[], fallback: { headless: string; dismissed: string }, waiting: string) {
  await setView($, g, { enAttente: waiting })
  try {
    return await askHow($, question, options, fallback)
  } finally {
    await setView($, g, { enAttente: undefined })
  }
}

/** Les commandes détectées, en gardant ce que le projet avait appris de celles qui ne changent pas (durée, exclusions) et celles ajoutées par l'orchestrateur. */
function mergeCommands(found: VerifCommande[], prev: VerifCommande[] | undefined): VerifCommande[] {
  const old = new Map((prev ?? []).map(c => [c.id, c]))
  const merged = found.map(c => {
    const o = old.get(c.id)
    return o ? { ...c, ...(o.dureeMs !== undefined ? { dureeMs: o.dureeMs } : {}), ...(o.exclus?.length ? { exclus: o.exclus } : {}) } : c
  })
  const added = (prev ?? []).filter(c => c.source === 'orchestrateur' && !found.some(f => f.id === c.id))
  return [...merged, ...added]
}

/** La liste des commandes pour l'orchestrateur (Ajuster) : une ligne chacune, puis comment la corriger. */
function adjustNote(nom: string, commandes: VerifCommande[], note?: string): string {
  const rows = commandes.map(
    c =>
      `- ${c.id} (${c.outil}, portée ${c.portee}, format ${c.format}, source ${c.source}) : ${c.format === 'crap' ? `score CRAP, seuil ${c.seuil ?? CRAP_SEUIL}, rien à lancer` : c.argv.join(' ')}${c.exclus?.length ? ` · exclus : ${c.exclus.join(', ')}` : ''}`,
  )
  return [
    `revo-flow : l'utilisateur veut ajuster les commandes de vérification de ${nom}${note ? ` (« ${note} »)` : ''} :`,
    ...rows,
    `Corrige-les avec l'outil ${VERIF_TOOL} action commandes : commandes = la liste complète corrigée [{id, outil (lint, typage, tests, format, generation, qualite), argv (sans shell ; "{fichiers}" = les fichiers du flow, "{sorties}" = le dossier des sorties), portee (fichiers, lies, projet), format, seuil (crap)}] ; la commande crap (outil qualite, format crap, argv vide) lit la couverture que les tests liés écrivent dans {sorties}/couverture : garde leurs flags de couverture. Ou commande = l'id et exclus = les motifs de tests à exclure. La question sera reposée à l'utilisateur. Sans réponse de sa part, pas de vérification pour ce flow.`,
  ].join('\n')
}

/**
 * Au lancement d'un flow (planning) : les commandes de vérification du projet. Connues et à jour (manifestes au même hash) : rien à
 * demander. Sinon détectées (§6), puis confirmées par l'utilisateur (Utiliser / Ajuster / Pas de vérification). La base de
 * référence part ensuite en fond. Rend la note pour l'orchestrateur quand l'utilisateur veut ajuster. Jamais d'exception.
 */
async function startVerif($: $, flowId: string): Promise<string | undefined> {
  // La porte du flow remplacé : son serveur de dev et son app mobile ne lui survivent pas.
  await stopProofs($, gate)
  gate = undefined
  verifStatus = undefined
  await update($, verifA, () => null)
  await update($, verifFlowA, () => null)
  if (opts.verif === 'off') return undefined
  const ref = flowRef ?? (await resolveProject(ioOf($)).catch(() => undefined))
  if (!ref) return undefined
  const graph = await graphOf($, ref, { build: true }).catch(() => null)
  if (!graph) return undefined
  const files = Object.keys(graph.fichiers)
  const paths = [...new Set([...MANIFESTES, ...manifestPaths(files)])]
  const io = ioOf($)
  const texts = await Promise.all(paths.map(p => io.fs.read(`${normalizePath(ref.racine)}/${p}`).then(t => (typeof t === 'string' ? t : undefined), () => undefined)))
  const readMap: Record<string, string | undefined> = Object.fromEntries(paths.map((p, i) => [p, texts[i]]))
  const hashes = await hashFiles($, ref.racine, paths.filter(p => readMap[p] !== undefined))
  const g: Gate = {
    flowId,
    mode: opts.verif,
    ref,
    commit: (await gitOut($, ref.racine, ['rev-parse', 'HEAD'])).trim(),
    saleAuDepart: new Set(await dirtyPaths($, ref.racine)),
    seq: 0,
    blocks: 0,
    encore: 0,
    relances: 0,
    portes: 0,
    dureeMs: 0,
    gel: [],
    gelesModifies: [],
    triches: [],
    decisions: new Map(),
    criteres: [],
  }
  gate = g
  await update($, verifA, () => ({ projet: ref.nom, mode: g.mode, etat: 'attente', tentative: 0, max: MAX_TENTATIVES, commandes: [], base: 'absente', geles: [], triches: [] }))
  await persistVerif($, g)
  // Les sorties des flows plus anciens que les 20 derniers partent, en fond.
  $.clock.after(0, async () => {
    try {
      const dir = await verifDir($)
      if (dir) await purgeOutputs(await verifIoOf($, g), dir, SORTIES_GARDEES)
    } catch {
      // une purge manquée sera rattrapée au flow suivant
    }
  })
  const pv = graph.projet.verif
  // Confirmées par l'utilisateur, manifestes au même hash : rien à demander. Confirmées sans personne à qui demander (claude -p) :
  // needsConfirm redemande, et la question repart (sans personne, encore en observateur).
  if (pv && !needsConfirm(pv, hashes)) {
    if (!pv.commandes.length) g.mode = 'off'
    await setView($, g, { mode: g.mode, etat: g.mode === 'off' ? 'off' : 'attente' })
    await persistVerif($, g)
    startBase($, g)
    return undefined
  }
  // Les pièges d'environnement (node_modules absent, pub get pas fait) : seule la présence de ces chemins compte.
  const sondes = Object.fromEntries(await Promise.all(SONDES.map(async p => [p, await io.fs.exists(`${normalizePath(ref.racine)}/${p}`).catch(() => false)] as const)))
  const found = detectCommands({ stack: graph.projet.stack, files, read: readMap, sondes, crap: opts.crap })
  // Flutter du poste différent de celui de .fvm : un piège affiché avec la question (§6.5).
  const fvm = fvmVersion(readMap)
  if (fvm) {
    const argv = withShell(['flutter', '--version', '--machine'], (await isWindows($)) ? 'windows' : 'posix')
    const out = await $.process.run(argv, { cwd: ref.racine, timeoutMs: 20_000 }).then(r => r.stdout, () => '')
    const trap = flutterVersionTrap(fvm, out)
    if (trap) found.pieges.push(trap)
  }
  if (!found.commandes.length) {
    // Rien à lancer dans ce projet : la porte reste fermée à l'écran, sans question.
    g.mode = 'off'
    await setView($, g, { mode: 'off', etat: 'off' })
    await persistVerif($, g)
    return undefined
  }
  return confirmCommands($, g, mergeCommands(found.commandes, pv?.commandes), found.pieges, hashes)
}

/**
 * La question des commandes (§4, §6.4) : Utiliser (rangées dans projet.verif avec le hash des manifestes ; sans personne à qui
 * demander, en observateur), Ajuster (l'orchestrateur reçoit la liste, la question revient après `verif commandes`), Pas de
 * vérification (ce flow seulement ; aussi sur Échap). Un texte libre vaut Ajuster, avec ce que l'utilisateur a écrit.
 * Rend la note pour l'orchestrateur, ou rien.
 */
async function confirmCommands($: $, g: Gate, commandes: VerifCommande[], pieges: string[], hashes: Record<string, string>): Promise<string | undefined> {
  await setView($, g, { etat: 'a-confirmer' })
  const { answer, how } = await askGate($, g, commandsQuestion(g.ref.nom, commandes, pieges), CONFIRM, { headless: 'Utiliser', dismissed: 'Pas de vérification' }, 'Confirmer les commandes de vérification')
  if (gate !== g) return undefined
  if (answer === 'Utiliser') {
    if (how === 'headless') g.mode = 'observer'
    g.proposees = undefined
    const le = new Date(await $.clock.now()).toISOString()
    await saveVerif($, g.ref, v => ({
      commandes,
      manifestes: hashes,
      confirme: { le, par: how === 'headless' ? 'headless' : 'utilisateur' },
      instables: v?.instables ?? [],
      pieges,
      bases: v?.bases ?? [],
    }))
    await setView($, g, { mode: g.mode, etat: 'attente' })
    await persistVerif($, g)
    startBase($, g)
    return undefined
  }
  if (answer === 'Pas de vérification') {
    g.mode = 'off'
    g.proposees = undefined
    await setView($, g, { mode: 'off', etat: 'off' })
    await persistVerif($, g)
    return undefined
  }
  g.proposees = { commandes, pieges, hashes }
  await setView($, g, { etat: 'a-confirmer', enAttente: 'Commandes à ajuster par l’orchestrateur' })
  return adjustNote(g.ref.nom, commandes, answer === 'Ajuster' ? undefined : answer)
}

/**
 * La base de référence en fond (§7) : lint et typage du projet au commit de départ, sauf si le graphe l'a déjà pour ce commit.
 * Un fichier modifié pendant qu'elle tourne la rend inutilisable (base absente). Perdue si le mod se recharge.
 */
function startBase($: $, g: Gate) {
  if (g.mode === 'off' || g.base) return
  const pv = verifOf(g)
  if (!pv?.commandes.length || !g.commit) return
  if (baseFor(pv, g.commit)) {
    void setView($, g, { base: 'prete' }).catch(() => undefined)
    return
  }
  g.baseEnCours = true
  void setView($, g, { base: 'en_cours', etat: 'base' }).catch(() => undefined)
  g.base = (async () => {
    try {
      // La ligne d'état suit la base comme la porte : « revo-flow : base de référence, typecheck… ».
      const base = await runBase(await verifIoOf($, g), pv, g.commit, c => {
        if (gate !== g) return
        verifStatus = c.etat === 'en_cours' ? `revo-flow : base de référence, ${c.id}…` : undefined
        if (verifStatus !== statusLine) {
          statusLine = verifStatus
          $.ui.status(verifStatus)
        }
      })
      if (g.baseSalie) {
        await setView($, g, { base: 'absente' })
        return
      }
      await saveVerif($, g.ref, v => addBase(v ?? pv, base))
      await setView($, g, { base: 'prete' })
    } catch {
      await setView($, g, { base: 'absente' })
    } finally {
      g.baseEnCours = false
      if (gate === g) await update($, verifA, v => (v && v.etat === 'base' ? { ...v, etat: 'attente' } : v))
    }
  })().catch(() => undefined)
}

/** Un fichier vient d'être modifié pendant le flow : une porte déjà lancée ne vaut plus, une base encore en cours non plus. */
function touchVerif(isWrite: boolean) {
  const g = gate
  if (!g) return
  g.seq++
  if (isWrite && g.baseEnCours) g.baseSalie = true
}

/** Une commande de la porte avance : la ligne du panneau, et la ligne d'état « revo-flow : typecheck… (≈ 45 s) » pendant qu'elle tourne. */
async function onCommand($: $, g: Gate, c: VerifEtatCommande) {
  if (gate !== g) return
  await update($, verifA, v => {
    if (!v) return v
    const i = v.commandes.findIndex(x => x.id === c.id)
    return { ...v, commandes: i < 0 ? [...v.commandes, c] : v.commandes.map((x, j) => (j === i ? c : x)) }
  })
  const expected = verifOf(g)?.commandes.find(x => x.id === c.id)?.dureeMs
  verifStatus = c.etat === 'en_cours' ? `revo-flow : ${c.id}…${expected ? ` (≈ ${fmtDuration(expected)})` : ''}` : undefined
  if (verifStatus !== statusLine) {
    statusLine = verifStatus
    $.ui.status(verifStatus)
  }
}

/** Les durées apprises et les tests instables d'une exécution, rangés dans projet.verif sans toucher aux commandes confirmées entre-temps. */
async function keepLearned($: $, g: Gate, learnedVerif: ProjetVerif) {
  await saveVerif($, g.ref, v => {
    const cur = v ?? learnedVerif
    const durees = new Map(learnedVerif.commandes.map(c => [c.id, c.dureeMs]))
    return {
      ...cur,
      commandes: cur.commandes.map(c => (durees.get(c.id) !== undefined ? { ...c, dureeMs: durees.get(c.id) } : c)),
      instables: [...new Set([...(cur.instables ?? []), ...(learnedVerif.instables ?? [])])],
    }
  })
}

/** Le motif de detectCheats pour un test gelé modifié : couvert par le re-hash (gelesModifies), pas par une question de plus. */
const FROZEN_MOTIF = 'test gelé modifié'

/** Ce qui bloque la porte en plus des erreurs nouvelles : un test gelé modifié ou une triche bloquante, non acceptés. */
function blockers(g: Gate): string[] {
  return [
    ...g.gelesModifies.filter(x => x.decision !== 'accepte').map(x => `Test gelé ${x.p} modifié hors outil${x.decision === 'refuse' ? ' : refusé par l’utilisateur, remets-le comme il était' : ' : en attente de la réponse de l’utilisateur'}.`),
    ...g.triches
      .filter(t => t.bloquant && t.motif !== FROZEN_MOTIF && g.decisions.get(`${t.motif}|${t.fichier}`) !== 'accepte')
      .map(t => `${t.motif} : ${t.fichier}${t.extrait ? ` (${t.extrait})` : ''}${g.decisions.get(`${t.motif}|${t.fichier}`) === 'refuse' ? ' : refusé par l’utilisateur, reviens dessus' : ''}.`),
  ]
}

const isGreen = (g: Gate, r: VerifResultat) => r.etat === 'vert' && blockers(g).length === 0

/** Le fichier de sortie à ouvrir par le bouton Détail : la première commande rouge, sinon la dernière qui en a un. */
const detailOf = (r: VerifResultat | undefined) =>
  r ? (r.commandes.find(c => (c.etat === 'ko' || c.etat === 'erreur') && c.sortie)?.sortie ?? [...r.commandes].reverse().find(c => c.sortie)?.sortie) : undefined

/** Le résultat de la dernière porte dans le panneau et la bande. */
async function showResult($: $, g: Gate) {
  const r = g.dernier
  const etat: VerifView['etat'] = g.erreur || !r ? 'erreur' : isGreen(g, r) ? 'vert' : r.etat === 'erreur' && !blockers(g).length ? 'erreur' : 'rouge'
  const detail = detailOf(r)
  await setView($, g, {
    etat,
    commandes: r?.commandes ?? [],
    tentative: g.portes,
    geles: g.gel.map(x => {
      const m = g.gelesModifies.find(y => y.p === x.p && y.decision !== 'accepte')
      return m ? { p: x.p, modifie: 'hors outil (Bash ?)' } : { p: x.p }
    }),
    triches: g.triches,
    ...(detail ? { detail } : {}),
  })
}

/**
 * Re-hash des tests gelés à chaque porte (§8) : une modification hors outil (Bash) est bloquante et soumise à l'utilisateur
 * (Accepter : le test est regelé tel quel ; Refuser, Échap ou sans personne : la porte reste rouge).
 */
async function checkFrozen($: $, g: Gate) {
  if (!g.gel.length) {
    g.gelesModifies = []
    return
  }
  const hashes = await hashFiles($, g.ref.racine, g.gel.map(x => x.p))
  const mods = rehash(g.gel, hashes)
  const prev = g.gelesModifies
  g.gelesModifies = []
  for (const m of mods) {
    const known = prev.find(x => x.p === m.p && x.decision)
    if (known) {
      g.gelesModifies.push(known)
      continue
    }
    const { answer } = await askGate(
      $,
      g,
      `Le test gelé ${m.p} (écrit par « ${m.par} ») a été modifié hors des outils d’édition, sans doute par une commande Bash. Accepter cette modification ?`,
      ['Accepter', 'Refuser'],
      { headless: 'Refuser', dismissed: 'Refuser' },
      `Test gelé ${m.p} modifié`,
    )
    if (answer === 'Accepter' && hashes[m.p]) {
      g.gel = freeze([{ p: m.p, h: hashes[m.p]! }], m.par, g.gel)
      await persistVerif($, g)
    } else g.gelesModifies.push({ ...m, decision: 'refuse' })
  }
}

/** Le diff du flow depuis le commit de départ, plus les fichiers nouveaux non suivis du flow, lus en entier (lignes ajoutées). */
async function flowDiff($: $, g: Gate, scope: string[]): Promise<string> {
  const tracked = g.commit ? await gitOut($, g.ref.racine, ['diff', g.commit, '--']) : ''
  const untracked = parseStatus(await gitOut($, g.ref.racine, ['status', '--porcelain', '-z', '--untracked-files=all']))
    .filter(e => e.x === '?' && scope.includes(e.p))
    .map(e => e.p)
    .slice(0, 50)
  const io = ioOf($)
  const added: string[] = []
  for (const p of untracked) {
    const t = await io.fs.read(`${normalizePath(g.ref.racine)}/${p}`).catch(() => undefined)
    if (typeof t !== 'string') continue
    const lines = t.split(/\r?\n/)
    added.push(`diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}`)
  }
  return [tracked, ...added].filter(Boolean).join('\n')
}

/**
 * La triche dans le diff du flow (§8) : signalée dans le panneau ; une triche bloquante (test gelé ou garde-fou modifié) est
 * soumise à l'utilisateur (Accepter / Refuser ; Échap et sans personne : Refuser) et garde la porte rouge sans son accord.
 */
async function checkCheats($: $, g: Gate, scope: string[]) {
  // Le diff part du commit de départ : il contient toujours la création des tests par le testeur. « test gelé modifié » n'est donc
  // retenu que pour un fichier que le re-hash a trouvé changé depuis le gel (checkFrozen, qui a déjà posé sa question).
  g.triches = detectCheats(await flowDiff($, g, scope), g.gel).filter(
    t => t.motif !== FROZEN_MOTIF || g.gelesModifies.some(m => unfreeze([{ p: m.p, h: '-', par: m.par }], t.fichier).length === 0),
  )
  for (const t of g.triches.filter(x => x.bloquant && x.motif !== FROZEN_MOTIF)) {
    const key = `${t.motif}|${t.fichier}`
    if (g.decisions.has(key)) continue
    const { answer } = await askGate(
      $,
      g,
      `revo-flow a repéré dans le diff du flow : ${t.motif}, ${t.fichier}${t.extrait ? ` (${t.extrait})` : ''}. Accepter ce changement ?`,
      ['Accepter', 'Refuser'],
      { headless: 'Refuser', dismissed: 'Refuser' },
      `${t.motif} : ${t.fichier}`,
    )
    g.decisions.set(key, answer === 'Accepter' ? 'accepte' : 'refuse')
  }
}

/**
 * La porte pour l'état actuel du flow : celle déjà lancée si rien n'a bougé depuis (même seq), sinon une nouvelle, en file
 * derrière les autres exécutions. undefined : pas de porte (off, commandes non confirmées, revo-flow en erreur).
 */
function ensureGate($: $, force = false): Promise<VerifResultat | undefined> {
  const g = gate
  if (!g || g.mode === 'off') return Promise.resolve(undefined)
  if (!force && g.porte && g.porte.seq === g.seq) return g.porte.promesse
  const porte = { seq: g.seq, fini: false, promesse: Promise.resolve<VerifResultat | undefined>(undefined) }
  porte.promesse = serial(() => runGlobalGate($, g)).finally(() => {
    porte.fini = true
  })
  g.porte = porte
  return porte.promesse
}

/**
 * La porte globale (§7) : toutes les commandes confirmées sur la portée du flow, comparées à la base, puis re-hash des tests
 * gelés et détection de triche. Commandes encore à confirmer (Ajuster sans suite) : la question revient une dernière fois.
 */
async function runGlobalGate($: $, g: Gate): Promise<VerifResultat | undefined> {
  if (g.proposees) {
    const p = g.proposees
    const { answer, how } = await askGate($, g, commandsQuestion(g.ref.nom, p.commandes, p.pieges), ['Utiliser', 'Pas de vérification'], { headless: 'Utiliser', dismissed: 'Pas de vérification' }, 'Confirmer les commandes de vérification')
    g.proposees = undefined
    if (answer !== 'Utiliser') {
      g.mode = 'off'
      await setView($, g, { mode: 'off', etat: 'off' })
      await persistVerif($, g)
      return undefined
    }
    if (how === 'headless') g.mode = 'observer'
    const le = new Date(await $.clock.now()).toISOString()
    await saveVerif($, g.ref, v => ({ commandes: p.commandes, manifestes: p.hashes, confirme: { le, par: how === 'headless' ? 'headless' : 'utilisateur' }, instables: v?.instables ?? [], pieges: p.pieges, bases: v?.bases ?? [] }))
    await setView($, g, { mode: g.mode })
    await persistVerif($, g)
  }
  await g.base?.catch(() => undefined)
  const pv = verifOf(g)
  if (!pv?.commandes.length) return undefined
  try {
    const scope = await flowScope($, g)
    await setView($, g, { etat: 'en_cours', commandes: [] })
    const graph = graphCache.get(g.ref.cle)?.graph
    const testsOf = testsOfGraph(graph)
    const annotes = await annotesOf($, g, scope)
    const r = await runGate(await verifIoOf($, g), pv, {
      changed: scope,
      files: Object.keys(graph?.fichiers ?? {}),
      ...(testsOf ? { testsOf } : {}),
      ...(annotes.length ? { annotes } : {}),
      commit: g.commit,
      onProgress: c => void onCommand($, g, c).catch(() => undefined),
    })
    await keepLearned($, g, r.verif)
    g.dernier = r.resultat
    g.dureeMs += r.resultat.dureeMs
    g.erreur = false
    // Lot 2 : les tests gelés, puis la triche ; leurs questions passent avant le verdict.
    await checkFrozen($, g)
    await checkCheats($, g, scope)
    await showResult($, g)
    return r.resultat
  } catch {
    // Un plantage de revo-flow ouvre la porte : le flow sera « non vérifié (erreur de revo-flow) ».
    g.erreur = true
    await setView($, g, { etat: 'erreur' })
    return undefined
  } finally {
    if (verifStatus) {
      verifStatus = undefined
      statusLine = undefined
    }
  }
}

/** « 2 erreurs nouvelles de typage dans stores/booking/Cart.ts » : la phrase de la question de fin. */
function redSummary(g: Gate, r: VerifResultat): string {
  const fresh = r.erreurs.filter(x => x.statut === 'nouvelle' || x.statut === 'nouvelle?')
  const outils = [...new Set(fresh.map(x => x.outil))]
  const fichiers = [...new Set(fresh.map(x => x.fichier))]
  const parts = [
    ...(fresh.length
      ? [`${fresh.length} erreur${fresh.length > 1 ? 's' : ''} nouvelle${fresh.length > 1 ? 's' : ''} de ${outils.join(', ')} dans ${fichiers.slice(0, 2).join(', ')}${fichiers.length > 2 ? ` et ${fichiers.length - 2} autres` : ''}`]
      : r.etat !== 'vert'
        ? [r.commandes.filter(c => c.etat === 'ko' || c.etat === 'erreur').map(c => `${c.id} en échec`).join(', ') || 'porte rouge']
        : []),
    ...blockers(g),
  ]
  return parts.join(' ; ')
}

/** Le texte du block : le rapport borné de la porte (reportText), plus ce qui bloque au titre des garde-fous. */
function blockText(g: Gate, r: VerifResultat): string {
  const extra = blockers(g)
  return [
    reportText(r, { tentative: g.blocks, maxTentatives: MAX_TENTATIVES + g.encore }),
    ...(extra.length ? ['', 'Garde-fous :', ...extra.map(x => `- ${x}`)] : []),
    '',
    `Décide : corrige toi-même, ou reprends l'agent concerné avec SendMessage, puis conclus de nouveau ; ou demande une exception (${VERIF_TOOL} action exception, avec motif) si l'erreur ne relève pas de ce flow.`,
  ].join('\n')
}

/**
 * La question de fin (§4), plafond atteint ou exception demandée : Terminer non vérifié / Une tentative de plus / Voir le détail
 * (ouvre la sortie, puis la question revient). Sans personne : terminer non vérifié, marqué ; Échap : une tentative de plus.
 */
async function endQuestion($: $, g: Gate, r: VerifResultat, motif?: string): Promise<'terminer' | 'encore'> {
  for (let i = 0; i < 3; i++) {
    const q = `La vérification reste rouge${g.portes ? ` après ${plural(g.portes, 'tentative')}` : ''} : ${redSummary(g, r)}.${motif ? ` L’orchestrateur demande une exception : « ${motif} ».` : ''} Terminer quand même ?`
    const { answer, how } = await askGate($, g, q, FIN, { headless: 'Terminer non vérifié', dismissed: 'Une tentative de plus' }, 'Terminer non vérifié ?')
    if (answer === 'Voir le détail') {
      await openVerif($)
      continue
    }
    if (answer === 'Terminer non vérifié') {
      g.libre = true
      g.accepte = how === 'utilisateur'
      await persistVerif($, g)
      return 'terminer'
    }
    return 'encore'
  }
  return 'encore'
}

/** Le tour de l'orchestrateur attend-il ses agents (travail de fond) ? Alors ce n'est pas sa conclusion. */
const waitsForAgents = (tasks: readonly { type: string; status: string }[] | undefined) =>
  (tasks ?? []).some(t => t.type === 'subagent' && !/^(completed|failed|killed|stopped|done)$/i.test(t.status))

/**
 * La porte de fin (classic.Stop de l'orchestrateur, §2 étapes 10 à 12). Seulement en conclusion d'un flow vérifié (tous les
 * agents ont fini) et pas pendant que le tour attend ses agents. Observer : la porte tourne, rien ne bloque. Bloquer : vert,
 * porte levée ou porte en erreur → le tour finit ; rouge → block avec le rapport, 3 fois au plus, puis la question de fin.
 * Rend le texte du block, ou rien.
 */
async function stopGate($: $, e: { stop_hook_active?: boolean; background_tasks?: readonly { type: string; status: string }[] }): Promise<string | undefined> {
  const g = gate
  const flow = await read($, flowA)
  if (!g || !flow || flow.id !== g.flowId || flow.isStopped || g.mode === 'off') return undefined
  if (!(flow.phase === 'review' || (flow.phase === 'running' && allFinished(flow)))) return undefined
  if (waitsForAgents(e.background_tasks)) return undefined
  if (g.mode === 'observer') {
    void ensureGate($).catch(() => undefined)
    return undefined
  }
  if (g.libre) return undefined
  // stop_hook_active : cette fin de tour suit un block. Le plafond se compte par flow ; ce compte des relances consécutives
  // est un second garde-fou, au cas où le premier serait faux (rechargement du mod) : au-delà, le tour finit.
  g.relances = e.stop_hook_active === true ? g.relances + 1 : 0
  if (g.relances > MAX_TENTATIVES + g.encore + 1) return undefined
  g.portes++
  await setView($, g, { tentative: g.portes })
  const r = await ensureGate($)
  if (gate !== g || !r) return undefined
  if (g.premierRouge === undefined) g.premierRouge = !isGreen(g, r)
  await persistVerif($, g)
  if (isGreen(g, r)) return undefined
  // Des commandes qui n'ont pas pu tourner, sans erreur nouvelle ni garde-fou : rien que l'orchestrateur puisse corriger.
  if (r.etat === 'erreur' && !blockers(g).length) return undefined
  if (g.blocks >= MAX_TENTATIVES + g.encore) {
    if ((await endQuestion($, g, r)) === 'terminer') return undefined
    g.encore++
  }
  g.blocks++
  await persistVerif($, g)
  return blockText(g, r)
}

/** Le champ verif du journal (graphe et store) pour la porte de ce flow. */
function verifJournal(g: Gate): VerifJournal {
  const r = g.dernier
  const fresh = r?.erreurs.filter(x => x.statut === 'nouvelle' || x.statut === 'nouvelle?').length ?? 0
  const old = r?.erreurs.filter(x => x.statut === 'preexistante').length ?? 0
  const green = r ? isGreen(g, r) : false
  const etat: VerifJournal['etat'] = g.mode === 'off' ? 'off' : g.erreur ? 'erreur' : g.mode === 'observer' ? 'observe' : green ? 'verifie' : 'non-verifie'
  const ok = g.verdicts?.filter(v => v.verdict === 'ok').length ?? 0
  return {
    etat,
    tentatives: Math.max(g.portes, r ? 1 : 0),
    premierRouge: g.premierRouge ?? (r ? !green : false),
    nouvelles: fresh,
    preexistantes: old,
    dureeMs: g.dureeMs,
    triches: g.triches.length,
    ...(g.accepte && !green ? { accepte: true } : {}),
    ...(g.criteres.length ? { criteres: { total: g.criteres.length, ok } } : {}),
    ...crapJournal(r),
    ...webJournal(g),
    ...mobileJournal(g),
  }
}

/** La preuve mobile du flow, pour le journal : son état, ses captures, et les verdicts appuyés sur l'appareil (dont ko). */
function mobileJournal(g: Gate): Pick<VerifJournal, 'mobile'> {
  const m = g.mobile
  if (!m || m.etat === 'non-demande') return {}
  const mobile = (g.verdicts ?? []).filter(v => v.mobile)
  return { mobile: { etat: m.etat, captures: m.captures.length, verdicts: mobile.length, ko: mobile.filter(v => v.verdict === 'ko').length } }
}

/** La preuve web du flow, pour le journal : son état, ses captures, et les verdicts appuyés sur le navigateur (dont ko). */
function webJournal(g: Gate): Pick<VerifJournal, 'web'> {
  const w = g.web
  if (!w || w.etat === 'non-demande') return {}
  const web = (g.verdicts ?? []).filter(v => v.web)
  return { web: { etat: w.etat, captures: w.captures.length, verdicts: web.length, ko: web.filter(v => v.verdict === 'ko').length } }
}

/** Le score CRAP de la dernière porte, pour le journal : fonctions au-dessus du seuil, touchées par le flow ou non ; rien si la commande n'a pas jugé. */
function crapJournal(r: VerifResultat | undefined): Pick<VerifJournal, 'crap'> {
  const c = r?.commandes.find(x => x.outil === 'qualite' && (x.etat === 'ok' || x.etat === 'ko'))
  return c ? { crap: { fonctions: c.nouvelles + c.preexistantes, nouvelles: c.nouvelles, preexistantes: c.preexistantes } } : {}
}

/** Le segment de la notification de fin : « vérifié ✓ », « non vérifié (typecheck ✗) », « non vérifié (erreur de revo-flow) ». */
function verifSegment(g: Gate): string {
  if (g.mode === 'off') return ''
  if (g.erreur) return 'non vérifié (erreur de revo-flow)'
  const r = g.dernier
  if (!r) return ''
  const line = summaryLine(r)
  if (r.etat === 'vert' && blockers(g).length) return 'non vérifié (garde-fou refusé)'
  const prefix = g.mode === 'observer' ? 'vérif observée : ' : ''
  return `${prefix}${line}${g.accepte && !isGreen(g, r) ? ' · accepté' : ''}`
}

/** Le testeur a fini : ses fichiers de test (ceux qu'il a modifiés) sont gelés à leur hash git (§8). */
async function freezeTester($: $, a: FlowAgent) {
  const g = gate
  if (!g) return
  const mine = [
    ...new Set(
      (await read($, entries))
        .filter(x => x.by === a.key)
        .map(x => relTo(g.ref.racine, x.path))
        .filter((p): p is string => !!p && isTestFile(p, g.ref.racine)),
    ),
  ]
  if (!mine.length) return
  const hashes = await hashFiles($, g.ref.racine, mine)
  const files = mine.filter(p => hashes[p]).map(p => ({ p, h: hashes[p]! }))
  if (!files.length) return
  g.gel = freeze(files, a.key, g.gel)
  await persistVerif($, g)
  await setView($, g, { geles: g.gel.map(x => ({ p: x.p })) })
  $.ui.toast(`revo-flow : ${plural(files.length, 'test')} de « ${a.name} » ${files.length > 1 ? 'gelés' : 'gelé'}`)
}

/**
 * Le refus d'une édition (Edit, Write, NotebookEdit) au titre du gel : le testeur ne touche qu'aux fichiers de test, un test gelé
 * ne se modifie que par son auteur jusqu'au dégel. Rien hors d'un flow vérifié.
 */
async function editDenial($: $, e: { agentId?: string }): Promise<string | undefined> {
  const g = gate
  if (!g) return undefined
  const flow = await read($, flowA)
  if (!flow || flow.id !== g.flowId || flow.phase === 'done') return undefined
  const input = e as unknown as Record<string, unknown>
  const raw = text(input.file_path) || text(input.notebook_path)
  if (!raw) return undefined
  const who = whoIs(flow, e.agentId) ?? e.agentId ?? ''
  const a = who && who !== 'lead' ? flow.agents.find(x => x.key === who) : undefined
  if (a && isTester(a)) {
    const deny = testerDenial(raw, g.ref.racine)
    if (deny) return deny
  }
  return g.gel.length ? frozenDenial(g.gel, relTo(g.ref.racine, raw) ?? raw, who) : undefined
}

/** Le gel est-il actif (des tests gelés, ou un testeur au travail) ? Le .catch du hook d'édition refuse alors par prudence. */
const isGelActive = () => !!gate && (gate.gel.length > 0 || testerAgents.size > 0)

const GEL_ERROR = 'revo-flow : le contrôle des tests gelés a échoué ; modification refusée par prudence, réessaie.'

/** Les commandes confirmées du projet, telles que le vérificateur peut les lancer (argv) : sans la commande crap ni les flags de couverture ('{sorties}'). */
const confirmedArgv = () => (gate ? withoutCrap(verifOf(gate)?.commandes ?? []).map(c => c.argv) : [])

/** La consigne de tâche du vérificateur : critères, git diff --stat du flow, commandes confirmées, triches repérées, preuve web. */
async function verifierBrief($: $): Promise<string | undefined> {
  const g = gate
  if (!g) return undefined
  const stat = g.commit ? await gitOut($, g.ref.racine, ['diff', '--stat', g.commit, '--']) : ''
  const graph = opts.web === 'off' && opts.mobile === 'off' ? null : await graphOf($, g.ref).catch(() => null)
  return verifierTask(g.criteres, stat, withoutCrap(verifOf(g)?.commandes ?? []), g.triches, await preuveTask($, g.ref, graph))
}

/**
 * Le paragraphe de la preuve à l'exécution du vérificateur, choisi selon le projet : « Preuve mobile » sur une app Flutter, React Native
 * ou Expo (même désactivée, pour le dire), sinon « Preuve web » (serveur de dev de package.json).
 */
async function preuveTask($: $, ref: ProjectRef, graph: Graph | null | undefined): Promise<string> {
  const mobile = await mobileDispo($, ref, graph)
  if (mobile.app) return verifierMobileTask(mobile)
  return verifierWebTask(await webDispo($, ref, graph))
}

/** La réponse du vérificateur : un verdict par critère (parseVerdicts), dans le panneau ; une réponse sans aucun verdict lisible ne remplace pas la précédente. */
async function readVerdicts($: $, answer: string) {
  const g = gate
  if (!g || !g.criteres.length) return
  const verdicts = parseVerdicts(answer, g.criteres)
  const readable = verdicts.some(v => !/^pas de verdict|^réponse du vérificateur illisible/.test(v.preuve))
  if (!readable && g.verdicts) return
  g.verdicts = verdicts
  await setView($, g, { criteres: { total: g.criteres.length, ok: verdicts.filter(v => v.verdict === 'ok').length, verdicts } })
}

/**
 * Après un rechargement du mod en plein flow : la porte est reconstruite depuis l'atom verifFlow (gel, critères, tentatives)
 * et le graphe (commandes) ; la base qui tournait est perdue, ses erreurs seront « nouvelle ? ».
 */
async function restoreVerif($: $) {
  const flow = await read($, flowA)
  const saved = await read($, verifFlowA)
  if (gate || !flow || flow.phase === 'done' || !saved || saved.flowId !== flow.id) return
  const ref = await resolveProject(ioOf($)).catch(() => undefined)
  if (!ref) return
  flowRef = flowRef ?? ref
  await graphOf($, ref).catch(() => null)
  gate = {
    flowId: saved.flowId,
    mode: saved.mode,
    ref,
    commit: saved.commit,
    saleAuDepart: new Set(),
    seq: 0,
    blocks: saved.blocks,
    encore: 0,
    relances: 0,
    portes: saved.portes,
    dureeMs: 0,
    gel: saved.gel,
    gelesModifies: [],
    triches: [],
    decisions: new Map(),
    criteres: saved.criteres,
    ...(saved.accepte ? { accepte: true, libre: true } : {}),
  }
  // La preuve web : un serveur en question, en démarrage ou prêt est mort avec le module (arrete) ; les captures restent.
  const view = await read($, verifA)
  const live = (s: WebEtat) => s === 'question' || s === 'demarrage' || s === 'pret'
  const web = view?.web ? { ...view.web, etat: live(view.web.etat) ? ('arrete' as const) : view.web.etat } : undefined
  if (web) {
    gate.web = {
      etat: web.etat,
      captures: [...web.captures],
      sortie: '',
      ...(web.url ? { url: web.url } : {}),
      ...(web.existant ? { existant: true } : {}),
      ...(web.note ? { note: web.note } : {}),
      ...(web.commande ? { commande: web.commande } : {}),
    }
  }
  // La preuve mobile : une app en question, en démarrage, en installation ou prête est morte avec le module (arrete) ; les captures restent.
  const liveM = (s: MobileEtat) => s === 'question' || s === 'demarrage' || s === 'installation' || s === 'pret'
  const mobile = view?.mobile ? { ...view.mobile, etat: liveM(view.mobile.etat) ? ('arrete' as const) : view.mobile.etat } : undefined
  if (mobile) {
    gate.mobile = {
      etat: mobile.etat,
      captures: [...mobile.captures],
      sortie: '',
      ...(mobile.note ? { note: mobile.note } : {}),
      ...(mobile.commande ? { commande: mobile.commande } : {}),
    }
  }
  await update($, verifA, v =>
    v
      ? {
          ...v,
          base: v.base === 'en_cours' ? 'absente' : v.base,
          etat: v.etat === 'en_cours' || v.etat === 'base' ? 'attente' : v.etat,
          ...(web ? { web } : {}),
          ...(mobile ? { mobile } : {}),
        }
      : v,
  )
}

/** Un `verif lancer` d'un agent : seulement ses fichiers (ceux qu'il a modifiés, ou ceux qu'il donne), rapport limité à eux. */
async function lancerTool($: $, g: Gate, who: string, e: Record<string, unknown>): Promise<string> {
  if (g.mode === 'off') return 'revo-flow verif : pas de vérification pour ce flow (option ou choix de l’utilisateur) ; continue.'
  if (g.proposees) return 'revo-flow verif : les commandes de vérification attendent encore la confirmation de l’utilisateur ; continue, la porte de fin vérifiera.'
  const given = (Array.isArray(e.fichiers) ? e.fichiers : []).map(text).filter(Boolean).map(p => relTo(g.ref.racine, p) ?? p)
  const flow = await read($, flowA)
  const mine =
    who === 'lead'
      ? await flowScope($, g)
      : (await read($, entries))
          .filter(x => x.by === who)
          .map(x => relTo(g.ref.racine, x.path))
          .filter((p): p is string => !!p)
  const files = await existing($, g, [...new Set([...mine, ...given])])
  if (!files.length) return 'revo-flow verif : aucun fichier modifié à ton nom, rien à vérifier (donne-les dans « fichiers » si tu les as créés par Bash).'
  await g.base?.catch(() => undefined)
  const pv = verifOf(g)
  if (!pv?.commandes.length) return 'revo-flow verif : aucune commande de vérification confirmée pour ce projet ; continue.'
  const graph = graphCache.get(g.ref.cle)?.graph
  const testsOf = testsOfGraph(graph)
  const only = who === 'lead' ? undefined : files
  const annotes = await annotesOf($, g, files)
  const r = await serial(async () => {
    await setView($, g, { etat: 'en_cours', commandes: [] })
    try {
      return await runGate(await verifIoOf($, g), pv, {
        changed: files,
        files: Object.keys(graph?.fichiers ?? {}),
        ...(testsOf ? { testsOf } : {}),
        ...(annotes.length ? { annotes } : {}),
        commit: g.commit,
        ...(only ? { seulement: only } : {}),
        onProgress: c => void onCommand($, g, c).catch(() => undefined),
      })
    } finally {
      verifStatus = undefined
    }
  })
  await keepLearned($, g, r.verif)
  // Le panneau montre l'exécution ; la porte de fin reste celle de tout le flow.
  await setView($, g, { etat: g.dernier ? (isGreen(g, g.dernier) ? 'vert' : 'rouge') : 'attente', commandes: r.resultat.commandes })
  const name = flow?.agents.find(a => a.key === who)?.name
  return `${name ? `revo-flow verif (« ${name} », ${plural(files.length, 'fichier')}) :\n` : ''}${reportText(r.resultat, { ...(only ? { seulement: only } : {}) })}`
}

/** Une commande proposée par l'orchestrateur : validée champ par champ, source « orchestrateur » si elle est nouvelle. */
function commandOf(raw: unknown, known: VerifCommande[]): VerifCommande | string {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const id = text(o.id)
  const outils: VerifOutil[] = ['lint', 'typage', 'tests', 'format', 'generation', 'qualite']
  const portees: VerifPortee[] = ['fichiers', 'lies', 'projet']
  const formats: VerifFormat[] = ['eslint-json', 'tsc', 'vitest-json', 'jest-json', 'biome', 'dart-machine', 'flutter-json', 'texte', 'crap']
  const argv = Array.isArray(o.argv) ? o.argv.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
  if (!id) return 'une commande sans « id »'
  if (!outils.includes(text(o.outil) as VerifOutil)) return `« ${id} » : outil doit être lint, typage, tests, format, generation ou qualite`
  const format = formats.includes(text(o.format) as VerifFormat) ? (text(o.format) as VerifFormat) : 'texte'
  // Le score CRAP ne lance rien (il lit la couverture des tests liés) : outil qualite et format crap vont ensemble, argv vide permis.
  const crap = format === 'crap'
  if (crap !== (text(o.outil) === 'qualite')) return `« ${id} » : le score CRAP s'écrit outil qualite et format crap, les deux ensemble`
  if (!argv.length && !crap) return `« ${id} » : argv vide (la commande mot à mot, sans shell)`
  if (!portees.includes(text(o.portee) as VerifPortee)) return `« ${id} » : portee doit être fichiers, lies ou projet`
  const seuil = typeof o.seuil === 'number' && Number.isFinite(o.seuil) && o.seuil > 0 ? o.seuil : undefined
  const same = known.find(k => k.id === id)
  const unchanged = same && same.argv.join('\u0000') === argv.join('\u0000') && same.portee === text(o.portee)
  return {
    id,
    outil: text(o.outil) as VerifOutil,
    argv,
    portee: text(o.portee) as VerifPortee,
    format,
    source: same && unchanged ? same.source : 'orchestrateur',
    ...(text(o.declencheur) ? { declencheur: text(o.declencheur) } : {}),
    ...(same?.dureeMs !== undefined ? { dureeMs: same.dureeMs } : {}),
    ...(texts(o.exclus).length ? { exclus: texts(o.exclus) } : same?.exclus?.length ? { exclus: same.exclus } : {}),
    ...(same?.origine ? { origine: same.origine } : {}),
    ...(crap ? { seuil: seuil ?? same?.seuil ?? CRAP_SEUIL } : {}),
  }
}

/** `verif commandes` (orchestrateur) : une liste corrigée, ou des tests à exclure d'une commande ; toujours reposée à l'utilisateur. */
async function commandesTool($: $, g: Gate, e: Record<string, unknown>): Promise<string> {
  const pv = verifOf(g)
  const known = g.proposees?.commandes ?? pv?.commandes ?? []
  let list: VerifCommande[]
  if (Array.isArray(e.commandes) && e.commandes.length) {
    const parsed = e.commandes.map(c => commandOf(c, known))
    const bad = parsed.find((c): c is string => typeof c === 'string')
    if (bad) return `revo-flow verif : commandes refusées : ${bad}.`
    list = parsed as VerifCommande[]
  } else if (texts(e.exclus).length) {
    const id = text(e.commande)
    const target = known.find(c => c.id === id)
    if (!target) return `revo-flow verif : « commande » = l’id d’une commande connue (${known.map(c => c.id).join(', ') || 'aucune'}).`
    list = known.map(c => (c.id === id ? { ...c, exclus: [...new Set([...(c.exclus ?? []), ...texts(e.exclus)])] } : c))
  } else return 'revo-flow verif : donne « commandes » (la liste corrigée) ou « commande » et « exclus » (les motifs de tests à exclure).'
  const pieges = g.proposees?.pieges ?? pv?.pieges ?? []
  const hashes = g.proposees?.hashes ?? pv?.manifestes ?? {}
  const wasOff = g.mode === 'off'
  if (wasOff) g.mode = opts.verif
  const note = await confirmCommands($, g, list, pieges, hashes)
  if (gate !== g) return 'revo-flow verif : le flow a changé entre-temps.'
  if (note) return `revo-flow verif : l’utilisateur veut encore ajuster ; demande-lui quoi, puis rappelle l’action commandes.\n${note}`
  if (g.mode === 'off') return 'revo-flow verif : l’utilisateur ne veut pas de vérification pour ce flow.'
  return `revo-flow verif : ${plural(list.length, 'commande')} confirmée${list.length > 1 ? 's' : ''} par l’utilisateur et enregistrée${list.length > 1 ? 's' : ''} pour ${g.ref.nom}.`
}

/**
 * L'outil verif : lancer, resultat, commandes, exception, degeler, web. commandes, exception et degeler sont réservées à l'orchestrateur,
 * web au vérificateur (et à l'orchestrateur).
 */
async function verifTool($: $, e: Record<string, unknown> & { agentId?: string }): Promise<string> {
  const action = text(e.action).toLowerCase()
  const g = gate
  const flow = await read($, flowA)
  if (!g || !flow || flow.id !== g.flowId || flow.phase === 'done') return 'revo-flow verif : aucun flow vérifié en cours ; continue.'
  const who = whoIs(flow, e.agentId) ?? e.agentId ?? 'lead'
  const leadOnly = (s: string) => (who === 'lead' ? undefined : `revo-flow verif : l’action ${s} est réservée à l’orchestrateur ; dis-lui ce qu’il faut dans ta réponse.`)
  switch (action) {
    case 'lancer':
      return lancerTool($, g, who, e)
    case 'resultat': {
      if (!g.dernier) return g.porte && !g.porte.fini ? 'revo-flow verif : la porte tourne encore ; rappelle resultat dans un moment.' : 'revo-flow verif : aucune porte encore lancée (elle part quand tous les agents ont fini).'
      const extra = blockers(g)
      const crit = g.verdicts?.length ? [`Critères : ${g.verdicts.map(v => `${v.id} ${v.verdict}`).join(', ')}`] : []
      return [reportText(g.dernier, { tentative: g.portes, maxTentatives: MAX_TENTATIVES }), ...extra.map(x => `- ${x}`), ...crit].join('\n')
    }
    case 'commandes':
      return leadOnly('commandes') ?? commandesTool($, g, e)
    case 'exception': {
      const denied = leadOnly('exception')
      if (denied) return denied
      const motif = text(e.motif)
      if (!motif) return 'revo-flow verif : « motif » manquant (pourquoi terminer malgré la porte rouge, en une phrase).'
      const r = g.dernier
      if (!r || isGreen(g, r)) return 'revo-flow verif : la porte n’est pas rouge, pas d’exception à demander.'
      const choice = await endQuestion($, g, r, motif)
      if (choice === 'terminer') return 'revo-flow verif : l’utilisateur accepte de terminer non vérifié ; conclus (le flow sera marqué non vérifié).'
      if (g.blocks >= MAX_TENTATIVES + g.encore) g.encore++
      await persistVerif($, g)
      return 'revo-flow verif : l’utilisateur veut une tentative de plus : corrige, puis conclus.'
    }
    case 'degeler': {
      const denied = leadOnly('degeler')
      if (denied) return denied
      const motif = text(e.motif)
      const asked = [...texts(e.fichiers), text(e.chemin)].filter(Boolean).map(p => relTo(g.ref.racine, p) ?? p)
      if (!motif || !asked.length) return 'revo-flow verif : donne « fichiers » (les tests gelés à dégeler) et « motif » (pourquoi le test est faux).'
      const targets = g.gel.filter(x => asked.some(p => unfreeze([x], p).length === 0))
      if (!targets.length) return `revo-flow verif : aucun de ces fichiers n’est gelé (gelés : ${g.gel.map(x => x.p).join(', ') || 'aucun'}).`
      const { answer } = await askGate(
        $,
        g,
        `L’orchestrateur demande de dégeler ${targets.map(x => x.p).join(', ')} : « ${motif} ». Dégeler ?`,
        ['Dégeler', 'Garder gelé'],
        { headless: 'Garder gelé', dismissed: 'Garder gelé' },
        'Dégeler un test ?',
      )
      if (answer !== 'Dégeler') return 'revo-flow verif : l’utilisateur garde ces tests gelés ; corrige le code de production.'
      for (const x of targets) g.gel = unfreeze(g.gel, x.p)
      await persistVerif($, g)
      await setView($, g, { geles: g.gel.map(x => ({ p: x.p })) })
      return `revo-flow verif : ${targets.map(x => x.p).join(', ')} dégelé${targets.length > 1 ? 's' : ''} par l’utilisateur.`
    }
    case 'web': {
      const isAllowed = who === 'lead' || (!!e.agentId && verifierAgents.has(e.agentId))
      if (!isAllowed) return 'revo-flow verif : l’action web est réservée au vérificateur.'
      // Une app mobile : la preuve à l'exécution de ce projet est la preuve mobile, pas un serveur de dev.
      const app = await mobileAppOf($, g.ref).catch(() => undefined)
      if (app) return `revo-flow verif : ce projet est une app mobile ${frameworkLabel(app.framework)} (${app.origine}) : sa preuve à l’exécution passe par l’action mobile, pas web. Appelle action "mobile".`
      return webTool($, g, flow.isStopped === true)
    }
    case 'mobile': {
      const isAllowed = who === 'lead' || (!!e.agentId && verifierAgents.has(e.agentId))
      if (!isAllowed) return 'revo-flow verif : l’action mobile est réservée au vérificateur.'
      return mobileTool($, g, flow.isStopped === true)
    }
    default:
      return `revo-flow verif : action « ${action} » inconnue (lancer, resultat, commandes, exception, degeler, web, mobile).`
  }
}

// ── Preuve web (v3, docs/rd-v2/execution.md §2) ──────────────────────────

/** La sortie du serveur de dev gardée pour y lire l'URL (et la dernière ligne quand il meurt) : les 8 000 derniers caractères. */
const WEB_SORTIE_MAX = 8000
/** Une capture affichée dans le panneau au plus à cette taille de texte base64 (Image accepte 2 Mio). */
const CAPTURE_MAX = 1_500_000
/** La note d'une preuve web sans serveur de dev détecté : la réponse au vérificateur le dit à part. */
const NO_DEV_SERVER = 'aucun serveur de dev détecté'

/** La preuve web de la porte, créée à la première demande. */
function webOf(g: Gate): GateWeb {
  if (!g.web) g.web = { etat: 'non-demande', captures: [], sortie: '' }
  return g.web
}

/** Ce que le panneau et le rapport montrent de la preuve web (VerifView.web). */
function webView(g: Gate): WebView {
  const w = webOf(g)
  const commande = w.serveur ? commandeText(w.serveur) : w.commande
  return {
    etat: w.etat,
    ...(commande ? { commande } : {}),
    ...(w.url ? { url: w.url } : {}),
    ...(w.existant ? { existant: true } : {}),
    captures: [...w.captures],
    ...(w.note ? { note: w.note } : {}),
  }
}

/** Change la preuve web (en place : le serveur en fond garde la même référence) et la pousse dans la vue de la porte. */
async function setWeb($: $, g: Gate, patch: Partial<GateWeb>) {
  Object.assign(webOf(g), patch)
  await setView($, g, { web: webView(g) }).catch(() => undefined)
}

/**
 * Les lectures de la preuve web (WebDispo) : le serveur de dev détecté et la présence de REVO_WEB_LOGIN, jamais sa valeur ailleurs.
 * deja : les fichiers déjà lus par l'appelant (chemin relatif → texte), qui ne sont pas relus.
 */
async function webDispo($: $, ref: ProjectRef | undefined, graph: Graph | null | undefined, deja?: Record<string, string | undefined>): Promise<WebDispo> {
  if (opts.web === 'off') return { option: 'off', login: false }
  const serveur = ref ? await devServerOf($, ref, graph, deja) : undefined
  const login = Boolean(await $.env.get('REVO_WEB_LOGIN').catch(() => undefined))
  return { option: opts.web, ...(serveur ? { serveur } : {}), login }
}

/**
 * Le serveur de dev du projet (detectDevServer) : package.json, .env et les nuxt.config.* / vite.config.* de la racine, lus par ioOf ;
 * un chemin présent dans deja (déjà lu, même absent) n'est pas relu.
 */
async function devServerOf($: $, ref: ProjectRef, graph: Graph | null | undefined, deja: Record<string, string | undefined> = {}): Promise<WebServeur | undefined> {
  try {
    const files = Object.keys(graph?.fichiers ?? {})
    const paths = [...new Set([...WEB_MANIFESTES, ...files.filter(p => /^(nuxt|vite)\.config\.[a-z]+$/i.test(p))])]
    const io = ioOf($)
    const root = normalizePath(ref.racine)
    const texts = await Promise.all(
      paths.map(p => (p in deja ? Promise.resolve(deja[p]) : io.fs.read(`${root}/${p}`).then(t => (typeof t === 'string' ? t : undefined), () => undefined))),
    )
    const stack = graph?.projet.stack
    return detectDevServer({ files, read: Object.fromEntries(paths.map((p, i) => [p, texts[i]])), ...(stack ? { stack } : {}) })
  } catch {
    return undefined
  }
}

/**
 * Le port est-il déjà pris par un serveur à l'écoute ? Windows : netstat -ano (IPv4 et IPv6), une ligne TCP dont l'adresse locale
 * finit en :<port>, à l'écoute ; ailleurs : lsof -nP -iTCP:<port> -sTCP:LISTEN, sortie non vide. Une commande qui échoue vaut « libre ».
 */
async function portTaken($: $, port: number): Promise<boolean> {
  try {
    if (await isWindows($)) {
      const r = await $.process.run(['netstat', '-ano'], { timeoutMs: 10_000 })
      return r.stdout.split(/\r?\n/).some(line => {
        const cols = line.trim().split(/\s+/)
        return cols[0]?.toUpperCase() === 'TCP' && !!cols[1]?.endsWith(`:${port}`) && (/LISTENING/i.test(line) || /^(0\.0\.0\.0|\[::\]|\*):[0*]$/.test(cols[2] ?? ''))
      })
    }
    const r = await $.process.run(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeoutMs: 10_000 })
    return r.exitCode === 0 && r.stdout.trim().length > 0
  } catch {
    return false
  }
}

/** La réponse de `verif web` au vérificateur, selon l'état de la preuve web. */
function webAnswer(w: GateWeb): string {
  const commande = w.serveur ? commandeText(w.serveur) : (w.commande ?? 'serveur de dev')
  if (w.etat === 'pret' && w.url) {
    return `revo-flow verif : serveur prêt sur ${w.url} (${commande}, ${w.existant ? 'déjà en marche' : 'démarré par revo-flow'}) — navigue seulement sur cette origine ; cite dans chaque preuve l’URL, l’élément vu, le nombre d’erreurs console et de réponses 4xx/5xx ; une capture par critère (computer screenshot).`
  }
  if (w.etat === 'refuse') return 'revo-flow verif : l’utilisateur ne démarre pas le serveur : preuve web non vérifiable, dis-le dans tes preuves.'
  if (w.etat === 'erreur' && w.note === NO_DEV_SERVER) {
    return 'revo-flow verif : aucun serveur de dev détecté (pas de script dev dans package.json) : preuve web impossible, juge non vérifiable.'
  }
  if (w.etat === 'erreur') return `revo-flow verif : le serveur n’a pas démarré (${w.note ?? 'erreur inconnue'}) : preuve web non vérifiable.`
  return 'revo-flow verif : le serveur de dev est arrêté : preuve web non vérifiable.'
}

/**
 * `verif web` : le serveur de dev de la preuve web. Un second appel attend la demande en cours et rend la même réponse ; prêt,
 * refusé ou en erreur, la réponse reste ; arrêté (fin de flow puis agent relancé, rechargement du mod), la demande repart, sauf
 * pour un flow arrêté par l'utilisateur.
 */
async function webTool($: $, g: Gate, isStopped: boolean): Promise<string> {
  if (opts.web === 'off') return 'revo-flow verif : preuve web désactivée (option web) ; juge non vérifiable ce qui demande le navigateur.'
  const w = webOf(g)
  if (!w.enCours && (w.etat === 'non-demande' || (w.etat === 'arrete' && !isStopped))) {
    w.enCours = true
    w.attente = startWeb($, g, w)
      .catch(async err => {
        if (w.etat === 'question' || w.etat === 'demarrage' || w.etat === 'non-demande') await setWeb($, g, { etat: 'erreur', note: errText(err) })
      })
      .finally(() => {
        w.enCours = false
      })
  }
  await w.attente
  return webAnswer(w)
}

/**
 * Détecte le serveur de dev, puis demande à l'utilisateur : port déjà pris, utiliser le serveur en marche (revo-flow n'arrête rien) ;
 * sinon, démarrer la commande. Rend quand l'issue est connue (pret, refuse ou erreur). Échap et -p : pas cette fois.
 */
async function startWeb($: $, g: Gate, w: GateWeb): Promise<void> {
  Object.assign(w, { url: undefined, existant: undefined, note: undefined, sortie: '', stop: undefined })
  const graph = await graphOf($, g.ref).catch(() => null)
  const serveur = await devServerOf($, g.ref, graph)
  if (!serveur) return setWeb($, g, { etat: 'erreur', note: NO_DEV_SERVER })
  w.serveur = serveur
  const port = serveur.port
  const no = { headless: 'Pas cette fois', dismissed: 'Pas cette fois' }
  if (port !== undefined && (await portTaken($, port))) {
    await setWeb($, g, { etat: 'question' })
    const url = `http://localhost:${port}`
    const { answer } = await askGate(
      $,
      g,
      `Le port ${port} est déjà pris : un serveur tourne sans doute. Utiliser ${url} pour la preuve web ? (revo-flow n’arrête rien)`,
      ['Utiliser', 'Pas cette fois'],
      no,
      'Preuve web : utiliser le serveur déjà en marche ?',
    )
    // Arrêtée pendant la question (fin de flow, porte remplacée) : rien ne change.
    if (w.etat !== 'question') return
    return setWeb($, g, answer === 'Utiliser' ? { etat: 'pret', existant: true, url } : { etat: 'refuse' })
  }
  await setWeb($, g, { etat: 'question' })
  const commande = commandeText(serveur)
  const { answer } = await askGate(
    $,
    g,
    `Démarrer « ${commande} » pour ${g.ref.nom}${port !== undefined ? ` (port ${port})` : ''} ? Le vérificateur l’ouvrira dans le navigateur pour la preuve web.`,
    ['Démarrer', 'Pas cette fois'],
    no,
    'Preuve web : démarrer le serveur de dev ?',
  )
  if (w.etat !== 'question') return
  if (answer !== 'Démarrer') return setWeb($, g, { etat: 'refuse' })
  await setWeb($, g, { etat: 'demarrage' })
  await spawnServer($, g, w, serveur)
}

/** L'itérateur de ce que rend $.process.spawn : un itérable asynchrone, ou déjà un itérateur. */
function iteratorOf(proc: unknown): AsyncIterator<unknown> | undefined {
  if (!proc || (typeof proc !== 'object' && typeof proc !== 'function')) return undefined
  const o = proc as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown>; next?: unknown }
  if (typeof o[Symbol.asyncIterator] === 'function') return o[Symbol.asyncIterator]!()
  return typeof o.next === 'function' ? (o as AsyncIterator<unknown>) : undefined
}

/** Le texte d'un morceau de sortie de $.process.spawn : une chaîne, ou un objet dont text, data, chunk ou line est une chaîne ou des octets. */
function chunkText(c: unknown): string {
  const decode = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v
    if (v instanceof Uint8Array) {
      try {
        return new TextDecoder().decode(v)
      } catch {
        return ''
      }
    }
    return undefined
  }
  const direct = decode(c)
  if (direct !== undefined) return direct
  if (!c || typeof c !== 'object') return ''
  const o = c as Record<string, unknown>
  for (const k of ['text', 'data', 'chunk', 'line']) {
    const t = decode(o[k])
    if (t !== undefined) return k === 'line' && !t.endsWith('\n') ? `${t}\n` : t
  }
  return ''
}

/** La dernière ligne non vide d'une sortie, sans les codes de couleur ANSI. */
function lastLine(out: string): string {
  const lines = sansAnsi(out)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  return (lines.at(-1) ?? 'sans sortie').slice(0, 200)
}

/**
 * Lance le serveur de dev ($.process.spawn, cmd /c sous Windows) et lit sa sortie en fond (une boucle sur l'itérateur, comme
 * for await) : URL annoncée → pret ; port pris dans la sortie, processus mort ou 90 s sans URL → erreur (le processus est arrêté).
 * Rend quand l'issue est connue ; la lecture continue ensuite (quitter la boucle tuerait le serveur). Jamais d'exception.
 */
async function spawnServer($: $, g: Gate, w: GateWeb, serveur: WebServeur): Promise<void> {
  const os = (await isWindows($)) ? 'windows' : 'posix'
  let proc: unknown
  try {
    proc = await $.process.spawn({ argv: withShell(serveur.argv, os), cwd: g.ref.racine })
  } catch (err) {
    return setWeb($, g, { etat: 'erreur', note: `lancement impossible : ${errText(err)}` })
  }
  const it = iteratorOf(proc)
  if (!it) return setWeb($, g, { etat: 'erreur', note: 'lancement impossible : sortie du serveur illisible' })
  let isStopped = false
  // Fermer l'itérateur tue le processus (cc:3603-3605), kill en plus s'il existe ; rien n'est attendu : un itérateur dont un next()
  // est en suspens peut ne rendre la main qu'à la sortie suivante, et l'arrêt ne doit jamais retenir la fin du flow.
  const stop = async () => {
    if (isStopped) return
    isStopped = true
    const call = (target: unknown, name: 'return' | 'kill') => {
      try {
        const fn = (target as Record<string, unknown> | null)?.[name]
        if (typeof fn === 'function') void Promise.resolve(fn.call(target)).catch(() => undefined)
      } catch {
        // déjà fermé
      }
    }
    call(it, 'return')
    if (proc !== it) call(proc, 'return')
    call(proc, 'kill')
  }
  w.stop = stop
  // Arrêtée pendant le lancement (fin de flow, porte remplacée) : le serveur ne reste pas.
  if (w.etat !== 'demarrage') {
    await stop()
    return
  }
  await new Promise<void>(resolve => {
    let isSettled = false
    let timer: { cancel?: () => void } | undefined
    const settle = async (patch: Partial<GateWeb>, kill = false) => {
      if (isSettled) return
      isSettled = true
      timer?.cancel?.()
      if (kill) await stop()
      await setWeb($, g, patch)
      resolve()
    }
    timer = $.clock.after(WEB_ATTENTE_MS, () => void settle({ etat: 'erreur', note: `pas d’URL annoncée en ${Math.round(WEB_ATTENTE_MS / 1000)} s` }, true)) as unknown as
      | { cancel?: () => void }
      | undefined
    void (async () => {
      try {
        for (;;) {
          const r = await it.next()
          if (r.done) break
          w.sortie = (w.sortie + chunkText(r.value)).slice(-WEB_SORTIE_MAX)
          if (isSettled) continue
          const url = urlFromOutput(w.sortie)
          if (url) await settle({ etat: 'pret', url })
          // « Port 3000 is in use, trying another one » n'est pas fatal : l'URL qui suit l'emporte (le délai couvre le reste).
          else if (portFatalInOutput(w.sortie)) await settle({ etat: 'erreur', note: portNote(serveur) }, true)
        }
      } catch {
        // la sortie est perdue : le processus aussi
      }
      if (isStopped) return
      isStopped = true
      const note = `le serveur s’est arrêté : ${lastLine(w.sortie)}`
      if (!isSettled) await settle({ etat: 'erreur', note })
      // Mort après avoir annoncé son URL : la preuve web n'a plus de serveur, les outils du navigateur sont refusés.
      else if (w.etat === 'pret' && !w.existant) await setWeb($, g, { etat: 'erreur', note })
    })().catch(() => undefined)
  })
}

/** La note d'un port pris annoncé par le serveur lui-même (EADDRINUSE…). */
const portNote = (s: WebServeur) => (s.port !== undefined ? `port ${s.port} déjà pris` : 'port déjà pris')

/**
 * Arrête le serveur de dev lancé par revo-flow (jamais un serveur déjà en marche) : fin de flow, Tout arrêter, flow abandonné, porte
 * remplacée. Prêt, en question ou en démarrage : arrete ; refuse, erreur et non-demande restent. Jamais d'exception.
 */
async function stopWeb($: $, g: Gate | undefined) {
  const w = g?.web
  if (!g || !w) return
  try {
    if (!w.existant) await w.stop?.()
  } catch {
    // arrêt au mieux : le serveur meurt aussi avec le module
  }
  w.stop = undefined
  if (w.etat === 'refuse' || w.etat === 'erreur' || w.etat === 'non-demande') return
  w.etat = 'arrete'
  await setView($, g, { web: webView(g) }).catch(() => undefined)
}

/** La dernière capture déjà lue (base64), pour ne lire qu'une fois le fichier de chaque capture. */
let shownCapture: { path: string; png: string | undefined } | undefined

/** La dernière capture de la preuve web ou mobile pour le panneau terminal (Image) : son .png.txt, lu une fois, ignoré au-delà de 1,5 Mo. */
async function lastCapture($: $, v: VerifView | null): Promise<ViewData['capture']> {
  const last = v?.mobile?.captures.at(-1) ?? v?.web?.captures.at(-1)
  if (!last) return undefined
  const path = last.endsWith('.txt') ? last : `${last}.txt`
  if (shownCapture?.path !== path) {
    let png: string | undefined
    try {
      const t = await $.fs.read(path)
      png = typeof t === 'string' && t.length > 0 && t.length <= CAPTURE_MAX ? t.trim() : undefined
    } catch {
      png = undefined
    }
    shownCapture = { path, png }
  }
  return shownCapture.png ? { png: shownCapture.png, nom: baseName(path).replace(/\.txt$/, '') } : undefined
}

/**
 * Une capture d'écran du vérificateur pendant la preuve web : le PNG du résultat (extractPng), en base64 dans les sorties du flow
 * (capture-n.png.txt : $.fs n'écrit que du texte), puis décodé à côté en capture-n.png au mieux (certutil, base64 -d) ; le .png est
 * retenu s'il existe, sinon le .txt. Jamais d'exception.
 */
async function keepCapture($: $, ran: unknown) {
  try {
    const g = gate
    const flow = await read($, flowA)
    // La preuve ouverte : mobile (outils mobile-mcp) ou web (navigateur) ; un projet a l'une ou l'autre.
    const w = g?.mobile?.etat === 'pret' ? g.mobile : g?.web?.etat === 'pret' ? g.web : undefined
    if (!g || !w || !flow || flow.id !== g.flowId) return
    const b64 = extractPng(ran)
    if (!b64) return
    // Le numéro est pris avant toute attente : deux captures en même temps n'écrivent pas le même fichier.
    w.prises = Math.max(w.prises ?? 0, w.captures.length) + 1
    const txt = capturePath((await verifIoOf($, g)).sorties, w.prises)
    await $.fs.write(txt, b64)
    let kept = txt
    const png = txt.replace(/\.txt$/, '')
    // Sans shell : certutil (-f : écrase un fichier resté d'un essai précédent) ; ailleurs base64 de macOS, sinon openssl (-A : base64
    // sur une seule ligne). Le premier qui écrit le .png l'emporte.
    const tries = (await isWindows($))
      ? [['certutil', '-f', '-decode', txt, png]]
      : [
          ['base64', '-d', '-i', txt, '-o', png],
          ['openssl', 'base64', '-d', '-A', '-in', txt, '-out', png],
        ]
    for (const argv of tries) {
      try {
        const r = await $.process.run(argv, { timeoutMs: 15_000 })
        if (r.exitCode === 0 && (await $.fs.exists(png).catch(() => false))) {
          kept = png
          break
        }
      } catch {
        // essai suivant ; à défaut le .txt suffit : le panneau et le rapport le lisent
      }
    }
    w.captures.push(kept)
    await setView($, g, w === g.mobile ? { mobile: mobileView(g) } : { web: webView(g) })
  } catch {
    // une capture perdue ne gêne jamais l'outil
  }
}

/** Bouton « capture » du panneau : ouvre la dernière capture (le .png, sinon son .txt), comme le rapport. */
async function openCapture($: $) {
  const v = await read($, verifA)
  const last = v?.mobile?.captures.at(-1) ?? v?.web?.captures.at(-1)
  if (last) await openFile($, last, 'la capture')
}

// ── Preuve mobile (v3.1, docs/rd-v2/execution.md §3) ─────────────────────

/** La sortie de l'app (flutter run, expo, react-native) gardée pour le journal et la dernière ligne quand elle meurt : 8 000 caractères. */
const MOBILE_SORTIE_MAX = 8000
/** Lignes du journal de l'app rendues au vérificateur. */
const JOURNAL_LIGNES = 40
/** La note d'une preuve mobile sans app détectée : la réponse au vérificateur le dit à part. */
const NO_MOBILE_APP = 'aucune app mobile détectée'
/** Le refus d'un vérificateur lancé en arrière-plan : sa preuve se suit en direct. */
const VERIFIER_FOREGROUND =
  'revo-flow : lance le vérificateur au premier plan, pas en arrière-plan : sa preuve à l’exécution (web ou mobile) se suit en direct dans le panneau et sur l’appareil.'

/** L'agent est-il demandé en arrière-plan (run_in_background de l'outil Agent, sous l'un de ses noms) ? */
function isBackgroundSpawn(e: unknown): boolean {
  const x = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {}
  return x.background === true || x.run_in_background === true || x.isBackground === true
}

/** La preuve mobile de la porte, créée à la première demande. */
function mobileOf(g: Gate): GateMobile {
  if (!g.mobile) g.mobile = { etat: 'non-demande', captures: [], sortie: '' }
  return g.mobile
}

/** Ce que le panneau et le rapport montrent de la preuve mobile (VerifView.mobile). */
function mobileView(g: Gate): MobileView {
  const m = mobileOf(g)
  return {
    etat: m.etat,
    ...(m.app ? { framework: frameworkLabel(m.app.framework) } : {}),
    ...(m.appareil ? { appareil: deviceLabel(m.appareil) } : {}),
    ...(m.commande ? { commande: m.commande } : {}),
    ...(m.emulateur ? { emulateurLance: true } : {}),
    captures: [...m.captures],
    ...(m.note ? { note: m.note } : {}),
  }
}

/** Change la preuve mobile (en place : l'app en fond garde la même référence) et la pousse dans la vue de la porte. */
async function setMobile($: $, g: Gate, patch: Partial<GateMobile>) {
  Object.assign(mobileOf(g), patch)
  await setView($, g, { mobile: mobileView(g) }).catch(() => undefined)
}

/**
 * L'app mobile du projet (detectMobileApp) : pubspec.yaml, package.json et app.json lus par ioOf, les dossiers android/ et ios/ sondés ;
 * un chemin présent dans deja (déjà lu, même absent) n'est pas relu.
 */
async function mobileAppOf($: $, ref: ProjectRef, graph?: Graph | null, deja: Record<string, string | undefined> = {}): Promise<MobileApp | undefined> {
  try {
    const io = ioOf($)
    const root = normalizePath(ref.racine)
    const texts = await Promise.all(
      MOBILE_MANIFESTES.map(p => (p in deja ? Promise.resolve(deja[p]) : io.fs.read(`${root}/${p}`).then(t => (typeof t === 'string' ? t : undefined), () => undefined))),
    )
    const sondes = Object.fromEntries(await Promise.all(MOBILE_SONDES.map(async d => [d, await io.fs.exists(`${root}/${d}`).catch(() => false)] as const)))
    const stack = graph?.projet.stack
    return detectMobileApp({ files: Object.keys(graph?.fichiers ?? {}), read: Object.fromEntries(MOBILE_MANIFESTES.map((p, i) => [p, texts[i]])), sondes, ...(stack ? { stack } : {}) })
  } catch {
    return undefined
  }
}

/** Les lectures de la preuve mobile (MobileDispo) : l'option, l'app détectée et, sur demande (doctor), les appareils du poste. */
async function mobileDispo($: $, ref: ProjectRef | undefined, graph: Graph | null | undefined, deja?: Record<string, string | undefined>, avecAppareils = false): Promise<MobileDispo> {
  const app = ref ? await mobileAppOf($, ref, graph, deja) : undefined
  if (opts.mobile === 'off') return { option: 'off', ...(app ? { app } : {}) }
  const appareils = app && avecAppareils && ref ? await devicesOf($, ref, app) : undefined
  return { option: opts.mobile, ...(app ? { app } : {}), ...(appareils ? { appareils } : {}) }
}

/**
 * Les appareils du poste pour cette app (listCommands : flutter devices et flutter emulators, ou adb, emulator et simctl), fondus sans
 * doublon ; une commande absente ou en échec ne compte pas. La sortie standard d'abord, l'erreur standard si elle est vide.
 */
async function devicesOf($: $, ref: ProjectRef, app: MobileApp): Promise<Appareil[]> {
  const win = await isWindows($)
  const lists = await Promise.all(
    listCommands(app, win ? 'windows' : 'darwin').map(async c => {
      try {
        const r = await $.process.run(withShell(c.argv, win ? 'windows' : 'posix'), { cwd: ref.racine, timeoutMs: 45_000 })
        return c.parse(r.stdout.trim() ? r.stdout : r.stderr)
      } catch {
        return [] as Appareil[]
      }
    }),
  )
  return mergeDevices(...lists)
}

/** La réponse de `verif mobile` au vérificateur, selon l'état de la preuve mobile. */
function mobileAnswer(m: GateMobile): string {
  const ou = m.appareil ? deviceLabel(m.appareil) : 'l’appareil'
  if (m.etat === 'pret') {
    return `revo-flow verif : app ${m.app ? frameworkLabel(m.app.framework) : ''} à l’écran sur ${ou} (${m.commande ?? 'lancée'}${m.emulateur ? ', émulateur démarré par revo-flow' : ''}). L’utilisateur la regarde en direct. Observe avec l’outil mcp__revo-flow__mobile : capture (puis Read), arbre, journal, toucher, glisser, texte, touche — une action à la fois ; cite dans chaque preuve l’écran vu, les exceptions, débordements et erreurs du journal, et « capture n ».`
  }
  if (m.etat === 'refuse') return 'revo-flow verif : l’utilisateur ne lance pas l’app : preuve mobile non vérifiable, dis-le dans tes preuves.'
  if (m.etat === 'erreur' && m.note === NO_MOBILE_APP) {
    return 'revo-flow verif : aucune app mobile détectée (ni pubspec.yaml Flutter, ni react-native ou expo dans package.json) : preuve mobile impossible, juge non vérifiable.'
  }
  if (m.etat === 'erreur') return `revo-flow verif : l’app n’a pas été lancée (${m.note ?? 'erreur inconnue'}) : preuve mobile non vérifiable.`
  return 'revo-flow verif : l’app est arrêtée : preuve mobile non vérifiable.'
}

/**
 * `verif mobile` : l'app de la preuve mobile. Un second appel attend la demande en cours et rend la même réponse ; prête, refusée ou en
 * erreur, la réponse reste ; arrêtée (fin de flow puis agent relancé, rechargement du mod), la demande repart, sauf pour un flow arrêté.
 */
async function mobileTool($: $, g: Gate, isStopped: boolean): Promise<string> {
  if (opts.mobile === 'off') return 'revo-flow verif : preuve mobile désactivée (option mobile) ; juge non vérifiable ce qui demande l’appareil.'
  const m = mobileOf(g)
  if (!m.enCours && (m.etat === 'non-demande' || (m.etat === 'arrete' && !isStopped))) {
    m.enCours = true
    m.attente = startMobile($, g, m)
      .catch(async err => {
        if (m.etat === 'question' || m.etat === 'demarrage' || m.etat === 'installation' || m.etat === 'non-demande') await setMobile($, g, { etat: 'erreur', note: errText(err) })
      })
      .finally(() => {
        m.enCours = false
      })
  }
  await m.attente
  return mobileAnswer(m)
}

/** Appareils proposés au plus dans la question (plus « Pas cette fois »). */
const APPAREILS_MAX = 3

/**
 * Détecte l'app, lit les appareils, choisit (téléphone branché d'abord, puis émulateur ou simulateur allumé, puis à démarrer), puis demande
 * à l'utilisateur : un seul candidat, « Lancer » ; plusieurs, le choix de l'appareil. Démarre l'émulateur s'il le faut (avec sa fenêtre),
 * lance l'app et attend qu'elle soit à l'écran. Rend quand l'issue est connue (pret, refuse ou erreur). Échap et -p : pas cette fois.
 */
async function startMobile($: $, g: Gate, m: GateMobile): Promise<void> {
  Object.assign(m, { appareil: undefined, note: undefined, sortie: '', stop: undefined, emulateur: undefined, stopEmulateur: undefined, vmService: undefined, commande: undefined })
  const graph = await graphOf($, g.ref).catch(() => null)
  const app = await mobileAppOf($, g.ref, graph)
  if (!app) return setMobile($, g, { etat: 'erreur', note: NO_MOBILE_APP })
  m.app = app
  await setMobile($, g, { etat: 'question' })
  const tous = await devicesOf($, g.ref, app)
  const candidats = rankDevices(tous, app)
  if (!candidats.length) {
    return setMobile($, g, {
      etat: 'erreur',
      note: `aucun appareil ${app.plateformes.join(' ou ')} : branchez un téléphone (adb ou Xcode) ou créez un émulateur / simulateur`,
    })
  }
  const no = { headless: 'Pas cette fois', dismissed: 'Pas cette fois' }
  const nom = frameworkLabel(app.framework)
  let choisi: Appareil | undefined
  if (candidats.length === 1) {
    const d = candidats[0]!
    const { answer } = await askGate(
      $,
      g,
      d.etat === 'connecte'
        ? `Lancer l’app ${nom} de ${g.ref.nom} sur ${deviceLabel(d)} ? Le vérificateur l’observera en direct sur l’appareil pour la preuve mobile.`
        : `Démarrer ${deviceLabel(d)} (sa fenêtre s’ouvrira) puis y lancer l’app ${nom} de ${g.ref.nom} ? Le vérificateur l’observera en direct pour la preuve mobile.`,
      ['Lancer', 'Pas cette fois'],
      no,
      'Preuve mobile : lancer l’app sur l’appareil ?',
    )
    if (m.etat !== 'question') return
    if (answer === 'Lancer') choisi = d
  } else {
    const options = candidats.slice(0, APPAREILS_MAX)
    const { answer } = await askGate(
      $,
      g,
      `Lancer l’app ${nom} de ${g.ref.nom} pour la preuve mobile : sur quel appareil ? Le vérificateur l’observera en direct (un émulateur éteint est démarré avec sa fenêtre).`,
      [...options.map(deviceLabel), 'Pas cette fois'],
      no,
      'Preuve mobile : sur quel appareil ?',
    )
    if (m.etat !== 'question') return
    choisi = options.find(d => deviceLabel(d) === answer)
  }
  if (!choisi) return setMobile($, g, { etat: 'refuse' })
  m.appareil = choisi
  if (choisi.etat !== 'connecte') {
    await setMobile($, g, { etat: 'demarrage' })
    $.ui.toast(`revo-flow : démarrage de ${choisi.nom}, sa fenêtre s’ouvre`)
    const allume = await bootEmulator($, g, m, app, choisi, tous)
    if (m.etat !== 'demarrage') return
    if (!allume) {
      await m.stopEmulateur?.().catch(() => undefined)
      return setMobile($, g, { etat: 'erreur', note: `${choisi.nom} ne s’est pas allumé en ${Math.round(EMULATEUR_ATTENTE_MS / 1000)} s` })
    }
    // L'émulateur à éteindre en fin de flow est celui qui s'est connecté (emulator-5554), pas le nom de l'AVD.
    m.appareil = allume
    m.emulateur = allume
  }
  await setMobile($, g, { etat: 'installation', commande: commandeMobile(runCommand(app, m.appareil)) })
  await spawnApp($, g, m, app, m.appareil)
}

/**
 * Démarre un émulateur ou un simulateur éteint (launchCommands : fenêtre visible) et attend qu'il soit connecté : simctl le dit Booted, ou un
 * emulator-NNNN nouveau apparaît dans adb avec sys.boot_completed. Rend l'appareil allumé, ou undefined après EMULATEUR_ATTENTE_MS (ou si
 * la preuve a changé d'état). Le processus `emulator -avd` est gardé (stopEmulateur le ferme) ; revo-flow l'éteindra en fin de flow.
 */
async function bootEmulator($: $, g: Gate, m: GateMobile, app: MobileApp, lance: Appareil, avant: Appareil[]): Promise<Appareil | undefined> {
  const win = await isWindows($)
  const os = win ? 'windows' : 'posix'
  m.emulateur = lance
  for (const c of launchCommands(app, lance)) {
    try {
      if (c.garder) {
        const proc = await $.process.spawn({ argv: withShell(c.argv, os), cwd: g.ref.racine })
        const it = iteratorOf(proc)
        m.stopEmulateur = async () => {
          for (const [target, name] of [[it, 'return'], [proc, 'return'], [proc, 'kill']] as const) {
            try {
              const fn = (target as Record<string, unknown> | null | undefined)?.[name]
              if (typeof fn === 'function') void Promise.resolve(fn.call(target)).catch(() => undefined)
            } catch {
              // déjà fermé
            }
          }
        }
        // La sortie de l'émulateur est lue et jetée : quitter la boucle le tuerait.
        if (it)
          void (async () => {
            try {
              for (;;) if ((await it.next()).done) break
            } catch {
              // l'émulateur est parti
            }
          })()
      } else await $.process.run(withShell(c.argv, os), { cwd: g.ref.racine, timeoutMs: 60_000 })
    } catch (err) {
      await setMobile($, g, { note: `démarrage impossible : ${errText(err)}` })
      return undefined
    }
  }
  const debut = await $.clock.now()
  for (;;) {
    if (m.etat !== 'demarrage') return undefined
    const apres = await devicesOf($, g.ref, app)
    const d = bootedDevice(lance, avant, apres)
    if (d && (d.plateforme !== 'android' || (await androidBooted($, d, os)))) return d
    if ((await $.clock.now()) - debut >= EMULATEUR_ATTENTE_MS) return undefined
    await new Promise<void>(resolve => void $.clock.after(EMULATEUR_SONDE_MS, () => resolve()))
  }
}

/** Android a fini de démarrer : `adb shell getprop sys.boot_completed` rend 1. */
async function androidBooted($: $, d: Appareil, os: 'windows' | 'posix'): Promise<boolean> {
  try {
    const r = await $.process.run(withShell(['adb', '-s', d.id, 'shell', 'getprop', 'sys.boot_completed'], os), { timeoutMs: 15_000 })
    return r.stdout.trim() === '1'
  } catch {
    return false
  }
}

/**
 * Lance l'app sur l'appareil ($.process.spawn, cmd /c sous Windows) et lit sa sortie en fond, comme spawnServer : app à l'écran
 * (appReadyFromOutput) → pret ; échec de build ou de pose, processus mort ou 5 min sans signe → erreur (le processus est arrêté). Rend
 * quand l'issue est connue ; la lecture continue ensuite (le journal du vérificateur la lit). Jamais d'exception.
 */
async function spawnApp($: $, g: Gate, m: GateMobile, app: MobileApp, d: Appareil): Promise<void> {
  const os = (await isWindows($)) ? 'windows' : 'posix'
  const argv = runCommand(app, d)
  let proc: unknown
  try {
    proc = await $.process.spawn({ argv: withShell(argv, os), cwd: g.ref.racine })
  } catch (err) {
    return setMobile($, g, { etat: 'erreur', note: `lancement impossible : ${errText(err)}` })
  }
  const it = iteratorOf(proc)
  if (!it) return setMobile($, g, { etat: 'erreur', note: 'lancement impossible : sortie de l’app illisible' })
  let isStopped = false
  const stop = async () => {
    if (isStopped) return
    isStopped = true
    const call = (target: unknown, name: 'return' | 'kill') => {
      try {
        const fn = (target as Record<string, unknown> | null)?.[name]
        if (typeof fn === 'function') void Promise.resolve(fn.call(target)).catch(() => undefined)
      } catch {
        // déjà fermé
      }
    }
    call(it, 'return')
    if (proc !== it) call(proc, 'return')
    call(proc, 'kill')
  }
  m.stop = stop
  if (m.etat !== 'installation') {
    await stop()
    return
  }
  await new Promise<void>(resolve => {
    let isSettled = false
    let timer: { cancel?: () => void } | undefined
    const settle = async (patch: Partial<GateMobile>, kill = false) => {
      if (isSettled) return
      isSettled = true
      timer?.cancel?.()
      if (kill) await stop()
      await setMobile($, g, patch)
      if (patch.etat === 'pret') $.ui.toast(`revo-flow : app à l’écran sur ${d.nom}, le vérificateur la regarde`)
      resolve()
    }
    timer = $.clock.after(MOBILE_ATTENTE_MS, () => void settle({ etat: 'erreur', note: `l’app n’est pas à l’écran après ${Math.round(MOBILE_ATTENTE_MS / 1000)} s` }, true)) as unknown as
      | { cancel?: () => void }
      | undefined
    void (async () => {
      try {
        for (;;) {
          const r = await it.next()
          if (r.done) break
          m.sortie = (m.sortie + chunkText(r.value)).slice(-MOBILE_SORTIE_MAX)
          if (isSettled) continue
          const ready = appReadyFromOutput(m.sortie)
          if (ready) await settle({ etat: 'pret', ...(ready.vmService ? { vmService: ready.vmService } : {}) })
          else {
            const failed = appFailedFromOutput(m.sortie)
            if (failed) await settle({ etat: 'erreur', note: failed }, true)
          }
        }
      } catch {
        // la sortie est perdue : le processus aussi
      }
      if (isStopped) return
      isStopped = true
      const note = `l’app s’est arrêtée : ${lastLine(m.sortie)}`
      if (!isSettled) await settle({ etat: 'erreur', note })
      // Morte après avoir été à l'écran : la preuve mobile n'a plus d'app, les actions sont refusées.
      else if (m.etat === 'pret') await setMobile($, g, { etat: 'erreur', note })
    })().catch(() => undefined)
  })
}

/**
 * Arrête l'app lancée par revo-flow et éteint l'émulateur ou le simulateur qu'il a démarré (jamais un appareil déjà allumé ni un téléphone) :
 * fin de flow, Tout arrêter, flow abandonné, porte remplacée. Prête, en question, en démarrage ou en installation : arrete ; refuse, erreur
 * et non-demande restent. Jamais d'exception.
 */
async function stopMobile($: $, g: Gate | undefined) {
  const m = g?.mobile
  if (!g || !m) return
  try {
    await m.stop?.()
  } catch {
    // arrêt au mieux : l'app meurt aussi avec le module
  }
  m.stop = undefined
  if (m.emulateur) {
    try {
      const os = (await isWindows($)) ? 'windows' : 'posix'
      await $.process.run(withShell(shutdownCommand(m.emulateur), os), { timeoutMs: 20_000 }).catch(() => undefined)
      await m.stopEmulateur?.()
    } catch {
      // l'émulateur reste allumé : l'utilisateur le fermera
    }
    m.stopEmulateur = undefined
  }
  if (m.etat === 'refuse' || m.etat === 'erreur' || m.etat === 'non-demande') return
  m.etat = 'arrete'
  await setView($, g, { mobile: mobileView(g) }).catch(() => undefined)
}

/** Arrête les preuves à l'exécution d'une porte : le serveur de dev (web) et l'app sur l'appareil (mobile). */
async function stopProofs($: $, g: Gate | undefined) {
  await stopWeb($, g)
  await stopMobile($, g)
}

/**
 * Le base64 d'un fichier, par une commande du poste (le système de fichiers du mod ne lit que du texte) : openssl base64 -A, base64 -i
 * (macOS) ou base64 -w 0 (Linux) ; certutil -encode sous Windows (en-tête et pied retirés). undefined si rien n'y arrive.
 */
async function base64Of($: $, path: string, os: 'windows' | 'posix'): Promise<string | undefined> {
  const propre = (t: string) => t.replace(/-----(?:BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
  if (os === 'windows') {
    const txt = `${path}.b64`
    try {
      const r = await $.process.run(['certutil', '-encode', '-f', path, txt], { timeoutMs: 20_000 })
      if (r.exitCode !== 0) return undefined
      const t = await $.fs.read(txt)
      return typeof t === 'string' && t ? propre(t) : undefined
    } catch {
      return undefined
    }
  }
  for (const argv of [
    ['openssl', 'base64', '-A', '-in', path],
    ['base64', '-i', path],
    ['base64', '-w', '0', path],
  ]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 20_000 })
      const t = propre(r.stdout)
      if (r.exitCode === 0 && t) return t
    } catch {
      // essai suivant
    }
  }
  return undefined
}

/**
 * L'outil mobile : capture, arbre, journal, toucher, glisser, texte, touche, sur l'app prête de la preuve mobile, pour le vérificateur
 * seul. Chaque action passe par une commande du poste (flutter screenshot, adb, simctl) ; l'erreur est dite en texte.
 */
async function mobileActionTool($: $, e: Record<string, unknown> & { agentId?: string }): Promise<string> {
  const action = text(e.action).toLowerCase()
  const g = gate
  const flow = await read($, flowA)
  if (!g || !flow || flow.id !== g.flowId || flow.phase === 'done') return 'revo-flow mobile : aucun flow vérifié en cours.'
  if (!e.agentId || !verifierAgents.has(e.agentId)) return 'revo-flow mobile : outil réservé au vérificateur.'
  const m = g.mobile
  if (!m || m.etat !== 'pret' || !m.app || !m.appareil) {
    return 'revo-flow mobile : la preuve mobile n’est pas ouverte ; appelle d’abord mcp__revo-flow__verif action "mobile", puis réessaie.'
  }
  const os = (await isWindows($)) ? 'windows' : 'posix'
  const run = async (argv: string[], timeoutMs = 60_000) => {
    const r = await $.process.run(withShell(argv, os), { cwd: g.ref.racine, timeoutMs })
    return { ok: r.exitCode === 0, out: r.stdout, err: lastLine(r.stderr || r.stdout) }
  }
  const d = m.appareil
  switch (action) {
    case 'capture': {
      m.prises = Math.max(m.prises ?? 0, m.captures.length) + 1
      const n = m.prises
      const png = `${(await verifIoOf($, g)).sorties}/capture-${n}.png`
      const steps = captureCommands(m.app, d, png)
      if (!steps) return `revo-flow mobile : pas de capture possible sur ${deviceLabel(d)} (iPhone branché sans Flutter) ; juge avec le journal, sinon non vérifiable.`
      // Le dossier des sorties existe grâce au .txt (le système de fichiers du mod crée les dossiers) ; il reçoit ensuite le base64 du panneau.
      await $.fs.write(`${png}.txt`, '')
      for (const argv of steps) {
        const r = await run(argv, 90_000)
        if (!r.ok) return `revo-flow mobile : capture ${n} impossible (${argv[0]} : ${r.err || 'échec'}) ; réessaie, ou juge avec l’arbre et le journal.`
      }
      if (!(await $.fs.exists(png).catch(() => false))) return `revo-flow mobile : capture ${n} non écrite (${png} absent) ; réessaie.`
      const b64 = await base64Of($, png, os)
      if (b64) await $.fs.write(`${png}.txt`, b64)
      m.captures.push(png)
      await setMobile($, g, {})
      return `revo-flow mobile : capture ${n} écrite : ${png} — lis-la avec l’outil Read pour la voir, et cite « capture ${n} » dans ta preuve.`
    }
    case 'arbre': {
      const steps = treeCommands(d)
      if (!steps) return `revo-flow mobile : pas d’arbre des vues sur ${deviceLabel(d)} (iOS) ; observe avec capture et journal.`
      let dernier = ''
      for (const argv of steps) {
        const r = await run(argv)
        if (!r.ok) return `revo-flow mobile : arbre illisible (${r.err || 'échec'}) ; réessaie après une capture.`
        dernier = r.out
      }
      const arbre = condenseUiTree(dernier)
      return arbre ? `revo-flow mobile : vues à l’écran de ${d.nom} (classe « texte » [description] #id · centre x,y) :\n${arbre}` : 'revo-flow mobile : aucune vue avec un texte ou un id à l’écran (écran vide, ou en cours de dessin) ; prends une capture.'
    }
    case 'journal': {
      const n = countIssues(m.sortie)
      const lignes = [`revo-flow mobile : journal de l’app (${m.commande ?? 'lancement'}) — exceptions : ${n.exceptions}, débordements : ${n.debordements}, erreurs : ${n.erreurs}`, tailLines(m.sortie, JOURNAL_LIGNES) || '(rien encore)']
      const logcat = logCommand(d)
      if (logcat) {
        const r = await run(logcat, 30_000).catch(() => undefined)
        if (r?.ok && r.out.trim()) lignes.push('--- logcat, dernières erreurs de l’appareil ---', tailLines(r.out, 30))
      }
      return lignes.join('\n')
    }
    case 'toucher':
    case 'glisser':
    case 'texte':
    case 'touche': {
      const argv = gestureCommand(d, action, e)
      if (!argv) {
        return d.plateforme !== 'android'
          ? `revo-flow mobile : pas de geste sur ${deviceLabel(d)} (iOS) : observe avec capture et journal, ou dis le critère non vérifiable.`
          : `revo-flow mobile : ${action} demande ${action === 'toucher' ? 'x et y' : action === 'glisser' ? 'x1, y1, x2 et y2' : action === 'texte' ? '« texte »' : '« touche » (retour, accueil, entree)'}.`
      }
      const r = await run(argv, 30_000)
      if (!r.ok) return `revo-flow mobile : ${action} refusé par l’appareil (${r.err || 'échec'}).`
      return `revo-flow mobile : ${describeCall(MOBILE_TOOL, e).replace(/^Mobile /, '')} fait sur ${d.nom} ; prends une capture pour voir le résultat.`
    }
    default:
      return `revo-flow mobile : action « ${action} » inconnue (capture, arbre, journal, toucher, glisser, texte, touche).`
  }
}

// ── Commande cache ───────────────────────────────────────────────────────

/** Confirmation par dialogue ; sans personne à qui demander, `fallback` ; dialogue fermé : non. */
const confirm = ($: $, question: string, yes: string, no: string, fallback: boolean) =>
  askOr($, question, [yes, no], { headless: fallback ? yes : no, dismissed: no }).then(a => a === yes)

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
  // L'outil n'est déclaré qu'à la demande (premier flow ou build) : l'agent de construction en a besoin.
  await registerCacheTool($).catch(() => undefined)
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
  const verif = await read($, verifA)
  const capture = await lastCapture($, verif)
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
    verif,
    ...(capture ? { capture } : {}),
  }
}

/** Les boutons du panneau. */
function paneActions($: $): PaneActions {
  return {
    clear: () => update($, entries, () => []),
    stopAll: () => confirmStop($),
    stopAgent: key => confirmStop($, key),
    retryAgent: key => retryAgent($, key),
    approvePlan: () => approvePlan($),
    cancelPlan: () => cancelPlan($),
    openPlan: () => openPlan($),
    openRapport: () => openRapport($),
    toggleCache: () => update($, cacheOpenA, v => !v),
    openVerif: () => openVerif($),
    rerunVerif: () => rerunVerif($),
    openCapture: () => openCapture($),
  }
}

/** La fenêtre de contexte telle que la barre d'état la lit ; rien tant qu'aucune réponse ne l'a mesurée. */
function contextOf(c: SessionContextUsage): Context | null {
  if (c.tokens === undefined) return null
  return { percent: c.percent ?? Math.round((c.tokens / c.window) * 100), tokens: c.tokens, window: c.window }
}

const ENDED = new Set(['completed', 'failed', 'killed'])
/**
 * Tenu par Claude Code sans tourner : waiting (un travail de fond à lui, qui peut le réveiller) ou idle. Après la fin
 * de son tour, son rapport est rendu : il a fini pour le flow (rouvert par turn.start s'il se réveille).
 */
const HELD = new Set(['waiting', 'idle'])

/** Comment finit le tour d'un agent : fini, en échec, ou en attente d'un autre agent. */
type Outcome = 'done' | 'failed' | 'blocked'

/**
 * Un agent a fini : ses tâches sont closes, son heure de fin notée. blocked : il attend un autre agent ; sa tâche
 * en cours repart en attente et il quitte son lancement (agentId, claimed) pour pouvoir être relancé.
 * Seul un agent encore « running » est clos (deux vérifications simultanées ne le closent qu'une fois) : renvoie
 * vrai s'il l'a été. isQuiet : sans les suites (relance de qui l'attendait, messages à l'orchestrateur).
 */
async function endAgent($: $, key: string, outcome: Outcome, isQuiet = false): Promise<boolean> {
  const now = await $.clock.now()
  let isEnded = false as boolean
  await setAgent($, key, x => {
    if (x.status !== 'running') return x
    isEnded = true
    if (outcome === 'blocked') {
      const { agentId: _id, ...rest } = x
      return { ...rest, ...(x.agentId ? { lastAgentId: x.agentId } : {}), status: 'blocked', isDoing: false, endedAt: now, tasks: pauseTasks(x.tasks) }
    }
    const { waitingFor: _w, ...rest } = x
    return { ...rest, status: outcome, isDoing: false, endedAt: now, tasks: finishTasks(x.tasks, outcome === 'failed') }
  })
  if (!isEnded) return false
  if (outcome === 'blocked') claimed.delete(key)
  if (!isQuiet) await afterEnd($, key, outcome)
  return true
}

/**
 * Les suites de la fin d'un agent. Fini : ceux qui l'attendaient sont relancés. En échec : ceux qui l'attendaient
 * sont signalés à l'orchestrateur. En attente : relancé tout de suite si l'agent attendu a déjà fini, signalé à
 * l'orchestrateur s'il a échoué, n'est pas du plan ou l'attend lui-même ; sinon il patiente.
 */
async function afterEnd($: $, key: string, outcome: Outcome) {
  const flow = await read($, flowA)
  const a = flow?.agents.find(x => x.key === key)
  if (!flow || !a) return
  const dependents = flow.agents.filter(x => x.status === 'blocked' && x.waitingFor?.key === key)
  if (a.agentId ?? a.lastAgentId) testerAgents.delete((a.agentId ?? a.lastAgentId)!)
  // Le testeur a fini : ses tests sont gelés avant que quiconque reprenne (§8).
  if (outcome === 'done' && isTester(a)) await freezeTester($, a).catch(() => undefined)
  if (outcome === 'done') {
    for (const x of dependents) await relaunch($, x.key, `« ${a.name} » a fini, « ${x.name} » l’attendait :`)
    return
  }
  if (outcome === 'failed') {
    for (const x of dependents) blockedNote($, x, 'en échec')
    return
  }
  const target = a.waitingFor?.key ? flow.agents.find(x => x.key === a.waitingFor?.key) : undefined
  $.ui.toast(`revo-flow : « ${a.name} » attend « ${target?.name ?? a.waitingFor?.name ?? 'un autre agent'} »`)
  if (!target) return blockedNote($, a, 'hors plan')
  if (target.status === 'done') return relaunch($, key, `« ${target.name} » a déjà fini, « ${a.name} » l’attendait :`)
  if (target.status === 'failed') return blockedNote($, a, 'en échec')
  if (target.status === 'blocked' && waitsFor(flow, target.key, key)) return blockedNote($, a, 'attente croisée')
}

/** `from` attend-il `key`, directement ou par une chaîne d'agents en attente (A attend B qui attend C qui attend A) ? */
function waitsFor(flow: Flow, from: string, key: string): boolean {
  const seen = new Set<string>()
  let cur = flow.agents.find(x => x.key === from)
  while (cur && cur.status === 'blocked' && cur.waitingFor?.key && !seen.has(cur.key)) {
    if (cur.waitingFor.key === key) return true
    seen.add(cur.key)
    cur = flow.agents.find(x => x.key === cur!.waitingFor?.key)
  }
  return false
}

/** Personne ne viendra relancer cet agent en attente : l'orchestrateur est prévenu et décide. */
function blockedNote($: $, a: FlowAgent, why: 'en échec' | 'hors plan' | 'attente croisée') {
  const name = a.waitingFor?.name ?? 'un autre agent'
  const left = remainingTasks(a)
    .map(t => t.title)
    .join(' ; ')
  const todo =
    why === 'en échec'
      ? `Relance « ${name} » puis « ${a.name} », ou « ${a.name} » avec d’autres consignes`
      : why === 'hors plan'
        ? `« ${name} » n’est pas un agent du plan : relance « ${a.name} » avec ce qui lui manque`
        : `Ils s’attendent en boucle : relance l’un d’eux avec d’autres consignes`
  void $.prompt
    .submit({
      text: `revo-flow : l’agent « ${a.name} » attend « ${name} » (${why}) ; reste : ${left}. ${todo}, avec l’outil Agent (description = son nom exact)${a.lastAgentId ? `, ou avec SendMessage (to: "${a.lastAgentId}") pour « ${a.name} », qui garde alors son contexte` : ''}.`,
      asUser: true,
    })
    .catch(() => undefined)
}

/**
 * Tous les agents ont fini pendant l'exécution : l'orchestrateur passe à la vérification, et la porte globale part aussitôt en
 * fond, pendant qu'il lit les réponses (§2 étape 8) ; souvent prête quand il conclut.
 */
async function toReview($: $) {
  let isReview = false as boolean
  await setFlow($, f => {
    if (f.phase !== 'running' || !allFinished(f)) return f
    isReview = true
    return { ...f, phase: 'review' }
  })
  if (isReview && gate && gate.mode !== 'off') void ensureGate($).catch(() => undefined)
}

/**
 * L'état réel des sous-agents, lu auprès de Claude Code : la fin d'un tour ne veut pas dire que l'agent a fini
 * (un agent en arrière-plan termine des tours et continue). completed, failed ou killed le terminent, et aussi
 * waiting ou idle une fois son tour fini (sinon un agent qui attend son propre travail de fond reste « actif »).
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
    const isEnded = info ? ENDED.has(info.status) || (HELD.has(info.status) && a.hasEndedTurn === true) : a.hasEndedTurn === true
    if (!isEnded) continue
    // L'état à jour (une attente a pu être signalée pendant la lecture de la liste).
    const cur = (await read($, flowA))?.agents.find(x => x.key === a.key) ?? a
    const isFailed = (info !== undefined && (info.status === 'failed' || info.status === 'killed')) || cur.tasks.some(t => t.status === 'failed')
    // Un agent qui a signalé une attente et n'a pas fini ses tâches attend : ni fini, ni en échec.
    const outcome: Outcome = isFailed ? 'failed' : cur.waitingFor && remainingTasks(cur).length > 0 ? 'blocked' : 'done'
    if (!(await endAgent($, a.key, outcome))) continue
    if (outcome === 'failed') await notify($, `agent « ${a.name} » en échec`)
  }
  await toReview($)
}

// ── Arrêt, relance et validation du plan ─────────────────────────────────

/** Arrête un sous-agent en cours avec TaskStop, comme le modèle le ferait, et le marque en échec. isQuiet : voir endAgent. */
async function stopAgent($: $, key: string, isQuiet = false) {
  const a = (await read($, flowA))?.agents.find(x => x.key === key)
  if (!a || a.status !== 'running') return
  if (a.agentId) {
    try {
      await $.tool.call({ tool: 'TaskStop', task_id: a.agentId })
    } catch {
      // déjà fini, ou plus connu de Claude Code : on le marque quand même
    }
  }
  await endAgent($, key, 'failed', isQuiet)
  await toReview($)
}

/**
 * Arrête tous les agents en cours, sans suites (personne n'est relancé pour un agent arrêté), puis interrompt le tour
 * de l'orchestrateur s'il tourne. Le flow est marqué arrêté : sa fin ne vaut ni conclusion ni fiche apprise.
 */
async function stopAll($: $) {
  await setFlow($, f => ({ ...f, isStopped: true }))
  for (const a of (await read($, flowA))?.agents ?? []) if (a.status === 'running') await stopAgent($, a.key, true)
  await stopProofs($, gate)
  const turnId = leadTurnId
  leadTurnId = undefined
  if (turnId) {
    stoppedTurns.add(turnId)
    await $.turn.abort({ turnId }).catch(() => undefined)
  }
}

/** Boutons « Arrêter » et « Tout arrêter » du panneau : rien ne s'arrête sans confirmation (Échap : rien). */
async function confirmStop($: $, key?: string) {
  const flow = await read($, flowA)
  const running = flow?.agents.filter(a => a.status === 'running' && (key === undefined || a.key === key)) ?? []
  if (key !== undefined && running.length === 0) return
  const spent = flow ? (await read($, leadA)).costUsd + flow.agents.reduce((n, a) => n + a.costUsd, 0) : 0
  const what = key !== undefined ? `l’agent « ${running[0]!.name} »` : running.length ? `${running.length} agent${running.length > 1 ? 's' : ''} et l’orchestrateur` : 'l’orchestrateur'
  const answer = await askOr($, `Arrêter ${what} ? (${euros(spent)} déjà dépensés)`, ['Arrêter', 'Continuer'], { headless: 'Arrêter', dismissed: 'Continuer' })
  if (answer !== 'Arrêter') return
  if (key !== undefined) await stopAgent($, key)
  else await stopAll($)
}

/** Bouton « Relancer » (agent en échec ou en attente) : un agent encore actif est d'abord arrêté, sans suites. */
async function retryAgent($: $, key: string) {
  const a = (await read($, flowA))?.agents.find(x => x.key === key)
  if (!a) return
  if (a.status === 'running') await stopAgent($, key, true)
  await relaunch($, key)
}

/**
 * Réarme un agent et demande sa relance : il redevient « en attente de lancement » (nouvelle tentative), ses tâches
 * non faites repartent de zéro, son attente est levée, et l'orchestrateur reçoit la consigne de le relancer avec
 * l'outil Agent. `why` précède la consigne : pourquoi on le relance. isQuiet : la consigne est rendue au lieu d'être envoyée
 * (la reprise après redémarrage les envoie toutes en un message).
 */
async function relaunch($: $, key: string, why = '', isQuiet = false): Promise<string | undefined> {
  const a = (await read($, flowA))?.agents.find(x => x.key === key)
  if (!a) return undefined
  claimed.delete(key)
  const tasks = a.tasks.map(t => (t.status === 'completed' ? t : { ...t, status: 'pending' as const }))
  const resumeId = a.agentId ?? a.lastAgentId
  await setAgent($, key, ({ agentId: _id, startedAt: _start, endedAt: _end, waitingFor: _w, ...x }) => ({
    ...x,
    ...(resumeId ? { lastAgentId: resumeId } : {}),
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
  // Avec l'id de son dernier lancement, SendMessage le reprend avec tout son contexte : rien à relire.
  const how = resumeId
    ? `reprends l’agent « ${a.name} » avec SendMessage (to: "${resumeId}") pour qu’il garde son contexte, ou relance-le avec l’outil Agent (description = son nom exact),`
    : `relance l’agent « ${a.name} » avec l’outil Agent (description = son nom exact)`
  const line = `${why ? `${why} ` : ''}${how} pour ses tâches restantes : ${left}`
  if (isQuiet) return line
  void $.prompt
    .submit({
      text: `revo-flow : ${line}`,
      asUser: true,
    })
    .catch(() => undefined)
  return undefined
}

// ── Reprise après redémarrage ────────────────────────────────────────────

/**
 * Au chargement, sans flow en mémoire : le plus récent des instantanés non terminés de ce projet est proposé (Reprendre ou
 * Abandonner). Sans personne à qui demander (-p, SDK) : Abandonner. Dialogue fermé, ou session pas encore prête : rien,
 * l'instantané attend le prochain démarrage. Un instantané illisible ou fini est effacé.
 */
async function offerResume($: $, isInteractive: boolean) {
  if (await read($, flowA)) return
  const { project } = await projectHeader($)
  let snap: FlowSnapshot | undefined
  for (const key of await $.store.keys()) {
    if (!key.startsWith(SNAPSHOT_PREFIX)) continue
    const s = readSnapshot(await $.store.get(key))
    if (!s) {
      await $.store.delete(key)
      continue
    }
    // Un flow d'un autre projet attend qu'on rouvre Claude Code là-bas.
    if (s.flow.project !== project) continue
    if (!snap || s.savedAt > snap.savedAt) snap = s
  }
  if (!snap) return
  let answer = 'Abandonner'
  if (isInteractive) {
    const r = await askHow($, resumeQuestion(snap.flow), ['Reprendre', 'Abandonner'], { headless: '', dismissed: '' })
    answer = r.answer
  }
  // Un flow est parti pendant la question : il a la main, l'instantané reste pour le prochain démarrage.
  if (await read($, flowA)) return
  if (answer === 'Reprendre') await resumeFlow($, snap)
  else if (answer === 'Abandonner') await abandonFlow($, snap)
}

/**
 * Reprendre : le flow, l'orchestrateur, les fichiers, la vérification et le cache reviennent dans l'état partagé ; tout agent non
 * terminé est à relancer (resumedFlow, jamais actif). L'orchestrateur reçoit en un message son rôle, l'état du flow et la consigne
 * de relancer chaque agent sur ses tâches restantes (relaunch, comme après une attente) ; le panneau se rouvre.
 */
async function resumeFlow($: $, snap: FlowSnapshot) {
  const flow = resumedFlow(snap.flow)
  claimed.clear()
  Object.assign(learned, { flowId: flow.id, features: [] })
  await update($, flowA, () => flow)
  await update($, leadA, () => ({ ...snap.lead, isDoing: false }))
  await update($, entries, () => snap.entries)
  await update($, flowCacheA, () => snap.flowCache ?? null)
  await update($, verifA, () => snap.verif ?? null)
  await update($, verifFlowA, () => snap.verifFlow ?? null)
  await saveFlow($).catch(() => undefined)
  await registerTools($)
  if (opts.cache) await registerCacheTool($).catch(() => undefined)
  await restoreVerif($).catch(() => undefined)
  agentsInstalles = await loadAgents($).catch(() => [])
  watchAgents($)
  try {
    if (!flow.isPaneClosed && !(await isPaneShown($))) await openPane($)
  } catch {
    // le panneau ne doit jamais bloquer la reprise
  }
  const todo: string[] = []
  if (isBeforeLaunch(snap.flow)) {
    todo.push(`Le plan n’était pas encore lancé : relis la demande et propose le plan avec l’outil ${PLAN_TOOL}.`, `Demande : ${flow.request}`)
  } else {
    for (const a of flow.agents.filter(isUnfinished)) {
      const line = await relaunch($, a.key, '', true)
      if (line) todo.push(`- ${line}`)
    }
    if (todo.length) todo.unshift(`N’appelle plus l’outil ${PLAN_TOOL} : le plan est posé. Les agents sont morts avec la session ; leurs tâches faites restent cochées.`)
    else todo.push('Tous les agents avaient fini : vérifie l’ensemble et conclus.')
  }
  const recap = flowRecap((await read($, flowA)) ?? flow, opts.cache ? cacheRecap(await read($, flowCacheA)) : false, opts.verif !== 'off').replace(
    '(rappel après compaction)',
    '(reprise après redémarrage)',
  )
  const text = [`revo-flow : reprise du flow « ${flow.title} » après un redémarrage de Claude Code.`, ...todo, '', recap].join('\n')
  void $.prompt.submit({ text, asUser: true }).catch(() => undefined)
}

/** Abandonner : le flow entre au journal comme arrêté, à l'heure de son dernier instantané, et l'instantané est effacé. */
async function abandonFlow($: $, snap: FlowSnapshot) {
  const flow: Flow = { ...snap.flow, isStopped: true, endedAt: Math.max(snap.savedAt, snap.flow.startedAt) }
  // Le serveur de la preuve web est mort avec la session ; au cas où la porte de ce flow serait encore en mémoire, rien ne reste.
  if (gate?.flowId === flow.id) await stopProofs($, gate)
  await journalize($, flow, snap.lead, snap.entries.length).catch(() => undefined)
  await $.store.delete(snapshotKey(flow.id))
  $.ui.toast(`revo-flow : flow « ${flow.title} » abandonné, inscrit au journal comme arrêté`)
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
 * Sans personne à qui demander (-p), le plan part : la validation ne doit jamais bloquer le flow. Dialogue fermé
 * (Échap) : annulé, aucun agent ne part sans accord. Un texte libre (« Other ») vaut refus, transmis au modèle.
 */
function decide($: $, plan: PlanInput): Promise<Decision> {
  return new Promise(resolve => {
    let isSettled = false
    const settle = (d: Decision) => {
      if (isSettled) return
      isSettled = true
      if (pendingDecision === settle) pendingDecision = undefined
      if (pendingPreview?.question === question) pendingPreview = undefined
      resolve(d)
    }
    const question = planQuestion(plan)
    pendingDecision = settle
    pendingPreview = { question, markdown: planMarkdown(plan) }
    void askOr($, question, ['Lancer', 'Annuler'], { headless: 'Lancer', dismissed: 'Annuler' }).then(answer =>
      settle(answer === 'Lancer' ? { isLaunched: true } : answer === 'Annuler' ? { isLaunched: false } : { isLaunched: false, note: answer }),
    )
  })
}

/** Le plan en markdown, à côté des graphes : ~/.claude/revo-flow/plans/<titre>.md, réécrit à chaque nouveau plan. */
async function writePlanFile($: $, plan: PlanInput, flow: Flow): Promise<string | undefined> {
  const home = await ioOf($).home()
  if (!home) return undefined
  const d = new Date(await $.clock.now())
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${dayKey(d)} ${p(d.getHours())}:${p(d.getMinutes())}`
  const path = `${normalizePath(home)}/.claude/revo-flow/plans/${slug(plan.title) || 'plan'}.md`
  await $.fs.write(path, planMarkdown(plan, { request: flow.request, project: flow.project, branch: flow.branch, date }))
  return path
}

/**
 * Le rapport de flow (rapportMarkdown) à côté des plans : ~/.claude/revo-flow/rapports/<titre>.md, écrit une fois la vérification connue.
 * Un flow arrêté n'a pas de rapport ; le chemin est gardé dans le flow (rapportFile) pour le bouton « rapport.md ».
 */
async function writeRapport($: $, flow: Flow, lead: Lead, verifP: Promise<VerifJournal | undefined>, g: Gate | undefined): Promise<string | undefined> {
  if (flow.isStopped) return undefined
  const home = await ioOf($).home()
  if (!home) return undefined
  const verif = await verifP.catch(() => undefined)
  const d = new Date(flow.endedAt ?? (await $.clock.now()))
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${dayKey(d)} ${p(d.getHours())}:${p(d.getMinutes())}`
  const text = rapportMarkdown({
    flow,
    lead,
    entries: await read($, entries),
    date,
    verif,
    porte: g ? { resultat: g.dernier, accepte: g.accepte, gelesModifies: g.gelesModifies } : undefined,
    criteres: g?.criteres,
    verdicts: g?.verdicts,
    cache: (await read($, cacheStatsA))?.flow,
    ...(g?.web ? { web: webView(g) } : {}),
    ...(g?.mobile ? { mobile: mobileView(g) } : {}),
  })
  const path = `${normalizePath(home)}/.claude/revo-flow/rapports/${slug(flow.title) || 'rapport'}.md`
  await $.fs.write(path, text)
  await setFlow($, f => (f.id === flow.id ? { ...f, rapportFile: path } : f))
  return path
}

/** Bouton « rapport.md » : ouvre le rapport de fin de flow, comme plan.md. */
async function openRapport($: $) {
  const file = (await read($, flowA))?.rapportFile
  if (file) await openFile($, file, 'le rapport')
}

/** Bouton « plan.md » : ouvre le fichier du plan dans l'application par défaut du système ; sinon, un toast donne son chemin. */
async function openPlan($: $) {
  const file = (await read($, flowA))?.planFile
  if (file) await openFile($, file, 'le plan')
}

/** Bouton « Détail » de la vérification : la sortie complète de la dernière commande rouge, comme plan.md. */
async function openVerif($: $) {
  const file = (await read($, verifA))?.detail
  if (file) await openFile($, file, 'la sortie complète')
}

/** Ouvre un fichier dans l'application par défaut du système (cmd /c start sous Windows) ; sinon, un toast donne son chemin. */
async function openFile($: $, file: string, what: string) {
  const tries = (await isWindows($)) ? [['cmd', '/c', 'start', '', file.replace(/\//g, '\\')]] : [['open', file], ['xdg-open', file]]
  for (const argv of tries) {
    const r = await $.process.run(argv, { timeoutMs: 5000 }).catch(() => undefined)
    if (r?.exitCode === 0) return
  }
  $.ui.toast(`revo-flow : ${what} est dans ${file}`)
}

/** Bouton « Relancer » de la vérification : une nouvelle porte sur l'état actuel du flow, en fond. */
async function rerunVerif($: $) {
  const flow = await read($, flowA)
  if (!gate || !flow || flow.id !== gate.flowId || gate.mode === 'off') return
  void ensureGate($, true).catch(() => undefined)
}

function statusText(flow: Flow | null) {
  if (!flow) return 'revo-flow : aucun flow en cours. Lance /revo-flow <ta demande>.'
  const head = `revo-flow · ${flow.title} — ${flow.phase === 'planning' ? 'planification' : flow.phase === 'done' ? 'terminé' : `${flowPercent(flow)} %`}`
  const rows = flow.agents.map(a => {
    const p = progress(a.tasks, a.status, a.status === 'running')
    const state = a.status === 'blocked' ? `en attente de « ${a.waitingFor?.name ?? '?'} »` : a.status
    return `  ${a.name} (${MODELS[a.model].label} · ${a.effort}) ${p.count}${p.label ? ` — ${p.label}` : ''} [${state}]`
  })
  return [head, ...rows].join('\n')
}

function readOptions(o: PluginOptions) {
  opts.validerPlan = o.validerPlan !== false
  opts.conflits = o.conflits === 'refuser' ? 'refuser' : 'avertir'
  opts.notifier = o.notifier !== false
  opts.cache = o.cache !== false
  // La porte de vérification (v2) : bloquer par défaut ; observer la fait tourner sans jamais bloquer ; off la retire.
  opts.verif = o.verif === 'observer' || o.verif === 'off' ? o.verif : 'bloquer'
  // Le score CRAP (v2.1) dans la porte : actif par défaut ; il bloque selon le mode verif.
  opts.crap = o.crap !== false
  // Les agents installés (v2.2) proposés à l'orchestrateur : actifs par défaut.
  opts.agents = (o as { agents?: unknown }).agents !== false
  // La preuve web (v3) : l'extension Claude in Chrome par défaut ; devtools ajoute le serveur MCP Chrome DevTools au vérificateur.
  const web = (o as { web?: unknown }).web
  opts.web = web === 'devtools' || web === 'off' ? web : 'extension'
  // La preuve mobile (v3.1) : l'outil mobile de revo-flow par défaut ; mcp ajoute le serveur mobile-mcp au vérificateur.
  const mobile = (o as { mobile?: unknown }).mobile
  opts.mobile = mobile === 'mcp' || mobile === 'off' ? mobile : 'appareil'
}

/**
 * /revo-flow doctor : ce que le mod a détecté sur le projet courant. Lecture seule : le graphe est lu (ou construit en mémoire, jamais écrit),
 * les commandes de la porte sont celles confirmées ou, sinon, détectées maintenant ; aucune n'est lancée (seuls `flutter --version`, si .fvm existe,
 * et la liste des appareils (flutter devices, adb devices, simctl) sur une app mobile le sont).
 */
async function doctorCommand($: $): Promise<string> {
  const ref = await resolveProject(ioOf($)).catch(() => undefined)
  const agents = await loadAgents($).catch(() => [])
  const common = { mode: opts.verif, crap: opts.crap, cache: opts.cache, agentsActif: opts.agents, agents }
  if (!ref) return doctorText({ ...common, manifestes: [], commandes: [], confirmation: 'a-confirmer', stats: null, journal: 0, pieges: [] })
  const io = ioOf($)
  const graph = graphCache.get(ref.cle)?.graph ?? (await loadGraph(io, ref).catch(() => null)) ?? (await buildMechanical(io, ref).catch(() => null))
  if (!graph) return doctorText({ ...common, nom: ref.nom, manifestes: [], commandes: [], confirmation: 'a-confirmer', stats: null, journal: 0, pieges: [] })
  const files = Object.keys(graph.fichiers)
  const paths = [...new Set([...MANIFESTES, ...manifestPaths(files)])]
  const texts = await Promise.all(paths.map(p => io.fs.read(`${normalizePath(ref.racine)}/${p}`).then(t => (typeof t === 'string' ? t : undefined), () => undefined)))
  const readMap: Record<string, string | undefined> = Object.fromEntries(paths.map((p, i) => [p, texts[i]]))
  const hashes = await hashFiles($, ref.racine, paths.filter(p => readMap[p] !== undefined))
  const pv = graph.projet.verif
  const isConfirmed = !!pv && !needsConfirm(pv, hashes)
  let commandes = pv?.commandes ?? []
  let pieges = pv?.pieges ?? []
  if (isConfirmed) commandes = opts.crap ? commandes : withoutCrap(commandes)
  else {
    const sondes = Object.fromEntries(await Promise.all(SONDES.map(async p => [p, await io.fs.exists(`${normalizePath(ref.racine)}/${p}`).catch(() => false)] as const)))
    const found = detectCommands({ stack: graph.projet.stack, files, read: readMap, sondes, crap: opts.crap })
    commandes = found.commandes
    pieges = found.pieges
  }
  // Flutter du poste contre celui de .fvm : la version lue remplace le rappel générique.
  const fvm = fvmVersion(readMap)
  if (fvm) {
    const argv = withShell(['flutter', '--version', '--machine'], (await isWindows($)) ? 'windows' : 'posix')
    const out = await $.process.run(argv, { cwd: ref.racine, timeoutMs: 20_000 }).then(r => r.stdout, () => '')
    const trap = flutterVersionTrap(fvm, out)
    if (out) pieges = pieges.filter(p => !/attendu par \.fvm/.test(p))
    if (trap) pieges = [...pieges, trap]
  }
  return doctorText({
    ...common,
    nom: ref.nom,
    stack: graph.projet.stack,
    manifestes: manifestsOf(files, readMap),
    commandes,
    confirmation: isConfirmed ? 'confirmee' : 'a-confirmer',
    ...(pv ? { verif: pv } : {}),
    commit: (await gitOut($, ref.racine, ['rev-parse', 'HEAD'])).trim(),
    stats: computeStats(graph, null, ref.nom),
    journal: graph.journal?.length ?? 0,
    pieges,
    web: await webDispo($, ref, graph, readMap),
    mobile: await mobileDispo($, ref, graph, readMap, true),
  })
}

// ── Les hooks ────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  readOptions(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'revo-flow',
      description:
        'revo-flow <demande> : l’orchestrateur lit les specs, fait le plan, répartit les tâches entre des sous-agents et suit chacun dans le panneau · statut · panneau · stop · historique [n] : les derniers flows, leur coût et le bilan par modèle · cache [projet | build [feature | --top N | --tout] | clear [feature] | mot-clé] : le graphe et les fiches de features du projet',
      argumentHint: '<demande> | statut | panneau | stop | historique [n] | cache [projet | build [feature|--top N|--tout] | clear [feature] | mot-clé]',
      // statut, panneau, stop et cache répondent tout de suite, même pendant un tour ; une nouvelle demande part
      // par prompt.submit, qui attend de toute façon que la session soit libre.
      immediate: true,
    })
    // Les outils (cache compris) ne sont déclarés qu'au premier /revo-flow ou `cache build` : sans le mod, aucune
    // description d'outil dans les requêtes. Après un rechargement en plein flow, on les redéclare.
    if (await read($, flowA)) {
      await registerTools($)
      if (opts.cache) await registerCacheTool($).catch(() => undefined)
      savedId = (await read($, flowA))?.id
    }
    await registerIndexer($)
    await registerVerifier($)
    // Rechargé en plein flow vérifié : la porte revient (gel, critères, tentatives) ; la base qui tournait est perdue.
    await restoreVerif($).catch(() => undefined)
    await migrate($)
    await purge($)
    await loadTokens($)
    const usage = await $.session.usage()
    await update($, limits, () => usage.rateLimits.map(l => ({ ...l })))
    await update($, contextA, () => contextOf(usage.context))
    await update($, sessionCostA, () => usage.cost?.usd ?? 0)
    watchAgents($)
    // Redémarré (pas rechargé : l'état du flow est perdu) avec un flow en cours dans le store : Reprendre ou Abandonner,
    // demandé hors du démarrage pour ne pas le retenir.
    if (!(await read($, flowA))) $.clock.after(0, () => void offerResume($, e.isInteractive).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: 'revo-flow' }, async ($, e) => {
    const args = e.args.trim()
    const word = args.toLowerCase()
    const flow = await read($, flowA)

    if (!args || word === 'statut' || word === 'status') return { text: statusText(flow) }
    if (word === 'doctor') return { text: await doctorCommand($) }
    if (word === 'version') {
      const manifest = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).then(t => (typeof t === 'string' ? t : undefined), () => undefined)
      return { text: versionText(pluginVersion(manifest)) }
    }
    const hist = /^(historique|history)(?:\s+(\d+))?$/.exec(word)
    if (hist) return { text: historyText(await $.store.get(JOURNAL_KEY), hist[2] ? Math.max(1, Number(hist[2])) : 10) }
    if (word === 'stop') {
      let isStopped = false
      if (flow?.agents.some(a => a.status === 'running')) {
        // Sans personne à qui demander, on arrête tout : c'est ce que « stop » veut dire. Dialogue fermé : rien ne change.
        const answer = await askOr($, 'Des agents revo-flow tournent encore. Les arrêter ?', ['Tout arrêter', 'Garder les agents'], {
          headless: 'Tout arrêter',
          dismissed: '',
        })
        if (!answer) return { text: 'revo-flow : stop annulé, le flow continue.' }
        isStopped = answer !== 'Garder les agents'
      } else isStopped = flow !== null && leadTurnId !== undefined
      if (isStopped) await stopAll($)
      else await stopProofs($, gate)
      await update($, flowA, () => null)
      // Plus de flow : plus d'instantané à reprendre.
      await saveFlow($).catch(() => undefined)
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

    // Un flow encore en cours n'est jamais remplacé sans accord : ses agents ne seraient plus suivis.
    if (flow && flow.phase !== 'done') {
      const busy = flow.agents.filter(a => a.status === 'running').length
      const answer = await askOr(
        $,
        `Le flow « ${flow.title} » n’est pas fini${busy ? ` (${busy} agent${busy > 1 ? 's' : ''} au travail)` : ''}. Le remplacer par cette demande ?`,
        ['Remplacer', 'Garder le flow en cours'],
        { headless: 'Remplacer', dismissed: 'Garder le flow en cours' },
      )
      if (answer !== 'Remplacer') return { text: `revo-flow : demande non lancée, « ${flow.title} » continue. /revo-flow stop pour l’arrêter.` }
      if (busy) await stopAll($)
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
    // L'instantané du nouveau flow remplace celui de l'ancien.
    await saveFlow($).catch(() => undefined)
    try {
      if (!(await isPaneShown($))) await openPane($)
    } catch {
      // le panneau ne doit jamais bloquer la demande
    }
    // Le brief du cache (si une fiche correspond, après confirmation) ; sans graphe possible, on continue sans.
    const brief = await startFlowCache($, String(now), args).catch(() => undefined)
    // Les commandes de vérification du projet (confirmées une fois), puis la base de référence en fond ; jamais bloquant.
    const verifNote = await startVerif($, String(now)).catch(() => undefined)
    // Les agents installés (option agents) : leur bloc suit le rôle d'orchestrateur, qui les propose à l'étape « Équipe ».
    agentsInstalles = await loadAgents($).catch(() => [])
    const agentsNote = catalogueBrief(agentsInstalles)
    // Le rôle d'orchestrateur est une note cachée laissée au modèle par la commande ; la demande part ensuite
    // comme si l'utilisateur l'avait tapée. Sans /revo-flow, rien de tout cela n'est ajouté.
    $.clock.after(0, () => void $.prompt.submit({ text: args, asUser: true }).catch(() => undefined))
    return {
      text: `revo-flow : ${modelLabel(model)} lit la demande et les specs, puis prépare le plan et l’équipe d’agents…`,
      context: [
        leadBrief(opts.cache, opts.verif !== 'off', opts.crap, agentsInstalles.length > 0),
        ...(agentsNote ? [agentsNote] : []),
        ...(brief ? [brief] : []),
        ...(verifNote ? [verifNote] : []),
      ],
    }
  })

  on('turn.start', async ($, e, next) => {
    // Le dernier tour de l'orchestrateur se compte même hors flow : la ligne de fin de tour en a besoin.
    if (e.agentId === undefined) {
      leadTurnId = e.turnId
      const at = await $.clock.now()
      await update($, lastTurnA, () => ({ at, durationMs: 0, tokens: EMPTY, modelId: '', costUsd: 0, isLive: true }))
    }
    const flow = await read($, flowA)
    if (flow) await update($, isBusy, () => true)
    // Un agent tenu pour fini (waiting après son tour) que son travail de fond réveille : il reprend, le flow aussi.
    const woken = e.agentId && flow && flow.phase !== 'done' ? flow.agents.find(a => a.agentId === e.agentId && a.status === 'done') : undefined
    if (woken) {
      await setAgent($, woken.key, ({ endedAt: _end, ...x }) => ({ ...x, status: 'running', hasEndedTurn: false }))
      await setFlow($, f => (f.phase === 'review' ? { ...f, phase: 'running' } : f))
    }
    // Un agent en attente (ou réarmé pour une relance) repris par SendMessage : même id, même contexte, suivi de nouveau.
    const resumed =
      e.agentId && flow ? flow.agents.find(a => !a.agentId && a.lastAgentId === e.agentId && (a.status === 'blocked' || a.status === 'waiting')) : undefined
    if (resumed && e.agentId) {
      const at = await $.clock.now()
      claimed.add(resumed.key)
      await setAgent($, resumed.key, ({ waitingFor: _w, endedAt: _end, ...x }) => ({
        ...x,
        agentId: e.agentId!,
        status: 'running',
        startedAt: at,
        lastActiveAt: at,
        hasEndedTurn: false,
        attempts: x.status === 'blocked' ? (x.attempts ?? 1) + 1 : (x.attempts ?? 1),
      }))
      await setFlow($, ({ endedAt: _end, ...f }) => ({ ...f, phase: f.phase === 'review' || f.phase === 'done' || f.phase === 'dispatch' ? 'running' : f.phase }))
    }
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
      if (!e.agentId) {
        stoppedTurns.delete(e.turnId)
        await update($, isBusy, () => false)
      }
      return next(e)
    }
    if (e.agentId) {
      // Le vérificateur : son verdict par critère va au panneau (VerifView.criteres).
      if (verifierAgents.has(e.agentId) && e.answer) await readVerdicts($, e.answer).catch(() => undefined)
      const a = flow.agents.find(x => x.agentId === e.agentId)
      if (a) {
        await setAgent($, a.key, x => ({ ...x, hasEndedTurn: true, isDoing: false }))
        await syncAgents($)
      }
      return next(e)
    }
    await update($, isBusy, () => false)
    // Le tour d'un flow arrêté puis remplacé : le nouveau flow n'a rien à en tirer.
    if (stoppedTurns.delete(e.turnId) && !flow.isStopped) return next(e)
    // Interrompu avant même le plan : il n'y a rien à suivre, le flow est abandonné.
    if (e.reason === 'aborted' && flow.phase === 'planning') {
      await update($, flowA, () => null)
      await saveFlow($).catch(() => undefined)
      $.ui.toast('revo-flow : flow annulé')
      return next(e)
    }
    await update($, leadA, l => ({ ...l, isDoing: false }))
    await syncAgents($)
    // L'orchestrateur a fini son tour après que tous les agents ont fini : c'était sa conclusion.
    const now = await read($, flowA)
    if (now && (now.phase === 'review' || now.phase === 'running') && (allFinished(now) || now.isStopped)) {
      // Sans « apprendre » pendant le flow, une fiche minimale automatique (le filet), puis la fin ; pas pour un flow arrêté.
      if (!now.isStopped) await learnAtEnd($, now).catch(() => undefined)
      await finishFlow($)
    }
    return next(e)
  })

  // Chaque requête : l'effort choisi pour le sous-agent, et les tokens attribués à qui les a consommés.
  on('turn.step', async function* ($, e, next) {
    const flow = await read($, flowA)
    const a = flow && e.agentId ? flow.agents.find(x => x.agentId === e.agentId) : undefined
    // Un modèle sans effort n'en reçoit pas : on ne fixe l'effort que là où la requête en porte un. Un agent installé qui déclare
    // son effort garde le sien.
    const step = a && e.effort !== undefined && !ownEffort(a) ? { ...e, effort: a.effort } : e
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
        } else if (scouts.has(e.agentId)) {
          // Un éclaireur : ses tokens et son coût, pas son modèle, vont à l'orchestrateur qui l'a lancé.
          await update($, leadA, l => ({ ...l, tokens: addUsage(l.tokens, u), costUsd: l.costUsd + costUsd(step.model, u) }))
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
    // Pas d'agent avant le plan : l'orchestrateur lit les specs lui-même, pose le plan, puis lance l'équipe. Seule
    // exception, après accord de l'utilisateur : un éclaireur Explore (lecture seule), moins cher qu'une lecture large
    // faite par le modèle de la session.
    if (flow.phase === 'planning') {
      if (e.subagentType !== 'Explore') {
        return {
          deny: `revo-flow : aucun sous-agent avant le plan, sauf un éclaireur Explore (lecture seule, après accord de l’utilisateur). Lis les specs toi-même ou lance un Explore, appelle ${PLAN_TOOL}, puis lance les agents prévus.`,
        }
      }
      const answer = await askOr(
        $,
        `L’orchestrateur veut un éclaireur en lecture seule avant le plan : « ${e.description} »${e.model ? ` (${modelLabel(e.model)})` : ''}. L’autoriser ?`,
        ['Autoriser', 'Refuser'],
        { headless: 'Autoriser', dismissed: 'Refuser' },
      )
      if (answer !== 'Autoriser') {
        return { deny: `revo-flow : éclaireur refusé par l’utilisateur. Lis les specs toi-même, puis appelle ${PLAN_TOOL}.` }
      }
      const r = await next(e)
      if (r.deny === undefined && r.agentId) {
        scouts.add(r.agentId)
        $.ui.toast(`revo-flow : éclaireur « ${e.description} » lancé`)
      }
      return r
    }
    if (flow.phase === 'dispatch' && !flow.isApproved) {
      return { deny: 'revo-flow : le plan attend la validation de l’utilisateur. Attends sa réponse avant de lancer les agents.' }
    }
    const a = matchAgent(
      flow.agents.filter(x => !claimed.has(x.key)),
      e.description,
      e.name,
    )
    if (!a) {
      // Un vérificateur lancé hors plan : sa tâche (critères, diff, commandes) s'ajoute à son prompt et son Bash sera filtré.
      if (e.subagentType !== VERIFIER_TYPE) return next(e)
      if (isBackgroundSpawn(e)) return { deny: VERIFIER_FOREGROUND }
      const task = await verifierBrief($).catch(() => undefined)
      const r = await next(task ? { ...e, prompt: `${e.prompt}\n\n${task}` } : e)
      if (r.deny === undefined && r.agentId) verifierAgents.add(r.agentId)
      return r
    }
    // Le vérificateur se suit en direct (preuve web ou mobile dans le panneau, sur l'appareil) : jamais en arrière-plan.
    if ((isVerifier(a) || e.subagentType === VERIFIER_TYPE) && isBackgroundSpawn(e)) return { deny: VERIFIER_FOREGROUND }
    claimed.add(a.key)
    const others = flow.agents.filter(x => x.key !== a.key).map(x => x.name)
    // L'extrait de la fiche servie qui concerne cet agent, après ses consignes.
    const extract = await agentCacheExtract($, a, e.prompt)
    // La vérification (v2) : la consigne « verif lancer » si la porte est active ; la consigne du testeur et les critères pour un
    // testeur ; la tâche du vérificateur (critères, diff, commandes, triches) pour un vérificateur, dont le type est imposé.
    const isVerifOn = !!gate && gate.flowId === flow.id && gate.mode !== 'off'
    const criteres = gate?.flowId === flow.id ? gate.criteres : []
    const tester = isTester(a) ? `\n\n${TESTER_BRIEF}${criteres.length ? `\n\nCritères d'acceptation du plan :\n${criteres.map(c => `- ${c.id} : ${c.texte}`).join('\n')}` : ''}` : ''
    const verifier = isVerifier(a) ? await verifierBrief($).catch(() => undefined) : undefined
    const prompt = `${e.prompt}\n\n${agentBrief(a, await agentCacheMode($), others, isVerifOn, opts.crap)}${tester}${verifier ? `\n\n${verifier}` : ''}${extract ? `\n\n${extract.text}` : ''}`
    const r = await next({ ...e, prompt, ...spawnType(a) })
    if (r.deny !== undefined || !r.agentId) {
      claimed.delete(a.key)
      return r
    }
    if (isTester(a)) testerAgents.add(r.agentId)
    if (isVerifier(a) || e.subagentType === VERIFIER_TYPE) verifierAgents.add(r.agentId)
    if (extract) await served($, extract.cle, extract.hits, tokensOf(extract.text)).catch(() => undefined)
    const agentId = r.agentId
    const now = await $.clock.now()
    // Un agent en attente relancé directement par l'orchestrateur (sans relaunch) : c'est une nouvelle tentative.
    await setAgent($, a.key, ({ waitingFor: _w, ...x }) => ({
      ...x,
      agentId,
      modelId: r.model,
      status: 'running',
      startedAt: now,
      lastActiveAt: now,
      hasEndedTurn: false,
      attempts: x.status === 'blocked' ? (x.attempts ?? 1) + 1 : (x.attempts ?? 1),
    }))
    // Un agent en attente relancé après la fin du flow (l'orchestrateur prévenu le relance) : le flow repart.
    await setFlow($, ({ endedAt, ...f }) =>
      f.phase === 'dispatch' || (a.status === 'blocked' && (f.phase === 'review' || f.phase === 'done'))
        ? { ...f, phase: 'running' }
        : { ...f, ...(endedAt !== undefined ? { endedAt } : {}) },
    )
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
    const typed = await withKnownTypes($, parsed.plan)
    if ('error' in typed) return { deny: `Plan refusé : ${typed.error}` }
    const { plan } = typed
    claimed.clear()
    // Les critères d'acceptation (lot 2) : à la porte (vérificateur, testeur) et au panneau.
    if (gate && gate.flowId === flow.id) {
      const g = gate
      g.criteres = plan.criteres ?? []
      g.verdicts = undefined
      await persistVerif($, g)
      await update($, verifA, v => {
        if (!v) return v
        const { criteres: _c, ...rest } = v
        return g.criteres.length ? { ...rest, criteres: { total: g.criteres.length, ok: 0, verdicts: [] } } : rest
      })
    }
    // Le plan en .md : un fichier à garder ou à rouvrir (bouton « plan.md » du panneau) ; il ne bloque jamais le plan.
    const planFile = await writePlanFile($, plan, flow).catch(() => undefined)
    await setFlow($, f => ({
      ...f,
      title: plan.title,
      summary: plan.summary,
      phase: 'dispatch',
      isApproved: !opts.validerPlan,
      planFile,
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

  // Le dialogue de validation du plan : le plan en markdown s'affiche en aperçu à côté de « Lancer » et « Annuler ».
  // $.ui.ask passe par l'outil AskUserQuestion, que ce hook voit (seul le hook qui pose la question est sauté).
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const preview = pendingPreview
    const input = e as unknown as { questions?: { question?: string; header?: string; options?: { label: string }[] }[] }
    const q = input.questions?.length === 1 ? input.questions[0] : undefined
    if (!preview || !q || q.header !== PLUGIN || q.question !== preview.question) return next(e)
    return next({ ...e, questions: [{ ...q, options: (q.options ?? []).map(o => ({ ...o, preview: preview.markdown })) }] } as typeof e)
  }).catch(($, e, next) => next(e))

  // Un sous-agent signale une tâche : sa barre avance. « attente » note qui il attend (waitingFor) ; tout autre
  // statut retire l'attente : l'agent a repris.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { tache?: unknown; statut?: unknown; agent?: unknown; attend?: unknown }
    const flow = await read($, flowA)
    const a = flow?.agents.find(x => (e.agentId ? x.agentId === e.agentId : x.key === slug(String(input.agent ?? ''))))
    if (!flow || !a) return { result: 'revo-flow : pas de liste de tâches revo-flow pour cet agent, rien à suivre.' as never }
    const n = Number(input.tache)
    const statut = String(input.statut ?? 'en_cours')
    const tasks = applyStep(a.tasks, n, statut)
    if (!tasks) return { deny: `revo-flow : « tache » doit être un numéro entre 1 et ${a.tasks.length}.` }
    const head = `tâche ${Math.round(n)}/${a.tasks.length}`
    if (slug(statut) === 'attente') {
      const asked = String(input.attend ?? '').trim()
      const target = findAgent(flow.agents, asked, a.key)
      if (target?.status === 'done') {
        await setAgent($, a.key, ({ waitingFor: _w, ...x }) => ({ ...x, tasks, hasReported: true }))
        return { result: `revo-flow : « ${target.name} » a déjà fini : continue (${head}).` as never }
      }
      const since = await $.clock.now()
      const name = target?.name ?? (asked.slice(0, 60) || 'un autre agent')
      await setAgent($, a.key, x => ({ ...x, tasks, hasReported: true, waitingFor: { ...(target ? { key: target.key } : {}), name, since } }))
      const then = target
        ? `revo-flow te relancera quand « ${name} » aura fini`
        : `ce n’est pas un agent du plan : l’orchestrateur sera prévenu à la fin de ton tour`
      return { result: `ok — ${head} en attente de « ${name} » : termine ta réponse en précisant ce qui te manque ; ${then}.` as never }
    }
    await setAgent($, a.key, ({ waitingFor: _w, ...x }) => ({ ...x, tasks, hasReported: true }))
    return { result: `ok — ${head} (${tasks[Math.round(n) - 1]!.title}) : ${statut}` as never }
  }).catch(() => ({ result: 'revo-flow : suivi indisponible, continue tes tâches.' as never }))

  // L'outil cache : autorisé en planification et hors flow ; aucune exception ne remonte, l'erreur est dite en texte.
  on('tool.call', { tool: CACHE_TOOL }, async ($, e) => {
    try {
      return { result: (await cacheTool($, e as unknown as CacheCall)) as never }
    } catch (err) {
      return { result: `revo-flow cache : ${errText(err)}` as never }
    }
  }).catch(() => ({ result: 'revo-flow cache : indisponible pour l’instant, continue sans.' as never }))

  // L'outil verif : aucune exception ne remonte, l'erreur est dite en texte.
  on('tool.call', { tool: VERIF_TOOL }, async ($, e) => {
    try {
      return { result: (await verifTool($, e as unknown as Record<string, unknown> & { agentId?: string })) as never }
    } catch (err) {
      return { result: `revo-flow verif : ${errText(err)}` as never }
    }
  }).catch(() => ({ result: 'revo-flow verif : indisponible pour l’instant ; continue, la porte de fin vérifiera.' as never }))

  // L'outil mobile (v3.1) : chaque action est montrée dans le panneau pendant qu'elle se fait (l'utilisateur regarde l'appareil) ;
  // aucune exception ne remonte, l'erreur est dite en texte.
  on('tool.call', { tool: MOBILE_TOOL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown> & { agentId?: string }
    const flow = await read($, flowA)
    const who = flow && flow.phase !== 'done' ? whoIs(flow, input.agentId) : undefined
    const label = describeCall(MOBILE_TOOL, input)
    if (who) await setActivity($, who, { doing: label, isDoing: true, filePath: '', reason: '' }).catch(() => undefined)
    let result: string
    try {
      result = await mobileActionTool($, input)
    } catch (err) {
      result = `revo-flow mobile : ${errText(err)}`
    }
    if (who) {
      const prev = who === 'lead' ? await read($, leadA) : (await read($, flowA))?.agents.find(a => a.key === who)
      await setActivity($, who, { isDoing: false, history: [...(prev?.history ?? []), label].slice(-3) }).catch(() => undefined)
    }
    return { result: result as never }
  }).catch(() => ({ result: 'revo-flow mobile : indisponible pour l’instant ; juge non vérifiable ce qui demande l’appareil.' as never }))

  // Le gel des tests (lot 2) : le testeur n'édite que des tests, un test gelé ne se modifie que par son auteur. Fermé : un
  // plantage refuse l'édition tant que le gel est actif.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await editDenial($, e)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => (isGelActive() ? { deny: GEL_ERROR } : next(e)))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await editDenial($, e)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => (isGelActive() ? { deny: GEL_ERROR } : next(e)))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const deny = await editDenial($, e)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => (isGelActive() ? { deny: GEL_ERROR } : next(e)))

  // La porte de fin (§2 étapes 10 à 12) : la fin de tour de l'orchestrateur en conclusion attend la porte. Sans .catch qui
  // refuse : un plantage laisse finir (porte ouverte), et le flow est marqué « non vérifié (erreur de revo-flow) ».
  on('classic.Stop', async ($, e, next) => {
    let reason: string | undefined
    try {
      reason = await stopGate($, e)
    } catch {
      if (gate) gate.erreur = true
    }
    return reason ? { block: reason } : next(e)
  })

  // Le vérificateur n'est proposé au modèle que pendant un flow (même sans commande de vérification, il lit et juge les critères).
  on('agent.offer', { agent: VERIFIER_TYPE }, async ($, e, next) => {
    const flow = await read($, flowA)
    return flow && flow.phase !== 'done' ? next(e) : { isOffered: false }
  })

  // L'agent de construction n'est lancé que par /revo-flow cache build : le modèle ne le voit pas.
  on('agent.offer', { agent: `${PLUGIN}:${INDEXER}` }, () => ({ isOffered: false }))

  // Ce que chacun fait en direct, et les fichiers modifiés : seulement pendant un flow.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool === PLAN_TOOL || tool === STEP_TOOL || tool === VERIF_TOOL || tool === MOBILE_TOOL) return next(e)
    const input = e as unknown as Record<string, unknown>
    const isVerifierCall = !!e.agentId && verifierAgents.has(e.agentId)
    // La preuve web (v3) : le navigateur du vérificateur ne sert que pendant la preuve web, et seulement sur l'origine du serveur prêt.
    if (isVerifierCall && isWebTool(tool)) {
      const flow = await read($, flowA)
      const deny = webToolDenial(tool, input, gate?.web && flow && gate.flowId === flow.id ? { etat: gate.web.etat, url: gate.web.url } : undefined)
      if (deny) return { deny }
    }
    // La preuve mobile (v3.1, option mcp) : les outils mobile-mcp du vérificateur ne servent que l'app prête sur l'appareil accordé.
    if (isVerifierCall && isMobileMcpTool(tool)) {
      const flow = await read($, flowA)
      const deny = mobileToolDenial(tool, gate?.mobile && flow && gate.flowId === flow.id ? { etat: gate.mobile.etat } : undefined)
      if (deny) return { deny }
    }
    // Le vérificateur est en lecture seule : son Bash ne passe que pour des lectures et les commandes confirmées (§8).
    if (tool === 'Bash' && isVerifierCall) {
      const command = text((e as unknown as { command?: unknown }).command)
      if (!verifierBashAllowed(command, confirmedArgv())) {
        return {
          deny: 'revo-flow : le vérificateur est en lecture seule. Seules passent les lectures (git diff, git show, git log, git status, cat, ls, head, tail, grep, wc, sed -n) et les commandes de vérification confirmées données dans ta tâche, sans enchaînement ni redirection.',
        }
      }
    }
    // Une capture d'écran du vérificateur pendant la preuve web est rangée avec les sorties du flow (au mieux, jamais bloquant).
    const kept = async <R extends { deny?: unknown; isError?: boolean }>(ran: R): Promise<R> => {
      if (isVerifierCall && ran.deny === undefined && ran.isError !== true && (isScreenshotCall(tool, input) || (isMobileMcpTool(tool) && /screenshot/i.test(tool)))) await keepCapture($, ran)
      return ran
    }
    const flow = await read($, flowA)
    const who = flow && flow.phase !== 'done' ? whoIs(flow, e.agentId) : undefined
    if (!who) return kept(await next(e))
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
      // La porte déjà lancée ne vaut plus pour ce nouvel état (une lecture Bash ne change rien).
      if (!failed && (path || (tool === 'Bash' && !verifierBashAllowed(text(input.command), [])))) touchVerif(Boolean(path) || flow?.phase !== 'planning')
      if (!failed && path) {
        await markFile($, path, who, e.tool_use_id, e.agentId)
        // Un fichier du projet vient de changer : le graphe gardé est revérifié au prochain appel, pas dans 30 s (L17).
        staleGraph((await read($, flowCacheA))?.cle ?? flowRef?.cle)
      }
      // La mesure du cache : ce qui est réellement lu pendant le flow, hors du chemin de l'outil.
      if (!failed && tool === 'Read' && typeof input.file_path === 'string') noteRead($, input.file_path, { limit: input.limit }, who)
      if (!failed && (tool === 'Grep' || tool === 'Glob')) noteToolOutput($, tokensOf(ran.text ?? ''))
      if (!failed && tool === 'Bash' && typeof input.command === 'string') {
        // Seule une lecture d'un fichier (cat, sed -n, head, tail) compte, à la taille de sa sortie ; toute autre commande est ignorée.
        const file = bashReadFile(input.command)
        if (file) noteRead($, file, { tok: tokensOf(ran.text ?? '') }, who, 'bash')
      }
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
    return kept(ran)
  }).catch(($, e, next) =>
    // Un plantage du hook : l'outil passe, sauf un outil navigateur du vérificateur (la preuve web se ferme par prudence).
    e.agentId && verifierAgents.has(e.agentId) && (isWebTool(String(e.tool)) || isMobileMcpTool(String(e.tool)))
      ? { deny: 'revo-flow : le contrôle de la preuve à l’exécution a échoué ; outil navigateur ou mobile refusé par prudence, réessaie.' }
      : next(e),
  )

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
    const recap = flowRecap(flow, opts.cache ? cacheRecap(await read($, flowCacheA)) : false, opts.verif !== 'off')
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
    if (e.surface === 'terminal') return TerminalBand($.ui.resolve(e) as unknown as Elements['terminal'], d, e.props.bodyColumns || 100) ?? next(e)
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
