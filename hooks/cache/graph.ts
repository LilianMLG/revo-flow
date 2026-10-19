// Le graphe de cache d'un projet : module PUR (aucun appel à $, aucun accès disque, tout entre en paramètres).
// Spec : docs/rd-graphe-cache/conception.md §2 à §5.

import { euros, fmt, modelLabel, slug } from '../lib'
import type {
  AgentInfo,
  CacheHit,
  CacheStats,
  Candidate,
  ColdFile,
  DiffEntry,
  EdgeKind,
  Edges,
  Feature,
  FeatureFile,
  FileNode,
  FileRole,
  FlowCache,
  Freshness,
  Graph,
  GraphNode,
  LearnContext,
  LearnInput,
  LearnResult,
  NodeKind,
  PerimeEntry,
  RefreshContext,
  SourceFile,
} from '../../types/cache'

// ── Bases ────────────────────────────────────────────────────────────────

/** Taille estimée en tokens : caractères / 4. */
export const tokensOf = (text: string) => Math.ceil(text.length / 4)

/** Exclus par défaut : dépendances, sorties de build, fichiers générés, sous-module, traductions, verrous, outils. */
export const EXCLUS_DEFAUT: string[] = [
  'node_modules/',
  'dist/',
  '.nuxt/',
  '.output/',
  'generated/',
  'coverage/',
  'public/',
  'static/',
  'locales/*.json',
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  '.claude/',
  '.agents/',
  '.kiro/',
  '.devcontainer/',
  '.vscode/',
  '.idea/',
  '.husky/',
  '.lighthouseci/',
  'libraries/',
  '__snapshots__/',
  'playwright-report/',
  'test-results/',
  '*.min.js',
  '.dart_tool/',
  '*.g.dart',
  '*.freezed.dart',
  '*.mocks.dart',
]

/** Les extensions indexées : code (dont Dart), gabarits GraphQL et docs. */
export const SOURCE_EXT = /\.(vue|ts|tsx|js|jsx|mjs|cjs|dart|graphql|gql|md)$/i

/** Version du format de la couche mécanique : un graphe d'une autre version est reconstruit en entier (fiches gardées). 4 : sum mécanique. */
export const MECA_FORMAT = 4

/** Chemin relatif, séparateur /, sans ./ de tête. */
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '')

const globCache = new Map<string, RegExp>()
function globRe(pat: string): RegExp {
  const hit = globCache.get(pat)
  if (hit) return hit
  const p = norm(pat).replace(/^\//, '')
  let body = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    if (c === '*' && p[i + 1] === '*') (body += '.*'), i++
    else if (c === '*') body += '[^/]*'
    else if (c === '?') body += '[^/]'
    else body += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c
  }
  const re = new RegExp(p.endsWith('/') ? `(^|/)${body}` : `(^|/)${body}$`)
  globCache.set(pat, re)
  return re
}

/** Le chemin tombe-t-il sous une exclusion ? « x/ » = dossier à n'importe quelle profondeur, « *.lock » = nom de fichier, « locales/*.json » = motif. */
export function isExcluded(p: string, exclus: string[]): boolean {
  const f = norm(p)
  return exclus.some(x => globRe(x).test(f))
}

/** Un fichier à indexer : extension source et pas exclu. */
export const isIndexable = (p: string, exclus: string[] = EXCLUS_DEFAUT) => SOURCE_EXT.test(p) && !isExcluded(p, exclus)

const SRC_DIRS = new Set(['src', 'app'])
const DIR_KIND: Record<string, NodeKind> = {
  pages: 'page',
  views: 'page',
  components: 'composant',
  composables: 'composable',
  stores: 'store',
  store: 'store',
  services: 'service',
  service: 'service',
  repository: 'service',
  repositories: 'service',
  api: 'service',
  server: 'service',
  graphql: 'gql',
  gql: 'gql',
  apollo: 'gql',
  types: 'type',
  interfaces: 'type',
  models: 'type',
  utils: 'util',
  helpers: 'util',
  lib: 'util',
  libs: 'util',
  mixins: 'mixin',
  middleware: 'middleware',
  middlewares: 'middleware',
  plugins: 'plugin',
  layouts: 'layout',
  config: 'config',
  configs: 'config',
  docs: 'doc',
}

/** Dossiers d'une app Flutter, cherchés du plus profond au moins profond sous lib/ (lib/features/x/presentation/widgets/…). */
const DART_DIR_KIND: Record<string, NodeKind> = {
  ...DIR_KIND,
  lib: 'autre',
  screens: 'page',
  pages: 'page',
  widgets: 'composant',
  providers: 'store',
  notifiers: 'store',
  blocs: 'store',
  bloc: 'store',
  domain: 'service',
  data: 'service',
  entities: 'type',
}

/** La stack est-elle celle d'un plugin Claude Code (detectStack a lu .claude-plugin/plugin.json) ? */
const isPluginStack = (stack: string | undefined) => (stack ?? '').includes('Plugin Claude Code')

/** Le type d'un fichier, d'après son chemin ; `stack` départage hooks/ : code du plugin (service) ou hooks React/Vue (composable). */
export function kindOf(p: string, stack?: string): NodeKind {
  const l = norm(p).toLowerCase()
  if (l.endsWith('.md')) return 'doc'
  if (/(^|\/)(tests?|__tests__|e2e|specs?|integration_test)\//.test(l) || /\.(spec|test|e2e)\.[cm]?[jt]sx?$/.test(l) || l.endsWith('_test.dart')) return 'test'
  if (/\.(graphql|gql)$/.test(l)) return 'gql'
  if (l.endsWith('.d.ts')) return 'type'
  const segs = l.split('/')
  if (l.endsWith('.dart')) {
    for (let i = segs.length - 2; i >= 0; i--) {
      const k = DART_DIR_KIND[segs[i]!]
      if (k && k !== 'autre') return k
    }
    return 'autre'
  }
  if (segs.length === 1) return /config|rc\.|^\./.test(l) ? 'config' : 'autre'
  const top = SRC_DIRS.has(segs[0]!) && segs.length > 2 ? segs[1]! : segs[0]!
  if (top === 'hooks') return isPluginStack(stack) ? 'service' : 'composable'
  return DIR_KIND[top] ?? 'autre'
}

/** Libellés au pluriel, pour les textes et le panneau. */
export const KIND_LABEL: Record<string, string> = {
  page: 'Pages',
  composant: 'Composants',
  composable: 'Composables',
  store: 'Stores',
  service: 'Services',
  gql: 'GraphQL',
  api: 'API',
  route: 'Routes',
  type: 'Types',
  util: 'Utils',
  mixin: 'Mixins',
  middleware: 'Middlewares',
  plugin: 'Plugins',
  layout: 'Layouts',
  config: 'Config',
  test: 'Tests',
  doc: 'Docs',
  externe: 'Externes',
  autre: 'Autres',
  feature: 'Features',
}

/** Deux hash de blob désignent-ils le même contenu ? (l'un peut être tronqué à 12 caractères) */
export function sameHash(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const n = Math.min(a.length, b.length)
  return a.slice(0, n) === b.slice(0, n)
}

/** 6 hex, synchrone (FNV-1a 32 bits), pour la clé d'un projet hors Documents/Front|Back. */
export function hashPath(s: string): string {
  const t = s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0').slice(0, 6)
}

/** 'front/reservation-tool', 'back/graphql', sinon slug du dossier + 6 hex du chemin. Fichier : cle.replace('/', '-') + '.json'. */
export function projectKey(racine: string): string {
  const m = /(?:^|[\\/])Documents[\\/](Front|Back)[\\/]([^\\/]+)/i.exec(racine)
  if (m) return `${m[1]!.toLowerCase()}/${slug(m[2]!) || 'projet'}`
  const base = racine.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return `${slug(base) || 'projet'}-${hashPath(racine)}`
}

/** Le nom du paquet d'un pubspec.yaml (`name: router_app`), qui préfixe ses imports `package:router_app/…`. */
export function dartPackageOf(pubspec: string | undefined): string | undefined {
  return /^name:\s*['"]?([A-Za-z_]\w*)/m.exec(pubspec ?? '')?.[1]
}

/** Les dépendances d'un pubspec.yaml (dependencies et dev_dependencies), sans parseur YAML : clés indentées sous ces sections. */
function pubspecDeps(pubspec: string): Set<string> {
  const deps = new Set<string>()
  let inDeps = false
  for (const line of pubspec.split(/\r?\n/)) {
    if (/^\S/.test(line)) inDeps = /^(dev_)?dependencies\s*:/.test(line)
    else if (inDeps) {
      const m = /^ {1,4}([A-Za-z_]\w*)\s*:/.exec(line)
      if (m) deps.add(m[1]!)
    }
  }
  return deps
}

/** « Flutter, Riverpod, Supabase » d'après pubspec.yaml. */
function dartStack(pubspec: string): string[] {
  const deps = pubspecDeps(pubspec)
  const has = (...n: string[]) => n.some(x => deps.has(x))
  const out = [has('flutter') ? 'Flutter' : 'Dart']
  if (has('flutter_riverpod', 'hooks_riverpod', 'riverpod')) out.push('Riverpod')
  if (has('flutter_bloc', 'bloc')) out.push('Bloc')
  if (has('provider')) out.push('Provider')
  if (has('go_router')) out.push('go_router')
  if (has('supabase_flutter', 'supabase')) out.push('Supabase')
  if (has('firebase_core')) out.push('Firebase')
  if (has('freezed')) out.push('freezed')
  if (has('mocktail', 'mockito')) out.push(has('mocktail') ? 'mocktail' : 'mockito')
  return out
}

/** Les fichiers de la racine qui trahissent une stack sans package.json ni pubspec.yaml ; lus par buildMechanical (store.ts). */
export const MANIFESTES = ['.claude-plugin/plugin.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml'] as const

/**
 * « Nuxt 3, Pinia, Apollo, Vuetify, vitest » d'après package.json et la liste des fichiers ; « Flutter, Riverpod » d'après pubspec.yaml ;
 * « Plugin Claude Code, TypeScript », « Python », « Go », « Rust » d'après les manifestes présents (chemin → texte). 'inconnue' sinon.
 */
export function detectStack(pkgJson: string | undefined, files: string[], pubspec?: string, manifestes: Record<string, string> = {}): string {
  let deps: Record<string, string> = {}
  try {
    const j = JSON.parse(pkgJson ?? '{}') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }
  } catch {
    deps = {}
  }
  const has = (n: string) => typeof deps[n] === 'string'
  const major = (n: string) => {
    const m = /(\d+)/.exec(deps[n] ?? '')
    return m ? Number(m[1]) : undefined
  }
  const paths = files.map(norm)
  const dir = (d: string) => paths.some(p => p.startsWith(`${d}/`) || p.startsWith(`src/${d}/`) || p.startsWith(`app/${d}/`))
  const out: string[] = []
  let nuxt = 0
  if (has('nuxt3')) nuxt = 3
  else if (has('nuxt-edge')) nuxt = 2
  else if (has('nuxt')) nuxt = major('nuxt') ?? 3
  else if (paths.some(p => /^nuxt\.config\.(ts|js|mjs)$/.test(p)))
    nuxt = paths.includes('nuxt.config.ts') && (dir('composables') || dir('stores') || !dir('store')) ? 3 : 2
  if (nuxt) out.push(`Nuxt ${nuxt}`)
  else if (has('vue')) out.push(`Vue ${major('vue') ?? ''}`.trim())
  else if (has('react')) out.push('React')
  if (has('@nestjs/core')) out.push('NestJS')
  if (has('express')) out.push('Express')
  if (has('pinia') || has('@pinia/nuxt')) out.push('Pinia')
  if (has('vuex') || (nuxt === 2 && dir('store'))) out.push('Vuex')
  if (['@nuxtjs/apollo', '@vue/apollo-composable', 'vue-apollo', '@apollo/client', 'apollo-client', 'apollo-boost'].some(has)) out.push('Apollo')
  if (['@apollo/server', 'apollo-server', 'apollo-server-express', '@nestjs/graphql'].some(has)) out.push('GraphQL serveur')
  if (has('typeorm')) out.push('TypeORM')
  if (has('prisma') || has('@prisma/client')) out.push('Prisma')
  if (has('vuetify') || has('@nuxtjs/vuetify')) out.push('Vuetify')
  if (has('tailwindcss') || has('@nuxtjs/tailwindcss')) out.push('Tailwind')
  if (has('@nuxtjs/i18n') || has('vue-i18n') || has('nuxt-i18n')) out.push('i18n')
  if (has('typescript')) out.push('TypeScript')
  if (has('vitest')) out.push('vitest')
  if (has('jest')) out.push('Jest')
  if (has('@playwright/test') || has('playwright')) out.push('Playwright')
  if (has('cypress')) out.push('Cypress')
  const m = (n: string) => typeof manifestes[n] === 'string'
  const langs: string[] = []
  if (m('.claude-plugin/plugin.json')) langs.push('Plugin Claude Code')
  if (m('pyproject.toml') || m('requirements.txt')) langs.push('Python')
  if (m('go.mod')) langs.push('Go')
  if (m('Cargo.toml')) langs.push('Rust')
  if (m('tsconfig.json') && !out.includes('TypeScript')) out.push('TypeScript')
  out.unshift(...langs)
  if (pubspec !== undefined) out.unshift(...dartStack(pubspec))
  return out.length ? out.join(', ') : 'inconnue'
}
// ── L'indexeur : définitions (1re passe) ─────────────────────────────────

/** « BookingOfferCard » → ['booking', 'offer', 'card'] ; « booking-offer » → ['booking', 'offer']. */
const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase())
const pascal = (s: string) => words(s).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')

const EXPORT_DECL = /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
const EXPORT_LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g
const STORE_DEF = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*defineStore\s*\(\s*['"`]([\w-]+)['"`]/g
const STORE_ID = /\bdefineStore\s*\(\s*['"`]([\w-]+)['"`]/g
const GQL_CONST = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:gql|graphql)\s*(?:\(\s*)?`\s*(?:#[^\n]*\n\s*)*(query|mutation|subscription)\s+([A-Za-z_]\w*)/g
const GQL_OP = /\b(query|mutation|subscription)\s+([A-Za-z_]\w*)\s*[({@]/g

type Defs = { exp: string[]; ops: { op: string; c?: string }[] }

/** Déclarations publiques de premier niveau d'un fichier Dart (colonne 0, comme `dart format` les pose) : types, variables, fonctions. */
const DART_TYPE_DECL = /^(?:(?:abstract|sealed|final|base|interface|mixin)\s+)*(?:class|enum|mixin|extension\s+type|extension|typedef)\s+([A-Za-z]\w*)/gm
const DART_VAR_DECL = /^(?:final|const|late\s+final|var)\s+(?:[\w<>?,. ]+?\s+)?([A-Za-z]\w*)\s*=/gm
const DART_FUN_DECL = /^(?!(?:import|export|part|library|return|if|for|while|switch)\b)(?:[\w<>?][\w<>?,. ]*?\s+)?([A-Za-z]\w*)\s*(?:<[^<>()]*>)?\(/gm

/** Noms exportés et opérations GraphQL déclarées par un fichier. */
function scanDefs(p: string, text: string): Defs {
  const exp = new Set<string>()
  const ops: Defs['ops'] = []
  if (/\.dart$/i.test(p)) {
    for (const re of [DART_TYPE_DECL, DART_VAR_DECL, DART_FUN_DECL]) for (const m of text.matchAll(re)) if (m[1] !== 'on') exp.add(m[1]!)
    return { exp: [...exp], ops }
  }
  if (/\.(vue|[cm]?[jt]sx?)$/i.test(p)) {
    for (const m of text.matchAll(EXPORT_DECL)) exp.add(m[1]!)
    for (const m of text.matchAll(EXPORT_LIST))
      for (const part of m[1]!.split(',')) {
        const name = part.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop()?.trim()
        if (name && /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') exp.add(name)
      }
    let named = false
    for (const m of text.matchAll(STORE_DEF)) {
      named = true
      exp.add(m[1]!)
    }
    if (!named) for (const m of text.matchAll(STORE_ID)) exp.add(`use${pascal(m[1]!)}Store`)
  }
  const isGqlFile = /\.(graphql|gql)$/i.test(p)
  if (isGqlFile || /\b(gql|graphql)\s*(\(\s*)?`/.test(text)) {
    const seen = new Set<string>()
    if (!isGqlFile)
      for (const m of text.matchAll(GQL_CONST)) {
        ops.push({ op: m[3]!, c: m[1]! })
        seen.add(m[3]!)
      }
    for (const m of text.matchAll(GQL_OP))
      if (!seen.has(m[2]!)) {
        seen.add(m[2]!)
        ops.push({ op: m[2]! })
      }
  }
  return { exp: [...exp], ops }
}

// ── L'indexeur : résumé mécanique (sum) ──────────────────────────────────

/** Longueur maximale d'un résumé de fichier (caractères). */
export const SUM_MAX = 120

/** Directives d'outils, licences et marqueurs de fichier généré : ils ne résument pas un fichier. */
const NOT_SUM =
  /^(eslint|prettier|tslint|jshint|istanbul|c8\b|biome-ignore|deno-|@ts-|@jsx|@vitest|@vite|@flow|@license|@preserve|@format|globals?\b|ignore_for_file|ignore:|coverage:|copyright|©|\(c\)|spdx|#?(end)?region\b|todo\b|fixme\b|<reference\b|(auto-?)?generated\b|do not (edit|modify)|ne pas modifier)/i

/** Coupe à SUM_MAX caractères sur une fin de mot, avec « … ». */
function clipSum(s: string): string {
  if (s.length <= SUM_MAX) return s
  const cut = s.slice(0, SUM_MAX - 1)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > SUM_MAX / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.(«—–-]+$/u, '')}…`
}

/** Le texte d'un commentaire sans ses marques (/**, *, //, ///) ; les tags JSDoc (@param…) et ce qui les suit sont retirés. */
function commentText(raw: string): string {
  const out: string[] = []
  const lines = raw
    .replace(/^\s*\/\*+!?/, '')
    .replace(/\*+\/\s*$/, '')
    .split(/\r?\n/)
  for (const l of lines) {
    const t = l.replace(/^\s*(?:\/\/+!?|\*+)\s?/, '').trimEnd()
    if (/^\s*@\w/.test(t)) break
    // Une directive (eslint-disable…) en tête de bloc n'empêche pas la description qui la suit.
    if (!out.some(x => x.trim()) && NOT_SUM.test(t.trim())) continue
    out.push(t)
  }
  return out.join('\n')
}

/** La première phrase du premier paragraphe d'un commentaire, nettoyée et coupée à SUM_MAX ; rien si ce n'est pas une phrase utile (directive, code). */
function sentenceOf(text: string): string | undefined {
  let s = (text.trim().split(/\n\s*\n/)[0] ?? '')
    .replace(/\{@link(?:code|plain)?\s+([^}|\s]+)(?:[|\s]+([^}]*))?\}/g, (_, a: string, b?: string) => b?.trim() || a)
    .replace(/[─━═]+/g, ' ')
    .replace(/^[\s#=*-]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s || NOT_SUM.test(s)) return undefined
  for (const m of s.matchAll(/[.!?…](?=\s|$)/g)) {
    const word = /(\S+)$/.exec(s.slice(0, m.index))?.[1] ?? ''
    // « p. ex. », « cf. », « e.g. » : pas une fin de phrase
    if (m[0] === '.' && (/^\p{L}$/u.test(word) || /^(ex|cf|vs|e\.g|i\.e|p\.ex)$/i.test(word))) continue
    s = s.slice(0, (m.index ?? 0) + 1)
    break
  }
  s = s.replace(/\s*[:;,]$/, '').trim()
  if (s.length < 8 || !/\p{L}{3}/u.test(s) || /^[\w$.]+\s*[(=]|[;{]$/.test(s)) return undefined
  return clipSum(s)
}

/** Les commentaires en tête de fichier (après BOM, shebang, « use strict » et lignes vides), dans l'ordre : blocs /* *\/ ou suites de lignes //. */
function headComments(text: string): string[] {
  const s = text.replace(/^﻿/, '').replace(/^#![^\n]*\n/, '')
  const out: string[] = []
  let i = 0
  while (out.length < 10) {
    i += /^\s*(?:(['"])use [\w ]+\1;?\s*)*/.exec(s.slice(i))![0].length
    if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i + 2)
      if (end < 0) break
      out.push(s.slice(i, end + 2))
      i = end + 2
    } else if (s.startsWith('//', i)) {
      const m = /^(?:[ \t]*\/\/[^\n]*(?:\n|$))+/.exec(s.slice(i))![0]
      out.push(m)
      i += m.length
    } else break
  }
  return out
}

/** Le commentaire collé au-dessus d'une déclaration qui commence en début de ligne à `at` (annotations @x sautées), ou rien. */
function commentBefore(text: string, at: number): string | undefined {
  const lines = text.slice(0, at).split('\n')
  lines.pop()
  let j = lines.length - 1
  while (j >= 0 && /^\s*@\w/.test(lines[j]!)) j--
  if (j < 0) return undefined
  const last = lines[j]!.trimEnd()
  if (last.endsWith('*/')) {
    let k = j
    while (k >= 0 && !lines[k]!.includes('/*')) k--
    return k < 0 ? undefined : lines.slice(k, j + 1).join('\n')
  }
  if (!/^\s*\/\//.test(last)) return undefined
  let k = j
  while (k > 0 && /^\s*\/\//.test(lines[k - 1]!)) k--
  return lines.slice(k, j + 1).join('\n')
}

const TS_EXPORT_AT = /^[ \t]*export\s+(?!\{|\*|type\s*\{)/gm
/** Au-delà de ce nombre de déclarations publiques, pas de résumé tiré de la première d'entre elles. */
const DECL_SUM_MAX = 5

/** Les positions des déclarations publiques d'un fichier, dans l'ordre (exports TS/JS ; déclarations Dart de premier niveau hors _privées). */
function declPositions(p: string, text: string): number[] {
  if (/\.dart$/i.test(p)) {
    const at: number[] = []
    for (const re of [DART_TYPE_DECL, DART_VAR_DECL, DART_FUN_DECL]) for (const m of text.matchAll(re)) if (!m[1]!.startsWith('_') && m[1] !== 'on') at.push(m.index ?? 0)
    return at.sort((a, b) => a - b)
  }
  return [...text.matchAll(TS_EXPORT_AT)].map(m => m.index ?? 0)
}

/**
 * Le résumé mécanique d'un fichier (0 token), pour `sum` : la première phrase de son commentaire de tête (JSDoc, //, /// en Dart ; directives et licences
 * sautées), sinon celle du commentaire de la première déclaration publique qui en a un ; pour un .md, son premier titre. Rien pour un test.
 * ≤ SUM_MAX caractères, coupé sur une fin de mot. Python n'est pas indexé (SOURCE_EXT) : pas de docstring.
 */
export function headSummary(p: string, text: string, k: NodeKind): string | undefined {
  try {
    if (k === 'test') return undefined
    if (/\.md$/i.test(p)) {
      const body = text.replace(/^﻿/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
      const m = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(body) ?? /^(\S.*)\r?\n(?:=+|-+)[ \t]*$/m.exec(body)
      const t = m?.[1]
        ?.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\*\*|__/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      return t ? clipSum(t) : undefined
    }
    if (!/\.(vue|[cm]?[jt]sx?|dart)$/i.test(p)) return undefined
    let src = text
    if (/\.vue$/i.test(p)) {
      const html = /^\s*<!--([\s\S]*?)-->/.exec(text)
      const s = html ? sentenceOf(html[1]!) : undefined
      if (s) return s
      src = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(text)?.[1] ?? ''
    }
    for (const c of headComments(src)) {
      const s = sentenceOf(commentText(c))
      if (s) return s
    }
    // Le commentaire d'une déclaration ne résume le fichier que s'il en déclare peu (un module de 60 utilitaires n'est pas sa première fonction).
    const decls = declPositions(p, src)
    if (decls.length > DECL_SUM_MAX) return undefined
    for (const at of decls) {
      const c = commentBefore(src, at)
      const s = c ? sentenceOf(commentText(c)) : undefined
      if (s) return s
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Nombre de mots-clés gardés par fichier. */
export const MOTS_MAX = 30
/** Mots trop courants dans les commentaires et le code pour distinguer un fichier. */
const MOTS_STOP = new Set(
  (
    'tout toute tous toutes rien comme avant apre deja encore aussi alor donc mai car pui chaque meme autre entre ici sinon seulement jamais toujours ' +
    'tant lui eux celui celle ceux cela ca peut quel quelle fois sert renvoie rend retourne vrai faux const let var function return true false null ' +
    'undefined string number boolean void async await new this type export import default get set'
  ).split(' '),
)
const COMMENT_RE = /\/\*[\s\S]*?\*\/|(?<![:'"`\\\w])\/\/[^\n]*|<!--[\s\S]*?-->/g
const DECL_NAME_RE =
  /\b(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^()]*\)\s*(?::[^=\n]+)?=>|function\b|[A-Za-z_$][\w$]*\s*=>)/g

/**
 * Les mots-clés d'un fichier de code (0 token, jamais injectés) : les MOTS_MAX termes les plus fréquents de ses commentaires et des noms
 * de ses déclarations (exportées ou non). Ils servent à la carte à froid (coldRank), pas à la recherche des fiches. Rien pour un test ou un doc.
 */
export function keywordsOf(p: string, text: string, k: NodeKind): string[] | undefined {
  try {
    if (k === 'test' || k === 'doc' || !/\.(vue|[cm]?[jt]sx?|dart)$/i.test(p)) return undefined
    const count = new Map<string, number>()
    const add = (s: string) => {
      for (const t of terms(s)) if (t.length > 2 && !/^\d+$/.test(t) && !MOTS_STOP.has(t)) count.set(t, (count.get(t) ?? 0) + 1)
    }
    for (const m of text.matchAll(COMMENT_RE)) add(m[0].replace(/^\/\*+|\*+\/$|^\/\/+|^<!--|-->$/g, ' '))
    if (/\.dart$/i.test(p)) {
      for (const re of [DART_TYPE_DECL, DART_VAR_DECL, DART_FUN_DECL]) for (const m of text.matchAll(re)) add(m[1]!)
    } else for (const m of text.matchAll(DECL_NAME_RE)) add(m[1] ?? m[2] ?? '')
    const out = [...count]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MOTS_MAX)
      .map(([t]) => t)
    return out.length ? out : undefined
  } catch {
    return undefined
  }
}

/** Le `sum` et les `mots` d'un fichier réindexé : le sum d'un modèle (sumLlm) tant que le hash n'a pas changé, sinon le résumé mécanique. */
function withSum(n: FileNode, old: FileNode | undefined, f: SourceFile): void {
  if (old?.sum && old.sumLlm && sameHash(old.h, f.h)) {
    n.sum = old.sum
    n.sumLlm = true
  } else {
    const s = headSummary(f.p, f.text, n.k)
    if (s) n.sum = s
  }
  const mots = keywordsOf(f.p, f.text, n.k)
  if (mots) n.mots = mots
}

// ── L'indexeur : le contexte de résolution ───────────────────────────────

type Ctx = {
  files: Record<string, FileNode>
  src: string
  exclus: string[]
  /** Composants par nom en minuscules sans tiret (préfixe de dossier Nuxt, puis nom de fichier s'il est unique). */
  comp: Map<string, string>
  /** Auto-imports Nuxt 3 : nom exporté par composables/, utils/, stores/ → fichier (noms ambigus écartés). */
  auto: Map<string, string> | null
  /** Modules Vuex : 'booking' → store/booking.ts. */
  vuex: Map<string, string>
  /** Constantes gql : fichier → constante → clés q:… */
  gql: Map<string, Map<string, string[]>>
  /** Middlewares : nom → fichier. */
  mw: Map<string, string>
  pagesDir: string
  /** Nom du paquet Dart du projet (pubspec.yaml), pour résoudre `package:<nom>/…` vers lib/. */
  dart?: string
}

/** srcDir Nuxt : '' ou 'src/' ou 'app/', d'après l'emplacement de pages/, components/, store/… */
function srcDirOf(paths: string[]): string {
  for (const d of ['src/', 'app/']) if (paths.some(p => p.startsWith(d) && /^(src|app)\/(pages|components|composables|store|stores)\//.test(p))) return d
  return ''
}

/** Les noms sous lesquels Nuxt enregistre un composant (préfixe de dossier sans répétition, puis nom de fichier seul). */
function componentNames(rel: string): string[] {
  const segs = rel.replace(/\.vue$/i, '').split('/').filter(Boolean)
  if (segs.length > 1 && segs[segs.length - 1]!.toLowerCase() === 'index') segs.pop()
  const fileWords = words(segs.pop() ?? '')
  let cut = segs.length
  for (let i = segs.length - 1; i >= 0; i--) {
    const suffix = segs.slice(i).flatMap(words)
    if (suffix.length <= fileWords.length && suffix.every((w, j) => fileWords[j] === w)) cut = i
  }
  const full = [...segs.slice(0, cut).flatMap(words), ...fileWords].join('')
  return [...new Set([full, fileWords.join('')])]
}

function makeCtx(files: Record<string, FileNode>, noeuds: Record<string, GraphNode>, stack: string, exclus: string[], dart?: string): Ctx {
  const paths = Object.keys(files)
  const src = srcDirOf(paths)
  const compDir = `${src}components/`
  const comp = new Map<string, string>()
  const base = new Map<string, string | null>()
  for (const p of paths) {
    if (!p.startsWith(compDir) || !p.endsWith('.vue')) continue
    const [full, short] = componentNames(p.slice(compDir.length))
    if (full && !comp.has(full)) comp.set(full, p)
    if (short && short !== full) base.set(short, base.has(short) ? null : p)
  }
  for (const [k, v] of base) if (v && !comp.has(k)) comp.set(k, v)

  let auto: Map<string, string> | null = null
  if (/Nuxt [3-9]/.test(stack)) {
    const amb = new Map<string, string | null>()
    const re = new RegExp(`^${src}(composables|utils|stores)/.*\\.(ts|js|mjs)$`)
    for (const p of paths) {
      if (!re.test(p) || p.endsWith('.d.ts')) continue
      for (const n of files[p]!.exp ?? []) if (n.length > 2) amb.set(n, amb.has(n) && amb.get(n) !== p ? null : p)
    }
    auto = new Map([...amb].filter((e): e is [string, string] => e[1] !== null))
  }

  const vuex = new Map<string, string>()
  const storeRe = new RegExp(`^${src}store/(.+)\\.(ts|js)$`)
  for (const p of paths) {
    const m = storeRe.exec(p)
    if (!m) continue
    const name = m[1]!.replace(/\/index$/, '')
    if (name !== 'index' && !vuex.has(name)) vuex.set(name, p)
  }

  const gql = new Map<string, Map<string, string[]>>()
  for (const [key, n] of Object.entries(noeuds)) {
    if (n.k !== 'gql' || !n.def || !n.c) continue
    const byConst = gql.get(n.def) ?? new Map<string, string[]>()
    for (const c of n.c) byConst.set(c, [...(byConst.get(c) ?? []), key])
    gql.set(n.def, byConst)
  }

  const mw = new Map<string, string>()
  const mwRe = new RegExp(`^${src}middleware/(.+?)(\\.global)?\\.(ts|js|mjs)$`)
  for (const p of paths) {
    const m = mwRe.exec(p)
    if (m) mw.set(m[1]!, p)
  }
  return { files, src, exclus, comp, auto, vuex, gql, mw, pagesDir: `${src}pages/`, ...(dart ? { dart } : {}) }
}
// ── L'indexeur : arêtes d'un fichier ─────────────────────────────────────

const IMPORT_RE =
  /\bimport\s+(?:type\s+)?([\w$*{}\s,]+?)\s+from\s*['"]([^'"\n]+)['"]|\bimport\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)|\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"\n]+)['"]|\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g
const CALL_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\(/g
const TAG_RE = /<([A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=[\s/>])/g
const VUEX_RES = [
  /\b(?:dispatch|commit)\s*\(\s*['"`]([\w-]+(?:\/[\w-]+)*)\/[\w-]+['"`]/g,
  /[gG]etters\s*\[\s*['"`]([\w-]+(?:\/[\w-]+)*)\/[\w-]+['"`]\s*\]/g,
  /\bmap(?:State|Getters|Actions|Mutations)\s*\(\s*['"`]([\w-]+(?:\/[\w-]+)*)['"`]/g,
  /(?:\$store\.state|\brootState)\.([\w$]+)/g,
]
const VUEX_MAP_OBJ = /\bmap(?:State|Getters|Actions|Mutations)\s*\(\s*[[{]([^)]*)\)/g
const API_RE =
  /(?:\$fetch|\bfetch|\buseFetch|\buseLazyFetch|\$?axios|\$http|\bhttp|\bapi|\bapiClient)(?:\.\$?(get|post|put|patch|delete|head))?\s*(?:<[^<>()]*>)?\(\s*(['"`])([^'"`\n]*?)\2/g
const MIDDLEWARE_RE = /\bmiddleware\s*:\s*(\[[^\]]*\]|['"][\w-]+['"])/g
const DOC_REF = /`([^`\s]+)`|\]\(([^)\s]+)\)/g
const DART_IMPORT_RE = /^\s*(?:import|export|part(?:\s+of)?)\s+['"]([^'"\n]+)['"]/gm

function joinPath(dir: string, rel: string): string {
  const out = dir ? dir.split('/') : []
  for (const s of rel.split('/')) {
    if (s === '..') out.pop()
    else if (s && s !== '.') out.push(s)
  }
  return out.join('/')
}
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/')

const EXTS = ['', '.ts', '.js', '.vue', '.mjs', '.tsx', '.jsx', '.d.ts', '/index.ts', '/index.js', '/index.vue', '/index.mjs']

/** Résout un spécifieur d'import : clé de fichier indexé, nœud externe « x:… » (chemin exclu), ou rien (paquet npm, introuvable). */
function resolveSpec(from: string, spec: string, ctx: Ctx): string | undefined {
  let base: string
  if (/^(~~|@@)\//.test(spec)) base = spec.slice(3)
  else if (/^[~@]\//.test(spec)) base = ctx.src + spec.slice(2)
  else if (spec.startsWith('.')) base = joinPath(dirOf(from), spec)
  else return undefined
  base = base.replace(/[?#].*$/, '')
  for (const e of EXTS) if (ctx.files[base + e]) return base + e
  if (base.endsWith('.js') && ctx.files[`${base.slice(0, -3)}.ts`]) return `${base.slice(0, -3)}.ts`
  if (isExcluded(`${base}/`, ctx.exclus) || isExcluded(base, ctx.exclus)) return `x:${base.split('/').slice(0, 2).join('/')}`
  return undefined
}

/** Résout un import Dart : `package:<paquet du projet>/x.dart` → lib/x.dart, relatif → à côté ; dart:, autres paquets → rien. */
function resolveDart(from: string, spec: string, ctx: Ctx): string | undefined {
  const pkg = /^package:(\w+)\/(.+)$/.exec(spec)
  let base: string
  if (pkg) {
    if (pkg[1] !== ctx.dart) return undefined
    base = `lib/${pkg[2]}`
  } else if (/^[a-z][\w+.-]*:/i.test(spec)) return undefined
  else base = joinPath(dirOf(from), spec)
  return ctx.files[base] ? base : undefined
}

/** Les noms importés par une clause : [nom d'origine, nom local] (« default » pour l'import par défaut). */
function importedNames(clause: string): [string, string][] {
  const out: [string, string][] = []
  const braces = /\{([^}]*)\}/.exec(clause)
  if (braces)
    for (const part of braces[1]!.split(',')) {
      const [orig, local] = part
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)
        .map(s => s.trim())
      if (orig) out.push([orig, local || orig])
    }
  const def = /^\s*([A-Za-z_$][\w$]*)/.exec(clause.replace(/\{[^}]*\}/, ''))
  if (def && def[1] !== 'type') out.push(['default', def[1]!])
  return out
}

/** Le chemin d'API d'une URL littérale : « /complementary-products », sans origine ni requête ; rien si ce n'est pas un chemin. */
function apiPath(raw: string): string | undefined {
  let u = raw
    .trim()
    .replace(/^(\$\{[^}]*\})+/, '')
    .replace(/^https?:\/\/[^/]+/, '')
  u = u
    .replace(/[?#].*$/, '')
    .replace(/\$\{[^}]*\}/g, ':p')
    .replace(/\/{2,}/g, '/')
  if (!u.startsWith('/') || u.length < 2 || /\.(png|jpe?g|svg|webp|css|json|js)$/i.test(u)) return undefined
  return u.replace(/\/$/, '')
}

/** La route Nuxt d'une page : pages/orders/[id].vue → /orders/:id ; pages/_name.vue → /:name ; index → /. */
export function routeOf(p: string, pagesDir = 'pages/'): string | undefined {
  if (!p.startsWith(pagesDir) || !p.endsWith('.vue')) return undefined
  const segs = p
    .slice(pagesDir.length, -4)
    .split('/')
    .map(s =>
      s
        .replace(/^\[\.\.\.([\w-]+)\]$/, ':$1*')
        .replace(/\[\[([\w-]+)\]\]/g, ':$1?')
        .replace(/\[([\w-]+)\]/g, ':$1')
        .replace(/^_([\w-]+)$/, ':$1')
        .replace(/^_$/, '*'),
    )
  if (segs[segs.length - 1] === 'index') segs.pop()
  return `/${segs.join('/')}`
}

type Parsed = { out: Edges; nodes: Record<string, GraphNode>; guards: string[] }

const EDGE_ORDER: EdgeKind[] = ['importe', 'rend', 'utilise', 'appelle', 'sert', 'garde', 'teste', 'documente']

function addEdge(e: Map<EdgeKind, Set<string>>, k: EdgeKind, to: string): void {
  const s = e.get(k) ?? new Set<string>()
  s.add(to)
  e.set(k, s)
}

function toEdges(e: Map<EdgeKind, Set<string>>): Edges {
  const out: Edges = {}
  for (const k of EDGE_ORDER) {
    const s = e.get(k)
    if (s && s.size) out[k] = [...s]
  }
  return out
}

/** Les arêtes sortantes d'un fichier (sauf « garde », que les pages posent sur les middlewares) et les nœuds api/externe rencontrés. */
function parseFile(p: string, text: string, ctx: Ctx): Parsed {
  const self = ctx.files[p]!
  const e = new Map<EdgeKind, Set<string>>()
  const nodes: Record<string, GraphNode> = {}
  const guards: string[] = []
  const linked = new Set<string>([p])

  if (self.k === 'doc') {
    for (const m of text.matchAll(DOC_REF)) {
      const raw = (m[1] ?? m[2] ?? '').replace(/:\d+(:\d+)?$/, '').replace(/^(\.\/|~~?\/|@@?\/|\/)/, '')
      if (raw.length < 3) continue
      const near = joinPath(dirOf(p), raw)
      const t = ctx.files[raw] ? raw : ctx.files[near] ? near : undefined
      if (t && t !== p) addEdge(e, 'documente', t)
    }
    return { out: toEdges(e), nodes, guards }
  }
  if (p.endsWith('.dart')) {
    for (const m of text.matchAll(DART_IMPORT_RE)) {
      const t = resolveDart(p, m[1]!, ctx)
      if (t && t !== p) addEdge(e, 'importe', t)
    }
    return { out: toEdges(self.k === 'test' ? asTest(e, ctx) : e), nodes, guards }
  }
  if (!/\.(vue|[cm]?[jt]sx?)$/i.test(p)) return { out: toEdges(e), nodes, guards }

  // Un test écrit souvent du code source dans des chaînes (fixtures) : ni opérations gql, ni endpoints, ni externes tirés de son texte.
  const isTest = self.k === 'test'

  // Imports explicites ; une constante gql importée donne « appelle » vers l'opération
  const locals = new Set<string>()
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? ''
    const names = m[1] ? importedNames(m[1]) : []
    for (const [, local] of names) locals.add(local)
    const t = resolveSpec(p, spec, ctx)
    if (!t || t === p) continue
    if (t.startsWith('x:')) {
      if (isTest) continue
      nodes[t] = { k: 'externe' }
      addEdge(e, 'importe', t)
      continue
    }
    linked.add(t)
    addEdge(e, t.endsWith('.vue') ? 'rend' : ctx.files[t]?.k === 'mixin' ? 'utilise' : 'importe', t)
    const consts = ctx.gql.get(t)
    if (consts) for (const [orig] of names) for (const q of consts.get(orig) ?? []) addEdge(e, 'appelle', q)
  }

  // Opérations gql écrites dans le fichier lui-même (hors graphql/) : il les appelle
  if (self.k !== 'gql' && !isTest) for (const d of scanDefs(p, text).ops) addEdge(e, 'appelle', `q:${d.op}`)

  // Auto-imports Nuxt 3 : composables/, utils/, stores/ appelés sans import
  if (ctx.auto) {
    const called = new Set<string>()
    for (const m of text.matchAll(CALL_RE)) called.add(m[1]!)
    for (const n of called) {
      const t = locals.has(n) ? undefined : ctx.auto.get(n)
      if (t && !linked.has(t)) {
        linked.add(t)
        addEdge(e, 'utilise', t)
      }
    }
  }

  // Vuex par chaîne (Nuxt 2) : dispatch/commit('mod/…'), getters['mod/…'], mapX('mod'), mapX({ a: 'mod/…' }), $store.state.mod
  if (ctx.vuex.size) {
    const mods = new Set<string>()
    for (const re of VUEX_RES) for (const m of text.matchAll(re)) mods.add(m[1]!)
    for (const m of text.matchAll(VUEX_MAP_OBJ)) for (const s of m[1]!.matchAll(/['"`]([\w-]+(?:\/[\w-]+)*)\/[\w-]+['"`]/g)) mods.add(s[1]!)
    for (const mod of mods) {
      const segs = mod.split('/')
      for (let i = segs.length; i > 0; i--) {
        const t = ctx.vuex.get(segs.slice(0, i).join('/'))
        if (t) {
          if (t !== p) addEdge(e, 'utilise', t)
          break
        }
      }
    }
  }

  // Balises de composants <PascalCase> et <kebab-case> (sans import)
  if (p.endsWith('.vue')) {
    const tpl = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    for (const m of tpl.matchAll(TAG_RE)) {
      const t = ctx.comp.get(words(m[1]!.replace(/^Lazy(?=[A-Z])|^lazy-/, '')).join(''))
      if (t && !linked.has(t)) {
        linked.add(t)
        addEdge(e, 'rend', t)
      }
    }
  }

  // URL littérales fetch / axios / $fetch → a:METHODE /chemin
  for (const m of isTest ? [] : text.matchAll(API_RE)) {
    const path = apiPath(m[3]!)
    if (!path) continue
    const end = (m.index ?? 0) + m[0].length
    const method = m[1]?.toUpperCase() ?? /\bmethod\s*:\s*['"`](\w+)['"`]/.exec(text.slice(end, end + 400))?.[1]?.toUpperCase() ?? 'GET'
    const key = `a:${method} ${path}`
    nodes[key] = { k: 'api' }
    addEdge(e, 'appelle', key)
  }

  // Middlewares nommés par la page (definePageMeta({ middleware }) ou Options API)
  if (self.k === 'page') for (const m of text.matchAll(MIDDLEWARE_RE)) for (const s of m[1]!.matchAll(/['"]([\w-]+)['"]/g)) guards.push(s[1]!)

  return { out: toEdges(self.k === 'test' ? asTest(e, ctx) : e), nodes, guards }
}

/** Un test « teste » ce qu'il importe, utilise ou rend. */
function asTest(e: Map<EdgeKind, Set<string>>, ctx: Ctx): Map<EdgeKind, Set<string>> {
  const t = new Map<EdgeKind, Set<string>>()
  for (const [k, set] of e)
    for (const to of set) addEdge(t, (k === 'importe' || k === 'utilise' || k === 'rend') && !to.includes(':') && ctx.files[to]?.k !== 'test' ? 'teste' : k, to)
  return t
}
// ── Assemblage du graphe ─────────────────────────────────────────────────

const isEmpty = (o: object) => Object.keys(o).length === 0

/** Pose les arêtes d'un fichier, sans garder un « out » vide. */
function setOut(n: FileNode, out: Edges): void {
  if (isEmpty(out)) delete n.out
  else n.out = out
}

/** Ajoute une arête sur un nœud existant (fichier ou nœud). */
function pushEdge(n: { out?: Edges }, k: EdgeKind, to: string): void {
  const out = (n.out ??= {})
  const list = out[k] ?? []
  if (!list.includes(to)) out[k] = [...list, to]
}

/** Routes de pages/ (sert), gardes des middlewares nommés par les pages, et des *.global sur toutes les routes. */
function linkRoutes(g: Graph, ctx: Ctx, guardsByPage: Map<string, string[]>): void {
  for (const [p, n] of Object.entries(g.fichiers)) {
    if (n.k !== 'page') continue
    const r = routeOf(p, ctx.pagesDir)
    if (r) g.noeuds[`r:${r}`] = { k: 'route', out: { sert: [p] } }
  }
  const routeOfPage = new Map<string, string>()
  for (const [key, n] of Object.entries(g.noeuds)) if (n.k === 'route' && n.out?.sert?.[0]) routeOfPage.set(n.out.sert[0], key)
  for (const [page, names] of guardsByPage) {
    const r = routeOfPage.get(page)
    if (!r) continue
    for (const name of names) {
      const mw = g.fichiers[ctx.mw.get(name) ?? '']
      if (mw) pushEdge(mw, 'garde', r)
    }
  }
  for (const p of ctx.mw.values()) {
    const mw = g.fichiers[p]
    if (mw && /\.global\.[cm]?[jt]s$/.test(p)) for (const r of routeOfPage.values()) pushEdge(mw, 'garde', r)
  }
}

/** Retire les nœuds orphelins (route sans page, api/externe sans usage, gql sans définition ni usage) et les arêtes vers des clés inconnues. */
function gc(g: Graph): void {
  for (const [key, n] of Object.entries(g.noeuds)) {
    if (n.k === 'route' && !g.fichiers[n.out?.sert?.[0] ?? '']) delete g.noeuds[key]
    if (n.k === 'gql' && n.def && !g.fichiers[n.def]) {
      delete n.def
      delete n.c
    }
  }
  const all = () => [...Object.values(g.fichiers), ...Object.values(g.noeuds)]
  const used = new Set<string>()
  for (const n of all()) for (const list of Object.values(n.out ?? {})) for (const t of list ?? []) used.add(t)
  for (const [key, n] of Object.entries(g.noeuds)) if (n.k !== 'route' && !n.def && !used.has(key)) delete g.noeuds[key]
  const exists = (t: string) => Boolean(g.fichiers[t] ?? g.noeuds[t])
  for (const n of all()) {
    if (!n.out) continue
    const out: Edges = {}
    for (const k of EDGE_ORDER) {
      const list = n.out[k]?.filter(exists)
      if (list && list.length) out[k] = list
    }
    if (isEmpty(out)) delete n.out
    else n.out = out
  }
}

/** Les fichiers de la fiche dont le hash courant diffère du hash appris (nouveau = '' : supprimé), d'après `f.fichiers` et les hash du graphe. */
export function perimeOf(graph: Graph, f: Feature): PerimeEntry[] {
  const out: PerimeEntry[] = []
  for (const ff of f?.fichiers ?? []) {
    const cur = graph.fichiers[ff.p]
    if (!cur) out.push({ p: ff.p, depuis: ff.h, nouveau: '' })
    else if (!sameHash(cur.h, ff.h)) out.push({ p: ff.p, depuis: ff.h, nouveau: cur.h })
  }
  return out
}

/** Recalcule `perime` de chaque fiche d'après les hash actuels (les hash font foi, pas le commit). */
function refreshPerime(g: Graph): void {
  for (const f of Object.values(g.features)) f.perime = perimeOf(g, f)
}

function setIndexed(g: Graph, ctx: { commit: string; branche: string; le: string }): void {
  const all = Object.values(g.fichiers)
  g.projet.indexe = { commit: ctx.commit, branche: ctx.branche, le: ctx.le, fichiers: all.length, tok: all.reduce((s, n) => s + n.tok, 0) }
}

/** Déclare les opérations gql d'un fichier (nœud q:Nom avec def et constantes). */
function addOps(g: Graph, p: string, ops: Defs['ops']): void {
  for (const o of ops) {
    const key = `q:${o.op}`
    const n = (g.noeuds[key] ??= { k: 'gql', def: p })
    n.def ??= p
    if (o.c && n.def === p) n.c = [...new Set([...(n.c ?? []), o.c])]
  }
}

/** Construit la couche mécanique. `prev` : garde fiches, stats, rev et candidates (si pas de log) ; tout le mécanique est recalculé. */
export function buildGraph(input: {
  cle: string
  racine: string
  nom: string
  files: SourceFile[]
  pkgJson?: string
  pubspec?: string
  /** Manifestes de la racine (MANIFESTES) présents : chemin → texte. */
  manifestes?: Record<string, string>
  commit: string
  branche: string
  le: string
  log?: string
  exclus?: string[]
  prev?: Graph | null
}): Graph {
  const prev = input.prev ?? undefined
  const exclus = input.exclus ?? prev?.projet.exclus ?? EXCLUS_DEFAUT
  const stack = detectStack(input.pkgJson, input.files.map(f => f.p), input.pubspec, input.manifestes)
  const dart = dartPackageOf(input.pubspec)
  const files = input.files.map(f => ({ ...f, p: norm(f.p) })).filter(f => isIndexable(f.p, exclus))
  const g: Graph = {
    v: 1,
    rev: prev?.rev ?? 0,
    projet: {
      cle: input.cle,
      racine: input.racine,
      nom: input.nom,
      stack,
      format: MECA_FORMAT,
      ...(dart ? { dart } : {}),
      ...(prev?.projet.conventions ? { conventions: prev.projet.conventions } : {}),
      indexe: { commit: input.commit, branche: input.branche, le: input.le, fichiers: 0, tok: 0 },
      exclus,
    },
    fichiers: {},
    noeuds: {},
    features: structuredClone(prev?.features ?? {}),
    candidates: prev?.candidates ?? [],
    stats: { ...(prev?.stats ?? { flows: 0, servis: 0, evites: 0, net: 0 }) },
  }
  for (const f of files) {
    const d = scanDefs(f.p, f.text)
    const n: FileNode = { k: kindOf(f.p, stack), h: f.h, tok: tokensOf(f.text) }
    if (d.exp.length) n.exp = d.exp
    withSum(n, prev?.fichiers[f.p], f)
    g.fichiers[f.p] = n
    if (n.k !== 'test') addOps(g, f.p, d.ops)
  }
  const ctx = makeCtx(g.fichiers, g.noeuds, stack, exclus, dart)
  const guards = new Map<string, string[]>()
  for (const f of files) {
    const r = parseFile(f.p, f.text, ctx)
    setOut(g.fichiers[f.p]!, r.out)
    for (const [k, n] of Object.entries(r.nodes)) g.noeuds[k] ??= n
    if (r.guards.length) guards.set(f.p, r.guards)
  }
  linkRoutes(g, ctx, guards)
  gc(g)
  setIndexed(g, input)
  refreshPerime(g)
  if (input.log) g.candidates = candidatesFromLog(input.log, g)
  return g
}

/**
 * Mise à jour incrémentale : renomme, retire, puis reparse seulement les fichiers modifiés (leurs auto-imports se résolvent sur
 * la table d'exports du graphe). Les arêtes des fichiers non modifiés ne sont réécrites que pour un renommage ou une suppression.
 */
export function updateFiles(
  graph: Graph,
  changed: SourceFile[],
  removed: string[],
  renamed: [string, string][],
  ctx: { commit: string; branche: string; le: string },
): Graph {
  const g = structuredClone(graph)
  const files = changed.map(f => ({ ...f, p: norm(f.p) })).filter(f => isIndexable(f.p, g.projet.exclus))
  const changedSet = new Set(files.map(f => f.p))

  // Renommages : nœud déplacé, arêtes, définitions et fiches réécrites
  const ren = new Map<string, string>()
  for (const [a, b] of renamed) {
    const from = norm(a)
    const to = norm(b)
    if (from === to) continue
    ren.set(from, to)
    const n = g.fichiers[from]
    delete g.fichiers[from]
    if (n && !changedSet.has(to)) g.fichiers[to] = { ...n, k: kindOf(to, g.projet.stack) }
  }
  if (ren.size) {
    const sub = (t: string) => ren.get(t) ?? t
    for (const n of [...Object.values(g.fichiers), ...Object.values(g.noeuds)]) {
      if (n.out) for (const k of EDGE_ORDER) if (n.out[k]) n.out[k] = n.out[k]!.map(sub)
      if ('def' in n && n.def) n.def = sub(n.def)
    }
    for (const f of Object.values(g.features)) {
      f.fichiers = f.fichiers.map(ff => ({ ...ff, p: sub(ff.p) }))
      f.pieges = f.pieges.map(x => (x.p ? { ...x, p: sub(x.p) } : x))
      f.entrees = f.entrees.map(sub)
      f.flux = f.flux.map(s => [...ren].reduce((acc, [a, b]) => acc.split(a).join(b), s))
    }
  }

  // Suppressions
  for (const r of removed) delete g.fichiers[norm(r)]

  // Fichiers modifiés ou ajoutés : définitions d'abord (exports, opérations gql)
  for (const [key, n] of Object.entries(g.noeuds)) if (n.k === 'gql' && n.def && changedSet.has(n.def)) delete g.noeuds[key]
  for (const f of files) {
    const d = scanDefs(f.p, f.text)
    const old = g.fichiers[f.p]
    const n: FileNode = { k: kindOf(f.p, g.projet.stack), h: f.h, tok: tokensOf(f.text), vu: ctx.le }
    if (d.exp.length) n.exp = d.exp
    withSum(n, old, f)
    if (old?.out?.garde) n.out = { garde: old.out.garde }
    g.fichiers[f.p] = n
    if (n.k !== 'test') addOps(g, f.p, d.ops)
  }
  const c = makeCtx(g.fichiers, g.noeuds, g.projet.stack, g.projet.exclus, g.projet.dart)
  const guards = new Map<string, string[]>()
  for (const f of files) {
    const r = parseFile(f.p, f.text, c)
    const n = g.fichiers[f.p]!
    const garde = n.out?.garde
    setOut(n, garde && !/\.global\./.test(f.p) ? { ...r.out, garde } : r.out)
    for (const [k, nn] of Object.entries(r.nodes)) g.noeuds[k] ??= nn
    if (n.k === 'page') guards.set(f.p, r.guards)
  }
  // Les routes sont recalculées ; une page reparsée perd ses anciennes gardes avant de poser les nouvelles
  for (const [key, n] of Object.entries(g.noeuds)) if (n.k === 'route') delete g.noeuds[key]
  const reparsed = new Set([...guards.keys()].map(p => `r:${routeOf(p, c.pagesDir) ?? ''}`))
  for (const n of Object.values(g.fichiers)) if (n.out?.garde) n.out.garde = n.out.garde.filter(r => !reparsed.has(r))
  linkRoutes(g, c, guards)
  gc(g)
  setIndexed(g, ctx)
  refreshPerime(g)
  return g
}

// ── Features candidates (scopes des commits) ─────────────────────────────

const SCOPES_IGNORES = new Set(['deps', 'deps-dev', 'release', 'ci', 'build', 'lint', 'test', 'tests', 'doc', 'docs', 'config', 'chore', 'wip', 'merge', 'readme'])
const SUBJECT_SCOPE = /^[^\w]*\s*\w+\(([^)]+)\)!?:/u

/** Candidates sans LLM : log = sortie de `git log -n 500 --pretty=format:%s --name-only`. Scope → commits, fichiers touchés (hors tests, docs, locales), tokens. */
export function candidatesFromLog(log: string, graph: Graph): Candidate[] {
  const by = new Map<string, { commits: number; files: Set<string> }>()
  let scopes: string[] = []
  const isPath = (l: string) => !/\s/.test(l) && /[/.]/.test(l)
  for (const raw of log.replace(/\r/g, '').split('\n')) {
    const l = raw.trim()
    if (!l) continue
    if (!isPath(l)) {
      const m = SUBJECT_SCOPE.exec(l)
      scopes = m
        ? [...new Set(m[1]!.split(/[,|]/).map(s => slug(s)))].filter(s => s && !SCOPES_IGNORES.has(s))
        : []
      for (const s of scopes) {
        const e = by.get(s) ?? { commits: 0, files: new Set<string>() }
        e.commits++
        by.set(s, e)
      }
      continue
    }
    const p = norm(l)
    const n = graph.fichiers[p]
    if (!n || n.k === 'test' || n.k === 'doc') continue
    for (const s of scopes) by.get(s)?.files.add(p)
  }
  const out: Candidate[] = []
  for (const [id, e] of by) {
    if (e.commits < 2 || e.files.size === 0) continue
    const tok = [...e.files].reduce((s, p) => s + (graph.fichiers[p]?.tok ?? 0), 0)
    out.push({ id, commits: e.commits, fichiers: e.files.size, tok, ...(tok > 40_000 ? { note: 'trop large : découper' } : {}) })
  }
  return out.sort((a, b) => b.commits - a.commits || b.tok - a.tok).slice(0, 25)
}
// ── Fraîcheur ────────────────────────────────────────────────────────────

const round2 = (x: number) => Math.round(x * 100) / 100

/**
 * Fraîcheur d'une fiche d'après les hash actuels : ratio = part des tokens de la fiche modifiés depuis l'apprentissage
 * (un fichier supprimé compte pour la taille moyenne des autres). < 50 % : partielle ; ≥ 50 % : périmée.
 * Un fichier jamais vérifié (h = '') est à relire (dans perimes et nonVerifies) sans compter dans le ratio : la fiche est au mieux partielle.
 * Une fiche sans aucun fichier est périmée, confiance 0, `vide` : à reconstruire.
 */
export function freshness(graph: Graph, f: Feature): Freshness {
  if (!f.fichiers.length) return { niveau: 'perimee', ratio: 1, perimes: [], confiance: 0, vide: true }
  let total = 0
  let changed = 0
  let present = 0
  let gone = 0
  const perimes: string[] = []
  const nonVerifies: string[] = []
  for (const ff of f.fichiers) {
    const cur = graph.fichiers[ff.p]
    if (!cur) {
      perimes.push(ff.p)
      gone++
      continue
    }
    present++
    total += cur.tok
    if (!ff.h) {
      perimes.push(ff.p)
      nonVerifies.push(ff.p)
    } else if (!sameHash(cur.h, ff.h)) {
      perimes.push(ff.p)
      changed += cur.tok
    }
  }
  const avg = present ? total / present : 1000
  const all = total + gone * avg
  const ratio = all > 0 ? (changed + gone * avg) / all : perimes.length > nonVerifies.length ? 1 : 0
  const niveau: Freshness['niveau'] = perimes.length === 0 ? 'fraiche' : ratio < 0.5 ? 'partielle' : 'perimee'
  return { niveau, ratio: round2(ratio), perimes, confiance: round2(f.confiance * (1 - ratio)), ...(nonVerifies.length ? { nonVerifies } : {}) }
}

// ── Recherche (BM25 simplifié) ───────────────────────────────────────────

const STOP = new Set(
  (
    'le la les l de des du d un une et ou en au aux a à pour par dans sur sous avec sans qui que quoi dont est sont etre pas ne plus moins ' +
    'ce cet cette ces il elle on je tu nous vous ils elles mon ma mes ton ta tes son sa ses leur leurs se si y c s n j qu quand lors ' +
    'faut fait faire veux peux doit dois the of to and in on for with is are this that it be as at by from an or not ' +
    'ajout ajoute ajouter corrige corriger correction modifier modifie modification mettre met jour fix feat bug probleme vue ts js index'
  ).split(' '),
)
const stem = (w: string) => (w.length > 4 && /[sx]$/.test(w) ? w.slice(0, -1) : w)

/** Les mots-clés d'un texte : découpe camelCase et ponctuation, sans accents ni mots vides, pluriel retiré. */
export function terms(s: string): string[] {
  return words(s.replace(/[^\p{L}\p{N}]+/gu, ' '))
    .flatMap(w => slug(w).split('-'))
    .filter(w => w.length > 1 && !STOP.has(w))
    .map(stem)
}

type Doc = { key: string; feature: boolean; terms: Map<string, number>; len: number }
type Index = { docs: Doc[]; df: Map<string, number>; avgFeature: number; avgFile: number; n: number }
const indexCache = new WeakMap<Graph, Index>()

const baseName = (p: string) => p.split('/').pop()!.replace(/\.[^.]+$/, '')

function searchIndex(graph: Graph): Index {
  const hit = indexCache.get(graph)
  if (hit) return hit
  const docs: Doc[] = []
  const doc = (key: string, feature: boolean, fields: [string | string[] | undefined, number][]) => {
    const t = new Map<string, number>()
    let len = 0
    for (const [v, w] of fields)
      for (const s of Array.isArray(v) ? v : v ? [v] : [])
        for (const x of terms(s)) {
          len++
          if ((t.get(x) ?? 0) < w) t.set(x, w)
        }
    docs.push({ key, feature, terms: t, len })
  }
  for (const f of Object.values(graph.features))
    doc(f.id, true, [
      [f.id, 3],
      [f.alias, 3],
      [f.titre, 2],
      [f.resume, 1],
      [f.fichiers.map(x => baseName(x.p)), 1],
      [f.entrees.map(e => e.replace(/^r:/, '')), 1],
    ])
  for (const [p, n] of Object.entries(graph.fichiers))
    doc(p, false, [
      [baseName(p), 3],
      [n.k === 'page' ? routeOf(p) : undefined, 2],
      [p.split('/').slice(0, -1), 1],
      [n.exp, 1],
      [n.sum, 1],
    ])
  const df = new Map<string, number>()
  for (const d of docs) for (const t of d.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  // Longueur moyenne par famille : une fiche est bien plus longue qu'un nom de fichier
  const avg = (list: Doc[]) => list.reduce((s, d) => s + d.len, 0) / Math.max(1, list.length) || 1
  const idx = { docs, df, avgFeature: avg(docs.filter(d => d.feature)), avgFile: avg(docs.filter(d => !d.feature)), n: docs.length }
  indexCache.set(graph, idx)
  return idx
}

function scoreAll(graph: Graph, query: string): { key: string; feature: boolean; score: number }[] {
  const idx = searchIndex(graph)
  const q = [...new Set(terms(query))]
  if (!q.length) return []
  const idf = (t: string) => {
    const df = idx.df.get(t) ?? 0
    return Math.log(1 + (idx.n - df + 0.5) / (df + 0.5))
  }
  const out: { key: string; feature: boolean; score: number }[] = []
  for (const d of idx.docs) {
    let s = 0
    for (const t of q) {
      const w = d.terms.get(t)
      if (w) {
        s += w * idf(t)
        continue
      }
      if (t.length < 4) continue
      let best = 0
      for (const [dt, dw] of d.terms)
        if (dt.length >= 4 && (dt.startsWith(t) || t.startsWith(dt))) best = Math.max(best, 0.5 * dw * idf(idx.df.has(t) ? t : dt))
      s += best
    }
    if (s > 0) out.push({ key: d.key, feature: d.feature, score: round2(s / (0.75 + (0.25 * d.len) / (d.feature ? idx.avgFeature : idx.avgFile))) })
  }
  return out.sort((a, b) => b.score - a.score)
}

/** Les 5 features et les 8 fichiers les plus pertinents pour la requête. */
export function search(graph: Graph, query: string): { features: { id: string; score: number }[]; files: { p: string; score: number }[] } {
  const all = scoreAll(graph, query)
  return {
    features: all.filter(x => x.feature).slice(0, 5).map(x => ({ id: x.key, score: x.score })),
    files: all.filter(x => !x.feature).slice(0, 8).map(x => ({ p: x.key, score: x.score })),
  }
}

/** Seuils de correspondance demande ↔ feature : score absolu, et avance sur la deuxième. */
export const MATCH_MIN = 6
export const MATCH_RATIO = 1.5

/** La feature que vise la demande, seulement si elle ressort nettement (seuil absolu et avance sur la deuxième) ; une fiche sans fichier n'est jamais servie. */
export function matchRequest(graph: Graph, request: string): { id: string; score: number } | undefined {
  const [best, second] = scoreAll(graph, request).filter(x => x.feature && graph.features[x.key]?.fichiers.length)
  if (!best || best.score < MATCH_MIN || (second && best.score < MATCH_RATIO * second.score)) return undefined
  return { id: best.key, score: best.score }
}

// ── Voisins ──────────────────────────────────────────────────────────────

const reverseCache = new WeakMap<Graph, Map<string, Map<string, string[]>>>()

function reverseIndex(graph: Graph): Map<string, Map<string, string[]>> {
  const hit = reverseCache.get(graph)
  if (hit) return hit
  const rev = new Map<string, Map<string, string[]>>()
  for (const [src, n] of [...Object.entries(graph.fichiers), ...Object.entries(graph.noeuds)])
    for (const [k, list] of Object.entries(n.out ?? {}))
      for (const t of list ?? []) {
        const m = rev.get(t) ?? new Map<string, string[]>()
        m.set(k, [...(m.get(k) ?? []), src])
        rev.set(t, m)
      }
  reverseCache.set(graph, rev)
  return rev
}

/** Retrouve la clé d'un chemin : relatif, absolu sous la racine, route « /x », ou suffixe unique (« offer.vue »). */
export function resolveKey(graph: Graph, p: string): string | undefined {
  let n = norm(p.trim())
  const root = norm(graph.projet.racine).replace(/\/$/, '')
  if (root && n.toLowerCase().startsWith(`${root.toLowerCase()}/`)) n = n.slice(root.length + 1)
  if (graph.fichiers[n] || graph.noeuds[n]) return n
  if (n.startsWith('/') && graph.noeuds[`r:${n}`]) return `r:${n}`
  const tail = n.replace(/^\/+/, '')
  const c = Object.keys(graph.fichiers).filter(k => k === tail || k.endsWith(`/${tail}`))
  return c.length === 1 ? c[0] : undefined
}

/** Ce que le fichier utilise (out) et qui l'utilise (in), par type d'arête ; à profondeur 2, les clés « k1/k2 » donnent le second saut. */
export function neighbors(
  graph: Graph,
  p: string,
  depth = 1,
): { out: Record<string, string[]>; in: Record<string, string[]>; tests: string[]; docs: string[] } {
  const key = resolveKey(graph, p) ?? norm(p)
  const rev = reverseIndex(graph)
  const outOf = (k: string) => (graph.fichiers[k] ?? graph.noeuds[k])?.out ?? {}
  const inOf = (k: string) => Object.fromEntries(rev.get(k) ?? []) as Record<string, string[]>
  const out: Record<string, string[]> = {}
  const inn: Record<string, string[]> = {}
  for (const [k, list] of Object.entries(outOf(key))) out[k] = [...(list ?? [])]
  for (const [k, list] of Object.entries(inOf(key))) inn[k] = [...list]
  if (depth >= 2) {
    const hop = (first: Record<string, string[]>, next: (k: string) => Record<string, string[] | undefined>) => {
      const seen = new Set([key, ...Object.values(first).flat()])
      const add: Record<string, string[]> = {}
      for (const [k1, list] of Object.entries(first)) {
        if (k1 === 'documente' || k1 === 'teste') continue
        for (const t of list)
          for (const [k2, l2] of Object.entries(next(t)))
            for (const u of l2 ?? [])
              if (!seen.has(u)) {
                seen.add(u)
                ;(add[`${k1}/${k2}`] ??= []).push(u)
              }
      }
      Object.assign(first, add)
    }
    hop(out, outOf)
    hop(inn, inOf)
  }
  const tests = [...(inn.teste ?? [])]
  const docs = [...(inn.documente ?? [])]
  return { out, in: inn, tests, docs }
}
// ── Apprentissage ────────────────────────────────────────────────────────

const ROLES: readonly FileRole[] = ['entree', 'coeur', 'donnees', 'ui', 'test', 'peripherique']

/** Le rôle d'un fichier dans une fiche, d'après son type, quand le modèle ne l'a pas donné. */
export function guessRole(k: NodeKind): FileRole {
  if (k === 'test') return 'test'
  if (k === 'page') return 'entree'
  if (k === 'store' || k === 'service' || k === 'gql' || k === 'type') return 'donnees'
  if (k === 'composant' || k === 'layout') return 'ui'
  if (k === 'doc' || k === 'config' || k === 'plugin' || k === 'middleware') return 'peripherique'
  return 'coeur'
}

function roleOf(raw: string | undefined, k: NodeKind): FileRole | undefined {
  const r = slug((raw ?? '').replace(/œ/g, 'oe')) as FileRole
  return ROLES.includes(r) ? r : raw ? guessRole(k) : undefined
}

const clip = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** Confiance par défaut selon la source : fin de flow 0,9 ; construction 0,75 ; fiche automatique 0,5 ; manuel 0,8. */
function defaultConfidence(source: string): number {
  if (source.startsWith('flow-auto')) return 0.5
  if (source.startsWith('flow')) return 0.9
  if (source === 'build') return 0.75
  return 0.8
}

const byRole = (a: FeatureFile, b: FeatureFile) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role)

/**
 * Écrit ou complète une fiche. Les chemins de fichiers et de pièges inconnus de la couche mécanique sont rejetés (et renvoyés) ;
 * les entrées (routes, commandes, mutations…) sont du texte : gardées telles quelles, ramenées à la clé du graphe quand elles en désignent une.
 * Les hash de tous les fichiers de la fiche sont remis à jour et `perime` est vidé.
 * Une fiche nouvelle sans aucun fichier valide est refusée (`refus`, graphe inchangé) ; une fiche existante restée sans fichier est écrite avec un `avertissement`.
 */
export function learn(graph: Graph, input: LearnInput, ctx: LearnContext): LearnResult {
  const id = slug(clip(input.feature, 80))
  if (!id) return { graph, rejected: ['feature (identifiant manquant)'] }
  const old = graph.features[id]
  const rejected: string[] = []
  const known = (p: string) => {
    const k = resolveKey(graph, p)
    return k && graph.fichiers[k] ? k : undefined
  }

  const files = new Map<string, FileRole>()
  for (const ff of old?.fichiers ?? []) if (graph.fichiers[ff.p]) files.set(ff.p, ff.role)
  for (const x of input.fichiers ?? []) {
    const k = typeof x?.p === 'string' ? known(x.p) : undefined
    if (!k) {
      rejected.push(String(x?.p ?? '?'))
      continue
    }
    files.set(k, roleOf(x.role, graph.fichiers[k]!.k) ?? files.get(k) ?? guessRole(graph.fichiers[k]!.k))
  }

  let entrees = old?.entrees ?? []
  if (input.entrees) {
    entrees = []
    for (const e of input.entrees) {
      const t = clip(e, 200)
      if (t) entrees.push(graph.noeuds[t] ? t : graph.noeuds[`r:${t}`] ? `r:${t}` : (known(t) ?? t))
    }
  }

  const pieges: Feature['pieges'] = []
  for (const x of input.pieges ?? []) {
    const txt = clip(x?.txt, 300)
    if (!txt) continue
    const p = x.p ? known(x.p) : undefined
    if (x.p && !p) rejected.push(x.p)
    pieges.push(p ? { txt, p } : { txt })
  }
  for (const c of input.corrections ?? []) {
    const txt = clip(c, 300)
    if (txt) pieges.push({ txt: `Corrigé : ${txt}` })
  }
  for (const x of old?.pieges ?? []) if (!pieges.some(y => y.txt === x.txt)) pieges.push(x)

  const alias = [...new Set([...(input.alias ?? []), ...(old?.alias ?? [])].map(a => clip(a, 40).toLowerCase()).filter(Boolean))].slice(0, 20)
  const feature: Feature = {
    id,
    titre: clip(input.titre, 120) || old?.titre || id,
    alias,
    resume: input.resume !== undefined ? clip(input.resume, 600) : (old?.resume ?? ''),
    flux: input.flux ? input.flux.map(s => clip(s, 240)).filter(Boolean).slice(0, 12) : (old?.flux ?? []),
    entrees: [...new Set(entrees)],
    fichiers: [...files]
      .map(([p, role]) => ({ p, role, h: graph.fichiers[p]!.h }))
      .sort(byRole)
      .slice(0, 60),
    pieges: pieges.slice(0, 12),
    deps: input.deps ? [...new Set(input.deps.map(d => slug(clip(d, 80))).filter(d => d && d !== id))] : (old?.deps ?? []),
    confiance: round2(Math.max(0, Math.min(1, ctx.confiance ?? defaultConfidence(ctx.source)))),
    source: ctx.source,
    ...(ctx.modele ? { modele: ctx.modele } : old?.modele ? { modele: old.modele } : {}),
    appris: { le: ctx.le, commit: ctx.commit, branche: ctx.branche },
    perime: [],
    usages: old?.usages ?? { servie: 0, evites: 0 },
  }
  if (!feature.fichiers.length) {
    if (!old)
      return {
        graph,
        rejected,
        refus: `fiche « ${id} » refusée : aucun fichier valide (chemins relatifs à la racine du projet, fichiers indexés). Rien n'a été écrit.`,
      }
    const next = { ...graph, features: { ...graph.features, [id]: feature } }
    return { graph: next, rejected, avertissement: `la fiche « ${id} » n'a plus aucun fichier valide : elle est à reconstruire et ne sera plus servie.` }
  }
  return { graph: { ...graph, features: { ...graph.features, [id]: feature } }, rejected }
}

/**
 * Fiche minimale « flow-auto » (fichiers sans résumé, confiance 0,5) ; une fiche existante est seulement complétée.
 * Personne n'a vérifié ces fichiers pour la fiche : ils sont enregistrés non vérifiés (h = '') et comptent comme à relire.
 */
export function autoFiche(graph: Graph, id: string, files: { p: string; role?: string }[], ctx: LearnContext): Graph {
  const key = slug(id)
  if (!key) return graph
  const valid = files
    .map(x => ({ k: resolveKey(graph, x.p), role: x.role }))
    .filter((x): x is { k: string; role: string | undefined } => Boolean(x.k && graph.fichiers[x.k]))
  if (!valid.length) return graph
  const old = graph.features[key]
  const fichiers = [...(old?.fichiers ?? [])]
  for (const x of valid) {
    if (fichiers.some(f => f.p === x.k)) continue
    const n = graph.fichiers[x.k]!
    fichiers.push({ p: x.k, role: roleOf(x.role, n.k) ?? guessRole(n.k), h: '' })
  }
  if (old) return { ...graph, features: { ...graph.features, [key]: { ...old, fichiers: fichiers.slice(0, 60) } } }
  const rev = reverseIndex(graph)
  const entrees = valid.flatMap(x => rev.get(x.k)?.get('sert') ?? [])
  const feature: Feature = {
    id: key,
    titre: id,
    alias: [],
    resume: '',
    flux: [],
    entrees: [...new Set(entrees)],
    fichiers: fichiers.sort(byRole).slice(0, 60),
    pieges: [],
    deps: [],
    confiance: round2(ctx.confiance ?? 0.5),
    source: 'flow-auto',
    ...(ctx.modele ? { modele: ctx.modele } : {}),
    appris: { le: ctx.le, commit: ctx.commit, branche: ctx.branche },
    perime: [],
    usages: { servie: 0, evites: 0 },
  }
  return { ...graph, features: { ...graph.features, [key]: feature } }
}

/** Ajoute à la fiche, en « peripherique » et non vérifiés (h = ''), les fichiers lus pendant le flow qui n'y figuraient pas. */
export function completeFiche(graph: Graph, id: string, lus: string[]): Graph {
  const f = graph.features[id]
  if (!f) return graph
  const fichiers = [...f.fichiers]
  for (const p of lus) {
    const k = resolveKey(graph, p)
    const n = k ? graph.fichiers[k] : undefined
    if (!k || !n || fichiers.length >= 60 || fichiers.some(x => x.p === k)) continue
    fichiers.push({ p: k, role: 'peripherique', h: '' })
  }
  if (fichiers.length === f.fichiers.length) return graph
  return { ...graph, features: { ...graph.features, [id]: { ...f, fichiers } } }
}

/** Le chemin de la fiche que désigne `p` (relatif, absolu sous la racine, suffixe unique parmi ses fichiers), même si le fichier a disparu du graphe. */
function ficheKey(graph: Graph, f: Feature, p: unknown): string | undefined {
  if (typeof p !== 'string' || !p.trim()) return undefined
  const inFiche = (k: string | undefined) => (k !== undefined && f.fichiers.some(x => x.p === k) ? k : undefined)
  const hit = inFiche(resolveKey(graph, p))
  if (hit) return hit
  let n = norm(p.trim())
  const root = norm(graph.projet.racine).replace(/\/$/, '')
  if (root && n.toLowerCase().startsWith(`${root.toLowerCase()}/`)) n = n.slice(root.length + 1)
  const exact = inFiche(n)
  if (exact) return exact
  const tail = n.replace(/^\/+/, '')
  const c = f.fichiers.filter(x => x.p.endsWith(`/${tail}`))
  return c.length === 1 ? c[0]!.p : undefined
}

/**
 * Confirme une fiche après relecture : remet le hash courant sur les seuls fichiers de la fiche listés dans `paths` et les retire de `perime`.
 * Ni le résumé, ni le flux, ni les pièges, ni la confiance ne bougent. Un fichier listé mais absent de la fiche n'est pas ajouté (`unknown`) ;
 * un fichier listé qui a disparu du graphe est retiré de la fiche (et compté dans `refreshed`).
 * Si plus aucun fichier de la fiche n'est périmé après coup, `appris` (date, commit, branche) prend `ctx` : la fiche vient d'être revérifiée en entier.
 * Fiche inconnue ou rien de rafraîchi : le même graphe.
 */
export function refreshFiles(graph: Graph, id: string, paths: string[], ctx: RefreshContext): { graph: Graph; refreshed: string[]; unknown: string[] } {
  const f = graph?.features?.[id]
  const list = Array.isArray(paths) ? paths : []
  if (!f) return { graph, refreshed: [], unknown: list.map(String) }
  const refreshed: string[] = []
  const unknown: string[] = []
  const gone = new Set<string>()
  const fresh = new Map<string, string>()
  for (const raw of list) {
    const k = ficheKey(graph, f, raw)
    if (!k) {
      unknown.push(String(raw))
      continue
    }
    if (refreshed.includes(k)) continue
    refreshed.push(k)
    const n = graph.fichiers[k]
    if (n) fresh.set(k, n.h)
    else gone.add(k)
  }
  if (!refreshed.length) return { graph, refreshed, unknown }
  const next: Feature = {
    ...f,
    fichiers: f.fichiers.filter(x => !gone.has(x.p)).map(x => (fresh.has(x.p) ? { ...x, h: fresh.get(x.p)! } : x)),
  }
  next.perime = perimeOf(graph, next)
  if (!next.perime.length && ctx) next.appris = { le: ctx.le, commit: ctx.commit, branche: ctx.branche }
  return { graph: { ...graph, features: { ...graph.features, [id]: next } }, refreshed, unknown }
}

// ── Mesure des gains ─────────────────────────────────────────────────────

/** Les hits à enregistrer quand une fiche est servie : ses fichiers existants, frais si leur hash n'a pas changé ; `only` limite aux chemins donnés (extrait d'un agent). */
export function servedFiles(graph: Graph, f: Feature, par: string, only?: string[]): CacheHit[] {
  const out: CacheHit[] = []
  const keep = only ? new Set(only) : undefined
  for (const ff of f.fichiers) {
    if (keep && !keep.has(ff.p)) continue
    const n = graph.fichiers[ff.p]
    if (n) out.push({ p: ff.p, tok: n.tok, feature: f.id, frais: sameHash(n.h, ff.h), par })
  }
  return out
}

/** Les hits d'un extrait de fiche : seulement les fichiers `paths` (ceux que rend extractFiles). */
export const servedSubset = (graph: Graph, f: Feature, paths: string[], par: string): CacheHit[] => servedFiles(graph, f, par, paths)

type Gains = { evites: number; servis: number; net: number; lus: number; completude: number; byFeature: Map<string, number>; feats: string[]; hits: CacheHit[] }

/** Évités = fichiers servis frais que personne n'a lus (une seule fois par fichier) ; net = évités − injectés ; complétude = part des fichiers lus présents dans les fiches servies. */
function gains(graph: Graph | null, flow: FlowCache): Gains {
  const lus = new Map<string, number>()
  for (const l of flow.lus) {
    const p = norm(l.p)
    lus.set(p, Math.max(lus.get(p) ?? 0, l.tok))
  }
  const served = new Map<string, CacheHit>()
  for (const h of flow.servis) {
    const p = norm(h.p)
    const o = served.get(p)
    if (!o || (h.frais && !o.frais) || (h.frais === o.frais && h.tok > o.tok)) served.set(p, { ...h, p })
  }
  let evites = 0
  let servis = 0
  const byFeature = new Map<string, number>()
  for (const h of served.values()) {
    servis += h.tok
    if (!h.frais || lus.has(h.p)) continue
    evites += h.tok
    if (h.feature) byFeature.set(h.feature, (byFeature.get(h.feature) ?? 0) + h.tok)
  }
  const feats = [...new Set([...(flow.feature ? [flow.feature] : []), ...flow.servis.flatMap(h => (h.feature ? [h.feature] : []))])]
  const fiche = new Set(feats.flatMap(id => graph?.features[id]?.fichiers.map(f => f.p) ?? []))
  const read = [...lus.keys()]
  const completude = read.length ? read.filter(p => fiche.has(p)).length / read.length : fiche.size ? 1 : 0
  return {
    evites,
    servis,
    net: evites - flow.injecte,
    lus: [...lus.values()].reduce((s, t) => s + t, 0),
    completude: round2(completude),
    byFeature,
    feats,
    hits: [...served.values()],
  }
}

/** Fin de flow : incrémente les usages des fiches servies et les statistiques cumulées du projet. */
export function recordUsage(graph: Graph, flow: FlowCache): Graph {
  const g = gains(graph, flow)
  if (!flow.servis.length && !flow.injecte && !g.feats.length) return { ...graph, stats: { ...graph.stats, flows: graph.stats.flows + 1 } }
  const features = { ...graph.features }
  for (const id of g.feats) {
    const f = features[id]
    if (f) features[id] = { ...f, usages: { servie: f.usages.servie + 1, evites: f.usages.evites + (g.byFeature.get(id) ?? 0) } }
  }
  const s = graph.stats
  return { ...graph, features, stats: { flows: s.flows + 1, servis: s.servis + g.servis, evites: s.evites + g.evites, net: s.net + g.net } }
}

/** Les données du panneau et de la bande. */
export function computeStats(graph: Graph | null, flow: FlowCache | null, nom: string): CacheStats | null {
  if (!graph) return null
  const parType: Record<string, number> = {}
  for (const n of Object.values(graph.fichiers)) parType[n.k] = (parType[n.k] ?? 0) + 1
  const g = flow ? gains(graph, flow) : undefined
  const hitOf = new Map<string, string>()
  for (const h of flow?.servis ?? []) if (h.feature && !hitOf.has(h.feature)) hitOf.set(h.feature, h.par)
  if (flow?.feature && !hitOf.has(flow.feature)) hitOf.set(flow.feature, 'brief')
  const feats = Object.values(graph.features).map(f => ({ f, fr: freshness(graph, f) }))
  const noeuds: CacheStats['noeuds'] = feats
    .sort((a, b) => Number(hitOf.has(b.f.id)) - Number(hitOf.has(a.f.id)) || b.f.usages.servie - a.f.usages.servie || a.f.id.localeCompare(b.f.id))
    .map(({ f, fr }) => {
      const hit = hitOf.get(f.id)
      return {
        id: f.id,
        k: 'feature',
        titre: f.titre,
        niveau: fr.niveau,
        ...(hit ? { hit } : {}),
        tok: f.fichiers.reduce((s, x) => s + (graph.fichiers[x.p]?.tok ?? 0), 0),
      }
    })
  for (const h of g?.hits ?? [])
    noeuds.push({ id: h.p, k: graph.fichiers[h.p]?.k ?? 'autre', titre: baseName(h.p), niveau: h.frais ? 'fraiche' : 'perimee', hit: h.par, tok: h.tok })
  const fraiches = feats.filter(x => x.fr.niveau === 'fraiche').length
  return {
    projet: nom,
    cle: graph.projet.cle,
    fichiers: Object.keys(graph.fichiers).length,
    features: feats.length,
    fraiches,
    perimees: feats.length - fraiches,
    parType,
    indexe: { commit: graph.projet.indexe.commit, le: graph.projet.indexe.le },
    noeuds: noeuds.slice(0, 40),
    flow: g
      ? { injecte: flow!.injecte, evites: g.evites, net: g.net, lus: g.lus, completude: g.completude, ...(flow!.feature ? { feature: flow!.feature } : {}) }
      : { injecte: 0, evites: 0, net: 0, lus: 0, completude: 0 },
    cumul: { flows: graph.stats.flows, evites: graph.stats.evites, net: graph.stats.net },
  }
}
// ── Textes (français, compacts, jamais de JSON) ──────────────────────────

const two = (n: number) => String(n).padStart(2, '0')
const pct = (r: number) => `${Math.round(r * 100)} %`
const conf = (x: number) => x.toFixed(2).replace('.', ',')
const signed = (n: number) => (n < 0 ? `−${fmt(-n)}` : fmt(n))
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`

function dateFr(iso: string, withTime = false): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '?'
  const day = `${two(d.getDate())}/${two(d.getMonth() + 1)}`
  return withTime ? `${day} ${two(d.getHours())}:${two(d.getMinutes())}` : day
}

function sourceLabel(s: string): string {
  if (s.startsWith('flow-auto')) return 'automatiquement en fin de flow'
  if (s.startsWith('flow')) return 'en flow'
  if (s === 'build') return 'par construction'
  if (s === 'manuel') return 'à la main'
  return s
}

/** ✓ fraîche, ⚠N partielle, ✕N très périmée : pour les listes. */
function freshMark(fr: Freshness): string {
  if (fr.vide) return '✕ vide'
  return fr.niveau === 'fraiche' ? '✓' : fr.niveau === 'partielle' ? `⚠${fr.perimes.length}` : `✕${fr.perimes.length}`
}

function freshWord(fr: Freshness): string {
  if (fr.vide) return '✕ à reconstruire (aucun fichier)'
  if (fr.niveau === 'fraiche') return '✓ fraîche'
  if (fr.niveau === 'partielle') {
    const nv = fr.nonVerifies?.length ?? 0
    const mod = fr.perimes.length - nv
    const parts = [...(mod ? [plural(mod, 'fichier modifié', 'fichiers modifiés')] : []), ...(nv ? [plural(nv, 'fichier non vérifié', 'fichiers non vérifiés')] : [])]
    return `⚠ ${parts.join(', ')}`
  }
  return `✕ très périmée (${pct(fr.ratio)} modifié)`
}

const ficheTok = (graph: Graph, f: Feature) => f.fichiers.reduce((s, x) => s + (graph.fichiers[x.p]?.tok ?? 0), 0)

/** Coût estimé d'une construction à la demande (Sonnet, ≈ 10 tours) : ≈ 0,2 $ pour 25k tokens (conception §5.2). */
export const buildCostUsd = (tok: number) => 0.04 + tok * 6e-6

/** Coupe les dernières lignes jusqu'à tenir dans le budget de tokens. */
function capLines(lines: string[], max: number, keepTail: string[] = []): string {
  const body = [...lines]
  const text = () => [...body, ...keepTail].join('\n')
  if (tokensOf(text()) <= max) return text()
  while (body.length > 1 && tokensOf(text()) > max - 3) body.pop()
  body.push('… (tronqué)')
  const t = text()
  return tokensOf(t) <= max ? t : t.slice(0, max * 4)
}

function featureHeader(f: Feature, fr: Freshness, prefix = '## Fiche'): string {
  const c = fr.confiance < f.confiance ? `${conf(fr.confiance)} (${conf(f.confiance)} à l'apprentissage)` : conf(f.confiance)
  const name = f.titre && f.titre !== f.id ? `${f.id} : ${f.titre}` : f.id
  const model = f.modele ? `, ${modelLabel(f.modele)}` : ''
  return `${prefix} ${name} (confiance ${c}, apprise le ${dateFr(f.appris.le)} ${sourceLabel(f.source)}${model}) · ${freshWord(fr)}`
}

/** Que faire d'une fiche partiellement périmée, une fois les fichiers modifiés relus (rafraichir, apprendre ou diff). */
const CONSIGNE_PARTIELLE =
  'Après relecture : si la fiche reste juste pour ces fichiers, action rafraichir (feature, fichiers = ceux relus) ; si elle est fausse, action apprendre avec corrections (et flux/pieges corrigés). Action diff (feature ou chemin) pour voir ce qui a changé sans tout relire.'
/** Que faire d'une fiche très périmée. */
const CONSIGNE_PERIMEE = 'Relis les fichiers (ou action diff) puis action apprendre pour la réécrire.'

/** Une ligne de fichier de fiche : chemin, rôle, taille, puis ✕ supprimé, ⚠ non vérifié ou `modifie`. */
function fileLine(graph: Graph, ff: FeatureFile, changed: Set<string>, unchecked: Set<string>, modifie: string): string {
  const n = graph.fichiers[ff.p]
  const mark = !n ? ' ✕ supprimé' : unchecked.has(ff.p) ? ' ⚠ non vérifié' : changed.has(ff.p) ? modifie : ''
  return `- ${ff.p} · ${ff.role}${n ? ` · ${fmt(n.tok)}` : ''}${mark}`
}

/** Le corps d'une fiche selon sa fraîcheur (§3.3) : flux masqué au-delà de 50 % de tokens modifiés ; pièges avant les fichiers. */
function featureBody(graph: Graph, f: Feature, fr: Freshness): string[] {
  const L: string[] = []
  const changed = new Set(fr.perimes)
  const unchecked = new Set(fr.nonVerifies ?? [])
  if (fr.vide) {
    L.push("⚠ Fiche sans aucun fichier du projet : à reconstruire (action apprendre avec ses fichiers) ; résumé et flux masqués, rien n'est servi.")
  } else if (fr.niveau === 'perimee') {
    L.push(`⚠ Fiche très périmée (${pct(fr.ratio)} des tokens modifiés depuis l'apprentissage) : résumé et flux masqués, tout est à revérifier dans le code.`)
    L.push(CONSIGNE_PERIMEE)
  } else {
    if (fr.niveau === 'partielle') {
      const mod = fr.perimes.filter(p => !unchecked.has(p))
      if (mod.length) L.push(`⚠ Modifiés depuis l'apprentissage : ${mod.join(', ')} : relis ces fichiers avant de te fier au flux.`)
      if (unchecked.size) L.push(`⚠ Jamais vérifiés (ajoutés automatiquement) : ${[...unchecked].join(', ')} : relis-les avant de t'y fier.`)
      L.push(CONSIGNE_PARTIELLE)
    }
    L.push(f.resume ? `Résumé : ${f.resume}` : 'Fiche automatique : pas de résumé, seulement les fichiers vus pendant un flow.')
    if (f.flux.length) {
      L.push('Flux :')
      f.flux.forEach((s, i) => L.push(`${i + 1}. ${s}`))
    }
  }
  if (f.entrees.length) L.push(`Entrées : ${f.entrees.map(e => e.replace(/^r:/, '')).join(', ')}`)
  // Pièges et dépendances avant la liste des fichiers : capLines coupe par la fin, ils doivent survivre à la coupe.
  if (f.pieges.length) {
    L.push(fr.niveau === 'perimee' ? 'Pièges (à revérifier) :' : 'Pièges :')
    for (const x of f.pieges) L.push(`- ${x.txt}${x.p ? ` (${x.p})` : ''}`)
  }
  if (f.deps.length) L.push(`Dépend de : ${f.deps.join(', ')}`)
  if (f.fichiers.length) {
    L.push(`Fichiers (${f.fichiers.length}, rôle · taille) :`)
    for (const ff of f.fichiers.slice(0, 30)) L.push(fileLine(graph, ff, changed, unchecked, ' ⚠ modifié'))
    if (f.fichiers.length > 30) L.push(`… et ${f.fichiers.length - 30} autres`)
  }
  return L
}

/** La fiche servie (≤ 1 500 tokens), selon sa fraîcheur. */
export function featureText(graph: Graph, f: Feature): string {
  const fr = freshness(graph, f)
  return capLines([featureHeader(f, fr), ...featureBody(graph, f, fr)], 1500)
}

/** « Features connues : a ✓ · b ⚠2 ; candidates sans fiche : ird (18 commits) ». */
function featuresLine(graph: Graph): string {
  const feats = Object.values(graph.features).sort((a, b) => b.usages.servie - a.usages.servie || a.id.localeCompare(b.id))
  const cands = graph.candidates.filter(c => !graph.features[c.id]).slice(0, 5)
  const known = feats
    .slice(0, 15)
    .map(f => `${f.id} ${freshMark(freshness(graph, f))}`)
    .join(' · ')
  const more = feats.length > 15 ? ` · … et ${feats.length - 15} autres` : ''
  const c = cands.length ? `candidates sans fiche : ${cands.map(x => `${x.id} (${x.commits} commits)`).join(' · ')}` : ''
  if (!feats.length) return `Aucune fiche de feature pour l'instant${c ? ` ; ${c}` : '.'}`
  return `Features connues (✓ fraîche, ⚠ modifiée, ✕ très périmée) : ${known}${more}${c ? ` ; ${c}` : ''}`
}

// ── Carte à froid (demande sans fiche) ───────────────────────────────────

/** Les arêtes qui lient deux fichiers de code pour la centralité (« appelle » q:op compte vers le fichier qui déclare l'opération). */
const CENTRAL_EDGES: EdgeKind[] = ['importe', 'utilise', 'rend', 'appelle']
/** Un fichier généré, même s'il a échappé aux exclusions. */
const GENERATED = /(^|\/)(generated|__generated__)\/|\.(g|gen|generated|freezed|mocks|pb)\.(dart|[cm]?[jt]sx?)$|\.min\.js$/i
/** Moins de fichiers de code que ça : pas de carte (le projet se lit d'un coup d'œil). */
const COLD_MIN_FILES = 5
/** Amortissement du PageRank : 0,75 garde la marche près des fichiers pertinents. */
const PR_DAMPING = 0.75
const PR_ITERS = 30

/** Mots français courants d'une demande → termes anglais du code (termes déjà passés par `terms` : sans accents, pluriel retiré). */
const GLOSSAIRE: Record<string, string[]> = {
  commande: ['order'],
  panier: ['cart', 'basket'],
  liste: ['list'],
  filtre: ['filter'],
  recherche: ['search'],
  client: ['customer'],
  utilisateur: ['user'],
  paiement: ['payment'],
  connexion: ['login', 'auth'],
  produit: ['product'],
  prix: ['price'],
  billet: ['ticket'],
  reservation: ['booking'],
  tableau: ['table'],
  formulaire: ['form'],
  bouton: ['button'],
  erreur: ['error'],
  fichier: ['file'],
  telechargement: ['download'],
  envoi: ['send'],
  traduction: ['i18n', 'translation'],
  calendrier: ['calendar'],
  jour: ['day'],
  heure: ['time', 'hour'],
  seance: ['session'],
  stock: ['stock'],
  offre: ['offer'],
  carte: ['card', 'map'],
  page: ['page'],
  ecran: ['screen'],
  parametre: ['settings', 'param'],
  notification: ['notification'],
  attente: ['waiting', 'pending', 'blocked'],
  relance: ['retry', 'relaunch', 'resume'],
}

type Carte = { nodes: string[]; adj: number[][]; central: Float64Array }
const carteCache = new WeakMap<Graph, Carte>()

/** PageRank sur un graphe non orienté, téléportation selon `seed` (somme 1) ; la masse d'un nœud isolé repart selon `seed`. */
function pagerank(adj: number[][], seed: Float64Array): Float64Array {
  const n = adj.length
  let pr = Float64Array.from(seed)
  for (let it = 0; it < PR_ITERS; it++) {
    const next = new Float64Array(n)
    let lost = 0
    for (let i = 0; i < n; i++) {
      const d = adj[i]!.length
      if (!d) {
        lost += pr[i]!
        continue
      }
      const share = pr[i]! / d
      for (const j of adj[i]!) next[j]! += share
    }
    for (let i = 0; i < n; i++) next[i] = (1 - PR_DAMPING) * seed[i]! + PR_DAMPING * (next[i]! + lost * seed[i]!)
    pr = next
  }
  return pr
}

/** Les fichiers de code (ni tests, ni docs, ni générés), leurs liens non orientés et leur centralité globale (PageRank uniforme). */
function carteOf(graph: Graph): Carte {
  const hit = carteCache.get(graph)
  if (hit) return hit
  const nodes = Object.entries(graph.fichiers)
    .filter(([p, n]) => n.k !== 'test' && n.k !== 'doc' && !GENERATED.test(p))
    .map(([p]) => p)
  const at = new Map(nodes.map((p, i) => [p, i]))
  const links = nodes.map(() => new Set<number>())
  nodes.forEach((p, i) => {
    const out = graph.fichiers[p]!.out ?? {}
    for (const k of CENTRAL_EDGES)
      for (const t of out[k] ?? []) {
        const j = at.get(t.startsWith('q:') ? (graph.noeuds[t]?.def ?? '') : t)
        if (j === undefined || j === i) continue
        links[i]!.add(j)
        links[j]!.add(i)
      }
  })
  const adj = links.map(s => [...s])
  const central = pagerank(adj, new Float64Array(nodes.length).fill(1 / Math.max(1, nodes.length)))
  const carte = { nodes, adj, central }
  carteCache.set(graph, carte)
  return carte
}

/**
 * Classe les fichiers de code pour une demande sans fiche : score = 0,6 × pertinence BM25 de la demande (nom, dossiers, exports, sum)
 * + 0,3 × PageRank personnalisé par les fichiers pertinents + 0,1 × centralité globale, chacun ramené à 0..1.
 * Aucun fichier pertinent : centralité seule. Ni tests, ni docs, ni fichiers générés ; moins de 5 fichiers de code : [].
 */
export function coldRank(graph: Graph, request: string): ColdFile[] {
  const { nodes, adj, central } = carteOf(graph)
  if (nodes.length < COLD_MIN_FILES) return []
  const at = new Map(nodes.map((p, i) => [p, i]))
  // La demande est souvent en français et le code en anglais : GLOSSAIRE ajoute la traduction des mots courants.
  const q = [...new Set(terms(String(request ?? '')).flatMap(t => [t, ...(GLOSSAIRE[t] ?? [])]))]
  const rel = new Float64Array(nodes.length)
  for (const x of scoreAll(graph, q.join(' '))) {
    const i = x.feature ? undefined : at.get(x.key)
    if (i !== undefined) rel[i] = x.score
  }
  // Les mots-clés (commentaires, noms internes) : idf calculé sur les seuls fichiers de la carte ; un préfixe commun (≥ 5 lettres) compte pour moitié.
  if (q.length) {
    const mots = nodes.map(p => graph.fichiers[p]!.mots ?? [])
    const df = new Map<string, number>()
    for (const list of mots) for (const t of list) df.set(t, (df.get(t) ?? 0) + 1)
    const idf = (t: string) => Math.log(1 + (nodes.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))
    mots.forEach((list, i) => {
      let s = 0
      for (const t of q) {
        if (list.includes(t)) {
          s += idf(t)
          continue
        }
        if (t.length < 5) continue
        const near = list.find(m => m.length >= 5 && (m.startsWith(t) || t.startsWith(m)))
        if (near) s += 0.5 * idf(near)
      }
      rel[i]! += s
    })
  }
  const maxOf = (a: Float64Array) => a.reduce((m, v) => Math.max(m, v), 0) || 1
  const relSum = rel.reduce((s, v) => s + v, 0)
  const maxC = maxOf(central)
  let score: (i: number) => number = i => central[i]! / maxC
  if (relSum > 0) {
    const ppr = pagerank(adj, rel.map(v => v / relSum))
    const maxR = maxOf(rel)
    const maxP = maxOf(ppr)
    score = i => 0.6 * (rel[i]! / maxR) + 0.3 * (ppr[i]! / maxP) + 0.1 * (central[i]! / maxC)
  }
  return nodes
    .map((p, i) => ({ p, score: round2(score(i)), pertinent: rel[i]! > 0 }))
    .sort((a, b) => b.score - a.score || Number(b.pertinent) - Number(a.pertinent) || a.p.localeCompare(b.p))
}

/** Titres de la carte à froid, selon qu'un fichier ressort ou non pour la demande. */
export const COLD_TITLE = '## Fichiers probables pour cette demande (carte, à vérifier)'
export const COLD_TITLE_CENTRAL = '## Rien ne ressort pour cette demande : fichiers les plus centraux du projet (carte, à vérifier)'

/**
 * La carte à froid (≤ maxTok tokens, 700 par défaut) : un titre puis 10 à 25 lignes « - chemin · type · ≈ taille · sum », par score décroissant
 * (au-delà de 10, seulement les scores ≥ 15 % du premier) ; aucun fichier pertinent : les 12 plus centraux sous COLD_TITLE_CENTRAL.
 * '' si le projet a moins de 5 fichiers de code ou si le budget ne laisse pas une ligne.
 */
export function coldMap(graph: Graph, request: string, maxTok = 700): string {
  try {
    const ranked = coldRank(graph, request)
    if (!ranked.length) return ''
    const any = ranked.some(x => x.pertinent)
    const max = any ? 25 : 12
    const top = ranked[0]!.score
    const ficheOf = new Map<string, string[]>()
    for (const f of Object.values(graph.features)) for (const x of f.fichiers) ficheOf.set(x.p, [...(ficheOf.get(x.p) ?? []), f.id])
    const L = [any ? COLD_TITLE : COLD_TITLE_CENTRAL]
    let used = tokensOf(L[0]!)
    for (const [i, x] of ranked.entries()) {
      if (i >= max || (i >= 10 && x.score < 0.15 * top)) break
      const n = graph.fichiers[x.p]!
      const fiches = ficheOf.get(x.p)
      const line = `- ${x.p} · ${n.k} · ≈ ${fmt(n.tok)}${n.sum ? ` · ${n.sum}` : ''}${fiches ? ` · fiche ${fiches.join(', ')}` : ''}`
      const cost = tokensOf(line) + 1
      if (used + cost > maxTok) break
      L.push(line)
      used += cost
    }
    return L.length > 1 ? L.join('\n') : ''
  } catch {
    return ''
  }
}

/**
 * Le brief injecté au lancement (≤ max tokens, 1 200 par défaut) ; sans feature : en-tête et liste des features, plus, si `request` est donnée,
 * la carte à froid (coldMap, ≤ 700 tokens) entre l'en-tête et la queue.
 */
export function briefText(graph: Graph, feature: Feature | undefined, max = 1200, request?: string): string {
  const p = graph.projet
  // Stack inconnue : pas de ligne (du bruit pour le modèle) ; les conventions restent.
  const known = p.stack && p.stack !== 'inconnue'
  const stack = known ? `Stack : ${p.stack}${p.conventions ? `. ${p.conventions}` : ''}` : p.conventions ? `Conventions : ${p.conventions}` : undefined
  const head = [
    `# Cache revo-flow — ${p.cle} (indexé ${p.indexe.commit.slice(0, 8)}${p.indexe.branche ? ` sur ${p.indexe.branche}` : ''}, ${p.indexe.fichiers} fichiers, ≈ ${fmt(p.indexe.tok)} tokens)`,
    ...(stack ? [stack] : []),
    featuresLine(graph),
  ]
  const tail = [
    'Le cache est une carte, pas la vérité : vérifie dans le code tout ce que tu affirmes ou modifies.',
    'Outil mcp__revo-flow__cache : chercher (mots-clés), feature (id), voisins (chemin : ce qu’il utilise, qui l’utilise), diff (feature ou chemin : ce qui a changé depuis l’apprentissage), rafraichir (fiche encore juste après relecture), apprendre (en fin de flow, ou fiche fausse).',
  ]
  if (!feature) {
    const room = Math.min(700, max - tokensOf([...head, ...tail].join('\n')) - 4)
    const map = request && room > 0 ? coldMap(graph, request, room) : ''
    return capLines(map ? [...head, ...map.split('\n')] : head, max, tail)
  }
  const fr = freshness(graph, feature)
  return capLines([...head, featureHeader(feature, fr, '## Fiche probable :'), ...featureBody(graph, feature, fr)], max, tail)
}

// ── Extrait de fiche pour un sous-agent ──────────────────────────────────

/** Les noms trop génériques pour désigner un fichier (nom de base ou export) dans un prompt. */
const GENERIC = new Set(['index', 'main', 'default', 'types', 'type', 'utils', 'util', 'config', 'test', 'tests', 'setup', 'helpers'])
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Fichiers de rôle central gardés quand rien ne correspond à la mission, et plafond des fichiers retenus par mission. */
const EXTRACT_FALLBACK = 10
const EXTRACT_MAX = 15

/** Le texte de la mission d'un agent : son prompt et ses tâches (jamais d'exception sur une entrée bizarre). */
function missionText(agent: AgentInfo): string {
  const tasks = Array.isArray(agent?.tasks) ? agent.tasks.map(t => String(t ?? '')) : []
  return [typeof agent?.prompt === 'string' ? agent.prompt : '', ...tasks].join('\n')
}

/** Les fichiers de la fiche que la mission cite : par chemin, par nom de base ou par export (casse ignorée, mots entiers ou slug). */
function mentioned(graph: Graph, f: Feature, text: string): string[] {
  const hay = text.toLowerCase().replace(/\\/g, '/')
  // Les jetons qui sont des chemins (avec « / ») ne désignent que le fichier entier : leur dernier mot n'est pas une citation d'un autre fichier du même nom de base.
  const pathRe = /[^\s'"`()<>,;:]*\/[^\s'"`()<>,;:]+/g
  const tokens = (hay.match(pathRe) ?? []).map(t => t.replace(/^(\.\/)+/, ''))
  const plain = hay.replace(pathRe, ' ')
  const slugHay = `-${slug(plain)}-`
  const word = (t: string) => {
    if (t.length < 4 || GENERIC.has(t.toLowerCase())) return false
    if (new RegExp(`(?<![\\w$])${escapeRe(t.toLowerCase())}(?![\\w$])`).test(plain)) return true
    const sl = slug(t)
    return sl.length >= 4 && slugHay.includes(`-${sl}-`)
  }
  const out: string[] = []
  for (const ff of f.fichiers) {
    const p = ff.p.toLowerCase()
    const byPath = hay.includes(p) || tokens.some(t => p.endsWith(`/${t}`))
    if (byPath || [baseName(ff.p), ...(graph.fichiers[ff.p]?.exp ?? [])].some(word)) out.push(ff.p)
  }
  return out
}

/** Les chemins de la fiche à montrer à cet agent : ceux que sa mission cite, sinon les fichiers entree, coeur et donnees (10 au plus). */
export function extractFiles(graph: Graph, f: Feature, agent: AgentInfo): string[] {
  try {
    const cited = mentioned(graph, f, missionText(agent)).slice(0, EXTRACT_MAX)
    if (cited.length) return cited
    return f.fichiers.filter(x => x.role === 'entree' || x.role === 'coeur' || x.role === 'donnees').slice(0, EXTRACT_FALLBACK).map(x => x.p)
  } catch {
    return []
  }
}

/**
 * L'extrait de fiche ajouté au prompt d'un sous-agent (≤ max tokens, 600 par défaut) : en-tête, pièges rattachés à ses fichiers (et 3 pièges sans fichier),
 * fichiers qui concernent sa mission (taille, ⚠ modifié, ⚠ non vérifié, ✕ supprimé), résumé si la fiche n'est pas très périmée et s'il reste du budget, ligne d'outil.
 */
export function agentExtract(graph: Graph, f: Feature, agent: AgentInfo, max = 600): string {
  const fr = freshness(graph, f)
  const paths = extractFiles(graph, f, agent)
  const set = new Set(paths)
  const changed = new Set(fr.perimes)
  const name = f.titre && f.titre !== f.id ? `${f.id} : ${f.titre}` : f.id
  const unchecked = new Set(fr.nonVerifies ?? [])
  const L = [`# Cache revo-flow — fiche « ${name} » (${freshWord(fr)}, confiance ${conf(fr.confiance)})`]
  // Pièges avant les fichiers : capLines coupe par la fin.
  const pieges = [...f.pieges.filter(x => x.p && set.has(x.p)), ...f.pieges.filter(x => !x.p).slice(0, 3)]
  if (pieges.length) {
    L.push('Pièges :')
    for (const x of pieges) L.push(`- ${x.txt}${x.p ? ` (${x.p})` : ''}`)
  }
  for (const ff of f.fichiers) if (set.has(ff.p)) L.push(fileLine(graph, ff, changed, unchecked, " ⚠ modifié depuis l'apprentissage"))
  const tail = [
    'Outil mcp__revo-flow__cache : feature « ' + f.id + ' » pour la fiche entière, voisins (chemin), diff (fichier modifié), rafraichir ou apprendre après relecture d’un fichier ⚠.',
  ]
  if (fr.niveau !== 'perimee' && f.resume) {
    const resume = `Résumé : ${f.resume}`
    if (tokensOf([...L, resume, ...tail].join('\n')) <= max) L.push(resume)
  }
  return capLines(L, max, tail)
}

// ── Diff depuis l'apprentissage ──────────────────────────────────────────

/** Budget de la réponse de l'action « diff », et plancher par fichier. */
const DIFF_MAX = 2500
const DIFF_MIN_FILE = 200
const DIFF_LINE = 240

/** Une ligne de diff coupée si elle est démesurée (fichier minifié). */
const diffLine = (l: string) => (l.length > DIFF_LINE ? `${l.slice(0, DIFF_LINE)}…` : l)

/** Les lignes ajoutées et retirées d'un diff unifié (hors en-têtes ---/+++ éventuels). */
function diffCounts(lines: string[]): { plus: number; minus: number } {
  let plus = 0
  let minus = 0
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) plus++
    else if (l.startsWith('-') && !l.startsWith('---')) minus++
  }
  return { plus, minus }
}

/** Découpe un diff en hunks (chacun commence à « @@ ») ; ce qui précède le premier « @@ » rejoint le premier hunk. */
function hunksOf(lines: string[]): string[][] {
  const hunks: string[][] = []
  for (const l of lines) {
    if (l.startsWith('@@') || hunks.length === 0) hunks.push([l])
    else hunks[hunks.length - 1]!.push(l)
  }
  return hunks
}

/** Le diff d'un fichier coupé au budget : hunks entiers tant que ça tient (au moins le début du premier), puis « … (tronqué, n lignes de plus) ». */
function clipDiff(lines: string[], budget: number): string[] {
  const hunks = hunksOf(lines)
  const out: string[] = []
  let used = 0
  const cost = (l: string) => tokensOf(l) + 1
  for (const h of hunks) {
    const size = h.reduce((s, l) => s + cost(l), 0)
    if (used + size <= budget) {
      out.push(...h)
      used += size
      continue
    }
    if (out.length === 0) {
      for (const l of h) {
        if (used + cost(l) > budget) break
        out.push(l)
        used += cost(l)
      }
    }
    break
  }
  const rest = lines.length - out.length
  if (rest > 0) out.push(`… (tronqué, ${plural(rest, 'ligne')} de plus)`)
  return out
}

/**
 * La réponse de l'action « diff » (≤ 2 500 tokens) : en-tête avec la date et le commit de l'apprentissage, puis par fichier « ### p (+n/-m lignes) » et son diff.
 * Le budget est partagé entre les fichiers ; chaque diff garde ses hunks entiers tant que sa part le permet. diff undefined : « diff indisponible ».
 */
export function diffText(graph: Graph, f: Feature | undefined, p: string | undefined, diffs: DiffEntry[]): string {
  try {
    const list = Array.isArray(diffs) ? diffs : []
    const what = f ? `de « ${f.id} » (le ${dateFr(f.appris.le)}, commit ${f.appris.commit.slice(0, 8) || '?'})` : p ? `de ${clip(p, 120)}` : ''
    const head = `Diff depuis l'apprentissage ${what}`.trim()
    if (!list.length) return `${head} : aucun fichier modifié, rien à comparer.`
    const L: string[] = [head]
    let used = tokensOf(head)
    for (let i = 0; i < list.length; i++) {
      const d = list[i]
      const left = list.length - i
      const budget = Math.min(DIFF_MAX - used, Math.max(DIFF_MIN_FILE, Math.floor((DIFF_MAX - used) / left)))
      if (budget < 30) {
        L.push(`… et ${plural(left, 'fichier')} de plus (budget atteint) : action diff avec un chemin pour chacun.`)
        break
      }
      const lines = typeof d?.diff === 'string' ? d.diff.split(/\r?\n/).filter((l, k, arr) => l !== '' || k < arr.length - 1).map(diffLine) : undefined
      const name = clip(d?.p, 200) || '?'
      const block: string[] = []
      if (lines === undefined && d?.depuis === '') block.push(`### ${name}`, 'jamais vérifié (ajouté automatiquement à la fiche) : relis le fichier, puis action rafraichir.')
      else if (lines === undefined) block.push(`### ${name}`, 'diff indisponible (blob absent) : relis le fichier.')
      else if (!lines.length) block.push(`### ${name}`, 'aucune différence.')
      else {
        const { plus, minus } = diffCounts(lines)
        block.push(`### ${name} (+${plus}/-${minus} lignes)`, ...clipDiff(lines, budget - 15))
      }
      L.push(...block)
      used += tokensOf(block.join('\n')) + 1
    }
    return capLines(L, DIFF_MAX)
  } catch {
    return 'Diff indisponible : relis les fichiers modifiés.'
  }
}

/** Réponse de l'action « chercher » : 5 features et 8 fichiers, une ligne chacun. */
export function searchText(graph: Graph, query: string): string {
  const r = search(graph, query)
  const q = clip(query, 80)
  if (!r.features.length && !r.files.length)
    return `Rien trouvé pour « ${q} » dans ${graph.projet.cle}. Essaie d'autres mots-clés (noms de fichiers, de composables, de routes), ou voisins sur un chemin.`
  const ficheOf = new Map<string, string[]>()
  for (const f of Object.values(graph.features)) for (const x of f.fichiers) ficheOf.set(x.p, [...(ficheOf.get(x.p) ?? []), f.id])
  const L = [`Recherche « ${q} » dans ${graph.projet.cle} : ${plural(r.features.length, 'feature')}, ${plural(r.files.length, 'fichier')} (liste indicative)`]
  if (r.features.length) {
    L.push('Features :')
    for (const { id } of r.features) {
      const f = graph.features[id]!
      const fr = freshness(graph, f)
      L.push(`- ${id}${f.titre !== id ? ` : ${f.titre}` : ''} · ${plural(f.fichiers.length, 'fichier')}, ≈ ${fmt(ficheTok(graph, f))} · ${freshWord(fr)} · confiance ${conf(fr.confiance)}`)
    }
  }
  if (r.files.length) {
    L.push('Fichiers :')
    for (const { p } of r.files) {
      const n = graph.fichiers[p]!
      const fiches = ficheOf.get(p)
      L.push(`- ${p} · ${n.k} · ${fmt(n.tok)}${n.sum ? ` · ${n.sum}` : ''}${fiches ? ` · fiche ${fiches.join(', ')}` : ''}`)
    }
  }
  const m = matchRequest(graph, query)
  if (m) L.push(`→ La fiche « ${m.id} » ressort nettement : action feature, id « ${m.id} ».`)
  return capLines(L, 2500)
}

const IN_LABEL: Record<string, string> = {
  importe: 'importé par',
  rend: 'rendu par',
  utilise: 'utilisé par',
  appelle: 'appelé par',
  sert: 'servi par',
  garde: 'gardé par',
  teste: 'testé par',
  documente: 'documenté par',
}
const outLabel = (k: string) => k.split('/').join(' › ')
const inLabel = (k: string) =>
  k
    .split('/')
    .map(x => IN_LABEL[x] ?? x)
    .join(' › ')

/** Réponse de l'action « voisins » : ce que le fichier utilise, qui l'utilise, tests, docs et fiches. */
export function neighborsText(graph: Graph, p: string, depth = 1): string {
  const key = resolveKey(graph, p)
  if (!key) return `« ${clip(p, 200)} » n'est pas dans le graphe de ${graph.projet.cle} (exclu, inconnu ou ambigu). Donne le chemin relatif au projet.`
  const nb = neighbors(graph, key, Math.min(2, Math.max(1, Math.round(depth) || 1)))
  const n = graph.fichiers[key]
  const node = graph.noeuds[key]
  const desc = n ? `${n.k}, ${fmt(n.tok)}` : node ? `${node.k}${node.def ? `, déclaré dans ${node.def}` : ''}` : ''
  const item = (t: string) => {
    const f = graph.fichiers[t]
    return f ? `${t} (${fmt(f.tok)})` : t
  }
  const list = (arr: string[]) => arr.slice(0, 20).map(item).join(', ') + (arr.length > 20 ? ` … et ${arr.length - 20} autres` : '')
  const L = [
    graph.projet.dart
      ? `Voisins de ${key} (${desc}) — liste indicative : imports package:${graph.projet.dart}/ et relatifs résolus ; fichiers générés (*.g.dart, *.freezed.dart) exclus, providers lus par ref.watch non vus.`
      : `Voisins de ${key} (${desc}) — liste indicative : imports, auto-imports Nuxt, Vuex par chaîne et balises résolus ; <component :is>, provide/inject et apollo: {} non vus.`,
  ]
  if (n?.exp?.length) L.push(`Exporte : ${n.exp.slice(0, 15).join(', ')}${n.exp.length > 15 ? '…' : ''}`)
  if (n?.sum) L.push(`Résumé : ${n.sum}`)
  const outs = Object.entries(nb.out)
  L.push(outs.length ? 'Utilise :' : 'Utilise : rien de connu.')
  for (const [k, arr] of outs) L.push(`  ${outLabel(k)} : ${list(arr)}`)
  const ins = Object.entries(nb.in).filter(([k]) => k !== 'teste' && k !== 'documente')
  L.push(ins.length ? 'Utilisé par :' : 'Utilisé par : personne de connu.')
  for (const [k, arr] of ins) L.push(`  ${inLabel(k)} : ${list(arr)}`)
  if (nb.tests.length) L.push(`Tests : ${list(nb.tests)}`)
  if (nb.docs.length) L.push(`Docs : ${list(nb.docs)}`)
  const fiches = Object.values(graph.features).flatMap(f => f.fichiers.filter(x => x.p === key).map(x => `${f.id} (${x.role})`))
  if (fiches.length) L.push(`Fiches : ${fiches.join(', ')}`)
  return capLines(L, 2500)
}

/** Le texte de /revo-flow cache : ≤ 60 lignes (gabarit docs/rd-graphe-cache/ui.md §5). */
export function graphText(graph: Graph, stats: CacheStats | null): string {
  const s = stats ?? computeStats(graph, null, graph.projet.nom)!
  const p = graph.projet
  const edges: Record<string, number> = {}
  for (const n of [...Object.values(graph.fichiers), ...Object.values(graph.noeuds)])
    for (const [k, list] of Object.entries(n.out ?? {})) edges[k] = (edges[k] ?? 0) + (list?.length ?? 0)
  const total = Object.values(edges).reduce((a, b) => a + b, 0)
  const count = (k: GraphNode['k']) => Object.values(graph.noeuds).filter(n => n.k === k).length
  const feats = Object.values(graph.features)
    .map(f => ({ f, fr: freshness(graph, f) }))
    .sort((a, b) => b.f.usages.servie - a.f.usages.servie || a.f.id.localeCompare(b.f.id))
  const cands = graph.candidates.filter(c => !graph.features[c.id])
  const L: string[] = [
    `Graphe de cache · ${p.nom} (${p.cle}) : ${s.fichiers} fichiers · ${total} arêtes · ${count('route')} routes · ${plural(feats.length, 'fiche')}${s.perimees ? `, ${s.perimees} périmée${s.perimees > 1 ? 's' : ''}` : ''}`,
    `Indexé ${p.indexe.commit.slice(0, 8)}${p.indexe.branche ? ` (${p.indexe.branche})` : ''} le ${dateFr(p.indexe.le, true)} · ≈ ${fmt(p.indexe.tok)} tokens · stack : ${p.stack}`,
    `Fichiers : ${Object.entries(s.parType)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`)
      .join(' · ')}`,
    `Arêtes : ${EDGE_ORDER.filter(k => edges[k])
      .map(k => `${k} ${edges[k]}`)
      .join(' · ')} · ${count('gql')} opérations GraphQL · ${count('api')} endpoints`,
  ]
  const foot: string[] = []
  if (cands.length) {
    foot.push(`Candidates sans fiche (${cands.length}) :`)
    for (const c of cands.slice(0, 8))
      foot.push(`  ${c.id} · ${c.commits} commits · ${c.fichiers} fichiers · ≈ ${fmt(c.tok)} tokens · ≈ ${euros(buildCostUsd(c.tok))} à construire${c.note ? ` · ${c.note}` : ''}`)
    if (cands.length > 8) foot.push(`  … et ${cands.length - 8} autres (/revo-flow cache build)`)
  }
  foot.push(`Gains · ${plural(s.cumul.flows, 'flow')} · ≈ ${fmt(s.cumul.evites)} tokens évités · net ≈ ${signed(s.cumul.net)}`)
  if (s.flow.injecte || s.flow.evites)
    foot.push(`Flow en cours · injecté ${fmt(s.flow.injecte)} · ≈ ${fmt(s.flow.evites)} évités · net ${signed(s.flow.net)} · complétude ${pct(s.flow.completude)}`)
  if (!feats.length) L.push("Features : aucune fiche pour l'instant (apprises en fin de flow, ou /revo-flow cache build <feature>).")
  else {
    L.push(`Features (${feats.length})`)
    const room = 60 - L.length - foot.length - 1
    let used = 0
    let shown = 0
    for (const { f, fr } of feats) {
      const lines = [
        `  ${f.id}${f.titre !== f.id ? ` : ${clip(f.titre, 60)}` : ''} · ${plural(f.fichiers.length, 'fichier')}, ≈ ${fmt(ficheTok(graph, f))} · ${freshWord(fr)} · confiance ${conf(fr.confiance)} · servie ${f.usages.servie}×${f.usages.evites ? ` · ≈ ${fmt(f.usages.evites)} évités` : ''}`,
        ...(fr.perimes.length ? [`    ⚠ modifiés : ${fr.perimes.slice(0, 4).join(', ')}${fr.perimes.length > 4 ? ` … +${fr.perimes.length - 4}` : ''}`] : []),
      ]
      if (used + lines.length > room) break
      L.push(...lines)
      used += lines.length
      shown++
    }
    if (shown < feats.length) L.push(`  … et ${feats.length - shown} autres fiches`)
  }
  return [...L, ...foot].slice(0, 60).join('\n')
}

/** Les candidates (scopes des commits) avec leur coût de construction estimé. */
export function candidatesText(graph: Graph): string {
  const cle = graph.projet.cle
  if (!graph.candidates.length)
    return `Aucune candidate pour ${cle} : il faut l'historique git avec des commits conventionnels à scope (« feat(panier): … »).`
  const L = [`Candidates de ${cle} (scopes des derniers commits, sans LLM) :`]
  for (const c of graph.candidates) {
    const f = graph.features[c.id]
    const state = f ? `fiche ${freshWord(freshness(graph, f))}` : `≈ ${euros(buildCostUsd(c.tok))} à construire`
    L.push(`- ${c.id} · ${c.commits} commits · ${c.fichiers} fichiers · ≈ ${fmt(c.tok)} tokens · ${state}${c.note ? ` · ${c.note}` : ''}`)
  }
  L.push('/revo-flow cache build <feature> construit une fiche (sous-agent en arrière-plan) ; mieux : laisser les flows les apprendre.')
  return capLines(L, 2500)
}