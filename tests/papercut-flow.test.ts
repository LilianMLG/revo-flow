// Papercuts, agent bloqué (v3.7) : tests d'intégration au niveau du mod (register.tsx), écrits d'après les critères C2 à C5, C7, C8
// et le contrat, pas d'après le code. Le monde de test est celui de tests/flow.test.ts, réduit à ce qu'un flow demande.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Flow, FlowAgent } from '../types'
import { WINDOWS, diskKey, native, type Os } from './helpers/os'

const rootOf = (os: Os) => native(os, 'Documents', 'Front', 'ui-vel')
const NOW = Date.UTC(2026, 10, 27, 9)
const PAPERCUT = 'mcp__revo-flow__papercut'
const STEP = 'mcp__revo-flow__step'

const PLAN = {
  titre: 'Code promo panier',
  resume: 'Un champ code promo dans le panier, validé côté GraphQL.',
  agents: [
    { nom: 'Front panier', role: 'Champ et affichage', modele: 'sonnet', effort: 'medium', taches: ['Lire le panier', 'Ajouter le champ'] },
    { nom: 'API promo', modele: 'opus', effort: 'high', taches: ['Lire le schéma', 'Ajouter la mutation'] },
  ],
}

/** Un papercut complet, tel qu'un sous-agent le signale. */
const SIGNALE = {
  cible: 'outil',
  outil: 'npm run lint',
  quoi: 'Lancer le lint du panier',
  attendu: 'La liste des erreurs du lint',
  obtenu: 'Option --format inconnue, aucune sortie',
  contournement: 'npx eslint components sans --format',
}

function world(on: On, os: Os = WINDOWS, store: Record<string, unknown> = {}) {
  // Le store du plugin en mémoire, lisible par le test ; une copie à chaque lecture et écriture.
  const copy = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as unknown))
  on('store.get', (_$, e) => ({ value: copy(store[e.key]) }) as never)
  on('store.set', (_$, e) => {
    store[e.key] = copy(e.value)
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => {
    delete store[e.key]
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: Object.keys(store) }) as never)
  mock.env(on, os.env)
  const clock = mock.clock(on, { now: NOW })
  const sent: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', (_$, e) => {
    sent.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  on('process.run', (_$, e) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.includes('ls-files')) return out('')
    if (e.argv.includes('status') || e.argv.includes('log') || e.argv.includes('diff')) return out('')
    if (e.argv.includes('--short')) return out('abc1234\n')
    if (e.argv.includes('hash-object')) return out('a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0\n')
    if (e.argv.includes('rev-parse') && !e.argv.includes('--abbrev-ref')) return out('c0ffee0000000000000000000000000000000000\n')
    return out('feat/promo\n')
  })
  on('fs.stat', () => ({ value: { realPath: rootOf(os), kind: 'directory' } }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { rateLimits: [], context: { window: 200000 } } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // Ce que le mod écrit dans son état partagé, dernière valeur par clé.
  const states: Record<string, unknown> = {}
  on('state.set', (_$, e, next) => {
    const w = e as unknown as { key: string; value: unknown }
    states[w.key] = w.value
    return next(e)
  })
  on('session.messages', () => ({ value: [] }) as never)
  on('session.repo', () => ({ value: { root: rootOf(os), remote: null, internal: false, name: 'ui-vel' } }) as never)
  // Un disque en mémoire (graphes du cache, plans, rapports).
  const disk: Record<string, string> = {}
  on('fs.read', (_$, e) => (diskKey(e.path) in disk ? { value: disk[diskKey(e.path)]! } : { deny: `ENOENT ${e.path}` }) as never)
  on('fs.write', (_$, e) => {
    disk[diskKey(e.path)] = e.text
    return { value: undefined } as never
  })
  on('fs.exists', (_$, e) => ({ value: diskKey(e.path) in disk }) as never)
  const registered: string[] = []
  on('tool.register', (_$, e) => {
    registered.push((e as unknown as { name: string }).name)
    return { value: { tool: `mcp__revo-flow__${(e as unknown as { name: string }).name}` } } as never
  })
  on('command.register', () => ({ value: { command: 'revo-flow' } }) as never)
  on('agent.register', (_$, e) => ({ value: { agent: `revo-flow:${(e as unknown as { name: string }).name}` } }) as never)
  // Le dialogue ui.ask (outil AskUserQuestion) : la réponse est celle que le test décide.
  const asked: string[] = []
  const toasts: string[] = []
  const ctl = { answer: 'Lancer' }
  on('session.surfaces', () => ({ value: ['terminal'] }) as never)
  on('tool.call', (_$, e) => {
    if (e.tool === 'AskUserQuestion') {
      asked.push(JSON.stringify(e))
      const questions = (e as unknown as { questions: { question: string }[] }).questions
      return { result: { questions, answers: { [questions[0]!.question]: ctl.answer } } as never }
    }
    // Un outil qui échoue : le test passe `echec` (le texte de l'erreur) ; l'outil rend un résultat en erreur.
    const echec = (e as unknown as { echec?: unknown }).echec
    if (typeof echec === 'string') return { result: echec as never, isError: true, text: echec } as never
    return { result: {} as never }
  })
  on('model.complete', () => {
    const usage = { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: false, reason: 'empty-reply', usage } } as never
  })
  on('ui.notify', () => ({ value: { isSent: true } }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('turn.abort', () => ({ value: undefined }) as never)
  let shown = false
  on('ui.panes', () => ({ value: shown ? [{ id: 'revo-flow', title: 'revo-flow', isPlaced: true }] : [] }) as never)
  on('ui.open', () => {
    shown = true
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => {
    shown = false
    return { value: undefined } as never
  })
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
  on('classic.Stop', () => ({}) as never)
  on('ui.render', (hook$, e) => h(hook$.ui.resolve(e).Box as never, {}) as never)
  return { clock, store, sent, prompts, status, ctl, asked, toasts, registered, disk, states }
}

type World = ReturnType<typeof world>

const run = async ($: Engine, args: string) => (await $.command.run({ command: 'revo-flow', args } as never)).text ?? ''

async function launch($: Engine, w: World, demande = 'ajoute un code promo dans le panier avec validation côté API') {
  const r = await $.command.run({ command: 'revo-flow', args: demande } as never)
  await w.clock.advance(1)
  await w.clock.settle()
  return r
}

const spawn = ($: Engine, description: string) =>
  $.agent.spawn({ prompt: `Mission de ${description}`, description, subagentType: 'general-purpose', provider: { kind: 'model' } } as never)

async function twoRunning($: Engine, w: World) {
  const r = await launch($, w)
  await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
  const front = (await spawn($, 'Front panier')).agentId!
  const api = (await spawn($, 'API promo')).agentId!
  return { front, api, context: (r.context ?? []).join('\n') }
}

const endTurn = async ($: Engine, w: World, agentId: string) => {
  w.status[agentId] = 'completed'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer', agentId } as never)
  await w.clock.settle()
}

/** Les deux agents finissent, puis le tour de l'orchestrateur : le flow se clôt (rapport et journal). */
async function finish($: Engine, w: World, front: string, api: string) {
  await endTurn($, w, front)
  await endTurn($, w, api)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await w.clock.settle()
}

const agentIn = (w: World, key: string) => (w.states.flow as Flow).agents.find(a => a.key === key)! as FlowAgent & { bloque?: { outil: string; suite: number; depuis: number } }
const papercutKeys = (w: World) => Object.keys(w.store).filter(k => k.startsWith('papercuts:'))
const storedPapercuts = (w: World) => (papercutKeys(w).length === 1 ? (w.store[papercutKeys(w)[0]!] as Record<string, unknown>[]) : [])
const rapportOf = (w: World) => Object.entries(w.disk).find(([k]) => k.includes('/rapports/'))?.[1] ?? ''
const contextOf = (r: unknown) => ((r as { context?: readonly string[] }).context ?? []).join('\n')

async function paneText($: Engine) {
  const ui = await $.ui.mount({ plugin: 'revo-flow', surface: 'terminal', component: 'Pane', requestId: 'revo-flow', props: { bodyColumns: 100, hasSurvey: false } as never } as never)
  const texts = (await ui.findAll({ text: /./ })).map(x => x.text)
  await ui.unmount()
  return texts.join('\n')
}

/** Un appel Bash d'un sous-agent qui échoue avec ce texte d'erreur. */
const bashKo = ($: Engine, agentId: string, erreur: string) => $.tool.call({ tool: 'Bash', command: 'npm run lint', agentId, echec: erreur } as never)
/** Trois erreurs différentes (pas la même signature) : c'est la suite de trois échecs qui alerte, pas la répétition. */
const ERREURS = ['npm ERR! missing script: lint', 'Permission refusée sur node_modules', 'Délai dépassé, processus tué']

// ── C2 : l'outil papercut ────────────────────────────────────────────────

test('C2 : un papercut signalé par un sous-agent est rangé sous le projet, répondu « noté », au panneau et au rapport', async ($, on) => {
  const w = world(on)
  const { front, api } = await twoRunning($, w)
  expect(w.registered).toContain('papercut')

  // Un papercut incomplet (sans « obtenu ») : l'erreur revient à l'agent, rien n'est rangé.
  const bad = await $.tool.call({ tool: PAPERCUT, agentId: front, quoi: 'Lancer le lint' } as never)
  expect(JSON.stringify(bad)).toMatch(/revo-flow papercut : /)
  expect(JSON.stringify(bad)).not.toMatch(/noté/)
  expect(storedPapercuts(w)).toEqual([])

  // Le papercut complet : réponse ok, rangé sous papercuts:<clé du projet>.
  const ok = await $.tool.call({ tool: PAPERCUT, agentId: front, ...SIGNALE } as never)
  expect(JSON.stringify(ok)).toMatch(/revo-flow papercut : noté \(pc-[^,\s]{8}, vu ×1\) ; merci, continue ta tâche\./)
  expect(papercutKeys(w)).toHaveLength(1)
  const list = storedPapercuts(w)
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({
    cible: 'outil',
    outil: 'npm run lint',
    quoi: SIGNALE.quoi,
    obtenu: SIGNALE.obtenu,
    contournement: SIGNALE.contournement,
    par: 'Front panier',
    flow: 'Code promo panier',
    vu: 1,
  })
  expect(String(list[0]!.id)).toMatch(/^pc-.{8}$/)

  // Le même papercut (cible, outil, erreur obtenue) signalé par un autre agent : fusionné, vu ×2.
  const again = await $.tool.call({ tool: PAPERCUT, agentId: api, ...SIGNALE } as never)
  expect(JSON.stringify(again)).toMatch(/revo-flow papercut : noté \(pc-[^,\s]{8}, vu ×2\)/)
  expect(storedPapercuts(w)).toHaveLength(1)
  expect(storedPapercuts(w)[0]).toMatchObject({ vu: 2, par: 'API promo' })

  // Le panneau : la ligne des papercuts (ce flow, au projet).
  expect(await paneText($)).toMatch(/papercuts\s*:\s*1\s*ce flow\s*·\s*1\s*au projet/)
})

test('C2 : le papercut signalé pendant le flow est dans la section « ## Papercuts et trajectoire » du rapport', async ($, on) => {
  const w = world(on)
  const { front, api } = await twoRunning($, w)
  await $.tool.call({ tool: PAPERCUT, agentId: front, ...SIGNALE } as never)
  await finish($, w, front, api)
  expect((w.states.flow as Flow).phase).toBe('done')
  const rapport = rapportOf(w)
  expect(rapport).toContain('## Papercuts et trajectoire')
  const section = rapport.slice(rapport.indexOf('## Papercuts et trajectoire'))
  expect(section).toContain(SIGNALE.quoi)
  expect(section).not.toMatch(/^\*Absent : aucun papercut signalé\.\*/m)
})

test('C2 : un flow sans papercut a la section « ## Papercuts et trajectoire » avec la ligne Absent', async ($, on) => {
  const w = world(on)
  const { front, api } = await twoRunning($, w)
  await finish($, w, front, api)
  const rapport = rapportOf(w)
  expect(rapport).toContain('## Papercuts et trajectoire')
  expect(rapport.slice(rapport.indexOf('## Papercuts et trajectoire'))).toContain('*Absent : aucun papercut signalé.*')
})

// ── C3 : les papercuts connus servent au flow suivant ───────────────────

test('C3 : un nouveau /revo-flow sur le même projet injecte « Papercuts connus du projet » à l’orchestrateur et à chaque sous-agent', async ($, on) => {
  const w = world(on)
  // Premier flow : aucun papercut connu, rien d'injecté.
  const first = await twoRunning($, w)
  expect(first.context).not.toMatch(/Papercuts connus du projet/)
  expect(w.prompts.join('\n')).not.toMatch(/Papercuts connus du projet/)
  await $.tool.call({ tool: PAPERCUT, agentId: first.front, ...SIGNALE } as never)

  // Second flow sur le même projet (il remplace le premier) : le contexte de l'orchestrateur et le prompt de chaque agent portent le papercut.
  w.prompts.length = 0
  w.ctl.answer = 'Remplacer'
  const second = await launch($, w, 'ajoute un bouton vider le panier')
  w.ctl.answer = 'Lancer'
  const lead = contextOf(second)
  expect(lead).toMatch(/## Papercuts connus du projet/)
  expect(lead).toContain(SIGNALE.quoi)
  expect(lead).toContain(SIGNALE.contournement)
  await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
  await spawn($, 'Front panier')
  await spawn($, 'API promo')
  expect(w.prompts).toHaveLength(2)
  for (const p of w.prompts) {
    expect(p).toMatch(/Papercuts connus du projet/)
    expect(p).toContain(SIGNALE.quoi)
    // À la fin du prompt : après la mission et la liste des tâches.
    expect(p.indexOf('Papercuts connus du projet')).toBeGreaterThan(p.indexOf('Mission de'))
  }
})

// ── C4 : l'agent bloqué ──────────────────────────────────────────────────

test('C4 : trois appels ratés de suite → toast « semble bloqué », bloque renseigné, consigne d’arrêt au 3e résultat ; un succès efface bloque', async ($, on) => {
  const w = world(on)
  const { front } = await twoRunning($, w)

  const r1 = await bashKo($, front, ERREURS[0]!)
  const r2 = await bashKo($, front, ERREURS[1]!)
  // Deux échecs : rien encore.
  expect(contextOf(r1)).not.toMatch(/échecs de suite/)
  expect(contextOf(r2)).not.toMatch(/échecs de suite/)
  expect(w.toasts.join('\n')).not.toMatch(/semble bloqué/)
  expect(agentIn(w, 'front-panier').bloque).toBeUndefined()

  // Le troisième : l'alerte.
  const r3 = await bashKo($, front, ERREURS[2]!)
  expect(w.toasts.filter(t => t.includes('revo-flow : « Front panier » semble bloqué (3 échecs de suite, dernier : Bash)'))).toHaveLength(1)
  expect(agentIn(w, 'front-panier').bloque).toMatchObject({ outil: 'Bash', suite: 3 })
  expect(typeof agentIn(w, 'front-panier').bloque!.depuis).toBe('number')
  const hint = contextOf(r3)
  expect(hint).toMatch(/revo-flow : 3 échecs de suite \(dernier : Bash\)\. Arrête de réessayer à l’identique/)
  expect(hint).toContain('mcp__revo-flow__papercut')
  // Le résultat de l'outil lui-même est rendu tel quel, en erreur.
  expect((r3 as { isError?: boolean }).isError).toBe(true)

  // Un quatrième échec : pas de second toast (alerte rendue une fois jusqu'au prochain succès).
  await bashKo($, front, 'Encore une autre erreur')
  expect(w.toasts.filter(t => t.includes('semble bloqué'))).toHaveLength(1)

  // Un succès efface bloque, sans consigne d'arrêt.
  const ok = await $.tool.call({ tool: 'Bash', command: 'npm run lint', agentId: front } as never)
  expect(contextOf(ok)).not.toMatch(/échecs de suite/)
  expect(agentIn(w, 'front-panier').bloque).toBeUndefined()
})

test('C4 : l’orchestrateur et l’outil papercut ne comptent pas dans la trajectoire d’un agent', async ($, on) => {
  const w = world(on)
  const { front } = await twoRunning($, w)
  // L'orchestrateur rate trois appels : pas d'alerte « semble bloqué ».
  for (const erreur of ERREURS) await $.tool.call({ tool: 'Bash', command: 'npm run lint', echec: erreur } as never)
  expect(w.toasts.join('\n')).not.toMatch(/semble bloqué/)
  // Un agent : deux échecs, un papercut (outil de revo-flow), un troisième échec → l'alerte vient au troisième échec de Bash.
  await bashKo($, front, ERREURS[0]!)
  await bashKo($, front, ERREURS[1]!)
  await $.tool.call({ tool: PAPERCUT, agentId: front, ...SIGNALE } as never)
  expect(agentIn(w, 'front-panier').bloque).toBeUndefined()
  const r3 = await bashKo($, front, ERREURS[2]!)
  expect(contextOf(r3)).toMatch(/3 échecs de suite \(dernier : Bash\)/)
  expect(agentIn(w, 'front-panier').bloque).toMatchObject({ outil: 'Bash', suite: 3 })
})

// ── C5 : la commande /revo-flow papercuts ────────────────────────────────

test('C5 : /revo-flow papercuts liste les papercuts du projet ; papercuts clear les efface après « Effacer »', async ($, on) => {
  const w = world(on)
  expect(await run($, 'papercuts')).toContain('revo-flow papercuts · ui-vel : aucun papercut signalé.')

  const { front } = await twoRunning($, w)
  await $.tool.call({ tool: PAPERCUT, agentId: front, ...SIGNALE } as never)
  const liste = await run($, 'papercuts')
  expect(liste).toMatch(/revo-flow papercuts · ui-vel : 1 papercut/)
  expect(liste).toContain(SIGNALE.quoi)
  expect(liste).toContain(SIGNALE.obtenu)
  expect(liste).toContain(SIGNALE.contournement)
  expect(liste).toContain('Front panier')

  // Annuler : rien n'est effacé.
  w.ctl.answer = 'Annuler'
  await run($, 'papercuts clear')
  expect(w.asked.at(-1)!).toMatch(/Effacer les 1 papercuts? de ui-vel \?/)
  expect(JSON.parse(w.asked.at(-1)!).questions[0].options.map((o: { label: string }) => o.label)).toEqual(['Effacer', 'Annuler'])
  expect(storedPapercuts(w)).toHaveLength(1)

  // Effacer : la clé du projet disparaît du store, la liste est vide.
  w.ctl.answer = 'Effacer'
  await run($, 'papercuts clear')
  expect(papercutKeys(w)).toEqual([])
  expect(await run($, 'papercuts')).toContain('revo-flow papercuts · ui-vel : aucun papercut signalé.')
})

// ── C7 : l'option papercuts coupée ───────────────────────────────────────

test('C7 : option papercuts à false : ni outil papercut, ni consigne d’agent bloqué, briefs sans l’outil papercut', { options: { papercuts: false } as never }, async ($, on) => {
  const w = world(on)
  const { front } = await twoRunning($, w)
  expect(w.registered).toEqual(expect.arrayContaining(['plan', 'step']))
  expect(w.registered).not.toContain('papercut')
  expect(w.prompts).toHaveLength(2)
  for (const p of w.prompts) {
    expect(p).not.toMatch(/mcp__revo-flow__papercut/)
    expect(p).not.toMatch(/Papercuts connus du projet/)
  }

  const results = []
  for (const erreur of ERREURS) results.push(await bashKo($, front, erreur))
  for (const r of results) expect(contextOf(r)).not.toMatch(/échecs de suite|mcp__revo-flow__papercut/)
  expect(w.toasts.join('\n')).not.toMatch(/semble bloqué/)
  expect(agentIn(w, 'front-panier').bloque).toBeUndefined()
  expect(papercutKeys(w)).toEqual([])
})

// ── C8 : le journal ──────────────────────────────────────────────────────

test('C8 : l’entrée de journal du flow compte ses papercuts et les échecs d’outils de ses sous-agents', async ($, on) => {
  const w = world(on)
  const { front, api } = await twoRunning($, w)
  // Trois échecs pour le front, un pour l'API, des succès entre ; un échec de l'orchestrateur ne compte pas.
  for (const erreur of ERREURS) await bashKo($, front, erreur)
  await $.tool.call({ tool: 'Bash', command: 'npm run lint', agentId: front } as never)
  await bashKo($, api, 'tsc introuvable')
  await $.tool.call({ tool: 'Bash', command: 'npm run lint', echec: 'erreur de l’orchestrateur' } as never)
  await $.tool.call({ tool: STEP, agentId: api, tache: 1, statut: 'en_cours' } as never)
  await $.tool.call({ tool: PAPERCUT, agentId: front, ...SIGNALE } as never)
  await $.tool.call({ tool: PAPERCUT, agentId: api, cible: 'projet', quoi: 'Lire la doc de l’API', obtenu: 'docs/api.md décrit une mutation supprimée' } as never)
  await finish($, w, front, api)

  const journal = w.store.journal as Record<string, unknown>[]
  expect(journal).toHaveLength(1)
  expect(journal[0]).toMatchObject({ title: 'Code promo panier', papercuts: 2, echecsOutils: 4 })
})

test('C8 : un flow sans papercut ni échec d’outil compte zéro (ou rien) au journal', async ($, on) => {
  const w = world(on)
  const { front, api } = await twoRunning($, w)
  await $.tool.call({ tool: 'Bash', command: 'npm run lint', agentId: front } as never)
  await finish($, w, front, api)
  const entry = (w.store.journal as Record<string, unknown>[])[0]!
  expect(entry.papercuts ?? 0).toBe(0)
  expect(entry.echecsOutils ?? 0).toBe(0)
})
