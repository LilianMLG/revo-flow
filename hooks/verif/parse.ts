// Lecture des sorties de vérification en erreurs (docs/rd-v2/conception.md §7) : formats machine quand l'outil en a un (ESLint, Vitest et
// Jest en JSON, dart analyze --format=machine, flutter test --machine), sinon des motifs (tsc, vue-tsc, nuxi typecheck, Biome, dart format).
// Chaque erreur devient une signature { outil, fichier, code, message } sans numéro de ligne (il bouge) : c'est la clé de la base de référence.
// Pur ; CRLF et chemins Windows tolérés ; chemins rendus relatifs à la racine du projet.
import type { VerifErreur, VerifFormat, VerifSignature } from '../../types/verif'
import { norm } from './scope'

type Erreur = Omit<VerifErreur, 'statut'>
/** outil : l'id de la commande (rangé dans la signature) ; cwd : dossier du lancement, relatif à la racine ; racine : chemin absolu du projet ; argv : la commande lancée. */
export type ParseCtx = { outil: string; cwd: string; racine?: string; argv?: string[] }
type Sortie = { stdout: string; stderr: string; exitCode: number }

/** Longueur max d'un message gardé. */
const MAX_MESSAGE = 300

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const lines = (s: string) => s.replace(ANSI, '').split(/\r?\n/)
const firstLine = (s: string | undefined) =>
  (s ?? '')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(Boolean)
    ?.slice(0, MAX_MESSAGE) ?? ''

/** « a/./b/../c » → « a/c ». */
function resolveDots(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/** Un chemin de sortie (absolu, file://, relatif au cwd ; Windows ou POSIX) rendu relatif à la racine. Hors racine : gardé absolu. */
export function toRoot(p0: string, ctx: Pick<ParseCtx, 'cwd' | 'racine'>): string {
  let p = p0.trim()
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(p.slice(7))
    } catch {
      p = p.slice(7)
    }
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
  }
  p = norm(p)
  if (/^([A-Za-z]:)?\//.test(p)) {
    const r = ctx.racine ? norm(ctx.racine).replace(/\/$/, '') : ''
    if (!r) return p
    // Lettre de lecteur : comparaison sans la casse (c:\Users et C:\Users désignent le même dossier).
    const win = /^[A-Za-z]:/.test(r) || /^[A-Za-z]:/.test(p)
    const a = win ? p.toLowerCase() : p
    const b = win ? r.toLowerCase() : r
    if (a === b) return ''
    return a.startsWith(`${b}/`) ? p.slice(r.length + 1) : p
  }
  return resolveDots(ctx.cwd ? `${norm(ctx.cwd)}/${p}` : p)
}

/** Le premier bloc JSON de `text` qui commence en début de ligne par `open` et passe `ok` ; les lignes de bruit autour sont ignorées. */
function jsonFrom<T>(text: string, open: '[' | '{', ok: (j: unknown) => boolean): T | undefined {
  const close = open === '[' ? ']' : '}'
  const end = text.lastIndexOf(close)
  if (end < 0) return undefined
  const starts: number[] = []
  if (text.trimStart().startsWith(open)) starts.push(text.indexOf(open))
  for (let i = text.indexOf(`\n${open}`); i >= 0; i = text.indexOf(`\n${open}`, i + 1)) starts.push(i + 1)
  for (const s of starts) {
    try {
      const j = JSON.parse(text.slice(s, end + 1)) as unknown
      if (ok(j)) return j as T
    } catch {
      // pas ce bloc : on essaie le suivant
    }
  }
  return undefined
}

/** L'option vaut-elle 0 dans argv (--max-warnings 0, --max-warnings=0) ? */
const flagZero = (argv: string[] | undefined, flag: string) => {
  const a = argv ?? []
  const i = a.indexOf(flag)
  return (i >= 0 && a[i + 1] === '0') || a.includes(`${flag}=0`)
}

// ── Les lecteurs, un par format ───────────────────────────────────────────

type EslintFile = { filePath: string; messages: { ruleId?: string | null; severity: number; message: string; line?: number; column?: number; fatal?: boolean }[] }

/** ESLint -f json : erreurs (severity 2) et erreurs fatales ; avertissements seulement avec --max-warnings 0. */
function eslint(out: Sortie, ctx: ParseCtx): Erreur[] {
  const j = jsonFrom<EslintFile[]>(out.stdout, '[', x => Array.isArray(x) && x.every(f => typeof (f as EslintFile)?.filePath === 'string'))
  if (!j) return []
  const warn = flagZero(ctx.argv, '--max-warnings')
  const res: Erreur[] = []
  for (const f of j)
    for (const m of f.messages ?? []) {
      if (/^File ignored\b/.test(m.message)) continue
      if (m.severity !== 2 && !m.fatal && !(warn && m.severity === 1)) continue
      res.push({ outil: ctx.outil, fichier: toRoot(f.filePath, ctx), code: m.ruleId || (m.fatal ? 'syntaxe' : 'eslint'), message: firstLine(m.message), ligne: m.line, col: m.column })
    }
  return res
}

const TSC_PAREN = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/
const TSC_DASH = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/
const TSC_GLOBAL = /^error (TS\d+): (.*)$/

/** tsc, vue-tsc, nuxi typecheck : `fichier(l,c): error TSxxxx: …` et `fichier:l:c - error TSxxxx: …` (sortie colorée tolérée). */
function tsc(out: Sortie, ctx: ParseCtx): Erreur[] {
  const res: Erreur[] = []
  for (const raw of [...lines(out.stdout), ...lines(out.stderr)]) {
    const l = raw.trimEnd()
    const m = TSC_PAREN.exec(l) ?? TSC_DASH.exec(l)
    if (m) {
      res.push({ outil: ctx.outil, fichier: toRoot(m[1]!, ctx), code: m[4]!, message: m[5]!.trim().slice(0, MAX_MESSAGE), ligne: Number(m[2]), col: Number(m[3]) })
      continue
    }
    const g = TSC_GLOBAL.exec(l.trim())
    if (g) res.push({ outil: ctx.outil, fichier: '', code: g[1]!, message: g[2]!.trim().slice(0, MAX_MESSAGE) })
  }
  return res
}

type JestAssertion = { ancestorTitles?: string[]; title?: string; fullName?: string; status?: string; failureMessages?: string[]; location?: { line?: number; column?: number } | null }
type JestFile = { name?: string; testFilePath?: string; status?: string; message?: string; failureMessage?: string; assertionResults?: JestAssertion[] }
type JestJson = { testResults?: JestFile[] }

/** Vitest --reporter=json et Jest --json (27, 29) : un test rouge = une erreur (code 'echec', message = nom complet du test) ; un fichier qui ne charge pas = 'chargement'. */
function jestLike(out: Sortie, ctx: ParseCtx): Erreur[] {
  const j = jsonFrom<JestJson>(out.stdout, '{', x => typeof x === 'object' && x !== null && Array.isArray((x as JestJson).testResults))
  if (!j) return []
  const res: Erreur[] = []
  for (const f of j.testResults ?? []) {
    const fichier = toRoot(f.name ?? f.testFilePath ?? '', ctx)
    const rouges = (f.assertionResults ?? []).filter(a => a.status === 'failed')
    for (const a of rouges) {
      const nom = a.fullName || [...(a.ancestorTitles ?? []), a.title ?? ''].filter(Boolean).join(' > ')
      const e: Erreur = { outil: ctx.outil, fichier, code: 'echec', message: nom.slice(0, MAX_MESSAGE) }
      if (a.location?.line) e.ligne = a.location.line
      const d = firstLine(a.failureMessages?.[0])
      if (d) e.detail = d
      res.push(e)
    }
    if (!rouges.length && f.status === 'failed') {
      const e: Erreur = { outil: ctx.outil, fichier, code: 'chargement', message: 'le fichier de test ne se charge pas' }
      const d = firstLine(f.message || f.failureMessage)
      if (d) e.detail = d
      res.push(e)
    }
  }
  return res
}

const BIOME_HEAD = /^(\S+?)(?::(\d+):(\d+))?\s+((?:lint|format|organizeImports|assist|parse|syntax|suppressions|internalError)(?:\/[\w-]+)*)(?=\s|$)/
const BIOME_GITHUB = /^::(error|warning|notice)\s+(.*?)::(.*)$/

/** Biome check : rapport texte par défaut (`fichier:l:c catégorie` puis `✖ message`) ; aussi --reporter=github. Erreurs seulement (✖ ou ×). */
function biome(out: Sortie, ctx: ParseCtx): Erreur[] {
  const res: Erreur[] = []
  const all = [...lines(out.stdout), '', ...lines(out.stderr)]
  for (let i = 0; i < all.length; i++) {
    const l = all[i]!
    const g = BIOME_GITHUB.exec(l.trim())
    if (g) {
      if (g[1] !== 'error') continue
      const params = Object.fromEntries(g[2]!.split(',').map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
      res.push({ outil: ctx.outil, fichier: toRoot(params.file ?? '', ctx), code: params.title ?? 'biome', message: firstLine(g[3]), ligne: Number(params.line) || undefined, col: Number(params.col) || undefined })
      continue
    }
    const h = BIOME_HEAD.exec(l)
    if (!h) continue
    let j = i + 1
    while (j < all.length && !all[j]!.trim()) j++
    const m = /^\s*([✖×⚠!ℹi])\s+(.*)$/.exec(all[j] ?? '')
    if (!m || (m[1] !== '✖' && m[1] !== '×')) continue
    const e: Erreur = { outil: ctx.outil, fichier: toRoot(h[1]!, ctx), code: h[4]!, message: m[2]!.trim().slice(0, MAX_MESSAGE) }
    if (h[2]) {
      e.ligne = Number(h[2])
      e.col = Number(h[3])
    }
    res.push(e)
    i = j
  }
  return res
}

/** Un champ de dart analyze --format=machine : « \| », « \\ » et « \n » sont échappés. */
function machineFields(line: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '\\' && i + 1 < line.length) {
      const n = line[++i]!
      cur += n === 'n' ? ' ' : n === 'r' ? '' : n
    } else if (c === '|') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

/** dart analyze --format=machine : `SÉVÉRITÉ|TYPE|CODE|fichier|ligne|col|longueur|message`. ERROR et WARNING ; INFO seulement avec --fatal-infos. */
function dartMachine(out: Sortie, ctx: ParseCtx): Erreur[] {
  const infos = (ctx.argv ?? []).includes('--fatal-infos')
  const res: Erreur[] = []
  for (const l of [...lines(out.stdout), ...lines(out.stderr)]) {
    if (!/^(INFO|WARNING|ERROR)\|/.test(l)) continue
    const f = machineFields(l.trimEnd())
    if (f.length < 8) continue
    const [sev, , code, fichier, ligne, col] = f
    if (sev === 'INFO' && !infos) continue
    res.push({ outil: ctx.outil, fichier: toRoot(fichier!, ctx), code: code!.toLowerCase(), message: f.slice(7).join('|').trim().slice(0, MAX_MESSAGE), ligne: Number(ligne) || undefined, col: Number(col) || undefined })
  }
  return res
}

type FlutterTest = { name: string; suiteID?: number; url?: string | null; line?: number | null; root_url?: string | null; root_line?: number | null }

/** flutter test --machine et dart test --reporter=json : événements JSON ligne à ligne ; testDone sans succès = une erreur. */
function flutterJson(out: Sortie, ctx: ParseCtx): Erreur[] {
  const suites = new Map<number, string>()
  const tests = new Map<number, FlutterTest>()
  const errors = new Map<number, string>()
  const res: Erreur[] = []
  for (const l of lines(out.stdout)) {
    const t = l.trim()
    if (!t.startsWith('{')) continue
    let e: Record<string, unknown>
    try {
      e = JSON.parse(t) as Record<string, unknown>
    } catch {
      continue
    }
    if (e.type === 'suite') {
      const s = e.suite as { id: number; path?: string | null }
      if (s?.path) suites.set(s.id, s.path)
    } else if (e.type === 'testStart') {
      const s = e.test as FlutterTest & { id: number }
      if (s) tests.set(s.id, s)
    } else if (e.type === 'error') {
      const id = e.testID as number
      if (!errors.has(id)) errors.set(id, String(e.error ?? ''))
    } else if (e.type === 'testDone') {
      if (e.result === 'success' || e.skipped === true) continue
      const s = tests.get(e.testID as number)
      if (!s) continue
      const chargement = s.name.startsWith('loading ')
      const src = (s.suiteID !== undefined && suites.get(s.suiteID)) || s.root_url || s.url || (chargement ? s.name.slice(8) : '')
      const err: Erreur = { outil: ctx.outil, fichier: toRoot(src, ctx), code: chargement ? 'chargement' : 'echec', message: chargement ? 'le fichier de test ne se charge pas' : s.name.slice(0, MAX_MESSAGE) }
      const ligne = s.root_line ?? s.line
      if (!chargement && ligne) err.ligne = ligne
      const d = firstLine(errors.get(e.testID as number))
      if (d) err.detail = d
      res.push(err)
    }
  }
  return res
}

/** Sortie texte : `Changed x.dart` (dart format --output=none) et `[warn] x.ts` (prettier --check) ; rien d'autre n'est lisible. */
function texte(out: Sortie, ctx: ParseCtx): Erreur[] {
  const res: Erreur[] = []
  for (const l of [...lines(out.stdout), ...lines(out.stderr)]) {
    const d = /^Changed (.+\.dart)\s*$/.exec(l)
    if (d) res.push({ outil: ctx.outil, fichier: toRoot(d[1]!, ctx), code: 'format', message: 'formatage à refaire (dart format)' })
    const p = /^\[warn\] (.+?)\s*$/.exec(l)
    if (p && !/Code style issues|Run Prettier|--write/.test(p[1]!)) res.push({ outil: ctx.outil, fichier: toRoot(p[1]!, ctx), code: 'format', message: 'formatage à refaire (prettier)' })
  }
  return res
}

/** Les erreurs d'une sortie, chemins relatifs à la racine. Une sortie illisible (outil absent, config cassée) donne [] : c'est au runner d'en tirer l'état 'erreur'. */
export function parseOutput(format: VerifFormat, out: Sortie, ctx: ParseCtx): Erreur[] {
  switch (format) {
    case 'eslint-json':
      return eslint(out, ctx)
    case 'tsc':
      return tsc(out, ctx)
    case 'vitest-json':
    case 'jest-json':
      return jestLike(out, ctx)
    case 'biome':
      return biome(out, ctx)
    case 'dart-machine':
      return dartMachine(out, ctx)
    case 'flutter-json':
      return flutterJson(out, ctx)
    default:
      return texte(out, ctx)
  }
}

/** Un message sans ce qui bouge d'une exécution à l'autre : couleurs, espaces, positions (l,c), « line 12 ». */
export function normalizeMessage(m: string): string {
  return m
    .replace(ANSI, '')
    .replace(/\((\d+),(\d+)\)/g, '')
    .replace(/:\d+:\d+\b/g, '')
    .replace(/\b(line|ligne)\s+\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE)
}

/** La clé d'une erreur dans la base : outil|fichier|code|message normalisé, sans ligne ni colonne. */
export function signatureKey(s: VerifSignature): string {
  return `${s.outil}|${norm(s.fichier)}|${s.code}|${normalizeMessage(s.message)}`
}
