// Le budget par flow (docs/rd-v4 §2.2) : une estimation à la validation du plan, un plafond, trois états pendant le flow.
// Pur : des chiffres et des textes, aucun accès disque ni processus. Les coûts sont en dollars, l'affichage en euros (lib.ts).
import type { Effort, Flow, FlowBudget, Lead, ModelKey } from '../types'
import { EUR_PER_USD, euros, type JournalEntry, type PlanInput } from './lib'

/** Il faut au moins autant d'agents dans le journal pour estimer sur l'historique (sinon la valeur par défaut). */
export const HISTORIQUE_MIN = 3

/** Estimations par défaut, en dollars par agent, par modèle et effort (low, medium, high, xhigh) : un ordre de grandeur tiré des flows de l'auteur, pas une mesure. */
export const DEFAUT_AGENT_USD: Record<ModelKey, Record<Effort, number>> = {
  haiku: { low: 0.1, medium: 0.2, high: 0.35, xhigh: 0.5 },
  sonnet: { low: 0.4, medium: 0.8, high: 1.3, xhigh: 2 },
  opus: { low: 0.8, medium: 1.5, high: 2.5, xhigh: 4 },
}

/** Estimation par défaut du coût de l'orchestrateur sur un flow, en dollars (sans historique). */
export const DEFAUT_LEAD_USD = 1

/** Le plafond automatique : ce multiple de l'estimation, jamais sous le plancher. */
export const PLAFOND_FACTEUR = 2
/** Plancher du plafond automatique, en euros. */
export const PLAFOND_PLANCHER_EUR = 2
/** Part du plafond à partir de laquelle le flow est en alerte. */
export const SEUIL_ALERTE = 0.8
/** De combien « +50 % » relève le plafond. */
export const RELEVEMENT = 1.5

/** Les trois réponses à la question posée quand le plafond est atteint. */
export const BUDGET_CHOIX = ['Arrêter', '+50 %', 'Laisser finir'] as const

/** La mention d'honnêteté du rapport : le coût est calculé côté client, ce n'est pas la facture. */
export const BUDGET_HONNETETE = 'Le coût est une estimation côté client, calculée avec les tarifs publics des modèles : ce n\'est pas la facture.'

export type BudgetEtat = 'ok' | 'alerte' | 'atteint'
export type BudgetEstimate = { usd: number; base: 'historique' | 'defaut'; flows: number }
/** Le champ du journal et du rapport : estimé, plafond (absent sans plafond), réel, plafond atteint ; tout en dollars. */
export type BudgetJournal = { estime: number; plafond?: number; reel: number; atteint: boolean }

type Stat = { sum: number; n: number }
const moyenne = (xs: readonly number[]): Stat => ({ sum: xs.reduce((a, b) => a + b, 0), n: xs.length })

/** Le coût moyen d'un agent de ce modèle : affiné par effort avec assez d'agents de même effort, sinon par modèle ; undefined sans assez d'historique. */
function agentHistorique(journal: readonly JournalEntry[], model: ModelKey, effort: Effort): { usd: number; ids: string[] } | undefined {
  const all = journal.flatMap(e => e.agents.filter(a => a.model === model).map(a => ({ id: e.id, effort: a.effort, usd: a.costUsd })))
  const same = all.filter(a => a.effort === effort)
  const pool = same.length >= HISTORIQUE_MIN ? same : all
  if (pool.length < HISTORIQUE_MIN) return undefined
  const s = moyenne(pool.map(a => a.usd))
  return { usd: s.sum / s.n, ids: pool.map(a => a.id) }
}

/** Le coût moyen de l'orchestrateur sur les flows du journal, ou la valeur par défaut. */
function leadMoyen(journal: readonly JournalEntry[]): number {
  if (!journal.length) return DEFAUT_LEAD_USD
  const s = moyenne(journal.map(e => e.lead.costUsd))
  return s.sum / s.n
}

/** L'estimation d'un flow : la somme des agents du plan (moyenne du journal, sinon défaut) et de l'orchestrateur. */
export function estimate(plan: PlanInput, journal: readonly JournalEntry[]): BudgetEstimate {
  const used = new Set<string>()
  let usd = leadMoyen(journal)
  for (const a of plan.agents) {
    const h = agentHistorique(journal, a.model, a.effort)
    if (h) h.ids.forEach(id => used.add(id))
    usd += h ? h.usd : DEFAUT_AGENT_USD[a.model][a.effort]
  }
  return { usd, base: used.size ? 'historique' : 'defaut', flows: used.size }
}

/** Lit l'option `budget` : un nombre d'euros (« 15 », « 12,5 », « 12.5 »), ou undefined si ce n'en est pas un. */
function parseEuros(option: string): number | undefined {
  const t = option.trim()
  return /^\d+([.,]\d+)?$/.test(t) ? Number(t.replace(',', '.')) : undefined
}

/** Le plafond en dollars : « auto » (défaut, valeur illisible) = 2 × l'estimation, 2 € au moins ; « off » ou 0 = aucun ; un nombre = ce plafond en euros. */
export function ceilingOf(estimateUsd: number, option: string | undefined): number | undefined {
  const o = (option ?? 'auto').trim().toLowerCase()
  if (o === 'off') return undefined
  const eur = parseEuros(o)
  if (eur !== undefined) return eur > 0 ? eur / EUR_PER_USD : undefined
  return Math.max(estimateUsd * PLAFOND_FACTEUR, PLAFOND_PLANCHER_EUR / EUR_PER_USD)
}

/** L'état du flow : alerte à 80 % du plafond, atteint à 100 % ; sans plafond, ok. */
export function budgetState(spentUsd: number, ceilingUsd: number | undefined): BudgetEtat {
  if (ceilingUsd === undefined || ceilingUsd <= 0) return 'ok'
  const part = spentUsd / ceilingUsd
  return part >= 1 ? 'atteint' : part >= SEUIL_ALERTE ? 'alerte' : 'ok'
}

/** Le plafond relevé de 50 %. */
export const raise = (ceilingUsd: number): number => ceilingUsd * RELEVEMENT

/** La ligne du dialogue du plan : « Estimation ≈ 0,90 € (historique : 11 flows) · plafond 1,80 € ». */
export function budgetPlanLine(est: BudgetEstimate, ceilingUsd: number | undefined): string {
  const base = est.base === 'historique' ? `historique : ${est.flows} ${est.flows > 1 ? 'flows' : 'flow'}` : 'estimation par défaut'
  return `Estimation ≈ ${euros(est.usd)} (${base}) · ${ceilingUsd === undefined ? 'sans plafond' : `plafond ${euros(ceilingUsd)}`}`
}

/** Le segment de la bande : « 0,41 € / 1,80 € », ou le seul coût sans plafond. */
export const budgetSegment = (spentUsd: number, ceilingUsd: number | undefined): string =>
  ceilingUsd === undefined ? euros(spentUsd) : `${euros(spentUsd)} / ${euros(ceilingUsd)}`

/** La question posée quand le plafond est atteint (les réponses : BUDGET_CHOIX). */
export const budgetQuestion = (spentUsd: number, ceilingUsd: number): string =>
  `Le flow a dépensé ${euros(spentUsd)} pour un plafond de ${euros(ceilingUsd)}. Que faire ?`

/** Le toast de l'alerte à 80 % : « Budget à 82 % : 1,48 € sur 1,80 €. » */
export const budgetAlert = (spentUsd: number, ceilingUsd: number): string =>
  `Budget à ${Math.floor((spentUsd / ceilingUsd) * 100)} % : ${euros(spentUsd)} sur ${euros(ceilingUsd)}.`

/** Ce que le journal garde pour calibrer : estimé, plafond, réel, plafond atteint. */
export const budgetJournal = (est: BudgetEstimate, ceilingUsd: number | undefined, spentUsd: number, reached: boolean): BudgetJournal => ({
  estime: est.usd,
  ...(ceilingUsd === undefined ? {} : { plafond: ceilingUsd }),
  reel: spentUsd,
  atteint: reached,
})

// ── Le budget dans le flow (v3.6, branché par register.tsx) ──────────────

/** L'option `budget` telle que readOptions la garde : « auto » par défaut, sinon le texte saisi (« off », « 0 », « 12,5 ») en minuscules. */
export function budgetOption(raw: unknown): string {
  const t = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return t || 'auto'
}

/** Le coût d'un flow en cours : l'orchestrateur (éclaireurs compris) et ses agents, en dollars. */
export const flowCost = (flow: Pick<Flow, 'agents'>, lead: Pick<Lead, 'costUsd'>): number => lead.costUsd + flow.agents.reduce((n, a) => n + a.costUsd, 0)

/** Le budget posé à la validation du plan : l'estimation et le plafond qu'en tire l'option (absent : aucun). */
export function flowBudget(est: BudgetEstimate, ceilingUsd: number | undefined): FlowBudget {
  return { estime: est.usd, base: est.base, flows: est.flows, ...(ceilingUsd === undefined ? {} : { plafond: ceilingUsd }) }
}

/** L'estimation gardée dans le budget du flow, sous la forme que lisent budgetPlanLine et budgetJournal. */
export const estimateOf = (b: FlowBudget): BudgetEstimate => ({ usd: b.estime, base: b.base, flows: b.flows })

/** Ce que demande une dépense : l'alerte (80 %) ou la question (100 %), chacune une seule fois par plafond ; rien sans plafond. */
export function budgetAction(b: Pick<FlowBudget, 'plafond' | 'alerte' | 'question'>, spentUsd: number): 'alerte' | 'question' | undefined {
  if (b.plafond === undefined) return undefined
  const etat = budgetState(spentUsd, b.plafond)
  if (etat === 'atteint') return b.question === b.plafond ? undefined : 'question'
  return etat === 'alerte' && b.alerte !== b.plafond ? 'alerte' : undefined
}

/** Le champ budget du journal et du rapport pour un flow : son estimation, son dernier plafond, sa dépense, plafond atteint ou non. */
export const budgetOfFlow = (b: FlowBudget, spentUsd: number): BudgetJournal => budgetJournal(estimateOf(b), b.plafond, spentUsd, b.atteint === true)
