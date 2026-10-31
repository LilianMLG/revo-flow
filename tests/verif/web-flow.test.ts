// La preuve à l'exécution web (v3.0), au niveau de register.tsx : l'action web de l'outil verif, la question,
// le serveur de dev lancé par process.spawn, les outils navigateur du vérificateur, les captures et l'arrêt en fin de flow.
// Écrits d'après les critères C2 à C6 et C8 du plan et le contrat de l'action web, pas d'après le code.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { OSES, WINDOWS, diskKey, native, type Os } from '../helpers/os'

const rootOf = (os: Os) => native(os, 'Documents', 'Front', 'reservation-tool')
const NOW = Date.UTC(2026, 9, 31, 9)
const H0 = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'
const COMMIT = 'c0ffee0000000000000000000000000000000000'

const VERIF = 'mcp__revo-flow__verif'
const NAVIGATE = 'mcp__claude-in-chrome__navigate'
const COMPUTER = 'mcp__claude-in-chrome__computer'
const URL = 'http://localhost:3000'

/** Le projet simulé : un Nuxt 3 avec un script dev, sans lockfile pnpm ni yarn. */
const PKG_NUXT = JSON.stringify({
  name: 'reservation-tool',
  scripts: { dev: 'nuxt dev', lint: 'eslint .', test: 'vitest' },
  devDependencies: { nuxt: '^3.9.0', vitest: '^1.6.0', eslint: '^8.57.0' },
})
/** Le même projet sans script dev. */
const PKG_SANS_DEV = JSON.stringify({
  name: 'reservation-tool',
  scripts: { lint: 'eslint .', test: 'vitest' },
  devDependencies: { nuxt: '^3.9.0', vitest: '^1.6.0', eslint: '^8.57.0' },
})

/** Une capture PNG plausible, en base64 (signature PNG puis quelques octets). */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const PLAN_WEB = {
  titre: 'Panier réservation',
  resume: 'Le panier de réservation affiche le total.',
  criteres: ['La page panier affiche le total de la réservation', 'Le bouton payer reste désactivé sans créneau choisi'],
  agents: [
    { nom: 'Front panier', modele: 'sonnet', effort: 'medium', taches: [{ titre: 'Afficher le total', type: 'codage' }] },
    { nom: 'Vérificateur', type: 'revo-flow:verifier', modele: 'sonnet', effort: 'medium', taches: [{ titre: 'Juger les critères', type: 'review' }] },
  ],
}

type Chunk = { stream: 'stdout' | 'stderr'; text: string }
type Spawned = { argv: string[]; closed: boolean; push: (text: string) => void }
type WebView = { etat: string; commande?: string; url?: string; existant?: boolean; captures: string[]; note?: string }
type Question = { question: string; options: string[] }

/**
 * Le serveur que simule le hook process.spawn (un générateur asynchrone, seule forme que le kit accepte) :
 * il livre d'abord les chunks que le test a décidés, puis reste en attente tant que le test n'en pousse pas d'autres.
 * revo-flow l'arrête en fermant le flux (return(), next.signal) : closed passe à true, il rend { code: null, signal: 'SIGTERM' }.
 */
function serveur(argv: readonly string[], initial: string[], signal: AbortSignal | undefined) {
  const queue: string[] = [...initial]
  let wake: (() => void) | undefined
  const rec: Spawned = {
    argv: [...argv],
    closed: false,
    push(text) {
      queue.push(text)
      wake?.()
    },
  }
  const stopped = () => rec.closed || signal?.aborted === true
  signal?.addEventListener('abort', () => wake?.())
  async function* stream(): AsyncGenerator<Chunk, { code: number | null; signal: string | null }> {
    try {
      while (!stopped()) {
        const text = queue.shift()
        if (text !== undefined) {
          yield { stream: 'stdout', text }
          continue
        }
        await new Promise<void>(resolve => {
          wake = () => {
            wake = undefined
            resolve()
          }
        })
      }
    } finally {
      rec.closed = true
    }
    return { code: null, signal: 'SIGTERM' }
  }
  return { rec, stream }
}

function world(on: On, os: Os = WINDOWS) {
  const store: Record<string, unknown> = {}
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
  on('prompt.submit', (_$, e) => ({ text: e.text }))

  // Le port 3000 : libre ou déjà pris (un serveur à l'écoute que revo-flow ne doit jamais tuer).
  const port = { pris: false }
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    const res = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const out = (stdout: string) => res(0, stdout)
    // netstat (Windows) et lsof (ailleurs) : qui écoute sur le port.
    if (e.argv.some(a => /netstat/i.test(a))) return port.pris ? out('\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    0.0.0.0:3000     0.0.0.0:0    LISTENING    1234\r\n') : out('')
    if (e.argv.some(a => /lsof/i.test(a))) return port.pris ? out('COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    1234 x     23u  IPv6 0x0      0t0  TCP *:3000 (LISTEN)\n') : res(1, '')
    // Le décodage base64 → .png (certutil, sh base64) échoue : la capture reste en .png.txt.
    if (e.argv.some(a => /certutil|base64/i.test(a)) || e.argv[0] === 'sh') return res(1, '')
    if (e.argv.includes('ls-files') || e.argv.includes('status') || e.argv.includes('log') || e.argv.includes('diff')) return out('')
    if (e.argv.includes('--short')) return out('abc1234\n')
    if (e.argv.includes('hash-object')) {
      const paths = ((e as unknown as { init?: { stdin?: string } }).init?.stdin ?? '').split('\n').filter(Boolean)
      return out(`${(paths.length ? paths : [e.argv.at(-1)!]).map(() => H0).join('\n')}\n`)
    }
    if (e.argv.includes('rev-parse') && !e.argv.includes('--abbrev-ref')) return out(`${COMMIT}\n`)
    return out('feat/panier\n')
  })

  // Le serveur de dev : chaque process.spawn reçu, avec les chunks de sortie que le test décide.
  const sortie = { chunks: ['Nuxt 3.9.0\n', `  ➜ Local:    ${URL}/\n`] }
  const spawns: Spawned[] = []
  on('process.spawn', async function* (_$, e, next) {
    const { rec, stream } = serveur(e.argv, sortie.chunks, (next as unknown as { signal?: AbortSignal }).signal)
    spawns.push(rec)
    // Le kit attend le résultat d'un hook de flux sous la forme { value }.
    return { value: yield* stream() }
  } as never)

  on('fs.stat', () => ({ value: { realPath: rootOf(os), kind: 'directory' } }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { rateLimits: [], context: { window: 200000 } } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // L'état partagé du mod : dernière valeur par clé, et l'historique de la vue verif (la vue web avant l'effacement du flow).
  const states: Record<string, unknown> = {}
  const verifs: unknown[] = []
  on('state.set', (_$, e, next) => {
    const w = e as unknown as { key: string; value: unknown }
    states[w.key] = w.value
    if (w.key === 'verif' || w.key === 'revo-flow:verif') verifs.push(copy(w.value))
    return next(e)
  })
  on('session.messages', () => ({ value: [] }) as never)
  on('session.repo', () => ({ value: { root: rootOf(os), remote: null, internal: false, name: 'reservation-tool' } }) as never)
  // Le disque en mémoire, par clé diskKey (la même pour un chemin Windows ou macOS).
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
  on('session.surfaces', () => ({ value: ['terminal'] }) as never)

  // ui.ask (AskUserQuestion) : le plan est lancé, les commandes de vérification utilisées ;
  // la question web reçoit la réponse du test (ctl.web) ; sans réponse, elle reste ouverte jusqu'à repondre().
  const asked: Question[] = []
  const ctl: { web: string | undefined; repondre: ((a: string) => void) | undefined } = { web: 'Démarrer', repondre: undefined }
  // Les appels d'outils navigateur arrivés jusqu'au world (non refusés par revo-flow).
  const browser: { tool: string; agentId?: string; url?: string }[] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'AskUserQuestion') {
      const questions = (e as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions
      const q = questions[0]!
      const options = q.options.map(o => o.label)
      asked.push({ question: q.question, options })
      const reply = (a: string) => ({ result: { questions, answers: { [q.question]: a } } as never })
      if (options.includes('Lancer')) return reply('Lancer')
      if (options.includes('Ajuster')) return reply('Utiliser')
      if (ctl.web !== undefined) return reply(ctl.web)
      return new Promise<ReturnType<typeof reply>>(resolve => {
        ctl.repondre = a => resolve(reply(a))
      })
    }
    const x = e as unknown as { tool: string; agentId?: string; url?: string; action?: string }
    if (x.tool.startsWith('mcp__claude-in-chrome__')) browser.push({ tool: x.tool, ...(x.agentId ? { agentId: x.agentId } : {}), ...(x.url ? { url: x.url } : {}) })
    if (x.tool === COMPUTER && x.action === 'screenshot')
      return { result: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] } as never }
    return { result: {} as never }
  })
  on('model.complete', () => {
    const usage = { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: false, reason: 'empty-reply', usage } } as never
  })
  on('ui.notify', () => ({ value: { isSent: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
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
  on('agent.spawn', (_$, e) => {
    const agentId = `a-${e.description.split(' ')[0]!.toLowerCase()}`
    status[agentId] = 'running'
    return { model: e.model ?? 'inherit', agentId } as never
  })
  on('turn.start', () => ({ turnId: 't' }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}) as never)
  on('ui.render', (hook$, e) => h(hook$.ui.resolve(e).Box as never, {}) as never)
  return { clock, store, port, runs, sortie, spawns, states, verifs, disk, registered, asked, ctl, browser, status }
}

type World = ReturnType<typeof world>

/** Laisse passer les promesses en cours (lecture de la sortie du serveur, question ouverte). */
const flush = async (w: World) => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await w.clock.settle()
}

/** La vue web courante (état revo-flow:verif), ou la dernière connue avant l'effacement du flow. */
const webOf = (w: World): WebView | undefined => (w.states.verif as { web?: WebView } | null | undefined)?.web
const lastWeb = (w: World): WebView | undefined => [...w.verifs].reverse().map(v => (v as { web?: WebView } | null)?.web).find(Boolean)

/** Les questions de la preuve web (démarrage ou port pris), à part du plan et des commandes. */
const webQuestions = (w: World) => w.asked.filter(q => /^Démarrer « npm run dev »|^Le port 3000/.test(q.question))

const seed = (w: World, os: Os, pkg = PKG_NUXT) => {
  w.disk[diskKey(`${rootOf(os)}/package.json`)] = pkg
}

const spawnAgent = ($: Engine, description: string, subagentType = 'general-purpose') =>
  $.agent.spawn({ prompt: `Mission de ${description}`, description, subagentType, provider: { kind: 'model' } } as never)

/** /revo-flow, le plan avec critères validé, le front et le vérificateur lancés. */
async function launchWeb($: Engine, w: World) {
  await $.command.run({ command: 'revo-flow', args: 'affiche le total dans le panier de réservation' } as never)
  await w.clock.advance(1)
  await w.clock.settle()
  await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN_WEB } as never)
  const front = (await spawnAgent($, 'Front panier')).agentId!
  const verifier = (await spawnAgent($, 'Vérificateur', 'revo-flow:verifier')).agentId!
  return { front, verifier }
}

const web = async ($: Engine, agentId: string) => JSON.stringify(await $.tool.call({ tool: VERIF, action: 'web', agentId } as never))

const navigate = ($: Engine, url: string, agentId: string, id: string) =>
  $.tool.call({ tool: NAVIGATE, url, agentId, tool_use_id: id } as never) as Promise<{ deny?: string }>

const endTurn = async ($: Engine, w: World, agentId: string) => {
  w.status[agentId] = 'completed'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer', agentId } as never)
  await w.clock.settle()
}

/** La fin du flow : les agents finissent, la conclusion de l'orchestrateur. */
async function finish($: Engine, w: World, ids: string[]) {
  for (const id of ids) await endTurn($, w, id)
  await $.classic.Stop({ stop_hook_active: false } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await w.clock.settle()
}

/** Un flow complet monte le panneau et tout le mod : plus que les 5 s par défaut du kit. */
const LENT = { timeoutMs: 30_000 }

const DEV_ARGV = (os: Os) => (os === WINDOWS ? ['cmd', '/c', 'npm', 'run', 'dev'] : ['npm', 'run', 'dev'])

for (const os of OSES) {
  describe(`preuve web (${os.nom})`, () => {
    test('C2 : la question est posée avant tout spawn ; « Pas cette fois » → aucun spawn, preuve web non vérifiable', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      const { verifier } = await launchWeb($, w)
      w.ctl.web = undefined
      const pending = web($, verifier)
      await flush(w)
      // La question est ouverte : la commande, le port, les deux choix ; rien n'est lancé.
      const qs = webQuestions(w)
      expect(qs.length).toBe(1)
      expect(qs[0]!.question.startsWith('Démarrer « npm run dev » pour')).toBe(true)
      expect(qs[0]!.question).toContain('(port 3000)')
      expect(qs[0]!.options).toEqual(['Démarrer', 'Pas cette fois'])
      expect(w.spawns).toEqual([])
      expect(webOf(w)?.etat).toBe('question')
      w.ctl.repondre!('Pas cette fois')
      const r = await pending
      expect(r).toContain('revo-flow verif : l’utilisateur ne démarre pas le serveur : preuve web non vérifiable')
      expect(w.spawns).toEqual([])
      expect(webOf(w)?.etat).toBe('refuse')
      // Pas de serveur accordé : le navigateur du vérificateur reste fermé.
      expect((await navigate($, `${URL}/panier`, verifier, 'n1')).deny).toContain('preuve web n’est pas ouverte')
    })

    test('C3 : « Démarrer » lance npm run dev par process.spawn, l’URL lue dans la sortie, vue pret ; un 2e appel ne relance pas', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      const { verifier } = await launchWeb($, w)
      w.ctl.web = 'Démarrer'
      const r = await web($, verifier)
      expect(w.spawns.length).toBe(1)
      expect(w.spawns[0]!.argv).toEqual(DEV_ARGV(os))
      expect(r).toContain(`revo-flow verif : serveur prêt sur ${URL}`)
      const v = webOf(w)!
      expect(v).toMatchObject({ etat: 'pret', url: URL, commande: 'npm run dev' })
      expect(v.existant).toBeUndefined()
      expect(v.captures).toEqual([])
      // Deuxième appel : même réponse, ni question ni spawn de plus.
      const r2 = await web($, verifier)
      expect(r2).toContain(`revo-flow verif : serveur prêt sur ${URL}`)
      expect(w.spawns.length).toBe(1)
      expect(webQuestions(w).length).toBe(1)
      expect(w.spawns[0]!.closed).toBe(false)
    })

    test('C4 : navigate du vérificateur refusé sans serveur, refusé vers une autre origine, permis sur l’origine du serveur ; un autre agent n’est pas filtré', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      const { front, verifier } = await launchWeb($, w)
      // Avant tout serveur accordé.
      expect((await navigate($, `${URL}/panier`, verifier, 'n1')).deny).toContain('preuve web n’est pas ouverte')
      expect(w.browser).toEqual([])
      // Un agent qui n'est pas le vérificateur : pas de filtre.
      expect((await navigate($, 'https://example.com/', front, 'n2')).deny).toBeUndefined()
      expect(w.browser).toEqual([{ tool: NAVIGATE, agentId: front, url: 'https://example.com/' }])
      // Serveur accordé.
      w.ctl.web = 'Démarrer'
      expect(await web($, verifier)).toContain(`serveur prêt sur ${URL}`)
      expect((await navigate($, `${URL}/panier`, verifier, 'n3')).deny).toBeUndefined()
      expect(w.browser.at(-1)).toEqual({ tool: NAVIGATE, agentId: verifier, url: `${URL}/panier` })
      const autre = await navigate($, 'https://example.com/', verifier, 'n4')
      expect(autre.deny).toContain('autre origine')
      expect(w.browser.filter(b => b.agentId === verifier).length).toBe(1)
    })

    test('C5 : une capture du vérificateur est écrite en base64 (capture-1.png.txt) et listée dans web.captures ; la suivante est capture-2', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      const { verifier } = await launchWeb($, w)
      w.ctl.web = 'Démarrer'
      await web($, verifier)
      await $.tool.call({ tool: COMPUTER, action: 'screenshot', agentId: verifier, tool_use_id: 's1' } as never)
      await flush(w)
      const une = Object.keys(w.disk).filter(k => k.endsWith('/capture-1.png.txt'))
      expect(une.length).toBe(1)
      expect(w.disk[une[0]!]).toBe(PNG)
      const v = webOf(w)!
      expect(v.captures.length).toBe(1)
      expect(v.captures[0]!).toMatch(/capture-1\.png(\.txt)?$/)
      await $.tool.call({ tool: COMPUTER, action: 'screenshot', agentId: verifier, tool_use_id: 's2' } as never)
      await flush(w)
      const deux = Object.keys(w.disk).filter(k => k.endsWith('/capture-2.png.txt'))
      expect(deux.length).toBe(1)
      expect(w.disk[deux[0]!]).toBe(PNG)
      expect(webOf(w)!.captures.length).toBe(2)
      expect(webOf(w)!.captures[1]!).toMatch(/capture-2\.png(\.txt)?$/)
    })

    test('C6 : le serveur lancé par revo-flow est arrêté à la fin du flow (itérateur fermé), web.etat arrete', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      const { front, verifier } = await launchWeb($, w)
      w.ctl.web = 'Démarrer'
      expect(await web($, verifier)).toContain(`serveur prêt sur ${URL}`)
      expect(w.spawns[0]!.closed).toBe(false)
      await finish($, w, [front, verifier])
      expect(w.spawns[0]!.closed).toBe(true)
      expect(lastWeb(w)?.etat).toBe('arrete')
    })

    test('C6 : port déjà pris → question « Utiliser », réutilisé sans spawn, jamais tué en fin de flow', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      w.port.pris = true
      const { front, verifier } = await launchWeb($, w)
      w.ctl.web = 'Utiliser'
      const r = await web($, verifier)
      const qs = webQuestions(w)
      expect(qs.length).toBe(1)
      expect(qs[0]!.question.startsWith('Le port 3000 est déjà pris')).toBe(true)
      expect(qs[0]!.options).toEqual(['Utiliser', 'Pas cette fois'])
      expect(r).toContain(`revo-flow verif : serveur prêt sur ${URL}`)
      expect(w.spawns).toEqual([])
      expect(webOf(w)).toMatchObject({ etat: 'pret', url: URL, existant: true })
      // Le navigateur est ouvert sur ce serveur.
      expect((await navigate($, `${URL}/panier`, verifier, 'n1')).deny).toBeUndefined()
      const avant = w.runs.length
      await finish($, w, [front, verifier])
      // Rien à fermer : aucun spawn, aucune commande d'arrêt de processus.
      expect(w.spawns).toEqual([])
      expect(w.runs.slice(avant).some(a => a.some(x => /taskkill|^kill$|pkill/i.test(x)))).toBe(false)
      expect(lastWeb(w)?.etat).toBe('arrete')
    })

    test('erreur : EADDRINUSE dans la sortie au lieu de l’URL → le serveur n’a pas démarré, vue erreur, processus fermé', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      const { verifier } = await launchWeb($, w)
      w.ctl.web = 'Démarrer'
      w.sortie.chunks = ['Nuxt 3.9.0\n', 'Error: listen EADDRINUSE: address already in use :::3000\n']
      const pending = web($, verifier)
      // Si revo-flow attend un délai avant de conclure, l'horloge simulée le fait passer.
      await flush(w)
      await w.clock.advance(120_000)
      await w.clock.settle()
      const r = await pending
      expect(w.spawns.length).toBe(1)
      expect(r).toContain('revo-flow verif : le serveur n’a pas démarré')
      expect(webOf(w)?.etat).toBe('erreur')
      expect(w.spawns[0]!.closed).toBe(true)
      expect((await navigate($, `${URL}/panier`, verifier, 'n1')).deny).toContain('preuve web n’est pas ouverte')
    })

    test('aucun script dev : aucun serveur de dev détecté, sans question ni spawn', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os, PKG_SANS_DEV)
      const { verifier } = await launchWeb($, w)
      const avant = w.asked.length
      const r = await web($, verifier)
      expect(r).toContain('revo-flow verif : aucun serveur de dev détecté')
      expect(w.asked.length).toBe(avant)
      expect(w.spawns).toEqual([])
    })
  })
}

test('C8 : option web à off → preuve web désactivée, sans question ni spawn', { ...LENT, options: { web: 'off' } as never }, async ($, on) => {
  const w = world(on, WINDOWS)
  seed(w, WINDOWS)
  const { verifier } = await launchWeb($, w)
  const avant = w.asked.length
  const r = await web($, verifier)
  expect(r).toContain('revo-flow verif : preuve web désactivée (option web)')
  expect(w.asked.length).toBe(avant)
  expect(webQuestions(w)).toEqual([])
  expect(w.spawns).toEqual([])
})
