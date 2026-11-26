// La preuve à l'exécution mobile (v3.1), au niveau de register.tsx : le choix web ou mobile selon le projet, l'action mobile de l'outil
// verif, la question, le téléphone branché ou l'émulateur démarré, l'app lancée par process.spawn, l'outil mobile du vérificateur
// (capture, arbre, journal, toucher), l'arrêt en fin de flow et le vérificateur accepté en arrière-plan (v3.1.1).
// Écrits d'après le contrat de l'action mobile et de l'outil mobile, pas d'après le code.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { OSES, WINDOWS, diskKey, native, type Os } from '../helpers/os'

const rootOf = (os: Os) => native(os, 'Documents', 'Mobile', 'router_app')
const NOW = Date.UTC(2026, 10, 4, 9)
const H0 = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'
const COMMIT = 'c0ffee0000000000000000000000000000000000'

const VERIF = 'mcp__revo-flow__verif'
const MOBILE = 'mcp__revo-flow__mobile'
const A51 = '192.168.1.13:40481'
const EMU = 'emulator-5554'

/** Le projet simulé : une app Flutter avec un dossier android/. */
const PUBSPEC = ['name: router_app', 'environment:', "  sdk: '>=3.0.0 <4.0.0'", 'dependencies:', '  flutter:', '    sdk: flutter', '  go_router: ^14.0.0'].join('\n')
/** Un projet Nuxt, sans app mobile. */
const PKG_NUXT = JSON.stringify({ name: 'reservation-tool', scripts: { dev: 'nuxt dev', test: 'vitest' }, devDependencies: { nuxt: '^3.9.0', vitest: '^1.6.0' } })

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const UI_XML =
  '<?xml version=\'1.0\'?><hierarchy><node text="" class="android.widget.FrameLayout" bounds="[0,0][1080,2340]" clickable="false"><node text="Créneau 14h-15h" class="android.widget.TextView" bounds="[40,100][600,180]" clickable="false" enabled="true" /><node text="Réserver" resource-id="app:id/book" class="android.widget.Button" content-desc="" bounds="[80,1600][1000,1720]" clickable="true" enabled="true" /></node></hierarchy>'

const device = (id: string, emulator: boolean) => ({
  name: emulator ? 'sdk gphone64 arm64' : 'SM A515F',
  id,
  isSupported: true,
  targetPlatform: 'android-arm64',
  emulator,
  sdk: emulator ? 'Android 14 (API 34)' : 'Android 13 (API 33)',
  capabilities: { screenshot: true },
})

const PLAN_MOBILE = {
  titre: 'Écran réservation',
  resume: 'L’écran Réservation affiche le créneau choisi.',
  criteres: ['L’écran Réservation affiche le créneau choisi', 'Le bouton Réserver reste actif'],
  agents: [
    { nom: 'Front écran', modele: 'sonnet', effort: 'medium', taches: [{ titre: 'Afficher le créneau', type: 'codage' }] },
    { nom: 'Vérificateur', type: 'revo-flow:verifier', modele: 'sonnet', effort: 'medium', taches: [{ titre: 'Juger les critères', type: 'review' }] },
  ],
}

type Chunk = { stream: 'stdout' | 'stderr'; text: string }
type Spawned = { argv: string[]; closed: boolean; push: (text: string) => void }
type MobileView = { etat: string; framework?: string; appareil?: string; commande?: string; emulateurLance?: boolean; captures: string[]; note?: string }
type Question = { question: string; options: string[] }

function processus(argv: readonly string[], initial: string[], signal: AbortSignal | undefined) {
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

  // Le disque en mémoire, par clé diskKey (la même pour un chemin Windows ou macOS).
  const disk: Record<string, string> = {}
  // Les appareils du poste : un téléphone branché par défaut ; `emulateur` : seulement un AVD éteint, allumé après le --launch.
  const poste = { telephone: true, emulateur: false, allume: false }
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const res = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const out = (stdout: string) => res(0, stdout)
    const a = argv.join(' ')
    if (/flutter devices --machine/.test(a)) {
      const liste = [...(poste.telephone ? [device(A51, false)] : []), ...(poste.allume ? [device(EMU, true)] : [])]
      return out(`Error 1 retrieving device properties for x:\n${JSON.stringify(liste)}\n`)
    }
    if (/flutter emulators --launch/.test(a)) {
      poste.allume = true
      return out('')
    }
    if (/flutter emulators$/.test(a)) return out(poste.emulateur ? 'Pixel_8 • Pixel 8 • Google • android\n' : 'Unable to find any emulator sources.\n')
    if (/sys\.boot_completed/.test(a)) return out('1\n')
    if (/flutter screenshot/.test(a)) {
      disk[diskKey(argv.at(-1)!)] = 'PNG'
      return out('Screenshot written to capture.png\n')
    }
    if (/openssl base64|^base64 /.test(a) || argv[0] === 'base64' || argv[0] === 'certutil') {
      if (argv[0] === 'certutil') disk[diskKey(argv.at(-1)!)] = `-----BEGIN CERTIFICATE-----\r\n${PNG}\r\n-----END CERTIFICATE-----\r\n`
      return out(PNG)
    }
    if (/uiautomator dump/.test(a)) return out('UI hierchary dumped to: /sdcard/revo-flow-ui.xml\n')
    if (/shell cat \/sdcard\/revo-flow-ui\.xml/.test(a)) return out(UI_XML)
    if (/shell input/.test(a)) return out('')
    if (/logcat/.test(a)) return out('11-04 10:00:00.123  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main\n')
    if (/emu kill/.test(a)) return out('OK: killing emulator\n')
    if (argv.includes('ls-files') || argv.includes('status') || argv.includes('log') || argv.includes('diff')) return out('')
    if (argv.includes('--short')) return out('abc1234\n')
    if (argv.includes('hash-object')) {
      const paths = ((e as unknown as { init?: { stdin?: string } }).init?.stdin ?? '').split('\n').filter(Boolean)
      return out(`${(paths.length ? paths : [argv.at(-1)!]).map(() => H0).join('\n')}\n`)
    }
    if (argv.includes('rev-parse') && !argv.includes('--abbrev-ref')) return out(`${COMMIT}\n`)
    if (argv.includes('rev-parse')) return out('feat/ecran\n')
    return out('')
  })

  // L'app lancée : chaque process.spawn reçu, avec les chunks de sortie que le test décide.
  const sortie = { chunks: ['Launching lib/main.dart on SM A515F in debug mode...\n', 'A Dart VM Service on SM A515F is available at: http://127.0.0.1:61234/abcDEF=/\n'] }
  const spawns: Spawned[] = []
  on('process.spawn', async function* (_$, e, next) {
    const { rec, stream } = processus(e.argv, sortie.chunks, (next as unknown as { signal?: AbortSignal }).signal)
    spawns.push(rec)
    return { value: yield* stream() }
  } as never)

  on('fs.stat', () => ({ value: { realPath: rootOf(os), kind: 'directory' } }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { rateLimits: [], context: { window: 200000 } } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const states: Record<string, unknown> = {}
  const verifs: unknown[] = []
  on('state.set', (_$, e, next) => {
    const w = e as unknown as { key: string; value: unknown }
    states[w.key] = w.value
    if (w.key === 'verif' || w.key === 'revo-flow:verif') verifs.push(copy(w.value))
    return next(e)
  })
  on('session.messages', () => ({ value: [] }) as never)
  on('session.repo', () => ({ value: { root: rootOf(os), remote: null, internal: false, name: 'router_app' } }) as never)
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

  const asked: Question[] = []
  const ctl: { mobile: string | undefined; repondre: ((a: string) => void) | undefined } = { mobile: 'Lancer', repondre: undefined }
  on('tool.call', (_$, e) => {
    if (e.tool === 'AskUserQuestion') {
      const questions = (e as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions
      const q = questions[0]!
      const options = q.options.map(o => o.label)
      asked.push({ question: q.question, options })
      const reply = (a: string) => ({ result: { questions, answers: { [q.question]: a } } as never })
      if (options.includes('Lancer') && options.includes('Annuler')) return reply('Lancer')
      if (options.includes('Ajuster')) return reply('Utiliser')
      if (ctl.mobile !== undefined) return reply(ctl.mobile)
      return new Promise<ReturnType<typeof reply>>(resolve => {
        ctl.repondre = a => resolve(reply(a))
      })
    }
    return { result: {} as never }
  })
  on('model.complete', () => {
    const usage = { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: false, reason: 'empty-reply', usage } } as never
  })
  on('ui.notify', () => ({ value: { isSent: true } }) as never)
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as unknown as { text?: unknown; message?: unknown }).text ?? (e as unknown as { message?: unknown }).message ?? ''))
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
  on('agent.spawn', (_$, e) => {
    const agentId = `a-${e.description.split(' ')[0]!.toLowerCase()}`
    status[agentId] = 'running'
    return { model: e.model ?? 'inherit', agentId } as never
  })
  on('turn.start', () => ({ turnId: 't' }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}) as never)
  on('ui.render', (hook$, e) => h(hook$.ui.resolve(e).Box as never, {}) as never)
  return { clock, store, poste, runs, sortie, spawns, states, verifs, disk, registered, asked, ctl, toasts, status }
}

type World = ReturnType<typeof world>

const flush = async (w: World) => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await w.clock.settle()
}

const mobileOf = (w: World): MobileView | undefined => (w.states.verif as { mobile?: MobileView } | null | undefined)?.mobile
const lastMobile = (w: World): MobileView | undefined => [...w.verifs].reverse().map(v => (v as { mobile?: MobileView } | null)?.mobile).find(Boolean)
const mobileQuestions = (w: World) => w.asked.filter(q => /^Lancer l’app Flutter|^Démarrer Pixel 8/.test(q.question))

/** Un projet Flutter (pubspec.yaml et dossier android/), ou un projet Nuxt. */
const seed = (w: World, os: Os, kind: 'flutter' | 'nuxt' = 'flutter') => {
  if (kind === 'flutter') {
    w.disk[diskKey(`${rootOf(os)}/pubspec.yaml`)] = PUBSPEC
    w.disk[diskKey(`${rootOf(os)}/android`)] = ''
  } else w.disk[diskKey(`${rootOf(os)}/package.json`)] = PKG_NUXT
}

const spawnAgent = ($: Engine, description: string, subagentType = 'general-purpose', extra: Record<string, unknown> = {}) =>
  $.agent.spawn({ prompt: `Mission de ${description}`, description, subagentType, provider: { kind: 'model' }, ...extra } as never) as Promise<{ agentId?: string; deny?: string }>

async function launch($: Engine, w: World) {
  await $.command.run({ command: 'revo-flow', args: 'affiche le créneau choisi sur l’écran Réservation' } as never)
  await w.clock.advance(1)
  await w.clock.settle()
  await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN_MOBILE } as never)
  const front = (await spawnAgent($, 'Front écran')).agentId!
  const verifier = (await spawnAgent($, 'Vérificateur', 'revo-flow:verifier')).agentId!
  return { front, verifier }
}

const verif = async ($: Engine, action: string, agentId: string) => JSON.stringify(await $.tool.call({ tool: VERIF, action, agentId } as never))
const mobile = async ($: Engine, agentId: string, input: Record<string, unknown>) => JSON.stringify(await $.tool.call({ tool: MOBILE, agentId, ...input } as never))

const endTurn = async ($: Engine, w: World, agentId: string) => {
  w.status[agentId] = 'completed'
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer', agentId } as never)
  await w.clock.settle()
}

async function finish($: Engine, w: World, ids: string[]) {
  for (const id of ids) await endTurn($, w, id)
  await $.classic.Stop({ stop_hook_active: false } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await w.clock.settle()
}

const LENT = { timeoutMs: 30_000 }

/** flutter est un .bat sous Windows : cmd /c devant. */
const argvOf = (os: Os, argv: string[]) => (os === WINDOWS ? ['cmd', '/c', ...argv] : argv)
const RUN_ARGV = (os: Os, id: string) => argvOf(os, ['flutter', 'run', '-d', id])

for (const os of OSES) {
  describe(`preuve mobile (${os.nom})`, () => {
    test('la question est posée avant tout spawn, avec l’appareil branché ; « Pas cette fois » → aucun spawn, preuve mobile non vérifiable, outil mobile fermé', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      const { verifier } = await launch($, w)
      expect(w.registered).toContain('mobile')
      w.ctl.mobile = undefined
      const pending = verif($, 'mobile', verifier)
      await flush(w)
      const qs = mobileQuestions(w)
      expect(qs.length).toBe(1)
      expect(qs[0]!.question).toContain('Lancer l’app Flutter de router_app sur SM A515F (téléphone branché, Android 13 (API 33))')
      expect(qs[0]!.question).toContain('en direct')
      expect(qs[0]!.options).toEqual(['Lancer', 'Pas cette fois'])
      expect(w.spawns).toEqual([])
      expect(mobileOf(w)?.etat).toBe('question')
      w.ctl.repondre!('Pas cette fois')
      const r = await pending
      expect(r).toContain('revo-flow verif : l’utilisateur ne lance pas l’app : preuve mobile non vérifiable')
      expect(w.spawns).toEqual([])
      expect(mobileOf(w)?.etat).toBe('refuse')
      expect(await mobile($, verifier, { action: 'capture' })).toContain('preuve mobile n’est pas ouverte')
    })

    test('« Lancer » lance flutter run -d <téléphone> par process.spawn, l’app à l’écran lue dans la sortie, vue pret ; un 2e appel ne relance pas', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      const { verifier } = await launch($, w)
      const r = await verif($, 'mobile', verifier)
      expect(w.spawns.length).toBe(1)
      expect(w.spawns[0]!.argv).toEqual(RUN_ARGV(os, A51))
      expect(r).toContain('revo-flow verif : app Flutter à l’écran sur SM A515F (téléphone branché, Android 13 (API 33))')
      expect(r).toContain('mcp__revo-flow__mobile')
      const v = mobileOf(w)!
      expect(v).toMatchObject({ etat: 'pret', framework: 'Flutter', appareil: 'SM A515F (téléphone branché, Android 13 (API 33))', commande: `flutter run -d ${A51}` })
      expect(v.emulateurLance).toBeUndefined()
      expect(v.captures).toEqual([])
      expect(w.toasts.some(t => /app à l’écran sur SM A515F/.test(t))).toBe(true)
      const r2 = await verif($, 'mobile', verifier)
      expect(r2).toContain('app Flutter à l’écran')
      expect(w.spawns.length).toBe(1)
      expect(mobileQuestions(w).length).toBe(1)
      expect(w.spawns[0]!.closed).toBe(false)
    })

    test('outil mobile : capture écrite (capture-1.png et son base64), arbre condensé, toucher par adb, journal compté ; réservé au vérificateur', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      const { front, verifier } = await launch($, w)
      await verif($, 'mobile', verifier)
      expect(await mobile($, front, { action: 'capture' })).toContain('réservé au vérificateur')
      const c = await mobile($, verifier, { action: 'capture' })
      expect(c).toContain('capture 1 écrite')
      expect(c).toContain('Read')
      expect(w.runs.some(a => a.join(' ').includes(`flutter screenshot -d ${A51} -o`))).toBe(true)
      const txt = Object.keys(w.disk).filter(k => k.endsWith('/capture-1.png.txt'))
      expect(txt.length).toBe(1)
      expect(w.disk[txt[0]!]).toBe(PNG)
      expect(mobileOf(w)!.captures.length).toBe(1)
      expect(mobileOf(w)!.captures[0]!).toMatch(/capture-1\.png$/)
      const arbre = await mobile($, verifier, { action: 'arbre' })
      expect(arbre).toContain('TextView « Créneau 14h-15h » · centre 320,140')
      expect(arbre).toContain('Button « Réserver » #book · centre 540,1660 · cliquable')
      const tap = await mobile($, verifier, { action: 'toucher', x: 540, y: 1660 })
      expect(tap).toContain('toucher 540,1660 fait sur SM A515F')
      expect(w.runs.some(a => a.join(' ').includes(`adb -s ${A51} shell input tap 540 1660`))).toBe(true)
      w.spawns[0]!.push('I/flutter ( 1234): ══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞════\nA RenderFlex overflowed by 42 pixels on the right.\n')
      await flush(w)
      const j = await mobile($, verifier, { action: 'journal' })
      expect(j).toContain('exceptions : 1, débordements : 1')
      expect(j).toContain('logcat')
      expect(j).toContain('FATAL EXCEPTION')
      expect(await mobile($, verifier, { action: 'toucher' })).toContain('demande x et y')
      const c2 = await mobile($, verifier, { action: 'capture' })
      expect(c2).toContain('capture 2 écrite')
      expect(mobileOf(w)!.captures.length).toBe(2)
    })

    test('fin de flow : l’app lancée par revo-flow est arrêtée (itérateur fermé), mobile.etat arrete ; un téléphone n’est jamais éteint', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      const { front, verifier } = await launch($, w)
      expect(await verif($, 'mobile', verifier)).toContain('à l’écran')
      expect(w.spawns[0]!.closed).toBe(false)
      await finish($, w, [front, verifier])
      expect(w.spawns[0]!.closed).toBe(true)
      expect(lastMobile(w)?.etat).toBe('arrete')
      expect(w.runs.some(a => /emu kill|simctl shutdown/.test(a.join(' ')))).toBe(false)
    })

    test('aucun téléphone, un émulateur éteint : « Démarrer Pixel 8 » le lance avec sa fenêtre, l’app part sur emulator-5554, l’émulateur est éteint en fin de flow', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      w.poste.telephone = false
      w.poste.emulateur = true
      const { front, verifier } = await launch($, w)
      const r = await verif($, 'mobile', verifier)
      const qs = mobileQuestions(w)
      expect(qs.length).toBe(1)
      expect(qs[0]!.question).toContain('Démarrer Pixel 8 (émulateur, à démarrer) (sa fenêtre s’ouvrira) puis y lancer l’app Flutter')
      expect(w.runs.some(a => a.join(' ').includes('flutter emulators --launch Pixel_8'))).toBe(true)
      expect(w.runs.every(a => !a.join(' ').includes('no-window'))).toBe(true)
      expect(w.spawns.length).toBe(1)
      expect(w.spawns[0]!.argv).toEqual(RUN_ARGV(os, EMU))
      expect(r).toContain('émulateur démarré par revo-flow')
      expect(mobileOf(w)).toMatchObject({ etat: 'pret', emulateurLance: true, commande: `flutter run -d ${EMU}` })
      await finish($, w, [front, verifier])
      expect(w.spawns[0]!.closed).toBe(true)
      expect(w.runs.some(a => a.join(' ').includes(`adb -s ${EMU} emu kill`))).toBe(true)
      expect(lastMobile(w)).toMatchObject({ etat: 'arrete', emulateurLance: true })
    })

    test('aucun appareil : erreur dite, sans question ni spawn ; échec de build dans la sortie : l’app n’a pas été lancée, processus fermé', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      w.poste.telephone = false
      const { verifier } = await launch($, w)
      const avant = w.asked.length
      expect(await verif($, 'mobile', verifier)).toContain('l’app n’a pas été lancée (aucun appareil android')
      expect(w.asked.length).toBe(avant)
      expect(w.spawns).toEqual([])
      expect(mobileOf(w)?.etat).toBe('erreur')
    })

    test('échec de build : FAILURE: Build failed dans la sortie → erreur, processus fermé, outil mobile fermé', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      const { verifier } = await launch($, w)
      w.sortie.chunks = ["Running Gradle task 'assembleDebug'...\n", 'FAILURE: Build failed with an exception.\n']
      const r = await verif($, 'mobile', verifier)
      expect(w.spawns.length).toBe(1)
      expect(r).toContain('revo-flow verif : l’app n’a pas été lancée (FAILURE: Build failed with an exception.)')
      expect(mobileOf(w)?.etat).toBe('erreur')
      expect(w.spawns[0]!.closed).toBe(true)
      expect(await mobile($, verifier, { action: 'arbre' })).toContain('preuve mobile n’est pas ouverte')
    })

    test('le choix selon le projet : action web sur une app Flutter renvoie vers mobile ; action mobile sur un projet Nuxt dit qu’aucune app n’est détectée', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os)
      const { verifier } = await launch($, w)
      expect(await verif($, 'web', verifier)).toContain('ce projet est une app mobile Flutter (pubspec.yaml (flutter)) : sa preuve à l’exécution passe par l’action mobile')
      expect(w.spawns).toEqual([])
      expect(mobileQuestions(w)).toEqual([])
    })

    test('projet Nuxt : action mobile → aucune app mobile détectée, sans question ni spawn', LENT, async ($, on) => {
      const w = world(on, os)
      seed(w, os, 'nuxt')
      const { verifier } = await launch($, w)
      const avant = w.asked.length
      expect(await verif($, 'mobile', verifier)).toContain('revo-flow verif : aucune app mobile détectée')
      expect(w.asked.length).toBe(avant)
      expect(w.spawns).toEqual([])
    })
  })
}

test('option mobile à off → preuve mobile désactivée, sans question ni spawn, outil mobile non enregistré', { ...LENT, options: { mobile: 'off' } as never }, async ($, on) => {
  const w = world(on, WINDOWS)
  seed(w, WINDOWS)
  const { verifier } = await launch($, w)
  const avant = w.asked.length
  expect(await verif($, 'mobile', verifier)).toContain('revo-flow verif : preuve mobile désactivée (option mobile)')
  expect(w.asked.length).toBe(avant)
  expect(w.spawns).toEqual([])
  expect(w.registered).not.toContain('mobile')
})

test('le vérificateur lancé en arrière-plan est accepté et reste un vérificateur (Bash filtré)', LENT, async ($, on) => {
  // L'outil Agent de l'application de bureau ne propose que l'arrière-plan : refuser ce lancement bloquait toute vérification
  // (l'orchestrateur jugeait alors lui-même), sur le web comme sur l'émulateur.
  const w = world(on, WINDOWS)
  seed(w, WINDOWS)
  await $.command.run({ command: 'revo-flow', args: 'affiche le créneau choisi' } as never)
  await w.clock.advance(1)
  await w.clock.settle()
  await $.tool.call({ tool: 'mcp__revo-flow__plan', ...PLAN_MOBILE } as never)
  const r = await spawnAgent($, 'Vérificateur', 'revo-flow:verifier', { run_in_background: true })
  expect(r.deny).toBeUndefined()
  expect(r.agentId).toBeTruthy()
  // Il est bien suivi comme vérificateur : une commande qui écrit lui est refusée.
  const bash = await $.tool.call({ tool: 'Bash', agentId: r.agentId, command: 'rm -rf lib' } as never).then(
    x => (x as { deny?: string }).deny,
    err => (err instanceof Error ? err.message : String(err)),
  )
  expect(bash).toContain('lecture seule')
})
