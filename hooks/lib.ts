/** La logique pure du flow : plan, appariement des agents, tâches et progression, consignes, tokens et coûts, journal. */
import type { Effort, Flow, FlowAgent, FlowTask, ModelKey, Phase, TaskKind, TaskStatus, Tally } from '../types'

export const PLUGIN = 'revo-flow'
export const PLAN_TOOL = `mcp__${PLUGIN}__plan`
export const STEP_TOOL = `mcp__${PLUGIN}__step`
export const CACHE_TOOL = `mcp__${PLUGIN}__cache`

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

/**
 * Le sous-agent prévu que lance cet appel Agent, d'après son nom (description ou name), ou rien.
 * Pas de repli sur « le premier libre » : un Agent hors plan ne doit pas prendre la carte d'un agent prévu.
 */
export function matchAgent(agents: readonly FlowAgent[], description: string, name?: string): FlowAgent | undefined {
  const free = agents.filter(a => !a.agentId)
  const d = slug(description)
  const n = slug(name ?? '')
  return (
    free.find(a => a.key === d || a.key === n) ??
    free.find(a => (d && (hasWords(d, a.key) || (d.length >= 4 && hasWords(a.key, d)))) || (n && hasWords(n, a.key)))
  )
}

/** `part` est une suite de mots entiers de `whole` (deux slugs) : « api » est dans « api-promo », pas dans « revue-rapide ». */
const hasWords = (whole: string, part: string) => `-${whole}-`.includes(`-${part}-`)

/**
 * L'agent du plan que nomme `text` (sa clé ou son nom ; guillemets, accents et casse ignorés), hors `self`, ou rien.
 * Sert à l'outil step quand un agent dit qui il attend.
 */
export function findAgent(agents: readonly FlowAgent[], text: string, self?: string): FlowAgent | undefined {
  const s = slug(text)
  if (!s) return undefined
  const others = agents.filter(a => a.key !== self)
  return (
    others.find(a => a.key === s || slug(a.name) === s) ??
    others.find(a => hasWords(s, a.key) || (s.length >= 3 && hasWords(a.key, s)))
  )
}

// ── Les tâches d'un agent ────────────────────────────────────────────────

/**
 * L'agent signale une tâche (numérotée à partir de 1) : « en_cours » la démarre et clôt les précédentes,
 * « fait » la termine, « echec » la marque en échec. « attente » vaut « en_cours » pour la tâche : l'attente
 * est portée par l'agent (waitingFor), pas par la tâche.
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

/** L'agent s'arrête pour attendre un autre agent : sa tâche en cours repart en attente de lancement (pending). */
export function pauseTasks(tasks: readonly FlowTask[]): FlowTask[] {
  return tasks.map(t => (t.status === 'in_progress' ? { ...t, status: 'pending' as const } : t))
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

/**
 * Tous les agents prévus ont fini, échoué, ou attendent un autre agent qui ne viendra pas les relancer
 * (blocked compte comme fini : sinon un flow dont l'agent attendu a échoué ne se terminerait jamais).
 */
export const allFinished = (flow: Flow) =>
  flow.agents.length > 0 && flow.agents.every(a => a.status === 'done' || a.status === 'failed' || a.status === 'blocked')

// ── Les consignes ────────────────────────────────────────────────────────

/**
 * Ajoutées, invisibles, à la demande envoyée par /revo-flow : le rôle de l'orchestrateur. Sans cache (option
 * désactivée), rien n'y parle du cache ni de son outil.
 */
export function leadBrief(withCache: boolean): string {
  const cache = (s: string) => (withCache ? s : '')
  return `# revo-flow — tu es l'orchestrateur de cette demande
1. Plan : ${cache(`commence par le cache revo-flow ci-dessous s'il y en a un, une carte, pas la vérité : vérifie dans le code ce que tu affirmes ou changes. S'il connaît la feature, ne lis que les fichiers à modifier et ceux modifiés depuis l'apprentissage. Puis `)}lis toi-même la demande et les specs utiles, seulement le nécessaire, sans rien modifier. Pas de sous-agent avant le plan, sauf un éclaireur Explore (lecture seule, haiku ou sonnet) quand la lecture est large : revo-flow demande l'accord de l'utilisateur.
2. Équipe : appelle UNE fois l'outil ${PLAN_TOOL} : titre, résumé, et 1 à 6 sous-agents, pas plus que le travail ne le demande. Pour chacun : nom court et unique, rôle, type (general-purpose par défaut, Explore pour de la lecture seule), modèle le plus fiable pour SES tâches (haiku : mécanique et localisé ; sonnet : la plupart des features et correctifs ; opus : transverse, ambigu, délicat, sécurité), effort (low à xhigh), et 2 à 10 tâches courtes à l'infinitif avec leur type. Découpe pour qu'ils avancent en parallèle sans modifier les mêmes fichiers.
3. Exécution : lance chaque agent avec l'outil Agent (description = son nom exact), dans un même message quand ils sont indépendants ; prompt = sa mission et le contexte utile (fichiers, conventions, contraintes, ce que font les autres). revo-flow ajoute lui-même son modèle, son effort, sa liste de tâches${cache(` et l'extrait de fiche du cache qui le concerne : ajoute seulement ce qui manque (pièges transverses, décisions)`)} ; ne les recopie pas.
4. Fin : quand tous ont fini, vérifie l'ensemble (tests et lint ciblés) et corrige si besoin${cache(`. Puis, pour chaque feature touchée, ${CACHE_TOOL} action « apprendre » (feature, titre, alias, resume, flux, entrees, fichiers et rôles, pièges, corrections de ce que le cache disait de faux) ; pour une fiche seulement périmée et toujours juste, action « rafraichir » (feature, fichiers relus)`)}. Conclus par une synthèse courte.
Ne fais pas toi-même les tâches confiées aux sous-agents. Pas de commit, de push ni de MR sans que l'utilisateur le demande.`
}

/** Le rôle de l'orchestrateur, cache compris (l'option par défaut). */
export const LEAD_BRIEF = leadBrief(true)

/** La réponse de l'outil plan : ce que l'orchestrateur doit lancer maintenant. */
export function dispatchText(plan: PlanInput): string {
  // Le modèle vient d'écrire le plan : les noms suffisent, ses tâches ne lui sont pas répétées.
  const names = plan.agents.map(a => `« ${a.name} » (${a.subagentType}, ${MODELS[a.model].label})`).join(', ')
  return [
    `revo-flow : plan « ${plan.title} » enregistré, ${plan.agents.length} sous-agent${plan.agents.length > 1 ? 's' : ''} : ${names}.`,
    `Lance-les maintenant avec l'outil Agent (description = le nom exact entre guillemets). Un agent dont la description ne reprend pas un de ces noms n'est pas suivi.`,
  ].join('\n')
}

const PHASE_LABEL: Record<Phase, string> = {
  planning: 'planification',
  dispatch: 'plan posé, agents à lancer',
  running: 'agents au travail',
  review: 'vérification finale',
  done: 'terminé',
}

/** Les tâches qui restent à un agent (ni faites, ni en échec). */
export const remainingTasks = (a: FlowAgent) => a.tasks.filter(t => t.status === 'pending' || t.status === 'in_progress')

/**
 * Réinjecté après une compaction : la compaction résume la conversation et peut perdre le rôle d'orchestrateur
 * et l'état du flow ; on les redonne tels quels au modèle. `cache` : la ligne du cache (fiche servie, features
 * connues), ou false quand le cache est désactivé.
 */
export function flowRecap(flow: Flow, cache?: string | false): string {
  const rows = flow.agents.map(a => {
    const left = remainingTasks(a)
    const todo = left.length ? `reste : ${left.map(t => t.title).join(' ; ')}` : 'plus rien à faire'
    const state = a.status === 'blocked' ? `en attente de « ${a.waitingFor?.name ?? '?'} »` : a.status
    return `- « ${a.name} » (${MODELS[a.model].label}, effort ${a.effort}) [${state}] — ${todo}`
  })
  return [
    cache === false ? leadBrief(false) : LEAD_BRIEF,
    '',
    `# État du flow revo-flow (rappel après compaction)`,
    `Feature : « ${flow.title} » — phase : ${PHASE_LABEL[flow.phase]}.`,
    // Les étapes 1 et 2 du rôle sont passées : sans ce rappel, le modèle pourrait reposer un plan (refusé).
    ...(flow.agents.some(a => a.agentId || a.status !== 'waiting')
      ? [`Le plan est posé et lancé : n'appelle plus l'outil ${PLAN_TOOL} ; ne relance qu'un agent prévu (description = son nom exact).`]
      : []),
    ...(flow.summary ? [`Plan : ${flow.summary}`] : []),
    ...(rows.length ? ['Agents :', ...rows] : ['Aucun agent prévu pour l’instant : le plan reste à poser.']),
    ...(cache ? [cache] : []),
  ].join('\n')
}

/** Le texte du dialogue de validation du plan : chaque agent, son modèle, son effort et son nombre de tâches. */
export function planQuestion(plan: PlanInput): string {
  const rows = plan.agents.map(
    a => `• ${a.name} — ${MODELS[a.model].label}, effort ${a.effort}, ${a.tasks.length} tâche${a.tasks.length > 1 ? 's' : ''}`,
  )
  return [`Plan « ${plan.title} » : ${plan.agents.length} agent${plan.agents.length > 1 ? 's' : ''}.`, ...rows, 'Lancer ce plan ?'].join('\n')
}

/** Ce que le fichier plan.md ajoute à l'aperçu : la demande, le projet et l'heure. */
export type PlanMeta = { request?: string; project?: string; branch?: string; date?: string }

/**
 * Le plan en markdown : l'aperçu du dialogue de validation (sans meta) et le fichier plan.md (avec).
 * Pas de tableau : l'aperçu du terminal est une colonne étroite, en police fixe.
 */
export function planMarkdown(plan: PlanInput, meta?: PlanMeta): string {
  const tasks = plan.agents.reduce((n, a) => n + a.tasks.length, 0)
  const out = [`# ${plan.title}`, '']
  if (meta) {
    const where = [meta.project, meta.branch].filter(Boolean).join(' · ')
    if (meta.request) out.push(`**Demande** : ${meta.request}  `)
    if (where) out.push(`**Projet** : ${where}  `)
    if (meta.date) out.push(`**Posé le** : ${meta.date}  `)
    out.push('')
  }
  if (plan.summary) out.push(plan.summary, '')
  out.push(`**${plan.agents.length} agent${plan.agents.length > 1 ? 's' : ''} · ${tasks} tâche${tasks > 1 ? 's' : ''}**`, '')
  for (const [i, a] of plan.agents.entries()) {
    out.push(`## ${i + 1}. ${a.name}`, '', `${MODELS[a.model].label} · effort ${a.effort} · ${a.subagentType}`, '')
    if (a.role) out.push(`*${a.role}*`, '')
    if (a.why) out.push(`> ${a.why}`, '')
    out.push(...a.tasks.map((t, j) => `${j + 1}. ${t.title} \`${t.kind}\``), '')
  }
  return out.join('\n').trimEnd() + '\n'
}

/**
 * Le paragraphe du cache dans les consignes d'un sous-agent : `fiches` quand le projet a des fiches de features,
 * `graphe` quand il n'a que le graphe des fichiers (chercher une fiche serait un appel perdu), false sans cache.
 */
export type AgentCache = 'fiches' | 'graphe' | false

const AGENT_CACHE: Record<'fiches' | 'graphe', string> = {
  fiches: `Cache revo-flow (outil ${CACHE_TOOL}) : avant d'explorer, action chercher avec les mots-clés de tes tâches, puis feature si une fiche ressort ; voisins avant un grep « qui utilise X ».
Une fiche ou un extrait marqué ⚠ liste les fichiers modifiés depuis l'apprentissage : action diff pour voir ce qui a changé, relis ce qu'il faut, puis rafraichir (feature, fichiers relus) si la fiche reste juste, ou apprendre avec corrections si elle est fausse.
Le cache est une carte, pas la vérité : vérifie dans le code ce que tu modifies.`,
  graphe: `Cache revo-flow (outil ${CACHE_TOOL}) : pas encore de fiche de feature pour ce projet ; action voisins (chemin) avant un grep « qui utilise X ».`,
}

/**
 * Ajouté au prompt du sous-agent : ses tâches (celles déjà faites lors d'un lancement précédent cochées), comment
 * les signaler et, avec le cache, comment s'en servir. `others` : les noms des autres agents du plan, ceux qu'il
 * peut attendre (statut attente).
 */
export function agentBrief(a: FlowAgent, cache: AgentCache | boolean = 'fiches', others: readonly string[] = []): string {
  const mode = cache === true ? 'fiches' : cache
  const done = a.tasks.filter(t => t.status === 'completed').length
  const resume = done > 0 && done < a.tasks.length
  return `# Tes tâches (revo-flow) — « ${a.name} »${a.role ? ` : ${a.role}` : ''}
${a.tasks.map((t, i) => `${i + 1}. ${t.title}${t.status === 'completed' ? ' ✓ déjà faite' : ''}`).join('\n')}
${resume ? `Reprise : les tâches cochées ✓ ont été faites lors d'un lancement précédent ; ne les refais pas, reprends à la première qui ne l'est pas (garde sa numérotation).\n` : ''}${mode ? `\n${AGENT_CACHE[mode]}\n` : ''}
Suivi : fais ces tâches dans l'ordre. Au début de chacune, appelle l'outil ${STEP_TOOL} avec {"tache": <numéro>, "statut": "en_cours"} : cela clôt la précédente, et la dernière est close quand tu finis, donc "fait" est inutile. "attente" avec "attend" = le nom de l'agent du plan dont tu dépends si la tâche ne peut pas avancer tant qu'il n'a pas fini (termine alors ta réponse en disant ce qui manque : revo-flow te relancera quand il aura fini) ; "echec" seulement pour ce que tu ne peux pas faire du tout, en expliquant pourquoi dans ta réponse. N'utilise cet outil pour rien d'autre.${others.length ? `\nLes autres agents du plan (à nommer dans "attend") : ${others.map(n => `« ${n} »`).join(', ')}.` : ''}`
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

/** 45 000 → « 45 s » ; 192 000 → « 3 m 12 » ; 3 840 000 → « 1 h 04 ». */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} m ${two(s % 60)}`
  return `${Math.floor(s / 3600)} h ${two(Math.floor((s % 3600) / 60))}`
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

/**
 * Le fichier lu par une commande Bash de lecture d'un seul fichier (cat, sed -n, head, tail) ; rien pour toute autre
 * commande (tube, enchaînement, redirection, substitution, plusieurs fichiers, glob) : sa sortie n'est pas attribuable à un fichier.
 */
export function bashReadFile(command: string): string | undefined {
  const c = command.trim()
  if (!c || /[|;&<>`$\n*?]/.test(c)) return undefined
  const words = [...c.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')
  const cmd = words[0]
  const args = words.slice(1)
  if (cmd !== 'cat' && cmd !== 'sed' && cmd !== 'head' && cmd !== 'tail') return undefined
  const files: string[] = []
  let silent = false
  let script = cmd !== 'sed'
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') continue
    if (a.startsWith('-') && a.length > 1) {
      if (cmd === 'sed') {
        if (a !== '-n') return undefined
        silent = true
      } else if ((a === '-n' || a === '-c') && cmd !== 'cat') i++
      else if (cmd === 'cat' ? !/^-[nbsAEvT]+$/.test(a) : !/^(-\d+|-[qv]|-[nc]\d+)$/.test(a)) return undefined
      continue
    }
    if (!script) script = true
    else files.push(a)
  }
  if (cmd === 'sed' && !silent) return undefined
  return script && files.length === 1 ? files[0] : undefined
}

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

// ── Journal des flows ────────────────────────────────────────────────────

/** Un flow fini, tel que /revo-flow historique le relit : de quoi choisir les modèles sur des chiffres réels. */
export type JournalEntry = {
  id: string
  title: string
  project: string
  branch: string
  startedAt: number
  durationMs: number
  isStopped: boolean
  files: number
  lead: { modelId: string; costUsd: number; tokens: number }
  agents: {
    name: string
    model: ModelKey
    effort: Effort
    status: FlowAgent['status']
    costUsd: number
    tokens: number
    attempts: number
    durationMs: number
  }[]
}

/** Au plus autant de flows gardés dans le journal. */
export const JOURNAL_MAX = 100

const isEntry = (v: unknown): v is JournalEntry =>
  typeof v === 'object' && v !== null && typeof (v as JournalEntry).id === 'string' && Array.isArray((v as JournalEntry).agents)

/** Le journal avec ce flow en tête (un flow déjà présent est remplacé), plafonné à JOURNAL_MAX. */
export function addToJournal(prev: unknown, entry: JournalEntry): JournalEntry[] {
  const list = Array.isArray(prev) ? prev.filter(isEntry).filter(e => e.id !== entry.id) : []
  return [entry, ...list].slice(0, JOURNAL_MAX)
}

/** Le coût d'un flow : l'orchestrateur et ses agents. */
const entryCost = (e: JournalEntry) => e.lead.costUsd + e.agents.reduce((n, a) => n + a.costUsd, 0)

/**
 * /revo-flow historique : les `n` derniers flows (date, titre, durée, coût, agents), puis par modèle le coût moyen
 * d'un agent, son taux d'échec et ses relances, sur tout le journal.
 */
export function historyText(raw: unknown, n = 10): string {
  const all = Array.isArray(raw) ? raw.filter(isEntry) : []
  if (!all.length) return 'revo-flow : aucun flow dans l’historique pour l’instant (il se remplit à la fin de chaque flow).'
  const rows = all.slice(0, n).map(e => {
    const d = new Date(e.startedAt)
    const p = (x: number) => String(x).padStart(2, '0')
    const failed = e.agents.filter(a => a.status === 'failed').length
    const relaunched = e.agents.reduce((k, a) => k + Math.max(0, a.attempts - 1), 0)
    const extra = [
      e.isStopped ? 'arrêté' : '',
      failed ? `${failed} en échec` : '',
      relaunched ? `${relaunched} relance${relaunched > 1 ? 's' : ''}` : '',
    ].filter(Boolean)
    return `  ${dayKey(d)} ${p(d.getHours())}:${p(d.getMinutes())}  ${e.title} (${e.project}) · ${fmtDuration(e.durationMs)} · ${euros(entryCost(e))} · ${e.agents.length} agent${e.agents.length > 1 ? 's' : ''}${extra.length ? ` · ${extra.join(', ')}` : ''}`
  })
  const byModel = new Map<string, { n: number; cost: number; failed: number; relaunch: number }>()
  for (const a of all.flatMap(e => e.agents)) {
    const m = byModel.get(a.model) ?? { n: 0, cost: 0, failed: 0, relaunch: 0 }
    m.n++
    m.cost += a.costUsd
    if (a.status === 'failed') m.failed++
    m.relaunch += Math.max(0, a.attempts - 1)
    byModel.set(a.model, m)
  }
  const models = [...byModel.entries()].map(
    ([k, m]) =>
      `  ${MODELS[k as ModelKey]?.label ?? k} : ${m.n} agent${m.n > 1 ? 's' : ''}, ${euros(m.cost / m.n)} en moyenne, ${Math.round((m.failed / m.n) * 100)} % d’échecs, ${m.relaunch} relance${m.relaunch > 1 ? 's' : ''}`,
  )
  const cost = all.reduce((k, e) => k + entryCost(e), 0)
  return [
    `revo-flow · historique : ${all.length} flow${all.length > 1 ? 's' : ''}, ${euros(cost)} au total (${euros(cost / all.length)} par flow)`,
    ...rows,
    ...(all.length > n ? [`  … et ${all.length - n} plus anciens (/revo-flow historique ${Math.min(all.length, JOURNAL_MAX)})`] : []),
    'Par modèle (agents) :',
    ...models,
  ].join('\n')
}
