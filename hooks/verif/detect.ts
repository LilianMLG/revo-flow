// Détection des commandes de vérification d'un projet (docs/rd-v2/conception.md §6) : la CI d'abord, puis les scripts de package.json,
// puis les outils présents. Pur : les manifestes lus viennent de l'appelant (chemin → texte, undefined = absent).
// Rien de ce qui est proposé n'écrit : jamais lint:fix, format --write, -u ni build ; les formats machine sont préférés (JSON, machine).
import type { ProjetVerif, VerifCommande, VerifOutil, VerifPortee, VerifSource } from '../../types/verif'
import { FICHIERS, norm, toolOf } from './scope'

/** Chemins relatifs à lire s'ils existent ; leur hash git est gardé dans projet.verif.manifestes (un hash changé redemande la confirmation). */
export const MANIFESTES: string[] = [
  'package.json',
  'pubspec.yaml',
  '.gitlab-ci.yml',
  'lefthook.yml',
  'lefthook.yaml',
  'biome.json',
  'biome.jsonc',
  'tsconfig.json',
  'analysis_options.yaml',
  '.fvm/fvm_config.json',
  '.fvmrc',
  'melos.yaml',
  'build.yaml',
  'env.test',
]

/**
 * Chemins dont seule la présence compte (pièges d'environnement), jamais hachés : à passer dans `sondes` de detectCommands (chemin → existe).
 * node_modules : l'un des quatre suffit ; .dart_tool : `flutter pub get` fait.
 */
export const SONDES: string[] = ['node_modules/.package-lock.json', 'node_modules/.yarn-integrity', 'node_modules/.modules.yaml', 'node_modules/.yarn-state.yml', '.dart_tool/package_config.json']

/** Paquets de monorepo lus au plus. */
const MAX_PAQUETS = 40
/** Profondeur de scripts suivis (npm run a → npm run b → …). */
const MAX_DEPTH = 4

/** MANIFESTES, plus ceux des paquets d'un monorepo (packages/x/pubspec.yaml et son env.test, packages/x/package.json) et les workflows GitHub présents. */
export function manifestPaths(files: string[]): string[] {
  const out = new Set(MANIFESTES)
  let paquets = 0
  for (const f of files.map(norm).sort()) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)) out.add(f)
    if (paquets >= MAX_PAQUETS || /(^|\/)(node_modules|\.dart_tool|build|example|ios|android|macos|windows|linux|web)\//.test(f)) continue
    const dart = /^((?:[^/]+\/){1,3})pubspec\.yaml$/.exec(f)
    if (dart) {
      out.add(f)
      out.add(`${dart[1]}env.test`)
      paquets++
    } else if (/^(packages|apps|libs|modules|services)\/[^/]+\/package\.json$/.test(f)) {
      out.add(f)
      paquets++
    }
  }
  return [...out]
}

// ── Lecture des manifestes ────────────────────────────────────────────────

type Pkg = { scripts: Record<string, string>; deps: Record<string, string>; eslintConfig: boolean }

function readPkg(text: string | undefined): Pkg | undefined {
  if (text === undefined) return undefined
  try {
    const j = JSON.parse(text) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; eslintConfig?: unknown }
    const scripts: Record<string, string> = {}
    for (const [k, v] of Object.entries(j.scripts ?? {})) if (typeof v === 'string') scripts[k] = v
    return { scripts, deps: { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }, eslintConfig: j.eslintConfig !== undefined }
  } catch {
    return { scripts: {}, deps: {}, eslintConfig: false }
  }
}

/** La version de Flutter attendue par .fvm (fvm_config.json : flutterSdkVersion ; .fvmrc : flutter), ou undefined. */
export function fvmVersion(read: Record<string, string | undefined>): string | undefined {
  for (const [p, k] of [
    ['.fvmrc', 'flutter'],
    ['.fvm/fvm_config.json', 'flutterSdkVersion'],
  ] as const) {
    try {
      const v = (JSON.parse(read[p] ?? 'null') as Record<string, unknown> | null)?.[k]
      if (typeof v === 'string' && v) return v
    } catch {
      // manifeste illisible : on passe au suivant
    }
  }
  return undefined
}

/**
 * Le piège de version : la sortie de `flutter --version` (texte ou --machine) comparée à la version .fvm ; undefined si elles concordent ou
 * si la version du poste est illisible.
 */
export function flutterVersionTrap(attendue: string | undefined, sortie: string): string | undefined {
  if (!attendue) return undefined
  const m = /"frameworkVersion"\s*:\s*"([^"]+)"/.exec(sortie) ?? /Flutter\s+(\d+\.\d+\.\d+[^\s•]*)/.exec(sortie)
  if (!m || m[1] === attendue) return undefined
  return `Flutter ${m[1]} sur ce poste, ${attendue} attendu par .fvm : les résultats peuvent différer de la CI`
}

// ── Lecture des lignes de commande (CI, scripts) ──────────────────────────

type Kind =
  | 'eslint'
  | 'biome'
  | 'prettier'
  | 'tsc'
  | 'vue-tsc'
  | 'nuxi'
  | 'vitest'
  | 'jest'
  | 'dart-analyze'
  | 'dart-format'
  | 'flutter-test'
  | 'dart-test'
  | 'build-runner'
  | 'codegen'
/** Un appel d'outil trouvé : toks = arguments après l'outil ; script = le script qui l'appelle directement. */
type Hit = { kind: Kind; toks: string[]; source: VerifSource; origine: string; script?: string; flutterAnalyze?: boolean; envs: string[] }

/** Une ligne en jetons, guillemets simples ou doubles retirés. */
function tokens(s: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]!)
  return out
}

/** Options qui écrivent ou qui attendent (watch, ui) : un appel qui en porte une n'est jamais retenu. */
const ECRIT = new Set(['--fix', '--write', '--apply', '--apply-unsafe', '--unsafe', '-w', '--watch', '--watchAll', 'watch', 'dev', 'bench', '--ui', '-u', '--update', '--updateSnapshot', '--build', '-b'])

type Ctx = { scripts: Record<string, string>; melos?: string }

/** Le script `name` de melos.yaml (valeur en ligne ou clé run: du bloc), ou undefined. */
function melosScript(text: string, name: string): string | undefined {
  const lines = text.split(/\r?\n/)
  const i = lines.findIndex(l => new RegExp(`^\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(l))
  if (i < 0) return undefined
  const inline = lines[i]!.replace(/^[^:]+:\s*/, '').trim()
  if (inline && inline !== '|' && inline !== '>') return inline.replace(/^['"]|['"]$/g, '')
  const indent = /^\s*/.exec(lines[i]!)![0].length
  for (let j = i + 1; j < lines.length && (/^\s*$/.test(lines[j]!) || /^\s*/.exec(lines[j]!)![0].length > indent); j++) {
    const m = /^\s*run\s*:\s*(.*)$/.exec(lines[j]!)
    if (m) return m[1]!.replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

/** Un segment de commande (sans &&, ;, |) : l'outil qu'il appelle, ou le script qu'il délègue. */
function scanSegment(seg: string, origine: string, source: VerifSource, ctx: Ctx, depth: number, script: string | undefined, out: Hit[], herite: string[]) {
  let t = tokens(seg)
  const envs = [...herite]
  // Enveloppes : variables d'environnement, npx, pnpm exec, yarn exec, cross-env, dotenv, fvm, time, chemins node_modules/.bin.
  for (;;) {
    const a = t[0]
    if (a === undefined) return
    if (/^[A-Z_][A-Z0-9_]*=/.test(a)) {
      envs.push(a)
      t = t.slice(1)
    } else if (a === 'npx' || a === 'bunx' || a === 'fvm' || a === 'time' || a === 'exec' || a === '--yes' || a === '-y' || a === '--no-install') t = t.slice(1)
    else if ((a === 'pnpm' || a === 'yarn' || a === 'npm') && (t[1] === 'exec' || t[1] === 'dlx')) t = t.slice(t[2] === '--' ? 3 : 2)
    else if (a === 'cross-env') {
      t = t.slice(1)
      while (t[0] && /^[A-Z_][A-Z0-9_]*=/.test(t[0])) {
        envs.push(t[0])
        t = t.slice(1)
      }
    } else if (a === 'dotenv' || a === 'env-cmd') {
      const i = t.indexOf('--')
      t = i < 0 ? t.slice(1) : t.slice(i + 1)
    } else if (/(^|\/)node_modules\/\.bin\//.test(a)) t = [a.replace(/^.*\/node_modules\/\.bin\//, ''), ...t.slice(1)]
    else break
  }
  const [a, b, c] = t
  const rest = (n: number) => t.slice(n)
  // Délégation à un script de package.json ou de melos.yaml.
  let delegue: string | undefined
  if (a === 'npm' && (b === 'run' || b === 'run-script') && c) delegue = c
  else if (a === 'npm' && (b === 'test' || b === 't')) delegue = 'test'
  else if ((a === 'yarn' || a === 'pnpm') && b === 'run' && c) delegue = c
  else if ((a === 'yarn' || a === 'pnpm') && b && (b === 'test' || ctx.scripts[b] !== undefined)) delegue = b
  if (delegue !== undefined) {
    const corps = ctx.scripts[delegue]
    if (corps !== undefined && depth < MAX_DEPTH && scriptAllowed(delegue))
      scanLine(corps, source === 'ci' ? `${origine} (script ${delegue})` : `script ${delegue}`, source, ctx, depth + 1, delegue, out, envs)
    return
  }
  if (a === 'melos' && ctx.melos !== undefined && depth < MAX_DEPTH) {
    const name = b === 'run' ? c : b
    const corps = name ? melosScript(ctx.melos, name) : undefined
    if (corps !== undefined) scanLine(corps.replace(/^melos exec\s+(?:--\s+)?/, ''), `${origine} (melos ${name})`, source, ctx, depth + 1, script, out, envs)
    return
  }
  if (rest(1).some(x => ECRIT.has(x))) return
  const hit = (kind: Kind, toks: string[], extra: Partial<Hit> = {}) => out.push({ kind, toks, source, origine, script, envs, ...extra })
  switch (a) {
    case 'eslint':
      return hit('eslint', rest(1))
    case 'biome':
      if (b === 'check' || b === 'ci' || b === 'lint' || b === 'format') hit('biome', rest(2))
      return
    case 'prettier':
      if (rest(1).some(x => x === '--check' || x === '-c' || x === '--list-different' || x === '-l')) hit('prettier', rest(1))
      return
    case 'tsc':
      if (rest(1).some(x => /^--noEmit(=true)?$/i.test(x))) hit('tsc', rest(1))
      return
    case 'vue-tsc':
      if (rest(1).some(x => /^--noEmit(=true)?$/i.test(x))) hit('vue-tsc', rest(1))
      return
    case 'nuxi':
    case 'nuxt':
      if (b === 'typecheck') hit('nuxi', rest(2))
      return
    case 'vitest':
      return hit('vitest', rest(1))
    case 'jest':
      return hit('jest', rest(1))
    case 'graphql-codegen':
    case 'gql-gen':
      return hit('codegen', rest(1))
    case 'dart':
      if (b === 'analyze') hit('dart-analyze', rest(2))
      else if (b === 'format' && rest(2).includes('--set-exit-if-changed')) hit('dart-format', rest(2))
      else if (b === 'test' && !rest(2).some(x => x.includes('integration_test'))) hit('dart-test', rest(2))
      else if (b === 'run' && c === 'build_runner') hit('build-runner', rest(3))
      return
    case 'flutter':
      if (b === 'analyze') hit('dart-analyze', rest(2), { flutterAnalyze: true })
      else if (b === 'test' && !rest(2).some(x => x.includes('integration_test'))) hit('flutter-test', rest(2))
      else if (b === 'pub' && c === 'run' && t[3] === 'build_runner') hit('build-runner', rest(4))
      return
  }
}

/** Une ligne ou un script entier : segments séparés par &&, ||, ; ou |. */
function scanLine(line: string, origine: string, source: VerifSource, ctx: Ctx, depth: number, script: string | undefined, out: Hit[], envs: string[] = []) {
  for (const seg of line.split(/\s*(?:&&|\|\||;|\|)\s*/)) scanSegment(seg.trim(), origine, source, ctx, depth, script, out, envs)
}

/** Un fichier de CI (GitLab, GitHub, lefthook) lu comme texte : chaque ligne non commentée, préfixes YAML retirés. */
function scanCi(text: string, origine: string, ctx: Ctx, out: Hit[]) {
  for (const raw of text.split(/\r?\n/)) {
    let l = raw.trim()
    if (!l || l.startsWith('#')) continue
    while (l.startsWith('- ')) l = l.slice(2).trim()
    l = l.replace(/^(run|script|command|cmd)\s*:\s*/, '').replace(/^\|\s*$/, '')
    l = l.replace(/^(['"])(.*)\1$/, '$2')
    if (l) scanLine(l, origine, 'ci', ctx, 0, undefined, out)
  }
}

/** Les scripts jamais suivis : build, démarrage, déploiement, e2e, correction, formatage qui écrit. */
function scriptAllowed(name: string): boolean {
  if (/codegen|gql|graphql/.test(name) && !/watch/.test(name)) return true
  return (
    !/(^|:)(build|start|dev|serve|preview|deploy|generate|release|prepare|postinstall|prepublish\w*|storybook|docs)(:|$)/.test(name) &&
    !/fix|e2e|watch|coverage|playwright|cypress|sandbox|integration/.test(name)
  )
}

// ── Construction des commandes ────────────────────────────────────────────

/** Options gardées d'un appel trouvé, par outil ; true = l'option prend une valeur (forme séparée). Une clé finie par « . » est un préfixe. */
const GARDER: Record<string, Record<string, boolean>> = {
  eslint: { '-c': true, '--config': true, '--ignore-path': true, '--resolve-plugins-relative-to': true, '--rulesdir': true, '--no-eslintrc': false, '--ext': true, '--max-warnings': true },
  biome: { '--config-path': true },
  prettier: { '--config': true, '--ignore-path': true },
  tsc: { '-p': true, '--project': true },
  vitest: {
    '-c': true,
    '--config': true,
    '--root': true,
    '--dir': true,
    '--project': true,
    '--environment': true,
    '--exclude': true,
    '--pool': true,
    '--no-file-parallelism': false,
    '--poolOptions.': false,
    '--sequence.': false,
    '--maxWorkers': true,
    '--minWorkers': true,
  },
  jest: { '-c': true, '--config': true, '-i': false, '--runInBand': false, '--maxWorkers': true, '--testPathIgnorePatterns': true, '--selectProjects': true, '--rootDir': true },
  dart: { '--fatal-infos': false, '--no-fatal-infos': false, '--fatal-warnings': false, '--no-fatal-warnings': false },
  flutter: { '--dart-define-from-file': true, '--dart-define': true, '--exclude-tags': true, '-x': true, '--tags': true, '-t': true },
  codegen: { '-c': true, '--config': true },
}

function keep(toks: string[], spec: Record<string, boolean>): string[] {
  const out: string[] = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t
    const prefixe = Object.keys(spec).some(k => k.endsWith('.') && name.startsWith(k))
    if (prefixe) out.push(t)
    else if (spec[name] !== undefined) {
      out.push(t)
      if (spec[name] && !t.includes('=') && toks[i + 1] !== undefined) out.push(toks[++i]!)
    }
  }
  return out
}

const valueOf = (argv: string[], flag: string): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!
    if (t === flag) return argv[i + 1]
    if (t.startsWith(`${flag}=`)) return t.slice(flag.length + 1)
  }
  return undefined
}

const ORDRE: VerifOutil[] = ['generation', 'format', 'lint', 'typage', 'tests']

/**
 * Les commandes du projet et les pièges d'environnement. Ordre de confiance : CI (lignes qui appellent un outil ou un script connu),
 * scripts de package.json, outils présents (« déduit »). `sondes` : chemin de SONDES → existe (facultatif ; sans lui, aucun piège de dossier).
 */
export function detectCommands(input: { stack: string; files: string[]; read: Record<string, string | undefined>; sondes?: Record<string, boolean> }): {
  commandes: VerifCommande[]
  pieges: string[]
} {
  const files = input.files.map(norm)
  const fileSet = new Set(files)
  const read = input.read
  const present = (p: string) => fileSet.has(p) || read[p] !== undefined
  const pkg = readPkg(read['package.json'])
  const pubspecs = Object.entries(read).filter(([p, t]) => t !== undefined && (p === 'pubspec.yaml' || p.endsWith('/pubspec.yaml'))) as [string, string][]
  const dartProjet = pubspecs.length > 0 || files.some(f => f === 'pubspec.yaml' || f.endsWith('/pubspec.yaml')) || /\b(Flutter|Dart)\b/.test(input.stack)
  const flutter = pubspecs.some(([, t]) => /^[ \t]+flutter[ \t]*:/m.test(t)) || /\bFlutter\b/.test(input.stack)
  const ctx: Ctx = { scripts: pkg?.scripts ?? {}, melos: read['melos.yaml'] }
  const pieges: string[] = []

  // 1. CI, 2. scripts.
  const hits: Hit[] = []
  const ci = Object.keys(read)
    .filter(p => read[p] !== undefined && (p === '.gitlab-ci.yml' || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || /^lefthook\.ya?ml$/.test(p)))
    .sort()
  for (const p of ci) scanCi(read[p]!, p, ctx, hits)
  for (const [name, corps] of Object.entries(ctx.scripts)) if (scriptAllowed(name)) scanLine(corps, `script ${name}`, 'script', ctx, 0, name, hits)
  const best = (...kinds: Kind[]): Hit | undefined => hits.find(h => h.source === 'ci' && kinds.includes(h.kind)) ?? hits.find(h => kinds.includes(h.kind))

  const commandes: VerifCommande[] = []
  const add = (c: Omit<VerifCommande, 'source'> & { source?: VerifSource }) => commandes.push({ source: 'deduit', ...c } as VerifCommande)
  const from = (h: Hit | undefined, origine: string) => (h ? { source: h.source, origine: h.origine } : { source: 'deduit' as const, origine })

  // ── JavaScript / TypeScript ──
  if (pkg) {
    const has = (n: string) => typeof pkg.deps[n] === 'string'
    const flat = files.some(f => /^eslint\.config\.(js|mjs|cjs|ts|mts|cts)$/.test(f))
    const eslintCfg = flat || pkg.eslintConfig || files.some(f => /^\.eslintrc(\.(js|cjs|json|ya?ml))?$/.test(f))
    const nuxt3 = /\bNuxt 3\b/.test(input.stack) || /^[\^~]?3/.test(pkg.deps.nuxt ?? '') || has('nuxt3')
    const nuxt2 = /\bNuxt 2\b/.test(input.stack) || /^[\^~]?2/.test(pkg.deps.nuxt ?? '')
    const tsconfig = present('tsconfig.json')

    // Lint : ESLint et Biome (les deux s'ils sont là).
    const hEslint = best('eslint')
    if (hEslint || has('eslint') || eslintCfg) {
      let opts = hEslint ? keep(hEslint.toks, GARDER.eslint!) : []
      if (flat) opts = opts.filter((t, i) => t !== '--ext' && !t.startsWith('--ext=') && opts[i - 1] !== '--ext')
      else if (!opts.some(t => t === '--ext' || t.startsWith('--ext='))) {
        // ESLint 8 sans config plate ne lit que les .js d'un dossier : la base de référence (portée projet) a besoin de --ext.
        const exts = ['.js', '.jsx', '.ts', '.tsx', '.vue'].filter(e => files.some(f => f.endsWith(e) && !f.startsWith('node_modules/')))
        if (exts.length > 1 || (exts.length === 1 && exts[0] !== '.js')) opts.push('--ext', exts.join(','))
      }
      add({ id: 'eslint', outil: 'lint', argv: ['npx', 'eslint', '-f', 'json', ...opts, FICHIERS], portee: 'fichiers', format: 'eslint-json', ...from(hEslint, eslintCfg ? 'config ESLint' : 'eslint (dépendances)') })
    }
    const hBiome = best('biome')
    if (hBiome || has('@biomejs/biome') || present('biome.json') || present('biome.jsonc')) {
      add({ id: 'biome', outil: 'lint', argv: ['npx', 'biome', 'check', ...(hBiome ? keep(hBiome.toks, GARDER.biome!) : []), FICHIERS], portee: 'fichiers', format: 'biome', ...from(hBiome, 'biome.json') })
    }
    // Prettier : seulement si la CI le lance (un script de formatage peut écrire).
    const hPrettier = hits.find(h => h.source === 'ci' && h.kind === 'prettier')
    if (hPrettier)
      add({ id: 'prettier', outil: 'format', argv: ['npx', 'prettier', '--check', ...keep(hPrettier.toks, GARDER.prettier!), FICHIERS], portee: 'fichiers', format: 'texte', ...from(hPrettier, '') })

    // Typage : une seule commande, portée projet (nuxi typecheck > vue-tsc > tsc).
    const hType = best('nuxi', 'vue-tsc', 'tsc')
    if (hType?.kind === 'nuxi') add({ id: 'typecheck', outil: 'typage', argv: ['npx', 'nuxi', 'typecheck'], portee: 'projet', format: 'tsc', ...from(hType, '') })
    else if (hType)
      add({ id: 'typecheck', outil: 'typage', argv: ['npx', hType.kind, '--noEmit', ...keep(hType.toks, GARDER.tsc!)], portee: 'projet', format: 'tsc', ...from(hType, '') })
    else if (nuxt3 && (has('typescript') || has('vue-tsc') || tsconfig))
      add({ id: 'typecheck', outil: 'typage', argv: ['npx', 'nuxi', 'typecheck'], portee: 'projet', format: 'tsc', origine: 'Nuxt 3' })
    else if (!nuxt2 && tsconfig && has('typescript'))
      add({
        id: 'typecheck',
        outil: 'typage',
        argv: has('vue-tsc') ? ['npx', 'vue-tsc', '--noEmit'] : ['npx', 'tsc', '--noEmit', '-p', 'tsconfig.json'],
        portee: 'projet',
        format: 'tsc',
        origine: 'tsconfig.json',
      })

    // Tests liés : vitest related ou jest --findRelatedTests.
    const hTest = best('vitest', 'jest')
    const testeur = hTest?.kind ?? (has('vitest') ? 'vitest' : has('jest') || files.some(f => /^jest\.config\.(js|cjs|mjs|ts|json)$/.test(f)) ? 'jest' : undefined)
    const architect = has('@architect/architect') || has('@architect/functions') || present('app.arc') || present('arc.json')
    const exclus: string[] = []
    if (architect) {
      // Tests qui demandent le sandbox Architect : exclus par défaut (§6.2), à confirmer avec la liste.
      for (const f of files.filter(f => /sandbox/i.test(f) && /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f))) {
        const seg = f.split('/').slice(0, -1).find(s => /sandbox/i.test(s))
        const g = seg ? `**/${seg}/**` : '**/*sandbox*'
        if (!exclus.includes(g)) exclus.push(g)
      }
    }
    if (testeur === 'vitest')
      add({
        id: 'vitest',
        outil: 'tests',
        argv: ['npx', 'vitest', 'related', '--run', '--reporter=json', '--passWithNoTests', ...(hTest ? keep(hTest.toks, GARDER.vitest!) : []), FICHIERS],
        portee: 'lies',
        format: 'vitest-json',
        ...from(hTest, 'vitest (dépendances)'),
        ...(exclus.length ? { exclus } : {}),
      })
    else if (testeur === 'jest')
      add({
        id: 'jest',
        outil: 'tests',
        argv: ['npx', 'jest', '--json', '--passWithNoTests', ...(hTest ? keep(hTest.toks, GARDER.jest!) : []), '--findRelatedTests', FICHIERS],
        portee: 'lies',
        format: 'jest-json',
        ...from(hTest, 'jest (dépendances)'),
        ...(exclus.length ? { exclus } : {}),
      })

    // Générateur GraphQL : déclenché par un .graphql modifié, avant le typage.
    const hGen = best('codegen')
    if (hGen?.script)
      add({ id: 'codegen', outil: 'generation', argv: ['npm', 'run', hGen.script], portee: 'projet', format: 'texte', declencheur: '**/*.{graphql,gql}', source: hGen.source, origine: hGen.origine })
    else if (hGen)
      add({ id: 'codegen', outil: 'generation', argv: ['npx', 'graphql-codegen', ...keep(hGen.toks, GARDER.codegen!)], portee: 'projet', format: 'texte', declencheur: '**/*.{graphql,gql}', source: hGen.source, origine: hGen.origine })

    // Pièges JS.
    const nm = SONDES.filter(p => p.startsWith('node_modules/'))
    if (input.sondes && nm.some(p => p in input.sondes!) && !nm.some(p => input.sondes![p]) && !fileSet.has('.pnp.cjs'))
      pieges.push('node_modules absent : lancez npm install (ou yarn, pnpm install) avant la vérification, sinon les commandes échouent')
    const envs = [...new Set([hEslint, hBiome, hType, hTest].flatMap(h => h?.envs ?? []))].filter(e => !/^(CI|FORCE_COLOR)=/.test(e))
    if (envs.length) pieges.push(`les scripts posent ${envs.join(', ')} : les commandes de revo-flow tournent sans`)
  }

  // ── Dart / Flutter ──
  if (dartProjet) {
    const hAnalyze = best('dart-analyze')
    const fatalInfos = hAnalyze ? (hAnalyze.flutterAnalyze ? !hAnalyze.toks.includes('--no-fatal-infos') : hAnalyze.toks.includes('--fatal-infos')) : false
    const hFormat = best('dart-format')
    if (hFormat)
      add({ id: 'dart-format', outil: 'format', argv: ['dart', 'format', '--output=none', '--set-exit-if-changed', FICHIERS], portee: 'fichiers', format: 'texte', ...from(hFormat, '') })
    add({
      id: 'dart-analyze',
      outil: 'typage',
      argv: ['dart', 'analyze', '--format=machine', ...(fatalInfos ? ['--fatal-infos'] : []), FICHIERS],
      portee: 'fichiers',
      format: 'dart-machine',
      ...from(hAnalyze, read['analysis_options.yaml'] !== undefined ? 'analysis_options.yaml' : 'pubspec.yaml'),
    })
    const hTest = best('flutter-test', 'dart-test')
    const aDesTests = files.some(f => f.endsWith('_test.dart') && !/(^|\/)integration_test\//.test(f))
    if (hTest || aDesTests) {
      const viaFlutter = hTest ? hTest.kind === 'flutter-test' : flutter
      let opts = hTest ? keep(hTest.toks, GARDER.flutter!) : []
      const envFile = valueOf(opts, '--dart-define-from-file')
      const envTest = read['env.test'] !== undefined
      if (envFile !== undefined && /(^|\/)env\.test$/.test(envFile) && !envTest) {
        opts = opts.filter((t, i) => t !== '--dart-define-from-file' && !t.startsWith('--dart-define-from-file=') && opts[i - 1] !== '--dart-define-from-file')
        pieges.push(`env.test absent : la CI le passe à flutter test (--dart-define-from-file) ; les tests liés tournent sans`)
      } else if (envFile === undefined && envTest) opts.unshift('--dart-define-from-file=env.test')
      add(
        viaFlutter
          ? { id: 'flutter-test', outil: 'tests', argv: ['flutter', 'test', '--machine', ...opts, FICHIERS], portee: 'lies', format: 'flutter-json', ...from(hTest, 'test/') }
          : { id: 'dart-test', outil: 'tests', argv: ['dart', 'test', '--reporter=json', FICHIERS], portee: 'lies', format: 'flutter-json', ...from(hTest, 'test/') },
      )
    }
    const hGen = best('build-runner')
    if (hGen || pubspecs.some(([, t]) => /^[ \t]+build_runner[ \t]*:/m.test(t)))
      add({
        id: 'build-runner',
        outil: 'generation',
        argv: ['dart', 'run', 'build_runner', 'build', '--delete-conflicting-outputs'],
        portee: 'fichiers',
        format: 'texte',
        declencheur: '**/*.{dart,yaml}',
        ...from(hGen, 'build_runner (pubspec.yaml)'),
      })

    // Pièges Dart.
    const fvm = fvmVersion(read)
    if (fvm) pieges.push(`Flutter ${fvm} attendu par .fvm : vérifiez que le poste a la même version (flutter --version)`)
    if (input.sondes && '.dart_tool/package_config.json' in input.sondes && !input.sondes['.dart_tool/package_config.json'])
      pieges.push('dépendances Dart non récupérées (.dart_tool absent) : lancez flutter pub get avant la vérification')
    const ciRef = ci.some(p => /env\.test/.test(read[p] ?? ''))
    if (ciRef && read['env.test'] === undefined && !pieges.some(p => p.startsWith('env.test absent'))) pieges.push('env.test absent : la CI y fait référence ; les tests qui en dépendent échoueront')
  }

  commandes.sort((a, b) => ORDRE.indexOf(a.outil) - ORDRE.indexOf(b.outil))
  return { commandes, pieges }
}

/** Faut-il (re)demander la confirmation ? Absent, jamais confirmé par l'utilisateur, ou un manifeste ajouté, retiré ou dont le hash a changé. */
export function needsConfirm(verif: ProjetVerif | undefined, hashes: Record<string, string>): boolean {
  if (!verif || !verif.confirme || verif.confirme.par !== 'utilisateur') return true
  const avant = verif.manifestes
  const cles = new Set([...Object.keys(avant), ...Object.keys(hashes)])
  for (const k of cles) if (avant[k] !== hashes[k]) return true
  return false
}

/** Le nom court d'une commande, pour la question, le panneau et le rapport : 'eslint', 'nuxi typecheck', 'vitest related', 'flutter test'… */
export function commandLabel(c: VerifCommande): string {
  const t = toolOf(c.argv)
  const i = c.argv.findIndex(x => x.toLowerCase() === t || x.endsWith(`/${t}`))
  const sub = c.argv[i + 1]
  if (t === 'npm' || t === 'yarn' || t === 'pnpm') return c.argv.slice(i + 1).filter(x => x !== 'run').join(' ') || c.id
  if (t === 'nuxi' || t === 'dart' || t === 'flutter' || (t === 'vitest' && sub === 'related') || t === 'biome') {
    if (t === 'dart' && sub === 'run') return c.argv[i + 2] ?? c.id
    return sub && !sub.startsWith('-') ? `${t} ${sub}` : t
  }
  return t || c.id
}

const PORTEE: Record<VerifPortee, string> = { fichiers: 'fichiers du flow', lies: 'tests liés', projet: 'tout le projet' }

/** La source lisible : « CI (.gitlab-ci.yml) », « script lint », « déduit (biome.json) », « orchestrateur ». */
function sourceLabel(c: VerifCommande): string {
  if (c.source === 'ci') return `CI${c.origine ? ` (${c.origine})` : ''}`
  if (c.source === 'script') return c.origine || 'script'
  if (c.source === 'orchestrateur') return 'orchestrateur'
  return `déduit${c.origine ? ` (${c.origine})` : ''}`
}

/** argv lisible : '{fichiers}' devient '<fichiers>'. */
export const argvText = (argv: string[]) => argv.map(t => (t === FICHIERS ? '<fichiers>' : /\s/.test(t) ? `"${t}"` : t)).join(' ')

/** Le texte de la question de confirmation (§6.4) : chaque commande exacte, sa portée, sa source ; puis les pièges. */
export function commandsQuestion(nom: string, commandes: VerifCommande[], pieges: string[]): string {
  if (!commandes.length) {
    const lignes = [`revo-flow n'a trouvé aucune vérification pour ${nom} (ni CI, ni script lint / typecheck / test, ni outil connu).`]
    if (pieges.length) lignes.push('', 'À savoir :', ...pieges.map(p => `  · ${p}`))
    lignes.push('', 'Continuer sans vérification ?')
    return lignes.join('\n')
  }
  const lignes = [`revo-flow a trouvé ces vérifications pour ${nom} :`]
  for (const c of commandes) {
    const quand = c.declencheur ? `, si un fichier ${c.declencheur.replace(/^\*\*\//, '')} change` : ''
    lignes.push(`  · ${commandLabel(c)} (${PORTEE[c.portee]}${quand}) : ${argvText(c.argv)} · ${sourceLabel(c)}`)
    if (c.exclus?.length) lignes.push(`      tests exclus : ${c.exclus.join(', ')}`)
  }
  if (pieges.length) lignes.push('', 'À savoir :', ...pieges.map(p => `  · ${p}`))
  lignes.push('', 'Les utiliser ?')
  return lignes.join('\n')
}
