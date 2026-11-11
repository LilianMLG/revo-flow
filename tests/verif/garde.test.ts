import { describe, expect, test } from 'claude-code/testing'

import {
  TESTER_BRIEF,
  VERIFIER_PROMPT,
  detectCheats,
  freeze,
  frozenDenial,
  isTestFile,
  parseCriteres,
  parseVerdicts,
  rehash,
  testerDenial,
  unfreeze,
  verifierBashAllowed,
  verifierTask,
} from '../../hooks/verif/garde'
import type { Critere, VerifCommande } from '../../types/verif'
import { OSES, native } from '../helpers/os'

const H1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const H2 = 'ffeeddccbbaa99887766554433221100ffeeddcc'

// ── Critères ─────────────────────────────────────────────────────────────

describe('parseCriteres', () => {
  test('numérote C1..Cn dans l’ordre, chaînes ou objets, puces retirées', () => {
    const r = parseCriteres(['- Un code expiré affiche une erreur', { id: 'X9', texte: '2) Le total est arrondi au centime' }, { text: 'Le bouton reste désactivé sans code' }])
    expect(r).toEqual({
      criteres: [
        { id: 'C1', texte: 'Un code expiré affiche une erreur' },
        { id: 'C2', texte: 'Le total est arrondi au centime' },
        { id: 'C3', texte: 'Le bouton reste désactivé sans code' },
      ],
    })
  })

  test('accepte une chaîne d’une ligne par critère, lignes vides ignorées', () => {
    const r = parseCriteres('C1: Un code expiré affiche une erreur\r\n\r\nC2: Le total est arrondi au centime')
    expect('criteres' in r && r.criteres.map(c => c.id)).toEqual(['C1', 'C2'])
  })

  test('refuse vide, absent, plus de 8, vague, trop long, doublon', () => {
    expect('error' in parseCriteres(undefined)).toBe(true)
    expect('error' in parseCriteres([])).toBe(true)
    expect('error' in parseCriteres(['  ', ''])).toBe(true)
    expect('error' in parseCriteres(42)).toBe(true)
    const neuf = Array.from({ length: 9 }, (_, i) => `Le cas numéro ${i} est couvert`)
    expect((parseCriteres(neuf) as { error: string }).error).toContain('8 au plus')
    expect('criteres' in parseCriteres(neuf.slice(0, 8))).toBe(true)
    expect((parseCriteres(['Ça marche']) as { error: string }).error).toContain('pas vérifiable')
    expect((parseCriteres([`Le texte ${'très '.repeat(80)}long`]) as { error: string }).error).toContain('300 au plus')
    expect((parseCriteres(['Le total est arrondi', 'le total est arrondi']) as { error: string }).error).toContain('doublon')
  })
})

// ── Fichiers de test et gel ──────────────────────────────────────────────

describe('isTestFile', () => {
  test('reconnaît les tests JS, TS, Dart et les dossiers de test', () => {
    for (const p of [
      'components/Panier.test.ts',
      'src/api.spec.tsx',
      'lib/x.test.mjs',
      'lib/promo_test.dart',
      'test/helpers/fake.ts',
      'packages/a/tests/a.ts',
      'src/__tests__/b.js',
      'integration_test/app_test.dart',
      'Tests\\Panier.TEST.ts',
      './test/a.dart',
    ])
      expect(isTestFile(p)).toBe(true)
    for (const p of ['src/testing.ts', 'stores/panier.ts', 'lib/contest/x.dart', 'latest/a.ts', '', 'test.ts', 'src/test-utils.ts']) expect(isTestFile(p)).toBe(false)
  })

  test('racine retirée d’un chemin absolu, sous Windows et macOS', () => {
    for (const os of OSES) {
      const racine = native(os, 'tests', 'projet')
      expect(isTestFile(native(os, 'tests', 'projet', 'src', 'a.ts'), racine)).toBe(false)
      expect(isTestFile(native(os, 'tests', 'projet', 'src', 'a.test.ts'), racine)).toBe(true)
      expect(isTestFile(native(os, 'tests', 'projet', 'test', 'a.ts'), racine)).toBe(true)
    }
  })
})

describe('gel des tests', () => {
  const gel = freeze(
    [
      { p: './tests/promo/Champ.test.ts', h: H1 },
      { p: 'test\\panier_test.dart', h: H2 },
      { p: '', h: H1 },
      { p: 'x.test.ts', h: '' },
    ],
    'Testeur',
  )

  test('freeze normalise, ignore les entrées vides, garde l’existant et prend le dernier hash', () => {
    expect(gel).toEqual([
      { p: 'tests/promo/Champ.test.ts', h: H1, par: 'Testeur' },
      { p: 'test/panier_test.dart', h: H2, par: 'Testeur' },
    ])
    const regel = freeze([{ p: 'Tests/Promo/Champ.test.ts', h: H2 }, { p: 'tests/autre.test.ts', h: H1 }], 'Testeur 2', gel)
    expect(regel.length).toBe(3)
    expect(regel.find(g => g.p === 'Tests/Promo/Champ.test.ts')).toEqual({ p: 'Tests/Promo/Champ.test.ts', h: H2, par: 'Testeur 2' })
  })

  test('frozenDenial : refuse un autre agent et l’orchestrateur, sous Windows et macOS, quelle que soit la casse', () => {
    for (const os of OSES) {
      const abs = native(os, 'Documents', 'proj', 'tests', 'promo', 'Champ.test.ts')
      const raison = frozenDenial(gel, abs, 'Front panier')
      expect(raison).toContain('test gelé')
      expect(raison).toContain('degeler')
      expect(frozenDenial(gel, abs, 'orchestrateur')).toBeDefined()
      expect(frozenDenial(gel, abs.toUpperCase(), 'Front panier')).toBeDefined()
      expect(frozenDenial(gel, native(os, 'Documents', 'proj', 'stores', 'panier.ts'), 'Front panier')).toBeUndefined()
    }
    expect(frozenDenial(gel, './test/panier_test.dart', 'Front panier')).toBeDefined()
    expect(frozenDenial(gel, 'test\\panier_test.dart', 'x')).toBeDefined()
  })

  test('frozenDenial : l’auteur garde la main ; agent inconnu refusé ; jamais d’exception', () => {
    expect(frozenDenial(gel, 'tests/promo/Champ.test.ts', ' testeur ')).toBeUndefined()
    expect(frozenDenial(gel, 'tests/promo/Champ.test.ts', '')).toBeDefined()
    expect(frozenDenial(gel, 'tests/promo/Champ.test.ts', undefined as unknown as string)).toBeDefined()
    expect(frozenDenial(gel, 'tests/promo/Other.test.ts', 'x')).toBeUndefined()
    expect(frozenDenial(gel, 'promo/Champ.test.tsx', 'x')).toBeUndefined()
    expect(frozenDenial(null as unknown as [], 'a', 'x')).toBeUndefined()
    expect(frozenDenial([null] as unknown as [], 'a', 'x')).toBeUndefined()
    expect(frozenDenial(gel, null as unknown as string, 'x')).toBeUndefined()
  })

  test('unfreeze rouvre un seul fichier', () => {
    const reste = unfreeze(gel, 'C:\\proj\\TESTS\\promo\\champ.test.ts')
    expect(reste.map(g => g.p)).toEqual(['test/panier_test.dart'])
  })

  test('rehash : hash changé, fichier disparu ; hash abrégé toléré, clés Windows', () => {
    expect(rehash(gel, { 'tests/promo/Champ.test.ts': H1, 'test/panier_test.dart': H2 })).toEqual([])
    expect(rehash(gel, { 'tests\\promo\\champ.test.ts': H1.slice(0, 12), './test/panier_test.dart': H2.toUpperCase() })).toEqual([])
    expect(rehash(gel, { 'tests/promo/Champ.test.ts': H2, 'test/panier_test.dart': H2 })).toEqual([{ p: 'tests/promo/Champ.test.ts', par: 'Testeur' }])
    expect(rehash(gel, { 'tests/promo/Champ.test.ts': H1 })).toEqual([{ p: 'test/panier_test.dart', par: 'Testeur' }])
    expect(rehash(gel, { 'tests/promo/Champ.test.ts': 'a1b', 'test/panier_test.dart': H2 }).length).toBe(1)
  })
})

describe('testerDenial', () => {
  test('le testeur n’écrit que des tests, sous Windows et macOS', () => {
    for (const os of OSES) {
      const racine = native(os, 'Documents', 'proj')
      expect(testerDenial(native(os, 'Documents', 'proj', 'tests', 'a.test.ts'), racine)).toBeUndefined()
      expect(testerDenial(native(os, 'Documents', 'proj', 'lib', 'promo_test.dart'), racine)).toBeUndefined()
      const raison = testerDenial(native(os, 'Documents', 'proj', 'stores', 'panier.ts'), racine)
      expect(raison).toContain('stores/panier.ts')
      expect(raison).toContain('pas un fichier de test')
    }
    expect(testerDenial('./src/__tests__/a.ts')).toBeUndefined()
    expect(testerDenial('src/Panier.vue')).toBeDefined()
    expect(testerDenial(undefined as unknown as string)).toBeDefined()
  })
})

// ── Bash du vérificateur ─────────────────────────────────────────────────

describe('verifierBashAllowed', () => {
  const confirmees = [
    ['npx', 'vitest', 'run', '{fichiers}'],
    ['npx', 'nuxi', 'typecheck'],
    ['sh', '-c', 'npm run lint && npm test'],
  ]

  test('lectures permises', () => {
    for (const c of [
      'git diff',
      'git diff --stat',
      'git --no-pager log -5 --oneline',
      'git -C packages/api show HEAD:src/a.ts',
      'git status --short',
      'cat stores/panier.ts',
      'ls -la tests',
      'head -n 40 src/a.ts',
      'tail -n 20 src/a.ts',
      "grep -rn 'Code expiré' components",
      "sed -n '10,40p' src/a.ts",
      'sed -n 5p src/a.ts',
      "sed -nE '/export/,/^}/p' src/a.ts",
      'wc -l src/a.ts',
    ])
      expect(verifierBashAllowed(c, confirmees)).toBe(true)
  })

  test('commandes confirmées : exactes, avec {fichiers}, préfixe Windows ; même avec && si données exactement', () => {
    expect(verifierBashAllowed('npx nuxi typecheck', confirmees)).toBe(true)
    expect(verifierBashAllowed('npx vitest run tests/a.test.ts tests/b.test.ts', confirmees)).toBe(true)
    expect(verifierBashAllowed('npx vitest run', confirmees)).toBe(true)
    expect(verifierBashAllowed('cmd /c npx nuxi typecheck', confirmees)).toBe(true)
    expect(verifierBashAllowed('sh -c npm run lint && npm test', confirmees)).toBe(true)
    expect(verifierBashAllowed('npx vitest run --update', confirmees)).toBe(false)
    expect(verifierBashAllowed('npx nuxi typecheck --fix', confirmees)).toBe(false)
    expect(verifierBashAllowed('npx vitest run a.test.ts; rm -rf .', confirmees)).toBe(false)
  })

  test('enchaînements, redirections et substitutions refusés', () => {
    for (const c of [
      'git diff; rm -rf src',
      'cat a.ts && echo ok',
      'cat a.ts | sh',
      'git diff > patch.txt',
      'cat < a.ts',
      'cat $(echo a.ts)',
      'cat `echo a.ts`',
      'git diff &',
      'cat a.ts\nrm a.ts',
      "grep 'a|b' src",
      'cat "a.ts',
    ])
      expect(verifierBashAllowed(c, confirmees)).toBe(false)
  })

  test('écritures et commandes inconnues refusées', () => {
    for (const c of [
      'git checkout -- src/a.ts',
      'git reset --hard',
      'git restore src/a.ts',
      'git stash',
      'git -c core.pager=sh diff',
      'git diff --output=x.patch',
      'git diff --ext-diff',
      'rm src/a.ts',
      'sed -i s/a/b/ src/a.ts',
      "sed -n -i '1p' a.ts",
      "sed -n '1w out.txt' a.ts",
      "sed '1p' a.ts",
      'tail -f log.txt',
      './cat a.ts',
      '/bin/rm a',
      'npm test',
      'node -e 1',
      'FOO=1 cat a',
      '',
      '   ',
    ])
      expect(verifierBashAllowed(c, confirmees)).toBe(false)
    expect(verifierBashAllowed(undefined as unknown as string, confirmees)).toBe(false)
    expect(verifierBashAllowed('git diff', null as unknown as string[][])).toBe(true)
  })
})

// ── Triche ───────────────────────────────────────────────────────────────

const fichier = (p: string, hunk: string, entete = `--- a/${p}\n+++ b/${p}`) => `diff --git a/${p} b/${p}\nindex 1111111..2222222 100644\n${entete}\n${hunk}`

describe('detectCheats', () => {
  test('motifs dans les lignes ajoutées, signalés sans bloquer', () => {
    const diff = [
      fichier('tests/promo.test.ts', "@@ -1,3 +1,4 @@\n import { x } from 'y'\n-it('a', () => {})\n+it.skip('a', () => {})\n+describe.only('b', () => {})\n test.todo('c')"),
      fichier('src/a.ts', '@@ -10,2 +10,5 @@\n const a = 1\n+// @ts-ignore\n+const b = c as any\n+// eslint-disable-next-line no-console\n const d = 2'),
      fichier('lib/x_test.dart', "@@ -1,1 +1,3 @@\n void main() {\n+  test('a', () {}, skip: true);\n+  // ignore: avoid_print"),
      fichier('src/b.js', '@@ -1 +1,2 @@\n a\n+xit("x", () => {})'),
    ].join('\n')
    const t = detectCheats(diff)
    const motifs = t.map(x => `${x.fichier} ${x.motif}`)
    expect(motifs).toContain('tests/promo.test.ts test sauté (.skip)')
    expect(motifs).toContain('tests/promo.test.ts test isolé (.only)')
    expect(motifs).toContain('src/a.ts erreur de typage masquée (@ts-ignore)')
    expect(motifs).toContain('src/a.ts typage contourné (as any)')
    expect(motifs).toContain('src/a.ts règle eslint désactivée (eslint-disable)')
    expect(motifs).toContain('lib/x_test.dart test sauté (skip: true)')
    expect(motifs).toContain('lib/x_test.dart avertissement Dart ignoré (// ignore:)')
    expect(motifs).toContain('src/b.js test désactivé (xit, xdescribe)')
    // test.todo est une ligne de contexte : pas signalé.
    expect(motifs.some(m => m.includes('test.todo'))).toBe(false)
    expect(t.every(x => !x.bloquant)).toBe(true)
    expect(t.find(x => x.motif.includes('as any'))!.extrait).toBe('const b = c as any')
  })

  test('pas de faux positif : ligne retirée, contexte, doc, .skip hors test, skip: true hors Dart', () => {
    const diff = [
      fichier('src/a.ts', '@@ -1,3 +1,2 @@\n-// @ts-ignore\n-const b = c as any\n+const b = c as Panier\n // eslint-disable-line'),
      fichier('README.md', '@@ -1 +1,2 @@\n # Doc\n+Évitez `@ts-ignore` et `as any`, et `it.skip`.'),
      fichier('src/db.ts', '@@ -1 +1,2 @@\n a\n+const rows = query.skip(10).only(5)\n+const opts = { skip: true }'),
    ].join('\n')
    expect(detectCheats(diff)).toEqual([])
  })

  test('une ligne retirée qui commence par « -- » ou « ++ » n’est pas un en-tête', () => {
    const diff = fichier('src/a.ts', '@@ -1,2 +1,2 @@\n--- ancien commentaire\n+++ x as any\n a')
    const t = detectCheats(diff)
    expect(t.map(x => x.motif)).toEqual(['typage contourné (as any)'])
    expect(t[0]!.fichier).toBe('src/a.ts')
  })

  test('baisse des expect dans un test modifié ; hausse ou fichier non test : rien', () => {
    const moins = fichier('tests/a.test.ts', "@@ -1,2 +1,2 @@\n test('a', () => {\n-  expect(a).toBe(1); expect(b).toBe(2)\n+  expect(a).toBe(1)")
    const t = detectCheats(moins)
    expect(t).toEqual([{ motif: 'moins d’assertions (expect)', fichier: 'tests/a.test.ts', extrait: '2 expect( retirés, 1 ajoutés', bloquant: false }])
    expect(detectCheats(fichier('tests/a.test.ts', '@@ -1 +1,2 @@\n-  expect(a).toBe(1)\n+  expect(a).toBe(1)\n+  expect(b).toBe(2)'))).toEqual([])
    expect(detectCheats(fichier('src/a.ts', '@@ -1 +0,0 @@\n-  expect(a)'))).toEqual([])
  })

  test('garde-fous modifiés : bloquants, y compris supprimés ; scripts lint et test du package.json', () => {
    const diff = [
      fichier('.eslintrc.cjs', "@@ -1 +1 @@\n-  rules: { 'no-console': 'error' }\n+  rules: { 'no-console': 'off' }"),
      fichier('packages/api/tsconfig.build.json', '@@ -1 +1 @@\n-  "strict": true\n+  "strict": false'),
      fichier('vitest.config.ts', '@@ -1 +0,0 @@\n-export default {}', '--- a/vitest.config.ts\n+++ /dev/null'),
      fichier('eslint.config.mjs', '@@ -1 +1,2 @@\n a\n+b'),
      fichier('jest.config.js', '@@ -1 +1,2 @@\n a\n+b'),
      fichier('biome.json', '@@ -1 +1,2 @@\n a\n+b'),
      fichier('analysis_options.yaml', '@@ -1 +1,2 @@\n a\n+b'),
      fichier('package.json', '@@ -5,3 +5,3 @@\n   "scripts": {\n-    "lint": "eslint .",\n+    "lint": "eslint src/a.ts",\n     "dev": "nuxt dev",'),
      fichier('apps/web/package.json', '@@ -5,2 +5,3 @@\n   "devDependencies": {\n-    "vitest": "^1.0.0",\n+    "vitest": "^2.0.0",\n+    "test": "^1.0.0",'),
    ].join('\n')
    const t = detectCheats(diff)
    const bloquants = t.filter(x => x.bloquant).map(x => x.fichier)
    expect(bloquants).toEqual([
      '.eslintrc.cjs',
      'packages/api/tsconfig.build.json',
      'vitest.config.ts',
      'eslint.config.mjs',
      'jest.config.js',
      'biome.json',
      'analysis_options.yaml',
      'package.json',
    ])
    // package.json : les lignes retirée et ajoutée du script lint donnent une seule triche (« +1 »).
    expect(t.find(x => x.fichier === 'package.json')!.extrait).toBe('"lint": "eslint src/a.ts", (+1)')
  })

  test('test gelé modifié : bloquant, et rangé avant les signalements', () => {
    const gel = freeze([{ p: 'tests/promo.test.ts', h: H1 }], 'Testeur')
    const diff = [fichier('src/a.ts', '@@ -1 +1,2 @@\n a\n+b as any'), fichier('Tests/Promo.test.ts', '@@ -1 +1,2 @@\n a\n+b')].join('\n')
    const t = detectCheats(diff, gel)
    expect(t[0]).toEqual({ motif: 'test gelé modifié', fichier: 'Tests/Promo.test.ts', extrait: 'gelé, écrit par « Testeur »', bloquant: true })
    expect(t[1]!.bloquant).toBe(false)
  })

  test('motif répété : une triche avec le compte ; CRLF et diff -u sans en-tête git', () => {
    const crlf = fichier('src/a.ts', '@@ -1 +1,3 @@\n a\n+x as any\n+y as any').replace(/\n/g, '\r\n')
    expect(detectCheats(crlf)).toEqual([{ motif: 'typage contourné (as any)', fichier: 'src/a.ts', extrait: 'x as any (+1)', bloquant: false }])
    const plain = '--- a/src/a.ts\t2026-10-25\n+++ b/src/a.ts\t2026-10-25\n@@ -1 +1,2 @@\n a\n+// @ts-expect-error\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1,2 @@\n a\n+biome-ignore lint: x'
    expect(detectCheats(plain).map(x => `${x.fichier} ${x.motif}`)).toEqual([
      'src/a.ts erreur de typage masquée (@ts-expect-error)',
      'src/b.ts règle biome désactivée (biome-ignore)',
    ])
    expect(detectCheats('')).toEqual([])
    expect(detectCheats(undefined as unknown as string)).toEqual([])
  })
})

// ── Vérificateur ─────────────────────────────────────────────────────────

const CRITERES: Critere[] = [
  { id: 'C1', texte: 'Un code expiré affiche une erreur' },
  { id: 'C2', texte: 'Le total est arrondi au centime' },
  { id: 'C3', texte: 'La notification arrive sur le téléphone' },
]

describe('VERIFIER_PROMPT et verifierTask', () => {
  test('le prompt est calibré : trois verdicts notés, preuve exécutée, lecture seule, bloc json', () => {
    for (const s of ['"verdict":"ok"', '"verdict":"ko"', '"verdict":"non-verifiable"', 'preuve', '```json', 'Lecture seule', 'commande']) expect(VERIFIER_PROMPT).toContain(s)
    expect(VERIFIER_PROMPT).toContain('Lire le code ne suffit jamais')
  })

  test('la tâche liste les critères, le diff --stat borné, les commandes et les triches', () => {
    const cmds: VerifCommande[] = [{ id: 'tests', outil: 'tests', argv: ['npx', 'vitest', 'run', '{fichiers}'], portee: 'lies', format: 'vitest-json', source: 'script' }]
    const stat = Array.from({ length: 70 }, (_, i) => ` src/f${i}.ts | 2 +-`).join('\n')
    const t = verifierTask(CRITERES, stat, cmds, [{ motif: 'typage contourné (as any)', fichier: 'src/a.ts', extrait: 'x as any', bloquant: false }])
    expect(t).toContain('- C1 : Un code expiré affiche une erreur')
    expect(t).toContain('src/f59.ts')
    expect(t).not.toContain('src/f60.ts')
    expect(t).toContain('… et 10 autres lignes')
    expect(t).toContain('- npx vitest run {fichiers} (tests, portée lies)')
    expect(t).toContain('typage contourné (as any) : src/a.ts (x as any)')
    expect(t).toContain('C1, C2, C3')
    const nue = verifierTask(CRITERES, '', [])
    expect(nue).toContain('Aucune commande confirmée')
    expect(nue).toContain('(aucun fichier modifié)')
    expect(nue).not.toContain('Triches')
  })

  test('preuve web : section du prompt, exemple 4, règle 3 ouverte, "web" accepté dans le bloc json', () => {
    expect(VERIFIER_PROMPT).toContain('## Preuve web')
    expect(VERIFIER_PROMPT).toContain('Exemple 4, « ok » par preuve web')
    expect(VERIFIER_PROMPT).toContain(
      '{"id":"C2","verdict":"ok","preuve":"http://localhost:3000/panier → read_page : « Total TTC 12,00 € » présent après ajout de l’option ; console : 0 erreur ; réseau : 0 réponse 4xx/5xx ; capture 1","web":true}',
    )
    expect(VERIFIER_PROMPT).toContain('capture prise, ça a l’air bon')
    expect(VERIFIER_PROMPT).toContain('sauf si ta tâche t’ouvre la preuve web ou la preuve mobile : alors demande le serveur ou l’app et observe, voir « Preuve web » et « Preuve mobile » ;')
    // v3.1 : la section « Preuve mobile », l'exemple 5 et "mobile": true dans le bloc json.
    expect(VERIFIER_PROMPT).toContain('## Preuve mobile')
    expect(VERIFIER_PROMPT).toContain('Exemple 5, « ko » par preuve mobile')
    expect(VERIFIER_PROMPT).toContain('mcp__revo-flow__mobile')
    expect(VERIFIER_PROMPT).toContain('"mobile": true')
    expect(VERIFIER_PROMPT).toContain('mcp__revo-flow__verif')
    expect(VERIFIER_PROMPT).toContain('"web": true')
  })

  test('verifierTask : le paragraphe web ajouté tel quel, après les triches, avant la consigne finale', () => {
    const web = '## Preuve web\nCe projet a un serveur de dev : `npm run dev`.'
    const triches = [{ motif: 'test isolé (.only)', fichier: 'a.test.ts', bloquant: false }]
    const t = verifierTask(CRITERES, ' a.ts | 1 +', [], triches, web)
    expect(t).toContain(web)
    expect(t.indexOf('test isolé (.only)')).toBeLessThan(t.indexOf('## Preuve web'))
    expect(t.indexOf('## Preuve web')).toBeLessThan(t.indexOf('Rends le bloc json'))
    expect(verifierTask(CRITERES, '', [])).not.toContain('Preuve web')
    expect(verifierTask(CRITERES, '', [], [], web)).toContain(web)
  })
})

describe('parseVerdicts', () => {
  test('bloc json entouré de texte ; critère absent → non vérifiable', () => {
    const text = 'J’ai lancé les tests.\n```json\n[{"id":"C1","verdict":"ok","preuve":"npx vitest run → 3 passed"},{"id":"C2","verdict":"ko","preuve":"expected 10.005 to be 10.01"}]\n```\nFin.'
    expect(parseVerdicts(text, CRITERES)).toEqual([
      { id: 'C1', verdict: 'ok', preuve: 'npx vitest run → 3 passed' },
      { id: 'C2', verdict: 'ko', preuve: 'expected 10.005 to be 10.01' },
      { id: 'C3', verdict: 'non-verifiable', preuve: 'pas de verdict du vérificateur pour ce critère' },
    ])
  })

  test('tolérant : sans clôture, virgule finale, ids et verdicts approximatifs, objet par id', () => {
    const brut = 'Verdicts : [{"id":"c1","verdict":"OK","preuve":"x → passed"},{"id":"2","verdict":"Échec","preuve":"y"},{"id":"C3","verdict":"non vérifiable","preuve":"z"},]'
    expect(parseVerdicts(brut, CRITERES).map(v => v.verdict)).toEqual(['ok', 'ko', 'non-verifiable'])
    const objet = '```\n{"C1":{"verdict":"ok","preuve":"p"},"C2":"ko"}\n```'
    expect(parseVerdicts(objet, CRITERES).map(v => v.verdict)).toEqual(['ok', 'ko', 'non-verifiable'])
    expect(parseVerdicts('{"verdicts":[{"id":"C3","verdict":"ok","preuve":"p"}]}', CRITERES)[2]!.verdict).toBe('ok')
  })

  test('le dernier bloc lisible l’emporte ; « ok » sans preuve rétrogradé ; id inconnu ignoré', () => {
    const text = '```json\n[{"id":"C1","verdict":"ko","preuve":"brouillon"}]\n```\nfinalement :\n```json\n[{"id":"C1","verdict":"ok","preuve":""},{"id":"C9","verdict":"ok","preuve":"p"}]\n```'
    const v = parseVerdicts(text, CRITERES)
    expect(v[0]).toEqual({ id: 'C1', verdict: 'non-verifiable', preuve: 'verdict « ok » sans preuve exécutée' })
    expect(v.length).toBe(3)
  })

  test('mobile: true gardé quand le verdict le porte (preuve mobile, v3.1), absent sinon', () => {
    const c = [{ id: 'C1', texte: 'a' }, { id: 'C2', texte: 'b' }]
    const v = parseVerdicts('```json\n[{"id":"C1","verdict":"ko","preuve":"SM A515F : 1 débordement ; capture 1","mobile":true},{"id":"C2","verdict":"ok","preuve":"vitest → ok"}]\n```', c)
    expect(v[0]).toEqual({ id: 'C1', verdict: 'ko', preuve: 'SM A515F : 1 débordement ; capture 1', mobile: true })
    expect(v[1]).toEqual({ id: 'C2', verdict: 'ok', preuve: 'vitest → ok' })
  })

  test('web: true gardé quand le verdict le porte, absent sinon', () => {
    const text =
      '```json\n[{"id":"C1","verdict":"ok","preuve":"http://localhost:3000 → read_page : « Code expiré » ; capture 1","web":true},{"id":"C2","verdict":"ko","preuve":"p","web":false},{"id":"C3","verdict":"ok","preuve":"","web":true}]\n```'
    const v = parseVerdicts(text, CRITERES)
    expect(v[0]).toEqual({ id: 'C1', verdict: 'ok', preuve: 'http://localhost:3000 → read_page : « Code expiré » ; capture 1', web: true })
    expect(v[1]).toEqual({ id: 'C2', verdict: 'ko', preuve: 'p' })
    expect('web' in v[1]!).toBe(false)
    expect(v[2]).toEqual({ id: 'C3', verdict: 'non-verifiable', preuve: 'verdict « ok » sans preuve exécutée', web: true })
  })

  test('réponse illisible : tout non vérifiable, jamais d’exception', () => {
    for (const text of ['Tout passe, je vous assure.', '```json\n[{"id": \n```', '', undefined as unknown as string]) {
      const v = parseVerdicts(text, CRITERES)
      expect(v.map(x => x.verdict)).toEqual(['non-verifiable', 'non-verifiable', 'non-verifiable'])
      expect(v[0]!.preuve).toContain('illisible')
    }
  })
})

describe('TESTER_BRIEF', () => {
  test('critères et interfaces, fichiers de test seulement, gel et tests gardés', () => {
    for (const s of ['critères d’acceptation', 'interfaces', 'Ne pars pas du code', 'que des fichiers de test', 'gèle', 'restent dans le dépôt']) expect(TESTER_BRIEF).toContain(s)
  })
})

describe('vérificateur : étape ARCHI (v3.2)', () => {
  test('git grep, merge-base et ls-tree sont des lectures ; git grep -O (éditeur) ne l’est pas', () => {
    expect(verifierBashAllowed('git grep -n -w Panier', [])).toBe(true)
    expect(verifierBashAllowed('git merge-base HEAD origin/main', [])).toBe(true)
    expect(verifierBashAllowed('git ls-tree -r --name-only HEAD', [])).toBe(true)
    expect(verifierBashAllowed('git grep -O Panier', [])).toBe(false)
    expect(verifierBashAllowed('git grep --open-files-in-pager=vim Panier', [])).toBe(false)
  })
  test('la tâche sans critère porte sur l’architecture et demande le verdict ARCHI', () => {
    const t = verifierTask([], ' a.ts | 2 +-', [], [], undefined, '## Architecture (étape ARCHI, obligatoire)\nBase : abc')
    expect(t).toMatch(/Le plan n’a pas de critère d’acceptation : ta vérification porte sur l’architecture \(étape ARCHI\)\./)
    expect(t).toMatch(/## Architecture \(étape ARCHI, obligatoire\)/)
    expect(t).toMatch(/Rends le bloc json avec un verdict pour ARCHI\.$/)
  })
  test('avec des critères : les critères puis ARCHI', () => {
    const t = verifierTask([{ id: 'C1', texte: 'Un code expiré affiche une erreur' }], '', [], [], undefined, '## Architecture (étape ARCHI, obligatoire)')
    expect(t).toMatch(/Rends le bloc json avec un verdict pour C1, ARCHI\.$/)
  })
  test('le prompt du vérificateur présente l’étape ARCHI, toujours, et l’objet ARCHI du bloc json', () => {
    expect(VERIFIER_PROMPT).toMatch(/## Architecture \(étape ARCHI, toujours\)/)
    expect(VERIFIER_PROMPT).toMatch(/\{"id":"ARCHI","verdict":"ok"/)
  })
})
