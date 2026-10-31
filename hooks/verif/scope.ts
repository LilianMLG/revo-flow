// La portée d'une commande de vérification (docs/rd-v2/conception.md §6.2, §7) : quels fichiers, quels tests liés, dans quel paquet.
// Pur : ni `$`, ni fs. La liste des fichiers du projet, les fichiers du flow et les tests liés du graphe (arêtes `teste`) viennent de l'appelant.
import type { VerifCommande } from '../../types/verif'

/** Un lancement d'une commande : cwd relatif à la racine ('' = racine), argv sans shell, fichiers passés (relatifs à la racine). */
export type Lancement = { id: string; cwd: string; argv: string[]; fichiers: string[] }

/** Le jeton remplacé par les fichiers de la portée. */
export const FICHIERS = '{fichiers}'

/**
 * Le jeton remplacé par le runner, à l'exécution, par le chemin absolu du dossier de sorties du flow
 * (~/.claude/revo-flow/verif/<date>-<flow>) ; il peut être un préfixe (« {sorties}/couverture »). fill le laisse passer tel quel.
 */
export const SORTIES = '{sorties}'

/**
 * Longueur max des fichiers d'un lancement, en caractères : `cmd /c` refuse une ligne de plus de 8 191 caractères sous Windows.
 * Au-delà, la commande est découpée en plusieurs lancements (même id).
 */
const MAX_ARGV = 6000

/** Les exécutables qui sont des .cmd ou des .bat sous Windows : sans shell, il faut `cmd /c` (§6.3). */
const CMD_BINS = new Set(['npx', 'npm', 'yarn', 'pnpm', 'flutter', 'dart', 'fvm', 'melos'])

const JS_EXT = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue']
const BIOME_EXT = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json', '.jsonc']
const PRETTIER_EXT = [...JS_EXT, '.json', '.css', '.scss', '.less', '.html', '.md', '.yaml', '.yml', '.graphql', '.gql']
/** Fichiers Dart générés (build_runner, freezed, auto_route, injectable, mockito…) : jamais passés à l'analyse ni au formatage. */
export const DART_GENERE = /\.(g|freezed|gr|config|mocks|chopper|gen)\.dart$/
/** Dossiers où un package.json imbriqué est un paquet de monorepo ; ailleurs (fonctions Architect, src/http/*) il ne compte pas. */
const JS_PAQUETS = /^(packages|apps|libs|modules|services)\/[^/]+$/

/** Un chemin Windows ou POSIX en chemin à « / », sans « ./ » de tête ni « / » doublé. */
export function norm(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  return s
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const join = (a: string, b: string) => (a ? `${a}/${b}` : b)
const uniq = <T>(xs: T[]) => [...new Set(xs)]

/** Le chemin de `to` vu depuis `from` (deux chemins relatifs à la racine) : 'packages/a' et 'env.test' → '../../env.test'. */
export function relative(from: string, to: string): string {
  const f = from ? from.split('/') : []
  const t = to.split('/')
  let i = 0
  while (i < f.length && i < t.length - 1 && f[i] === t[i]) i++
  return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/')
}

/** Un motif glob en RegExp : `**\/`, `**`, `*`, `?`, `{a,b}`. */
export function globRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end < 0) re += '\\{'
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
          .join('|')})`
        i = end
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** Le chemin correspond-il au motif ? Un motif sans « / » porte sur le nom du fichier seul. */
export function globMatch(glob: string, p: string): boolean {
  const s = norm(p)
  return globRegex(glob).test(glob.includes('/') ? s : baseOf(s))
}

/** L'outil d'un argv, sans les enveloppes : ['cmd', '/c', 'npx', 'eslint', …] → 'eslint' ; ['dart', 'run', 'build_runner'] → 'dart'. */
export function toolOf(argv: string[]): string {
  let i = 0
  while (i < argv.length) {
    const t = (argv[i] ?? '').toLowerCase()
    if (t === 'cmd' || t === '/c' || t === 'npx' || t === 'fvm' || t === '--yes' || t === '-y') i++
    else break
  }
  return baseOf(norm(argv[i] ?? '')).toLowerCase()
}

/** La commande tourne-t-elle sur du Dart (paquet = pubspec.yaml le plus proche) ? */
export function isDart(cmd: VerifCommande): boolean {
  const t = toolOf(cmd.argv)
  return t === 'dart' || t === 'flutter' || cmd.format === 'dart-machine' || cmd.format === 'flutter-json'
}

/** La commande est-elle build_runner (générateur Dart, déclenché par un fichier annoté) ? */
export const isBuildRunner = (argv: string[]) => argv.includes('build_runner')

/** Les extensions que la commande accepte ; undefined = toutes. */
function extensionsOf(cmd: VerifCommande): string[] | undefined {
  const t = toolOf(cmd.argv)
  if (t === 'eslint') return JS_EXT
  if (t === 'biome') return BIOME_EXT
  if (t === 'prettier') return PRETTIER_EXT
  if (t === 'vitest' || t === 'jest') return JS_EXT
  if (isDart(cmd)) return ['.dart']
  return undefined
}

/** Les racines de paquet : '' toujours ; les dossiers d'un pubspec.yaml (Dart) ou d'un package.json de monorepo (JS). */
function packageRoots(files: Iterable<string>, dart: boolean): string[] {
  const out = new Set([''])
  for (const f of files) {
    if (dart && baseOf(f) === 'pubspec.yaml') out.add(dirOf(f))
    if (!dart && baseOf(f) === 'package.json' && JS_PAQUETS.test(dirOf(f))) out.add(dirOf(f))
  }
  return [...out]
}

/** La racine de paquet la plus proche d'un fichier. */
function nearestRoot(p: string, roots: string[]): string {
  let best = ''
  for (const r of roots) if (r && (p === r || p.startsWith(`${r}/`)) && r.length > best.length) best = r
  return best
}

/** Le contenu d'un fichier Dart porte-t-il une annotation qui demande build_runner (@riverpod, @freezed, part '*.g.dart'…) ? Pour `annotes`. */
export function hasGenAnnotation(text: string): boolean {
  return /^\s*part\s+['"][^'"]+\.(g|freezed|gr|config|mocks|chopper|gen)\.dart['"]\s*;/m.test(text) || /@(riverpod|Riverpod|freezed|Freezed|JsonSerializable|injectable|Injectable|RoutePage|HiveType|GenerateMocks)\b/.test(text)
}

/** Le fichier a-t-il un fichier généré à côté (x.dart → x.g.dart, x.freezed.dart…) ? */
function hasGeneratedSibling(p: string, files: Set<string>): boolean {
  const stem = p.replace(/\.dart$/, '')
  return ['g', 'freezed', 'gr', 'config', 'mocks', 'chopper', 'gen'].some(k => files.has(`${stem}.${k}.dart`))
}

/** Un test Dart d'intégration (integration_test/) : jamais dans la porte (lots 3 et 4). */
const isIntegrationTest = (p: string) => /(^|\/)integration_test\//.test(p)

/**
 * Les tests Dart liés aux fichiers du flow : les tests modifiés eux-mêmes, les arêtes `teste` du graphe (testsOf),
 * et la convention lib/a/b.dart → test/a/b_test.dart dans le même paquet (si le test existe).
 */
export function dartTests(changed: string[], known: (p: string) => boolean, roots: string[], testsOf?: (p: string) => string[]): string[] {
  const out: string[] = []
  for (const p of changed) {
    if (!p.endsWith('.dart') || isIntegrationTest(p)) continue
    if (p.endsWith('_test.dart')) {
      out.push(p)
      continue
    }
    for (const t of testsOf?.(p) ?? []) {
      const n = norm(t)
      if (n.endsWith('_test.dart') && !isIntegrationTest(n)) out.push(n)
    }
    const root = nearestRoot(p, roots)
    const rel = root ? p.slice(root.length + 1) : p
    if (rel.startsWith('lib/')) {
      const t = join(root, `test/${rel.slice(4).replace(/\.dart$/, '_test.dart')}`)
      if (known(t)) out.push(t)
    }
  }
  return uniq(out)
}

/** argv dont '{fichiers}' est remplacé ; le chemin de --dart-define-from-file (relatif à la racine) est rendu relatif au cwd. */
function fill(argv: string[], fichiers: string[], cwd: string): string[] {
  return argv.flatMap(t => {
    if (t === FICHIERS) return fichiers
    const m = /^--dart-define-from-file=(.+)$/.exec(t)
    if (m && cwd && !/^([A-Za-z]:)?\//.test(m[1]!)) return [`--dart-define-from-file=${relative(cwd, norm(m[1]!))}`]
    return [t]
  })
}

/** Les arguments d'exclusion de tests (vitest --exclude, jest --testPathIgnorePatterns), insérés avant la liste des fichiers. */
function withExclusions(cmd: VerifCommande): string[] {
  const exclus = cmd.exclus ?? []
  if (!exclus.length) return cmd.argv
  const t = toolOf(cmd.argv)
  const extra =
    t === 'vitest'
      ? exclus.flatMap(g => ['--exclude', g])
      : t === 'jest'
        ? exclus.flatMap(g => ['--testPathIgnorePatterns', globRegex(g).source.replace(/^\^|\$$/g, '').replace(/\\\//g, '/')])
        : []
  if (!extra.length) return cmd.argv
  const argv = [...cmd.argv]
  let i = argv.indexOf(FICHIERS)
  if (i < 0) i = argv.length
  else if (argv[i - 1] === '--findRelatedTests') i--
  argv.splice(i, 0, ...extra)
  return argv
}

/** Découpe une liste de fichiers en paquets d'au plus MAX_ARGV caractères. */
function chunks(fichiers: string[]): string[][] {
  const out: string[][] = []
  let cur: string[] = []
  let len = 0
  for (const f of fichiers) {
    if (cur.length && len + f.length + 1 > MAX_ARGV) {
      out.push(cur)
      cur = []
      len = 0
    }
    cur.push(f)
    len += f.length + 1
  }
  if (cur.length) out.push(cur)
  return out
}

/**
 * Les lancements d'une commande pour le flow : [] si rien à lancer (aucun fichier concerné, déclencheur absent).
 * - projet : un lancement à la racine ;
 * - fichiers : les fichiers du flow que l'outil accepte, par paquet (package.json de monorepo ou pubspec.yaml le plus proche = cwd) ;
 *   sans '{fichiers}' dans argv, un lancement par paquet touché ;
 * - lies : vitest related et jest --findRelatedTests reçoivent les fichiers et trouvent leurs tests ; pour Dart, les tests liés (dartTests).
 * `changed` : fichiers du flow qui existent encore (les supprimés sont à retirer par l'appelant) ; `files` : fichiers du projet ;
 * `annotes` : fichiers du flow dont le contenu porte une annotation générée (hasGenAnnotation), pour build_runner.
 */
export function plan(cmd: VerifCommande, input: { changed: string[]; files: string[]; testsOf?: (p: string) => string[]; annotes?: string[] }): Lancement[] {
  const changed = uniq(input.changed.map(norm).filter(Boolean))
  if (!changed.length) return []
  if (cmd.declencheur && !changed.some(p => globMatch(cmd.declencheur!, p))) return []
  const files = new Set(input.files.map(norm))
  const changedSet = new Set(changed)
  const known = (p: string) => files.has(p) || changedSet.has(p)
  const dart = isDart(cmd)
  const roots = packageRoots([...files, ...changed], dart)

  if (cmd.portee === 'projet') return [{ id: cmd.id, cwd: '', argv: fill(cmd.argv, [], ''), fichiers: [] }]

  let cible: string[]
  if (cmd.outil === 'generation' && isBuildRunner(cmd.argv)) {
    // Déclencheur fin : un .dart du flow à côté d'un fichier généré, ou annoté ; ou pubspec.yaml / build.yaml modifié.
    const annotes = new Set((input.annotes ?? []).map(norm))
    cible = changed.filter(
      p => (p.endsWith('.dart') && !DART_GENERE.test(p) && (hasGeneratedSibling(p, files) || annotes.has(p))) || /(^|\/)(pubspec|build)\.yaml$/.test(p),
    )
  } else if (cmd.portee === 'lies' && dart) {
    cible = dartTests(changed, known, roots, input.testsOf)
    const exclus = cmd.exclus ?? []
    cible = cible.filter(p => !exclus.some(g => globMatch(g, p)))
  } else {
    const ext = extensionsOf(cmd)
    cible = changed.filter(p => (!ext || ext.some(e => p.endsWith(e))) && !(dart && DART_GENERE.test(p)))
  }
  if (!cible.length) return []

  const argv = dart ? cmd.argv : withExclusions(cmd)
  const parPaquet = new Map<string, string[]>()
  for (const p of cible) {
    const r = nearestRoot(p, roots)
    parPaquet.set(r, [...(parPaquet.get(r) ?? []), p])
  }
  const out: Lancement[] = []
  for (const cwd of [...parPaquet.keys()].sort()) {
    const fichiers = parPaquet.get(cwd)!
    if (!argv.includes(FICHIERS)) {
      out.push({ id: cmd.id, cwd, argv: fill(argv, [], cwd), fichiers })
      continue
    }
    for (const lot of chunks(fichiers)) out.push({ id: cmd.id, cwd, argv: fill(argv, lot.map(p => relative(cwd, p)), cwd), fichiers: lot })
  }
  return out
}

/** argv prêt pour $.process.run : sous Windows, `npx`, `npm`, `flutter`, `dart`… passent par `cmd /c` (§6.3). */
export function withShell(argv: string[], os: 'windows' | 'posix'): string[] {
  if (os !== 'windows' || !argv.length) return argv
  if (!CMD_BINS.has(argv[0]!.toLowerCase())) return argv
  return ['cmd', '/c', ...argv]
}
