import { describe, expect, test } from 'claude-code/testing'

import {
  ARCHI_CRITERE,
  ARCHI_ID,
  archiTask,
  definedNames,
  definitionPattern,
  duplicateHints,
  fileKind,
  homonymHints,
  parseNameStatus,
  placementHints,
} from '../../hooks/verif/archi'

describe('parseNameStatus', () => {
  test('ajouts, modifications, suppressions, renommages ; lignes illisibles ignorées', () => {
    const out = parseNameStatus('A\tlib/recap/recap_page.dart\nM\tlib/main.dart\r\nD\told.ts\nR087\tsrc/a.ts\tsrc/b.ts\n\nnimporte quoi')
    expect(out).toEqual([
      { statut: 'A', p: 'lib/recap/recap_page.dart' },
      { statut: 'M', p: 'lib/main.dart' },
      { statut: 'D', p: 'old.ts' },
      { statut: 'R', p: 'src/b.ts', avant: 'src/a.ts' },
    ])
  })
})

describe('fileKind', () => {
  test('suffixes à point, suffixes Dart, composables, vues ; rien pour un nom sans motif ou un test', () => {
    expect(fileKind('src/cart/cart.service.ts')).toBe('*.service.ts')
    expect(fileKind('lib/recap/recap_page.dart')).toBe('*_page.dart')
    expect(fileKind('composables/useCart.ts')).toBe('use*.ts')
    expect(fileKind('components/Basket.vue')).toBe('*.vue')
    expect(fileKind('src/index.ts')).toBeUndefined()
    expect(fileKind('tests/cart.test.ts')).toBeUndefined()
    expect(fileKind('test/recap_page_test.dart')).toBeUndefined()
  })
})

describe('placementHints', () => {
  const existants = ['composables/useCart.ts', 'composables/usePromo.ts', 'composables/useUser.ts', 'utils/format.ts', 'lib/home/home_page.dart', 'lib/cart/cart_page.dart', 'lib/user/user_page.dart']
  test('un fichier rangé ailleurs que ses semblables (3 au moins), avec les dossiers où ils sont', () => {
    const h = placementHints(['utils/useRecap.ts'], existants)
    expect(h).toHaveLength(1)
    expect(h[0]).toMatch(/utils\/useRecap\.ts : les fichiers use\*\.ts du projet sont sous composables\/ \(3\) ; celui-ci est sous utils\//)
  })
  test('rien quand le dossier a déjà des semblables, ou trop peu de semblables pour une règle', () => {
    expect(placementHints(['composables/useRecap.ts'], existants)).toEqual([])
    // Les pages Dart sont chacune dans leur dossier de feature : un nouveau dossier de feature n'est pas un écart… sauf à 3+ exemples ailleurs.
    expect(placementHints(['src/thing.store.ts'], existants)).toEqual([])
  })
})

describe('homonymHints', () => {
  test('un nom de fichier déjà pris ailleurs ; les noms génériques (index, types, utils) ne comptent pas', () => {
    const h = homonymHints(['src/models/panier.dart', 'src/index.ts'], ['lib/models/panier.dart', 'lib/index.ts'])
    expect(h).toEqual(['src/models/panier.dart : un fichier du même nom existe déjà (lib/models/panier.dart)'])
  })
})

describe('definedNames et definitionPattern', () => {
  test('les définitions TypeScript et Dart des lignes ajoutées, sans les noms courts ou génériques', () => {
    const noms = definedNames([
      'export interface Panier { total: number }',
      'export type LigneRecap = { id: string }',
      'export const formatPrix = (n: number) => n',
      'export default function useRecap() {}',
      'class RecapPage extends StatelessWidget {',
      'abstract class PanierRepository {',
      'export type Props = {}',
      'const local = 1',
    ])
    expect(noms).toEqual(['Panier', 'LigneRecap', 'formatPrix', 'useRecap', 'RecapPage', 'PanierRepository'])
  })
  test('le motif git grep couvre les mots-clés de définition ; rien sans nom', () => {
    expect(definitionPattern(['Panier', 'formatPrix'])).toBe('(interface|type|class|enum|function|const|let|mixin|extension|typedef)[[:space:]]+(Panier|formatPrix)([^A-Za-z0-9_$]|$)')
    expect(definitionPattern([])).toBeUndefined()
  })
})

describe('duplicateHints', () => {
  const grep = [
    'types/cart.ts:3:export interface Panier {',
    'lib/recap/recap.ts:1:export interface Panier {',
    'tests/cart.test.ts:2:type Panier = {}',
    'utils/prix.ts:10:export const formatPrix = (n: number) => `${n} €`',
    'README.md:4:la class Panier sert à…',
  ].join('\n')
  test('une définition existante par nom, hors de la définition de la branche elle-même et des tests', () => {
    const h = duplicateHints(grep, ['Panier', 'formatPrix'], { Panier: 'lib/recap/recap.ts', formatPrix: 'lib/recap/prix.ts' })
    expect(h).toEqual(['interface Panier (lib/recap/recap.ts) existe déjà : types/cart.ts:3', 'const formatPrix (lib/recap/prix.ts) existe déjà : utils/prix.ts:10'])
  })
  test('rien quand le nom n’est défini que dans le fichier de la branche', () => {
    expect(duplicateHints('lib/recap/recap.ts:1:export interface Panier {', ['Panier'], { Panier: 'lib/recap/recap.ts' })).toEqual([])
  })
})

describe('archiTask', () => {
  test('la base, les fichiers de la branche, les documents à lire, les indices et la consigne du verdict ARCHI', () => {
    const t = archiTask({
      base: 'a1b2c3d4e5f6',
      baseLabel: 'point de départ de la branche depuis origin/main',
      fichiers: [{ statut: 'A', p: 'utils/useRecap.ts' }, { statut: 'R', p: 'src/b.ts', avant: 'src/a.ts' }],
      docs: ['ARCHITECTURE.md', 'CLAUDE.md'],
      indices: ['utils/useRecap.ts : les fichiers use*.ts du projet sont sous composables/ (3)'],
    })
    expect(t).toMatch(/^## Architecture \(étape ARCHI, obligatoire\)/)
    expect(t).toMatch(/Base de comparaison : a1b2c3d4e \(point de départ de la branche depuis origin\/main\)/)
    expect(t).toMatch(/- A utils\/useRecap\.ts\n- R src\/a\.ts → src\/b\.ts/)
    expect(t).toMatch(/Lis d’abord ce que le projet dit de son architecture : ARCHITECTURE\.md, CLAUDE\.md\./)
    expect(t).toMatch(/Indices repérés par revo-flow[\s\S]*composables\/ \(3\)/)
    expect(t).toMatch(/Verdict ARCHI : « ok »[\s\S]*« ko » en citant chaque problème/)
    expect(ARCHI_CRITERE.id).toBe(ARCHI_ID)
  })
  test('sans document d’architecture : l’arborescence et les voisins', () => {
    expect(archiTask({ base: 'abc', baseLabel: 'commit de départ du flow', fichiers: [], docs: [], indices: [] })).toMatch(/n’a pas de document d’architecture[\s\S]*git ls-tree -r --name-only abc/)
  })
})
