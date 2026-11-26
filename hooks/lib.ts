/** La logique pure du flow : plan, appariement des agents, tâches et progression, consignes, tokens et coûts, journal. */
import type { Critere, Effort, Flow, FlowAgent, FlowTask, ModelKey, Phase, TaskKind, TaskStatus, Tally, VerifJournal } from '../types'
import type { BudgetJournal } from './budget'
import { parseCriteres } from './verif/garde'
import { globMatch, norm } from './verif/scope'

export const PLUGIN = 'revo-flow'
export const PLAN_TOOL = `mcp__${PLUGIN}__plan`
export const STEP_TOOL = `mcp__${PLUGIN}__step`
export const CACHE_TOOL = `mcp__${PLUGIN}__cache`
export const VERIF_TOOL = `mcp__${PLUGIN}__verif`
/** Le type d'agent du vérificateur (lot 2) : lecture seule, enregistré par register.tsx. */
export const VERIFIER_TYPE = `${PLUGIN}:verifier`

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
  /** Les critères d'acceptation (lot 2), 1 à 8 ; absents quand l'orchestrateur n'en donne pas. */
  criteres?: Critere[]
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

type PlanAgent = PlanInput['agents'][number]

/** Les agents tels que les fonctions d'ordre les lisent : le plan (PlanAgent) comme le flow (FlowAgent). */
type Ordered = Pick<FlowAgent, 'key' | 'name' | 'after' | 'subagentType'>

/** Au plus autant de fichiers (ou motifs) déclarés par agent. */
const MAX_FILES = 20

/** Une liste de textes (ou un seul texte) : sans les vides ni les doublons. */
function readList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? (raw as unknown[]) : typeof raw === 'string' ? [raw] : []
  return [...new Set(list.map(str).filter(Boolean))]
}

/** Les fichiers déclarés (« fichiers ») : chemins relatifs à la racine, « dossier/ » vaut « dossier/** ». */
const readFiles = (raw: unknown) => [...new Set(readList(raw).map(f => norm(f)).map(f => (f.endsWith('/') ? `${f}**` : f)))]

/** Les tâches d'un agent : titre et type lus, les titres vides écartés. */
function readTasks(raw: unknown): FlowTask[] {
  return (Array.isArray(raw) ? (raw as unknown[]) : [])
    .map(t => (typeof t === 'string' ? { titre: t } : typeof t === 'object' && t !== null ? (t as Record<string, unknown>) : {}))
    .map(t => ({ title: str(t.titre).slice(0, 70), kind: kindOf(str(t.type)), status: 'pending' as const }))
    .filter(t => t.title.length > 0)
}

/** Lit un agent de l'appel plan : sa fiche et les noms de « apres » (résolus ensuite), ou ce qui ne va pas. */
function readAgent(x: unknown, i: number, used: Set<string>): { agent: PlanAgent; apres: string[] } | { error: string } {
  const a = typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {}
  const name = str(a.nom).slice(0, 40) || `Agent ${i + 1}`
  let key = slug(name) || `agent-${i + 1}`
  if (used.has(key)) key = `${key}-${i + 1}`
  used.add(key)
  const model = str(a.modele).toLowerCase()
  if (!(model in MODELS)) return { error: `Agent « ${name} » : modele doit être haiku, sonnet ou opus.` }
  const effort = str(a.effort).toLowerCase()
  if (!EFFORTS.includes(effort as Effort)) return { error: `Agent « ${name} » : effort doit être low, medium, high ou xhigh.` }
  const tasks = readTasks(a.taches)
  if (tasks.length === 0) return { error: `Agent « ${name} » : donne-lui au moins une tâche (taches).` }
  if (tasks.length > 12) return { error: `Agent « ${name} » : ${tasks.length} tâches, 12 au plus.` }
  const files = readFiles(a.fichiers)
  if (files.length > MAX_FILES) return { error: `Agent « ${name} » : ${files.length} fichiers, ${MAX_FILES} au plus (regroupe-les avec des motifs : hooks/verif/**).` }
  const agent: PlanAgent = {
    key,
    name,
    role: str(a.role).slice(0, 160),
    subagentType: typeOf(str(a.type)),
    model: model as ModelKey,
    effort: effort as Effort,
    why: str(a.pourquoi).slice(0, 160),
    tasks,
    ...(files.length ? { files } : {}),
  }
  return { agent, apres: readList(a.apres) }
}

/** Lit l'appel à l'outil plan. Renvoie le plan, ou ce qui ne va pas, à renvoyer tel quel à l'orchestrateur. */
export function parsePlan(input: Record<string, unknown>): { plan: PlanInput } | { error: string } {
  const title = str(input.titre).slice(0, 70)
  if (!title) return { error: '« titre » manquant : donne un titre court à la feature.' }
  const raw = Array.isArray(input.agents) ? (input.agents as unknown[]) : []
  if (raw.length === 0) return { error: '« agents » vide : prévois au moins un sous-agent.' }
  if (raw.length > 6) return { error: `${raw.length} agents : 6 au plus. Regroupe des tâches.` }
  const agents: PlanInput['agents'] = []
  const apres: string[][] = []
  const used = new Set<string>()
  for (const [i, x] of raw.entries()) {
    const r = readAgent(x, i, used)
    if ('error' in r) return r
    agents.push(r.agent)
    apres.push(r.apres)
  }
  const order = resolveOrder(agents, apres)
  if (order) return { error: order }
  // Les critères d'acceptation : facultatifs ; donnés, ils doivent être valides (1 à 8, vérifiables), sinon le plan est refusé.
  const rawCriteres = input.criteres
  const hasCriteres = rawCriteres !== undefined && rawCriteres !== null && !(Array.isArray(rawCriteres) && rawCriteres.length === 0)
  let criteres: Critere[] | undefined
  if (hasCriteres) {
    const c = parseCriteres(rawCriteres)
    if ('error' in c) return { error: `« criteres » : ${c.error}` }
    criteres = c.criteres
  }
  return { plan: { title, summary: str(input.resume).slice(0, 400), agents, ...(criteres?.length ? { criteres } : {}) } }
}

// ── L'ordre des agents : dépendances, vagues, fichiers déclarés ──────────

/** Les clés des agents qui doivent finir avant celui-ci : ses « apres », et pour le vérificateur tous les autres (implicite). */
export function agentDeps(agents: readonly Ordered[], a: Ordered): string[] {
  const implicit = isVerifier(a) ? agents.filter(b => b.key !== a.key && !isVerifier(b)).map(b => b.key) : []
  return [...new Set([...(a.after ?? []), ...implicit])]
}

/** « « a » », « « a » et « b » », « « a », « b » et « c » ». */
export function joinNames(names: readonly string[]): string {
  const q = names.map(n => `« ${n} »`)
  return q.length < 2 ? q.join('') : `${q.slice(0, -1).join(', ')} et ${q.at(-1)}`
}

/** Les noms des agents cités dans « apres » par `a` (la clé si l'agent n'est plus dans la liste). */
const afterNames = (agents: readonly Ordered[], a: Ordered) => (a.after ?? []).map(k => agents.find(b => b.key === k)?.name ?? k)

/** Résout les « apres » (noms ou clés) en clés dans `agents`, puis refuse un cycle ou un fichier déclaré par deux agents non ordonnés. */
function resolveOrder(agents: PlanAgent[], apres: string[][]): string | undefined {
  for (const [i, a] of agents.entries()) {
    const keys: string[] = []
    for (const ref of apres[i] ?? []) {
      const dep = findAgent(agents, ref)
      if (!dep) return `Agent « ${a.name} » : apres cite « ${ref} », qui n'est pas dans le plan. Noms possibles : ${joinNames(agents.filter(b => b !== a).map(b => b.name))}.`
      if (dep.key === a.key) return `Agent « ${a.name} » : apres le cite lui-même.`
      keys.push(dep.key)
    }
    if (keys.length) a.after = [...new Set(keys)]
  }
  const cycle = findCycle(agents)
  if (cycle) return `apres en cycle : ${cycle.map(k => `« ${agents.find(b => b.key === k)!.name} »`).join(' → ')}. Chaque agent passe après le suivant : retire une dépendance.`
  return sharedFile(agents)
}

/** Un cycle de dépendances, de la clé de départ à elle-même (a → b → a), ou rien. */
function findCycle(agents: readonly Ordered[]): string[] | undefined {
  const state = new Map<string, 'open' | 'closed'>()
  const path: string[] = []
  const visit = (a: Ordered): string[] | undefined => {
    if (state.get(a.key) === 'closed') return undefined
    if (state.get(a.key) === 'open') return [...path.slice(path.indexOf(a.key)), a.key]
    state.set(a.key, 'open')
    path.push(a.key)
    for (const d of agentDeps(agents, a)) {
      const found = visit(agents.find(b => b.key === d)!)
      if (found) return found
    }
    path.pop()
    state.set(a.key, 'closed')
    return undefined
  }
  for (const a of agents) {
    const found = visit(a)
    if (found) return found
  }
  return undefined
}

/** Toutes les clés dont `a` dépend, de proche en proche (sans lui-même). */
function ancestors(agents: readonly Ordered[], a: Ordered): Set<string> {
  const out = new Set<string>()
  const todo = agentDeps(agents, a)
  for (let k = todo.shift(); k !== undefined; k = todo.shift()) {
    if (out.has(k)) continue
    out.add(k)
    const dep = agents.find(b => b.key === k)
    if (dep) todo.push(...agentDeps(agents, dep))
  }
  return out
}

const isGlob = (p: string) => /[*?{]/.test(p)

/** Le dossier d'un motif, avant son premier joker : « hooks/verif/** » → « hooks/verif/ ». */
const globDir = (p: string) => p.slice(0, p.search(/[*?{]/)).replace(/[^/]*$/, '')

/** Le motif descend-il dans les sous-dossiers de son dossier (« ** », ou un « / » après le premier joker) ? « hooks/*.ts » non. */
const isDeep = (p: string) => /\*\*|\//.test(p.slice(globDir(p).length))

/** Deux motifs : un motif à plat n'attrape que son propre dossier, que l'autre doit pouvoir atteindre ; deux profonds, préfixe l'un de l'autre. */
function globsOverlap(a: string, b: string): boolean {
  // Un motif sans « / » (« *.md ») porte sur le nom du fichier, dans n'importe quel dossier (globMatch) : il peut recouvrir tout autre motif.
  if (!a.includes('/') || !b.includes('/')) return true
  const [da, db] = [globDir(a), globDir(b)]
  if (!isDeep(a) && !isDeep(b)) return da === db
  if (!isDeep(a)) return da.startsWith(db)
  if (!isDeep(b)) return db.startsWith(da)
  return da.startsWith(db) || db.startsWith(da)
}

/**
 * Deux déclarations se recouvrent-elles ? Chemins identiques ; un chemin littéral que le motif de l'autre attrape ;
 * deux motifs : par leurs dossiers (prudent : peut refuser à tort, jamais laisser passer), « hooks/*.ts » n'atteignant pas « hooks/verif/ ».
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  if (!isGlob(a)) return isGlob(b) && globMatch(b, a)
  if (!isGlob(b)) return globMatch(a, b)
  return globsOverlap(a, b)
}

/** Le premier fichier déclaré par deux agents qui ne sont pas ordonnés l'un après l'autre : le refus qui le nomme, ou rien. */
function sharedFile(agents: readonly PlanAgent[]): string | undefined {
  for (const [i, a] of agents.entries()) {
    const before = ancestors(agents, a)
    for (const b of agents.slice(i + 1)) {
      if (before.has(b.key) || ancestors(agents, b).has(a.key)) continue
      for (const p of a.files ?? []) {
        const q = (b.files ?? []).find(f => pathsOverlap(p, f))
        if (q !== undefined) return `« ${a.name} » et « ${b.name} » déclarent tous deux ${p === q ? p : `${p} et ${q}`} : ordonne-les avec apres, ou redécoupe.`
      }
    }
  }
  return undefined
}

/** Le niveau de chaque agent : 1 sans dépendance, sinon 1 de plus que sa dépendance la plus tardive. */
function levels(agents: readonly Ordered[]): Map<string, number> {
  const memo = new Map<string, number>()
  const level = (a: Ordered, seen: ReadonlySet<string>): number => {
    const known = memo.get(a.key)
    if (known !== undefined) return known
    if (seen.has(a.key)) return 0 // cycle : refusé par parsePlan, jamais atteint ici
    const next = new Set(seen).add(a.key)
    const deps = agentDeps(agents, a).flatMap(k => agents.find(b => b.key === k) ?? [])
    const n = 1 + Math.max(0, ...deps.map(d => level(d, next)))
    memo.set(a.key, n)
    return n
  }
  for (const a of agents) level(a, new Set())
  return memo
}

/** Les vagues de noms d'agents, dans l'ordre : la première sans dépendance, la dernière avec le vérificateur. */
export function waves(agents: readonly Ordered[]): string[][] {
  const lvl = levels(agents)
  const last = Math.max(0, ...lvl.values())
  return Array.from({ length: last }, (_, i) => agents.filter(a => lvl.get(a.key) === i + 1).map(a => a.name))
}

/** Les agents pas encore lancés (waiting, sans agentId) dont toutes les dépendances ont fini (done). */
export function readyAgents(flow: Pick<Flow, 'agents'>): FlowAgent[] {
  return flow.agents.filter(a => a.status === 'waiting' && !a.agentId && pendingDeps(flow, a).length === 0 && failedDeps(flow, a).length === 0)
}

/** `b`, bloqué, attend-il `a` lui-même ? Alors refuser `a` à cause de `b` ne se dénouerait jamais. */
const waitsOn = (b: FlowAgent, a: FlowAgent) => b.waitingFor?.key === a.key

/**
 * Les dépendances de `a` qui n'ont pas fini et n'ont pas échoué (en attente, en cours, bloquées). Pour le vérificateur, une dépendance
 * bloquée (elle attend un agent qui ne viendra pas la relancer) compte comme finie, comme dans allFinished : sinon il ne partirait jamais.
 * Une dépendance bloquée qui attend `a` lui-même ne le retient pas non plus (attente croisée) : elle est signalée par failedDeps.
 */
function pendingDeps(flow: Pick<Flow, 'agents'>, a: FlowAgent): FlowAgent[] {
  const over = (b: FlowAgent) => b.status === 'done' || b.status === 'failed' || (b.status === 'blocked' && (isVerifier(a) || waitsOn(b, a)))
  return agentDeps(flow.agents, a).flatMap(k => flow.agents.find(b => b.key === k && !over(b)) ?? [])
}

/** Les dépendances de `a` qui ont échoué (failed) ou qui, bloquées, l'attendent lui-même : l'orchestrateur décide de lancer quand même ou de reprendre. */
export function failedDeps(flow: Pick<Flow, 'agents'>, a: FlowAgent): FlowAgent[] {
  const lost = (b: FlowAgent) => b.status === 'failed' || (b.status === 'blocked' && waitsOn(b, a))
  return agentDeps(flow.agents, a).flatMap(k => flow.agents.find(b => b.key === k && lost(b)) ?? [])
}

/**
 * Le refus de lancer `a` tant qu'une dépendance n'a pas fini (en attente, en cours ou bloquée), en la nommant ; rien sinon.
 * Une dépendance échouée (failed) ne refuse pas : le flow n'aurait plus d'issue, l'orchestrateur décide (failedDeps pour l'avertir).
 */
export function launchDenial(flow: Pick<Flow, 'agents'>, a: FlowAgent): string | undefined {
  const wait = pendingDeps(flow, a)
  if (wait.length === 0) return undefined
  const names = joinNames(wait.map(w => w.name))
  const [has, will] = wait.length > 1 ? ["n'ont", 'auront rendu leur'] : ["n'a", 'aura rendu son']
  return `revo-flow : « ${a.name} » passe après ${names}, qui ${has} pas fini. Lance-le quand ${names} ${will} rapport.`
}

/** L'agent du plan déjà lancé (parmi `claimed`, au travail) que cet appel Agent nomme exactement une seconde fois, ou rien. */
export function runningTwin(claimed: readonly FlowAgent[], description: string, name?: string): FlowAgent | undefined {
  const asked = [slug(description), slug(name ?? '')].filter(Boolean)
  return claimed.find(a => a.status === 'running' && asked.includes(a.key))
}

/** Le message à l'orchestrateur quand la fin de `a` rend d'autres agents prêts (tous leurs « apres » ont fini). */
export function readyText(a: Pick<FlowAgent, 'name'>, ready: readonly Pick<FlowAgent, 'name'>[]): string {
  return `revo-flow : « ${a.name} » a fini : lance maintenant ${joinNames(ready.map(r => r.name))} avec l’outil Agent (description = son nom exact).`
}

/** L'avertissement ajouté à la consigne d'un agent lancé alors qu'un agent dont il dépend a échoué ; '' sans échec. */
export function failedDepsNote(failed: readonly Pick<FlowAgent, 'name'>[]): string {
  if (!failed.length) return ''
  const [has, its] = failed.length > 1 ? ['ont échoué ou restent bloqués', 'leur travail'] : ['a échoué ou reste bloqué', 'son travail']
  return `Attention (revo-flow) : ${joinNames(failed.map(f => f.name))}, que tu devais attendre, ${has} : ${its} peut manquer ou être incomplet ; vérifie ce dont tu as besoin avant de t’en servir.`
}

/** Les chemins modifiés par l'agent qui ne correspondent à aucun de ses fichiers déclarés ([] s'il n'en a pas déclaré). */
export function outOfScope(a: Pick<FlowAgent, 'files'>, paths: readonly string[]): string[] {
  const files = a.files ?? []
  if (files.length === 0) return []
  return paths.filter(p => !files.some(f => norm(p) === f || (isGlob(f) && globMatch(f, p))))
}

/** Le type de sous-agent : « verifier » ou « revo-flow:verifier » désignent le vérificateur enregistré par revo-flow. */
function typeOf(raw: string): string {
  if (!raw) return 'general-purpose'
  return /^(revo-flow:)?verifi(er|cateur)$/i.test(raw) ? VERIFIER_TYPE : raw
}

/** Le testeur (lot 2) : un agent dont toutes les tâches sont de type test. Ses fichiers de test sont gelés à sa fin. */
export const isTester = (a: Pick<FlowAgent, 'tasks'>) => a.tasks.length > 0 && a.tasks.every(t => t.kind === 'test')

/** Le vérificateur (lot 2) : un agent du type revo-flow:verifier. */
export const isVerifier = (a: Pick<FlowAgent, 'subagentType'>) => a.subagentType === VERIFIER_TYPE

/** Coût estimé d'un testeur et d'un vérificateur, en dollars (docs/rd-v2/conception.md §12, estimation). */
export const TESTER_USD = [0.3, 0.8] as const
export const VERIFIER_USD = [0.2, 0.5] as const

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
export function findAgent<T extends Pick<FlowAgent, 'key' | 'name'>>(agents: readonly T[], text: string, self?: string): T | undefined {
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

/**
 * Un agent qui avait fini est renvoyé au travail (porte rouge, demande de l'orchestrateur) : une tâche de plus, en cours, au bout de
 * sa liste, pour que sa barre montre le nouveau travail au lieu de rester pleine. Pas de doublon si la même reprise est déjà ouverte.
 */
export function reworkTasks(tasks: readonly FlowTask[], title: string): FlowTask[] {
  const last = tasks.at(-1)
  if (last && last.title === title && last.status !== 'completed') return tasks.map((t, i) => (i === tasks.length - 1 ? { ...t, status: 'in_progress' as const } : t))
  return [...tasks, { title, kind: 'codage', status: 'in_progress' }]
}

/**
 * Le titre de la tâche de reprise : « Corriger la porte (typecheck, eslint) » quand la dernière porte est rouge, sinon la première phrase
 * du message de l'orchestrateur (« Reprise : … »), sinon « Reprise demandée par l'orchestrateur ».
 */
export function reworkTitle(message: string, rouges: readonly string[] = []): string {
  if (rouges.length) return `Corriger la porte (${rouges.join(', ')})`
  const s = firstSentence(typeof message === 'string' ? message : '', 60)
  return s ? `Reprise : ${s}` : 'Reprise demandée par l’orchestrateur'
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
 * désactivée), rien n'y parle du cache ni de son outil ; sans vérification (option verif à off), l'orchestrateur
 * vérifie lui-même comme en v1.5, et rien n'y parle de la porte, des critères ni de l'outil verif. Avec des agents installés
 * (catalogue non vide), l'étape « Équipe » propose leur type ; sans eux, le texte est celui d'avant.
 */
export function leadBrief(withCache: boolean, withVerif = true, withCrap = true, withAgents = false, withArchi = false): string {
  const cache = (s: string) => (withCache ? s : '')
  const archi = withVerif && withArchi
    ? ` Revue d’architecture obligatoire : à la fin de chaque flow, même sans critères, lance un vérificateur (type ${VERIFIER_TYPE}) quand les autres agents ont fini ; il juge l’étape ARCHI (le code de la branche respecte l’architecture du projet : fichiers au bon endroit, conventions, rien de redéfini qui existe déjà) et la porte attend son verdict avant de te laisser conclure. Prévois-le dans le plan.`
    : ''
  const agents = (s: string) => (withAgents ? s : '')
  const verif = (s: string) => (withVerif ? s : '')
  const end = withVerif
    ? `4. Fin : quand tous ont fini, la porte revo-flow vérifie (lint, typage et tests liés${withCrap ? ' et score CRAP des fonctions modifiées' : ''} sur les fichiers du flow, comparés à la base de référence) ; lis son rapport et décide : corrige toi-même, reprends l'agent avec SendMessage ou relance-le. Seules les erreurs nouvelles bloquent ; demande une exception (${VERIF_TOOL} action exception, avec motif) seulement pour une erreur qui ne relève pas de ce flow`
    : `4. Fin : quand tous ont fini, vérifie l'ensemble (tests et lint ciblés) et corrige si besoin`
  return `# revo-flow — tu es l'orchestrateur de cette demande
1. Plan : ${cache(`commence par le cache revo-flow ci-dessous s'il y en a un, une carte, pas la vérité : vérifie dans le code ce que tu affirmes ou changes. S'il connaît la feature, ne lis que les fichiers à modifier et ceux modifiés depuis l'apprentissage. Puis `)}lis toi-même la demande et les specs utiles, seulement le nécessaire, sans rien modifier. Pas de sous-agent avant le plan, sauf un éclaireur Explore (lecture seule, haiku ou sonnet) quand la lecture est large : revo-flow demande l'accord de l'utilisateur. Si un point de la demande change le plan et que ni elle ni le code ne le tranchent, pose 1 à 3 questions à l'utilisateur (AskUserQuestion) avant le plan, sinon prends le défaut raisonnable et dis-le.
2. Équipe : appelle UNE fois l'outil ${PLAN_TOOL} : titre, résumé, et 1 à 6 sous-agents, pas plus que le travail ne le demande. Pour chacun : nom court et unique, rôle, type (general-purpose par défaut, Explore pour de la lecture seule${agents(`, ou le type d'un agent installé du catalogue ci-dessous quand son rôle correspond à ses tâches (code, doc, test, revue) : revo-flow lui laisse alors le modèle et l'effort de sa définition, donne quand même modele et effort pour l'estimation`)}), modèle le plus fiable pour SES tâches (haiku : mécanique et localisé ; sonnet : la plupart des features et correctifs ; opus : transverse, ambigu, délicat, sécurité), effort (low à xhigh), et 2 à 10 tâches courtes à l'infinitif avec leur type. Découpe pour qu'ils avancent en parallèle sans modifier les mêmes fichiers : fichiers (chemins ou motifs relatifs à la racine qu'il modifiera, 20 au plus) et apres (agents à attendre) ; deux agents ne déclarent le même fichier que s'ils sont ordonnés par apres.${verif(`
   Vérification : donne des critères d'acceptation (criteres, 1 à 8, chacun vérifiable par une commande ou un test) quand la demande s'y prête. Un critère que le vérificateur ne peut pas rejouer (banc externe, recette manuelle, service absent) finira « non vérifiable » : qu'une commande, un test nommé ou la preuve web ou mobile le tranche. Avec des critères, à toi de juger s'il faut un testeur (un agent dont toutes les tâches sont de type test, au moins du niveau des implémenteurs : il écrit les tests à partir des critères et des interfaces, revo-flow les gèle à sa fin) et un vérificateur (type ${VERIFIER_TYPE}, sonnet medium, lecture seule : il juge chaque critère avec une preuve exécutée, après les autres ; lance-le avec l’outil Agent comme les autres, même en arrière-plan : sa preuve à l'exécution, web ou mobile, se suit en direct dans le panneau et sur l'appareil ; ne juge jamais les critères toi-même à sa place).${archi} Un gros flow (beaucoup de fichiers, plusieurs agents) mérite aussi une revue (/code-review) avant de conclure.`)}
3. Exécution : lance chaque agent avec l'outil Agent (description = son nom exact), dans un même message quand ils sont indépendants ; prompt = sa mission et le contexte utile (fichiers, conventions, contraintes, ce que font les autres). revo-flow ajoute lui-même son modèle, son effort, sa liste de tâches${cache(` et l'extrait de fiche du cache qui le concerne : ajoute seulement ce qui manque (pièges transverses, décisions)`)} ; ne les recopie pas.
${end}${cache(`. Puis, pour chaque feature touchée, ${CACHE_TOOL} action « apprendre » (feature, titre, alias, resume, flux, entrees, fichiers et rôles, pièges, corrections de ce que le cache disait de faux) ; pour une fiche seulement périmée et toujours juste, action « rafraichir » (feature, fichiers relus)`)}. Conclus par une synthèse courte.
Ne fais pas toi-même les tâches confiées aux sous-agents. Pas de commit, de push ni de MR sans que l'utilisateur le demande : à la fin d'un flow vérifié, revo-flow lui propose lui-même la PR, ne la propose pas toi-même.`
}

/** Le rôle de l'orchestrateur, cache compris (l'option par défaut). */
export const LEAD_BRIEF = leadBrief(true)

/** La réponse de l'outil plan : ce que l'orchestrateur doit lancer maintenant, et ce qui suit quand le plan est ordonné (apres). */
export function dispatchText(plan: PlanInput): string {
  // Le modèle vient d'écrire le plan : les noms suffisent, ses tâches ne lui sont pas répétées.
  const names = plan.agents.map(a => `« ${a.name} » (${a.subagentType}, ${MODELS[a.model].label})`).join(', ')
  const head = `revo-flow : plan « ${plan.title} » enregistré, ${plan.agents.length} sous-agent${plan.agents.length > 1 ? 's' : ''} : ${names}.`
  const tail = `avec l'outil Agent (description = le nom exact entre guillemets). Un agent dont la description ne reprend pas un de ces noms n'est pas suivi.`
  // Dès qu'il y a plus d'une vague (un « apres », ou le vérificateur, qui passe après tous les autres), ne faire lancer que la première.
  if (waves(plan.agents).length < 2) return [head, `Lance-les maintenant ${tail}`].join('\n')
  return [head, `Lance maintenant ${joinNames(waves(plan.agents)[0] ?? [])} ${tail}`, ...followUps(plan.agents)].join('\n')
}

/** Les phrases « Ensuite, quand « porte » et « plan » auront fini : « integration ». » : une par groupe d'agents qui attendent les mêmes. */
function followUps(agents: readonly Ordered[]): string[] {
  const lvl = levels(agents)
  const groups = new Map<string, { deps: string[]; names: string[] }>()
  for (const a of agents.filter(x => (lvl.get(x.key) ?? 1) > 1).sort((x, y) => lvl.get(x.key)! - lvl.get(y.key)!)) {
    const deps = agentDeps(agents, a)
    const waits = agents.filter(b => deps.includes(b.key)).map(b => b.name)
    const group = groups.get(waits.join('|')) ?? { deps: waits, names: [] }
    group.names.push(a.name)
    groups.set(waits.join('|'), group)
  }
  return [...groups.values()].map(g => `Ensuite, quand ${joinNames(g.deps)} ${g.deps.length > 1 ? 'auront' : 'aura'} fini : ${joinNames(g.names)}.`)
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
export function flowRecap(flow: Flow, cache?: string | false, withVerif = true): string {
  const rows = flow.agents.map(a => {
    const left = remainingTasks(a)
    const todo = left.length ? `reste : ${left.map(t => t.title).join(' ; ')}` : 'plus rien à faire'
    const state = a.status === 'blocked' ? `en attente de « ${a.waitingFor?.name ?? '?'} »` : a.status
    const order = a.status === 'waiting' && !a.agentId && a.after?.length ? ` après ${joinNames(afterNames(flow.agents, a))}` : ''
    const files = a.files?.length && a.status !== 'done' ? ` · fichiers : ${a.files.join(', ')}` : ''
    return `- « ${a.name} » (${MODELS[a.model].label}, effort ${a.effort}) [${state}]${order}${files} — ${todo}`
  })
  return [
    leadBrief(cache !== false, withVerif),
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

/**
 * Le texte du dialogue de validation du plan : chaque agent, son modèle, son effort, son nombre de tâches et son type s'il n'est
 * pas general-purpose (un agent installé, Explore) ; puis les critères
 * d'acceptation, le coût estimé du testeur et du vérificateur s'il y en a, et la ligne du budget (v3.6) quand elle est donnée.
 */
export function planQuestion(plan: PlanInput, budget?: string): string {
  const rows = plan.agents.map(a => `• ${a.name} — ${MODELS[a.model].label}, effort ${a.effort}, ${a.tasks.length} tâche${a.tasks.length > 1 ? 's' : ''}${agentMark(a)}${a.after?.length ? `, après ${joinNames(afterNames(plan.agents, a))}` : ''}`)
  const criteres = plan.criteres?.length ? [`Critères d'acceptation (${plan.criteres.length}) :`, ...plan.criteres.map(c => `  ${c.id} ${c.texte}`)] : []
  const cost = verifCost(plan)
  return [
    `Plan « ${plan.title} » : ${plan.agents.length} agent${plan.agents.length > 1 ? 's' : ''}.`,
    ...rows,
    ...criteres,
    ...(cost ? [`Coût estimé : ${cost}`] : []),
    ...(budget ? [budget] : []),
    'Lancer ce plan ?',
  ].join('\n')
}

/** « (testeur) », « (vérificateur) », le type d'un agent qui n'est pas general-purpose (« , savvy-flow:savvy-medium »), ou rien. */
function agentMark(a: PlanInput['agents'][number]): string {
  if (isTester(a)) return ' (testeur)'
  if (isVerifier(a)) return ' (vérificateur)'
  return a.subagentType === 'general-purpose' ? '' : `, ${a.subagentType}`
}

/** « testeur ≈ 0,28 € à 0,74 € · vérificateur ≈ 0,18 € à 0,46 € » pour les agents du plan concernés ; rien sans eux. */
export function verifCost(plan: PlanInput): string | undefined {
  const range = (r: readonly [number, number], n: number) => `${euros(r[0] * n)} à ${euros(r[1] * n)}`
  const testers = plan.agents.filter(isTester).length
  const verifiers = plan.agents.filter(isVerifier).length
  const parts = [
    ...(testers ? [`testeur${testers > 1 ? 's' : ''} ≈ ${range(TESTER_USD, testers)}`] : []),
    ...(verifiers ? [`vérificateur${verifiers > 1 ? 's' : ''} ≈ ${range(VERIFIER_USD, verifiers)}`] : []),
  ]
  return parts.length ? parts.join(' · ') : undefined
}

/** Ce que le fichier plan.md ajoute à l'aperçu : la demande, le projet, l'heure et la ligne du budget (v3.6). */
export type PlanMeta = { request?: string; project?: string; branch?: string; date?: string; budget?: string }

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
    if (meta.budget) out.push(`**Budget** : ${meta.budget}  `)
    out.push('')
  }
  if (plan.summary) out.push(plan.summary, '')
  out.push(`**${plan.agents.length} agent${plan.agents.length > 1 ? 's' : ''} · ${tasks} tâche${tasks > 1 ? 's' : ''}**`, '')
  if (plan.criteres?.length) {
    out.push(`## Critères d'acceptation`, '', ...plan.criteres.map(c => `- **${c.id}** ${c.texte}`), '')
    const cost = verifCost(plan)
    if (cost) out.push(`*Coût estimé : ${cost}*`, '')
  }
  for (const [i, a] of plan.agents.entries()) {
    const order = a.after?.length ? ` · après ${joinNames(afterNames(plan.agents, a))}` : ''
    out.push(`## ${i + 1}. ${a.name}`, '', `${MODELS[a.model].label} · effort ${a.effort} · ${a.subagentType}${order}`, '')
    if (a.files?.length) out.push(`Fichiers : ${a.files.map(f => `\`${f}\``).join(', ')}`, '')
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

/** La règle du scout du score CRAP, ajoutée à la consigne de vérification d'un agent quand l'option « crap » est active. */
const SCOUT =
  ' Règle du scout (score CRAP ≤ 30) : une fonction que tu modifies doit rester simple (complexité ≤ 5) ou être couverte par un test lié ; au-delà, la porte la refuse. Une fonction que tu ne touches pas n\'est pas à toi.'

/**
 * Ajouté au prompt du sous-agent : ses tâches (celles déjà faites lors d'un lancement précédent cochées), comment
 * les signaler et, avec le cache, comment s'en servir. `others` : les noms des autres agents du plan, ceux qu'il
 * peut attendre (statut attente). `verif` : la porte est active, l'agent lance verif sur ses fichiers avant de finir
 * (sauf un agent en lecture seule : Explore ou vérificateur) ; `crap` : avec la règle du scout du score CRAP.
 */
export function agentBrief(a: FlowAgent, cache: AgentCache | boolean = 'fiches', others: readonly string[] = [], verif = true, crap = true): string {
  const mode = cache === true ? 'fiches' : cache
  const done = a.tasks.filter(t => t.status === 'completed').length
  const resume = done > 0 && done < a.tasks.length
  const check =
    verif && a.subagentType !== 'Explore' && !isVerifier(a)
      ? `\nNe lance pas toi-même le lint, le typage ni les tests du projet : revo-flow les lance une seule fois, quand tous les agents ont fini (la porte). Si elle trouve une erreur nouvelle dans tes fichiers, l'orchestrateur te renverra la corriger.${crap ? SCOUT : ''}`
      : ''
  const scope = a.files?.length ? `Ton périmètre : ${a.files.join(', ')} ; un fichier hors de ce périmètre sera signalé dans le rapport.\n` : ''
  return `# Tes tâches (revo-flow) — « ${a.name} »${a.role ? ` : ${a.role}` : ''}
${a.tasks.map((t, i) => `${i + 1}. ${t.title}${t.status === 'completed' ? ' ✓ déjà faite' : ''}`).join('\n')}
${scope}${resume ? `Reprise : les tâches cochées ✓ ont été faites lors d'un lancement précédent ; ne les refais pas, reprends à la première qui ne l'est pas (garde sa numérotation).\n` : ''}${mode ? `\n${AGENT_CACHE[mode]}\n` : ''}
Suivi : fais ces tâches dans l'ordre. Au début de chacune, appelle l'outil ${STEP_TOOL} avec {"tache": <numéro>, "statut": "en_cours"} : cela clôt la précédente, et la dernière est close quand tu finis, donc "fait" est inutile. "attente" avec "attend" = le nom de l'agent du plan dont tu dépends si la tâche ne peut pas avancer tant qu'il n'a pas fini (termine alors ta réponse en disant ce qui manque : revo-flow te relancera quand il aura fini) ; "echec" seulement pour ce que tu ne peux pas faire du tout, en expliquant pourquoi dans ta réponse. N'utilise cet outil pour rien d'autre.${others.length ? `\nLes autres agents du plan (à nommer dans "attend") : ${others.map(n => `« ${n} »`).join(', ')}.` : ''}${check}`
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
  // L'outil mobile de la preuve mobile : « Mobile toucher 540,1660 », « Mobile capture », lisible par l'utilisateur qui regarde l'appareil.
  if (/__mobile$/.test(tool) && typeof input.action === 'string') {
    const xy = [input.x, input.y].every(v => typeof v === 'number' || typeof v === 'string') ? ` ${input.x},${input.y}` : ''
    const arg = typeof input.touche === 'string' ? ` ${input.touche}` : typeof input.texte === 'string' ? ` « ${input.texte} »` : xy
    return `Mobile ${input.action}${arg}`.slice(0, 90)
  }
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
  /** La vérification du flow (v2) ; absente pour un flow d'avant la v2 ou sans porte. */
  verif?: VerifJournal
  /** Le budget (v3.6) : estimé, plafond, réel, plafond atteint, en dollars ; absent sans budget. */
  budget?: BudgetJournal
  /** Pourquoi le flow a été arrêté, quand ce n'est pas l'utilisateur : « budget » (plafond atteint, « Arrêter »). */
  motif?: 'budget'
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

/** Le journal tel que le store le rend : ses entrées lisibles seulement (le budget y estime le coût d'un plan). */
export const journalOf = (raw: unknown): JournalEntry[] => (Array.isArray(raw) ? raw.filter(isEntry) : [])

/** « critères 6/8 · 1 ko » : les critères d'un verdict ; '' sans critères. */
export function criteresMark(c: { total: number; ok: number; ko?: number } | undefined): string {
  if (!c?.total) return ''
  return `critères ${c.ok}/${c.total}${c.ko ? ` · ${c.ko} ko` : ''}`
}

/** La marque de la porte seule : ✓, ✗ panne, ✗ accepté, ✗, ✗ erreur, observé ou —. */
function porteMark(v: VerifJournal): string {
  if (v.etat === 'verifie') return '✓'
  if (v.etat === 'non-verifie') return v.pannes?.length && !v.nouvelles ? '✗ panne' : v.accepte ? '✗ accepté' : '✗'
  if (v.etat === 'erreur') return '✗ erreur'
  if (v.etat === 'observe') return 'observé'
  return '—'
}

/**
 * La colonne « vérif » de l'historique : ✓ vérifié ; ✗ panne (la porte n'a pas pu juger) ; ✗ accepté (fini rouge sur décision de
 * l'utilisateur) ; ✗ (rouge sans décision, sans personne à qui demander) ; ✗ erreur (revo-flow a planté, la porte s'est ouverte) ;
 * observé ; — sans porte. Puis les critères s'il y en a : « ✓ · critères 6/8 · 1 ko ».
 */
export function verifMark(v: VerifJournal | undefined): string {
  if (!v) return '—'
  const mark = porteMark(v)
  const crit = criteresMark(v.criteres)
  return crit && mark !== '—' ? `${mark} · ${crit}` : mark
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
      e.isStopped ? `arrêté${e.motif === 'budget' ? ' (budget)' : ''}` : '',
      failed ? `${failed} en échec` : '',
      relaunched ? `${relaunched} relance${relaunched > 1 ? 's' : ''}` : '',
    ].filter(Boolean)
    return `  ${dayKey(d)} ${p(d.getHours())}:${p(d.getMinutes())}  ${e.title} (${e.project}) · ${fmtDuration(e.durationMs)} · ${euros(entryCost(e))} · ${e.agents.length} agent${e.agents.length > 1 ? 's' : ''}${extra.length ? ` · ${extra.join(', ')}` : ''} · vérif ${verifMark(e.verif)}`
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
