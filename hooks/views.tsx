import type { Elements } from 'claude-code'

import type { CacheStats } from '../types/cache'
import type { Context, Entry, Flow, FlowAgent, FlowTask, Lead, LastTurn, Limit, Tally, Tokens } from '../types'
import {
  AGENT_COLORS,
  PALETTE,
  agentHeadSvg,
  barSvg,
  cacheBandSvg,
  cacheNodeRowSvg,
  cacheSummarySvg,
  emptySvg,
  fileRowSvg,
  headerSvg,
  planBarSvg,
  ruleSvg,
  sectionSvg,
  statusPillSvg,
  usageRowSvg,
  usageSvg,
  type BarStage,
  type MascotKind,
} from './art'
import {
  LIMIT_LABEL,
  MODELS,
  allFinished,
  bar,
  euros,
  flowPercent,
  fmt,
  fmtDuration,
  leadTasks,
  modelKey,
  modelLabel,
  progress,
  resetLabel,
  total,
  usagePercents,
  type Progress,
} from './lib'

/** Tout ce que les vues ont besoin de savoir : de la donnée simple, aucun appel à `$`. */
export type ViewData = {
  flow: Flow | null
  lead: Lead
  busy: boolean
  entries: Entry[]
  tokens: Tokens | null
  session: Tally
  limits: Limit[]
  now: number
  lastTurn: LastTurn | null
  context: Context | null
  sessionCostUsd: number
  /** Le cache du projet (graphe de nœuds) ; null tant qu'il n'y en a pas. */
  cache: CacheStats | null
  /** La section Cache du panneau est dépliée. */
  cacheOpen: boolean
}

/** Ce que les boutons du panneau déclenchent : branchés par register.tsx. */
export type PaneActions = {
  clear(): unknown
  stopAll(): unknown
  stopAgent(key: string): unknown
  retryAgent(key: string): unknown
  approvePlan(): unknown
  cancelPlan(): unknown
  toggleCache(): unknown
}

const MODEL_COLOR = { haiku: PALETTE.haiku, sonnet: PALETTE.sonnet, opus: PALETTE.opus } as const
const colorOf = (modelId: string) => {
  const k = modelKey(modelId)
  return k ? MODEL_COLOR[k] : PALETTE.muted
}
const mascotOf = (modelId: string): MascotKind => modelKey(modelId) ?? 'none'
const shortModel = (modelId: string) => modelLabel(modelId).split(' ')[0] || modelLabel(modelId)

/** Une colonne d'interface vaut environ 7,6 pixels sur le bureau. */
export const pixels = (columns: number) => Math.round(columns * 7.6)

// ── Les cartes : l'orchestrateur puis un sous-agent par carte ────────────

type Tone = 'live' | 'wait' | 'done' | 'fail'
type Line = { icon: string; text: string; tone: 'now' | 'done' | 'next' | 'fail' | 'detail' }

export type Card = {
  id: string
  name: string
  modelId: string
  /** « Sonnet · high » : le modèle et l'effort choisis pour l'agent. */
  pill: string
  tone: Tone
  status: string
  /** La couleur de sa barre : une par agent, dans l'ordre du plan. */
  color: string
  /** Ce qu'il fait en ce moment, quand un outil tourne. */
  doing?: string
  prog: Progress
  usage: string
  lines: Line[]
  /** « 3 m 12 » : depuis son lancement, ou sa durée totale une fois fini. */
  duration?: string
  /** « inactif depuis 1 m 30 » : un agent actif qui ne fait plus rien depuis plus de 90 s. */
  idle?: string
  isLead: boolean
  /** Le bouton « Relancer » : un agent en échec, ou qui attend un autre agent. */
  canRetry?: boolean
}

const IDLE_AFTER_MS = 90_000
const PLAN_PENDING = 'Plan à valider'
const isPendingPlan = (d: ViewData) => d.flow?.phase === 'dispatch' && !d.flow.isApproved
/** Le nom court de qui a touché un fichier : « orchestrateur » ou le nom de l'agent. */
const whoName = (d: ViewData, key: string) => (key === 'lead' ? 'orchestrateur' : (d.flow?.agents.find(a => a.key === key)?.name ?? key))
const ctxColor = (percent: number) => (percent >= 85 ? PALETTE.red : percent >= 70 ? PALETTE.orange : PALETTE.silver)
const cacheOf = (t: Tally) => t.cacheRead + t.cacheWrite
const turnCost = (t: LastTurn) => (t.costUsd === 0 && !modelKey(t.modelId) ? '—' : euros(t.costUsd))
/** « 3,2k ↑ · 850 ↓ · 41k cache · 0,04 € » */
const promptText = (t: LastTurn) => `${fmt(t.tokens.input)} ↑ · ${fmt(t.tokens.output)} ↓ · ${fmt(cacheOf(t.tokens))} cache API · ${turnCost(t)}`
const planCount = (a: FlowAgent) => `${a.tasks.length} tâche${a.tasks.length > 1 ? 's' : ''}`
const planModel = (a: FlowAgent) => `${modelLabel(a.modelId || MODELS[a.model].id)} · ${a.effort}`

// ── Le cache du projet : le texte et les chiffres partagés ───────────────

const TYPE_LABEL: Record<string, string> = { page: 'Pages', composant: 'Composants', composable: 'Composables', store: 'Stores', service: 'Services', feature: 'Features' }
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`
const cacheNodes = (c: CacheStats) => Math.max(c.noeuds.length, c.fichiers + c.features)
const cacheHits = (c: CacheStats) => c.noeuds.filter(n => n.hit).length
const cacheKnown = (c: CacheStats) => c.noeuds.length > 0 || c.fichiers > 0 || c.features > 0 || c.build !== undefined
/** La part des tokens lus qui ont été évités : évités / (évités + injectés). */
const cacheShare = (c: CacheStats) => (c.flow.evites + c.flow.injecte > 0 ? (c.flow.evites / (c.flow.evites + c.flow.injecte)) * 100 : 0)
/** La couleur de l'agent qui a reçu un nœud : « lead » en blanc, sinon la couleur de sa carte (ou de son modèle en terminal). */
function hitColor(d: ViewData, key: string | undefined, byModel = false): string | undefined {
  if (!key) return undefined
  if (key === 'lead') return PALETTE.text
  const i = d.flow?.agents.findIndex(a => a.key === key) ?? -1
  if (i < 0) return PALETTE.silver
  const a = d.flow!.agents[i]!
  return byModel ? colorOf(a.modelId || MODELS[a.model].id) : AGENT_COLORS[i % AGENT_COLORS.length]!
}
const nodeState = (n: CacheStats['noeuds'][number]) => (n.niveau === 'perimee' ? 'périmé' : n.niveau === 'partielle' ? 'partiel' : 'frais')
/** Les nœuds à montrer : ceux qui ont servi d'abord, puis les périmés, puis le reste. */
const shownNodes = (c: CacheStats, max: number) => {
  const rank = (n: CacheStats['noeuds'][number]) => (n.hit ? 0 : n.niveau !== 'fraiche' ? 1 : 2)
  return [...c.noeuds].sort((a, b) => rank(a) - rank(b)).slice(0, max)
}
const typeCounts = (c: CacheStats) =>
  Object.entries(c.parType)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${TYPE_LABEL[k] ?? k} ${n}`)
    .join(' · ')

/** Les morceaux de la ligne de cache : le texte, les tokens évités (pour les colorer) et le nombre de périmés. */
function cacheParts(d: ViewData, columns = 100): { text: string; saved?: string; stale: number } | undefined {
  const c = d.cache
  if (!c || !cacheKnown(c)) return undefined
  const stale = c.perimees
  if (c.build && c.flow.evites <= 0) return { text: `cache : construction « ${c.build.feature} » · ${fmt(c.build.tokens)} tokens`, stale }
  const n = cacheNodes(c)
  const used = cacheHits(c)
  if (columns < 70) {
    const saved = `≈${fmt(c.flow.evites)}`
    return { text: `cache : ${n} · ${used} ✓ · ${saved}`, saved, stale }
  }
  const saved = `≈ ${fmt(c.flow.evites)} tokens évités`
  return { text: `cache : ${plural(n, 'nœud')} · ${plural(used, 'utilisé')} · ${saved}`, saved, stale }
}

/** `cache : 12 nœuds · 3 utilisés · ≈ 18k tokens évités` (+ ` · ⚠ 1 périmé`) ; undefined sans cache. */
export function cacheLine(d: ViewData, columns = 100): string | undefined {
  const p = cacheParts(d, columns)
  return p ? `${p.text}${p.stale > 0 ? ` · ⚠ ${p.stale} périmé${p.stale > 1 ? 's' : ''}` : ''}` : undefined
}

/** Les lignes « ↳ cache : … » d'une carte : ce que le cache a donné à cet agent (« lead » pour l'orchestrateur). */
function cacheDetail(d: ViewData, key: string): Line[] {
  const mine = d.cache?.noeuds.filter(n => n.hit === key) ?? []
  if (!mine.length) return []
  const title = mine.find(n => n.k === 'feature')?.titre ?? d.cache?.flow.feature ?? mine[0]!.titre
  const saved = mine.reduce((s, n) => s + n.tok, 0)
  return [{ icon: ' ', text: `↳ cache : ${title} (≈ ${fmt(saved)} évités)`, tone: 'detail' }]
}

const STATUS: Record<Tone, string> = { live: 'Actif', wait: 'En attente', done: 'Terminé', fail: 'Échec' }

/** `waiting` : le nom de l'agent attendu, pour un agent en attente (sa tâche suspendue, puis « attend « Y » »). */
function lines(
  tasks: readonly FlowTask[],
  p: Progress,
  a: { doing?: string; isDoing?: boolean; reason?: string; filePath?: string; history?: string[] },
  tone: Tone,
  waiting?: string,
): Line[] {
  const out: Line[] = []
  const at = tasks.findIndex(t => t.title === p.label && t.status !== 'completed')
  const failed = tasks.find(t => t.status === 'failed')
  if (failed) out.push({ icon: '✕', text: failed.title, tone: 'fail' })
  else if (tone === 'live' && p.label) out.push({ icon: '⏳', text: p.label, tone: 'now' })
  else if (waiting !== undefined && p.label) {
    out.push({ icon: '⏳', text: p.label, tone: 'now' })
    out.push({ icon: ' ', text: `attend « ${waiting} »`, tone: 'detail' })
  }
  if (tone === 'live' && a.doing && a.isDoing) out.push({ icon: ' ', text: a.doing, tone: 'detail' })
  if (tone === 'live' && a.filePath && a.reason && a.reason !== '…') out.push({ icon: ' ', text: `↳ ${a.reason}`, tone: 'detail' })
  const next = tasks.find((t, i) => t.status === 'pending' && i > at)
  if (next && tone !== 'done') out.push({ icon: '○', text: next.title, tone: 'next' })
  for (const t of tasks.filter(x => x.status === 'completed').slice(-2).reverse()) out.push({ icon: '✓', text: t.title, tone: 'done' })
  return out.slice(0, 5)
}

const usageText = (t: Tally, usd: number) => `${fmt(total(t))} tokens · ${euros(usd)}`

function leadCard(d: ViewData, flow: Flow): Card {
  const tasks = leadTasks(flow.phase)
  const isDone = flow.phase === 'done'
  // Pendant que les agents tournent en arrière-plan, l'orchestrateur attend leurs résultats.
  const tone: Tone = isDone ? 'done' : d.busy ? 'live' : 'wait'
  const p = progress(tasks, 'lead', !isDone)
  const effort = d.lead.effort ? ` · ${d.lead.effort}` : ''
  return {
    id: 'lead',
    name: 'Orchestrateur',
    modelId: d.lead.modelId,
    pill: `${shortModel(d.lead.modelId || '')}${effort}`,
    tone,
    status: tone === 'wait' ? 'Attend les agents' : STATUS[tone],
    color: PALETTE.text,
    ...(d.lead.isDoing && d.lead.doing ? { doing: d.lead.doing } : {}),
    prog: p,
    usage: usageText(d.lead.tokens, d.lead.costUsd),
    lines: [...lines(tasks, p, d.lead, tone === 'wait' ? 'live' : tone), ...cacheDetail(d, 'lead')],
    duration: fmtDuration(Math.max(0, (flow.endedAt ?? d.now) - flow.startedAt)),
    isLead: true,
  }
}

/** Le nom de l'agent attendu, raccourci pour tenir dans l'en-tête de la carte. */
const waitName = (name: string) => (name.length > 24 ? `${name.slice(0, 23)}…` : name)

function agentCard(a: FlowAgent, index: number, d: ViewData): Card {
  const now = d.now
  // En attente d'un autre agent : ton « attente », pas « échec ».
  const tone: Tone = a.status === 'failed' ? 'fail' : a.status === 'done' ? 'done' : a.status === 'running' ? 'live' : 'wait'
  const isBlocked = a.status === 'blocked'
  const waiting = isBlocked ? waitName(a.waitingFor?.name ?? '?') : undefined
  const base = progress(a.tasks, a.status, a.status === 'running')
  // Sa barre montre la tâche suspendue (la première restante) : c'est elle qui reprendra.
  const paused = isBlocked ? a.tasks.findIndex(t => t.status === 'pending' || t.status === 'in_progress') : -1
  const p = paused >= 0 ? { ...base, label: a.tasks[paused]!.title, count: `${paused + 1}/${a.tasks.length}` } : base
  const modelId = a.modelId || MODELS[a.model].id
  return {
    id: a.key,
    name: a.name,
    modelId,
    pill: `${shortModel(modelId)} · ${a.effort}`,
    tone,
    status: waiting !== undefined ? `Attend « ${waiting} »` : STATUS[tone],
    color: AGENT_COLORS[index % AGENT_COLORS.length]!,
    ...(a.isDoing && a.doing ? { doing: a.doing } : {}),
    prog: p,
    usage: usageText(a.tokens, a.costUsd),
    lines: [...lines(a.tasks, p, a, tone, waiting), ...cacheDetail(d, a.key)],
    ...(a.startedAt !== undefined
      ? { duration: fmtDuration(Math.max(0, (a.endedAt ?? (a.status === 'running' ? now : (a.lastActiveAt ?? now))) - a.startedAt)) }
      : {}),
    ...(a.status === 'running' && a.lastActiveAt !== undefined && now - a.lastActiveAt > IDLE_AFTER_MS
      ? { idle: `inactif depuis ${fmtDuration(now - a.lastActiveAt)}` }
      : {}),
    isLead: false,
    canRetry: a.status === 'failed' || isBlocked,
  }
}

/** Les cartes n'existent qu'une fois le plan posé : avant, le panneau attend le plan d'exécution. */
/**
 * L'ordre des cartes sous l'orchestrateur : les actifs d'abord, puis en attente (de lancement ou d'un autre agent),
 * en échec, et les terminés en bas.
 */
const RANK: Record<Tone, number> = { live: 0, wait: 1, fail: 2, done: 3 }

export function cards(d: ViewData): Card[] {
  if (!d.flow || d.flow.phase === 'planning') return []
  // La couleur suit l'ordre du plan (elle ne change pas quand l'agent change de place) ; le tri garde cet ordre à rang égal.
  const agents = d.flow.agents.map((a, i) => agentCard(a, i, d)).sort((a, b) => RANK[a.tone] - RANK[b.tone])
  return [leadCard(d, d.flow), ...agents]
}

const WAITING = 'En attente du plan d’exécution…'
const isPlanning = (d: ViewData) => d.flow?.phase === 'planning'

// ── La barre dans le chat ────────────────────────────────────────────────

/** Les étapes de l'orchestrateur, le pourcentage global et le nombre d'agents qui travaillent. */
export function bandModel(d: ViewData) {
  const flow = d.flow
  if (!flow) return null
  const p = progress(leadTasks(flow.phase), 'lead', flow.phase !== 'done')
  const stages: BarStage[] = p.segs.map(s => ({ name: s.name, kind: s.kind }))
  const running = flow.agents.filter(a => a.status === 'running').length
  return {
    flow,
    stages,
    percent: flowPercent(flow),
    agents: running + (d.busy ? 1 : 0),
    isDone: flow.phase === 'done',
    label: p.label,
    count: p.count,
  }
}

const stageAlt = (stages: readonly BarStage[]) =>
  stages
    .map(v => `${v.name} ${v.kind === 'now' ? 'en cours' : v.kind === 'reached' ? 'terminé' : v.kind === 'failed' ? 'échoué' : 'à venir'}`)
    .join(', ')

export function DesktopBand(t: Elements['desktop'], d: ViewData, widthPx: number) {
  const m = bandModel(d)
  if (!m) return null
  const { Box, Svg } = t
  const width = Math.max(340, Math.min(1100, widthPx - 24))
  const cp = cacheParts(d, width / 7.6)
  return (
    <Box key="bar" flexDirection="column">
      <Svg
        source={barSvg(m.stages, {
          title: m.flow.title,
          width,
          percent: m.percent,
          agents: m.agents,
          isDone: m.isDone,
          ...(d.context ? { context: d.context.percent } : {}),
          ...(d.lastTurn ? { lastPrompt: `${d.lastTurn.isLive ? '…' : ''}${fmt(d.lastTurn.tokens.input)}↑ ${fmt(d.lastTurn.tokens.output)}↓ · ${turnCost(d.lastTurn)}` } : {}),
        })}
        alt={`revo-flow ${m.flow.title} : ${stageAlt(m.stages)}, ${m.percent} %, ${m.agents} agent${m.agents > 1 ? 's' : ''} actif${m.agents > 1 ? 's' : ''}${d.context ? `, contexte ${Math.round(d.context.percent)} %` : ''}`}
        width={width}
        isInteractive
      />
      {cp && (
        <Svg
          source={cacheBandSvg({ text: cp.text, ...(cp.saved ? { saved: cp.saved } : {}), stale: cp.stale, width })}
          alt={cacheLine(d, width / 7.6) ?? ''}
          width={width}
          isInteractive
        />
      )}
    </Box>
  )
}

/** La largeur du terminal en colonnes (100 si on ne la connaît pas). */
const termColumns = () => (globalThis as { process?: { stdout?: { columns?: number } } }).process?.stdout?.columns ?? 100

/** Terminal : une ligne sobre — titre, étape de l'orchestrateur, avancement, agents actifs — et dessous le dernier prompt et le contexte. */
export function TerminalBand(t: Elements['terminal'], d: ViewData) {
  const m = bandModel(d)
  if (!m) return null
  const { Box, Text } = t
  const lt = d.lastTurn
  const cp = cacheParts(d, termColumns())
  const cut = cp?.saved ? cp.text.indexOf(cp.saved) : -1
  return (
    <Box borderStyle="round" borderColor={PALETTE.border} paddingX={1} flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>{m.flow.title}</Text>
        <Text dimColor>{'  ·  '}</Text>
        <Text>{m.isDone ? `✓ ${m.label} ${m.count}` : `${m.label} ${m.count}`}</Text>
        <Text>{'  '}</Text>
        <Text color={PALETTE.silver}>{bar(m.percent, 10)}</Text>
        <Text bold>{` ${m.percent}%`}</Text>
        {m.agents > 0 && <Text color={PALETTE.live}>{`  ● ${m.agents} actif${m.agents > 1 ? 's' : ''}`}</Text>}
      </Text>
      {(lt || d.context) && (
        <Box justifyContent="space-between">
          <Text dimColor wrap="truncate-end">
            {lt ? `${lt.isLive ? 'Prompt en cours' : 'Dernier prompt'} : ${promptText(lt)}` : ' '}
          </Text>
          {d.context && (
            <Box flexShrink={0} marginLeft={2}>
              <Text color={d.context.percent >= 70 ? ctxColor(d.context.percent) : undefined} dimColor={d.context.percent < 70}>
                {`ctx ${Math.round(d.context.percent)} %`}
              </Text>
            </Box>
          )}
        </Box>
      )}
      {cp && (
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text dimColor>{cut >= 0 ? cp.text.slice(0, cut) : cp.text}</Text>
            {cut >= 0 ? <Text color={PALETTE.live}>{cp.saved}</Text> : null}
            {cut >= 0 ? <Text dimColor>{cp.text.slice(cut + (cp.saved?.length ?? 0))}</Text> : null}
          </Text>
          {cp.stale > 0 && (
            <Box flexShrink={0} marginLeft={2}>
              <Text color={PALETTE.orange}>{`⚠ ${cp.stale} périmé${cp.stale > 1 ? 's' : ''}`}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}

/** Terminal : remplace la ligne native « Baked for 12s » par une ligne dim avec la durée, les tokens, le coût et le modèle du tour. */
export function TerminalTurnLine(t: Elements['terminal'], d: ViewData, props: { word: string; durationMs: number }) {
  const lt = d.lastTurn
  if (!lt || lt.isLive) return null
  const { Text } = t
  const parts = [
    `⏱ ${fmtDuration(props.durationMs)}`,
    `${fmt(lt.tokens.input)} in`,
    `${fmt(lt.tokens.output)} out`,
    `${fmt(cacheOf(lt.tokens))} cache API`,
    turnCost(lt),
    ...(d.cache && d.cache.flow.evites > 0 ? [`cache ${plural(cacheHits(d.cache), 'hit')} ≈ -${fmt(d.cache.flow.evites)}`] : []),
    modelLabel(lt.modelId),
  ]
  return (
    <Text dimColor wrap="truncate-end">
      {parts.join(' · ')}
    </Text>
  )
}

/** Mobile : la surface a `Svg`, on réutilise la barre du bureau. */
export function MobileBand(t: Elements['mobile'], d: ViewData, widthPx: number) {
  return DesktopBand(t as unknown as Elements['desktop'], d, widthPx)
}

// ── La fenêtre latérale ──────────────────────────────────────────────────

function pill(d: ViewData) {
  const flow = d.flow
  if (!flow) return null
  if (flow.phase === 'planning') return { text: 'Analyse des specs', tone: 'outline' as const }
  if (isPendingPlan(d)) return { text: PLAN_PENDING, tone: 'orange' as const }
  const failed = flow.agents.filter(a => a.status === 'failed').length
  const blocked = flow.agents.filter(a => a.status === 'blocked').length
  const waits = blocked ? ` · ${blocked} en attente` : ''
  if (flow.phase === 'done') {
    const text = failed ? `Terminé · ${failed} échec${failed > 1 ? 's' : ''}${waits}` : blocked ? `Terminé${waits}` : 'Terminé · 100 %'
    return { text, tone: failed ? ('red' as const) : ('silver' as const) }
  }
  const done = flow.agents.filter(a => a.status === 'done').length
  const text = allFinished(flow) ? `Vérification · ${flowPercent(flow)} %${waits}` : `${done}/${flow.agents.length} agents · ${flowPercent(flow)} %${waits}`
  return { text, tone: failed ? ('red' as const) : ('outline' as const) }
}

/** Les noms des autres agents qui ont touché un fichier : « Front, orchestrateur ». */
const conflictNames = (d: ViewData, x: Entry) => (x.conflict ?? []).map(k => whoName(d, k)).join(', ')

export function DesktopPane(t: Elements['desktop'], d: ViewData, actions: PaneActions, columns: number) {
  const { Box, Text, Svg, Button } = t
  const inner = Math.max(240, Math.min(700, pixels(columns) - 56))
  const cardInner = inner - 28
  const flow = d.flow
  const all = cards(d)
  const running = all.filter(c => c.tone === 'live' && !c.isLead).length
  const liveCount = all.filter(c => c.tone === 'live').length
  const day = d.tokens ? total(d.tokens.day) : 0
  const week = d.tokens ? total(d.tokens.week) : 0
  const pct = usagePercents(d.limits, day, week)
  const p = pill(d)
  const isPending = isPendingPlan(d)

  const line = (l: Line, i: number) => (
    <Text
      key={`l${i}`}
      color={l.tone === 'now' ? PALETTE.text : l.tone === 'fail' ? PALETTE.redText : l.tone === 'next' ? PALETTE.text2 : PALETTE.muted}
      bold={l.tone === 'now'}
      wrap="truncate-end"
    >
      {l.tone === 'detail' ? `   ${l.text}` : `${l.icon} ${l.text}`}
    </Text>
  )

  return (
    <Box flexDirection="column" width="100%" minHeight="100%" backgroundColor={PALETTE.panel}>
      <Box flexDirection="column" gap={1} padding={2} flexGrow={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
          <Svg
            source={headerSvg({ title: flow?.title || '', project: flow?.project || '', branch: flow?.branch || '', width: inner - 130 })}
            alt={`Feature demandée : ${flow?.title || 'en attente'}`}
            width={inner - 130}
          />
          {p && <Svg source={statusPillSvg(p.text, p.tone)} alt={p.text} />}
        </Box>
        {flow?.summary ? (
          <Text color={PALETTE.muted} wrap="wrap">
            {flow.summary}
          </Text>
        ) : null}

        {running > 0 && (
          <Box justifyContent="flex-end" width="100%">
            <Button key="stop-all" plain label="Tout arrêter" onPress={() => actions.stopAll()} />
          </Box>
        )}

        {isPending && flow && (
          <Box
            key="plan"
            flexDirection="column"
            gap={1}
            width="100%"
            backgroundColor={PALETTE.card}
            borderStyle="round"
            borderColor={PALETTE.orange}
            padding={1}
          >
            <Svg source={sectionSvg('PLAN À VALIDER', `${flow.agents.length} agent${flow.agents.length > 1 ? 's' : ''}`, cardInner)} alt="Plan à valider" width={cardInner} />
            {flow.agents.map(a => (
              <Box key={a.key} flexDirection="column">
                <Text bold wrap="truncate-end">
                  {a.name}
                </Text>
                <Text color={PALETTE.muted} wrap="truncate-end">{`${planModel(a)} · ${planCount(a)}`}</Text>
              </Box>
            ))}
            <Box flexDirection="row" gap={2}>
              <Button key="approve" label="Lancer" onPress={() => actions.approvePlan()} />
              <Button key="cancel" plain label="Annuler" onPress={() => actions.cancelPlan()} />
            </Box>
          </Box>
        )}

        <Svg
          source={sectionSvg('AGENTS', all.length ? `${all.length} · ${liveCount} actif${liveCount > 1 ? 's' : ''}` : '', inner)}
          alt={`Agents : ${all.length}`}
          width={inner}
        />
        {all.length === 0 &&
          (isPlanning(d) ? (
            <Svg source={emptySvg(WAITING, inner)} alt={WAITING} width={inner} />
          ) : (
            <Svg source={emptySvg('Aucun flow en cours. /revo-flow <demande> pour en lancer un.', inner)} alt="Aucun flow" width={inner} />
          ))}
        {all.map(c => {
          const isWait = c.tone === 'wait'
          return (
            <Box
              key={c.id}
              flexDirection="column"
              gap={1}
              width="100%"
              backgroundColor={isWait ? PALETTE.cardWait : PALETTE.card}
              borderStyle="round"
              borderColor={
                c.tone === 'fail' ? PALETTE.redBorder : c.tone === 'live' ? PALETTE.liveBorder : isWait ? PALETTE.waitBorder : PALETTE.cardBorder
              }
              padding={1}
            >
              <Svg
                source={agentHeadSvg({
                  name: c.name,
                  kind: mascotOf(c.modelId),
                  modelLabel: c.pill,
                  modelColor: colorOf(c.modelId),
                  status: c.status,
                  tone: c.tone,
                  width: cardInner,
                  ...(c.duration ? { duration: c.duration } : {}),
                  ...(c.idle ? { note: c.idle } : {}),
                })}
                alt={`${c.name}, ${modelLabel(c.modelId)}, ${c.pill}, ${c.status}${c.duration ? `, ${c.duration}` : ''}${c.idle ? `, ${c.idle}` : ''}`}
                width={cardInner}
              />
              {/* Sa barre : un segment par tâche que l'orchestrateur lui a confiée, la tâche en cours dessous et « n/total ». */}
              <Box flexDirection="column">
                <Svg
                  source={planBarSvg(c.prog.segs, cardInner, {
                    label: c.prog.label,
                    count: c.prog.count,
                    isRunning: c.tone === 'live',
                    isDone: c.tone === 'done',
                    color: c.color,
                  })}
                  alt={`${c.name} : tâche ${c.prog.count}${c.prog.label ? `, ${c.prog.label}` : ''}, ${c.prog.percent} %`}
                  width={cardInner}
                />
                <Svg source={usageSvg(c.usage, c.tone === 'live', cardInner)} alt={c.usage} width={cardInner} />
              </Box>
              {c.lines.length > 0 && <Svg source={ruleSvg(cardInner)} alt="" width={cardInner} />}
              <Box flexDirection="column">{c.lines.map(line)}</Box>
              {!c.isLead && c.tone === 'live' && (
                <Box justifyContent="flex-end" width="100%">
                  <Button key={`stop-${c.id}`} plain label="Arrêter" onPress={() => actions.stopAgent(c.id)} />
                </Box>
              )}
              {!c.isLead && c.canRetry && (
                <Box justifyContent="flex-end" width="100%">
                  <Button key={`retry-${c.id}`} plain label="Relancer" onPress={() => actions.retryAgent(c.id)} />
                </Box>
              )}
            </Box>
          )
        })}

        <Svg source={sectionSvg('FICHIERS MODIFIÉS', String(d.entries.length), inner)} alt={`Fichiers modifiés : ${d.entries.length}`} width={inner} />
        {d.entries.length === 0 ? (
          <Svg source={emptySvg('Aucun fichier modifié pour l’instant.', inner)} alt="Aucun fichier modifié" width={inner} />
        ) : (
          <Box flexDirection="column" gap={1} width="100%">
            {d.entries
              .slice(-6)
              .reverse()
              .map(x => {
                const who = x.by ? whoName(d, x.by) : ''
                const others = conflictNames(d, x)
                return (
                  <Svg
                    key={x.path}
                    source={fileRowSvg({
                      path: x.rel,
                      summary: x.reason,
                      count: x.count,
                      width: inner,
                      ...(who ? { by: who } : {}),
                      ...(others ? { conflict: others } : {}),
                    })}
                    alt={`${x.rel} : ${x.reason}${who ? `, par ${who}` : ''}${others ? `, aussi modifié par ${others}` : ''}`}
                    width={inner}
                  />
                )
              })}
            <Button key="clear" plain label="vider la liste" onPress={() => actions.clear()} />
          </Box>
        )}

        {d.cache && cacheKnown(d.cache) && (() => {
          const c = d.cache!
          const nodes = cacheNodes(c)
          const right = `${plural(nodes, 'nœud')}${c.perimees > 0 ? ` · ${c.perimees} périmé${c.perimees > 1 ? 's' : ''}` : ''}`
          const limit = inner < 360 ? 5 : 8
          const shown = shownNodes(c, limit)
          const types = typeCounts(c)
          return (
            <Box key="cache" flexDirection="column" gap={1} width="100%">
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Button key="toggle-cache" plain label={d.cacheOpen ? '▾' : '▸'} onPress={() => actions.toggleCache()} />
                <Svg source={sectionSvg(`CACHE · ${c.projet}`, right, inner - 28)} alt={`Cache ${c.projet} : ${right}`} width={inner - 28} />
              </Box>
              {d.cacheOpen && (
                <Box flexDirection="column" gap={1} width="100%">
                  <Svg
                    source={cacheSummarySvg({ nodes, used: cacheHits(c), saved: fmt(c.flow.evites), stale: c.perimees, width: inner })}
                    alt={`Cache : ${plural(nodes, 'nœud')}, ${plural(cacheHits(c), 'utilisé')}, ≈ ${fmt(c.flow.evites)} tokens évités`}
                    width={inner}
                  />
                  {types ? <Text color={PALETTE.muted} wrap="truncate-end">{types}</Text> : null}
                  {shown.map(n => {
                    const color = hitColor(d, n.hit)
                    return (
                      <Svg
                        key={n.id}
                        source={cacheNodeRowSvg({
                          name: n.titre,
                          type: n.k,
                          summary: `${nodeState(n)}${n.hit ? ` · reçu par ${whoName(d, n.hit)}` : ''} · ≈ ${fmt(n.tok)} tokens`,
                          level: n.niveau,
                          width: inner,
                          detail: `${n.titre} (${n.k}) : ${nodeState(n)}${n.hit ? `, reçu par ${whoName(d, n.hit)}` : ''}, ≈ ${fmt(n.tok)} tokens${c.indexe ? `, indexé au commit ${c.indexe.commit}` : ''}`,
                          ...(color ? { color } : {}),
                        })}
                        alt={`${n.titre}, ${n.k}, ${nodeState(n)}${n.hit ? `, reçu par ${whoName(d, n.hit)}` : ''}`}
                        width={inner}
                        isInteractive
                      />
                    )
                  })}
                  {c.noeuds.length > shown.length && (
                    <Text color={PALETTE.muted} wrap="truncate-end">{`… et ${c.noeuds.length - shown.length} autres : /revo-flow cache`}</Text>
                  )}
                  {c.build && (
                    <Text color={PALETTE.muted} wrap="truncate-end">{`Coût construction ${fmt(c.build.tokens)} tokens · ${euros(c.build.costUsd)}`}</Text>
                  )}
                </Box>
              )}
            </Box>
          )
        })()}
      </Box>

      <Box flexDirection="column" gap={1} padding={2} width="100%" backgroundColor={PALETTE.panelFoot}>
        <Svg source={sectionSvg('CONSOMMATION', 'tokens', inner)} alt="Consommation" width={inner} />
        <Svg
          source={usageRowSvg({
            label: d.sessionCostUsd > 0 ? `Session · ${euros(d.sessionCostUsd)}` : 'Session',
            value: fmt(total(d.session)),
            note: pct.session !== undefined ? `${Math.round(pct.session)} %` : '',
            percent: pct.session,
            width: inner,
          })}
          alt={`Session : ${fmt(total(d.session))}${d.sessionCostUsd > 0 ? `, ${euros(d.sessionCostUsd)}` : ''}`}
          width={inner}
        />
        {d.context && (
          <Svg
            source={usageRowSvg({
              label: 'Contexte',
              value: `${fmt(d.context.tokens)} / ${fmt(d.context.window)}`,
              note: `${Math.round(d.context.percent)} %`,
              percent: d.context.percent,
              width: inner,
              warnAt: [70, 85],
            })}
            alt={`Contexte : ${Math.round(d.context.percent)} %`}
            width={inner}
          />
        )}
        {d.cache && (d.cache.flow.evites > 0 || d.cache.flow.lus > 0) && (
          <Svg
            source={usageRowSvg({
              label: 'Cache',
              value: `≈ ${fmt(d.cache.flow.evites)} évités`,
              note: d.cache.build ? `coût ${fmt(d.cache.build.tokens)}` : '',
              percent: cacheShare(d.cache),
              width: inner,
              warnAt: [101, 101],
            })}
            alt={`Cache : ≈ ${fmt(d.cache.flow.evites)} tokens évités`}
            width={inner}
          />
        )}
        <Svg
          source={usageRowSvg({ label: 'Semaine', value: fmt(week), note: pct.week !== undefined ? `${Math.round(pct.week)} %` : '', percent: pct.week, width: inner })}
          alt={`Semaine : ${fmt(week)}`}
          width={inner}
        />
      </Box>
    </Box>
  )
}

/** Mobile : la surface a `Svg` et `Button` : même panneau que le bureau. */
export function MobilePane(t: Elements['mobile'], d: ViewData, actions: PaneActions, columns: number) {
  return DesktopPane(t as unknown as Elements['desktop'], d, actions, columns)
}

/**
 * Terminal : la même chose que le bureau, en sobre. Deux lignes par agent (nom, modèle, statut et durée ; sa barre colorée,
 * n/total et la tâche en cours), une troisième pour l'action en direct quand il est actif, puis ses tokens ; un terminé tient en une ligne de barre sans titre.
 */
export function TerminalPane(t: Elements['terminal'], d: ViewData, actions: PaneActions) {
  const { Box, Text, Button } = t
  const flow = d.flow
  const all = cards(d)
  const day = d.tokens ? total(d.tokens.day) : 0
  const week = d.tokens ? total(d.tokens.week) : 0
  const pct = usagePercents(d.limits, day, week)
  const p = pill(d)
  const isPending = isPendingPlan(d)
  const running = all.filter(c => c.tone === 'live' && !c.isLead).length
  const where = flow ? [flow.project, flow.branch].filter(Boolean).join(' · ') : ''
  const icon = (tone: Tone) => (tone === 'live' ? '●' : tone === 'wait' ? '○' : tone === 'fail' ? '✕' : '✓')
  const segs = (c: Card) => c.prog.segs.map(s => (s.kind === 'todo' ? '▱' : s.kind === 'failed' ? '✕' : '▰')).join('')

  const card = (c: Card) => {
    const isDone = c.tone === 'done'
    return (
      <Box key={c.id} flexDirection="column">
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text bold={!isDone} dimColor={isDone}>
              {c.name}
            </Text>
            <Text color={isDone ? PALETTE.muted : colorOf(c.modelId)}>{`  ${c.pill}`}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text
              color={c.tone === 'live' ? PALETTE.live : c.tone === 'fail' ? PALETTE.redText : PALETTE.muted}
              bold={c.tone === 'live'}
            >{`${icon(c.tone)} ${c.status}`}</Text>
            {c.duration ? <Text dimColor>{` · ${c.duration}`}</Text> : null}
          </Text>
        </Box>
        <Text wrap="truncate-end">
          <Text color={isDone ? PALETTE.muted : c.color}>{`  ${segs(c)}`}</Text>
          <Text bold={!isDone} dimColor={isDone}>{`  ${c.prog.count}`}</Text>
          {!isDone && c.prog.label ? <Text color={c.tone === 'fail' ? PALETTE.redText : undefined}>{` ${c.prog.label}`}</Text> : null}
        </Text>
        {c.tone === 'live' && c.doing ? (
          <Text dimColor wrap="truncate-end">
            {`    ↳ ${c.doing}`}
          </Text>
        ) : null}
        {c.idle ? (
          <Text color={PALETTE.orange} wrap="truncate-end">
            {`  ⚠ ${c.idle}`}
          </Text>
        ) : null}
        {c.lines
          .filter(l => l.text.startsWith('↳ cache'))
          .map((l, i) => (
            <Text key={`cache${i}`} dimColor wrap="truncate-end">{`    ${l.text}`}</Text>
          ))}
        <Text dimColor={isDone} color={isDone ? undefined : PALETTE.text2} wrap="truncate-end">{`  Σ ${c.usage}`}</Text>
        {!c.isLead && (c.tone === 'live' || c.canRetry) ? (
          <Box paddingLeft={2}>
            {c.tone === 'live' ? (
              <Button key={`stop-${c.id}`} plain label="Arrêter" onPress={() => actions.stopAgent(c.id)} />
            ) : (
              <Button key={`retry-${c.id}`} plain label="Relancer" onPress={() => actions.retryAgent(c.id)} />
            )}
          </Box>
        ) : null}
      </Box>
    )
  }

  const gauge = (label: string, value: string, percent: number | undefined, warnAt: readonly [number, number] = [80, 95], extra = '') => (
    <Text key={label} wrap="truncate-end">
      <Text dimColor>{label.padEnd(9)}</Text>
      <Text color={percent !== undefined && percent >= warnAt[1] ? PALETTE.red : percent !== undefined && percent >= warnAt[0] ? PALETTE.orange : PALETTE.silver}>
        {bar(percent ?? 0, 10)}
      </Text>
      <Text>{`  ${value}`}</Text>
      <Text dimColor>{percent !== undefined ? ` · ${Math.round(percent)} %` : ''}</Text>
      {extra ? <Text dimColor>{` · ${extra}`}</Text> : null}
    </Text>
  )

  const cacheSection = (c: CacheStats) => {
    const nodes = cacheNodes(c)
    const shown = shownNodes(c, 8)
    const types = typeCounts(c)
    const share = cacheShare(c)
    const gain = c.flow.evites > 0 || c.flow.lus > 0
    return (
      <Box key="cache" flexDirection="column">
        <Box justifyContent="space-between">
          <Button key="toggle-cache" plain label={`${d.cacheOpen ? '▾' : '▸'} Cache · ${c.projet}`} onPress={() => actions.toggleCache()} />
          <Text dimColor wrap="truncate-end">{`${plural(nodes, 'nœud')}${c.perimees > 0 ? ` · ${c.perimees} périmé${c.perimees > 1 ? 's' : ''}` : ''}`}</Text>
        </Box>
        {d.cacheOpen && types ? <Text dimColor wrap="truncate-end">{`  ${types}`}</Text> : null}
        {d.cacheOpen &&
          shown.map(n => {
            const warn = n.niveau !== 'fraiche'
            const color = hitColor(d, n.hit, true)
            const mark = warn ? '⚠' : n.hit ? '●' : '○'
            return (
              <Box key={n.id} justifyContent="space-between">
                <Box flexShrink={1}>
                  <Text wrap="truncate-end">
                    <Text color={warn ? PALETTE.orange : (color ?? PALETTE.muted)}>{`  ${mark} `}</Text>
                    <Text>{`${n.titre} (${n.k})`}</Text>
                  </Text>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  <Text color={warn ? PALETTE.orange : undefined} dimColor={!warn}>
                    {n.hit ? `← ${whoName(d, n.hit)}` : nodeState(n)}
                  </Text>
                </Box>
              </Box>
            )
          })}
        {d.cacheOpen && c.noeuds.length > shown.length ? (
          <Text dimColor wrap="truncate-end">{`  … et ${c.noeuds.length - shown.length} autres : /revo-flow cache`}</Text>
        ) : null}
        {gain && (d.cacheOpen || c.flow.evites > 0) ? (
          <Text wrap="truncate-end">
            <Text dimColor>{'  Gain '.padEnd(9)}</Text>
            <Text color={PALETTE.live}>{bar(share, 10)}</Text>
            <Text>{`  ≈ ${fmt(c.flow.evites)} tokens évités`}</Text>
            <Text dimColor>{` (sur ≈ ${fmt(c.flow.lus)} lus)`}</Text>
          </Text>
        ) : null}
        {d.cacheOpen && c.build ? (
          <Text dimColor wrap="truncate-end">{`  Coût construction ${fmt(c.build.tokens)} tokens · ${euros(c.build.costUsd)}`}</Text>
        ) : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {flow?.title || 'revo-flow'}
          </Text>
          <Box gap={2} flexShrink={0}>
            {running > 0 && <Button key="stop-all" plain label="Tout arrêter" onPress={() => actions.stopAll()} />}
            <Text color={isPending ? PALETTE.orange : undefined} dimColor={!isPending}>
              {p?.text ?? ''}
            </Text>
          </Box>
        </Box>
        <Text dimColor wrap="truncate-end">
          {flow ? where || ' ' : '/revo-flow <demande> pour lancer un flow'}
        </Text>
      </Box>

      {isPlanning(d) && <Text color={PALETTE.text2}>{`⏳ ${WAITING}`}</Text>}

      {isPending && flow && (
        <Box flexDirection="column">
          <Text bold color={PALETTE.orange}>{`${PLAN_PENDING} · ${flow.agents.length} agent${flow.agents.length > 1 ? 's' : ''}`}</Text>
          {flow.agents.map(a => (
            <Text key={a.key} wrap="truncate-end">
              <Text>{`  ${a.name}`}</Text>
              <Text dimColor>{`  ${planModel(a)} · ${planCount(a)}`}</Text>
            </Text>
          ))}
          <Box gap={2} paddingLeft={2}>
            <Button key="approve" label="Lancer" onPress={() => actions.approvePlan()} />
            <Button key="cancel" plain label="Annuler" onPress={() => actions.cancelPlan()} />
          </Box>
        </Box>
      )}

      {all.length > 0 && <Box flexDirection="column">{all.map(card)}</Box>}

      {d.entries.length > 0 && (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text dimColor>{`Fichiers modifiés · ${d.entries.length}`}</Text>
            <Button key="clear" plain label="vider" onPress={() => actions.clear()} />
          </Box>
          {d.entries
            .slice(-3)
            .reverse()
            .map(x => {
              const who = x.by ? whoName(d, x.by) : ''
              const others = conflictNames(d, x)
              return (
                <Box key={x.path} flexDirection="column">
                  <Box>
                    <Box flexShrink={1}>
                      <Text wrap="truncate-start">{`  ${x.rel}${x.count > 1 ? ` ×${x.count}` : ''}`}</Text>
                    </Box>
                    {who ? (
                      <Box flexShrink={0}>
                        <Text dimColor>{` · ${who}`}</Text>
                      </Box>
                    ) : null}
                  </Box>
                  {others ? (
                    <Text color={PALETTE.orange} wrap="truncate-end">{`    ⚠ aussi modifié par ${others}`}</Text>
                  ) : null}
                </Box>
              )
            })}
        </Box>
      )}

      {d.cache && cacheKnown(d.cache) && cacheSection(d.cache)}

      <Box flexDirection="column">
        {gauge('Session', fmt(total(d.session)), pct.session, [80, 95], d.sessionCostUsd > 0 ? euros(d.sessionCostUsd) : '')}
        {d.context && gauge('Contexte', `${fmt(d.context.tokens)} / ${fmt(d.context.window)}`, d.context.percent, [70, 85])}
        {gauge('Semaine', fmt(week), pct.week)}
        {d.limits.some(l => l.resetsAt) && (
          <Text dimColor wrap="truncate-end">
            {d.limits
              .filter(l => l.resetsAt)
              .map(l => `${LIMIT_LABEL[l.kind] ?? l.kind} ↻ ${resetLabel(l.resetsAt, d.now)}`)
              .join('  ·  ')}
          </Text>
        )}
      </Box>
    </Box>
  )
}
