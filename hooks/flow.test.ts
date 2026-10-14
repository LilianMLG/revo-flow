import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  LEAD_BRIEF,
  agentBrief,
  applyStep,
  finishTasks,
  flowRecap,
  fmtDuration,
  leadBrief,
  matchAgent,
  parsePlan,
  planQuestion,
  progress,
  remainingTasks,
} from './lib'
import type { Flow, FlowAgent } from '../types'
import { MACOS, WINDOWS, diskKey, native, type Os } from './test-os'

const rootOf = (os: Os) => native(os, 'Documents', 'Front', 'ui-vel')
const ROOT = rootOf(WINDOWS)
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

function world(on: On, os: Os = WINDOWS) {
  mock.store(on, {})
  mock.env(on, os.env)
  const clock = mock.clock(on, { now: NOW })
  const sent: { text: string; context: readonly string[] }[] = []
  const opened: string[] = []
  let shown = false
  on('prompt.submit', (_$, e) => {
    sent.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  // git : la branche feat/promo ; les fichiers suivis (ls-files) sont ceux que le test met dans `tracked`.
  const tracked: Record<string, string> = {}
  on('process.run', (_$, e) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.includes('ls-files')) return out(Object.entries(tracked).map(([p, h]) => `100644 ${h.padEnd(40, '0')} 0\t${p}\0`).join(''))
    if (e.argv.includes('status') || e.argv.includes('log') || e.argv.includes('diff')) return out('')
    if (e.argv.includes('--short')) return out('abc1234\n')
    return out('feat/promo\n')
  })
  on('fs.stat', () => ({ value: { realPath: rootOf(os), kind: 'directory' } }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { rateLimits: [], context: { window: 200000 } } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // Ce que le mod écrit dans son état partagé, dernière valeur par clé (la suite de la chaîne le garde).
  const states: Record<string, unknown> = {}
  on('state.set', (_$, e, next) => {
    const w = e as unknown as { key: string; value: unknown }
    states[w.key] = w.value
    return next(e)
  })
  on('session.messages', () => ({ value: [] }) as never)
  // Le dépôt de la session : le projet du cache.
  on('session.repo', () => ({ value: { root: rootOf(os), remote: null, internal: false, name: 'ui-vel' } }) as never)
  // Un disque en mémoire pour les graphes du cache (~/.claude/revo-flow/graphs) et les sources du projet ;
  // les clés sont celles de diskKey, la même pour un chemin Windows ou macOS.
  const disk: Record<string, string> = {}
  const at = diskKey
  on('fs.read', (_$, e) => (at(e.path) in disk ? { value: disk[at(e.path)]! } : { deny: `ENOENT ${e.path}` }) as never)
  on('fs.write', (_$, e) => {
    disk[at(e.path)] = e.text
    return { value: undefined } as never
  })
  on('fs.exists', (_$, e) => ({ value: at(e.path) in disk }) as never)
  const registered: string[] = []
  on('tool.register', (_$, e) => {
    registered.push((e as unknown as { name: string }).name)
    return { value: { tool: `mcp__revo-flow__${(e as unknown as { name: string }).name}` } } as never
  })
  on('command.register', () => ({ value: { command: 'revo-flow' } }) as never)
  on('agent.register', (_$, e) => ({ value: { agent: `revo-flow:${(e as unknown as { name: string }).name}` } }) as never)
  // Le dialogue ui.ask (outil AskUserQuestion) : la réponse est celle que le test décide ; sans réponse, il reste ouvert.
  const asked: string[] = []
  const notified: string[] = []
  const stopped: string[] = []
  const toasts: string[] = []
  const aborted: string[] = []
  const ctl: { answer: string | undefined; pending: ((a: string) => void) | undefined } = { answer: 'Lancer', pending: undefined }
  on('tool.call', (_$, e) => {
    if (e.tool === 'AskUserQuestion') {
      asked.push(JSON.stringify(e))
      const questions = (e as unknown as { questions: { question: string }[] }).questions
      const reply = (a: string) => ({ result: { questions, answers: { [questions[0]!.question]: a } } as never })
      if (ctl.answer !== undefined) return reply(ctl.answer)
      return new Promise<ReturnType<typeof reply>>(resolve => {
        ctl.pending = a => resolve(reply(a))
      })
    }
    if (e.tool === 'TaskStop') stopped.push(String((e as unknown as { task_id?: string }).task_id))
    return { result: {} as never }
  })
  on('ui.notify', (_$, e) => {
    notified.push(e.text)
    return { value: { isSent: true } } as never
  })
  on('ui.toast', (_$, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined } as never
  })
  on('turn.abort', (_$, e) => {
    aborted.push(e.turnId)
    return { value: undefined } as never
  })
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
  return { clock, sent, opened, prompts, status, ctl, asked, notified, stopped, toasts, aborted, registered, disk, states, tracked }
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

test('un Agent hors plan n’est pas suivi ; un agent interrompu est en échec', async ($, on) => {
  const w = world(on)
  w.ctl.answer = 'Lancer'
  await launch($, w)
  await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
  const stray = await spawn($, 'Quelque chose')
  expect(stray.model).toBe('inherit')
  const r = await spawn($, 'Front panier')
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

// ── Validation du plan ───────────────────────────────────────────────────

test('plan validé (« Lancer ») : le dialogue décrit le plan, puis agent.spawn est accepté', async ($, on) => {
  const w = world(on)
  w.ctl.answer = 'Lancer'
  await launch($, w)
  const ok = await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
  expect(JSON.stringify(ok)).toMatch(/plan « Code promo panier » enregistré/)
  expect(w.asked.length).toBe(1)
  expect(w.asked[0]!).toMatch(/Front panier — Sonnet 5\.5, effort medium, 3 tâches/)
  const r = await spawn($, 'Front panier')
  expect(r.deny).toBeUndefined()
  expect(r.model).toBe('claude-sonnet-5-5')
})

test('plan en attente de validation : agent.spawn refusé tant que l’utilisateur n’a pas répondu', async ($, on) => {
  const w = world(on)
  w.ctl.answer = undefined
  await launch($, w)
  const planned = $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
  await w.clock.settle()
  expect(w.ctl.pending).toBeDefined()
  const early = await spawn($, 'Front panier')
  expect(early.deny).toMatch(/attend la validation/)
  w.ctl.pending!('Lancer')
  await planned
  const r = await spawn($, 'Front panier')
  expect(r.deny).toBeUndefined()
  expect(r.model).toBe('claude-sonnet-5-5')
})

test('plan annulé : retour à la planification, aucun agent avant un nouveau plan', async ($, on) => {
  const w = world(on)
  w.ctl.answer = 'Annuler'
  await launch($, w)
  const res = await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
  expect(JSON.stringify(res)).toMatch(/plan annulé par l’utilisateur/)
  const r = await spawn($, 'Front panier')
  expect(r.deny).toMatch(/aucun sous-agent avant le plan/)
})

test('validerPlan désactivé : le plan part sans dialogue', { options: { validerPlan: false } }, async ($, on) => {
  const w = world(on)
  await launch($, w)
  await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
  expect(w.asked.length).toBe(0)
  expect((await spawn($, 'API promo')).model).toBe('claude-opus-5-5')
}, )

// ── Dernier tour, conflits, arrêt, notifications ────────────────────────

test('lastTurn : alimenté par turn.step puis figé par turn.complete, affiché sur la ligne de fin de tour', async ($, on) => {
  const w = world(on)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: STEP_USAGE } as never
  })
  await launch($, w)
  await $.turn.start({ turnId: 't' } as never)
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) void _
  let band = await drawn($, 'terminal', 'AbovePrompt')
  expect(band.text).toMatch(/Prompt en cours/)
  await $.turn.complete({
    answer: '',
    durationMs: 192000,
    isAborted: false,
    turnId: 't',
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
  } as never)
  band = await drawn($, 'terminal', 'AbovePrompt')
  expect(band.text).toMatch(/Dernier prompt/)
  expect(band.text).toMatch(/300 ↑/)
  const ui = await $.ui.mount({
    plugin: 'revo-flow',
    surface: 'terminal',
    component: 'TurnDuration',
    props: { word: 'Baked', durationMs: 192000 } as never,
  } as never)
  const text = (await ui.findAll({ text: /./ })).map(x => x.text).join('\n')
  await ui.unmount()
  expect(text).toMatch(/⏱ 3 m 12/)
  expect(text).toMatch(/300 in/)
  expect(text).toMatch(/80 out/)
})

async function twoRunning($: Engine, w: ReturnType<typeof world>) {
  await launch($, w)
  await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
  const front = await spawn($, 'Front panier')
  const api = await spawn($, 'API promo')
  return { front: front.agentId!, api: api.agentId! }
}

test('conflit de fichiers, mode avertir : un toast prévient et la modification passe', async ($, on) => {
  const w = world(on)
  const { front, api } = await twoRunning($, w)
  const first = await $.tool.call({ tool: 'Edit', file_path: FILE, agentId: front, tool_use_id: 'u1' } as never)
  expect(first.deny).toBeUndefined()
  const second = await $.tool.call({ tool: 'Edit', file_path: FILE, agentId: api, tool_use_id: 'u2' } as never)
  expect(second.deny).toBeUndefined()
  expect(w.toasts.join('\n')).toMatch(/aussi modifié par « Front panier »/)
})

test('conflit de fichiers, mode refuser : la modification du second agent est refusée', { options: { conflits: 'refuser' } }, async ($, on) => {
  const w = world(on)
  const { front, api } = await twoRunning($, w)
  await $.tool.call({ tool: 'Edit', file_path: FILE, agentId: front, tool_use_id: 'u1' } as never)
  const second = await $.tool.call({ tool: 'Edit', file_path: FILE, agentId: api, tool_use_id: 'u2' } as never)
  expect(second.deny).toMatch(/en cours de modification par l’agent « Front panier »/)
  expect(w.toasts.length).toBe(0)
})

test('/revo-flow stop : TaskStop sur chaque agent en cours, tour de l’orchestrateur interrompu', async ($, on) => {
  const w = world(on)
  const { front, api } = await twoRunning($, w)
  w.ctl.answer = 'Tout arrêter'
  await $.turn.start({ turnId: 'lead-1' } as never)
  const text = await run($, 'stop')
  expect(w.stopped.sort()).toEqual([api, front].sort())
  expect(w.aborted).toEqual(['lead-1'])
  expect(text).toMatch(/agents et orchestrateur interrompus/)
  expect(await run($, '')).toMatch(/aucun flow en cours/)
})

test('/revo-flow stop : « Garder les agents » ne touche à aucun agent', async ($, on) => {
  const w = world(on)
  await twoRunning($, w)
  w.ctl.answer = 'Garder les agents'
  const text = await run($, 'stop')
  expect(w.stopped).toEqual([])
  expect(w.aborted).toEqual([])
  expect(text).toMatch(/continuent jusqu’au bout/)
})

test('notification quand un agent échoue', async ($, on) => {
  const w = world(on)
  const { front } = await twoRunning($, w)
  w.status[front] = 'killed'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'q', reason: 'aborted', agentId: front } as never)
  expect(w.notified.join('\n')).toMatch(/agent « Front panier » en échec/)
})

test('notifier désactivé : aucune notification', { options: { notifier: false } }, async ($, on) => {
  const w = world(on)
  const { front } = await twoRunning($, w)
  w.status[front] = 'killed'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'q', reason: 'aborted', agentId: front } as never)
  expect(w.notified).toEqual([])
})

// ── Cache projet ─────────────────────────────────────────────────────────

const flowCacheOf = (w: ReturnType<typeof world>) => w.states.flowCache as { lus: unknown[] } | null | undefined

test('session.start : l’outil cache est enregistré tout de suite, sans attendre /revo-flow', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(w.registered).toContain('cache')
  expect(w.registered).not.toContain('plan')
})

test('cache désactivé : ni outil, ni brief, ni consigne sur le cache', { options: { cache: false } }, async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(w.registered).not.toContain('cache')
  const r = await launch($, w)
  expect(r.context?.length).toBe(1)
  expect((r.context ?? []).join('\n')).not.toMatch(/mcp__revo-flow__cache|Cache revo-flow/)
  await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
  await spawn($, 'Front panier')
  expect(w.prompts[0]).not.toMatch(/mcp__revo-flow__cache/)
})

test('/revo-flow cache clear sans graphe : réponse propre, rien supprimé', async ($, on) => {
  const w = world(on)
  expect(await run($, 'cache clear')).toMatch(/aucun graphe pour ui-vel, rien à supprimer/)
  expect(w.asked).toEqual([])
  expect(w.sent).toEqual([])
})

test('« cache le bouton panier en ES » est une demande ordinaire, pas la sous-commande', async ($, on) => {
  const w = world(on)
  const text = await run($, 'cache le bouton panier en ES')
  await w.clock.advance(1)
  expect(text).toMatch(/lit la demande/)
  expect(w.sent.map(x => x.text)).toEqual(['cache le bouton panier en ES'])
})

test('l’agent de construction revo-flow-cache passe en planification, sans entrer dans le flow', async ($, on) => {
  const w = world(on)
  await launch($, w)
  const builder = await spawn($, 'revo-flow-cache panier')
  expect(builder.deny).toBeUndefined()
  expect((await spawn($, 'Explorer')).deny).toMatch(/aucun sous-agent avant le plan/)
  expect((w.states.flow as Flow).agents).toEqual([])
})

for (const os of [WINDOWS, MACOS]) {
  describe(os.nom, () => {
    test('un Read d’un agent du flow alimente flowCache.lus (chemin relatif, tokens, qui)', async ($, on) => {
      const w = world(on, os)
      const { front } = await twoRunning($, w)
      await $.tool.call({ tool: 'Read', file_path: native(os, 'Documents', 'Front', 'ui-vel', 'components', 'Basket.vue'), limit: 40, agentId: front, tool_use_id: 'r1' } as never)
      // Hors flow (un agent inconnu) : rien n'est compté.
      await $.tool.call({ tool: 'Read', file_path: native(os, 'Documents', 'Front', 'ui-vel', 'components', 'Basket.vue'), agentId: 'inconnu', tool_use_id: 'r2' } as never)
      await w.clock.settle()
      expect(flowCacheOf(w)?.lus).toEqual([{ p: 'components/Basket.vue', tok: 120, par: 'front-panier' }])
    })

    test('outil cache : une erreur revient en texte, jamais en exception', async ($, on) => {
      const w = world(on, os)
      await launch($, w)
      const r = await $.tool.call({ tool: 'mcp__revo-flow__cache', action: 'nimporte' } as never)
      expect(JSON.stringify(r)).toMatch(/revo-flow cache : /)
      expect(r.deny).toBeUndefined()
    })

    /** Un projet ui-vel suivi par git : le panier et sa promo, lisibles sur le disque en mémoire. */
    function seedProject(w: ReturnType<typeof world>, os: Os) {
      const root = diskKey(rootOf(os))
      w.tracked['components/Basket.vue'] = 'a1a1a1a1a1a1'
      w.tracked['components/Promo.vue'] = 'b2b2b2b2b2b2'
      w.disk[`${root}/components/Basket.vue`] = `<template><Promo /></template>\n<script setup>\nimport Promo from './Promo.vue'\n</script>\n${'// panier\n'.repeat(40)}`
      w.disk[`${root}/components/Promo.vue`] = `<template><input /></template>\n${'// code promo\n'.repeat(20)}`
    }

    test('/revo-flow cache : construit le graphe, ouvre la section du panneau, texte au terminal', async ($, on) => {
      const w = world(on, os)
      seedProject(w, os)
      const text = await run($, 'cache')
      expect(text).toMatch(/revo-flow cache · ui-vel : 2 fichiers, 0 fiche/)
      expect(w.opened).toEqual(['revo-flow'])
      expect(w.states.cacheOpen).toBe(true)
      expect(w.states.cacheStats).toMatchObject({ projet: 'ui-vel', fichiers: 2 })
      expect(w.sent).toEqual([])
    })

    test('flow avec cache : fiche apprise, proposée au lancement, servie, puis complétée en fin de flow', async ($, on) => {
      const w = world(on, os)
      seedProject(w, os)
      // Une fiche apprise hors flow (manuel).
      const learned = await $.tool.call({
        tool: 'mcp__revo-flow__cache',
        action: 'apprendre',
        feature: 'panier',
        titre: 'Panier et code promo',
        alias: ['panier', 'code promo', 'basket'],
        resume: 'Le panier et son code promo : saisie, validation côté API, application.',
        fichiers: [{ p: 'components/Basket.vue', role: 'coeur' }, { p: 'components/Inconnu.vue', role: 'ui' }],
      } as never)
      expect(JSON.stringify(learned)).toMatch(/fiche « Panier et code promo » apprise \(1 fichier\)/)
      expect(JSON.stringify(learned)).toMatch(/Chemins rejetés, inconnus du projet : components\/Inconnu\.vue/)

      // Au lancement : confirmation, puis la fiche part dans le contexte avec le rôle d'orchestrateur.
      w.ctl.answer = 'Utiliser'
      const started = await launch($, w)
      expect(w.asked[0]).toMatch(/Je pense qu’il s’agit de « Panier et code promo » .confiance 0,[0-9]+. : utiliser la fiche du cache ./)
      expect(started.context?.length).toBe(2)
      expect(started.context?.[1]).toMatch(/Panier/)
      const fc = w.states.flowCache as { servis: { p: string; par: string }[]; feature?: string; injecte: number }
      expect(fc.feature).toBe('panier')
      expect(fc.servis.map(h => `${h.p}:${h.par}`)).toEqual(['components/Basket.vue:brief'])
      expect(fc.injecte).toBeGreaterThan(0)

      // Le flow tourne ; un agent lit un fichier hors fiche ; tout le monde finit sans « apprendre ».
      w.ctl.answer = 'Lancer'
      await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
      const front = (await spawn($, 'Front panier')).agentId!
      const api = (await spawn($, 'API promo')).agentId!
      await $.tool.call({ tool: 'Read', file_path: native(os, 'Documents', 'Front', 'ui-vel', 'components', 'Promo.vue'), limit: 10, agentId: front, tool_use_id: 'r1' } as never)
      await w.clock.settle()
      w.status[front] = 'completed'
      w.status[api] = 'completed'
      await w.clock.advance(3000)
      await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
      expect(w.notified.join('\n')).toMatch(/« Code promo panier » terminé .* fiche auto « panier »/)
      const saved = Object.values(w.disk).find(t => t.includes('"panier"') && t.includes('"features"'))!
      const graph = JSON.parse(saved) as { features: Record<string, { fichiers: { p: string; role: string }[]; usages: { servie: number } }> }
      expect(graph.features.panier!.fichiers.map(f => `${f.p}:${f.role}`)).toEqual(['components/Basket.vue:coeur', 'components/Promo.vue:peripherique'])
      expect(graph.features.panier!.usages.servie).toBe(1)
    })

    test('brief : « Ignorer » ne sert pas la fiche, le brief court part quand même', async ($, on) => {
      const w = world(on, os)
      seedProject(w, os)
      await $.tool.call({ tool: 'mcp__revo-flow__cache', action: 'apprendre', feature: 'panier', titre: 'Panier', alias: ['panier'], fichiers: [{ p: 'components/Basket.vue' }] } as never)
      w.ctl.answer = 'Ignorer'
      const started = await launch($, w)
      expect(started.context?.length).toBe(2)
      const fc = w.states.flowCache as { servis: unknown[]; feature?: string }
      expect(fc.servis).toEqual([])
      expect(fc.feature).toBeUndefined()
    })

    test('/revo-flow cache build <feature> : coût confirmé, agent revo-flow-cache lancé hors flow', async ($, on) => {
      const w = world(on, os)
      seedProject(w, os)
      w.ctl.answer = 'Construire'
      const text = await run($, 'cache build panier')
      expect(w.asked[0]).toMatch(/Construire la fiche « panier » pour ui-vel : ≈ 0,\d\d €/)
      expect(text).toMatch(/construction de « panier » lancée en arrière-plan/)
      expect(w.prompts[0]).toMatch(/Construis la fiche de la feature « panier » du projet « ui-vel »/)
      expect(w.prompts[0]).toContain(`projet = "${rootOf(os).replace(/\\/g, '/')}"`)
      // Ni flow, ni demande envoyée : la construction vit à côté.
      expect(w.states.flow ?? null).toBeNull()
      expect(w.sent).toEqual([])
    })

    test('/revo-flow cache build <feature> annulé : aucun agent', async ($, on) => {
      const w = world(on, os)
      seedProject(w, os)
      w.ctl.answer = 'Annuler'
      expect(await run($, 'cache build panier')).toMatch(/construction annulée/)
      expect(w.prompts).toEqual([])
    })
  })
}

test('LEAD_BRIEF : cache d’abord (une carte, pas la vérité), extrait aux agents, « apprendre » avant de conclure', () => {
  expect(LEAD_BRIEF).toMatch(/commence par le cache revo-flow/)
  expect(LEAD_BRIEF).toMatch(/carte, pas la vérité/)
  expect(LEAD_BRIEF).toMatch(/extrait de fiche du cache qui le concerne/)
  expect(LEAD_BRIEF).toMatch(/mcp__revo-flow__cache action « apprendre »/)
  expect(leadBrief(false)).not.toMatch(/cache/)
  expect(leadBrief(false)).toMatch(/1\. Plan : lis toi-même la demande/)
})

test('agentBrief : la ligne voisins seulement avec le cache', () => {
  const a = agentOf({ tasks: [{ title: 'Lire', kind: 'analyse', status: 'pending' }] })
  expect(agentBrief(a)).toMatch(/Avant un grep « qui utilise X », essaie mcp__revo-flow__cache action voisins\./)
  expect(agentBrief(a, false)).not.toMatch(/voisins/)
})

test('flowRecap : la ligne du cache après l’état des agents ; sans cache, aucune consigne sur le cache', () => {
  const flow = { id: '1', request: 'r', title: 'T', summary: '', phase: 'running', startedAt: 0, agents: [] } as unknown as Flow
  const line = 'Cache revo-flow (ui-vel) : fiche servie « panier » ; features connues : panier, promo.'
  expect(flowRecap(flow, line).endsWith(line)).toBe(true)
  expect(flowRecap(flow, false)).not.toMatch(/cache/i)
})

// ── Fonctions pures ──────────────────────────────────────────────────────

const agentOf = (over: Partial<FlowAgent>): FlowAgent =>
  ({
    key: 'front-panier',
    name: 'Front panier',
    model: 'sonnet',
    effort: 'medium',
    status: 'running',
    tasks: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    ...over,
  }) as unknown as FlowAgent

test('fmtDuration : secondes, minutes, heures', () => {
  expect(fmtDuration(0)).toBe('0 s')
  expect(fmtDuration(45_000)).toBe('45 s')
  expect(fmtDuration(59_600)).toBe('1 m 00')
  expect(fmtDuration(192_000)).toBe('3 m 12')
  expect(fmtDuration(3_840_000)).toBe('1 h 04')
  expect(fmtDuration(-5)).toBe('0 s')
})

test('remainingTasks : ni faites ni en échec', () => {
  const t = (title: string, status: string) => ({ title, kind: 'codage', status }) as never
  const a = agentOf({ tasks: [t('A', 'completed'), t('B', 'in_progress'), t('C', 'failed'), t('D', 'pending')] })
  expect(remainingTasks(a).map(x => x.title)).toEqual(['B', 'D'])
})

test('matchAgent : par nom, sans repli ; un Agent hors plan renvoie undefined', () => {
  const agents = [agentOf({ key: 'front-panier', status: 'waiting' }), agentOf({ key: 'api-promo', name: 'API promo', status: 'waiting' })]
  expect(matchAgent(agents, 'Front panier')?.key).toBe('front-panier')
  expect(matchAgent(agents, 'API promo')?.key).toBe('api-promo')
  expect(matchAgent(agents, 'Explorer le code')).toBeUndefined()
  expect(matchAgent(agents, '', undefined)).toBeUndefined()
  expect(matchAgent([{ ...agents[0]!, agentId: 'x' }], 'Front panier')).toBeUndefined()
})

test('planQuestion : titre, une ligne par agent, question finale', () => {
  const parsed = parsePlan(PLAN as never)
  if (!('plan' in parsed)) throw new Error('plan invalide')
  const q = planQuestion(parsed.plan)
  expect(q.split('\n')[0]).toBe('Plan « Code promo panier » : 2 agents.')
  expect(q).toMatch(/• Front panier — Sonnet 5\.5, effort medium, 3 tâches/)
  expect(q).toMatch(/• API promo — Opus 5\.5, effort high, 7 tâches/)
  expect(q.endsWith('Lancer ce plan ?')).toBe(true)
})

test('flowRecap : rôle d’orchestrateur, phase, et ce qui reste à chaque agent', () => {
  const t = (title: string, status: string) => ({ title, kind: 'codage', status }) as never
  const flow = {
    id: '1',
    request: 'r',
    title: 'Code promo panier',
    summary: 'Un champ code promo.',
    phase: 'running',
    startedAt: 0,
    agents: [
      agentOf({ tasks: [t('Lire', 'completed'), t('Coder', 'pending')] }),
      agentOf({ key: 'api', name: 'API promo', model: 'opus', effort: 'high', tasks: [t('Tout', 'completed')] }),
    ],
  } as unknown as Flow
  const r = flowRecap(flow)
  expect(r).toMatch(/orchestrateur/)
  expect(r).toMatch(/Code promo panier » — phase : agents au travail/)
  expect(r).toMatch(/Plan : Un champ code promo\./)
  expect(r).toMatch(/« Front panier » \(Sonnet 5\.5, effort medium\) \[running\] — reste : Coder/)
  expect(r).toMatch(/« API promo » .* plus rien à faire/)
  expect(flowRecap({ ...flow, agents: [], summary: '' })).toMatch(/Aucun agent prévu/)
})
