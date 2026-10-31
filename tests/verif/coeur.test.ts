import { describe, expect, test } from 'claude-code/testing'

import type { ProjetVerif, VerifBase, VerifCommande, VerifErreur, VerifEtatCommande, VerifResultat } from '../../types/verif'
import { MANIFESTES, argvText, commandLabel, commandsQuestion, detectCommands, flutterVersionTrap, fvmVersion, manifestPaths, needsConfirm, withoutCrap } from '../../hooks/verif/detect'
import { dartTests, globMatch, hasGenAnnotation, plan, relative, withShell } from '../../hooks/verif/scope'
import { normalizeMessage, parseOutput, signatureKey, toRoot } from '../../hooks/verif/parse'
import { addBase, baseFor, classify } from '../../hooks/verif/base'
import { reportText, summaryLine } from '../../hooks/verif/report'
import { durationOf, fillSorties, projectArgv, purgeOutputs, runBase, runGate, timeoutOf, type VerifIo } from '../../hooks/verif/runner'
import { OSES, WINDOWS, native, type Os } from '../helpers/os'

const json = (x: unknown) => JSON.stringify(x)
const pkg = (scripts: Record<string, string>, devDependencies: Record<string, string>, dependencies: Record<string, string> = {}) => json({ name: 'app', scripts, dependencies, devDependencies })
const byId = (cs: VerifCommande[], id: string) => cs.find(c => c.id === id)

// ── Détection, par famille ────────────────────────────────────────────────

describe('detectCommands', () => {
  test('Nuxt 3 + Vitest + codegen (reservation-tool) : CI d’abord, puis scripts ; jamais lint:fix ni build', () => {
    const read = {
      'package.json': pkg(
        {
          build: 'nuxt build',
          lint: 'eslint --ext .ts,.js,.vue .',
          'lint:fix': 'eslint --ext .ts,.js,.vue . --fix',
          typecheck: 'nuxi typecheck',
          test: 'vitest',
          codegen: 'graphql-codegen --config codegen.ts',
          format: 'prettier --write .',
        },
        { nuxt: '^3.9.0', vitest: '^1.6.0', eslint: '^8.57.0', typescript: '^5.4.0', '@graphql-codegen/cli': '^5.0.0' },
      ),
      '.gitlab-ci.yml': ['stages: [test]', 'lint:', '  stage: test', '  script:', '    - npm ci', '    - npm run lint', '    - npm run typecheck', '#    - npm run build'].join('\n'),
    }
    const files = ['nuxt.config.ts', '.eslintrc.cjs', 'components/Cart.vue', 'composables/useCart.ts', 'graphql/offers.graphql', 'tests/useCart.spec.ts']
    const { commandes, pieges } = detectCommands({ crap: false, stack: 'Nuxt 3, Pinia, Apollo, TypeScript, vitest', files, read })
    expect(commandes.map(c => c.id)).toEqual(['codegen', 'eslint', 'typecheck', 'vitest'])
    expect(byId(commandes, 'eslint')).toMatchObject({ source: 'ci', portee: 'fichiers', format: 'eslint-json', argv: ['npx', 'eslint', '-f', 'json', '--ext', '.ts,.js,.vue', '{fichiers}'] })
    expect(byId(commandes, 'eslint')!.origine).toBe('.gitlab-ci.yml (script lint)')
    expect(byId(commandes, 'typecheck')).toMatchObject({ source: 'ci', portee: 'projet', format: 'tsc', argv: ['npx', 'nuxi', 'typecheck'] })
    expect(byId(commandes, 'vitest')).toMatchObject({ source: 'script', portee: 'lies', format: 'vitest-json', argv: ['npx', 'vitest', 'related', '--run', '--reporter=json', '--passWithNoTests', '{fichiers}'] })
    expect(byId(commandes, 'codegen')).toMatchObject({ outil: 'generation', argv: ['npm', 'run', 'codegen'], declencheur: '**/*.{graphql,gql}', source: 'script' })
    expect(commandes.some(c => c.argv.includes('--fix') || c.argv.includes('build') || c.argv.includes('--write'))).toBe(false)
    expect(pieges).toEqual([])
  })

  test('Nuxt 3.14 + vue-tsc + config ESLint plate (lumos-front) : pas de --ext', () => {
    const read = { 'package.json': pkg({ lint: 'eslint .', typecheck: 'vue-tsc --noEmit', test: 'vitest run' }, { nuxt: '^3.14.0', 'vue-tsc': '^2.1.0', vitest: '^2.1.0', eslint: '^9.0.0' }) }
    const { commandes } = detectCommands({ crap: false, stack: 'Nuxt 3, vitest', files: ['eslint.config.mjs', 'nuxt.config.ts', 'pages/index.vue'], read })
    expect(byId(commandes, 'eslint')!.argv).toEqual(['npx', 'eslint', '-f', 'json', '{fichiers}'])
    expect(byId(commandes, 'typecheck')).toMatchObject({ source: 'script', origine: 'script typecheck', argv: ['npx', 'vue-tsc', '--noEmit'] })
  })

  test('Nuxt 2 + Jest 27 (back-office) : eslint du script, pas de typage, jest --findRelatedTests en JSON', () => {
    const read = { 'package.json': pkg({ lint: 'eslint --ext .js,.vue --ignore-path .gitignore .', test: 'jest', dev: 'nuxt' }, { nuxt: '^2.15.8', jest: '^27.5.1', eslint: '^7.32.0' }) }
    const { commandes } = detectCommands({ crap: false, stack: 'Nuxt 2, Vuex, Jest', files: ['nuxt.config.js', '.eslintrc.js', 'store/cart.js', 'test/store/cart.spec.js'], read })
    expect(commandes.map(c => c.id)).toEqual(['eslint', 'jest'])
    expect(byId(commandes, 'eslint')!.argv).toEqual(['npx', 'eslint', '-f', 'json', '--ext', '.js,.vue', '--ignore-path', '.gitignore', '{fichiers}'])
    expect(byId(commandes, 'jest')).toMatchObject({ portee: 'lies', format: 'jest-json', argv: ['npx', 'jest', '--json', '--passWithNoTests', '--findRelatedTests', '{fichiers}'] })
  })

  test('NestJS + Jest 29 : lint --fix refusé (eslint déduit), tsc --noEmit déduit, test:e2e et build jamais suivis', () => {
    const read = {
      'package.json': pkg(
        { build: 'nest build', lint: 'eslint "{src,apps,libs,test}/**/*.ts" --fix', test: 'jest', 'test:e2e': 'jest --config ./test/jest-e2e.json' },
        { '@nestjs/cli': '^10.0.0', jest: '^29.7.0', typescript: '^5.1.3', eslint: '^8.42.0' },
        { '@nestjs/core': '^10.0.0' },
      ),
      'tsconfig.json': '{}',
    }
    const { commandes } = detectCommands({ crap: false, stack: 'NestJS, TypeScript, Jest', files: ['src/main.ts', '.eslintrc.js', 'tsconfig.json', 'nest-cli.json'], read })
    expect(byId(commandes, 'eslint')).toMatchObject({ source: 'deduit' })
    expect(byId(commandes, 'typecheck')).toMatchObject({ source: 'deduit', argv: ['npx', 'tsc', '--noEmit', '-p', 'tsconfig.json'] })
    expect(byId(commandes, 'jest')!.argv).not.toContain('./test/jest-e2e.json')
    expect(byId(commandes, 'jest')!.source).toBe('script')
  })

  test('Architect + Vitest + Biome : biome check, tests du sandbox exclus, options séquentielles gardées', () => {
    const read = {
      'package.json': pkg({ lint: 'biome check .', 'lint:fix': 'biome check --write .', test: 'vitest run --no-file-parallelism', 'test:sandbox': 'vitest run test/sandbox' }, { '@architect/architect': '^11.0.0', vitest: '^2.0.0', '@biomejs/biome': '^1.9.0', typescript: '^5.5.0' }),
      'biome.json': '{}',
      'tsconfig.json': '{}',
    }
    const files = ['app.arc', 'biome.json', 'tsconfig.json', 'src/http/get-index/index.ts', 'src/http/get-index/package.json', 'test/unit/index.test.ts', 'test/sandbox/http.test.ts']
    const { commandes } = detectCommands({ crap: false, stack: 'TypeScript, vitest', files, read })
    expect(commandes.map(c => c.id)).toEqual(['biome', 'typecheck', 'vitest'])
    expect(byId(commandes, 'biome')).toMatchObject({ argv: ['npx', 'biome', 'check', '{fichiers}'], format: 'biome', source: 'script' })
    expect(byId(commandes, 'vitest')!.argv).toContain('--no-file-parallelism')
    expect(byId(commandes, 'vitest')!.exclus).toEqual(['**/sandbox/**'])
  })

  test('Flutter, monorepo packages/* (application-mobile-ui) : CI fvm, --fatal-infos, env.test, build_runner, version .fvm', () => {
    const read = {
      'pubspec.yaml': ['name: app', 'dependencies:', '  flutter:', '    sdk: flutter', '  core:', '    path: packages/core', 'dev_dependencies:', '  build_runner: ^2.4.0', '  riverpod_generator: ^2.4.0'].join('\n'),
      'packages/core/pubspec.yaml': ['name: core', 'dependencies:', '  flutter:', '    sdk: flutter'].join('\n'),
      '.fvm/fvm_config.json': json({ flutterSdkVersion: '3.44.6', flavors: {} }),
      'env.test': 'API_URL=http://localhost',
      '.gitlab-ci.yml': ['analyze:', '  script:', '    - fvm flutter pub get', '    - fvm flutter analyze', '    - dart format --output=none --set-exit-if-changed lib test', 'test:', '  script:', '    - fvm flutter test --dart-define-from-file=env.test --coverage'].join('\r\n'),
    }
    const files = ['pubspec.yaml', 'lib/main.dart', 'test/main_test.dart', 'packages/core/pubspec.yaml', 'packages/core/lib/src/cart.dart', 'packages/core/test/src/cart_test.dart', 'integration_test/app_test.dart']
    const { commandes, pieges } = detectCommands({ crap: false, stack: 'Flutter, Riverpod', files, read, sondes: { '.dart_tool/package_config.json': true } })
    expect(commandes.map(c => c.id)).toEqual(['build-runner', 'dart-format', 'dart-analyze', 'flutter-test'])
    expect(byId(commandes, 'dart-analyze')).toMatchObject({ source: 'ci', outil: 'typage', argv: ['dart', 'analyze', '--format=machine', '--fatal-infos', '{fichiers}'] })
    expect(byId(commandes, 'dart-format')!.argv).toEqual(['dart', 'format', '--output=none', '--set-exit-if-changed', '{fichiers}'])
    expect(byId(commandes, 'flutter-test')).toMatchObject({ portee: 'lies', format: 'flutter-json', argv: ['flutter', 'test', '--machine', '--dart-define-from-file=env.test', '{fichiers}'] })
    expect(byId(commandes, 'build-runner')!.argv).toEqual(['dart', 'run', 'build_runner', 'build', '--delete-conflicting-outputs'])
    expect(pieges.join('\n')).toMatch(/Flutter 3\.44\.6 attendu par \.fvm/)
  })

  test('Flutter sans CI (router_app) : déduit, pas de dart format ; env.test absent alors que la CI le cite → piège', () => {
    const read = {
      'pubspec.yaml': ['name: router_app', 'dependencies:', '  flutter:', '    sdk: flutter', '  supabase_flutter: ^2.0.0'].join('\n'),
      '.github/workflows/ci.yml': ['jobs:', '  test:', '    steps:', '      - run: flutter test --dart-define-from-file=env.test'].join('\n'),
    }
    const { commandes, pieges } = detectCommands({ crap: false, stack: 'Flutter, Supabase', files: ['pubspec.yaml', 'lib/main.dart', 'test/router_test.dart', '.github/workflows/ci.yml'], read })
    expect(commandes.map(c => c.id)).toEqual(['dart-analyze', 'flutter-test'])
    expect(byId(commandes, 'dart-analyze')!.argv).not.toContain('--fatal-infos')
    expect(byId(commandes, 'flutter-test')!.argv).toEqual(['flutter', 'test', '--machine', '{fichiers}'])
    expect(pieges.some(p => p.startsWith('env.test absent'))).toBe(true)
  })

  test('pièges : node_modules absent (sondes), .dart_tool absent ; rien sans sondes', () => {
    const read = { 'package.json': pkg({ test: 'NODE_ENV=test jest' }, { jest: '^29.0.0' }) }
    const sans = detectCommands({ crap: false, stack: 'Jest', files: [], read })
    expect(sans.pieges.some(p => p.includes('node_modules'))).toBe(false)
    const avec = detectCommands({ crap: false, stack: 'Jest', files: [], read, sondes: { 'node_modules/.package-lock.json': false } })
    expect(avec.pieges.some(p => p.startsWith('node_modules absent'))).toBe(true)
    expect(avec.pieges.some(p => p.includes('NODE_ENV=test'))).toBe(true)
    const dart = detectCommands({ crap: false, stack: 'Flutter', files: ['pubspec.yaml'], read: { 'pubspec.yaml': 'name: a' }, sondes: { '.dart_tool/package_config.json': false } })
    expect(dart.pieges.some(p => p.includes('flutter pub get'))).toBe(true)
  })

  test('Serverless + Mocha : eslint seul, aucun test ; projet inconnu : aucune commande', () => {
    const { commandes } = detectCommands({ crap: false, stack: 'inconnue', files: ['.eslintrc.json', 'handler.js'], read: { 'package.json': pkg({ test: 'mocha' }, { eslint: '^8.0.0', mocha: '^10.0.0' }) } })
    expect(commandes.map(c => c.id)).toEqual(['eslint'])
    expect(detectCommands({ crap: false, stack: 'Plugin Claude Code', files: ['hooks/a.ts'], read: {} }).commandes).toEqual([])
  })

  test('manifestPaths : racine, paquets du monorepo et leur env.test, workflows GitHub ; pas les fonctions Architect', () => {
    const p = manifestPaths(['packages/core/pubspec.yaml', 'packages/ui/package.json', 'src/http/get-index/package.json', '.github/workflows/ci.yml', 'example/pubspec.yaml', 'lib/main.dart'])
    for (const m of MANIFESTES) expect(p).toContain(m)
    expect(p).toContain('packages/core/pubspec.yaml')
    expect(p).toContain('packages/core/env.test')
    expect(p).toContain('packages/ui/package.json')
    expect(p).toContain('.github/workflows/ci.yml')
    expect(p).not.toContain('src/http/get-index/package.json')
    expect(p).not.toContain('example/pubspec.yaml')
  })

  test('needsConfirm : absent, headless, hash changé, manifeste ajouté ; confirmé et inchangé → non', () => {
    const v: ProjetVerif = { commandes: [], manifestes: { 'package.json': 'aaa' }, confirme: { le: '2026-10-25', par: 'utilisateur' }, instables: [], pieges: [], bases: [] }
    expect(needsConfirm(undefined, {})).toBe(true)
    expect(needsConfirm(v, { 'package.json': 'aaa' })).toBe(false)
    expect(needsConfirm(v, { 'package.json': 'bbb' })).toBe(true)
    expect(needsConfirm(v, { 'package.json': 'aaa', '.gitlab-ci.yml': 'ccc' })).toBe(true)
    expect(needsConfirm(v, {})).toBe(true)
    expect(needsConfirm({ ...v, confirme: { le: 'x', par: 'headless' } }, { 'package.json': 'aaa' })).toBe(true)
    expect(needsConfirm({ ...v, confirme: undefined }, { 'package.json': 'aaa' })).toBe(true)
  })

  test('commandsQuestion : commande exacte, portée, source, déclencheur, exclusions et pièges ; sans JSON', () => {
    const { commandes } = detectCommands({
      crap: false,
      stack: 'Nuxt 3, vitest',
      files: ['.eslintrc.cjs', 'a.vue'],
      read: { 'package.json': pkg({ lint: 'eslint .', codegen: 'graphql-codegen' }, { nuxt: '^3.9.0', vitest: '^1.0.0', typescript: '^5.0.0' }) },
    })
    const q = commandsQuestion('reservation-tool', commandes, ['node_modules absent : lancez npm install'])
    expect(q).toMatch(/^revo-flow a trouvé ces vérifications pour reservation-tool :/)
    expect(q).toContain('eslint (fichiers du flow) : npx eslint -f json --ext .vue <fichiers> · script lint')
    expect(q).toContain('nuxi typecheck (tout le projet) : npx nuxi typecheck · déduit (Nuxt 3)')
    expect(q).toContain('vitest related (tests liés)')
    expect(q).toContain('codegen (tout le projet, si un fichier *.{graphql,gql} change)')
    expect(q).toContain('À savoir :')
    expect(q).toMatch(/Les utiliser \?$/)
    expect(q).not.toMatch(/[{]"/)
    expect(commandsQuestion('x', [], [])).toMatch(/aucune vérification/)
  })

  test('commandLabel, fvmVersion, flutterVersionTrap', () => {
    expect(commandLabel({ id: 'typecheck', outil: 'typage', argv: ['npx', 'nuxi', 'typecheck'], portee: 'projet', format: 'tsc', source: 'ci' })).toBe('nuxi typecheck')
    expect(commandLabel({ id: 'build-runner', outil: 'generation', argv: ['dart', 'run', 'build_runner', 'build'], portee: 'fichiers', format: 'texte', source: 'deduit' })).toBe('build_runner')
    expect(fvmVersion({ '.fvmrc': json({ flutter: '3.44.6' }) })).toBe('3.44.6')
    expect(flutterVersionTrap('3.44.6', 'Flutter 3.44.4 • channel stable • https://github.com/flutter/flutter.git')).toMatch(/3\.44\.4 sur ce poste, 3\.44\.6 attendu/)
    expect(flutterVersionTrap('3.44.6', json({ frameworkVersion: '3.44.6', channel: 'stable' }))).toBeUndefined()
  })
})

// ── Portée ────────────────────────────────────────────────────────────────

describe('plan et withShell', () => {
  const cmd = (c: Partial<VerifCommande> & Pick<VerifCommande, 'id' | 'argv'>): VerifCommande => ({ outil: 'lint', portee: 'fichiers', format: 'texte', source: 'deduit', ...c })
  const FLUTTER_FILES = ['pubspec.yaml', 'lib/main.dart', 'test/main_test.dart', 'packages/core/pubspec.yaml', 'packages/core/lib/src/cart.dart', 'packages/core/lib/src/cart.g.dart', 'packages/core/test/src/cart_test.dart']

  test('monorepo Flutter : dart analyze par paquet (cwd), fichiers relatifs au cwd, générés exclus', () => {
    const c = cmd({ id: 'dart-analyze', outil: 'typage', argv: ['dart', 'analyze', '--format=machine', '{fichiers}'], format: 'dart-machine' })
    const l = plan(c, { changed: ['lib/main.dart', 'packages/core/lib/src/cart.dart', 'packages/core/lib/src/cart.g.dart', 'README.md'], files: FLUTTER_FILES })
    expect(l).toEqual([
      { id: 'dart-analyze', cwd: '', argv: ['dart', 'analyze', '--format=machine', 'lib/main.dart'], fichiers: ['lib/main.dart'] },
      { id: 'dart-analyze', cwd: 'packages/core', argv: ['dart', 'analyze', '--format=machine', 'lib/src/cart.dart'], fichiers: ['packages/core/lib/src/cart.dart'] },
    ])
  })

  test('tests liés Dart : convention lib → test, arêtes teste, test modifié, integration_test exclu ; env.test relatif au cwd', () => {
    const c = cmd({ id: 'flutter-test', outil: 'tests', portee: 'lies', argv: ['flutter', 'test', '--machine', '--dart-define-from-file=env.test', '{fichiers}'], format: 'flutter-json', exclus: ['**/supabase/**'] })
    const testsOf = (p: string) => (p === 'lib/main.dart' ? ['test/app_test.dart', 'integration_test/app_test.dart'] : [])
    const l = plan(c, { changed: ['packages/core/lib/src/cart.dart', 'lib/main.dart', 'test/supabase/db_test.dart'], files: [...FLUTTER_FILES, 'test/app_test.dart'], testsOf })
    expect(l).toEqual([
      { id: 'flutter-test', cwd: '', argv: ['flutter', 'test', '--machine', '--dart-define-from-file=env.test', 'test/app_test.dart', 'test/main_test.dart'], fichiers: ['test/app_test.dart', 'test/main_test.dart'] },
      {
        id: 'flutter-test',
        cwd: 'packages/core',
        argv: ['flutter', 'test', '--machine', '--dart-define-from-file=../../env.test', 'test/src/cart_test.dart'],
        fichiers: ['packages/core/test/src/cart_test.dart'],
      },
    ])
    expect(dartTests(['lib/x.dart'], () => false, [''])).toEqual([])
  })

  test('build_runner : déclenché par un fichier généré à côté ou une annotation, un lancement par paquet', () => {
    const c = cmd({ id: 'build-runner', outil: 'generation', argv: ['dart', 'run', 'build_runner', 'build', '--delete-conflicting-outputs'], declencheur: '**/*.{dart,yaml}' })
    expect(plan(c, { changed: ['lib/main.dart'], files: FLUTTER_FILES })).toEqual([])
    expect(plan(c, { changed: ['packages/core/lib/src/cart.dart'], files: FLUTTER_FILES })).toEqual([
      { id: 'build-runner', cwd: 'packages/core', argv: ['dart', 'run', 'build_runner', 'build', '--delete-conflicting-outputs'], fichiers: ['packages/core/lib/src/cart.dart'] },
    ])
    expect(plan(c, { changed: ['lib/main.dart'], files: FLUTTER_FILES, annotes: ['lib/main.dart'] })).toHaveLength(1)
    expect(hasGenAnnotation("part 'cart.g.dart';\n@riverpod\nclass Cart {}")).toBe(true)
    expect(hasGenAnnotation('class Cart {}')).toBe(false)
  })

  test('JS : extensions filtrées, projet à la racine, déclencheur codegen, exclusions vitest et jest, chemins Windows', () => {
    const eslint = cmd({ id: 'eslint', argv: ['npx', 'eslint', '-f', 'json', '{fichiers}'] })
    expect(plan(eslint, { changed: ['components\\Cart.vue', 'README.md', 'graphql/offers.graphql'], files: [] })).toEqual([{ id: 'eslint', cwd: '', argv: ['npx', 'eslint', '-f', 'json', 'components/Cart.vue'], fichiers: ['components/Cart.vue'] }])
    expect(plan(eslint, { changed: ['README.md'], files: [] })).toEqual([])
    const tsc = cmd({ id: 'typecheck', outil: 'typage', portee: 'projet', argv: ['npx', 'nuxi', 'typecheck'] })
    expect(plan(tsc, { changed: ['a.ts'], files: [] })).toEqual([{ id: 'typecheck', cwd: '', argv: ['npx', 'nuxi', 'typecheck'], fichiers: [] }])
    expect(plan(tsc, { changed: [], files: [] })).toEqual([])
    const codegen = cmd({ id: 'codegen', outil: 'generation', portee: 'projet', argv: ['npm', 'run', 'codegen'], declencheur: '**/*.{graphql,gql}' })
    expect(plan(codegen, { changed: ['a.ts'], files: [] })).toEqual([])
    expect(plan(codegen, { changed: ['graphql/offers.graphql'], files: [] })).toHaveLength(1)
    const vitest = cmd({ id: 'vitest', outil: 'tests', portee: 'lies', argv: ['npx', 'vitest', 'related', '--run', '{fichiers}'], exclus: ['**/sandbox/**'] })
    expect(plan(vitest, { changed: ['src/a.ts'], files: [] })[0]!.argv).toEqual(['npx', 'vitest', 'related', '--run', '--exclude', '**/sandbox/**', 'src/a.ts'])
    const jest = cmd({ id: 'jest', outil: 'tests', portee: 'lies', argv: ['npx', 'jest', '--json', '--findRelatedTests', '{fichiers}'], exclus: ['**/e2e/**'] })
    expect(plan(jest, { changed: ['src/a.ts'], files: [] })[0]!.argv).toEqual(['npx', 'jest', '--json', '--testPathIgnorePatterns', '(?:.*/)?e2e/.*', '--findRelatedTests', 'src/a.ts'])
  })

  test('monorepo JS : packages/* seulement ; découpe des longues listes (ligne de cmd limitée)', () => {
    const eslint = cmd({ id: 'eslint', argv: ['npx', 'eslint', '{fichiers}'] })
    const l = plan(eslint, { changed: ['packages/ui/src/a.ts', 'src/http/get-index/index.ts'], files: ['package.json', 'packages/ui/package.json', 'src/http/get-index/package.json'] })
    expect(l.map(x => [x.cwd, x.argv.at(-1)])).toEqual([
      ['', 'src/http/get-index/index.ts'],
      ['packages/ui', 'src/a.ts'],
    ])
    const many = Array.from({ length: 400 }, (_, i) => `components/booking/very/long/path/Component${i}.vue`)
    const parts = plan(eslint, { changed: many, files: [] })
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.reduce((n, p) => n + p.fichiers.length, 0)).toBe(400)
    for (const p of parts) expect(p.argv.join(' ').length).toBeLessThan(7000)
  })

  test('withShell : cmd /c sous Windows pour npx, npm, flutter, dart ; rien sous macOS', () => {
    expect(withShell(['npx', 'eslint', 'a.ts'], 'windows')).toEqual(['cmd', '/c', 'npx', 'eslint', 'a.ts'])
    expect(withShell(['flutter', 'test'], 'windows')).toEqual(['cmd', '/c', 'flutter', 'test'])
    expect(withShell(['git', 'status'], 'windows')).toEqual(['git', 'status'])
    expect(withShell(['npx', 'eslint'], 'posix')).toEqual(['npx', 'eslint'])
  })

  test('globMatch et relative', () => {
    expect(globMatch('**/*.{graphql,gql}', 'graphql/a.gql')).toBe(true)
    expect(globMatch('**/*.graphql', 'a.graphql')).toBe(true)
    expect(globMatch('*.dart', 'lib/a.dart')).toBe(true)
    expect(globMatch('**/sandbox/**', 'test/sandbox/a.test.ts')).toBe(true)
    expect(globMatch('**/sandbox/**', 'test/unit/a.test.ts')).toBe(false)
    expect(relative('packages/core', 'env.test')).toBe('../../env.test')
    expect(relative('packages/core', 'packages/core/lib/a.dart')).toBe('lib/a.dart')
  })
})

// ── Lecture des sorties ───────────────────────────────────────────────────

/** La racine du projet et la forme native d'un chemin sous cette racine. */
const projet = (os: Os, nom = 'reservation-tool') => {
  const racine = native(os, 'Documents', 'Front', nom)
  return { racine, abs: (rel: string) => [racine, ...rel.split('/')].join(os.sep), eol: os === WINDOWS ? '\r\n' : '\n' }
}

for (const os of OSES) {
  describe(`parseOutput (${os.nom})`, () => {
    const { racine, abs, eol } = projet(os)
    const ctx = (outil: string, argv?: string[]) => ({ outil, cwd: '', racine, argv })

    test('ESLint -f json : erreurs et fatales, avertissements ignorés (sauf --max-warnings 0), fichier ignoré écarté', () => {
      const out = json([
        {
          filePath: abs('components/Cart.vue'),
          messages: [
            { ruleId: 'vue/no-unused-vars', severity: 2, message: "'item' is defined but never used.", line: 12, column: 15, nodeType: 'Identifier', endLine: 12, endColumn: 19 },
            { ruleId: 'no-console', severity: 1, message: 'Unexpected console statement.', line: 30, column: 5 },
          ],
          suppressedMessages: [],
          errorCount: 1,
          warningCount: 1,
          fixableErrorCount: 0,
          fixableWarningCount: 0,
        },
        { filePath: abs('stores/booking/Cart.ts'), messages: [{ ruleId: null, fatal: true, severity: 2, message: "Parsing error: ',' expected.", line: 4, column: 10 }], errorCount: 1, warningCount: 0 },
        { filePath: abs('nuxt.config.ts'), messages: [{ ruleId: null, severity: 1, message: 'File ignored because of a matching ignore pattern. Use "--no-ignore" to override.' }], errorCount: 0, warningCount: 1 },
      ])
      const e = parseOutput('eslint-json', { stdout: out + eol, stderr: '', exitCode: 1 }, ctx('eslint'))
      expect(e).toEqual([
        { outil: 'eslint', fichier: 'components/Cart.vue', code: 'vue/no-unused-vars', message: "'item' is defined but never used.", ligne: 12, col: 15 },
        { outil: 'eslint', fichier: 'stores/booking/Cart.ts', code: 'syntaxe', message: "Parsing error: ',' expected.", ligne: 4, col: 10 },
      ])
      expect(parseOutput('eslint-json', { stdout: out, stderr: '', exitCode: 1 }, ctx('eslint', ['npx', 'eslint', '--max-warnings', '0'])).map(x => x.code)).toEqual(['vue/no-unused-vars', 'no-console', 'syntaxe'])
      expect(parseOutput('eslint-json', { stdout: '', stderr: 'Oops! Something went wrong! :(', exitCode: 2 }, ctx('eslint'))).toEqual([])
    })

    test('tsc (NestJS), vue-tsc coloré, nuxi typecheck : les deux formes, chemins relatifs au cwd, erreur globale', () => {
      const nest = ['src/orders/orders.service.ts(42,7): error TS2322: Type \'string\' is not assignable to type \'number\'.', "src/orders/orders.service.ts(58,12): error TS2339: Property 'total' does not exist on type 'Order'.", '', 'Found 2 errors.'].join(eol)
      expect(parseOutput('tsc', { stdout: nest, stderr: '', exitCode: 2 }, ctx('typecheck')).map(e => [e.fichier, e.code, e.ligne])).toEqual([
        ['src/orders/orders.service.ts', 'TS2322', 42],
        ['src/orders/orders.service.ts', 'TS2339', 58],
      ])
      const vue = `\x1b[96mcomponents/BookingCard.vue\x1b[0m:\x1b[93m24\x1b[0m:\x1b[93m9\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2345: \x1b[0mArgument of type 'number' is not assignable to parameter of type 'string'.${eol}${eol}24         formatPrice(offer.id)${eol}`
      expect(parseOutput('tsc', { stdout: vue, stderr: '', exitCode: 1 }, { outil: 'typecheck', cwd: 'apps/web', racine })).toEqual([
        { outil: 'typecheck', fichier: 'apps/web/components/BookingCard.vue', code: 'TS2345', message: "Argument of type 'number' is not assignable to parameter of type 'string'.", ligne: 24, col: 9 },
      ])
      const win = `stores\\booking\\Cart.ts(12,5): error TS2322: Type 'null' is not assignable to type 'Cart'.\r\nerror TS5083: Cannot read file 'tsconfig.app.json'.\r\n`
      expect(parseOutput('tsc', { stdout: win, stderr: '', exitCode: 2 }, ctx('typecheck')).map(e => [e.fichier, e.code])).toEqual([
        ['stores/booking/Cart.ts', 'TS2322'],
        ['', 'TS5083'],
      ])
    })

    test('Vitest --reporter=json : test rouge (nom complet, ligne, détail), bruit avant le JSON', () => {
      const out = json({
        numTotalTestSuites: 2,
        numFailedTests: 1,
        success: false,
        testResults: [
          {
            assertionResults: [
              { ancestorTitles: ['useCart'], fullName: 'useCart ajoute une offre', status: 'passed', title: 'ajoute une offre', failureMessages: [], location: { line: 8, column: 3 } },
              { ancestorTitles: ['useCart'], fullName: 'useCart calcule le total', status: 'failed', title: 'calcule le total', failureMessages: [`AssertionError: expected 30 to be 45 // Object.is equality\n    at ${abs('tests/useCart.spec.ts')}:20:25`], location: { line: 18, column: 3 } },
            ],
            status: 'failed',
            message: '',
            name: abs('tests/useCart.spec.ts'),
          },
          { assertionResults: [], status: 'failed', message: "Failed to load url ~/stores/missing (resolved id: ~/stores/missing) in tests/broken.spec.ts. Does the file exist?", name: abs('tests/broken.spec.ts') },
        ],
      })
      const e = parseOutput('vitest-json', { stdout: `stdout | tests/useCart.spec.ts > useCart > ajoute une offre${eol}debug panier${eol}${out}`, stderr: '', exitCode: 1 }, ctx('vitest'))
      expect(e).toEqual([
        { outil: 'vitest', fichier: 'tests/useCart.spec.ts', code: 'echec', message: 'useCart calcule le total', ligne: 18, detail: 'AssertionError: expected 30 to be 45 // Object.is equality' },
        { outil: 'vitest', fichier: 'tests/broken.spec.ts', code: 'chargement', message: 'le fichier de test ne se charge pas', detail: 'Failed to load url ~/stores/missing (resolved id: ~/stores/missing) in tests/broken.spec.ts. Does the file exist?' },
      ])
    })

    test('Jest 27 (back-office) et Jest 29 (order) --json : échecs, suite qui ne tourne pas, location nulle', () => {
      const bo = projet(os, 'back-office')
      const j27 = json({
        numFailedTestSuites: 2,
        numFailedTests: 1,
        numRuntimeErrorTestSuites: 1,
        success: false,
        testResults: [
          {
            assertionResults: [
              { ancestorTitles: ['Panier'], failureMessages: [`Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 2\nReceived: 1\n    at Object.<anonymous> (${bo.abs('test/store/cart.spec.js')}:14:28)`], fullName: 'Panier retire un article', location: null, status: 'failed', title: 'retire un article' },
              { ancestorTitles: ['Panier'], failureMessages: [], fullName: 'Panier ajoute un article', location: null, status: 'passed', title: 'ajoute un article' },
            ],
            message: '  ● Panier › retire un article\n\n    expect(received).toBe(expected)',
            name: bo.abs('test/store/cart.spec.js'),
            status: 'failed',
            summary: '',
          },
          { assertionResults: [], message: "  ● Test suite failed to run\n\n    Cannot find module '~/plugins/axios' from 'test/plugins/api.spec.js'", name: bo.abs('test/plugins/api.spec.js'), status: 'failed', summary: '' },
        ],
        wasInterrupted: false,
      })
      expect(parseOutput('jest-json', { stdout: j27, stderr: 'FAIL test/store/cart.spec.js', exitCode: 1 }, { outil: 'jest', cwd: '', racine: bo.racine })).toEqual([
        { outil: 'jest', fichier: 'test/store/cart.spec.js', code: 'echec', message: 'Panier retire un article', detail: 'Error: expect(received).toBe(expected) // Object.is equality' },
        { outil: 'jest', fichier: 'test/plugins/api.spec.js', code: 'chargement', message: 'le fichier de test ne se charge pas', detail: '● Test suite failed to run' },
      ])
      const order = { racine: native(os, 'Documents', 'Back', 'order') }
      const j29 = json({
        numFailedTests: 1,
        numRuntimeErrorTestSuites: 0,
        success: false,
        testResults: [
          {
            assertionResults: [
              { ancestorTitles: ['OrdersService', 'create'], duration: 12, failureDetails: [{}], failureMessages: ['Error: expect(jest.fn()).toHaveBeenCalledWith(...expected)'], fullName: 'OrdersService create enregistre la commande', invocations: 1, location: { column: 5, line: 31 }, numPassingAsserts: 0, retryReasons: [], status: 'failed', title: 'enregistre la commande' },
            ],
            message: '',
            name: [order.racine, 'src', 'orders', 'orders.service.spec.ts'].join(os.sep),
            status: 'failed',
          },
        ],
      })
      expect(parseOutput('jest-json', { stdout: j29, stderr: '', exitCode: 1 }, { outil: 'jest', cwd: '', racine: order.racine })).toEqual([
        { outil: 'jest', fichier: 'src/orders/orders.service.spec.ts', code: 'echec', message: 'OrdersService create enregistre la commande', ligne: 31, detail: 'Error: expect(jest.fn()).toHaveBeenCalledWith(...expected)' },
      ])
    })

    test('Biome check : rapport texte (✖ seulement, format compris), et --reporter=github', () => {
      const out = [
        'src/http/get-index/index.ts:3:7 lint/style/useConst  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        '  ✖ This let declares a variable that is only assigned once.',
        '  ',
        '    1 │ import arc from \'@architect/functions\'',
        '  > 3 │ let handler = arc.http(async () => ({ status: 200 }))',
        '      │     ^^^^^^^',
        '  ℹ \'handler\' is never reassigned.',
        '',
        'src/shared/db.ts:10:3 lint/suspicious/noConsoleLog ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        '  ⚠ Don\'t use console.log',
        '',
        'src/shared/db.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        '  ✖ Formatter would have printed the following content:',
        '',
        'check ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        '  ✖ Some errors were emitted while running checks.',
        '',
        'Checked 2 files in 4ms. No fixes applied.',
        'Found 2 errors.',
        'Found 1 warning.',
      ].join(eol)
      const ap = { outil: 'biome', cwd: '', racine: native(os, 'Documents', 'Back', 'application-mobile-api') }
      expect(parseOutput('biome', { stdout: '', stderr: out, exitCode: 1 }, ap)).toEqual([
        { outil: 'biome', fichier: 'src/http/get-index/index.ts', code: 'lint/style/useConst', message: 'This let declares a variable that is only assigned once.', ligne: 3, col: 7 },
        { outil: 'biome', fichier: 'src/shared/db.ts', code: 'format', message: 'Formatter would have printed the following content:' },
      ])
      const gh = '::error title=lint/suspicious/noDebugger,file=src/main.ts,line=1,endLine=1,col=1,endColumn=9::This is an unexpected use of the debugger statement.'
      expect(parseOutput('biome', { stdout: gh, stderr: '', exitCode: 1 }, ap)).toEqual([
        { outil: 'biome', fichier: 'src/main.ts', code: 'lint/suspicious/noDebugger', message: 'This is an unexpected use of the debugger statement.', ligne: 1, col: 1 },
      ])
    })

    test('dart analyze --format=machine : échappements (chemins Windows), INFO seulement avec --fatal-infos, monorepo', () => {
      const ui = projet(os, 'application-mobile-ui')
      const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
      const out = [
        'Analyzing a.dart, main.dart...',
        `ERROR|COMPILE_TIME_ERROR|UNDEFINED_IDENTIFIER|${esc(ui.abs('packages/core/lib/src/cart.dart'))}|12|5|3|Undefined name 'foo'.`,
        `WARNING|STATIC_WARNING|UNUSED_IMPORT|${esc(ui.abs('lib/main.dart'))}|1|8|30|Unused import: 'package:core/core.dart'.`,
        `INFO|LINT|PREFER_CONST_CONSTRUCTORS|${esc(ui.abs('lib/main.dart'))}|8|10|20|Use 'const' with the constructor to improve performance.`,
        `ERROR|SYNTACTIC_ERROR|EXPECTED_TOKEN|${esc(ui.abs('lib/a.dart'))}|3|1|1|Expected to find ';' \\| or '}'.`,
      ].join(ui.eol)
      const base = { outil: 'dart-analyze', cwd: 'packages/core', racine: ui.racine }
      expect(parseOutput('dart-machine', { stdout: out, stderr: '', exitCode: 3 }, base)).toEqual([
        { outil: 'dart-analyze', fichier: 'packages/core/lib/src/cart.dart', code: 'undefined_identifier', message: "Undefined name 'foo'.", ligne: 12, col: 5 },
        { outil: 'dart-analyze', fichier: 'lib/main.dart', code: 'unused_import', message: "Unused import: 'package:core/core.dart'.", ligne: 1, col: 8 },
        { outil: 'dart-analyze', fichier: 'lib/a.dart', code: 'expected_token', message: "Expected to find ';' | or '}'.", ligne: 3, col: 1 },
      ])
      expect(parseOutput('dart-machine', { stdout: out, stderr: '', exitCode: 3 }, { ...base, argv: ['dart', 'analyze', '--fatal-infos'] })).toHaveLength(4)
    })

    test('flutter test --machine : échec avec détail, fichier qui ne compile pas, tests verts et cachés ignorés', () => {
      const ui = projet(os, 'application-mobile-ui')
      const t = ui.abs('packages/core/test/src/cart_test.dart')
      const broken = ui.abs('packages/core/test/broken_test.dart')
      const url = (p: string) => `file:///${p.replace(/\\/g, '/').replace(/^\//, '')}`
      const ev = [
        { protocolVersion: '0.1.1', runnerVersion: '1.25.8', pid: 4242, type: 'start', time: 0 },
        { suite: { id: 0, platform: 'vm', path: t }, type: 'suite', time: 0 },
        { test: { id: 1, name: `loading ${t}`, suiteID: 0, groupIDs: [], metadata: { skip: false, skipReason: null }, line: null, column: null, url: null }, type: 'testStart', time: 2 },
        { count: 2, time: 5, type: 'allSuites' },
        { testID: 1, result: 'success', skipped: false, hidden: true, type: 'testDone', time: 900 },
        { group: { id: 3, suiteID: 0, parentID: 2, name: 'Panier', testCount: 2, line: 8, column: 3, url: url(t) }, type: 'group', time: 906 },
        { test: { id: 4, name: 'Panier calcule le total', suiteID: 0, groupIDs: [2, 3], metadata: { skip: false, skipReason: null }, line: 12, column: 5, url: url(t) }, type: 'testStart', time: 907 },
        { testID: 4, messageType: 'print', message: 'debug', type: 'print', time: 910 },
        { testID: 4, error: 'Expected: <45>\n  Actual: <30>\n', stackTrace: 'package:matcher/src/expect/expect.dart 149:31  fail', isFailure: true, type: 'error', time: 950 },
        { testID: 4, result: 'failure', skipped: false, hidden: false, type: 'testDone', time: 951 },
        { test: { id: 5, name: 'Panier ajoute', suiteID: 0, groupIDs: [2, 3], metadata: { skip: false, skipReason: null }, line: 20, column: 5, url: url(t) }, type: 'testStart', time: 952 },
        { testID: 5, result: 'success', skipped: false, hidden: false, type: 'testDone', time: 960 },
        { suite: { id: 6, platform: 'vm', path: broken }, type: 'suite', time: 1 },
        { test: { id: 7, name: `loading ${broken}`, suiteID: 6, groupIDs: [], metadata: { skip: false, skipReason: null }, line: null, column: null, url: null }, type: 'testStart', time: 3 },
        { testID: 7, error: `Failed to load "${broken}":\nlib/src/cart.dart:3:1: Error: Expected ';' after this.`, stackTrace: '', isFailure: false, type: 'error', time: 1000 },
        { testID: 7, result: 'error', skipped: false, hidden: false, type: 'testDone', time: 1001 },
        { success: false, type: 'done', time: 1200 },
      ]
      const out = ['Resolving dependencies...', ...ev.map(json)].join(ui.eol)
      expect(parseOutput('flutter-json', { stdout: out, stderr: '', exitCode: 1 }, { outil: 'flutter-test', cwd: 'packages/core', racine: ui.racine })).toEqual([
        { outil: 'flutter-test', fichier: 'packages/core/test/src/cart_test.dart', code: 'echec', message: 'Panier calcule le total', ligne: 12, detail: 'Expected: <45>' },
        { outil: 'flutter-test', fichier: 'packages/core/test/broken_test.dart', code: 'chargement', message: 'le fichier de test ne se charge pas', detail: `Failed to load "${broken}":` },
      ])
    })

    test('texte : dart format (Changed) et prettier --check ([warn]) ; le reste est illisible', () => {
      const out = [`Changed lib${os.sep}main.dart`, 'Formatted 3 files (1 changed) in 0.12 seconds.'].join(eol)
      expect(parseOutput('texte', { stdout: out, stderr: '', exitCode: 1 }, { outil: 'dart-format', cwd: 'packages/core', racine })).toEqual([
        { outil: 'dart-format', fichier: 'packages/core/lib/main.dart', code: 'format', message: 'formatage à refaire (dart format)' },
      ])
      const pr = ['Checking formatting...', '[warn] components/Cart.vue', '[warn] Code style issues found in the above file. Run Prettier with --write to fix.'].join(eol)
      expect(parseOutput('texte', { stdout: pr, stderr: '', exitCode: 1 }, ctx('prettier')).map(e => e.fichier)).toEqual(['components/Cart.vue'])
      expect(parseOutput('texte', { stdout: 'Error: schema unreachable', stderr: '', exitCode: 1 }, ctx('codegen'))).toEqual([])
    })

    test('toRoot : absolu sous la racine (casse du lecteur ignorée sous Windows), file://, hors racine gardé', () => {
      expect(toRoot(abs('a/b.ts'), { cwd: '', racine })).toBe('a/b.ts')
      if (os === WINDOWS) expect(toRoot('c:\\users\\x\\Documents\\Front\\reservation-tool\\a.ts', { cwd: '', racine })).toBe('a.ts')
      expect(toRoot(`file:///${abs('test/a_test.dart').replace(/\\/g, '/').replace(/^\//, '')}`, { cwd: '', racine })).toBe('test/a_test.dart')
      expect(toRoot('../shared/x.ts', { cwd: 'packages/ui', racine })).toBe('packages/shared/x.ts')
      expect(toRoot('/opt/other/x.ts', { cwd: '', racine: '/Users/x/p' })).toBe('/opt/other/x.ts')
    })
  })
}

describe('signatureKey', () => {
  test('sans ligne ni colonne, message normalisé (couleurs, espaces, positions)', () => {
    const a = signatureKey({ outil: 'typecheck', fichier: 'a\\b.ts', code: 'TS2322', message: "Type  'x' is not assignable (12,4)" })
    const b = signatureKey({ outil: 'typecheck', fichier: 'a/b.ts', code: 'TS2322', message: "\x1b[1mType 'x' is not assignable\x1b[0m" })
    expect(a).toBe(b)
    expect(a).toBe("typecheck|a/b.ts|TS2322|Type 'x' is not assignable")
    expect(normalizeMessage('at line 12: oops :3:4')).toBe('at : oops')
  })
})

// ── Base de référence ─────────────────────────────────────────────────────

describe('classify, addBase, baseFor', () => {
  const err = (fichier: string, code: string, message: string, outil = 'eslint') => ({ outil, fichier, code, message })
  const base = (commit: string, commandes: string[], errs: ReturnType<typeof err>[], le = '2026-10-25T08:00:00.000Z'): VerifBase => ({ commit, le, commandes, signatures: errs.map(signatureKey) })

  test('nouvelle, préexistante (multiensemble), instable ; base absente ou commande absente → nouvelle ?', () => {
    const e1 = err('a.vue', 'no-undef', "'x' is not defined.")
    const e2 = err('b.ts', 'no-unused-vars', "'y' is defined but never used.")
    const b = base('abc1234', ['eslint'], [e1])
    const r = classify([{ ...e1, ligne: 3 }, { ...e1, ligne: 9 }, e2], b, [], 'eslint')
    expect(r.map(x => x.statut)).toEqual(['preexistante', 'nouvelle', 'nouvelle'])
    expect(r[0]!.ligne).toBe(3)
    expect(classify([e2], undefined, [], 'eslint')[0]!.statut).toBe('nouvelle?')
    expect(classify([e2], b, [], 'typecheck')[0]!.statut).toBe('nouvelle?')
    const t = err('tests/a.spec.ts', 'echec', 'panier total', 'vitest')
    expect(classify([t], undefined, [signatureKey(t)], 'vitest')[0]!.statut).toBe('instable')
  })

  test('addBase : 3 derniers commits, fusion du même commit par commande ; baseFor par hash abrégé', () => {
    let v: ProjetVerif = { commandes: [], manifestes: {}, instables: [], pieges: [], bases: [] }
    for (const c of ['c1', 'c2', 'c3', 'c4']) v = addBase(v, base(`${c}aaaaaaa`, ['eslint'], []))
    expect(v.bases.map(b => b.commit.slice(0, 2))).toEqual(['c2', 'c3', 'c4'])
    v = addBase(v, base('c4aaaaaaa', ['eslint'], [err('a.ts', 'r', 'm')]))
    v = addBase(v, base('c4aaaaaaa', ['typecheck'], [err('b.ts', 'TS1', 'm', 'typecheck')]))
    const b4 = baseFor(v, 'c4aaaaaaaffffff')!
    expect(b4.commandes).toEqual(['eslint', 'typecheck'])
    expect(b4.signatures).toEqual(['eslint|a.ts|r|m', 'typecheck|b.ts|TS1|m'])
    v = addBase(v, base('c4aaaaaaa', ['eslint'], []))
    expect(baseFor(v, 'c4aaaaa')!.signatures).toEqual(['typecheck|b.ts|TS1|m'])
    expect(v.bases).toHaveLength(3)
    expect(baseFor(v, 'zzz')).toBeUndefined()
    expect(baseFor(undefined, 'c4')).toBeUndefined()
  })
})

// ── Rapport ───────────────────────────────────────────────────────────────

describe('reportText et summaryLine', () => {
  const etat = (c: Partial<VerifEtatCommande> & Pick<VerifEtatCommande, 'id' | 'etat'>): VerifEtatCommande => ({ outil: 'lint', dureeMs: 6000, nouvelles: 0, preexistantes: 0, instables: 0, fichiers: 0, ...c })
  const nouvelle = (i: number, fichier = `stores/f${i % 7}.ts`): VerifErreur => ({ outil: 'typecheck', fichier, code: 'TS2322', message: `Type 'A${i}' is not assignable to type 'B'. ${'x'.repeat(400)}`, ligne: i, statut: 'nouvelle' })

  test('rouge : erreurs nouvelles groupées par fichier, 30 au plus, « et N autres », ≤ 4 000 tokens, sorties complètes', () => {
    const erreurs = [...Array.from({ length: 500 }, (_, i) => nouvelle(i + 1)), { outil: 'eslint', fichier: 'a.vue', code: 'no-undef', message: 'x', statut: 'preexistante' } as VerifErreur]
    const r: VerifResultat = {
      etat: 'rouge',
      le: '2026-10-25T10:00:00.000Z',
      dureeMs: 62_000,
      commandes: [etat({ id: 'eslint', etat: 'ok', fichiers: 12, preexistantes: 1 }), etat({ id: 'typecheck', outil: 'typage', etat: 'ko', nouvelles: 500, dureeMs: 48_000, sortie: '/Users/x/.claude/revo-flow/verif/f1/typecheck.txt' })],
      erreurs,
    }
    const t = reportText(r, { tentative: 2, maxTentatives: 3 })
    expect(t.length).toBeLessThanOrEqual(16_000)
    expect(t).toMatch(/^Vérification revo-flow : rouge \(tentative 2\/3\) · 500 erreurs nouvelles · 1 min 02/)
    expect(t).toContain('✗ typecheck · 500 nouvelles · 48 s')
    expect(t).toContain('✓ eslint · 1 préexistante · 6 s')
    expect((t.match(/^ {2}l\.\d+ TS2322/gm) ?? []).length).toBe(30)
    expect(t).toContain('… et 470 autres')
    expect(t).toContain('typecheck → /Users/x/.claude/revo-flow/verif/f1/typecheck.txt')
    expect(t).toContain('Préexistantes (déjà là au commit de départ, non bloquantes) : 1')
    expect(t).not.toContain('{"')
    expect(summaryLine(r)).toBe('non vérifié (typecheck ✗)')
  })

  test('seulement : les fichiers de l’agent détaillés, les autres comptés ; « nouvelle ? » marquée ; instables à part', () => {
    const r: VerifResultat = {
      etat: 'rouge',
      le: 'x',
      dureeMs: 3000,
      commandes: [etat({ id: 'vitest', outil: 'tests', etat: 'ko', nouvelles: 2, instables: 1 })],
      erreurs: [
        { outil: 'vitest', fichier: 'tests/cart.spec.ts', code: 'echec', message: 'panier total', statut: 'nouvelle?', detail: 'expected 30 to be 45' },
        { outil: 'vitest', fichier: 'tests/other.spec.ts', code: 'echec', message: 'autre', statut: 'nouvelle' },
        { outil: 'vitest', fichier: 'tests/flaky.spec.ts', code: 'echec', message: 'réseau', statut: 'instable' },
      ],
    }
    const t = reportText(r, { seulement: ['tests\\cart.spec.ts'] })
    expect(t).toContain('tests/cart.spec.ts\n  echec panier total (nouvelle ?) — expected 30 to be 45')
    expect(t).not.toContain('tests/other.spec.ts')
    expect(t).toContain('1 erreur nouvelle hors de ces fichiers')
    expect(t).toContain('Tests instables (rouges puis verts à la relance, non bloquants) : 1')
    expect(t).toContain('« nouvelle ? »')
  })

  test('vert, erreur, sautée', () => {
    const vert: VerifResultat = { etat: 'vert', le: 'x', dureeMs: 9000, commandes: [etat({ id: 'eslint', etat: 'ok', fichiers: 3 }), etat({ id: 'codegen', outil: 'generation', etat: 'saute', note: 'aucun fichier {graphql,gql} modifié' })], erreurs: [] }
    expect(reportText(vert)).toBe(['Vérification revo-flow : vert · 9 s', '✓ eslint · 3 fichiers · 6 s', '– codegen · sautée (aucun fichier {graphql,gql} modifié)'].join('\n'))
    expect(summaryLine(vert)).toBe('vérifié ✓')
    const err: VerifResultat = { etat: 'erreur', le: 'x', dureeMs: 1000, commandes: [etat({ id: 'jest', outil: 'tests', etat: 'erreur', note: 'code de sortie 1 sans erreur lisible : voir la sortie complète', sortie: '/tmp/jest.txt' })], erreurs: [] }
    expect(reportText(err)).toContain('⚠ jest · erreur : code de sortie 1 sans erreur lisible')
    expect(reportText(err)).toContain('jest → /tmp/jest.txt')
    expect(summaryLine(err)).toBe('non vérifié (jest : erreur)')
  })
})

// ── Exécuteur, avec un faux VerifIo ───────────────────────────────────────

type Reponse = { exitCode: number; stdout?: string; stderr?: string; ms?: number } | Error
/** Un faux moteur : chaque run avance l'horloge et répond selon l'argv (sans le préfixe cmd /c), le cwd et le rang de l'appel pour cet outil. */
function fakeIo(os: Os, racine: string, repond: (argv: string[], cwd: string, n: number) => Reponse) {
  let clock = Date.UTC(2026, 9, 25, 10)
  const calls: { argv: string[]; cwd: string; timeoutMs: number }[] = []
  const writes = new Map<string, string>()
  const removed: string[] = []
  const rangs = new Map<string, number>()
  const io: VerifIo = {
    os: os === WINDOWS ? 'windows' : 'posix',
    racine,
    sorties: native(os, '.claude', 'revo-flow', 'verif', '20261025-1000-f1'),
    async run(argv, init) {
      calls.push({ argv, cwd: init.cwd, timeoutMs: init.timeoutMs })
      const nu = argv[0] === 'cmd' ? argv.slice(2) : argv
      const cle = nu.slice(0, 3).join(' ')
      const n = (rangs.get(cle) ?? 0) + 1
      rangs.set(cle, n)
      const r = repond(nu, init.cwd, n)
      if (r instanceof Error) {
        clock += 1000
        throw r
      }
      clock += r.ms ?? 2000
      return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    async write(path, text) {
      writes.set(path, text)
    },
    async list() {
      return ['20261001-0900-a', '20261002-0900-b', '20261003-0900-c', '20261004-0900-d']
    },
    async remove(path) {
      removed.push(path)
    },
    async now() {
      return clock
    },
  }
  return { io, calls, writes, removed }
}

const NUXT_CMDS: VerifCommande[] = [
  { id: 'eslint', outil: 'lint', argv: ['npx', 'eslint', '-f', 'json', '{fichiers}'], portee: 'fichiers', format: 'eslint-json', source: 'ci' },
  { id: 'typecheck', outil: 'typage', argv: ['npx', 'nuxi', 'typecheck'], portee: 'projet', format: 'tsc', source: 'script', dureeMs: 40_000 },
  { id: 'vitest', outil: 'tests', argv: ['npx', 'vitest', 'related', '--run', '--reporter=json', '{fichiers}'], portee: 'lies', format: 'vitest-json', source: 'deduit' },
  { id: 'codegen', outil: 'generation', argv: ['npm', 'run', 'codegen'], portee: 'projet', format: 'texte', source: 'script', declencheur: '**/*.{graphql,gql}' },
]
const verifOf = (commandes: VerifCommande[], bases: VerifBase[] = []): ProjetVerif => ({ commandes, manifestes: {}, confirme: { le: 'x', par: 'utilisateur' }, instables: [], pieges: [], bases })

for (const os of OSES) {
  describe(`runGate et runBase (${os.nom})`, () => {
    const { racine, abs } = projet(os)
    const vitestOut = (rouge: boolean) =>
      json({
        success: !rouge,
        testResults: [
          {
            name: abs('tests/useCart.spec.ts'),
            status: rouge ? 'failed' : 'passed',
            message: '',
            assertionResults: [{ ancestorTitles: ['useCart'], title: 'total', fullName: 'useCart total', status: rouge ? 'failed' : 'passed', failureMessages: rouge ? ['AssertionError: expected 30 to be 45'] : [] }],
          },
        ],
      })
    const eslintOut = json([{ filePath: abs('components/Cart.vue'), messages: [{ ruleId: 'no-undef', severity: 2, message: "'x' is not defined.", line: 3, column: 1 }] }])

    test('porte rouge : préexistante contre la base, typecheck nouveau, test instable relancé seul, durées, sorties écrites', async () => {
      const base: VerifBase = { commit: 'abc1234', le: 'x', commandes: ['eslint', 'typecheck'], signatures: ["eslint|components/Cart.vue|no-undef|'x' is not defined."] }
      const { io, calls, writes } = fakeIo(os, racine, (argv, _cwd, n) => {
        if (argv[1] === 'eslint') return { exitCode: 1, stdout: eslintOut, ms: 6000 }
        if (argv[1] === 'nuxi') return { exitCode: 2, stdout: "stores/booking/Cart.ts(12,5): error TS2322: Type 'null' is not assignable to type 'Cart'.", ms: 48_000 }
        if (argv[1] === 'vitest') return { exitCode: n === 1 ? 1 : 0, stdout: vitestOut(n === 1), ms: 14_000 }
        return { exitCode: 0 }
      })
      const progres: string[] = []
      const { resultat, verif } = await runGate(io, verifOf(NUXT_CMDS, [base]), {
        changed: ['components/Cart.vue', 'composables/useCart.ts'],
        files: ['components/Cart.vue', 'composables/useCart.ts', 'tests/useCart.spec.ts'],
        commit: 'abc1234def',
        onProgress: c => progres.push(`${c.id}:${c.etat}`),
      })
      expect(resultat.etat).toBe('rouge')
      expect(resultat.commandes.map(c => [c.id, c.etat, c.nouvelles, c.preexistantes, c.instables])).toEqual([
        ['codegen', 'saute', 0, 0, 0],
        ['eslint', 'ok', 0, 1, 0],
        ['typecheck', 'ko', 1, 0, 0],
        ['vitest', 'ok', 0, 0, 1],
      ])
      expect(progres).toEqual(['codegen:saute', 'eslint:en_cours', 'eslint:ok', 'typecheck:en_cours', 'typecheck:ko', 'vitest:en_cours', 'vitest:ok'])
      // Relance : même commande, le seul fichier de test rouge.
      const vit = calls.filter(c => c.argv.includes('vitest'))
      expect(vit).toHaveLength(2)
      expect(vit[1]!.argv.at(-1)).toBe('tests/useCart.spec.ts')
      expect(verif.instables).toEqual(['vitest|tests/useCart.spec.ts|echec|useCart total'])
      // Durées : moyenne glissante (40 s connus, 48 s mesurés) ; première mesure prise telle quelle.
      expect(durationOf(verif, 'typecheck')).toBe(Math.round(40_000 * 0.7 + 48_000 * 0.3))
      expect(durationOf(verif, 'eslint')).toBe(6000)
      expect(durationOf(verif, 'vitest')).toBe(28_000)
      expect(durationOf(verif, 'codegen')).toBeUndefined()
      // Délais : 3 × durée apprise, 10 min sans durée.
      expect(calls.find(c => c.argv.includes('nuxi'))!.timeoutMs).toBe(120_000)
      expect(calls.find(c => c.argv.includes('eslint'))!.timeoutMs).toBe(600_000)
      // Sorties complètes : un .txt par commande lancée, relance comprise.
      const sortie = resultat.commandes.find(c => c.id === 'vitest')!.sortie!
      expect(sortie).toBe([io.sorties, 'vitest.txt'].join(os.sep))
      expect(writes.get(sortie)).toContain('relance des tests rouges')
      expect(writes.has([io.sorties, 'codegen.txt'].join(os.sep))).toBe(false)
      expect(resultat.erreurs.map(e => `${e.outil}:${e.statut}`)).toEqual(['typecheck:nouvelle', 'vitest:instable', 'eslint:preexistante'])
      expect(reportText(resultat)).toContain('stores/booking/Cart.ts\n  l.12:5 TS2322')
    })

    test('Windows / macOS : cmd /c, cwd natif du paquet ; test toujours rouge à la relance → reste nouvelle ?', async () => {
      const ui = projet(os, 'application-mobile-ui')
      const cmds: VerifCommande[] = [{ id: 'flutter-test', outil: 'tests', argv: ['flutter', 'test', '--machine', '{fichiers}'], portee: 'lies', format: 'flutter-json', source: 'deduit' }]
      const t = ui.abs('packages/core/test/src/cart_test.dart')
      const out = [
        { suite: { id: 0, platform: 'vm', path: t }, type: 'suite' },
        { test: { id: 4, name: 'Panier total', suiteID: 0, line: 12 }, type: 'testStart' },
        { testID: 4, error: 'Expected: <45>', type: 'error' },
        { testID: 4, result: 'failure', skipped: false, hidden: false, type: 'testDone' },
      ]
        .map(json)
        .join('\r\n')
      const { io, calls } = fakeIo(os, ui.racine, () => ({ exitCode: 1, stdout: out }))
      const { resultat, verif } = await runGate(io, verifOf(cmds), {
        changed: ['packages/core/lib/src/cart.dart'],
        files: ['pubspec.yaml', 'packages/core/pubspec.yaml', 'packages/core/test/src/cart_test.dart'],
        commit: 'abc',
      })
      expect(calls).toHaveLength(2)
      expect(calls[0]!.argv).toEqual(os === WINDOWS ? ['cmd', '/c', 'flutter', 'test', '--machine', 'test/src/cart_test.dart'] : ['flutter', 'test', '--machine', 'test/src/cart_test.dart'])
      expect(calls[0]!.cwd).toBe(ui.abs('packages/core'))
      expect(resultat.erreurs.map(e => [e.fichier, e.statut])).toEqual([['packages/core/test/src/cart_test.dart', 'nouvelle?']])
      expect(verif.instables).toEqual([])
      expect(summaryLine(resultat)).toBe('non vérifié (flutter-test ✗)')
    })

    test('code de sortie non nul sans erreur lisible → erreur (pas ok), note, sortie écrite ; plantage de run → erreur', async () => {
      const cmds: VerifCommande[] = [
        { id: 'jest', outil: 'tests', argv: ['npx', 'jest', '--json', '--findRelatedTests', '{fichiers}'], portee: 'lies', format: 'jest-json', source: 'deduit' },
        { id: 'typecheck', outil: 'typage', argv: ['npx', 'tsc', '--noEmit'], portee: 'projet', format: 'tsc', source: 'deduit', dureeMs: 400_000 },
      ]
      const { io, writes } = fakeIo(os, racine, argv => (argv[1] === 'jest' ? { exitCode: 1, stderr: 'Error: Cannot find module \'ts-jest\'' } : new Error('Timed out after 600000 ms')))
      const { resultat, verif } = await runGate(io, verifOf(cmds), { changed: ['src/a.ts'], files: [], commit: 'c' })
      expect(resultat.etat).toBe('erreur')
      const jest = resultat.commandes.find(c => c.id === 'jest')!
      expect(jest.etat).toBe('erreur')
      expect(jest.note).toMatch(/code de sortie 1 sans erreur lisible/)
      expect(writes.get(jest.sortie!)).toContain("Cannot find module 'ts-jest'")
      const tsc = resultat.commandes.find(c => c.id === 'typecheck')!
      expect(tsc.etat).toBe('erreur')
      expect(tsc.note).toMatch(/au-delà de 5 min, à passer par spawn/)
      expect(tsc.note).toMatch(/délai dépassé \(10 min 00\)/)
      expect(durationOf(verif, 'typecheck')).toBe(400_000)
      expect(summaryLine(resultat)).toBe('non vérifié (typecheck, jest : erreur)')
    })

    test('seulement (vérification d’un agent) : sa portée, erreurs de typage d’un autre agent écartées', async () => {
      const { io, calls } = fakeIo(os, racine, argv => {
        if (argv[1] === 'eslint') return { exitCode: 0, stdout: '[]' }
        return { exitCode: 2, stdout: ["a.ts(1,1): error TS1: mine", "b.ts(1,1): error TS1: other agent", "c.ts(1,1): error TS1: untouched"].join('\n') }
      })
      const cmds = NUXT_CMDS.filter(c => c.id === 'eslint' || c.id === 'typecheck')
      const { resultat } = await runGate(io, verifOf(cmds), { changed: ['a.ts', 'b.ts'], files: [], commit: 'c', seulement: ['a.ts'] })
      expect(calls.find(c => c.argv.includes('eslint'))!.argv.at(-1)).toBe('a.ts')
      expect(resultat.erreurs.map(e => e.fichier)).toEqual(['a.ts', 'c.ts'])
    })

    test('runBase : lint et typage sur tout le projet, commande illisible hors base ; projectArgv', async () => {
      const cmds: VerifCommande[] = [
        ...NUXT_CMDS,
        { id: 'biome', outil: 'lint', argv: ['npx', 'biome', 'check', '{fichiers}'], portee: 'fichiers', format: 'biome', source: 'deduit' },
      ]
      const { io, calls, writes } = fakeIo(os, racine, argv => {
        if (argv[1] === 'eslint') return { exitCode: 1, stdout: eslintOut }
        if (argv[1] === 'nuxi') return { exitCode: 0, stdout: '' }
        return { exitCode: 1, stderr: 'biome: configuration invalide' }
      })
      const b = await runBase(io, verifOf(cmds), 'abc1234')
      expect(b.commit).toBe('abc1234')
      expect(b.commandes).toEqual(['eslint', 'typecheck'])
      expect(b.signatures).toEqual(["eslint|components/Cart.vue|no-undef|'x' is not defined."])
      expect(calls.map(c => c.argv.filter(x => x !== 'cmd' && x !== '/c').slice(1).join(' '))).toEqual(['eslint -f json .', 'nuxi typecheck', 'biome check .'])
      expect(calls.every(c => c.cwd === racine)).toBe(true)
      expect(writes.has([io.sorties, 'base-eslint.txt'].join(os.sep))).toBe(true)
      expect(projectArgv(NUXT_CMDS[2]!)).toBeUndefined()
      expect(projectArgv({ id: 'd', outil: 'typage', argv: ['dart', 'analyze', '--format=machine', '{fichiers}'], portee: 'fichiers', format: 'dart-machine', source: 'ci' })).toEqual(['dart', 'analyze', '--format=machine', '.'])
    })

    test('purgeOutputs : garde les plus récents ; timeoutOf borné à 10 min', async () => {
      const { io, removed } = fakeIo(os, racine, () => ({ exitCode: 0 }))
      const parent = native(os, '.claude', 'revo-flow', 'verif')
      expect(await purgeOutputs(io, parent, 2)).toBe(2)
      expect(removed).toEqual([[parent, '20261001-0900-a'].join(os.sep), [parent, '20261002-0900-b'].join(os.sep)])
      expect(await purgeOutputs({ ...io, list: undefined }, parent)).toBe(0)
      expect(timeoutOf(undefined)).toBe(600_000)
      expect(timeoutOf(10_000)).toBe(60_000)
      expect(timeoutOf(100_000)).toBe(300_000)
      expect(timeoutOf(900_000)).toBe(600_000)
    })
  })
}

// ── Score CRAP : détection et porte ───────────────────────────────────────

describe('score CRAP : détection', () => {
  test('vitest avec coverage-v8, jest, flutter test : flags de couverture avant les fichiers, commande crap en dernier ; dart test : rien', () => {
    const vitest = detectCommands({ stack: 'vitest', files: [], read: { 'package.json': pkg({ test: 'vitest run' }, { vitest: '^2.0.0', '@vitest/coverage-v8': '^2.0.0' }) } })
    expect(vitest.commandes.map(c => c.id)).toEqual(['vitest', 'crap'])
    const argv = byId(vitest.commandes, 'vitest')!.argv
    expect(argv.at(-1)).toBe('{fichiers}')
    expect(argv).toContain('--coverage.reportsDirectory={sorties}/couverture')
    expect(byId(vitest.commandes, 'crap')).toMatchObject({ outil: 'qualite', format: 'crap', argv: [], portee: 'fichiers', seuil: 30 })
    expect(vitest.pieges).toEqual([])

    const sans = detectCommands({ stack: 'vitest', files: [], read: { 'package.json': pkg({ test: 'vitest run' }, { vitest: '^2.0.0' }) } })
    expect(sans.commandes.map(c => c.id)).toEqual(['vitest'])
    expect(byId(sans.commandes, 'vitest')!.argv.some(t => t.includes('{sorties}'))).toBe(false)
    expect(sans.pieges.some(p => p.includes('@vitest/coverage-v8'))).toBe(true)

    const jest = detectCommands({ stack: 'Jest', files: [], read: { 'package.json': pkg({ test: 'jest' }, { jest: '^29.0.0' }) } })
    expect(jest.commandes.map(c => c.id)).toEqual(['jest', 'crap'])
    expect(byId(jest.commandes, 'jest')!.argv.slice(-2)).toEqual(['--findRelatedTests', '{fichiers}'])
    expect(byId(jest.commandes, 'jest')!.argv).toContain('--coverageDirectory={sorties}/couverture')

    const flutter = detectCommands({ stack: 'Flutter', files: ['pubspec.yaml', 'lib/main.dart', 'test/main_test.dart'], read: { 'pubspec.yaml': 'name: a\ndependencies:\n  flutter:\n    sdk: flutter\n' } })
    expect(flutter.commandes.map(c => c.id)).toEqual(['dart-analyze', 'flutter-test', 'crap'])
    expect(byId(flutter.commandes, 'flutter-test')!.argv.at(-1)).toBe('{fichiers}')
    const dart = detectCommands({ stack: 'Dart', files: ['pubspec.yaml', 'lib/a.dart', 'test/a_test.dart'], read: { 'pubspec.yaml': 'name: a\n' } })
    expect(dart.commandes.map(c => c.id)).toEqual(['dart-analyze', 'dart-test'])

    const off = detectCommands({ crap: false, stack: 'Jest', files: [], read: { 'package.json': pkg({ test: 'jest' }, { jest: '^29.0.0' }) } })
    expect(off.commandes.map(c => c.id)).toEqual(['jest'])
    expect(withoutCrap(jest.commandes)).toEqual(off.commandes)
  })

  test('question, libellé et argv lisibles ; {sorties} remplacé à l’exécution au séparateur de l’hôte', () => {
    const { commandes } = detectCommands({ stack: 'Jest', files: [], read: { 'package.json': pkg({ test: 'jest' }, { jest: '^29.0.0' }) } })
    const crap = byId(commandes, 'crap')!
    expect(commandLabel(crap)).toBe('crap · score CRAP sur les fonctions modifiées')
    const q = commandsQuestion('app', commandes, [])
    expect(q).toContain('crap · score CRAP sur les fonctions modifiées : complexité × couverture des tests liés, seuil 30')
    expect(q).toContain('--coverageDirectory=<sorties>/couverture')
    expect(argvText(['a', '{sorties}/x', '{fichiers}'])).toBe('a <sorties>/x <fichiers>')
    expect(fillSorties({ os: 'windows', sorties: 'C:\\v\\f1' }, ['--coverage-path={sorties}/couverture/lcov.info', 'x'])).toEqual(['--coverage-path=C:\\v\\f1\\couverture\\lcov.info', 'x'])
    expect(fillSorties({ os: 'posix', sorties: '/v/f1' }, ['--coverageDirectory={sorties}/couverture'])).toEqual(['--coverageDirectory=/v/f1/couverture'])
  })
})

for (const os of OSES) {
  describe(`score CRAP : porte (${os.nom})`, () => {
    const { racine, abs } = projet(os)
    // Deux fonctions de complexité 6 (cinq if) : sans test, CRAP 42 > 30.
    const fn = (nom: string, extra = '') =>
      [`export function ${nom}(a: number) {`, '  let n = 0', '  if (a > 1) n++', '  if (a > 2) n++', '  if (a > 3) n++', '  if (a > 4) n++', `  if (a > 5) n++${extra}`, '  return n', '}'].join('\n')
    const avant = `${fn('vieux')}\n\n${fn('neuf')}\n`
    const maintenant = `${fn('vieux')}\n\n${fn('neuf', ' // modifiée')}\n`
    const JEST: VerifCommande[] = [
      { id: 'jest', outil: 'tests', argv: ['npx', 'jest', '--json', '--coverage', '--coverageReporters=json', '--coverageDirectory={sorties}/couverture', '--findRelatedTests', '{fichiers}'], portee: 'lies', format: 'jest-json', source: 'deduit' },
      { id: 'crap', outil: 'qualite', argv: [], portee: 'fichiers', format: 'crap', source: 'deduit', seuil: 30 },
    ]
    const jestOk = json({ success: true, testResults: [] })
    /** Couverture istanbul : chaque ligne 1..19 instrumentée ; couvertes = lignes exécutées. */
    const istanbul = (couvertes: (l: number) => boolean) => {
      const statementMap: Record<string, { start: { line: number }; end: { line: number } }> = {}
      const hits: Record<string, number> = {}
      for (let l = 1; l <= 19; l++) {
        statementMap[String(l)] = { start: { line: l }, end: { line: l } }
        hits[String(l)] = couvertes(l) ? 1 : 0
      }
      return json({ [abs('src/calc.ts')]: { path: abs('src/calc.ts'), statementMap, s: hits } })
    }
    const ioCrap = (couverture: string | undefined) => {
      const f = fakeIo(os, racine, argv => (argv[1] === 'jest' ? { exitCode: 0, stdout: jestOk } : { exitCode: 0 }))
      const lus: string[] = []
      const io: VerifIo = {
        ...f.io,
        async list(dir) {
          return dir.endsWith('couverture') && couverture ? ['coverage-final.json'] : []
        },
        async read(path) {
          lus.push(path)
          if (path.endsWith('coverage-final.json')) return couverture!
          if (path === abs('src/calc.ts')) return maintenant
          throw new Error('absent')
        },
        async show(commit, rel) {
          return commit === 'abc1234' && rel === 'src/calc.ts' ? avant : undefined
        },
      }
      return { ...f, io, lus }
    }

    test('fonction modifiée non couverte : nouvelle, porte rouge ; fonction intacte : préexistante ; crap.txt écrit', async () => {
      const { io, calls, writes, removed } = ioCrap(istanbul(() => false))
      const { resultat } = await runGate(io, verifOf(JEST), { changed: ['src/calc.ts'], files: ['src/calc.ts', 'src/calc.test.ts'], commit: 'abc1234' })
      expect(calls[0]!.argv).toContain(`--coverageDirectory=${[io.sorties, 'couverture'].join(os.sep)}`)
      expect(removed).toEqual([[io.sorties, 'couverture'].join(os.sep)])
      expect(resultat.etat).toBe('rouge')
      expect(resultat.commandes.map(c => [c.id, c.etat])).toEqual([
        ['jest', 'ok'],
        ['crap', 'ko'],
      ])
      const crap = resultat.erreurs.filter(e => e.outil === 'crap')
      expect(crap.map(e => [e.message.split(' :')[0], e.statut])).toEqual([
        ['neuf', 'nouvelle'],
        ['vieux', 'preexistante'],
      ].sort((a, b) => (a[1]! < b[1]! ? -1 : 1)))
      expect(resultat.commandes[1]).toMatchObject({ nouvelles: 1, preexistantes: 1, fichiers: 1 })
      expect(writes.has([io.sorties, 'crap.txt'].join(os.sep))).toBe(true)
    })

    test('fonction modifiée couverte : vert ; sans rapport de couverture, sans tests lancés ou sans read/show : sautée', async () => {
      const couverte = ioCrap(istanbul(l => l >= 11))
      const vert = await runGate(couverte.io, verifOf(JEST), { changed: ['src/calc.ts'], files: [], commit: 'abc1234' })
      expect(vert.resultat.etat).toBe('vert')
      expect(vert.resultat.commandes[1]).toMatchObject({ id: 'crap', etat: 'ok', nouvelles: 0, preexistantes: 1 })

      const sansRapport = ioCrap(undefined)
      const r1 = await runGate(sansRapport.io, verifOf(JEST), { changed: ['src/calc.ts'], files: [], commit: 'abc1234' })
      expect(r1.resultat.etat).toBe('vert')
      expect(r1.resultat.commandes[1]).toMatchObject({ etat: 'saute' })
      expect(r1.resultat.commandes[1]!.note).toMatch(/pas de couverture/)

      const r2 = await runGate(couverte.io, verifOf([JEST[1]!]), { changed: ['src/calc.ts'], files: [], commit: 'abc1234' })
      expect(r2.resultat.commandes[0]).toMatchObject({ etat: 'saute', note: 'pas de couverture : tests non lancés' })

      const r3 = await runGate({ ...couverte.io, show: undefined }, verifOf(JEST), { changed: ['src/calc.ts'], files: [], commit: 'abc1234' })
      expect(r3.resultat.commandes[1]).toMatchObject({ etat: 'saute' })
      const r4 = await runGate(couverte.io, verifOf(JEST), { changed: ['src/calc.test.ts', 'README.md'], files: [], commit: 'abc1234' })
      expect(r4.resultat.commandes.find(c => c.id === 'crap')).toMatchObject({ etat: 'saute', note: 'aucun fichier analysable' })
    })
  })
}
