import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Feature, Graph } from '../../types/cache'
import { graphFileName, mergeGraphs, normalizePath, parseLsFiles, parseNameStatus, parseStatus } from './store'

const HOME = 'C:\\Users\\x'
const DOCS = 'C:/Users/x/Documents'
const NOW = Date.UTC(2026, 9, 14, 9)
const EMPTY_OBJECT = '{' + '}'

// ── Un petit monde : disque en mémoire et git scripté ────────────────────

/** Un hash de blob de 40 hex dont les 12 premiers sont s complété par des zéros. */
const blob = (s: string) => s.padEnd(40, '0')
const h12 = (s: string) => s.padEnd(12, '0')

type Repo = {
  /** Fichiers suivis : chemin, préfixe du hash. */
  tracked: Record<string, string>
  /** Sortie brute de git status --porcelain -z. */
  status: string
  /** Hash que rend hash-object pour un fichier du disque. */
  hashObject: Record<string, string>
  head: string
  branch: string
  log: string
  diff: string
  /** Sortie de ls-files -s -z coupée quand elle n'a pas de pathspec. */
  truncateAll: boolean
  /** Les commandes git reçues (arguments après les options communes). */
  calls: string[][]
}

type World = { files: Map<string, string>; repo: Repo | undefined; writes: string[]; clock: ReturnType<typeof mock.clock> }

const abs = (p: string) => normalizePath(p)

type Init = { files?: Record<string, string>; repo?: Partial<Repo>; sessionRoot?: string; repoRoot?: string | null }

function world(on: On, init: Init = {}): World {
  mock.env(on, { USERPROFILE: HOME })
  const clock = mock.clock(on, { now: NOW })
  const w: World = {
    files: new Map(Object.entries(init.files ?? {}).map(([p, t]) => [abs(p), t])),
    repo: init.repo
      ? { status: '', hashObject: {}, head: 'abc1234', branch: 'main', log: '', diff: '', truncateAll: false, calls: [], ...init.repo, tracked: { ...(init.repo.tracked ?? {}) } }
      : undefined,
    writes: [],
    clock,
  }
  const isDirPath = (d: string) => [...w.files.keys()].some(k => k.startsWith(d + '/'))
  on('fs.read', (_$, e) => {
    const t = w.files.get(abs(e.path))
    if (t === undefined) return { deny: 'ENOENT' }
    return { value: t } as never
  })
  on('fs.write', (_$, e) => {
    w.files.set(abs(e.path), e.text)
    w.writes.push(abs(e.path))
    return { value: undefined } as never
  })
  on('fs.exists', (_$, e) => ({ value: w.files.has(abs(e.path)) || isDirPath(abs(e.path)) }) as never)
  on('fs.stat', (_$, e) => {
    const p = abs(e.path)
    const t = w.files.get(p)
    if (t !== undefined) return { value: { kind: 'file', size: t.length, mtimeMs: 1000 + t.length, isLink: false } } as never
    if (isDirPath(p)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } as never
    return { deny: 'ENOENT' }
  })
  on('fs.list', (_$, e) => {
    const d = abs(e.path)
    if (!isDirPath(d)) return { deny: 'ENOENT' }
    const seen = new Map<string, 'file' | 'dir'>()
    for (const k of w.files.keys()) {
      if (!k.startsWith(d + '/')) continue
      const rest = k.slice(d.length + 1)
      seen.set(rest.split('/')[0]!, rest.includes('/') ? 'dir' : 'file')
    }
    const entries = [...seen].map(([name, kind]) => {
      const t = w.files.get(`${d}/${name}`)
      return { name, kind, size: t?.length ?? 0, mtimeMs: t === undefined ? 0 : 1000 + t.length, isLink: false }
    })
    return { value: entries } as never
  })
  const defaultRoot = 'C:\\Users\\x\\Documents\\Front\\app'
  on('session.root', () => ({ value: init.sessionRoot ?? defaultRoot }) as never)
  on('session.repo', () => ({ value: init.repoRoot === null ? null : { root: init.repoRoot ?? defaultRoot, remote: null, internal: false, name: null } }) as never)
  on('process.run', (_$, e) => {
    const r = w.repo
    const res = (stdout: string, exitCode = 0, truncated = false) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: truncated, isStderrTruncated: false } }) as never
    if (e.argv[0] !== 'git') return res('', 127)
    if (!r) return res('', 128)
    const args = e.argv.slice(4)
    r.calls.push(args)
    const sub = args[0]
    if (sub === 'ls-files') {
      const spec = args.includes('--') ? args.slice(args.indexOf('--') + 1) : []
      if (spec.length === 0 && r.truncateAll) return res('', 0, true)
      const lines = Object.entries(r.tracked)
        .filter(([p]) => spec.length === 0 || spec.some(s => (s.endsWith('/') ? p.startsWith(s) : p === s)))
        .map(([p, h]) => `100644 ${blob(h)} 0\t${p}\0`)
      return res(lines.join(''))
    }
    if (sub === 'status') return res(r.status)
    if (sub === 'hash-object') {
      const paths = args.includes('--stdin-paths') ? (e.init?.stdin ?? '').split('\n').filter(Boolean) : [args[args.length - 1]!]
      const known = paths.map(p => r.hashObject[p])
      if (known.some(h => h === undefined)) return res('', 128)
      return res(known.map(h => blob(h!)).join('\n') + '\n')
    }
    if (sub === 'rev-parse') return res((args.includes('--short') ? r.head : r.branch) + '\n')
    if (sub === 'log') return res(r.log)
    if (sub === 'diff') return res(r.diff)
    return res('', 1)
  })
  // La confirmation d'un dialogue (cache clear) : toujours Supprimer.
  on('tool.call', (_$, e) => {
    if (e.tool === 'AskUserQuestion') {
      const questions = (e as unknown as { questions: { question: string }[] }).questions
      return { result: { questions, answers: { [questions[0]!.question]: 'Supprimer' } } as never }
    }
    return { result: {} as never }
  })
  return w
}

/** Le sink de progression de buildMechanical (une fonction ne traverse pas l'appel d'outil). */
const feature = (id: string, le: string, over: Partial<Feature> = {}): Feature => ({
  id,
  titre: id,
  alias: [],
  resume: '',
  flux: [],
  entrees: [],
  fichiers: [],
  pieges: [],
  deps: [],
  confiance: 0.9,
  source: 'manuel',
  appris: { le, commit: 'abc1234', branche: 'main' },
  perime: [],
  usages: { servie: 0, evites: 0 },
  ...over,
})

const ZERO = { flows: 0, servis: 0, evites: 0, net: 0 }

const graph = (rev: number, features: Feature[], stats = ZERO, indexe = '2026-10-14T09:00:00Z'): Graph => ({
  v: 1,
  rev,
  projet: {
    cle: 'front/app',
    racine: `${DOCS}/Front/app`,
    nom: 'app',
    stack: '',
    indexe: { commit: 'abc1234', branche: 'main', le: indexe, fichiers: 0, tok: 0 },
    exclus: ['node_modules/'],
  },
  fichiers: {},
  noeuds: {},
  features: Object.fromEntries(features.map(f => [f.id, f])),
  candidates: [],
  stats,
})

// ── Fonctions pures ──────────────────────────────────────────────────────

test('normalizePath : séparateurs, doublons, ./ et / final', () => {
  expect(normalizePath('C:\\Users\\x\\Documents\\Front\\app\\')).toBe('C:/Users/x/Documents/Front/app')
  expect(normalizePath('./pages//index.vue')).toBe('pages/index.vue')
  expect(normalizePath('/home/x/')).toBe('/home/x')
  expect(normalizePath('C:\\')).toBe('C:/')
})

test('graphFileName : / devient -, caractères interdits aussi', () => {
  expect(graphFileName('front/reservation-tool')).toBe('front-reservation-tool.json')
  expect(graphFileName('back/graphql')).toBe('back-graphql.json')
  expect(graphFileName('a:b*c')).toBe('a-b-c.json')
})

test('parseLsFiles : -z, lignes, chemins entre guillemets, sous-modules ignorés', () => {
  const h1 = 'a'.repeat(40)
  const h2 = 'b'.repeat(40)
  const nul = `100644 ${h1} 0\tpages/index.vue\x00100755 ${h2} 0\tscripts/run.mjs\x00160000 ${h1} 0\tlibraries/sub\0`
  expect(parseLsFiles(nul)).toEqual({ 'pages/index.vue': 'aaaaaaaaaaaa', 'scripts/run.mjs': 'bbbbbbbbbbbb' })
  const quoted = String.raw`"caf\303\251/x.ts"`
  const lines = `100644 ${h1} 0\tutils/a.ts\n100644 ${h2} 0\t${quoted}\n`
  expect(parseLsFiles(lines)).toEqual({ 'utils/a.ts': 'aaaaaaaaaaaa', 'café/x.ts': 'bbbbbbbbbbbb' })
  expect(parseLsFiles('')).toEqual({})
})

test('parseStatus : -z et texte, renommage, non suivi', () => {
  expect(parseStatus(' M utils/a.ts\0?? new.ts\0R  to.ts\0from.ts\0 D gone.vue\0')).toEqual([
    { x: ' ', y: 'M', p: 'utils/a.ts' },
    { x: '?', y: '?', p: 'new.ts' },
    { x: 'R', y: ' ', p: 'to.ts', from: 'from.ts' },
    { x: ' ', y: 'D', p: 'gone.vue' },
  ])
  expect(parseStatus(' M utils/a.ts\nR  old.ts -> new dir/new.ts\nA  added.js\n')).toEqual([
    { x: ' ', y: 'M', p: 'utils/a.ts' },
    { x: 'R', y: ' ', p: 'new dir/new.ts', from: 'old.ts' },
    { x: 'A', y: ' ', p: 'added.js' },
  ])
})

test('parseNameStatus : -z et texte, renommages avec score', () => {
  expect(parseNameStatus('M\0a.ts\0R087\0old.ts\0new.ts\0D\0gone.ts\0A\0add.ts\0')).toEqual([
    { status: 'M', p: 'a.ts' },
    { status: 'R', p: 'new.ts', from: 'old.ts', score: 87 },
    { status: 'D', p: 'gone.ts' },
    { status: 'A', p: 'add.ts' },
  ])
  expect(parseNameStatus('M\ta.ts\nR100\told.ts\tnew.ts\n')).toEqual([
    { status: 'M', p: 'a.ts' },
    { status: 'R', p: 'new.ts', from: 'old.ts', score: 100 },
  ])
})

test('mergeGraphs : fiche la plus récente, fiches des deux côtés, stats additionnées, rev', () => {
  const mine = graph(3, [feature('panier', '2026-10-14T10:00:00Z', { resume: 'moi' }), feature('mien', '2026-10-14T08:00:00Z')], { flows: 2, servis: 12, evites: 100, net: 0 })
  const disk = graph(4, [feature('panier', '2026-10-14T09:00:00Z', { resume: 'disque' }), feature('autre', '2026-10-14T07:00:00Z')], { flows: 3, servis: 15, evites: 150, net: 0 })
  const m = mergeGraphs(mine, disk, { flows: 1, servis: 10, evites: 90, net: 0 })
  expect(Object.keys(m.features).sort()).toEqual(['autre', 'mien', 'panier'])
  expect(m.features['panier']!.resume).toBe('moi')
  // disque + ce que mine a ajouté depuis la base
  expect(m.stats).toEqual({ flows: 4, servis: 17, evites: 160, net: 0 })
  expect(m.rev).toBe(5)

  const older = graph(3, [feature('panier', '2026-10-14T08:00:00Z', { resume: 'moi' })])
  expect(mergeGraphs(older, disk).features['panier']!.resume).toBe('disque')
  // sans base : le plus grand des deux
  expect(mergeGraphs(mine, disk).stats.servis).toBe(15)
})

test('mergeGraphs : la couche mécanique la plus récemment indexée gagne ; usages au plus grand', () => {
  const mine = graph(1, [feature('f', '2026-10-14T10:00:00Z', { usages: { servie: 1, evites: 500 } })], ZERO, '2026-10-14T09:00:00Z')
  const disk = graph(2, [feature('f', '2026-10-14T09:00:00Z', { usages: { servie: 4, evites: 100 } })], ZERO, '2026-10-14T11:00:00Z')
  disk.fichiers = { 'a.ts': { k: 'util', h: 'aaaaaaaaaaaa', tok: 1 } }
  const m = mergeGraphs(mine, disk)
  expect(Object.keys(m.fichiers)).toEqual(['a.ts'])
  expect(m.projet.indexe.le).toBe('2026-10-14T11:00:00Z')
  expect(m.features['f']!.usages).toEqual({ servie: 4, evites: 500 })
})


// ── Intégration : /revo-flow cache pilote store.ts (ni $.fs ni $.process ne sont ceux du test : tout est scripté) ──

const run = async ($: Engine, args: string) => (await $.command.run({ command: 'revo-flow', args } as never)).text ?? ''

const RACINE = `${DOCS}/Front/app`
const GRAPH_DIR = 'C:/Users/x/.claude/revo-flow/graphs'
const GRAPH_FILE = `${GRAPH_DIR}/front-app.json`
const sources = (racine: string): Record<string, string> => ({
  [`${racine}/package.json`]: JSON.stringify({ name: 'app', dependencies: { nuxt: '^3.0.0' } }),
  [`${racine}/pages/index.vue`]: '<template><Basket /></template>',
  [`${racine}/components/Basket.vue`]: '<template><div /></template>',
  [`${racine}/utils/a.ts`]: 'export const a = 1',
  [`${racine}/node_modules/x/index.js`]: 'x',
  [`${racine}/logo.png`]: 'png',
})
const TRACKED = { 'package.json': 'a1', 'pages/index.vue': 'a2', 'components/Basket.vue': 'a3', 'utils/a.ts': 'a4', 'node_modules/x/index.js': 'a5', 'logo.png': 'a6' }
const RETENUS = ['components/Basket.vue', 'pages/index.vue', 'utils/a.ts']
const readGraph = (w: World, file = GRAPH_FILE) => JSON.parse(w.files.get(file)!) as Graph

test('cache build : fichiers retenus, hash de git, commit, branche ; écrit .tmp puis la cible, sous le dossier du plugin', async ($, on) => {
  const w = world(on, { files: sources(RACINE), repo: { tracked: TRACKED, log: 'feat(basket): panier\nutils/a.ts\n' } })
  expect(await run($, 'cache build')).toMatch(/couche mécanique construite \(3 fichiers\)/)
  expect(w.writes).toEqual([`${GRAPH_FILE}.tmp`, GRAPH_FILE])
  const g = readGraph(w)
  expect(g.rev).toBe(1)
  expect(Object.keys(g.fichiers).sort()).toEqual(RETENUS)
  expect(g.fichiers['utils/a.ts']!.h).toBe(h12('a4'))
  expect(g.projet.cle).toBe('front/app')
  expect(g.projet.racine).toBe(RACINE)
  expect(g.projet.indexe.commit).toBe('abc1234')
  expect(g.projet.indexe.branche).toBe('main')
  expect(g.projet.stack).toContain('Nuxt 3')
  const calls = w.repo!.calls
  expect(calls.some(c => c[0] === 'ls-files' && c.includes('-s') && c.includes('-z'))).toBe(true)
  expect(calls.some(c => c[0] === 'status' && c.includes('--porcelain'))).toBe(true)
  expect(calls.some(c => c[0] === 'log' && c.includes('-n') && c.includes('500') && c.includes('--name-only'))).toBe(true)
})

test('cache build : git status corrige les hash (modifié, non suivi) et retire les supprimés', async ($, on) => {
  const w = world(on, {
    files: { ...sources(RACINE), [`${RACINE}/utils/new.ts`]: 'export const n = 1' },
    repo: {
      tracked: { ...TRACKED, 'pages/gone.vue': 'a7' },
      status: ' M utils/a.ts\0?? utils/new.ts\0 D pages/gone.vue\0',
      hashObject: { 'utils/a.ts': 'f4', 'utils/new.ts': 'f5' },
    },
  })
  await run($, 'cache build')
  const g = readGraph(w)
  expect(g.fichiers['utils/a.ts']!.h).toBe(h12('f4'))
  expect(g.fichiers['utils/new.ts']!.h).toBe(h12('f5'))
  expect(g.fichiers['pages/gone.vue']).toBeUndefined()
  expect(g.fichiers['pages/index.vue']!.h).toBe(h12('a2'))
  expect(w.repo!.calls.some(c => c[0] === 'hash-object' && c.includes('--stdin-paths'))).toBe(true)
})

test('ls-files coupé à 4 Mio : repasse dossier par dossier, sans demander les dossiers exclus', async ($, on) => {
  const w = world(on, { files: sources(RACINE), repo: { tracked: TRACKED, truncateAll: true } })
  await run($, 'cache build')
  expect(Object.keys(readGraph(w).fichiers).sort()).toEqual(RETENUS)
  expect(w.repo!.calls.some(c => c[0] === 'ls-files' && c.includes('--') && c.includes('pages/'))).toBe(true)
  expect(w.repo!.calls.some(c => c.includes('node_modules/'))).toBe(false)
})

test('cache : rafraîchissement incrémental (modifié, supprimé, renommé) enregistré avec rev + 1', async ($, on) => {
  const w = world(on, { files: sources(RACINE), repo: { tracked: TRACKED } })
  await run($, 'cache build')
  // utils/a.ts modifié, pages/index.vue supprimé, components/Basket.vue renommé en Cart.vue (même blob).
  w.files.set(`${RACINE}/utils/a.ts`, 'export const a = 2')
  w.files.delete(`${RACINE}/pages/index.vue`)
  w.files.delete(`${RACINE}/components/Basket.vue`)
  w.files.set(`${RACINE}/components/Cart.vue`, '<template><div /></template>')
  const t = w.repo!.tracked
  t['utils/a.ts'] = 'b4'
  delete t['pages/index.vue']
  delete t['components/Basket.vue']
  t['components/Cart.vue'] = 'a3'
  await w.clock.advance(31_000)
  await run($, 'cache')
  const g = readGraph(w)
  expect(Object.keys(g.fichiers).sort()).toEqual(['components/Cart.vue', 'utils/a.ts'])
  expect(g.fichiers['utils/a.ts']!.h).toBe(h12('b4'))
  expect(g.fichiers['components/Cart.vue']!.h).toBe(h12('a3'))
  expect(g.rev).toBe(2)
})

test('cache : un renommage avec modification est annoncé par git diff -M depuis le commit indexé', async ($, on) => {
  const w = world(on, { files: sources(RACINE), repo: { tracked: TRACKED } })
  await run($, 'cache build')
  w.files.delete(`${RACINE}/utils/a.ts`)
  w.files.set(`${RACINE}/utils/b.ts`, 'export const a = 3')
  delete w.repo!.tracked['utils/a.ts']
  w.repo!.tracked['utils/b.ts'] = 'c9'
  w.repo!.diff = 'R090\0utils/a.ts\0utils/b.ts\0'
  await w.clock.advance(31_000)
  await run($, 'cache')
  const g = readGraph(w)
  expect(g.fichiers['utils/a.ts']).toBeUndefined()
  expect(g.fichiers['utils/b.ts']!.h).toBe(h12('c9'))
  expect(w.repo!.calls.some(c => c[0] === 'diff' && c.includes('-M') && c.includes('abc1234'))).toBe(true)
})

test('cache : rien de changé, rien d écrit', async ($, on) => {
  const w = world(on, { files: sources(RACINE), repo: { tracked: TRACKED } })
  await run($, 'cache build')
  const writes = w.writes.length
  await w.clock.advance(31_000)
  await run($, 'cache')
  expect(w.writes.length).toBe(writes)
  expect(readGraph(w).rev).toBe(1)
})

test('sans git : repli sur taille et mtime, construction et rafraîchissement', async ($, on) => {
  const w = world(on, { files: sources(RACINE) })
  await run($, 'cache build')
  const a = `${RACINE}/utils/a.ts`
  const len = w.files.get(a)!.length
  const g = readGraph(w)
  expect(Object.keys(g.fichiers).sort()).toEqual(RETENUS)
  expect(g.fichiers['utils/a.ts']!.h).toBe(`${len}-${1000 + len}`)
  expect(g.projet.indexe.commit).toBe('')
  w.files.set(a, 'export const a = 12345')
  const len2 = w.files.get(a)!.length
  await w.clock.advance(31_000)
  await run($, 'cache')
  expect(readGraph(w).fichiers['utils/a.ts']!.h).toBe(`${len2}-${1000 + len2}`)
})

test('écriture concurrente : le graphe d une autre session est fusionné, rev dépasse les deux', async ($, on) => {
  const w = world(on, { files: sources(RACINE), repo: { tracked: TRACKED } })
  await run($, 'cache build')
  // Une autre session écrit entre-temps : rev 5 et une fiche que nous ne connaissons pas.
  const other = { ...readGraph(w), rev: 5 }
  other.features = { b: feature('b', '2026-10-14T09:00:00Z') }
  w.files.set(GRAPH_FILE, JSON.stringify(other))
  await w.clock.advance(31_000)
  await run($, 'cache build')
  const g = readGraph(w)
  expect(Object.keys(g.features)).toEqual(['b'])
  expect(g.rev).toBe(6)
})

test('cache clear : confirmation, marqueur vide, puis aucun graphe', async ($, on) => {
  const w = world(on, { files: sources(RACINE), repo: { tracked: TRACKED } })
  await run($, 'cache build')
  expect(await run($, 'cache clear')).toMatch(/cache de app supprimé/)
  expect(w.files.get(GRAPH_FILE)).toBe(EMPTY_OBJECT)
  expect(await run($, 'cache clear')).toMatch(/aucun graphe pour app, rien à supprimer/)
})

test('cache <projet> : le dossier sous Documents/Front, graphe nommé front-<projet>.json', async ($, on) => {
  const other = `${DOCS}/Front/ui-vel`
  const w = world(on, { files: { ...sources(RACINE), ...sources(other) }, repo: { tracked: TRACKED } })
  expect(await run($, 'cache ui-vel')).toMatch(/revo-flow cache · ui-vel : 3 fichiers/)
  const g = readGraph(w, `${GRAPH_DIR}/front-ui-vel.json`)
  expect(g.projet.cle).toBe('front/ui-vel')
  expect(g.projet.racine).toBe(other)
  expect(w.files.has(GRAPH_FILE)).toBe(false)
})

test('un graphe illisible est recopié en .bak puis reconstruit', async ($, on) => {
  const w = world(on, { files: sources(RACINE), repo: { tracked: TRACKED } })
  w.files.set(GRAPH_FILE, 'pas du json')
  await run($, 'cache build')
  expect(w.files.get(`${GRAPH_FILE}.bak`)).toBe('pas du json')
  expect(readGraph(w).rev).toBe(1)
})
