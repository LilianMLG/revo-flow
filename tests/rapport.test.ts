import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { rapportMarkdown, type RapportInput } from '../hooks/rapport'
import type { Entry, Flow, Lead, WebView } from '../types'
import { OSES, WINDOWS, diskKey, native, type Os } from './helpers/os'

const rootOf = (os: Os) => native(os, 'Documents', 'Front', 'ui-vel')
const ROOT = rootOf(WINDOWS)
const NOW = Date.UTC(2026, 9, 12, 9)

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
  // git diff <blob> <blob> (action diff du cache) : la sortie que le test décide, et les appels reçus.
  const gitDiff = { out: '', calls: [] as string[][] }
  const runs: string[][] = []
  // Les hash git des fichiers (hash-object) et la sortie de tsc, que les tests de la vérification font varier.
  const hashes: Record<string, string> = {}
  const verifRun = { tsc: { exitCode: 0, stdout: '', stderr: '' } }
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv.includes('--unified=3')) {
      gitDiff.calls.push([...e.argv])
      return out(gitDiff.out)
    }
    if (e.argv.includes('ls-files')) return out(Object.entries(tracked).map(([p, h]) => `100644 ${h.padEnd(40, '0')} 0\t${p}\0`).join(''))
    if (e.argv.includes('status') || e.argv.includes('log') || e.argv.includes('diff')) return out('')
    if (e.argv.includes('--short')) return out('abc1234\n')
    // git hash-object (manifestes, tests gelés) : le hash que le test décide, sinon un hash fixe.
    if (e.argv.includes('hash-object')) {
      const paths = ((e as unknown as { init?: { stdin?: string } }).init?.stdin ?? '').split('\n').filter(Boolean)
      const list = paths.length ? paths : [e.argv.at(-1)!]
      return out(`${list.map(p => hashes[p] ?? H0).join('\n')}\n`)
    }
    if (e.argv.includes('rev-parse') && !e.argv.includes('--abbrev-ref')) return out(`${COMMIT}\n`)
    // Les commandes de vérification : la sortie de tsc que le test décide (cmd /c sous Windows compris).
    if (e.argv.includes('tsc')) return { value: { ...verifRun.tsc, isStdoutTruncated: false, isStderrTruncated: false } }
    return out('feat/promo\n')
  })
  on('fs.stat', () => ({ value: { realPath: rootOf(os), kind: 'directory' } }) as never)
  // Les dossiers listés (fs.list), par clé diskKey : vides sauf ceux que le test remplit (agents installés).
  const lists: Record<string, { name: string; kind: string }[]> = {}
  on('fs.list', (_$, e) => ({ value: lists[diskKey(e.path)] ?? [] }) as never)
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
  // Les surfaces de la session : vide = claude -p (personne à qui demander).
  const surfaces: string[] = ['terminal']
  on('session.surfaces', () => ({ value: [...surfaces] }) as never)
  on('tool.call', (_$, e) => {
    if (e.tool === 'AskUserQuestion') {
      asked.push(JSON.stringify(e))
      // DISMISS : l'utilisateur ferme le dialogue (Échap) ; sans surface, c'est un -p qui ne peut pas demander.
      if (ctl.answer === DISMISS) return { deny: 'dialogue fermé' } as never
      const questions = (e as unknown as { questions: { question: string }[] }).questions
      const reply = (a: string) => ({ result: { questions, answers: { [questions[0]!.question]: a } } as never })
      if (ctl.answer !== undefined) return reply(ctl.answer)
      return new Promise<ReturnType<typeof reply>>(resolve => {
        ctl.pending = a => resolve(reply(a))
      })
    }
    if (e.tool === 'TaskStop') stopped.push(String((e as unknown as { task_id?: string }).task_id))
    // La sortie de l'outil telle que le modèle la lit (Grep, Glob, Bash) : celle que le test passe dans `sortie`.
    const sortie = (e as unknown as { sortie?: unknown }).sortie
    return { result: {} as never, ...(typeof sortie === 'string' ? { text: sortie } : {}) }
  })
  // $.model.complete (Haiku tranche la zone grise) : la réponse que le test décide ; sans réponse, pas de texte.
  const haiku = { reply: undefined as string | undefined, prompts: [] as string[] }
  on('model.complete', (_$, e) => {
    haiku.prompts.push(e.prompt)
    const usage = { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: haiku.reply === undefined ? { isAnswered: false, reason: 'empty-reply', usage } : { isAnswered: true, text: haiku.reply, usage } } as never
  })
  on('ui.notify', (_$, e) => {
    notified.push(e.text)
    return { value: { isSent: true } } as never
  })
  on('ui.toast', (_$, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined } as never
  })
  // La ligne d'état sous le prompt (undefined : retirée) et les redessins demandés.
  const statuses: (string | undefined)[] = []
  let redraws = 0
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined } as never
  })
  on('ui.invalidate', () => {
    redraws++
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
  // Le type et le modèle de chaque lancement, tels que revo-flow les transmet.
  const spawned: { description: string; subagentType?: string | undefined; model?: string | undefined }[] = []
  on('agent.spawn', (_$, e) => {
    prompts.push(e.prompt)
    spawned.push({ description: e.description, subagentType: e.subagentType, model: e.model })
    const agentId = `a-${e.description.split(' ')[0]!.toLowerCase()}`
    status[agentId] = 'running'
    return { model: e.model ?? 'inherit', agentId } as never
  })
  on('turn.start', () => ({ turnId: 't' }))
  on('turn.complete', () => ({ text: '' }))
  // La fin de tour de l'orchestrateur (porte de fin) : sans hook de réglages en dessous, rien à ajouter.
  on('classic.Stop', () => ({}) as never)
  // Ce que l'engine dessinerait sans le mod : une boîte vide.
  on('ui.render', (hook$, e) => h(hook$.ui.resolve(e).Box as never, {}) as never)
  return {
    clock,
    sent,
    opened,
    prompts,
    spawned,
    lists,
    status,
    ctl,
    asked,
    notified,
    stopped,
    toasts,
    aborted,
    registered,
    disk,
    states,
    tracked,
    gitDiff,
    haiku,
    runs,
    hashes,
    verifRun,
    surfaces,
    statuses,
    redraws: () => redraws,
  }
}

const H0 = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'
const COMMIT = 'c0ffee0000000000000000000000000000000000'

/** La réponse « dialogue fermé » : ui.ask rejette. */
const DISMISS = '\u0000fermé'

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

// ── rapportMarkdown ──────────────────────────────────────────────────────

const task = (title: string, status: 'completed' | 'pending' = 'completed') => ({ title, kind: 'codage', status }) as never
const FLOW: Flow = {
  id: 'f1',
  request: 'ajoute un code promo dans le panier',
  title: 'Code promo panier',
  summary: 'Un champ code promo dans le panier.',
  project: 'ui-vel',
  branch: 'feat/promo',
  phase: 'done',
  startedAt: NOW,
  endedAt: NOW + 192_000,
  agents: [
    { key: 'front-panier', name: 'Front panier', role: '', subagentType: 'general-purpose', model: 'sonnet', effort: 'medium', why: '', status: 'done', tasks: [task('Ajouter le champ'), task('Tester', 'pending')], costUsd: 0.4, tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 } },
    { key: 'api-promo', name: 'API promo', role: '', subagentType: 'general-purpose', model: 'opus', effort: 'high', why: '', status: 'done', tasks: [task('Ajouter la mutation')], costUsd: 1.1, tokens: { input: 2000, output: 800, cacheRead: 0, cacheWrite: 0 }, attempts: 2 },
  ],
} as never
const LEAD: Lead = { modelId: 'claude-opus-5-5', costUsd: 0.3, tokens: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0 } } as never
const ENTRIES: Entry[] = [
  { path: '/r/Basket.vue', rel: 'components/Basket.vue', reason: 'champ code promo', count: 2, at: NOW, by: 'front-panier' },
  { path: '/r/promo.ts', rel: 'api/promo.ts', reason: 'mutation', count: 1, at: NOW, by: 'api-promo', conflict: ['front-panier'] },
  { path: '/r/README.md', rel: 'README.md', reason: 'doc', count: 1, at: NOW },
]
const BASE: RapportInput = { flow: FLOW, lead: LEAD, entries: ENTRIES, date: '2026-10-12 09:03' }

const SECTIONS = ['## Demande et plan', '## Fichiers modifiés', '## Vérification (porte)', "## Critères d'acceptation", '## Architecture', '## Score CRAP', '## Durée, coût et tokens']

test('rapportMarkdown : rapport complet, les six sections', () => {
  const md = rapportMarkdown({
    ...BASE,
    verif: { etat: 'non-verifie', tentatives: 2, premierRouge: true, nouvelles: 1, preexistantes: 3, dureeMs: 48_000, triches: 0, accepte: true, criteres: { total: 2, ok: 1 }, crap: { fonctions: 2, nouvelles: 1, preexistantes: 1 } },
    porte: {
      accepte: true,
      resultat: {
        etat: 'rouge',
        le: 'x',
        dureeMs: 48_000,
        commandes: [
          { id: 'typecheck', outil: 'typage', etat: 'ko', dureeMs: 48_000, nouvelles: 1, preexistantes: 3, instables: 0, fichiers: 2 },
          { id: 'lint', outil: 'lint', etat: 'saute', dureeMs: 0, nouvelles: 0, preexistantes: 0, instables: 0, fichiers: 0, note: 'rien à lint' },
        ],
        erreurs: [
          { outil: 'typage', fichier: 'components/Basket.vue', code: 'TS2322', message: 'Type incompatible', ligne: 12, statut: 'nouvelle' },
          { outil: 'crap', fichier: 'api/promo.ts', code: 'CRAP', message: 'valider : CRAP 42', ligne: 8, statut: 'nouvelle' },
          { outil: 'crap', fichier: 'api/old.ts', code: 'CRAP', message: 'ancien : CRAP 35', ligne: 3, statut: 'preexistante' },
        ],
      },
    },
    criteres: [
      { id: 'C1', texte: 'Un code expiré affiche une erreur' },
      { id: 'C2', texte: 'Le total se met à jour' },
    ],
    verdicts: [
      { id: 'C1', verdict: 'ok', preuve: 'test promo.test.ts vert' },
      { id: 'C2', verdict: 'ko', preuve: 'total inchangé' },
    ],
    cache: { injecte: 1200, evites: 8400, net: 7200, lus: 3, completude: 1 },
    web: { etat: 'arrete', commande: 'npm run dev', url: 'http://localhost:3000', captures: [] },
    archi: { verdict: 'ok', preuve: '3 fichiers lus ; Basket.vue sous components/ comme les autres vues ; Promo importé de types/promo.ts' },
  })
  for (const s of SECTIONS) expect(md).toContain(s)
  expect(md).not.toMatch(/\*Absent/)
  expect(md).toMatch(/^# Rapport : Code promo panier\n/)
  expect(md).toContain('**Demande** : ajoute un code promo dans le panier')
  expect(md).toContain('Sonnet 5.5 · effort medium')
  expect(md).toContain('2/3 tâches faites')
  expect(md).toContain('1. ✓ Ajouter le champ')
  expect(md).toContain('2. ○ Tester')
  // Les fichiers, par agent (« by » ; sans auteur, l'orchestrateur).
  expect(md).toContain('### Front panier (1)')
  expect(md).toContain('- `components/Basket.vue` ×2 : champ code promo')
  expect(md).toContain('⚠ conflit')
  expect(md).toContain('### orchestrateur (1)')
  // La porte.
  expect(md).toContain('non vérifié ✗ · accepté par l\'utilisateur')
  expect(md).toContain('- ✗ `typecheck` : 1 nouvelle · 48 s')
  expect(md).toContain('- – `lint` : sautée (rien à lint)')
  expect(md).toContain('`components/Basket.vue:12` TS2322 Type incompatible')
  expect(md).toContain('Fini rouge sur décision de l\'utilisateur.')
  // Critères et CRAP.
  expect(md).toContain('**1/2 critères ok**')
  expect(md).toContain('- **C1** Un code expiré affiche une erreur : ok ✓')
  expect(md).toContain('> test promo.test.ts vert')
  expect(md).toContain('- **C2** Le total se met à jour : ko ✗')
  expect(md).toContain('2 fonctions au-dessus du seuil : 1 modifiée par le flow, 1 préexistante')
  expect(md).toContain('- ✗ `api/promo.ts:8` valider : CRAP 42')
  expect(md).toContain('- ⚠ `api/old.ts:3` ancien : CRAP 35')
  // Durée, coût, cache.
  expect(md).toContain('**Durée** : 3 m 12 (fini le 2026-10-12 09:03)')
  expect(md).toContain('- API promo : ')
  expect(md).toContain('2 lancements')
  expect(md).toContain('8,4k tokens évités')
})

test('rapportMarkdown : sans porte, sans critères, sans fichiers ni cache, chaque section dit son absence', () => {
  const md = rapportMarkdown({ ...BASE, entries: [] })
  for (const s of SECTIONS) expect(md).toContain(s)
  expect(md.match(/\*Absent : /g)).toHaveLength(6)
  expect(md).toContain("*Absent : pas de revue d'architecture pour ce flow.*")
  expect(md).toContain('*Absent : pas de porte de vérification pour ce flow.*')
  expect(md).toContain("*Absent : le plan n'avait pas de critères.*")
  expect(md).toContain('*Absent : pas de score CRAP pour ce flow.*')
  expect(md).toContain('*Absent : aucun fichier modifié pendant ce flow.*')
  expect(md).toContain('*Absent : pas de mesure du cache pour ce flow.*')
  // Une porte désactivée vaut une porte absente.
  expect(rapportMarkdown({ ...BASE, verif: { etat: 'off', tentatives: 0, premierRouge: false, nouvelles: 0, preexistantes: 0, dureeMs: 0, triches: 0 } })).toContain('pas de porte de vérification')
})

// ── Fin de flow, fichier et bouton ───────────────────────────────────────

const finish = async ($: Engine, w: ReturnType<typeof world>) => {
  const { front, api } = await twoRunning($, w)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}\\components\\Basket.vue`, agentId: front, tool_use_id: 'u1' } as never)
  for (const id of [front, api]) {
    w.status[id] = 'completed'
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer', agentId: id } as never)
    await w.clock.settle()
  }
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await w.clock.settle()
}

async function twoRunning($: Engine, w: ReturnType<typeof world>) {
  await launch($, w)
  await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN } as never)
  const front = await spawn($, 'Front panier')
  const api = await spawn($, 'API promo')
  return { front: front.agentId!, api: api.agentId! }
}

for (const os of OSES) {
  test(`rapport.md (${os.nom}) : écrit en fin de flow dans ~/.claude/revo-flow/rapports, le bouton du panneau l'ouvre`, async ($, on) => {
    const w = world(on, os)
    await finish($, w)
    const md = w.disk['/Users/x/.claude/revo-flow/rapports/code-promo-panier.md']
    expect(md).toBeDefined()
    expect(md!).toMatch(/^# Rapport : Code promo panier\n/)
    expect(md!).toContain('## Fichiers modifiés')
    expect(md!).toContain('### Front panier (1)')
    expect(md!).toContain('*Absent : pas de porte de vérification pour ce flow.*')
    const path = (w.states.flow as Flow).rapportFile
    expect(path && diskKey(path)).toBe('/Users/x/.claude/revo-flow/rapports/code-promo-panier.md')
    for (const surface of ['terminal', 'desktop'] as const) {
      w.runs.length = 0
      const ui = await $.ui.mount({ plugin: 'revo-flow', surface, component: 'Pane', requestId: 'revo-flow', props: { bodyColumns: 100 } as never } as never)
      await ui.press({ key: 'rapport-done' })
      await ui.unmount()
      const opener = w.runs.find(r => r[0] === 'open' || r[0] === 'cmd')
      expect(opener).toEqual(
        os === WINDOWS
          ? ['cmd', '/c', 'start', '', 'C:\\Users\\x\\.claude\\revo-flow\\rapports\\code-promo-panier.md']
          : ['open', '/Users/x/.claude/revo-flow/rapports/code-promo-panier.md'],
      )
    }
  })
}

test('rapport.md : pas de bouton tant que le flow n’a pas fini', async ($, on) => {
  const w = world(on)
  await twoRunning($, w)
  const pane = await drawn($, 'terminal', 'Pane')
  expect(pane.text).not.toMatch(/rapport\.md/)
  expect((w.states.flow as Flow).rapportFile).toBeUndefined()
})

test('flow arrêté : pas de rapport', async ($, on) => {
  const w = world(on)
  await twoRunning($, w)
  await $.turn.start({ turnId: 'lead-1' } as never)
  const ui = await $.ui.mount({ plugin: 'revo-flow', surface: 'terminal', component: 'Pane', requestId: 'revo-flow', props: { bodyColumns: 100 } as never } as never)
  w.ctl.answer = 'Arrêter'
  await ui.press({ key: 'stop-all' })
  await ui.unmount()
  await w.clock.settle()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'lead-1', reason: 'aborted' } as never)
  await w.clock.settle()
  expect(w.notified.join('\n')).toMatch(/arrêté/)
  expect(Object.keys(w.disk).filter(k => k.includes('/rapports/'))).toEqual([])
})

// ── La preuve web dans la section critères ───────────────────────────────

const CRITERES = [
  { id: 'C1', texte: 'Le champ code promo s’affiche' },
  { id: 'C2', texte: 'Un code expiré affiche une erreur' },
] as never
const VERDICTS = [
  { id: 'C1', verdict: 'ok', preuve: 'capture-1', web: true },
  { id: 'C2', verdict: 'ok', preuve: 'test' },
] as never
const WIN_CAPTURE = 'C:\\r\\sorties\\capture-2.png.txt'
const WEB: WebView = { etat: 'pret', commande: 'npm run dev', url: 'http://localhost:3000', captures: ['/r/sorties/capture-1.png', WIN_CAPTURE] }
const avecWeb = (web?: WebView) => rapportMarkdown({ ...BASE, criteres: CRITERES, verdicts: VERDICTS, web })

test('rapportMarkdown : preuve web prête, deux captures et un verdict web', () => {
  const md = avecWeb(WEB)
  expect(md).toContain('ok ✓ · preuve web')
  expect(md).toContain('**C2** Un code expiré affiche une erreur : ok ✓\n')
  expect(md).toContain(`**Preuve web** : serveur « npm run dev » sur http://localhost:3000 (démarré par revo-flow), 2 captures : [capture-1.png](</r/sorties/capture-1.png>), [capture-2.png.txt](<${WIN_CAPTURE}>)`)
  expect(avecWeb({ ...WEB, existant: true, captures: [] })).toContain('(déjà en marche), aucune capture')
  expect(avecWeb({ ...WEB, etat: 'arrete' })).toContain('**Preuve web** : serveur « npm run dev »')
})

test('rapportMarkdown : preuve mobile (v3.1) prête avec captures, verdict mobile ; elle remplace le paragraphe web ; refusée, en erreur, en cours', () => {
  const verdicts = [{ id: 'C1', verdict: 'ko' as const, preuve: 'SM A515F : 1 débordement ; capture 1', mobile: true }, { id: 'C2', verdict: 'ok' as const, preuve: 'vitest → ok' }]
  const mobile = { etat: 'pret' as const, framework: 'Flutter', appareil: 'SM A515F (téléphone branché, Android 13 (API 33))', commande: 'flutter run -d 192.168.1.13:40481', captures: ['/r/sorties/capture-1.png'] }
  const md = rapportMarkdown({ ...BASE, criteres: CRITERES, verdicts, web: { etat: 'non-demande', captures: [] }, mobile })
  expect(md).toContain('ko ✗ · preuve mobile')
  expect(md).toContain('**Preuve mobile** : app Flutter « flutter run -d 192.168.1.13:40481 » sur SM A515F (téléphone branché, Android 13 (API 33)), 1 capture : [capture-1.png](</r/sorties/capture-1.png>)')
  expect(md).not.toContain('**Preuve web**')
  expect(rapportMarkdown({ ...BASE, criteres: CRITERES, verdicts, mobile: { ...mobile, etat: 'arrete', emulateurLance: true, captures: [] } })).toContain('(émulateur démarré par revo-flow), aucune capture')
  expect(rapportMarkdown({ ...BASE, criteres: CRITERES, verdicts, mobile: { etat: 'refuse', captures: [] } })).toContain('**Preuve mobile** : app non lancée (choix de l’utilisateur)')
  expect(rapportMarkdown({ ...BASE, criteres: CRITERES, verdicts, mobile: { etat: 'erreur', captures: [], note: 'aucun appareil' } })).toContain('**Preuve mobile** : l’app n’a pas été lancée : aucun appareil')
  expect(rapportMarkdown({ ...BASE, criteres: CRITERES, verdicts, mobile: { etat: 'installation', captures: [] } })).toContain('**Preuve mobile** : app en cours de lancement')
  // Non demandée : le paragraphe web reprend sa place.
  expect(rapportMarkdown({ ...BASE, criteres: CRITERES, verdicts, mobile: { etat: 'non-demande', captures: [] } })).toContain('**Preuve web**')
})

test('rapportMarkdown : preuve web refusée, en erreur, en cours ou absente', () => {
  expect(avecWeb({ etat: 'refuse', captures: [] })).toContain('**Preuve web** : serveur non démarré (choix de l’utilisateur) : les critères web sont non vérifiables')
  expect(avecWeb({ etat: 'erreur', captures: [], note: 'port occupé' })).toContain('**Preuve web** : le serveur n’a pas démarré : port occupé')
  expect(avecWeb({ etat: 'demarrage', captures: [] })).toContain('**Preuve web** : serveur en cours de démarrage')
  expect(avecWeb({ etat: 'question', captures: [] })).toContain('serveur en cours de démarrage')
  expect(avecWeb(undefined)).toContain('**Preuve web** : *Absent : le vérificateur n’a pas demandé le navigateur.*')
  expect(avecWeb({ etat: 'non-demande', captures: [] })).toContain('le vérificateur n’a pas demandé le navigateur')
})

test('rapportMarkdown : sans critères, rien n’est ajouté pour le web', () => {
  const md = rapportMarkdown({ ...BASE, web: WEB })
  expect(md).not.toContain('Preuve web')
  expect(md).toContain("*Absent : le plan n'avait pas de critères.*")
})

test('rapportMarkdown : la revue d’architecture, conforme, ko avec sa preuve, ou terminée sans', () => {
  expect(rapportMarkdown({ ...BASE, archi: { verdict: 'ok', preuve: 'rien à redire' } })).toContain('## Architecture\n\n**Revue du vérificateur** : conforme ✓\n> rien à redire')
  expect(rapportMarkdown({ ...BASE, archi: { verdict: 'ko', preuve: 'lib/x.ts redéfinit Panier (types/cart.ts:3)' } })).toContain('**Revue du vérificateur** : ko ✗\n> lib/x.ts redéfinit Panier (types/cart.ts:3)')
  expect(rapportMarkdown({ ...BASE, archi: { verdict: 'passee' } })).toContain('terminé sans revue (décision de l’utilisateur)')
})
