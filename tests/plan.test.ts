import { describe, expect, test } from 'claude-code/testing'

import {
  agentBrief,
  costUsd,
  dispatchText,
  failedDeps,
  flowRecap,
  launchDenial,
  modelLabel,
  leadBrief,
  outOfScope,
  parsePlan,
  pathsOverlap,
  planMarkdown,
  planQuestion,
  priceKey,
  readyAgents,
  runningTwin,
  waves,
} from '../hooks/lib'
import type { PlanInput } from '../hooks/lib'
import type { Flow, FlowAgent } from '../types'

const tache = { titre: 'Faire' }
const ag = (nom: string, over: Record<string, unknown> = {}) => ({ nom, modele: 'sonnet', effort: 'medium', taches: [tache], ...over })
const plan = (agents: unknown[]) => parsePlan({ titre: 'Un plan', agents })
const ok = (agents: unknown[]): PlanInput => {
  const r = plan(agents)
  if (!('plan' in r)) throw new Error(`plan refusé : ${r.error}`)
  return r.plan
}
const refus = (agents: unknown[]): string => {
  const r = plan(agents)
  if (!('error' in r)) throw new Error('plan accepté')
  return r.error
}

/** Un agent de flow à partir d'un agent du plan : lancé ou non, avec son état. */
const live = (a: PlanInput['agents'][number], status: FlowAgent['status'] = 'waiting', agentId?: string): FlowAgent =>
  ({ ...a, status, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, ...(agentId ? { agentId } : {}) }) as FlowAgent
const flowOf = (agents: FlowAgent[]): Flow => ({ title: 'Un plan', summary: '', phase: 'running', agents }) as unknown as Flow

// L'exemple du flow : porte et budget-rapport en parallèle, integration après porte, doc après tout, verificateur à la fin.
const ORDRE = [
  ag('porte', { fichiers: ['hooks/verif/**'] }),
  ag('plan', { fichiers: ['hooks/lib.ts', 'tests/plan.test.ts'] }),
  ag('integration', { apres: ['porte', 'plan'], fichiers: ['hooks/register.tsx'] }),
  ag('doc', { apres: ['integration'], fichiers: ['README.md'] }),
  ag('verificateur', { type: 'revo-flow:verifier', taches: ['Juger'] }),
]

describe('parsePlan : apres', () => {
  test('lit les noms ou les clés, les range en clés, sans doublon', () => {
    const p = ok([ag('Porte de fin'), ag('Plan'), ag('Integration', { apres: ['Porte de fin', 'plan', 'porte-de-fin'] })])
    expect(p.agents[2]!.after).toEqual(['porte-de-fin', 'plan'])
    expect(p.agents[0]!.after).toBeUndefined()
  })

  test('un nom inconnu est refusé, avec les noms possibles', () => {
    const e = refus([ag('A'), ag('B', { apres: ['Zorglub'] })])
    expect(e).toMatch(/Agent « B » : apres cite « Zorglub », qui n'est pas dans le plan/)
    expect(e).toMatch(/« A »/)
  })

  test('un agent qui se cite lui-même est refusé', () => {
    expect(refus([ag('A', { apres: ['a'] })])).toMatch(/Agent « A » : apres le cite lui-même/)
  })

  test('C5 : parsePlan refuse un cycle dans « apres » et le dit (a → b → a)', () => {
    const e = refus([ag('A', { apres: ['B'] }), ag('B', { apres: ['A'] })])
    expect(e).toMatch(/apres en cycle : « A » → « B » → « A »/)
    expect(refus([ag('A', { apres: ['C'] }), ag('B', { apres: ['A'] }), ag('C', { apres: ['B'] })])).toMatch(/« A » → « C » → « B » → « A »/)
  })

  test('un agent qui passe après le vérificateur fait un cycle (le vérificateur passe après tous)', () => {
    expect(refus([ag('A', { apres: ['V'] }), ag('V', { type: 'revo-flow:verifier' })])).toMatch(/apres en cycle/)
  })
})

describe('parsePlan : fichiers', () => {
  test('lit les chemins relatifs, un dossier devient un motif, sans doublon', () => {
    const p = ok([ag('A', { fichiers: ['./hooks\\lib.ts', 'hooks/lib.ts', 'tests/', ' '] })])
    expect(p.agents[0]!.files).toEqual(['hooks/lib.ts', 'tests/**'])
  })

  test('20 fichiers au plus', () => {
    const files = Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`)
    expect(refus([ag('A', { fichiers: files })])).toMatch(/Agent « A » : 21 fichiers, 20 au plus/)
    expect(ok([ag('A', { fichiers: files.slice(1) })]).agents[0]!.files).toHaveLength(20)
  })

  test('C5 : deux agents non ordonnés qui déclarent le même fichier sont refusés', () => {
    const e = refus([ag('A', { fichiers: ['hooks/lib.ts'] }), ag('B', { fichiers: ['hooks/lib.ts'] })])
    expect(e).toBe('« A » et « B » déclarent tous deux hooks/lib.ts : ordonne-les avec apres, ou redécoupe.')
  })

  test('ordonnés par apres, directement ou par transitivité, ils le peuvent', () => {
    expect(() => ok([ag('A', { fichiers: ['x.ts'] }), ag('B', { fichiers: ['x.ts'], apres: ['A'] })])).not.toThrow()
    const chaine = [ag('A', { fichiers: ['x.ts'] }), ag('B', { apres: ['A'] }), ag('C', { fichiers: ['x.ts'], apres: ['B'] })]
    expect(() => ok(chaine)).not.toThrow()
    expect(() => ok([ag('C', { fichiers: ['x.ts'], apres: ['B'] }), ag('B', { apres: ['A'] }), ag('A', { fichiers: ['x.ts'] })])).not.toThrow()
  })

  test('un chemin littéral attrapé par le motif de l’autre agent est un recouvrement', () => {
    const e = refus([ag('A', { fichiers: ['hooks/verif/**'] }), ag('B', { fichiers: ['hooks/verif/garde.ts'] })])
    expect(e).toMatch(/« A » et « B » déclarent tous deux hooks\/verif\/\*\* et hooks\/verif\/garde\.ts/)
    expect(() => ok([ag('A', { fichiers: ['hooks/verif/**'] }), ag('B', { fichiers: ['hooks/lib.ts', 'types/**'] })])).not.toThrow()
  })

  test('le vérificateur n’a pas à déclarer de fichiers ni à se faire ordonner', () => {
    expect(() => ok([ag('A', { fichiers: ['x.ts'] }), ag('V', { type: 'verifier', fichiers: ['x.ts'] })])).not.toThrow()
    expect(() => ok([ag('A'), ag('E', { type: 'Explore' })])).not.toThrow()
  })

  test('pathsOverlap : identiques, littéral et motif, deux motifs seulement par dossier', () => {
    expect(pathsOverlap('a/b.ts', 'a/b.ts')).toBe(true)
    expect(pathsOverlap('a/b.ts', 'a/c.ts')).toBe(false)
    expect(pathsOverlap('a/**', 'a/b/c.ts')).toBe(true)
    expect(pathsOverlap('a/b/c.ts', 'a/**')).toBe(true)
    expect(pathsOverlap('a/**', 'b/c.ts')).toBe(false)
    expect(pathsOverlap('a/**', 'a/b/**')).toBe(true)
    expect(pathsOverlap('a/b/**', 'a/**')).toBe(true)
    expect(pathsOverlap('a/**', 'b/**')).toBe(false)
    expect(pathsOverlap('a/*.ts', 'a/*.ts')).toBe(true)
  })

  test('pathsOverlap : un motif à plat n’atteint pas les sous-dossiers (« hooks/*.ts » et « hooks/verif/** » sont disjoints)', () => {
    expect(pathsOverlap('hooks/*.ts', 'hooks/verif/**')).toBe(false)
    expect(pathsOverlap('hooks/verif/**', 'hooks/*.ts')).toBe(false)
    expect(pathsOverlap('hooks/*.ts', 'hooks/**')).toBe(true)
    expect(pathsOverlap('hooks/*.ts', 'hooks/*.tsx')).toBe(true)
    expect(pathsOverlap('hooks/*.ts', 'tests/*.ts')).toBe(false)
    expect(pathsOverlap('hooks/*/x.ts', 'hooks/verif/**')).toBe(true)
    expect(() => ok([ag('A', { fichiers: ['hooks/*.ts'] }), ag('B', { fichiers: ['hooks/verif/**'] })])).not.toThrow()
  })
})

describe('waves, readyAgents, launchDenial, outOfScope', () => {
  const p = ok(ORDRE)

  test('waves : sans dépendance d’abord, le vérificateur dans la dernière vague', () => {
    expect(waves(p.agents)).toEqual([['porte', 'plan'], ['integration'], ['doc'], ['verificateur']])
    expect(waves(ok([ag('A'), ag('B')]).agents)).toEqual([['A', 'B']])
    expect(waves(ok([ag('A'), ag('V', { type: 'revo-flow:verifier' })]).agents)).toEqual([['A'], ['V']])
    expect(waves(ok([ag('V', { type: 'revo-flow:verifier' })]).agents)).toEqual([['V']])
  })

  test('readyAgents : les agents pas lancés dont toutes les dépendances ont fini', () => {
    const agents = p.agents.map(a => live(a))
    expect(readyAgents(flowOf(agents)).map(a => a.name)).toEqual(['porte', 'plan'])
    const byName = (n: string) => agents.find(a => a.name === n)!
    byName('porte').status = 'done'
    expect(readyAgents(flowOf(agents)).map(a => a.name)).toEqual(['plan'])
    byName('plan').status = 'done'
    expect(readyAgents(flowOf(agents)).map(a => a.name)).toEqual(['integration'])
    byName('integration').agentId = 'x'
    byName('integration').status = 'running'
    expect(readyAgents(flowOf(agents)).map(a => a.name)).toEqual([])
    byName('integration').status = 'done'
    byName('doc').status = 'done'
    expect(readyAgents(flowOf(agents)).map(a => a.name)).toEqual(['verificateur'])
  })

  test('readyAgents : un agent dont la dépendance a échoué n’est pas prêt', () => {
    const agents = ok([ag('A'), ag('B', { apres: ['A'] })]).agents.map(a => live(a))
    agents[0]!.status = 'failed'
    expect(readyAgents(flowOf(agents))).toEqual([])
  })

  test('launchDenial : nomme l’agent attendu, plusieurs au pluriel, rien une fois fini', () => {
    const agents = p.agents.map(a => live(a))
    const integration = agents.find(a => a.name === 'integration')!
    expect(launchDenial(flowOf(agents), agents[0]!)).toBeUndefined()
    expect(launchDenial(flowOf(agents), integration)).toBe(
      "revo-flow : « integration » passe après « porte » et « plan », qui n'ont pas fini. Lance-le quand « porte » et « plan » auront rendu leur rapport.",
    )
    agents[1]!.status = 'done'
    expect(launchDenial(flowOf(agents), integration)).toBe(
      "revo-flow : « integration » passe après « porte », qui n'a pas fini. Lance-le quand « porte » aura rendu son rapport.",
    )
    agents[0]!.status = 'done'
    expect(launchDenial(flowOf(agents), integration)).toBeUndefined()
  })

  test('revue de la PR #5 · attente croisée : une dépendance bloquée qui attend l’agent lui-même ne le retient pas, et il en est averti', () => {
    const agents = ok([ag('A', { apres: ['B'] }), ag('B')]).agents.map(a => live(a))
    const [a, b] = agents as [FlowAgent, FlowAgent]
    b.status = 'blocked'
    b.waitingFor = { key: a.key, name: a.name, since: 0 }
    expect(launchDenial(flowOf(agents), a)).toBeUndefined()
    expect(failedDeps(flowOf(agents), a).map(x => x.name)).toEqual(['B'])
    // Bloquée sur un tiers : elle sera relancée, « A » attend encore.
    b.waitingFor = { key: 'c', name: 'C', since: 0 }
    expect(launchDenial(flowOf(agents), a)).toMatch(/« A » passe après « B », qui n'a pas fini/)
  })

  test('revue de la PR #5 · runningTwin : un agent du plan déjà au travail, nommé une seconde fois, est reconnu ; fini ou autre nom, non', () => {
    const agents = ok([ag('Front panier'), ag('API promo')]).agents.map(a => live(a, 'running', 'id'))
    expect(runningTwin(agents, 'Front panier')?.name).toBe('Front panier')
    expect(runningTwin(agents, 'autre chose', 'api-promo')?.name).toBe('API promo')
    expect(runningTwin(agents, 'Revue rapide')).toBeUndefined()
    agents[0]!.status = 'done'
    expect(runningTwin(agents, 'Front panier')).toBeUndefined()
  })

  test('launchDenial : le vérificateur attend tous les autres sans le déclarer', () => {
    const agents = p.agents.map(a => live(a, 'done'))
    const verif = agents.find(a => a.name === 'verificateur')!
    verif.status = 'waiting'
    expect(launchDenial(flowOf(agents), verif)).toBeUndefined()
    agents.find(a => a.name === 'doc')!.status = 'running'
    expect(launchDenial(flowOf(agents), verif)).toMatch(/« verificateur » passe après « doc », qui n'a pas fini/)
  })

  test('launchDenial : un agent bloqué (il attend un agent qui ne viendra pas) n’empêche pas le vérificateur, comme dans allFinished', () => {
    const agents = p.agents.map(a => live(a, 'done'))
    const verif = agents.find(a => a.name === 'verificateur')!
    verif.status = 'waiting'
    agents.find(a => a.name === 'doc')!.status = 'blocked'
    expect(launchDenial(flowOf(agents), verif)).toBeUndefined()
    expect(readyAgents(flowOf(agents)).map(a => a.name)).toEqual(['verificateur'])
    // Un « apres » déclaré reste bloquant : « doc » attend « integration », bloqué.
    const doc = agents.find(a => a.name === 'doc')!
    doc.status = 'waiting'
    agents.find(a => a.name === 'integration')!.status = 'blocked'
    expect(launchDenial(flowOf(agents), doc)).toMatch(/« doc » passe après « integration »/)
  })

  test('launchDenial : une dépendance échouée ne refuse pas (l’orchestrateur décide), failedDeps la signale', () => {
    const agents = ok([ag('A'), ag('B', { apres: ['A'] })]).agents.map(a => live(a))
    agents[0]!.status = 'failed'
    expect(launchDenial(flowOf(agents), agents[1]!)).toBeUndefined()
    expect(failedDeps(flowOf(agents), agents[1]!).map(a => a.name)).toEqual(['A'])
    expect(failedDeps(flowOf(agents), agents[0]!)).toEqual([])
  })

  test('outOfScope : les chemins hors des fichiers déclarés ; [] sans déclaration', () => {
    const a = { files: ['hooks/lib.ts', 'hooks/verif/**', '*.md'] }
    expect(outOfScope(a, ['hooks/lib.ts', 'hooks/verif/scope.ts', 'hooks/verif/a/b.ts', 'README.md', 'hooks/budget.ts', './types/index.d.ts'])).toEqual([
      'hooks/budget.ts',
      './types/index.d.ts',
    ])
    expect(outOfScope({}, ['hooks/lib.ts'])).toEqual([])
    expect(outOfScope({ files: ['README.md'] }, ['docs/README.md'])).toEqual(['docs/README.md'])
    expect(outOfScope({ files: ['hooks/lib.ts'] }, ['.\\hooks\\lib.ts'])).toEqual([])
  })
})

describe('les textes', () => {
  const sans = ok([ag('Front panier'), ag('API promo', { modele: 'opus', effort: 'high' })])
  const avec = ok(ORDRE)

  test('sans apres ni fichiers, dispatchText, planQuestion et planMarkdown sont ceux d’avant', () => {
    expect(dispatchText(sans)).toBe(
      [
        'revo-flow : plan « Un plan » enregistré, 2 sous-agents : « Front panier » (general-purpose, Sonnet 5.5), « API promo » (general-purpose, Opus 5.5).',
        "Lance-les maintenant avec l'outil Agent (description = le nom exact entre guillemets). Un agent dont la description ne reprend pas un de ces noms n'est pas suivi.",
      ].join('\n'),
    )
    expect(planQuestion(sans)).toBe(
      ['Plan « Un plan » : 2 agents.', '• Front panier — Sonnet 5.5, effort medium, 1 tâche', '• API promo — Opus 5.5, effort high, 1 tâche', 'Lancer ce plan ?'].join('\n'),
    )
    expect(planMarkdown(sans)).not.toMatch(/après|Fichiers/)
    expect(planMarkdown(sans)).toMatch(/## 1\. Front panier\n\nSonnet 5\.5 · effort medium · general-purpose\n\n/)
  })

  test('un vérificateur passe après les autres : dispatchText ne fait lancer que la première vague (revue de la PR #5)', () => {
    const p = ok([ag('A'), ag('V', { type: 'revo-flow:verifier' })])
    const lines = dispatchText(p).split('\n')
    expect(lines[1]).toMatch(/^Lance maintenant « A » avec/)
    expect(lines[2]).toBe('Ensuite, quand « A » aura fini : « V ».')
    // Sans vérificateur ni « apres » : une seule vague, le texte d'avant.
    expect(dispatchText(ok([ag('A'), ag('B')]))).toMatch(/^Lance-les maintenant avec/m)
  })

  test('revue de la PR #5 : un motif sans « / » porte sur le nom du fichier partout, donc recouvre tout autre motif', () => {
    expect(pathsOverlap('*.test.ts', 'tests/**')).toBe(true)
    expect(pathsOverlap('hooks/**', '*.md')).toBe(true)
    // Deux motifs avec dossier restent jugés par leurs dossiers.
    expect(pathsOverlap('hooks/*.ts', 'hooks/verif/**')).toBe(false)
  })

  test('dispatchText : ce qu’il faut lancer maintenant, puis ce qui suit', () => {
    const lines = dispatchText(avec).split('\n')
    expect(lines[1]).toMatch(/^Lance maintenant « porte » et « plan » avec l'outil Agent \(description = le nom exact entre guillemets\)/)
    expect(lines.slice(2)).toEqual([
      'Ensuite, quand « porte » et « plan » auront fini : « integration ».',
      'Ensuite, quand « integration » aura fini : « doc ».',
      'Ensuite, quand « porte », « plan », « integration » et « doc » auront fini : « verificateur ».',
    ])
  })

  test('dispatchText : les agents qui attendent les mêmes sont groupés', () => {
    const p = ok([ag('A'), ag('B', { apres: ['A'] }), ag('C', { apres: ['A'] })])
    expect(dispatchText(p).split('\n').slice(1)[0]).toMatch(/^Lance maintenant « A » avec/)
    expect(dispatchText(p).split('\n')[2]).toBe('Ensuite, quand « A » aura fini : « B » et « C ».')
  })

  test('planQuestion et planMarkdown : après « x » et les fichiers déclarés', () => {
    expect(planQuestion(avec)).toMatch(/• integration — Sonnet 5\.5, effort medium, 1 tâche, après « porte » et « plan »\n/)
    expect(planQuestion(avec)).toMatch(/• porte — Sonnet 5\.5, effort medium, 1 tâche\n/)
    const md = planMarkdown(avec)
    expect(md).toMatch(/## 3\. integration\n\nSonnet 5\.5 · effort medium · general-purpose · après « porte » et « plan »\n\nFichiers : `hooks\/register\.tsx`\n/)
    expect(md).toMatch(/Fichiers : `hooks\/lib\.ts`, `tests\/plan\.test\.ts`/)
  })

  test('agentBrief : le périmètre seulement si l’agent a des fichiers', () => {
    const [porte, , , , verif] = avec.agents.map(a => live(a))
    expect(agentBrief(porte!)).toMatch(/Ton périmètre : hooks\/verif\/\*\* ; un fichier hors de ce périmètre sera signalé dans le rapport\./)
    expect(agentBrief(verif!)).not.toMatch(/périmètre/)
    expect(agentBrief(live(sans.agents[0]!))).not.toMatch(/périmètre/)
  })

  test('flowRecap : « après » sur la ligne d’un agent pas encore lancé, plus une fois lancé', () => {
    const agents = avec.agents.map(a => live(a))
    expect(flowRecap(flowOf(agents))).toMatch(/- « integration » \(Sonnet 5\.5, effort medium\) \[waiting\] après « porte » et « plan » · fichiers : hooks\/register\.tsx — /)
    // Les fichiers déclarés restent sur la ligne jusqu'à la fin de l'agent.
    agents[0]!.status = 'done'
    expect(flowRecap(flowOf(agents))).toMatch(/- « porte » \(Sonnet 5\.5, effort medium\) \[done\] — /)
    agents[2]!.agentId = 'x'
    agents[2]!.status = 'running'
    expect(flowRecap(flowOf(agents))).not.toMatch(/\[running\] après/)
    expect(flowRecap(flowOf(sans.agents.map(a => live(a))))).not.toMatch(/\] après/)
  })

  test('leadBrief : questions, apres et fichiers, qualité des critères ; compact', () => {
    const brief = leadBrief(true)
    expect(brief).toMatch(/AskUserQuestion/)
    expect(brief).toMatch(/fichiers \(chemins ou motifs relatifs à la racine qu'il modifiera, 20 au plus\) et apres/)
    expect(brief).toMatch(/« non vérifiable »/)
    expect(brief.match(/sans modifier les mêmes fichiers/g)).toHaveLength(1)
    expect(leadBrief(true, false)).not.toMatch(/non vérifiable/)
  })
})

describe('coût par modèle', () => {
  const proche = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9)
  const million = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }

  test('priceKey : Fable et Mythos ont leur tarif ; haiku, sonnet, opus le leur ; un modèle inconnu, aucun', () => {
    expect(['claude-fable-5-2', 'claude-mythos-5-2', 'Claude-Fable-5-2[1m]'].map(priceKey)).toEqual(['fable', 'fable', 'fable'])
    expect(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(priceKey)).toEqual(['opus', 'sonnet', 'haiku'])
    expect(priceKey('gpt-x')).toBeUndefined()
  })

  test('costUsd : un orchestrateur sur Fable n’est plus compté à 0 (8 $ entrée, 40 $ sortie, 0,20 $ lecture, 10 $ écriture par million)', () => {
    proche(costUsd('claude-fable-5-2', million), 8 + 40 + 0.2 + 10)
    proche(costUsd('claude-opus-5-5', million), 4 + 20 + 0.2 + 5)
    // Sonnet 5.5 : lecture de cache à 0,10 $.
    proche(costUsd('claude-sonnet-5-5', million), 2 + 10 + 0.1 + 2.5)
    expect(costUsd('modele-inconnu', million)).toBe(0)
  })

  test('revue de la PR #6 · un Sonnet d’avant le 5.5 garde sa lecture de cache à 0,20 $ ; Mythos a son libellé', () => {
    expect(['claude-sonnet-5', 'claude-sonnet-4-6'].map(priceKey)).toEqual(['sonnetAncien', 'sonnetAncien'])
    proche(costUsd('claude-sonnet-5', million), 2 + 10 + 0.2 + 2.5)
    expect(modelLabel('claude-mythos-5-2')).toBe('Mythos 5.2')
    expect(modelLabel('claude-fable-5-2')).toBe('Fable 5.2')
  })
})
