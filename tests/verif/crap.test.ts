// Le score CRAP (C2 à C7) : formule, complexité par fonction, couverture, erreurs, détection et porte.
// Les fixtures sont inline ; les lignes et les complexités attendues sont calculées à la main, en commentaire.
import { describe, expect, test } from 'claude-code/testing'

import type { ProjetVerif, VerifCommande } from '../../types/verif'
import { CRAP_SEUIL, analysable, coverageArgs, coverageFiles, coverageFormatOf, coverageOf, crapErreurs, crapOf, crapScore, crapText, fnCoverage, functionsOf, langOf, mergeCoverage } from '../../hooks/verif/crap'
import { detectCommands } from '../../hooks/verif/detect'
import { runGate, type VerifIo } from '../../hooks/verif/runner'
import { OSES, WINDOWS, native, type Os } from '../helpers/os'

const json = (x: unknown) => JSON.stringify(x)
const lignes = (...l: string[]) => l.join('\n')
const pkg = (scripts: Record<string, string>, devDependencies: Record<string, string>) => json({ name: 'app', scripts, dependencies: {}, devDependencies })
const byId = (cs: VerifCommande[], id: string) => cs.find(c => c.id === id)
const plain = (c: Map<string, Map<number, number>>) => Object.fromEntries([...c].map(([f, m]) => [f, Object.fromEntries(m)]))
const near = (got: number | undefined, want: number) => expect(Math.abs((got ?? Number.NaN) - want) < 1e-6).toBe(true)
const fnOf = (fns: { nom: string }[], nom: string) => fns.find(f => f.nom === nom || f.nom.endsWith(`.${nom}`))

// ── C2 : la formule ───────────────────────────────────────────────────────

describe('crapScore', () => {
  test('C2 : crapScore(5, 0) vaut 30', () => near(crapScore(5, 0), 30))
  test('C2 : crapScore(10, 1) vaut 10', () => near(crapScore(10, 1), 10))
  test('C2 : crapScore(10, 0.5) vaut 22,5', () => near(crapScore(10, 0.5), 22.5))
  test('C2 : le seuil est 30 ; cc 1 sans couverture reste à 2', () => {
    expect(CRAP_SEUIL).toBe(30)
    near(crapScore(1, 0), 2)
  })
})

describe('langOf et analysable', () => {
  test('C3 : langages par extension', () => {
    expect(langOf('a.vue')).toBe('ts')
    expect(langOf('src/a.ts')).toBe('ts')
    expect(langOf('a.dart')).toBe('dart')
    expect(langOf('a.md')).toBeUndefined()
  })
  test('C3 : tests, Dart générés et déclarations exclus', () => {
    expect(analysable('a.test.ts')).toBe(false)
    expect(analysable('lib/x.g.dart')).toBe(false)
    expect(analysable('types/a.d.ts')).toBe(false)
    expect(analysable('src/a.ts')).toBe(true)
  })
})

// ── C3 : functionsOf ──────────────────────────────────────────────────────

// Lignes numérotées en commentaire de fin de ligne n'existent pas : le tableau ci-dessous suit les numéros du bloc « attendu » plus bas.
const TS = lignes(
  /* 1 */ 'function simple(a: number) {',
  /* 2 */ '  return a',
  /* 3 */ '}',
  /* 4 */ '',
  /* 5 */ 'export async function chain(a: number, b: string, c?: number) {',
  /* 6 */ '  if (a > 1 && b) {',
  /* 7 */ '    return 1',
  /* 8 */ '  } else if (a < 0 || c) {',
  /* 9 */ '    return 2',
  /* 10 */ '  }',
  /* 11 */ '  for (let i = 0; i < a; i++) {',
  /* 12 */ '    while (c) { c-- }',
  /* 13 */ '  }',
  /* 14 */ '  const z = c ?? 3',
  /* 15 */ '  return a ? z : 0',
  /* 16 */ '}',
  /* 17 */ '',
  /* 18 */ 'class K {',
  /* 19 */ '  method(x: number) {',
  /* 20 */ '    switch (x) {',
  /* 21 */ '      case 1:',
  /* 22 */ "        return 'a'",
  /* 23 */ '      case 2:',
  /* 24 */ "        return 'b'",
  /* 25 */ '      default:',
  /* 26 */ "        return 'c'",
  /* 27 */ '    }',
  /* 28 */ '  }',
  /* 29 */ '  other(s: string) {',
  /* 30 */ '    try {',
  /* 31 */ '      return JSON.parse(s)',
  /* 32 */ '    } catch (e) {',
  /* 33 */ '      return undefined',
  /* 34 */ '    }',
  /* 35 */ '  }',
  /* 36 */ '}',
  /* 37 */ '',
  /* 38 */ 'const arrow = async (n: number) => {',
  /* 39 */ "  const s = 'if (a && b) { while (x) {} ? 1 : 2'",
  /* 40 */ '  // if (x) { for (;;) while (y) a && b || c ?? d }',
  /* 41 */ '  const t = `v ${n} if (a) && ${s}`',
  /* 42 */ '  return [1, 2].map(v => { if (v) { return v } return 0 })',
  /* 43 */ '}',
  /* 44 */ '',
  /* 45 */ 'export default function () {',
  /* 46 */ '  return 1',
  /* 47 */ '}',
  /* 48 */ '',
  /* 49 */ 'function loop(x: number) {',
  /* 50 */ '  do {',
  /* 51 */ '    x++',
  /* 52 */ '  } while (x < 3)',
  /* 53 */ '  return x',
  /* 54 */ '}',
)

describe('functionsOf (TypeScript)', () => {
  const fns = functionsOf(TS, 'ts')
  const at = (nom: string) => {
    const f = fnOf(fns, nom)
    return f && { debut: f.debut, fin: f.fin, cc: f.cc }
  }

  test('C3 : fonction simple, cc 1', () => expect(at('simple')).toEqual({ debut: 1, fin: 3, cc: 1 }))
  // chain : 1 + if + && + else if + || + for + while + ?? + ternaire = 9 ; « c?: number » et les mots-clés absents du code ne comptent pas.
  test('C3 : async avec if, else if, for, while, &&, ||, ??, ternaire : cc 9', () => expect(at('chain')).toEqual({ debut: 5, fin: 16, cc: 9 }))
  // method : 1 + case 1 + case 2 (default ne compte pas) = 3.
  test('C3 : méthode de classe, switch : case compte, default non (cc 3)', () => expect(at('method')).toEqual({ debut: 19, fin: 28, cc: 3 }))
  // other : 1 + catch = 2 (try ne compte pas).
  test('C3 : méthode avec try / catch : cc 2', () => expect(at('other')).toEqual({ debut: 29, fin: 35, cc: 2 }))
  // arrow : 1 + le if du callback imbriqué = 2 ; la string (l.39), le commentaire (l.40) et le template (l.41) n'ajoutent rien.
  test('C3 : fléchée affectée, chaînes, commentaire, template et callback imbriqué : cc 2', () => expect(at('arrow')).toEqual({ debut: 38, fin: 43, cc: 2 }))
  test('C3 : fonction anonyme nommée « (anonyme l.N) »', () => {
    const f = fns.find(x => x.debut === 45)
    expect(f).toMatchObject({ nom: '(anonyme l.45)', fin: 47, cc: 1 })
  })
  // loop : 1 + do…while compté une fois = 2.
  test('C3 : do…while compte une fois : cc 2', () => expect(at('loop')).toEqual({ debut: 49, fin: 54, cc: 2 }))
  test('C3 : la classe elle-même n\'est pas une fonction', () => expect(fns.some(f => f.nom === 'K')).toBe(false))
  test('C3 : `?.`, `?:` d\'un paramètre et `T?>` ne comptent pas', () => {
    const f = functionsOf(lignes('function a(x?: number, y: Array<string | undefined>, o?: { v: number }) {', '  return o?.v', '}'), 'ts')
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ nom: 'a', debut: 1, fin: 3, cc: 1 })
  })
  test('C3 : texte mal formé (accolade non fermée) : pas d\'exception', () => {
    expect(() => functionsOf('function a() {\n  if (x) {\n', 'ts')).not.toThrow()
    expect(Array.isArray(functionsOf('function a() {\n  if (x) {\n', 'ts'))).toBe(true)
    expect(() => functionsOf('}}} ) ( `${ "', 'ts')).not.toThrow()
  })
})

// toggle : 1 + if + && = 3 ; le ternaire du <template> ne compte pas, les lignes d'origine sont gardées (l.7 à 12).
const VUE = lignes(
  /* 1 */ '<template>',
  /* 2 */ '  <div v-if="a">{{ a ? 1 : 2 }}</div>',
  /* 3 */ '</template>',
  /* 4 */ '',
  /* 5 */ '<script setup lang="ts">',
  /* 6 */ 'const props = defineProps<{ a: boolean }>()',
  /* 7 */ 'function toggle(v: boolean) {',
  /* 8 */ '  if (v && props.a) {',
  /* 9 */ '    return 1',
  /* 10 */ '  }',
  /* 11 */ '  return 0',
  /* 12 */ '}',
  /* 13 */ '</script>',
)

describe('functionsOf (Vue)', () => {
  test('C3 : seul le bloc script setup compte, lignes d\'origine conservées', () => {
    const fns = functionsOf(VUE, 'ts')
    expect(fns.map(f => [f.nom, f.debut, f.fin, f.cc])).toEqual([['toggle', 7, 12, 3]])
  })
})

const DART = lignes(
  /* 1 */ 'class Cart {',
  /* 2 */ '  int total(List<int> xs, String? label) {',
  /* 3 */ '    var t = 0;',
  /* 4 */ '    for (final x in xs) {',
  /* 5 */ '      if (x > 0 && t < 100) {',
  /* 6 */ '        t += x;',
  /* 7 */ '      }',
  /* 8 */ '    }',
  /* 9 */ '    // if (x) { while (y) }',
  /* 10 */ "    final s = r'if (a) { && }';",
  /* 11 */ '    return t > 0 ? t : (label?.length ?? 0);',
  /* 12 */ '  }',
  /* 13 */ '',
  /* 14 */ '  Future<void> safe() async {',
  /* 15 */ '    try {',
  /* 16 */ '      await run();',
  /* 17 */ '    } on FormatException catch (e) {',
  /* 18 */ '      print(e);',
  /* 19 */ '    }',
  /* 20 */ '  }',
  /* 21 */ '}',
  /* 22 */ '',
  /* 23 */ '/// if (x) while (y) { && ||',
  /* 24 */ 'int top(int a) {',
  /* 25 */ '  if (a > 1) {',
  /* 26 */ '    return 1;',
  /* 27 */ '  } else if (a < 0) {',
  /* 28 */ '    return 2;',
  /* 29 */ '  }',
  /* 30 */ '  return 0;',
  /* 31 */ '}',
)

describe('functionsOf (Dart)', () => {
  const fns = functionsOf(DART, 'dart')
  const at = (nom: string) => {
    const f = fnOf(fns, nom)
    return f && { debut: f.debut, fin: f.fin, cc: f.cc }
  }
  // total : 1 + for + if + && + ternaire + ?? = 6 ; `String? label` (type) et `label?.length` ne comptent pas ; r'…' et // sont ignorés.
  test('C3 : méthode Dart, for, if, &&, ternaire, ?? : cc 6, `?.` et `String?` ne comptent pas', () => expect(at('total')).toEqual({ debut: 2, fin: 12, cc: 6 }))
  // safe : 1 + `on … catch` = 2 (try ne compte pas).
  test('C3 : `on … catch` compte une fois : cc 2', () => expect(at('safe')).toEqual({ debut: 14, fin: 20, cc: 2 }))
  // top : 1 + if + else if = 3 ; le commentaire /// avant n'ajoute rien.
  test('C3 : fonction de niveau supérieur, else if, commentaire /// : cc 3', () => expect(at('top')).toEqual({ debut: 24, fin: 31, cc: 3 }))
  test('C3 : texte Dart mal formé : pas d\'exception', () => expect(() => functionsOf('int a() {\n if (x) {', 'dart')).not.toThrow())
})

// ── C4 : couverture ───────────────────────────────────────────────────────

describe('couverture', () => {
  const stmt = (l: number, l2 = l) => ({ start: { line: l }, end: { line: l2 } })

  for (const os of OSES) {
    const racine = native(os, 'proj')
    const abs = (rel: string) => [racine, ...rel.split('/')].join(os.sep)
    const istanbul = json({ [abs('src/a.ts')]: { path: abs('src/a.ts'), statementMap: { 0: stmt(1), 1: stmt(2), 2: stmt(3) }, s: { 0: 1, 1: 0, 2: 4 } } })
    const lcov = ['TN:', 'SF:src/a.ts', 'DA:1,1', 'DA:2,0', 'DA:3,4', 'end_of_record', ''].join('\r\n')
    const attendu = { 'src/a.ts': { 1: 1, 2: 0, 3: 4 } }

    test(`C4 : coverage-final.json (istanbul, chemin absolu sous la racine) → fichier relatif → ligne → hits (${os.nom})`, () => {
      expect(plain(coverageOf(istanbul, 'istanbul', { racine, cwd: racine }))).toEqual(attendu)
    })

    test(`C4 : lcov.info (SF relatif au cwd, CRLF) → la même carte (${os.nom})`, () => {
      expect(plain(coverageOf(lcov, 'lcov', { racine, cwd: racine }))).toEqual(attendu)
    })

    test(`C4 : JSON invalide → carte vide (${os.nom})`, () => {
      expect(coverageOf('{pas du json', 'istanbul', { racine, cwd: racine }).size).toBe(0)
    })
  }

  test('C4 : plusieurs lignes d\'un statement multi-ligne ; le statement le plus interne l\'emporte sur une ligne partagée', () => {
    const racine = '/proj'
    const t = json({ '/proj/src/a.ts': { path: '/proj/src/a.ts', statementMap: { 0: stmt(1, 3), 1: stmt(2) }, s: { 0: 5, 1: 0 } } })
    expect(plain(coverageOf(t, 'istanbul', { racine, cwd: racine }))).toEqual({ 'src/a.ts': { 1: 5, 2: 0, 3: 5 } })
  })

  test('C4 : coverageFormatOf', () => {
    expect(coverageFormatOf('coverage-final.json')).toBe('istanbul')
    expect(coverageFormatOf('lcov.info')).toBe('lcov')
    expect(coverageFormatOf('index.html')).toBeUndefined()
  })

  test('C4 : coverageFiles ne garde que les noms lisibles', () => {
    expect(coverageFiles(['coverage-final.json', 'index.html', 'lcov.info', 'x.txt'])).toEqual(['coverage-final.json', 'lcov.info'])
  })

  test('C4 : mergeCoverage prend le max par ligne', () => {
    const into = new Map([['a.ts', new Map([[1, 0], [2, 3]])]])
    const from = new Map([['a.ts', new Map([[1, 2], [2, 1], [4, 1]])], ['b.ts', new Map([[1, 1]])]])
    const m = mergeCoverage(into, from)
    expect(plain(m)).toEqual({ 'a.ts': { 1: 2, 2: 3, 4: 1 }, 'b.ts': { 1: 1 } })
  })

  test('C4 : fnCoverage = part des lignes instrumentées de [debut, fin] touchées', () => {
    const fn = { nom: 'f', debut: 1, fin: 4, cc: 2 }
    // lignes 1, 2, 3 instrumentées dans la fonction (2 touchées) ; la ligne 9 est hors de la fonction.
    near(fnCoverage(fn, new Map([[1, 1], [2, 0], [3, 2], [9, 0]])), 2 / 3)
    expect(fnCoverage(fn, new Map([[9, 1]]))).toBeUndefined()
    expect(fnCoverage(fn, undefined)).toBeUndefined()
  })
})

// ── C5 : crapOf, crapErreurs, crapText, coverageArgs ──────────────────────

// risky : 1 + if + && + else if + || + for + while + ?? + ternaire = 9 ; sans couverture CRAP = 81 + 9 = 90.
const RISKY = lignes(
  /* 1 */ 'export function risky(a: number, b: string, c: number) {',
  /* 2 */ '  if (a > 1 && b) {',
  /* 3 */ '    return 1',
  /* 4 */ '  } else if (a < 0 || c) {',
  /* 5 */ '    return 2',
  /* 6 */ '  }',
  /* 7 */ '  for (let i = 0; i < a; i++) {',
  /* 8 */ '    c++',
  /* 9 */ '  }',
  /* 10 */ '  while (c > 10) { c-- }',
  /* 11 */ '  const z = c ?? 3',
  /* 12 */ '  return a ? z : 0',
  /* 13 */ '}',
)
const RISKY_AVANT = RISKY.replace('return 2', 'return 3')
const couvDe = (hits: number) => new Map([['src/risky.ts', new Map(Array.from({ length: 11 }, (_, i) => [i + 2, hits] as [number, number]))]])
// mid : 1 + trois if = 4 ; non couverte : 16 + 4 = 20.
const MID = lignes('export function mid(a: number, b: number) {', '  if (a) { return 1 }', '  if (b) { return 2 }', '  if (a + b) { return 3 }', '  return 0', '}')
// cinq : 1 + quatre if = 5 ; non couverte : 25 + 5 = 30 pile, pas au-dessus du seuil.
const CINQ = lignes('export function cinq(a: number, b: number) {', '  if (a) { return 1 }', '  if (b) { return 2 }', '  if (a + b) { return 3 }', '  if (a - b) { return 4 }', '  return 0', '}')

describe('crapOf et crapErreurs', () => {
  test('C5 : cc 9 non couverte, modifiée depuis `avant` → une erreur nouvelle', () => {
    const fns = crapOf('src/risky.ts', RISKY, RISKY_AVANT, couvDe(0), 'ts')
    const f = fnOf(fns, 'risky')!
    expect(f).toMatchObject({ debut: 1, fin: 13, cc: 9, touchee: true })
    near(f.crap, 90)
    const erreurs = crapErreurs('src/risky.ts', fns)
    expect(erreurs).toHaveLength(1)
    expect(erreurs[0]).toMatchObject({ outil: 'crap', code: 'CRAP', ligne: 1, statut: 'nouvelle', fichier: 'src/risky.ts' })
    expect(erreurs[0]!.message).toContain('risky')
    expect(erreurs[0]!.message).toContain('CRAP 90')
    expect(erreurs[0]!.message).toContain('complexité 9')
  })

  test('C5 : fonction identique dans `avant`, CRAP > 30 → preexistante', () => {
    const fns = crapOf('src/risky.ts', RISKY, RISKY, couvDe(0), 'ts')
    expect(fns[0]!.touchee).toBe(false)
    const erreurs = crapErreurs('src/risky.ts', fns)
    expect(erreurs).toHaveLength(1)
    expect(erreurs[0]).toMatchObject({ code: 'CRAP', statut: 'preexistante', ligne: 1 })
  })

  test('C5 : `avant` undefined (fichier nouveau) → nouvelle', () => {
    const erreurs = crapErreurs('src/risky.ts', crapOf('src/risky.ts', RISKY, undefined, couvDe(0), 'ts'))
    expect(erreurs.map(e => e.statut)).toEqual(['nouvelle'])
  })

  test('C5 : cc 4 non couverte (CRAP 20) → aucune erreur', () => {
    const fns = crapOf('src/mid.ts', MID, undefined, new Map(), 'ts')
    near(fnOf(fns, 'mid')!.crap, 20)
    expect(crapErreurs('src/mid.ts', fns)).toEqual([])
  })

  test('C5 : CRAP égal au seuil (cc 5 non couverte = 30) → aucune erreur', () => {
    const fns = crapOf('src/cinq.ts', CINQ, undefined, new Map(), 'ts')
    near(fnOf(fns, 'cinq')!.crap, 30)
    expect(crapErreurs('src/cinq.ts', fns)).toEqual([])
  })

  test('C5 : cc 9 couverte à 100 % (CRAP 9) → aucune erreur', () => {
    const fns = crapOf('src/risky.ts', RISKY, undefined, couvDe(3), 'ts')
    const f = fnOf(fns, 'risky')!
    near(f.cov, 1)
    near(f.crap, 9)
    expect(crapErreurs('src/risky.ts', fns)).toEqual([])
  })

  test('C5 : crapText contient la formule et la table des fonctions', () => {
    const fns = crapOf('src/risky.ts', RISKY, undefined, couvDe(0), 'ts')
    const t = crapText([{ fichier: 'src/risky.ts', fns }])
    expect(t).toContain('src/risky.ts')
    expect(t).toContain('risky')
    expect(t).toContain('1-13')
    expect(t).toContain('90')
    expect(t).toContain('CRAP = cc² × (1 − couverture)³ + cc')
    expect(t).toContain('fonction')
    expect(t).toContain('couverture')
  })

  test('C5 : coverageArgs de vitest, jest et flutter', () => {
    expect(coverageArgs('vitest', '/d')).toEqual(['--coverage.enabled=true', '--coverage.reporter=json', '--coverage.reportsDirectory=/d'])
    expect(coverageArgs('jest', '/d')).toEqual(['--coverage', '--coverageReporters=json', '--coverageDirectory=/d'])
    expect(coverageArgs('flutter', '/d')).toEqual(['--coverage', '--coverage-path=/d/lcov.info'])
  })
})

// ── C6 : detectCommands ───────────────────────────────────────────────────

describe('detectCommands et le score CRAP', () => {
  const vitestPkg = (dev: Record<string, string>) => ({ 'package.json': pkg({ test: 'vitest' }, { vitest: '^2.1.0', ...dev }) })

  test('C6 : vitest avec @vitest/coverage-v8 → commande crap et flags de couverture avant {fichiers}', () => {
    const { commandes } = detectCommands({ stack: 'TypeScript, vitest', files: ['src/a.ts'], read: vitestPkg({ '@vitest/coverage-v8': '^2.1.0' }) })
    expect(byId(commandes, 'crap')).toMatchObject({ id: 'crap', outil: 'qualite', format: 'crap', portee: 'fichiers', argv: [] })
    const argv = byId(commandes, 'vitest')!.argv
    expect(argv).toContain('--coverage.enabled=true')
    expect(argv).toContain('--coverage.reportsDirectory={sorties}/couverture')
    expect(argv.indexOf('--coverage.enabled=true')).toBeLessThan(argv.indexOf('{fichiers}'))
    expect(argv.indexOf('--coverage.reportsDirectory={sorties}/couverture')).toBeLessThan(argv.indexOf('{fichiers}'))
  })

  test('C6 : vitest sans lib de couverture → pas de commande crap, un piège cite @vitest/coverage-v8', () => {
    const { commandes, pieges } = detectCommands({ stack: 'TypeScript, vitest', files: ['src/a.ts'], read: vitestPkg({}) })
    expect(byId(commandes, 'crap')).toBeUndefined()
    expect(byId(commandes, 'vitest')!.argv.some(t => t.startsWith('--coverage'))).toBe(false)
    expect(pieges.join('\n')).toContain('@vitest/coverage-v8')
  })

  test('C6 : jest → commande crap et --coverage dans l\'argv', () => {
    const { commandes } = detectCommands({ stack: 'Jest', files: ['src/a.js'], read: { 'package.json': pkg({ test: 'jest' }, { jest: '^29.0.0' }) } })
    expect(byId(commandes, 'crap')).toMatchObject({ outil: 'qualite', format: 'crap', portee: 'fichiers', argv: [] })
    expect(byId(commandes, 'jest')!.argv).toContain('--coverage')
  })

  test('C6 : crap: false → ni commande crap ni flags', () => {
    const { commandes } = detectCommands({ stack: 'TypeScript, vitest', files: ['src/a.ts'], read: vitestPkg({ '@vitest/coverage-v8': '^2.1.0' }), crap: false })
    expect(byId(commandes, 'crap')).toBeUndefined()
    expect(byId(commandes, 'vitest')!.argv.some(t => t.includes('coverage'))).toBe(false)
    const jest = detectCommands({ stack: 'Jest', files: [], read: { 'package.json': pkg({ test: 'jest' }, { jest: '^29.0.0' }) }, crap: false })
    expect(byId(jest.commandes, 'crap')).toBeUndefined()
    expect(byId(jest.commandes, 'jest')!.argv).not.toContain('--coverage')
  })

  test('C6 : flutter test → commande crap et --coverage-path={sorties}/couverture/lcov.info', () => {
    const read = { 'pubspec.yaml': ['name: router_app', 'dependencies:', '  flutter:', '    sdk: flutter'].join('\n') }
    const { commandes } = detectCommands({ stack: 'Flutter, Supabase', files: ['pubspec.yaml', 'lib/main.dart', 'test/router_test.dart'], read })
    expect(byId(commandes, 'crap')).toMatchObject({ outil: 'qualite', format: 'crap', argv: [] })
    const argv = byId(commandes, 'flutter-test')!.argv
    expect(argv).toContain('--coverage')
    expect(argv).toContain('--coverage-path={sorties}/couverture/lcov.info')
  })
})

// ── C7 : runGate ──────────────────────────────────────────────────────────

type Reponse = { exitCode: number; stdout?: string; stderr?: string; ms?: number } | Error

/** Le faux moteur de coeur.test.ts, étendu de read, show et d'un list qui rend coverage-final.json pour <sorties>/couverture. */
function fakeIo(os: Os, racine: string, repond: (argv: string[]) => Reponse, fichiers: { read: (p: string) => string | undefined; show: (commit: string, rel: string) => string | undefined }) {
  let clock = Date.UTC(2026, 9, 25, 10)
  const calls: { argv: string[]; cwd: string }[] = []
  const writes = new Map<string, string>()
  const io: VerifIo = {
    os: os === WINDOWS ? 'windows' : 'posix',
    racine,
    sorties: native(os, '.claude', 'revo-flow', 'verif', '20261025-1000-f1'),
    async run(argv, init) {
      calls.push({ argv, cwd: init.cwd })
      const nu = argv[0] === 'cmd' ? argv.slice(2) : argv
      const r = repond(nu)
      clock += 2000
      if (r instanceof Error) throw r
      return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    async write(path, text) {
      writes.set(path, text)
    },
    async list(dir) {
      return dir.replace(/\\/g, '/').endsWith('/couverture') ? ['coverage-final.json'] : []
    },
    async remove() {},
    async now() {
      return clock
    },
    async read(path) {
      const t = fichiers.read(path.replace(/\\/g, '/'))
      if (t === undefined) throw new Error(`ENOENT ${path}`)
      return t
    },
    async show(commit, rel) {
      return fichiers.show(commit, rel)
    },
  }
  return { io, calls, writes }
}

const verifOf = (commandes: VerifCommande[]): ProjetVerif => ({ commandes, manifestes: {}, confirme: { le: 'x', par: 'utilisateur' }, instables: [], pieges: [], bases: [] })
const COUV_ARGS = coverageArgs('vitest', '{sorties}/couverture')
const CMDS: VerifCommande[] = [
  { id: 'crap', outil: 'qualite', argv: [], portee: 'fichiers', format: 'crap', source: 'deduit' },
  { id: 'vitest', outil: 'tests', argv: ['npx', 'vitest', 'related', '--run', '--reporter=json', '--passWithNoTests', ...COUV_ARGS, '{fichiers}'], portee: 'lies', format: 'vitest-json', source: 'deduit' },
]

for (const os of OSES) {
  describe(`runGate et le score CRAP (${os.nom})`, () => {
    const racine = native(os, 'Documents', 'Front', 'app')
    const abs = (rel: string) => [racine, ...rel.split('/')].join(os.sep)
    const vitestVert = json({
      success: true,
      testResults: [{ name: abs('tests/risky.spec.ts'), status: 'passed', message: '', assertionResults: [{ ancestorTitles: ['risky'], title: 'ok', fullName: 'risky ok', status: 'passed', failureMessages: [] }] }],
    })
    const stmt = (l: number) => ({ start: { line: l }, end: { line: l } })
    const couverture = json({ [abs('src/risky.ts')]: { path: abs('src/risky.ts'), statementMap: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(i), stmt(i + 2)])), s: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(i), 0])) } })
    const lecture = (p: string) => (p.endsWith('coverage-final.json') ? couverture : p.endsWith('src/risky.ts') ? RISKY : undefined)
    const run = (argv: string[]): Reponse => (argv.includes('vitest') ? { exitCode: 0, stdout: vitestVert } : { exitCode: 0 })
    const entree = { changed: ['src/risky.ts'], files: ['src/risky.ts', 'tests/risky.spec.ts'], commit: 'abc1234def' }

    test('C7 : fonction cc 9 modifiée sans couverture → crap après vitest, ko, nouvelle, porte rouge, {sorties} remplacé', async () => {
      const { io, calls } = fakeIo(os, racine, run, { read: lecture, show: () => RISKY_AVANT })
      const { resultat } = await runGate(io, verifOf(CMDS), entree)
      const ids = resultat.commandes.map(c => c.id)
      expect(ids.indexOf('crap')).toBeGreaterThan(ids.indexOf('vitest'))
      const crap = resultat.commandes.find(c => c.id === 'crap')!
      expect(crap.etat).toBe('ko')
      expect(crap.nouvelles).toBe(1)
      expect(resultat.etat).toBe('rouge')
      expect(resultat.erreurs.filter(e => e.outil === 'crap')).toHaveLength(1)
      expect(resultat.erreurs.find(e => e.outil === 'crap')).toMatchObject({ outil: 'crap', code: 'CRAP', statut: 'nouvelle' })
      const vit = calls.find(c => c.argv.includes('vitest'))!
      expect(vit.argv.some(t => t.includes('{sorties}'))).toBe(false)
      expect(vit.argv.some(t => t.startsWith('--coverage.reportsDirectory=') && t.includes(io.sorties))).toBe(true)
      expect(vit.argv).toContain('--coverage.enabled=true')
    })

    test('C7 : même fonction identique au commit de départ → crap ok, préexistante, porte verte', async () => {
      const { io } = fakeIo(os, racine, run, { read: lecture, show: () => RISKY })
      const { resultat } = await runGate(io, verifOf(CMDS), entree)
      const crap = resultat.commandes.find(c => c.id === 'crap')!
      expect(crap.etat).toBe('ok')
      expect(crap.preexistantes).toBe(1)
      expect(crap.nouvelles).toBe(0)
      expect(resultat.etat).toBe('vert')
      expect(resultat.erreurs.find(e => e.outil === 'crap')).toMatchObject({ code: 'CRAP', statut: 'preexistante' })
    })

    test('C7 : fichier absent du commit de départ (show undefined) → nouvelle, rouge', async () => {
      const { io } = fakeIo(os, racine, run, { read: lecture, show: () => undefined })
      const { resultat } = await runGate(io, verifOf(CMDS), entree)
      expect(resultat.commandes.find(c => c.id === 'crap')!.etat).toBe('ko')
      expect(resultat.etat).toBe('rouge')
    })

    test('C7 : aucun fichier concerné (tests sautés) → crap sautée', async () => {
      const { io } = fakeIo(os, racine, run, { read: lecture, show: () => RISKY })
      const { resultat } = await runGate(io, verifOf(CMDS), { changed: ['README.md'], files: ['README.md'], commit: 'abc1234def' })
      expect(resultat.commandes.find(c => c.id === 'crap')!.etat).toBe('saute')
      expect(resultat.etat).toBe('vert')
    })
  })
}
