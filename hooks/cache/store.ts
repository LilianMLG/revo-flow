// Stockage et git du cache : tout ce qui touche le disque et git. Les modèles et la logique du graphe sont dans graph.ts (pur).
// Pas de Node ici, et pas de `$` non plus : le moteur ne suit `$` que dans le fichier qui le reçoit, jamais à travers un import.
// register.tsx construit donc un `Io` (ioOf) dont chaque méthode appelle $.fs, $.process, $.env, $.session ou $.clock.
import type { EngineInterface } from 'claude-code'

import type { Graph, SourceFile } from '../../types/cache'
import { EXCLUS_DEFAUT, buildGraph, isExcluded, isIndexable, projectKey, updateFiles } from './graph'

type $ = EngineInterface

/** Ce que le cache demande au moteur ; construit par ioOf($) dans register.tsx. */
export type Io = {
  fs: {
    read: (path: string) => Promise<string>
    write: $['fs']['write']
    list: $['fs']['list']
    exists: $['fs']['exists']
    stat: (path: string) => ReturnType<$['fs']['stat']>
  }
  run: $['process']['run']
  now: $['clock']['now']
  /** USERPROFILE (Windows), sinon HOME ; undefined si les deux sont vides. */
  home: () => Promise<string | undefined>
  repo: $['session']['repo']
  root: $['session']['root']
}

export type ProjectRef = { cle: string; racine: string; nom: string }

/** Le plus gros fichier que $.fs.read accepte, et la taille max d'un fichier graphe écrit. */
const MAX_READ = 4 * 1024 * 1024
const MAX_WRITE = 4 * 1024 * 1024 - 1024
/** Délai d'une commande git. */
const GIT_MS = 30_000
/** Lectures de fichiers en parallèle. */
const BATCH = 16
/** Garde-fou du parcours sans git. */
const MAX_WALK = 20000

// ── Fonctions pures : chemins et sorties de git ──────────────────────────

/** Un chemin Windows ou POSIX en chemin à « / » : sans « \ », sans « // » doublé, sans « ./ » de tête ni « / » final. */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1)
  return s
}

/** Le nom du fichier du graphe : « front/reservation-tool » → « front-reservation-tool.json » ; les caractères interdits sous Windows deviennent « - ». */
export function graphFileName(cle: string): string {
  return cle.replace(/[\\/<>:"|?*]/g, '-') + '.json'
}

/** La clé que rend un nom de fichier du graphe (le contraire de graphFileName pour front-x et back-x, sinon le nom sans extension). */
function keyFromFileName(name: string): string {
  const base = name.replace(/\.json$/, '')
  return /^(front|back)-/.test(base) ? base.replace('-', '/') : base
}

/** Un chemin entre guillemets, tel que git l'écrit quand il échappe (guillemet, antislash, tabulation, saut de ligne, ou un octet en octal d'UTF-8). */
function unquoteC(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s
  const bytes: number[] = []
  const enc = new TextEncoder()
  const inner = s.slice(1, -1)
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (c !== '\\') {
      bytes.push(...enc.encode(c))
      continue
    }
    const n = inner[++i] ?? ''
    if (/[0-7]/.test(n)) {
      let oct = n
      while (oct.length < 3 && /[0-7]/.test(inner[i + 1] ?? '')) oct += inner[++i]
      bytes.push(parseInt(oct, 8))
    } else {
      const map: Record<string, string> = { t: '\t', n: '\n', r: '\r', '"': '"', '\\': '\\' }
      bytes.push(...enc.encode(map[n] ?? n))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** Les enregistrements d'une sortie git : séparés par NUL avec -z, par ligne sinon. */
const records = (out: string, nul: boolean) => (nul ? out.split('\0') : out.split(/\r?\n/)).filter(r => r !== '')

/** `git ls-files -s` (avec ou sans -z) → { chemin → 12 premiers hex du blob }. Les sous-modules (mode 160000) sont ignorés. */
export function parseLsFiles(out: string): Record<string, string> {
  const res: Record<string, string> = {}
  for (const rec of records(out, out.includes('\0'))) {
    const m = /^(\d+) ([0-9a-f]{40,64}) \d\t(.*)$/s.exec(rec)
    if (!m || m[1] === '160000') continue
    res[normalizePath(unquoteC(m[3]!))] = m[2]!.slice(0, 12)
  }
  return res
}

/** Une ligne de `git status --porcelain` : x = index, y = disque ; `from` pour un renommage ou une copie. */
export type StatusEntry = { x: string; y: string; p: string; from?: string }

/** `git status --porcelain` (avec ou sans -z). */
export function parseStatus(out: string): StatusEntry[] {
  const res: StatusEntry[] = []
  const nul = out.includes('\0')
  const recs = records(out, nul)
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]!
    if (rec.length < 4) continue
    const x = rec[0]!
    const y = rec[1]!
    let p = rec.slice(3)
    let from: string | undefined
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      if (nul) from = recs[++i]
      else {
        const k = p.indexOf(' -> ')
        if (k >= 0) {
          from = p.slice(0, k)
          p = p.slice(k + 4)
        }
      }
    }
    const entry: StatusEntry = { x, y, p: normalizePath(unquoteC(p)) }
    if (from !== undefined) entry.from = normalizePath(unquoteC(from))
    res.push(entry)
  }
  return res
}

/** Une ligne de `git diff --name-status -M` : A, M, D, T, R (renommé) ou C (copié). */
export type NameStatus = { status: string; p: string; from?: string; score?: number }

/** `git diff --name-status -M` (avec ou sans -z). */
export function parseNameStatus(out: string): NameStatus[] {
  const res: NameStatus[] = []
  if (out.includes('\0')) {
    const t = records(out, true)
    for (let i = 0; i < t.length; i++) {
      const code = t[i]!
      const status = code[0]!
      if (status === 'R' || status === 'C') {
        const from = t[++i]
        const p = t[++i]
        if (from === undefined || p === undefined) break
        res.push({ status, p: normalizePath(p), from: normalizePath(from), score: Number(code.slice(1)) || 0 })
      } else {
        const p = t[++i]
        if (p === undefined) break
        res.push({ status, p: normalizePath(p) })
      }
    }
    return res
  }
  for (const line of records(out, false)) {
    const parts = line.split('\t')
    const code = parts[0] ?? ''
    const status = code[0] ?? ''
    if (!status) continue
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      res.push({ status, p: normalizePath(unquoteC(parts[2]!)), from: normalizePath(unquoteC(parts[1]!)), score: Number(code.slice(1)) || 0 })
    } else if (parts[1] !== undefined) {
      res.push({ status, p: normalizePath(unquoteC(parts[1])) })
    }
  }
  return res
}

/** Un chemin est-il à indexer : exactement ce que buildGraph garde (isIndexable de graph.ts : extension source, hors exclusions). package.json est lu à part. */
export function isRetained(p: string, exclus: string[]): boolean {
  return isIndexable(p, exclus)
}

type Counters = Record<string, number>
const statsOf = (g: Graph): Counters => ((g as unknown as { stats?: Counters }).stats ?? {}) as Counters
const timeOf = (f: unknown): string => (f as { appris?: { le?: string } } | undefined)?.appris?.le ?? ''

/**
 * Fusionne deux versions du même graphe : `mine` (ce que cette session veut écrire) et `disk` (ce qu'une autre session a écrit entre-temps).
 * - fiches : feature par feature, la plus récente `appris.le` gagne (égalité : `mine`) ; une fiche absente d'un côté est gardée ; `usages` prend le plus grand de chaque compteur ;
 * - couche mécanique (projet, fichiers, nœuds, candidates) : celle qui a été indexée le plus récemment ;
 * - stats : `disk` + ce que `mine` a ajouté depuis `baseStats` (les compteurs lus au chargement) ; sans base, le plus grand des deux ;
 * - rev : le plus grand des deux, plus un.
 */
export function mergeGraphs(mine: Graph, disk: Graph, baseStats?: Counters): Graph {
  const features: Record<string, unknown> = { ...(disk.features as Record<string, unknown>) }
  for (const [k, f] of Object.entries(mine.features as Record<string, unknown>)) {
    const d = features[k]
    if (d === undefined) {
      features[k] = f
      continue
    }
    const [win, lose] = timeOf(f) >= timeOf(d) ? [f, d] : [d, f]
    const wu = (win as { usages?: Counters }).usages
    const lu = (lose as { usages?: Counters }).usages
    if (wu || lu) {
      const usages: Counters = { ...(lu ?? {}), ...(wu ?? {}) }
      for (const key of Object.keys(usages)) usages[key] = Math.max(wu?.[key] ?? 0, lu?.[key] ?? 0)
      features[k] = { ...(win as object), usages }
    } else features[k] = win
  }

  const ms = statsOf(mine)
  const ds = statsOf(disk)
  const stats: Counters = {}
  for (const key of new Set([...Object.keys(ms), ...Object.keys(ds)])) {
    const m = ms[key] ?? 0
    const d = ds[key] ?? 0
    stats[key] = baseStats ? d + Math.max(0, m - (baseStats[key] ?? 0)) : Math.max(m, d)
  }

  const mineIsNewer = (mine.projet.indexe?.le ?? '') >= (disk.projet.indexe?.le ?? '')
  const mech = mineIsNewer ? mine : disk
  return {
    ...mine,
    projet: mech.projet,
    fichiers: mech.fichiers,
    noeuds: mech.noeuds,
    candidates: mech.candidates,
    features,
    stats,
    rev: Math.max(mine.rev ?? 0, disk.rev ?? 0) + 1,
  } as unknown as Graph
}

// ── Chemins et projet ────────────────────────────────────────────────────

/** Le dossier personnel : USERPROFILE (Windows), HOME en repli. Les noms d'une variable doivent être des littéraux. */
async function homeDir(io: Io): Promise<string> {
  const home = await io.home().catch(() => undefined)
  if (!home) throw new Error('dossier personnel introuvable (USERPROFILE et HOME sont vides)')
  return normalizePath(home)
}

async function graphsDir(io: Io): Promise<string> {
  return `${await homeDir(io)}/.claude/revo-flow/graphs`
}

/** Le fichier du graphe d'un projet : <home>/.claude/revo-flow/graphs/<cle avec / remplacé par ->.json */
export async function graphPath(io: Io, cle: string): Promise<string> {
  return `${await graphsDir(io)}/${graphFileName(cle)}`
}

const baseName = (p: string) => normalizePath(p).split('/').pop() ?? ''
const isAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')

async function isDir(io: Io, p: string): Promise<boolean> {
  try {
    return (await io.fs.stat(p)).kind === 'dir'
  } catch {
    return false
  }
}

/** Le sous-dossier de `parent` qui s'appelle `name` à la casse près, avec sa vraie casse. */
async function findDir(io: Io, parent: string, name: string): Promise<string | undefined> {
  try {
    const entries = await io.fs.list(parent)
    const hit = entries.find(e => e.kind === 'dir' && e.name.toLowerCase() === name.toLowerCase())
    return hit ? `${parent}/${hit.name}` : undefined
  } catch {
    return undefined
  }
}

const toRef = (racine: string): ProjectRef => ({ cle: projectKey(racine), racine, nom: baseName(racine) })

/**
 * Le projet visé. Sans argument : celui de la session (io.repo().root, sinon io.root()).
 * Avec un chemin absolu : ce dossier. Avec un nom (reservation-tool, back/graphql, Front/ui-vel) : le dossier sous Documents/Front puis Documents/Back.
 * undefined si le dossier n'existe pas.
 */
export async function resolveProject(io: Io, nameOrPath?: string): Promise<ProjectRef | undefined> {
  const wanted = nameOrPath?.trim()
  if (!wanted) {
    const repo = await io.repo().catch(() => null)
    let root = repo?.root
    if (!root) root = await io.root().catch(() => undefined)
    return root ? toRef(normalizePath(root)) : undefined
  }
  if (isAbsolute(wanted)) {
    const p = normalizePath(wanted)
    return (await isDir(io, p)) ? toRef(p) : undefined
  }
  const docs = `${await homeDir(io)}/Documents`
  const parts = normalizePath(wanted).split('/').filter(Boolean)
  const first = parts[0]?.toLowerCase()
  if (parts.length === 2 && (first === 'front' || first === 'back')) {
    const group = await findDir(io, docs, first)
    const racine = group ? await findDir(io, group, parts[1]!) : undefined
    return racine ? toRef(racine) : undefined
  }
  if (parts.length !== 1) return undefined
  for (const g of ['front', 'back']) {
    const group = await findDir(io, docs, g)
    const racine = group ? await findDir(io, group, parts[0]!) : undefined
    if (racine) return toRef(racine)
  }
  return undefined
}

/** Les projets qui ont déjà un graphe : les fichiers .json de ~/.claude/revo-flow/graphs/ (un graphe supprimé n'est qu'un marqueur de 2 octets : ignoré). */
export async function listGraphs(io: Io): Promise<{ cle: string; path: string; mtimeMs: number }[]> {
  try {
    const dir = await graphsDir(io)
    const entries = await io.fs.list(dir)
    return entries
      .filter(e => e.kind === 'file' && e.name.endsWith('.json') && e.size > 2)
      .map(e => ({ cle: keyFromFileName(e.name), path: `${dir}/${e.name}`, mtimeMs: e.mtimeMs }))
  } catch {
    return []
  }
}

// ── Fichiers ─────────────────────────────────────────────────────────────

/** Le texte d'un fichier, ou undefined s'il est absent, illisible ou trop gros (> 4 Mio). */
export async function readTextSafe(io: Io, path: string): Promise<string | undefined> {
  try {
    return await io.fs.read(path)
  } catch {
    return undefined
  }
}

/** Estimation de tokens d'un fichier : taille / 4 arrondie au-dessus ; 0 s'il est absent. */
export async function fileTokens(io: Io, racine: string, p: string): Promise<number> {
  try {
    const st = await io.fs.stat(`${normalizePath(racine)}/${p}`)
    return st.kind === 'file' ? Math.ceil(st.size / 4) : 0
  } catch {
    return 0
  }
}

const isGraph = (g: unknown): g is Graph => {
  const o = g as { projet?: { cle?: unknown } } | null
  return !!o && typeof o === 'object' && typeof o.projet === 'object' && o.projet !== null && typeof o.projet.cle === 'string'
}

const EMPTY_MARK = '{' + '}'

/** Lit et analyse un fichier graphe : le graphe, vide (absent ou marqueur de suppression) ou illisible. */
async function readGraphFile(io: Io, path: string): Promise<{ graph: Graph } | 'vide' | 'illisible'> {
  const text = await readTextSafe(io, path)
  if (text === undefined || text.trim() === '' || text.trim() === EMPTY_MARK) return 'vide'
  try {
    const g = JSON.parse(text) as unknown
    return isGraph(g) ? { graph: g } : 'illisible'
  } catch {
    return 'illisible'
  }
}

/** Les compteurs de stats vus au dernier chargement ou à la dernière écriture, par projet : la base du calcul de ce qu'une session a ajouté (mergeGraphs). */
const bases = new Map<string, Counters>()

/**
 * Le graphe d'un projet, ou null s'il est absent ou illisible.
 * Un fichier illisible est recopié en .bak ; la copie .tmp de la dernière écriture sert alors de secours.
 */
export async function loadGraph(io: Io, ref: ProjectRef): Promise<Graph | null> {
  try {
    const path = await graphPath(io, ref.cle)
    let r = await readGraphFile(io, path)
    if (r === 'illisible') {
      const raw = await readTextSafe(io, path)
      if (raw) await io.fs.write(`${path}.bak`, raw).catch(() => undefined)
      const alt = await readGraphFile(io, `${path}.tmp`)
      r = typeof alt === 'object' ? alt : 'illisible'
    }
    if (typeof r !== 'object') return null
    bases.set(ref.cle, { ...statsOf(r.graph) })
    return r.graph
  } catch {
    return null
  }
}

/**
 * Écrit le graphe, sans jamais écraser le travail d'une autre session.
 * Pas de renommage dans $.fs : on écrit le .tmp, on le relit pour vérifier, puis on écrit la cible (la copie .tmp reste, c'est un secours).
 * Avant d'écrire on relit la cible : si son rev n'est plus celui de graph, mergeGraphs fusionne feature par feature. rev est incrémenté.
 * Il reste une fenêtre de quelques millisecondes entre la relecture et l'écriture (pas de verrou dans $.fs).
 */
export async function saveGraph(io: Io, graph: Graph): Promise<Graph> {
  const cle = graph.projet.cle
  const path = await graphPath(io, cle)
  let out: Graph
  const disk = await readGraphFile(io, path)
  if (typeof disk === 'object' && (disk.graph.rev ?? 0) !== (graph.rev ?? 0)) out = mergeGraphs(graph, disk.graph, bases.get(cle))
  else out = { ...graph, rev: (graph.rev ?? 0) + 1 } as Graph
  const json = JSON.stringify(out)
  if (new TextEncoder().encode(json).length > MAX_WRITE) throw new Error(`graphe de ${cle} trop volumineux pour être écrit (plus de 4 Mio)`)
  try {
    await io.fs.write(`${path}.tmp`, json)
    if ((await readTextSafe(io, `${path}.tmp`)) !== json) throw new Error('relecture différente')
    await io.fs.write(path, json)
  } catch (e) {
    throw new Error(`écriture du graphe de ${cle} impossible : ${e instanceof Error ? e.message : String(e)}`)
  }
  bases.set(cle, { ...statsOf(out) })
  return out
}

/**
 * Supprime le graphe d'un projet. $.fs n'a ni remove ni unlink (vérifié dans les typings) :
 * le fichier et sa copie .tmp sont réécrits avec le marqueur d'objet vide (2 octets). loadGraph le lit comme absent et listGraphs l'ignore.
 */
export async function deleteGraph(io: Io, cle: string): Promise<void> {
  const path = await graphPath(io, cle)
  bases.delete(cle)
  await io.fs.write(`${path}.tmp`, EMPTY_MARK).catch(() => undefined)
  try {
    if (await io.fs.exists(path)) await io.fs.write(path, EMPTY_MARK)
  } catch (e) {
    throw new Error(`suppression du graphe de ${cle} impossible : ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── Git ──────────────────────────────────────────────────────────────────

type GitResult = { ok: boolean; out: string; truncated: boolean; spawnFailed: boolean }

/** Une commande git dans racine, sans jamais lever : ok = code 0 ; spawnFailed = git ne démarre pas. */
async function git(io: Io, racine: string, args: string[], stdin?: string): Promise<GitResult> {
  try {
    const r = await io.run(['git', '-c', 'core.quotepath=false', '--literal-pathspecs', ...args], {
      cwd: racine,
      timeoutMs: GIT_MS,
      ...(stdin !== undefined ? { stdin } : {}),
    })
    return { ok: r.exitCode === 0, out: r.stdout, truncated: r.isStdoutTruncated, spawnFailed: false }
  } catch {
    return { ok: false, out: '', truncated: false, spawnFailed: true }
  }
}

/** git ls-files -s -z ; si sa sortie est coupée à 4 Mio, on repasse dossier par dossier (récursivement) en sautant les exclusions. */
async function lsFiles(io: Io, racine: string, exclus: string[]): Promise<Record<string, string> | undefined> {
  const all = await git(io, racine, ['ls-files', '-s', '-z'])
  if (!all.ok) return undefined
  if (!all.truncated) return parseLsFiles(all.out)

  const res: Record<string, string> = {}
  const visit = async (dir: string): Promise<void> => {
    const entries = await io.fs.list(dir === '' ? racine : `${racine}/${dir}`)
    const prefix = dir === '' ? '' : `${dir}/`
    const files: string[] = []
    for (const e of entries) {
      if (e.name === '.git') continue
      const rel = prefix + e.name
      if (e.kind === 'dir') {
        if (isExcluded(`${rel}/`, exclus)) continue
        const r = await git(io, racine, ['ls-files', '-s', '-z', '--', `${rel}/`])
        if (r.ok && !r.truncated) Object.assign(res, parseLsFiles(r.out))
        else if (r.truncated) await visit(rel)
      } else files.push(rel)
    }
    for (let i = 0; i < files.length; i += 200) {
      const r = await git(io, racine, ['ls-files', '-s', '-z', '--', ...files.slice(i, i + 200)])
      if (r.ok) Object.assign(res, parseLsFiles(r.out))
    }
  }
  await visit('')
  return res
}

/** git hash-object des fichiers du disque (non commités) : { chemin → 12 hex }. Un fichier qui a disparu entre-temps est ignoré. */
async function hashObjects(io: Io, racine: string, paths: string[]): Promise<Record<string, string>> {
  const res: Record<string, string> = {}
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500)
    const r = await git(io, racine, ['hash-object', '--stdin-paths'], chunk.join('\n') + '\n')
    const lines = r.out.split(/\r?\n/).filter(Boolean)
    if (r.ok && lines.length === chunk.length) {
      chunk.forEach((p, k) => (res[p] = lines[k]!.slice(0, 12)))
      continue
    }
    // Un chemin a échoué : un par un, pour ne perdre que celui-là.
    for (const p of chunk) {
      const one = await git(io, racine, ['hash-object', '--', p])
      const h = one.out.trim()
      if (one.ok && h) res[p] = h.slice(0, 12)
    }
  }
  return res
}

/** Le parcours du dossier sans git : { chemin → taille-mtimeMs }, avec les mêmes exclusions. */
async function walkHashes(io: Io, racine: string, exclus: string[]): Promise<Record<string, string>> {
  const res: Record<string, string> = {}
  const stack = ['']
  let count = 0
  while (stack.length > 0 && count < MAX_WALK) {
    const dir = stack.pop()!
    const entries = await io.fs.list(dir === '' ? racine : `${racine}/${dir}`)
    const prefix = dir === '' ? '' : `${dir}/`
    for (const e of entries) {
      if (e.isLink || e.name === '.git' || e.name === 'node_modules') continue
      const rel = prefix + e.name
      if (e.kind === 'dir') {
        if (!isExcluded(`${rel}/`, exclus)) stack.push(rel)
      } else if (e.kind === 'file' && isRetained(rel, exclus)) {
        res[rel] = `${e.size}-${e.mtimeMs}`
        count++
      }
    }
  }
  return res
}

type DiskState = { hashes: Record<string, string>; usesGit: boolean }

/** L'état du disque : le hash de chaque fichier retenu. Avec git : ls-files -s, corrigé par status (supprimés, modifiés, non suivis par hash-object). Sans git : taille et mtime. */
async function diskState(io: Io, racine: string, exclus: string[]): Promise<DiskState> {
  let tracked: Record<string, string> | undefined
  try {
    tracked = await lsFiles(io, racine, exclus)
  } catch {
    tracked = undefined
  }
  if (!tracked) {
    try {
      return { hashes: await walkHashes(io, racine, exclus), usesGit: false }
    } catch {
      throw new Error(`dossier illisible : ${racine}`)
    }
  }
  const hashes: Record<string, string> = {}
  for (const [p, h] of Object.entries(tracked)) if (isRetained(p, exclus)) hashes[p] = h

  const st = await git(io, racine, ['status', '--porcelain', '-z', '--untracked-files=all'])
  if (st.ok) {
    const toHash: string[] = []
    for (const e of parseStatus(st.truncated ? st.out.slice(0, st.out.lastIndexOf('\0')) : st.out)) {
      if (e.y === 'D') delete hashes[e.p]
      else if ((e.y === 'M' || e.y === 'T' || e.y === 'U' || e.y === 'A' || (e.x === '?' && e.y === '?')) && isRetained(e.p, exclus)) toHash.push(e.p)
    }
    Object.assign(hashes, await hashObjects(io, racine, toHash))
  }
  return { hashes, usesGit: true }
}

/** Les hash actuels du disque { chemin → hash } pour les fichiers retenus, sans rien relire : la fraîcheur rapide. */
export async function currentHashes(io: Io, racine: string, exclus: string[] = EXCLUS_DEFAUT): Promise<Record<string, string>> {
  return (await diskState(io, normalizePath(racine), exclus)).hashes
}

/** Lit les fichiers par lots ; ceux qui sont illisibles ou trop gros (> 4 Mio) sont laissés de côté. */
async function readSources(io: Io, racine: string, hashes: Record<string, string>, paths: string[], onProgress?: (done: number, total: number) => void): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  let done = 0
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH)
    const texts = await Promise.all(batch.map(p => readTextSafe(io, `${racine}/${p}`)))
    batch.forEach((p, k) => {
      const text = texts[k]
      if (text !== undefined && text.length <= MAX_READ) out.push({ p, h: hashes[p] ?? '', text })
    })
    done += batch.length
    onProgress?.(done, paths.length)
  }
  return out
}

/** Le commit court et la branche ; vides sans git. */
async function headInfo(io: Io, racine: string): Promise<{ commit: string; branche: string }> {
  const c = await git(io, racine, ['rev-parse', '--short', 'HEAD'])
  const b = await git(io, racine, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return { commit: c.ok ? c.out.trim() : '', branche: b.ok ? b.out.trim() : '' }
}

async function nowIso(io: Io): Promise<string> {
  return new Date(await io.now()).toISOString()
}

/**
 * Construit la couche mécanique d'un projet : fichiers retenus (isIndexable : exclusions, extensions ; moins de 4 Mio), package.json, commit, branche, historique git, puis buildGraph.
 * prev conserve les fiches. Sans git, on parcourt le dossier avec io.fs.list (hash = taille-mtime).
 * Lève une Error en français : dossier illisible.
 */
export async function buildMechanical(io: Io, ref: ProjectRef, prev?: Graph | null, onProgress?: (done: number, total: number) => void): Promise<Graph> {
  const racine = normalizePath(ref.racine)
  try {
    await io.fs.list(racine)
  } catch {
    throw new Error(`dossier illisible : ${racine}`)
  }
  const exclus = prev?.projet.exclus ?? EXCLUS_DEFAUT
  const { hashes, usesGit } = await diskState(io, racine, exclus)
  const paths = Object.keys(hashes).sort()
  const files = await readSources(io, racine, hashes, paths, onProgress)
  const pkg = await readTextSafe(io, `${racine}/package.json`)
  const head = usesGit ? await headInfo(io, racine) : { commit: '', branche: '' }
  const log = usesGit ? (await git(io, racine, ['log', '-n', '500', '--pretty=format:%s', '--name-only'])).out : ''
  return buildGraph({
    cle: ref.cle,
    racine,
    nom: ref.nom,
    files,
    ...(pkg !== undefined ? { pkgJson: pkg } : {}),
    commit: head.commit,
    branche: head.branche,
    le: await nowIso(io),
    log,
    exclus,
    prev: prev ?? null,
  })
}

/**
 * Rafraîchissement incrémental : compare les hash du disque à ceux du graphe, ne relit que les fichiers ajoutés ou modifiés,
 * détecte les renommages (git diff --name-status -M depuis le commit indexé, sinon un fichier disparu et un nouveau de même hash) et appelle updateFiles.
 * changed : chemins ajoutés, modifiés ou arrivés par renommage ; removed : chemins supprimés ou quittés par un renommage.
 * Rien n'est écrit : l'appelant enregistre avec saveGraph.
 */
export async function refreshGraph(io: Io, graph: Graph): Promise<{ graph: Graph; changed: string[]; removed: string[] }> {
  const racine = normalizePath(graph.projet.racine)
  const exclus = graph.projet.exclus ?? EXCLUS_DEFAUT
  const { hashes, usesGit } = await diskState(io, racine, exclus)
  const known = graph.fichiers as Record<string, { h?: string }>

  const changed = Object.keys(hashes).filter(p => known[p] === undefined || known[p]!.h !== hashes[p])
  const gone = Object.keys(known).filter(p => hashes[p] === undefined)
  if (changed.length === 0 && gone.length === 0) return { graph, changed: [], removed: [] }

  // Renommages : l'avis de git d'abord, puis, pour le reste, même hash.
  const added = new Set(changed.filter(p => known[p] === undefined))
  const goneSet = new Set(gone)
  const renamed: [string, string][] = []
  const commit = graph.projet.indexe?.commit
  if (usesGit && commit && added.size > 0 && goneSet.size > 0) {
    const d = await git(io, racine, ['diff', '--name-status', '-M', '-z', commit])
    if (d.ok) {
      for (const e of parseNameStatus(d.out)) {
        if (e.status === 'R' && e.from && goneSet.has(e.from) && added.has(e.p)) {
          renamed.push([e.from, e.p])
          goneSet.delete(e.from)
          added.delete(e.p)
        }
      }
    }
  }
  for (const from of [...goneSet]) {
    const h = known[from]?.h
    const to = h ? [...added].find(p => hashes[p] === h) : undefined
    if (to !== undefined) {
      renamed.push([from, to])
      goneSet.delete(from)
      added.delete(to)
    }
  }

  const sources = await readSources(io, racine, hashes, changed)
  const head = usesGit ? await headInfo(io, racine) : { commit: graph.projet.indexe?.commit ?? '', branche: graph.projet.indexe?.branche ?? '' }
  const next = updateFiles(graph, sources, [...goneSet], renamed, { commit: head.commit, branche: head.branche, le: await nowIso(io) })
  return { graph: next, changed, removed: [...goneSet, ...renamed.map(([from]) => from)] }
}
