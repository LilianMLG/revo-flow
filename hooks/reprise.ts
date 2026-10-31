/**
 * La reprise d'un flow après un redémarrage de Claude Code (docs/rd-v3/README.md §2.3) : l'instantané gardé dans le store du
 * plugin, et le flow qu'on en restaure. Logique pure : register.tsx lit et écrit le store, et relance les agents.
 */
import type { Entry, Flow, FlowAgent, FlowCache, Lead, VerifFlow, VerifView } from '../types'

/** Le préfixe des instantanés dans le store : `flow:<id>`, un par flow en cours (deux sessions ne s'écrasent pas). */
export const SNAPSHOT_PREFIX = 'flow:'
export const snapshotKey = (id: string) => `${SNAPSHOT_PREFIX}${id}`

/**
 * Ce qui survit au redémarrage : le flow, l'orchestrateur (coût, tokens), les fichiers modifiés, et la vérification et le cache
 * du flow s'il y en a. Rien de vivant : ni tour, ni promesse, ni dialogue ouvert.
 */
export type FlowSnapshot = {
  v: 1
  /** L'heure de la dernière écriture. */
  savedAt: number
  flow: Flow
  lead: Lead
  entries: Entry[]
  verif?: VerifView
  verifFlow?: VerifFlow
  flowCache?: FlowCache
}

export function snapshotOf(
  savedAt: number,
  flow: Flow,
  lead: Lead,
  entries: Entry[],
  more: { verif?: VerifView | null; verifFlow?: VerifFlow | null; flowCache?: FlowCache | null } = {},
): FlowSnapshot {
  return {
    v: 1,
    savedAt,
    flow,
    lead,
    entries,
    ...(more.verif ? { verif: more.verif } : {}),
    ...(more.verifFlow && more.verifFlow.flowId === flow.id ? { verifFlow: more.verifFlow } : {}),
    ...(more.flowCache ? { flowCache: more.flowCache } : {}),
  }
}

/** Un instantané lisible et non terminé ; sinon rien (ancienne forme, flow fini, valeur abîmée). */
export function readSnapshot(v: unknown): FlowSnapshot | undefined {
  if (!v || typeof v !== 'object') return undefined
  const s = v as Partial<FlowSnapshot>
  const f = s.flow
  if (s.v !== 1 || !f || typeof f.id !== 'string' || !Array.isArray(f.agents) || f.phase === 'done') return undefined
  if (!s.lead || typeof s.lead !== 'object') return undefined
  return { ...(s as FlowSnapshot), entries: Array.isArray(s.entries) ? s.entries : [] }
}

/** Un agent qui n'a ni fini ni échoué : mort avec la session, il est à relancer. */
export const isUnfinished = (a: FlowAgent) => a.status !== 'done' && a.status !== 'failed'

/** Le plan n'était pas lancé (planification, ou plan pas encore validé) : il est à refaire, l'appel de l'outil plan est perdu. */
export const isBeforeLaunch = (flow: Flow) => flow.phase === 'planning' || (flow.phase === 'dispatch' && !flow.isApproved)

/**
 * Le flow restauré au chargement. Règle : aucun agent n'est « actif » ; tout agent non terminé est « à relancer » (waiting), ses
 * tâches faites restent cochées, les autres repartent de zéro, son id de lancement et son attente sont oubliés (l'agent est mort,
 * SendMessage ne le reprendrait pas). Un agent fini garde son sort et ses durées, sans son id. Avant le lancement, le plan est à refaire.
 */
export function resumedFlow(flow: Flow): Flow {
  if (isBeforeLaunch(flow)) return { ...flow, phase: 'planning', agents: [], isApproved: false }
  const agents = flow.agents.map((a): FlowAgent => {
    const { agentId: _id, isDoing: _d, doing: _g, ...kept } = a
    if (!isUnfinished(a)) return { ...kept, isDoing: false }
    const { lastAgentId: _l, waitingFor: _w, startedAt: _s, endedAt: _e, ...x } = kept
    return {
      ...x,
      status: 'waiting',
      // La relance compte une tentative de plus : un agent jamais lancé en sera à sa première.
      attempts: a.attempts ?? (a.startedAt === undefined ? 0 : 1),
      isDoing: false,
      hasReported: false,
      hasEndedTurn: false,
      tasks: a.tasks.map(t => (t.status === 'completed' ? t : { ...t, status: 'pending' as const })),
    }
  })
  const isLeft = agents.some(isUnfinished)
  const { endedAt: _end, ...f } = flow
  return { ...f, agents, phase: isLeft && flow.phase === 'review' ? 'running' : flow.phase }
}

/** La question posée au chargement : le flow, où il en est, ce qui reste. */
export function resumeQuestion(flow: Flow): string {
  const left = flow.agents.filter(isUnfinished).length
  const where = isBeforeLaunch(flow)
    ? 'plan pas encore lancé'
    : left
      ? `${left} agent${left > 1 ? 's' : ''} à relancer`
      : 'agents finis, conclusion à faire'
  return `Un flow revo-flow était en cours avant le redémarrage : « ${flow.title} » (${where}). Le reprendre ?`
}
