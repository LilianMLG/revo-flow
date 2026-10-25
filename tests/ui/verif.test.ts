import { describe, expect, test } from 'claude-code/testing'

import { barSvg, verifNoteSvg, verifRowSvg } from '../../hooks/ui/art'
import {
  verifCommandRow,
  verifCommandText,
  verifCriteriaText,
  verifHeader,
  verifLine,
  verifNotes,
  verifShown,
  verifTone,
} from '../../hooks/ui/views'
import type { VerifEtatCommande, VerifView } from '../../types/verif'

const cmd = (o: Partial<VerifEtatCommande> & { id: string }): VerifEtatCommande => ({
  outil: 'lint',
  etat: 'ok',
  dureeMs: 6000,
  nouvelles: 0,
  preexistantes: 0,
  instables: 0,
  fichiers: 12,
  ...o,
})

const view = (o: Partial<VerifView> = {}): VerifView => ({
  projet: 'reservation-tool',
  mode: 'bloquer',
  etat: 'attente',
  tentative: 0,
  max: 3,
  commandes: [],
  base: 'prete',
  geles: [],
  triches: [],
  ...o,
})

describe('verifLine', () => {
  test('rien sans vérification, coupée sans résultat, ou pas encore lancée', () => {
    expect(verifLine(null)).toBeUndefined()
    expect(verifLine(view({ mode: 'off', etat: 'off' }))).toBeUndefined()
    expect(verifLine(view({ etat: 'attente' }))).toBeUndefined()
    expect(verifLine(view({ etat: 'base', base: 'en_cours' }))).toBeUndefined()
  })

  test('en cours', () => {
    expect(verifLine(view({ etat: 'en_cours', tentative: 1 }))).toBe('vérif …')
  })

  test('vert : commandes ok sur commandes lancées, les sautées ne comptent pas', () => {
    const v = view({ etat: 'vert', commandes: [cmd({ id: 'eslint' }), cmd({ id: 'typecheck' }), cmd({ id: 'vitest' }), cmd({ id: 'format', etat: 'saute' })] })
    expect(verifLine(v)).toBe('vérif ✓ 3/3')
    expect(verifTone(v)).toBe('ok')
  })

  test('rouge : la première commande en échec et ses nouvelles erreurs', () => {
    const v = view({ etat: 'rouge', commandes: [cmd({ id: 'eslint' }), cmd({ id: 'typecheck', etat: 'ko', nouvelles: 2, preexistantes: 5 })] })
    expect(verifLine(v)).toBe('vérif ✗ typecheck (2)')
    expect(verifTone(v)).toBe('ko')
  })

  test('rouge sans nouvelle erreur chiffrée, par triche ou par critère', () => {
    expect(verifLine(view({ etat: 'rouge', commandes: [cmd({ id: 'vitest', etat: 'ko' })] }))).toBe('vérif ✗ vitest')
    expect(verifLine(view({ etat: 'rouge', commandes: [cmd({ id: 'eslint' })], triches: [{ motif: 'skip', fichier: 'a.spec.ts', bloquant: true }] }))).toBe('vérif ✗ triche')
    expect(
      verifLine(view({ etat: 'rouge', commandes: [cmd({ id: 'eslint' })], criteres: { total: 2, ok: 1, verdicts: [{ id: 'C2', verdict: 'ko', preuve: 'x' }] } })),
    ).toBe('vérif ✗ critères (1)')
  })

  test('erreur de revo-flow et à confirmer : attention', () => {
    expect(verifLine(view({ etat: 'erreur' }))).toBe('vérif ⚠ erreur')
    expect(verifLine(view({ etat: 'a-confirmer' }))).toBe('vérif ? à confirmer')
    expect(verifTone(view({ etat: 'erreur' }))).toBe('warn')
    expect(verifTone(view({ etat: 'en_cours' }))).toBe('dim')
  })
})

describe('verifShown', () => {
  test('coupée : seulement avec un résultat', () => {
    expect(verifShown(null)).toBe(false)
    expect(verifShown(view({ mode: 'off', etat: 'off' }))).toBe(false)
    expect(verifShown(view({ mode: 'off', etat: 'off', commandes: [cmd({ id: 'eslint' })] }))).toBe(true)
    expect(verifShown(view())).toBe(true)
  })
})

describe('lignes de commande', () => {
  test('ok : le nombre de fichiers et la durée', () => {
    expect(verifCommandText(cmd({ id: 'eslint' }))).toBe('✓ eslint  12 fichiers  6 s')
    expect(verifCommandRow(cmd({ id: 'eslint', fichiers: 1 })).detail).toBe('1 fichier')
  })

  test('ko : nouvelles et préexistantes, instables à part', () => {
    const r = verifCommandRow(cmd({ id: 'nuxi typecheck', etat: 'ko', nouvelles: 2, preexistantes: 5, dureeMs: 48000, instables: 1 }))
    expect(r).toMatchObject({ mark: '✗', tone: 'ko', detail: '2 nouvelles · 5 préexistantes', duration: '48 s', flaky: '1 instable' })
    expect(verifCommandRow(cmd({ id: 't', etat: 'ko', nouvelles: 1 })).detail).toBe('1 nouvelle')
    expect(verifCommandRow(cmd({ id: 't', etat: 'ko', preexistantes: 1 })).detail).toBe('1 préexistante')
  })

  test('en cours, erreur et sautée', () => {
    expect(verifCommandRow(cmd({ id: 'vitest', etat: 'en_cours', dureeMs: 0 }))).toMatchObject({ mark: '…', detail: 'en cours…', duration: '' })
    expect(verifCommandRow(cmd({ id: 'vitest', etat: 'erreur', note: 'délai dépassé' }))).toMatchObject({ mark: '⚠', tone: 'warn', detail: 'délai dépassé' })
    expect(verifCommandRow(cmd({ id: 'codegen', etat: 'saute', note: 'aucun .graphql modifié' }))).toMatchObject({ mark: '–', duration: '', detail: 'aucun .graphql modifié' })
  })
})

describe('en-tête, critères et remarques', () => {
  test('en-tête', () => {
    expect(verifHeader(view({ tentative: 2 }))).toBe('Vérification · reservation-tool · tentative 2/3')
    expect(verifHeader(view())).toBe('Vérification · reservation-tool')
  })

  test('critères', () => {
    expect(verifCriteriaText(view())).toBeUndefined()
    expect(verifCriteriaText(view({ criteres: { total: 4, ok: 4, verdicts: [] } }))).toBe('Critères 4/4 ✓')
    expect(
      verifCriteriaText(view({ criteres: { total: 4, ok: 3, verdicts: [{ id: 'C4', verdict: 'ko', preuve: 'sortie de vitest' }] } })),
    ).toBe('Critères 3/4 ✓ · vérificateur : « ko » sur C4 (preuve : sortie de vitest)')
    expect(
      verifCriteriaText(view({ criteres: { total: 3, ok: 1, verdicts: [{ id: 'C2', verdict: 'ko', preuve: 'a' }, { id: 'C3', verdict: 'non-verifiable', preuve: '' }] } })),
    ).toBe('Critères 1/3 ✓ · vérificateur : « ko » sur C2 (preuve : a) · non vérifiable : C3')
  })

  test('remarques : base, gelés, triches, critères, question', () => {
    const v = view({
      commandes: [cmd({ id: 'eslint' })],
      base: 'absente',
      geles: [{ p: 'cart.spec.ts' }, { p: 'b.spec.ts', modifie: 'Bash' }],
      triches: [
        { motif: 'test sauté', fichier: 'a.spec.ts', bloquant: true },
        { motif: 'ts-ignore', fichier: 'b.ts', bloquant: false },
      ],
      criteres: { total: 4, ok: 3, verdicts: [{ id: 'C4', verdict: 'ko', preuve: 'p' }] },
      enAttente: 'Garder la modification ?',
    })
    const n = verifNotes(v)
    expect(n.map(x => x.tone)).toEqual(['warn', 'warn', 'ko', 'warn', 'ko', 'warn'])
    expect(n[1]!.text).toBe('test gelé b.spec.ts modifié par Bash')
    expect(n[2]!.text).toBe('triche : test sauté (a.spec.ts)')
    expect(n[5]!.text).toContain('Garder la modification ?')
    expect(verifNotes(view({ base: 'en_cours' }))[0]!.text).toContain('base de référence en cours')
    expect(verifNotes(view())).toEqual([])
  })
})

describe('dessins', () => {
  test('ligne de commande et remarque en Svg, échappés et tronqués', () => {
    const row = verifRowSvg({ mark: '✗', tone: 'ko', id: 'a<b', detail: 'x'.repeat(200), duration: '48 s', flaky: '1 instable', width: 340 })
    expect(row).toContain('a&lt;b')
    expect(row).toContain('width="340"')
    expect(row).toContain('…')
    const note = verifNoteSvg({ mark: '⚠', tone: 'warn', text: 'test gelé', width: 340 })
    expect(note).toContain('test gelé')
  })

  test('la bande du bureau montre le segment, sauf en très étroit', () => {
    const stages = [{ name: 'Plan', kind: 'reached' as const }]
    const o = { title: 'T', width: 800, percent: 50, agents: 1, verif: { text: 'vérif ✓ 3/3', tone: 'ok' as const } }
    expect(barSvg(stages, o)).toContain('vérif ✓ 3/3')
    expect(barSvg(stages, { ...o, width: 380 })).not.toContain('vérif ✓ 3/3')
    expect(barSvg(stages, { title: 'T', width: 800, percent: 50, agents: 1 })).not.toContain('vérif')
  })
})
