import { expect, test } from 'claude-code/testing'

import {
  BUDGET_CHOIX,
  BUDGET_HONNETETE,
  DEFAUT_AGENT_USD,
  DEFAUT_LEAD_USD,
  budgetAction,
  budgetAlert,
  budgetJournal,
  budgetOfFlow,
  budgetOption,
  budgetPlanLine,
  budgetQuestion,
  budgetSegment,
  budgetState,
  ceilingOf,
  estimate,
  estimateOf,
  flowBudget,
  flowCost,
  raise,
} from '../hooks/budget'
import { EUR_PER_USD, type JournalEntry, type PlanInput } from '../hooks/lib'

/** Égalité à la précision des flottants près. */
const proche = (a: number | undefined, b: number) => expect(Math.abs((a ?? Number.NaN) - b) < 1e-9).toBe(true)

/** Des euros en dollars, pour écrire les plafonds comme l'utilisateur les lit. */
const usd = (eur: number) => eur / EUR_PER_USD

const plan = (...agents: [string, string][]): PlanInput =>
  ({ title: 't', summary: '', agents: agents.map(([model, effort], i) => ({ key: `a${i}`, name: `a${i}`, model, effort, tasks: [] })) }) as never

/** Un flow du journal : l'orchestrateur à `lead` dollars, des agents [modèle, effort, coût]. */
const flow = (id: string, lead: number, ...agents: [string, string, number][]): JournalEntry =>
  ({ id, lead: { modelId: 'm', costUsd: lead, tokens: 0 }, agents: agents.map(([model, effort, costUsd]) => ({ name: 'x', model, effort, costUsd, status: 'done' })) }) as never

test('estimate : sans historique, les valeurs par défaut par modèle et effort, plus l\'orchestrateur', () => {
  const e = estimate(plan(['sonnet', 'medium'], ['opus', 'high']), [])
  expect(e.base).toBe('defaut')
  expect(e.flows).toBe(0)
  proche(e.usd, DEFAUT_LEAD_USD + DEFAUT_AGENT_USD.sonnet.medium + DEFAUT_AGENT_USD.opus.high)
})

test('estimate : avec au moins 3 agents du modèle, la moyenne du journal ; l\'orchestrateur aussi', () => {
  const journal = [flow('1', 0.5, ['sonnet', 'low', 1]), flow('2', 1.5, ['sonnet', 'high', 2]), flow('3', 1, ['sonnet', 'medium', 3])]
  const e = estimate(plan(['sonnet', 'xhigh']), journal)
  // 3 agents sonnet, aucun en xhigh : moyenne par modèle (2) ; orchestrateur moyen (1).
  proche(e.usd, 3)
  expect(e.base).toBe('historique')
  expect(e.flows).toBe(3)
})

test('revue de la PR #5 · estimate : un flow arrêté et un agent qui n\'a pas fini n\'entrent pas dans la moyenne', () => {
  const journal = [flow('1', 0.5, ['sonnet', 'low', 1]), flow('2', 1.5, ['sonnet', 'high', 2]), flow('3', 1, ['sonnet', 'medium', 3])]
  const base = estimate(plan(['sonnet', 'xhigh']), journal).usd
  // Un flow arrêté par le budget : deux agents jamais lancés à 0 $, un orchestrateur coupé court.
  const arrete = { ...flow('4', 0.1, ['sonnet', 'low', 0], ['sonnet', 'low', 0]), isStopped: true } as JournalEntry
  // Un flow allé au bout, dont un agent a échoué en route (coût partiel).
  const echec = flow('5', 1, ['sonnet', 'low', 0.01])
  ;(echec.agents[0] as { status: string }).status = 'failed'
  const e = estimate(plan(['sonnet', 'xhigh']), [...journal, arrete, echec])
  // Les agents : toujours la moyenne des 3 finis (2) ; l'orchestrateur : les 4 flows allés au bout (0,5 + 1,5 + 1 + 1) / 4 = 1.
  proche(e.usd, base)
  expect(e.flows).toBe(3)
})

test('revue de la PR #6 · estimate : un orchestrateur compté à 0 ne tire pas la moyenne ; l\'orchestrateur s\'estime sur sa famille de modèle', () => {
  const mene = (id: string, modelId: string, lead: number) => ({ ...flow(id, lead), lead: { modelId, costUsd: lead, tokens: 0 } }) as JournalEntry
  const p = plan()
  // Dix flows menés par Fable et comptés à 0 (avant que Fable ait un tarif) : ignorés, la valeur par défaut de Fable (2 × celle d'Opus).
  const zeros = Array.from({ length: 10 }, (_, i) => mene(`z${i}`, 'claude-fable-5-2', 0))
  proche(estimate(p, zeros, 'claude-fable-5-2').usd, DEFAUT_LEAD_USD * 2)
  // Des flows menés par Opus ne disent rien d'un orchestrateur Fable ; un flow mené par Fable au vrai tarif, si.
  const opus = [mene('o1', 'claude-opus-5-5', 1), mene('o2', 'claude-opus-5-5', 3)]
  proche(estimate(p, [...zeros, ...opus], 'claude-fable-5-2').usd, DEFAUT_LEAD_USD * 2)
  proche(estimate(p, [...zeros, ...opus, mene('f', 'claude-mythos-5-2', 6)], 'claude-fable-5-2').usd, 6)
  proche(estimate(p, [...zeros, ...opus], 'claude-opus-5-5').usd, 2)
  // Sans modèle de session : tous les orchestrateurs au coût connu comptent, les zéros toujours pas.
  proche(estimate(p, [...zeros, ...opus]).usd, 2)
})

test('estimate : moins de 3 agents du modèle, retour à la valeur par défaut (mais le lead vient du journal)', () => {
  const journal = [flow('1', 2, ['sonnet', 'low', 1]), flow('2', 2, ['sonnet', 'low', 1])]
  const e = estimate(plan(['sonnet', 'low']), journal)
  expect(e.base).toBe('defaut')
  proche(e.usd, 2 + DEFAUT_AGENT_USD.sonnet.low)
})

test('estimate : affinage par effort avec au moins 3 agents du même effort, sinon par modèle', () => {
  const journal = [
    flow('1', 0, ['opus', 'high', 4], ['opus', 'high', 4], ['opus', 'high', 4]),
    flow('2', 0, ['opus', 'low', 1]),
  ]
  // 3 opus high à 4 : un agent high coûte 4 ; un agent low retombe sur la moyenne du modèle (13 / 4 = 3,25).
  // Les orchestrateurs du journal sont à 0 : ils ne comptent pas (un orchestrateur ne coûte jamais 0), la valeur par défaut s'ajoute.
  proche(estimate(plan(['opus', 'high']), journal).usd, 4 + DEFAUT_LEAD_USD)
  proche(estimate(plan(['opus', 'low']), journal).usd, 3.25 + DEFAUT_LEAD_USD)
})

test('ceilingOf : auto = 2 × l\'estimation, plancher de 2 €', () => {
  proche(ceilingOf(usd(3), 'auto'), usd(6))
  proche(ceilingOf(usd(0.5), 'auto'), usd(2))
  proche(ceilingOf(usd(3), undefined), usd(6))
})

test('ceilingOf : off ne met aucun plafond', () => {
  expect(ceilingOf(5, 'off')).toBeUndefined()
  expect(ceilingOf(5, ' OFF ')).toBeUndefined()
})

test('ceilingOf : un nombre en euros, entier ou à virgule', () => {
  proche(ceilingOf(5, '15'), usd(15))
  proche(ceilingOf(5, '12,5'), usd(12.5))
  proche(ceilingOf(5, '12.5'), usd(12.5))
  expect(ceilingOf(5, '0')).toBeUndefined()
})

test('ceilingOf : une valeur illisible vaut auto', () => {
  for (const bad of ['beaucoup', '-3', '12 euros', '']) proche(ceilingOf(usd(3), bad), usd(6))
})

test('budgetState : alerte à 80 %, atteint à 100 %, ok en dessous et sans plafond', () => {
  expect(budgetState(79, 100)).toBe('ok')
  expect(budgetState(80, 100)).toBe('alerte')
  expect(budgetState(99, 100)).toBe('alerte')
  expect(budgetState(100, 100)).toBe('atteint')
  expect(budgetState(250, 100)).toBe('atteint')
  expect(budgetState(1000, undefined)).toBe('ok')
})

test('raise : le plafond relevé de 50 %', () => {
  proche(raise(2), 3)
})

test('budgetPlanLine : historique, valeur par défaut, sans plafond', () => {
  expect(budgetPlanLine({ usd: usd(0.9), base: 'historique', flows: 11 }, usd(1.8))).toBe('Estimation ≈ 0,90 € (historique : 11 flows) · plafond 1,80 €')
  expect(budgetPlanLine({ usd: usd(0.9), base: 'historique', flows: 1 }, usd(1.8))).toContain('historique : 1 flow)')
  expect(budgetPlanLine({ usd: usd(0.9), base: 'defaut', flows: 0 }, usd(1.8))).toBe('Estimation ≈ 0,90 € (estimation par défaut) · plafond 1,80 €')
  expect(budgetPlanLine({ usd: usd(0.9), base: 'defaut', flows: 0 }, undefined)).toBe('Estimation ≈ 0,90 € (estimation par défaut) · sans plafond')
})

test('budgetSegment : le coût sur le plafond, ou le seul coût', () => {
  expect(budgetSegment(usd(0.41), usd(1.8))).toBe('0,41 € / 1,80 €')
  expect(budgetSegment(usd(0.41), undefined)).toBe('0,41 €')
})

test('à 100 % du plafond, la question propose Arrêter, +50 % ou Laisser finir', () => {
  expect(budgetQuestion(usd(1.84), usd(1.8))).toBe('Le flow a dépensé 1,84 € pour un plafond de 1,80 €. Que faire ?')
  expect([...BUDGET_CHOIX]).toEqual(['Arrêter', '+50 %', 'Laisser finir'])
})

test('budgetAlert : le toast à 80 % dit la part, le dépensé et le plafond', () => {
  expect(budgetAlert(usd(1.48), usd(1.8))).toBe('Budget à 82 % : 1,48 € sur 1,80 €.')
})

test('budgetJournal : estimé, plafond (absent sans plafond), réel, atteint ; et la mention d\'honnêteté', () => {
  const est = { usd: 1, base: 'defaut' as const, flows: 0 }
  expect(budgetJournal(est, 2, 2.5, true)).toEqual({ estime: 1, plafond: 2, reel: 2.5, atteint: true })
  expect(budgetJournal(est, undefined, 0.5, false)).toEqual({ estime: 1, reel: 0.5, atteint: false })
  expect(BUDGET_HONNETETE).toContain('estimation')
})

test('C7 · budgetAction : l’alerte à 80 %, la question à 100 %, chacune une fois par plafond ; rien sans plafond', () => {
  expect(budgetAction({ plafond: 1 }, 0.5)).toBeUndefined()
  expect(budgetAction({ plafond: 1 }, 0.8)).toBe('alerte')
  expect(budgetAction({ plafond: 1, alerte: 1 }, 0.9)).toBeUndefined()
  expect(budgetAction({ plafond: 1, alerte: 1 }, 1)).toBe('question')
  expect(budgetAction({ plafond: 1, alerte: 1, question: 1 }, 1.4)).toBeUndefined()
  // Plafond relevé (+50 %) : l'alerte et la question repartent pour le nouveau plafond.
  expect(budgetAction({ plafond: 1.5, alerte: 1, question: 1 }, 1.3)).toBe('alerte')
  expect(budgetAction({ plafond: 1.5, alerte: 1.5, question: 1 }, 1.5)).toBe('question')
  // D'un coup au-delà du plafond : la question seule.
  expect(budgetAction({ plafond: 1 }, 2)).toBe('question')
  expect(budgetAction({}, 100)).toBeUndefined()
})

test('budgetOption : auto par défaut, le texte saisi en minuscules, un nombre gardé tel quel', () => {
  expect(budgetOption(undefined)).toBe('auto')
  expect(budgetOption('  ')).toBe('auto')
  expect(budgetOption(' OFF ')).toBe('off')
  expect(budgetOption('12,5')).toBe('12,5')
  expect(budgetOption(15)).toBe('15')
  expect(budgetOption(true)).toBe('auto')
})

test('flowBudget, estimateOf, budgetOfFlow, flowCost : le budget du flow, du plan au journal', () => {
  const est = { usd: 0.9, base: 'historique' as const, flows: 11 }
  const b = flowBudget(est, 1.8)
  expect(b).toEqual({ estime: 0.9, base: 'historique', flows: 11, plafond: 1.8 })
  expect(flowBudget(est, undefined)).toEqual({ estime: 0.9, base: 'historique', flows: 11 })
  expect(estimateOf(b)).toEqual(est)
  expect(budgetOfFlow({ ...b, atteint: true }, 2.1)).toEqual({ estime: 0.9, plafond: 1.8, reel: 2.1, atteint: true })
  expect(budgetOfFlow({ estime: 0.9, base: 'defaut', flows: 0 }, 0.4)).toEqual({ estime: 0.9, reel: 0.4, atteint: false })
  proche(flowCost({ agents: [{ costUsd: 0.25 }, { costUsd: 0.5 }] } as never, { costUsd: 0.1 }), 0.85)
})
