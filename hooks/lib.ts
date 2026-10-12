import type { Effort, Flow, FlowAgent, FlowTask, ModelKey, Phase, TaskKind, TaskStatus, Tally } from '../types'

export const PLUGIN = 'revo-flow'
export const PLAN_TOOL = `mcp__${PLUGIN}__plan`
export const STEP_TOOL = `mcp__${PLUGIN}__step`

// ── Modèles ──────────────────────────────────────────────────────────────

export const MODELS = {
  haiku: { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  sonnet: { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  opus: { id: 'claude-opus-5-5', label: 'Opus 5.5' },
} as const

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh']
export const KINDS: readonly TaskKind[] = ['analyse', 'codage', 'test', 'review', 'doc', 'deploy']

/** « claude-sonnet-5-5 » → « Sonnet 5.5 » ; un identifiant inconnu est rendu tel quel. */
export function modelLabel(id: string): string {
  const m = /(haiku|sonnet|opus|fable)[-_ ]?(\d+)?[-_.](\d+)/i.exec(id)
  if (!m) return id.replace(/^claude-/, '')
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return m[2] ? `${name} ${m[2]}.${m[3]}` : name
}

/** haiku | sonnet | opus d'après un identifiant de modèle, ou rien. */
export function modelKey(id: string): ModelKey | undefined {
  const l = id.toLowerCase()
  return (['haiku', 'sonnet', 'opus'] as const).find(k => l.includes(k))
}

// ── Le plan envoyé par l'orchestrateur ───────────────────────────────────

export type PlanInput = {
  title: string
  summary: string
  agents: Omit<FlowAgent, 'status' | 'tokens' | 'costUsd'>[]
}

/** « Front Panier » → « front-panier » : pour retrouver un agent d'après la description de l'appel Agent. */
export const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Lit l'appel à l'outil plan. Renvoie le plan, ou ce qui ne va pas, à renvoyer tel quel à l'orchestrateur. */
export function parsePlan(input: Record<string, unknown>): { plan: PlanInput } | { error: string } {
  const title = str(input.titre).slice(0, 70)
  if (!title) return { error: '« titre » manquant : donne un titre court à la feature.' }
  const raw = Array.isArray(input.agents) ? (input.agents as unknown[]) : []
  if (raw.length === 0) return { error: '« agents » vide : prévois au moins un sous-agent.' }
  if (raw.length > 6) return { error: `${raw.length} agents : 6 au plus. Regroupe des tâches.` }
  const agents: PlanInput['agents'] = []
  const used = new Set<string>()
  for (const [i, x] of raw.entries()) {
    const a = typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {}
    const name = str(a.nom).slice(0, 40) || `Agent ${i + 1}`
    let key = slug(name) || `agent-${i + 1}`
    if (used.has(key)) key = `${key}-${i + 1}`
    used.add(key)
    const model = str(a.modele).toLowerCase()
    if (!(model in MODELS)) return { error: `Agent « ${name} » : modele doit être haiku, sonnet ou opus.` }
    const effort = str(a.effort).toLowerCase()
    if (!EFFORTS.includes(effort as Effort)) return { error: `Agent « ${name} » : effort doit être low, medium, high ou xhigh.` }
    const tasks: FlowTask[] = (Array.isArray(a.taches) ? (a.taches as unknown[]) : [])
      .map(t => (typeof t === 'string' ? { titre: t } : typeof t === 'object' && t !== null ? (t as Record<string, unknown>) : {}))
      .map(t => ({ title: str(t.titre).slice(0, 70), kind: kindOf(str(t.type)), status: 'pending' as const }))
      .filter(t => t.title.length > 0)
    if (tasks.length === 0) return { error: `Agent « ${name} » : donne-lui au moins une tâche (taches).` }
    if (tasks.length > 12) return { error: `Agent « ${name} » : ${tasks.length} tâches, 12 au plus.` }
    agents.push({
      key,
      name,
      role: str(a.role).slice(0, 160),
      subagentType: str(a.type) || 'general-purpose',
      model: model as ModelKey,
      effort: effort as Effort,
      why: str(a.pourquoi).slice(0, 160),
      tasks,
    })
  }
  return { plan: { title, summary: str(input.resume).slice(0, 400), agents } }
}

function kindOf(raw: string): TaskKind {
  const l = slug(raw)
  if (KINDS.includes(l as TaskKind)) return l as TaskKind
  if (/test/.test(l)) return 'test'
  if (/review|relect|verif/.test(l)) return 'review'
  if (/doc/.test(l)) return 'doc'
  if (/commit|deploy|mr|push/.test(l)) return 'deploy'
  if (/analy|lire|cherch|explor/.test(l)) return 'analyse'
  return 'codage'
}

/** Le sous-agent prévu que lance cet appel Agent : par son nom, sinon le premier pas encore lancé. */
export function matchAgent(agents: readonly FlowAgent[], description: string, name?: string): FlowAgent | undefined {
  const free = agents.filter(a => !a.agentId)
  const d = slug(description)
  const n = slug(name ?? '')
  return (
    free.find(a => a.key === d || a.key === n) ??
    free.find(a => (d && (d.includes(a.key) || a.key.includes(d))) || (n && n.includes(a.key))) ??
    free[0]
  )
}

// ── Les tâches d'un agent ────────────────────────────────────────────────

/**
 * L'agent signale une tâche (numérotée à partir de 1) : « en_cours » la démarre et clôt les précédentes,
 * « fait » la termine, « echec » la marque en échec.
 */
export function applyStep(tasks: readonly FlowTask[], n: number, statut: string): FlowTask[] | undefined {
  const i = Math.round(n) - 1
  if (!Number.isFinite(i) || i < 0 || i >= tasks.length) return undefined
  const s = slug(statut)
  const status: TaskStatus = s === 'fait' || s === 'done' ? 'completed' : s.startsWith('echec') || s === 'failed' ? 'failed' : 'in_progress'
  return tasks.map((t, j) => {
    if (j === i) return { ...t, status }
    if (j < i && status === 'in_progress' && t.status !== 'failed') return { ...t, status: 'completed' as const }
    if (j > i && status === 'in_progress' && t.status === 'in_progress') return { ...t, status: 'pending' as const }
    return t
  })
}

/** Un agent qui tient un TodoWrite de la même longueur que sa liste : on reprend les états, dans l'ordre. */
export function applyTodos(tasks: readonly FlowTask[], todos: unknown): FlowTask[] | undefined {
  if (!Array.isArray(todos) || todos.length !== tasks.length) return undefined
  return tasks.map((t, i) => {
    const s = (todos[i] as { status?: unknown } | undefined)?.status
    return s === 'completed' || s === 'in_progress' || s === 'pending' ? { ...t, status: s } : t
  })
}

/** L'agent a fini : tout est fait ; s'il a échoué, la tâche en cours (ou la première restante) passe en échec. */
export function finishTasks(tasks: readonly FlowTask[], failed: boolean): FlowTask[] {
  if (!failed) return tasks.map(t => (t.status === 'failed' ? t : { ...t, status: 'completed' as const }))
  const at = tasks.findIndex(t => t.status === 'in_progress')
  const i = at >= 0 ? at : tasks.findIndex(t => t.status === 'pending')
  return tasks.map((t, j) => (j === i ? { ...t, status: 'failed' as const } : t))
}

export type SegKind = 'now' | 'reached' | 'todo' | 'failed'
export type Progress = {
  segs: { name: string; kind: SegKind }[]
  /** Le titre de la tâche en cours (ou la dernière faite). */
  label: string
  /** « 3/7 » : la tâche en cours sur le total, total/total à la fin. */
  count: string
  done: number
  percent: number
}

/**
 * La barre d'un agent : un segment par tâche. Tant qu'il travaille sans avoir rien signalé,
 * sa première tâche restante est « en cours ».
 */
export function progress(tasks: readonly FlowTask[], status: FlowAgent['status'] | 'lead', isRunning: boolean): Progress {
  const n = tasks.length
  const done = tasks.filter(t => t.status === 'completed').length
  let now = tasks.findIndex(t => t.status === 'in_progress' || t.status === 'failed')
  if (now < 0 && isRunning) now = tasks.findIndex(t => t.status === 'pending')
  const segs = tasks.map((t, i) => ({
    name: t.title,
    kind: (t.status === 'failed'
      ? 'failed'
      : t.status === 'completed'
        ? 'reached'
        : i === now
          ? isRunning
            ? 'now'
            : 'reached'
          : 'todo') as SegKind,
  }))
  const isFinished = n > 0 && done === n
  const label = now >= 0 ? tasks[now]!.title : isFinished ? tasks[n - 1]!.title : status === 'waiting' ? 'En attente de lancement' : ''
  const position = isFinished ? n : now >= 0 ? now + 1 : done
  const doing = tasks.filter(t => t.status === 'in_progress').length + (now >= 0 && tasks[now]!.status === 'pending' ? 1 : 0)
  return {
    segs,
    label,
    count: n > 0 ? `${position}/${n}` : '',
    done,
    percent: n > 0 ? Math.round(((done + doing * 0.5) / n) * 100) : 0,
  }
}

// ── L'orchestrateur ──────────────────────────────────────────────────────

export const LEAD_STEPS = ['Lire les specs et planifier', 'Répartir les tâches', 'Exécution des agents', 'Vérifier et conclure'] as const

const PHASE_INDEX: Record<Phase, number> = { planning: 0, dispatch: 1, running: 2, review: 3, done: 4 }

/** Les étapes de l'orchestrateur, déduites de la phase du flow. */
export function leadTasks(phase: Phase): FlowTask[] {
  const at = PHASE_INDEX[phase]
  return LEAD_STEPS.map((title, i) => ({
    title,
    kind: i === 0 ? ('analyse' as const) : i === 3 ? ('review' as const) : ('codage' as const),
    status: i < at ? ('completed' as const) : i === at ? ('in_progress' as const) : ('pending' as const),
  }))
}

/** L'avancement global : le plan compte pour 10 %, les tâches des agents pour 85 %, la conclusion pour le reste. */
export function flowPercent(flow: Flow): number {
  if (flow.phase === 'done') return 100
  if (flow.phase === 'planning') return 3
  const all = flow.agents.flatMap(a => a.tasks)
  const done = all.filter(t => t.status === 'completed' || t.status === 'failed').length
  const doing = all.filter(t => t.status === 'in_progress').length
  const part = all.length ? (done + doing * 0.5) / all.length : 0
  return Math.min(99, Math.round(10 + part * 85 + (flow.phase === 'review' ? 3 : 0)))
}

/** Tous les agents prévus ont fini (ou échoué). */
export const allFinished = (flow: Flow) => flow.agents.length > 0 && flow.agents.every(a => a.status === 'done' || a.status === 'failed')

// ── Les consignes ────────────────────────────────────────────────────────

/** Ajoutées, invisibles, à la demande envoyée par /revo-flow : le rôle de l'orchestrateur. */
export const LEAD_BRIEF = `# revo-flow — tu es l'orchestrateur de cette demande
1. Plan : lis toi-même la demande et les specs utiles (fichiers, code existant, tickets cités), seulement le nécessaire, sans rien modifier et sans lancer de sous-agent (revo-flow refuse tout agent avant le plan). Établis le plan.
2. Équipe : appelle UNE fois l'outil ${PLAN_TOOL} avec le titre de la feature, le résumé du plan et les sous-agents nécessaires (1 à 6, pas plus que le travail ne le demande). Pour chacun : un nom court et unique, son rôle, le type d'agent (general-purpose par défaut, Explore pour de la lecture seule), le modèle le plus fiable pour SES tâches (haiku : mécanique et localisé ; sonnet : la plupart des features et correctifs ; opus : transverse, ambigu, délicat, sécurité) avec l'effort adapté (low, medium, high, xhigh), et la liste ordonnée de SES tâches (2 à 10, titres courts à l'infinitif) avec leur type (analyse, codage, test, review, doc, deploy). Découpe pour que les agents avancent en parallèle sans modifier les mêmes fichiers.
3. Exécution : lance ensuite chaque sous-agent avec l'outil Agent : description = son nom exact, prompt = sa mission avec tout le contexte utile (fichiers, conventions, contraintes, ce que les autres font). Lance-les dans un même message quand ils sont indépendants. revo-flow applique son modèle et son effort et lui transmet sa liste de tâches : ne la recopie pas.
4. Fin : quand tous ont fini, vérifie l'ensemble (tests et lint ciblés), corrige si besoin et conclus par une synthèse courte.
Ne fais pas toi-même les tâches confiées aux sous-agents. Pas de commit, de push ni de MR sans que l'utilisateur le demande.`

/** La réponse de l'outil plan : ce que l'orchestrateur doit lancer maintenant. */
export function dispatchText(plan: PlanInput): string {
  const lines = plan.agents.map(
    (a, i) =>
      `${i + 1}. « ${a.name} » (${a.subagentType}) — ${MODELS[a.model].label}, effort ${a.effort} — ${a.tasks.length} tâche${a.tasks.length > 1 ? 's' : ''} : ${a.tasks.map(t => t.title).join(' ; ')}`,
  )
  return [
    `revo-flow : plan « ${plan.title} » enregistré, ${plan.agents.length} sous-agent${plan.agents.length > 1 ? 's' : ''}.`,
    ...lines,
    `Lance-les maintenant avec l'outil Agent (description = le nom exact entre guillemets), dans un même message quand ils sont indépendants. Leur modèle, leur effort et leur liste de tâches sont ajoutés par revo-flow.`,
  ].join('\n')
}

/** Ajouté au prompt du sous-agent : ses tâches et comment les signaler. */
export function agentBrief(a: FlowAgent): string {
  return `# Tes tâches (revo-flow) — « ${a.name} »${a.role ? ` : ${a.role}` : ''}
${a.tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n')}

Suivi : fais ces tâches dans l'ordre. Au début de chacune, appelle l'outil ${STEP_TOOL} avec {"tache": <numéro>, "statut": "en_cours"} ; quand elle est finie, {"tache": <numéro>, "statut": "fait"} (ou "echec" si tu ne peux pas la faire, en expliquant pourquoi dans ta réponse). C'est ce qui fait avancer ta barre de progression ; n'utilise cet outil pour rien d'autre.`
}

// ── Tokens, jour et semaine ──────────────────────────────────────────────

export const EMPTY: Tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export function isTally(v: unknown): v is Tally {
  return typeof v === 'object' && v !== null && typeof (v as Tally).input === 'number'
}

export function addUsage(tally: unknown, u: Usage): Tally {
  const t = isTally(tally) ? tally : EMPTY
  return {
    input: t.input + (u.input_tokens || 0),
    output: t.output + (u.output_tokens || 0),
    cacheRead: t.cacheRead + (u.cache_read_input_tokens || 0),
    cacheWrite: t.cacheWrite + (u.cache_creation_input_tokens || 0),
  }
}

export const total = (t: Tally) => t.input + t.output + t.cacheRead + t.cacheWrite

export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Semaine ISO 8601, ex. 2026-W41. */
export function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const year = t.getUTCFullYear()
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** 1234 → 1,2k ; 1234567 → 1,2 M */
export function fmt(n: number): string {
  const one = (x: number) => x.toFixed(1).replace('.', ',').replace(/,0$/, '')
  if (n >= 1_000_000) return `${one(n / 1_000_000)} M`
  if (n >= 1_000) return `${one(n / 1_000)}k`
  return String(n)
}

export const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'hebdo', spend_limit: 'budget' }

const DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.']

/** « 14:00 » le jour même, sinon « lun. 09:00 ». */
export function resetLabel(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return dayKey(d) === dayKey(new Date(now)) ? hm : `${DAYS[d.getDay()]} ${hm}`
}

/** Barre de progression pour le terminal : ███████░░░░░ */
export function bar(percent: number, width: number): string {
  const full = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(full) + '░'.repeat(width - full)
}

/** Session = fenêtre de 5 h ; semaine = fenêtre de 7 jours ; aujourd'hui = la part du jour rapportée à un septième de la semaine. */
export function usagePercents(
  limits: readonly { kind: string; percentUsed: number }[],
  day: number,
  week: number,
): { session: number | undefined; day: number | undefined; week: number | undefined } {
  const five = limits.find(l => l.kind === 'five_hour')?.percentUsed
  const seven = limits.find(l => l.kind === 'seven_day')?.percentUsed
  const dayShare = week > 0 ? day / week : 0
  return {
    session: five,
    week: seven,
    day: seven === undefined ? undefined : Math.min(100, Math.round(seven * dayShare * 7)),
  }
}

/** Dollars par million de tokens : entrée, sortie, lecture de cache, écriture de cache. Tarifs de l'API au 2026-10-06. */
export const PRICES = {
  haiku: { input: 0.1, output: 0.5, read: 0.01, write: 0.125 },
  sonnet: { input: 2, output: 10, read: 0.2, write: 2.5 },
  opus: { input: 4, output: 20, read: 0.2, write: 5 },
} as const

export const EUR_PER_USD = 0.92

export function costUsd(model: string, u: Usage): number {
  const key = modelKey(model)
  if (!key) return 0
  const p = PRICES[key]
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
  const factor = key === 'haiku' && prompt > 100_000 ? 5 : 1
  return (
    (((u.input_tokens || 0) * p.input +
      (u.output_tokens || 0) * p.output +
      (u.cache_read_input_tokens || 0) * p.read +
      (u.cache_creation_input_tokens || 0) * p.write) *
      factor) /
    1_000_000
  )
}

/** « 0,12 € » */
export function euros(usd: number): string {
  const v = usd * EUR_PER_USD
  return `${(v < 0.01 && v > 0 ? 0.01 : v).toFixed(2).replace('.', ',')} €`
}

// ── Projets et texte ─────────────────────────────────────────────────────

const PROJECT = /^(.*[\\/]Documents[\\/](?:Front|Back)[\\/]([^\\/]+))(?:[\\/](.+))?$/i

export type Project = { root: string; name: string; rel: string }

/** Situe un chemin dans un projet de Documents\Front ou Documents\Back. */
export function projectOf(path: string | undefined): Project | undefined {
  const m = path ? PROJECT.exec(path) : null
  return m ? { root: m[1]!, name: m[2]!, rel: (m[3] ?? '').replace(/\\/g, '/') } : undefined
}

/** Le chemin court d'un fichier : relatif au projet, sinon ses 3 derniers segments. */
export const shortPath = (path: string) => projectOf(path)?.rel || path.replace(/\\/g, '/').split('/').slice(-3).join('/')

/** Première phrase d'un texte, ramenée à une ligne. */
export function firstSentence(text: string, max = 140): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const m = /^(.+?[.!?:])(\s|$)/.exec(flat)
  const s = (m ? m[1]! : flat).replace(/:$/, '')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

const VERBS: Record<string, string> = {
  Read: 'Lit',
  Grep: 'Cherche',
  Glob: 'Liste',
  Bash: 'Lance',
  PowerShell: 'Lance',
  Edit: 'Modifie',
  Write: 'Écrit',
  NotebookEdit: 'Modifie',
  Agent: 'Lance l’agent',
  WebFetch: 'Ouvre',
  WebSearch: 'Recherche',
  Skill: 'Skill',
  TodoWrite: 'Planifie',
}

/** Une phrase courte pour l'action en cours : « Lit components/Basket.vue ». */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const path = s('file_path') || s('notebook_path') || s('path')
  const what =
    (path ? shortPath(path) : '') ||
    s('description') ||
    s('pattern') ||
    s('command').split('\n')[0]! ||
    s('url') ||
    s('query') ||
    s('skill') ||
    ''
  const verb = VERBS[tool] ?? tool.replace(/^mcp__/, '').replace(/__/g, ' ')
  const text = `${verb} ${what}`.trim()
  return text.length > 90 ? `${text.slice(0, 89)}…` : text
}

/** Le titre provisoire d'un flow, d'après la demande : ses premiers mots. */
export function draftTitle(request: string): string {
  const flat = request.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat
}
