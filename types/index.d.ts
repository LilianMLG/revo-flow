export type ModelKey = 'haiku' | 'sonnet' | 'opus'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'
export type TaskKind = 'analyse' | 'codage' | 'test' | 'review' | 'doc' | 'deploy'
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/** Une tâche confiée à un sous-agent par l'orchestrateur. */
export type FlowTask = { title: string; kind: TaskKind; status: TaskStatus }

/** Ce qu'un agent fait en direct : action en cours, dernières actions, fichier touché. */
export type Activity = {
  doing?: string
  isDoing?: boolean
  history?: string[]
  filePath?: string
  reason?: string
}

export type Tally = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Un sous-agent prévu par le plan : son modèle, son effort et SES tâches. */
export type FlowAgent = Activity & {
  key: string
  name: string
  role: string
  subagentType: string
  model: ModelKey
  effort: Effort
  why: string
  tasks: FlowTask[]
  /** Connu une fois l'agent lancé. */
  agentId?: string
  /** Le modèle réellement utilisé (identifiant complet). */
  modelId?: string
  status: 'waiting' | 'running' | 'done' | 'failed'
  /** Vrai dès que l'agent a signalé lui-même une tâche. */
  hasReported?: boolean
  /** Son dernier tour s'est terminé ; il n'est fini que quand Claude Code le dit (il peut tourner encore en fond). */
  hasEndedTurn?: boolean
  tokens: Tally
  costUsd: number
  /** Lancé (agent.spawn accepté). */
  startedAt?: number
  /** Fini, en succès ou en échec. */
  endedAt?: number
  /** Dernier signe de vie : un appel d'outil ou une requête au modèle. */
  lastActiveAt?: number
  /** Nombre de lancements : 1 au premier, +1 à chaque relance. */
  attempts?: number
}

/**
 * planning : l'orchestrateur lit la demande et les specs (le panneau attend le plan d'exécution) ;
 * dispatch : le plan et les tâches sont posés, les agents apparaissent ; running : les agents travaillent ;
 * review : tous ont fini, l'orchestrateur vérifie ; done : terminé.
 */
export type Phase = 'planning' | 'dispatch' | 'running' | 'review' | 'done'

export type Flow = {
  id: string
  request: string
  title: string
  summary: string
  project: string
  branch: string
  phase: Phase
  startedAt: number
  agents: FlowAgent[]
  /** Fermé à la main pendant ce flow : on ne le rouvre pas tout seul. */
  isPaneClosed?: boolean
  /** Passé en done. */
  endedAt?: number
  /** Le plan a été validé (ou n'avait pas à l'être) : en dispatch sans cela, il attend l'utilisateur. */
  isApproved?: boolean
}

/** L'orchestrateur : le fil principal, sur le modèle de la session. */
export type Lead = Activity & { modelId: string; effort?: string; tokens: Tally; costUsd: number }

export type Tokens = { dayKey: string; weekKey: string; day: Tally; week: Tally }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** Un fichier modifié pendant le flow, avec la raison en une phrase. */
export type Entry = {
  path: string
  rel: string
  reason: string
  count: number
  at: number
  /** Qui l'a modifié en dernier : 'lead' ou la clé de l'agent. */
  by?: string
  /** Les clés des autres agents qui ont aussi touché ce fichier pendant qu'il tournait. */
  conflict?: string[]
}

/** Le dernier tour de l'orchestrateur : en cours (isLive, cumul via turn.step) puis figé par turn.complete. */
export type LastTurn = { at: number; durationMs: number; tokens: Tally; modelId: string; costUsd: number; isLive: boolean }

/** Fenêtre de contexte de l'orchestrateur. */
export type Context = { percent: number; tokens: number; window: number }

declare module 'claude-code' {
  interface PluginState {
    'revo-flow': {
      flow: Flow | null
      lead: Lead
      isBusy: boolean
      tokens: Tokens | null
      limits: Limit[]
      session: Tally
      entries: Entry[]
      lastTurn: LastTurn | null
      context: Context | null
      sessionCostUsd: number
    }
  }
}
