import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applyStep, finishTasks, parsePlan, progress } from './lib'

const ROOT = 'C:\\Users\\x\\Documents\\Front\\ui-vel'
const FILE = `${ROOT}\\components\\Basket.vue`
const NOW = Date.UTC(2026, 9, 12, 9)
const STEP_USAGE = { model: 'x', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 }

const PLAN = {
  titre: 'Code promo panier',
  resume: 'Un champ code promo dans le panier, validé côté GraphQL.',
  agents: [
    {
      nom: 'Front panier',
      role: 'Champ et affichage',
      modele: 'sonnet',
      effort: 'medium',
      taches: [{ titre: 'Lire le panier' }, { titre: 'Ajouter le champ', type: 'codage' }, { titre: 'Tester', type: 'test' }],
    },
    {
      nom: 'API promo',
      modele: 'opus',
      effort: 'high',
      taches: ['Lire le schéma', 'Ajouter la mutation', 'Écrire les tests', 'Relire', 'Documenter', 'Vérifier le lint', 'Synthèse'],
    },
  ],
}

function world(on: On) {
  mock.store(on, {})
  mock.env(on, { USERPROFILE: 'C:\\Users\\x' })
  const clock = mock.clock(on, { now: NOW })
  const sent: { text: string; context: readonly string[] }[] = []
  const opened: string[] = []
  let shown = false
  on('prompt.submit', (_$, e) => {
    sent.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'feat/promo\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.stat', () => ({ value: { realPath: ROOT, kind: 'directory' } }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { rateLimits: [] } }) as never)
  on('session.messages', () => ({ value: [] }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: {} as never }))
  on('ui.panes', () => ({ value: shown ? [{ id: 'revo-flow', title: 'revo-flow', isPlaced: true }] : [] }) as never)
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    shown = true
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => {
    shown = false
    return { value: undefined } as never
  })
  // L'état des agents tel que Claude Code le donne : un test le fait évoluer.
  const status: Record<string, string> = {}
  on('agent.list', () => ({ value: Object.entries(status).map(([id, st]) => ({ id, description: id, type: 'general-purpose', status: st })) }) as never)
  const prompts: string[] = []
  on('agent.spawn', (_$, e) => {
    prompts.push(e.prompt)
    const agentId = `a-${e.description.split(' ')[0]!.toLowerCase()}`
    status[agentId] = 'running'
    return { model: e.model ?? 'inherit', agentId } as never
  })
  on('turn.start', () => ({ turnId: 't' }))
  on('turn.complete', () => ({ text: '' }))
  // Ce que l'engine dessinerait sans le mod : une boîte vide.
  on('ui.render', (hook$, e) => h(hook$.ui.resolve(e).Box as never, {}) as never)
  return { clock, sent, opened, prompts, status }
}

const run = async ($: Engine, args: string) => (await $.command.run({ command: 'revo-flow', args } as never)).text ?? ''

async function launch($: Engine, w: ReturnType<typeof world>) {
  const r = await $.command.run({ command: 'revo-flow', args: 'ajoute un code promo dans le panier avec validation côté API' } as never)
  await w.clock.advance(1)
  await w.clock.settle()
  return r
}

async function drawn($: Engine, surface: 'terminal' | 'desktop', component: 'AbovePrompt' | 'Pane') {
  const ui = await $.ui.mount({
    plugin: 'revo-flow',
    surface,
    component,
    ...(component === 'Pane' ? { requestId: 'revo-flow' } : {}),
    props: { bodyColumns: 100, hasSurvey: false } as never,
  } as never)
  const texts = (await ui.findAll({ text: /./ })).map(x => x.text)
  const svgs = (await ui.findAll({ type: 'Svg' })).map(x => String(x.props.alt ?? ''))
  await ui.unmount()
  return { text: texts.join('\n'), alts: svgs.join('\n'), isEmpty: texts.length === 0 && svgs.length === 0 }
}

const spawn = ($: Engine, description: string) =>
  $.agent.spawn({ prompt: `Mission de ${description}`, description, subagentType: 'general-purpose', provider: { kind: 'model' } } as never)

// ── Sans la commande, le mod ne fait rien ────────────────────────────────

test('sans /revo-flow : aucune consigne ajoutée, aucune barre, aucun panneau', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: 'ajoute un code promo dans le panier avec validation', origin: { kind: 'composer' } } as never)
  expect(w.sent[0]!.context).toEqual([])
  const band = await drawn($, 'terminal', 'AbovePrompt')
  expect(band.text).not.toMatch(/revo-flow|Lire les specs/)
  expect(w.opened).toEqual([])
})

// ── Le flow complet ──────────────────────────────────────────────────────

test('/revo-flow : le panneau attend le plan, puis plan, répartition et exécution avec une barre par agent', async ($, on) => {
  const w = world(on)
  const sentSteps: string[] = []
  on('turn.step', async function* (_$, e) {
    sentSteps.push(`${e.agentId ?? 'main'}:${e.model}:${e.effort}`)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: STEP_USAGE } as never
  })

  // 1. La commande laisse le rôle d'orchestrateur en note cachée, puis envoie la demande telle quelle.
  const started = await launch($, w)
  expect(started.text).toMatch(/Opus 5\.5 lit la demande/)
  expect((started.context ?? []).join('\n')).toMatch(/tu es l'orchestrateur[\s\S]*mcp__revo-flow__plan/)
  expect(w.sent.map(x => x.text)).toEqual(['ajoute un code promo dans le panier avec validation côté API'])

  // Analyse des specs : le panneau dit seulement qu'il attend le plan d'exécution, sans aucun agent.
  await $.turn.start({ turnId: 't' } as never)
  await $.tool.call({ tool: 'Read', file_path: FILE } as never)
  let band = await drawn($, 'terminal', 'AbovePrompt')
  expect(band.text).toMatch(/Lire les specs et planifier 1\/4/)
  expect(w.opened).toEqual(['revo-flow'])
  let pane = await drawn($, 'desktop', 'Pane')
  expect(pane.alts).toMatch(/En attente du plan d’exécution/)
  expect(pane.alts).not.toMatch(/Orchestrateur|Front panier/)
  expect((await drawn($, 'terminal', 'Pane')).text).toMatch(/En attente du plan d’exécution/)

  // Aucun sous-agent avant le plan.
  const early = await spawn($, 'Explorer')
  expect(early.deny).toMatch(/aucun sous-agent avant le plan/)

  // 2. Le plan : un plan invalide est refusé, le bon est enregistré et dit qui lancer.
  const bad = await $.tool.call({ tool: 'mcp__revo-flow__plan', titre: 'x', agents: [{ nom: 'A', modele: 'gpt', effort: 'low', taches: ['t'] }] } as never)
  expect(JSON.stringify(bad)).toMatch(/modele doit être haiku, sonnet ou opus/)
  const ok = await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
  expect(JSON.stringify(ok)).toMatch(/« Front panier » .*Sonnet 5\.5, effort medium — 3 tâches/)
  pane = await drawn($, 'desktop', 'Pane')
  expect(pane.alts).toMatch(/Front panier, Sonnet 5\.5, Sonnet · medium, En attente/)

  // 3. Les agents sont lancés : modèle imposé, tâches ajoutées au prompt.
  const front = await spawn($, 'Front panier')
  const api = await spawn($, 'API promo')
  expect(front.model).toBe('claude-sonnet-5-5')
  expect(api.model).toBe('claude-opus-5-5')
  expect(w.prompts[0]).toMatch(/Mission de Front panier[\s\S]*1\. Lire le panier\n2\. Ajouter le champ\n3\. Tester[\s\S]*mcp__revo-flow__step/)

  // L'effort choisi pour chaque sous-agent est appliqué à ses requêtes ; l'orchestrateur garde le sien.
  const step = async (agentId: string | undefined, model: string) => {
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model, effort: 'high', messageCount: 1, ...(agentId ? { agentId } : {}) })) void _
  }
  await step('a-front', 'claude-sonnet-5-5')
  await step('a-api', 'claude-opus-5-5')
  await step(undefined, 'claude-opus-5-5')
  expect(sentSteps).toEqual(['a-front:claude-sonnet-5-5:medium', 'a-api:claude-opus-5-5:high', 'main:claude-opus-5-5:high'])

  // 4. Chaque agent a SA barre : 1/3 pour le front, 1/7 pour l'API, avec le titre de la tâche en cours.
  await $.tool.call({ tool: 'mcp__revo-flow__step', agentId: 'a-api', tache: 1, statut: 'en_cours' } as never)
  await $.tool.call({ tool: 'mcp__revo-flow__step', agentId: 'a-front', tache: 2, statut: 'en_cours' } as never)
  pane = await drawn($, 'desktop', 'Pane')
  expect(pane.alts).toMatch(/Orchestrateur, Opus 5\.5/)
  expect(pane.alts).toMatch(/Session : /)
  expect(pane.alts).toMatch(/Semaine : /)
  expect(pane.alts).not.toMatch(/Aujourd'hui/)
  expect(pane.alts).toMatch(/Front panier, Sonnet 5\.5, Sonnet · medium, Actif/)
  expect(pane.alts).toMatch(/Front panier : tâche 2\/3, Ajouter le champ/)
  expect(pane.alts).toMatch(/API promo, Opus 5\.5, Opus · high, Actif/)
  expect(pane.alts).toMatch(/API promo : tâche 1\/7, Lire le schéma/)
  const term = await drawn($, 'terminal', 'Pane')
  expect(term.text).toMatch(/Front panier[\s\S]*2\/3/)
  expect(term.text).toMatch(/▰▰▱\s+2\/3\s+Ajouter le champ/)
  expect(term.text).toMatch(/● Actif/)
  expect(term.text).toMatch(/Session[\s\S]*Semaine/)
  expect(term.text).not.toMatch(/Aujourd'hui/)

  // 5. Un agent en arrière-plan finit un tour mais tourne encore : il reste Actif.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'f', reason: 'answer', agentId: 'a-front' } as never)
  pane = await drawn($, 'desktop', 'Pane')
  expect(pane.alts).toMatch(/Front panier, Sonnet 5\.5, Sonnet · medium, Actif/)
  expect(pane.alts).toMatch(/Front panier : tâche 2\/3/)

  // Claude Code le dit fini : il passe Terminé (vu par la vérification périodique), 3/3.
  w.status['a-front'] = 'completed'
  await w.clock.advance(3000)
  await w.clock.settle()
  pane = await drawn($, 'desktop', 'Pane')
  expect(pane.alts).toMatch(/Front panier, Sonnet 5\.5, Sonnet · medium, Terminé/)
  expect(pane.alts).toMatch(/Front panier : tâche 3\/3/)
  // Le terminé descend en bas ; l'actif remonte juste sous l'orchestrateur.
  const order = pane.alts.split('\n').filter(l => /^(Orchestrateur|Front panier|API promo), /.test(l)).map(l => l.split(',')[0])
  expect(order).toEqual(['Orchestrateur', 'API promo', 'Front panier'])
  w.status['a-api'] = 'completed'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer', agentId: 'a-api' } as never)
  band = await drawn($, 'terminal', 'AbovePrompt')
  expect(band.text).toMatch(/Vérifier et conclure 4\/4/)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  band = await drawn($, 'terminal', 'AbovePrompt')
  expect(band.text).toMatch(/100%/)
  expect(await run($, 'statut')).toMatch(/Code promo panier — terminé/)
})

test('un agent lancé sous un autre nom prend le premier agent prévu encore libre ; un agent interrompu est en échec', async ($, on) => {
  const w = world(on)
  await launch($, w)
  await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
  const r = await spawn($, 'Quelque chose')
  expect(r.model).toBe('claude-sonnet-5-5')
  await $.tool.call({ tool: 'mcp__revo-flow__step', agentId: r.agentId, tache: 1, statut: 'fait' } as never)
  w.status[r.agentId!] = 'killed'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'q', reason: 'aborted', agentId: r.agentId } as never)
  const pane = await drawn($, 'desktop', 'Pane')
  expect(pane.alts).toMatch(/Front panier, Sonnet 5\.5, Sonnet · medium, Échec/)
  expect(pane.alts).toMatch(/API promo, Opus 5\.5, Opus · high, En attente/)
})

test('/revo-flow stop retire la barre ; /revo-flow sans flow le dit', async ($, on) => {
  const w = world(on)
  expect(await run($, '')).toMatch(/aucun flow en cours/)
  await launch($, w)
  expect(await run($, 'stop')).toMatch(/flow arrêté/)
  const band = await drawn($, 'terminal', 'AbovePrompt')
  expect(band.text).not.toMatch(/Lire les specs/)
})

// ── La logique pure ──────────────────────────────────────────────────────

test('parsePlan : valide les modèles, efforts et tâches', () => {
  const ok = parsePlan(PLAN as never)
  expect('plan' in ok && ok.plan.agents.map(a => `${a.key}:${a.model}:${a.effort}:${a.tasks.length}`)).toEqual([
    'front-panier:sonnet:medium:3',
    'api-promo:opus:high:7',
  ])
  expect(parsePlan({ titre: 'x', agents: [] })).toEqual({ error: '« agents » vide : prévois au moins un sous-agent.' })
  expect(parsePlan({ titre: 'x', agents: [{ nom: 'A', modele: 'haiku', effort: 'max', taches: ['a'] }] })).toEqual({
    error: 'Agent « A » : effort doit être low, medium, high ou xhigh.',
  })
})

test('progress : « n/total » sur la tâche en cours, le titre dessous, et total/total à la fin', () => {
  const tasks = ['A', 'B', 'C'].map(title => ({ title, kind: 'codage' as const, status: 'pending' as const }))
  expect(progress(tasks, 'waiting', false)).toMatchObject({ count: '0/3', label: 'En attente de lancement', percent: 0 })
  expect(progress(tasks, 'running', true)).toMatchObject({ count: '1/3', label: 'A' })
  const two = applyStep(tasks, 2, 'en_cours')!
  expect(two.map(t => t.status)).toEqual(['completed', 'in_progress', 'pending'])
  expect(progress(two, 'running', true)).toMatchObject({ count: '2/3', label: 'B', percent: 50 })
  expect(progress(finishTasks(two, false), 'done', false)).toMatchObject({ count: '3/3', percent: 100 })
  expect(finishTasks(two, true).map(t => t.status)).toEqual(['completed', 'failed', 'pending'])
  expect(applyStep(tasks, 9, 'fait')).toBeUndefined()
})
