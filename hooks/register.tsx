import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Activity, Flow, FlowAgent, Lead } from '../types'
import {
  EMPTY,
  LEAD_BRIEF,
  MODELS,
  PLAN_TOOL,
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
  finishTasks,
  firstSentence,
  flowPercent,
  isTally,
  matchAgent,
  modelLabel,
  parsePlan,
  progress,
  projectOf,
  shortPath,
  slug,
  weekKey,
  type Usage,
} from './lib'
import { DesktopBand, DesktopPane, TerminalBand, TerminalPane, type ViewData } from './views'

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

/** Les agents prévus déjà attribués à un appel Agent : deux lancements en parallèle ne prennent jamais le même. */
const claimed = new Set<string>()
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

async function gitBranch($: $, root: string) {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
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

/** Le fichier modifié entre dans la liste tout de suite ; sa raison (le texte écrit juste avant) suit, hors de l'outil. */
async function markFile($: $, path: string, toolUseId: string | undefined, agentId: string | undefined) {
  const at = await $.clock.now()
  const rel = shortPath(path)
  await update($, entries, list => {
    const old = list.find(x => x.path === path)
    return [...list.filter(x => x.path !== path), { path, rel, reason: old?.reason ?? '…', count: (old?.count ?? 0) + 1, at }].slice(-100)
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
  }
}

const ENDED = new Set(['completed', 'failed', 'killed'])

/**
 * L'état réel des sous-agents, lu auprès de Claude Code : la fin d'un tour ne veut pas dire que l'agent a fini
 * (un agent en arrière-plan termine des tours et continue). Seuls completed, failed ou killed le terminent.
 */
async function syncAgents($: $) {
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
    await setAgent($, a.key, x => ({ ...x, status: failed ? 'failed' : 'done', isDoing: false, tasks: finishTasks(x.tasks, failed) }))
  }
  await setFlow($, f => (f.phase === 'running' && allFinished(f) ? { ...f, phase: 'review' } : f))
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

// ── Les hooks ────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'revo-flow',
      description:
        'revo-flow <demande> : l’orchestrateur lit les specs, fait le plan, répartit les tâches entre des sous-agents et suit chacun dans le panneau · statut · panneau · stop',
      argumentHint: '<demande> | statut | panneau | stop',
    })
    // Les outils ne sont déclarés qu'au premier /revo-flow ; après un rechargement en plein flow, on les redéclare.
    if (await read($, flowA)) await registerTools($)
    await migrate($)
    await purge($)
    await loadTokens($)
    const usage = await $.session.usage()
    await update($, limits, () => usage.rateLimits.map(l => ({ ...l })))
    watchAgents($)
    return next(e)
  })

  on('command.run', { command: 'revo-flow' }, async ($, e) => {
    const args = e.args.trim()
    const word = args.toLowerCase()
    const flow = await read($, flowA)

    if (!args || word === 'statut' || word === 'status') return { text: statusText(flow) }
    if (word === 'stop') {
      await update($, flowA, () => null)
      if (await isPaneShown($)) await $.ui.close({ id: PANE })
      return { text: 'revo-flow : flow arrêté, barre et panneau retirés. Les agents déjà lancés continuent jusqu’au bout.' }
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

    watchAgents($)
    // Une nouvelle demande : le panneau s'ouvre sur « En attente du plan d'exécution » ; les agents n'y entrent qu'avec le plan.
    await registerTools($)
    const now = await $.clock.now()
    let project = ''
    let branch = ''
    try {
      const here = projectOf((await $.fs.stat('.', { resolve: true })).realPath)
      if (here) {
        project = here.name
        branch = await gitBranch($, here.root)
      }
    } catch {
      // hors d'un projet : pas d'en-tête projet · branche
    }
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
    // Le rôle d'orchestrateur est une note cachée laissée au modèle par la commande ; la demande part ensuite
    // comme si l'utilisateur l'avait tapée. Sans /revo-flow, rien de tout cela n'est ajouté.
    $.clock.after(0, () => void $.prompt.submit({ text: args, asUser: true }).catch(() => undefined))
    return {
      text: `revo-flow : ${modelLabel(model)} lit la demande et les specs, puis prépare le plan et l’équipe d’agents…`,
      context: [LEAD_BRIEF],
    }
  })

  on('turn.start', async ($, e, next) => {
    if (await read($, flowA)) await update($, isBusy, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
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
    await update($, leadA, l => ({ ...l, isDoing: false }))
    await syncAgents($)
    // L'orchestrateur a fini son tour après que tous les agents ont fini : c'était sa conclusion.
    await setFlow($, f => ((f.phase === 'review' || f.phase === 'running') && allFinished(f) ? { ...f, phase: 'done' } : f))
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
          await setAgent($, a.key, x => ({ ...x, hasEndedTurn: false, modelId: step.model, tokens: addUsage(x.tokens, u), costUsd: x.costUsd + costUsd(step.model, u) }))
        }
      }
    } catch {
      // le comptage ne doit jamais gêner le tour
    }
    return r
  })

  // Un sous-agent lancé par l'orchestrateur : son modèle, et ses tâches ajoutées à son prompt.
  on('agent.spawn', async ($, e, next) => {
    const flow = await read($, flowA)
    if (!flow || e.fork || e.workflow || e.isTeammate || e.parentAgentId) return next(e)
    // Pas d'agent avant le plan : l'orchestrateur lit les specs lui-même, pose le plan, puis lance l'équipe.
    if (flow.phase === 'planning') {
      return {
        deny: `revo-flow : aucun sous-agent avant le plan. Lis les specs toi-même, appelle ${PLAN_TOOL}, puis lance les agents prévus.`,
      }
    }
    const a = matchAgent(
      flow.agents.filter(x => !claimed.has(x.key)),
      e.description,
      e.name,
    )
    if (!a) return next(e)
    claimed.add(a.key)
    const r = await next({ ...e, model: MODELS[a.model].id, prompt: `${e.prompt}\n\n${agentBrief(a)}` })
    if (r.deny !== undefined || !r.agentId) {
      claimed.delete(a.key)
      return r
    }
    const agentId = r.agentId
    await setAgent($, a.key, x => ({ ...x, agentId, modelId: r.model, status: 'running' }))
    await setFlow($, f => (f.phase === 'dispatch' ? { ...f, phase: 'running' } : f))
    // L'exécution commence : c'est maintenant que le panneau s'ouvre.
    try {
      const now = await read($, flowA)
      if (now && !now.isPaneClosed && !(await isPaneShown($))) await openPane($)
    } catch {
      // le panneau ne doit jamais gêner le lancement
    }
    return r
  })

  // L'orchestrateur pose son plan : les agents, leur modèle, leur effort et leurs tâches.
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
      agents: plan.agents.map(a => ({ ...a, status: 'waiting' as const, tokens: EMPTY, costUsd: 0 })),
    }))
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
    try {
      await setActivity($, who, { doing: label, isDoing: true, filePath: path, reason: path ? '…' : '' })
    } catch {
      // le suivi ne doit jamais gêner l'outil
    }

    const ran = await next(e)
    const failed = ran.deny !== undefined || ran.isError === true
    try {
      const done = failed ? `✗ ${label}` : label
      const prev = who === 'lead' ? await read($, leadA) : (await read($, flowA))?.agents.find(a => a.key === who)
      await setActivity($, who, { isDoing: false, history: [...(prev?.history ?? []), done].slice(-3) })
      if (!failed && path) await markFile($, path, e.tool_use_id, e.agentId)
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
    return next(e)
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
      return DesktopBand($.ui.resolve(e) as unknown as Elements['desktop'], d, Math.round(e.props.bodyColumns * 7.6)) ?? next(e)
    }
    if (e.surface === 'terminal') return TerminalBand($.ui.resolve(e) as unknown as Elements['terminal'], d) ?? next(e)
    return next(e)
  })

  // Le panneau : l'orchestrateur et chaque sous-agent avec sa propre barre, les fichiers, la consommation.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const d = await viewData($)
    const clear = () => update($, entries, () => [])
    if (e.surface === 'desktop' || e.surface === 'vscode') {
      return DesktopPane($.ui.resolve(e) as unknown as Elements['desktop'], d, clear, e.props.bodyColumns)
    }
    if (e.surface === 'terminal') return TerminalPane($.ui.resolve(e) as unknown as Elements['terminal'], d, clear)
    return next(e)
  })
}
