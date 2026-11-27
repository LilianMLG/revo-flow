import { describe, expect, test } from 'claude-code/testing'

import { barSvg, verifNoteSvg, verifRowSvg } from '../../hooks/ui/art'
import {
  bandNote,
  budgetView,
  cards,
  criteresSuffix,
  mobileLine,
  papercutsLine,
  verifCommandRow,
  verifCommandText,
  verifCriteriaText,
  verifHeader,
  verifLine,
  verifNotes,
  verifShown,
  verifTone,
  webLine,
} from '../../hooks/ui/views'
import type { MobileView, VerifEtatCommande, VerifView, WebView } from '../../types/verif'

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

const web = (o: Partial<WebView> = {}): WebView => ({ etat: 'pret', commande: 'npm run dev', url: 'http://localhost:3000', captures: [], ...o })

describe('webLine : la preuve web', () => {
  test('rien sans web, non demandé ou en question', () => {
    expect(webLine(view())).toBeUndefined()
    expect(webLine(view({ web: web({ etat: 'non-demande' }) }))).toBeUndefined()
    expect(webLine(view({ web: web({ etat: 'question' }) }))).toBeUndefined()
  })

  test('chaque état', () => {
    expect(webLine(view({ web: web({ etat: 'demarrage' }) }))).toEqual({ mark: '…', tone: 'dim', text: 'preuve web : démarrage de « npm run dev »' })
    expect(webLine(view({ web: web() }))).toEqual({ mark: '✓', tone: 'ok', text: 'preuve web : http://localhost:3000 (serveur démarré)' })
    expect(webLine(view({ web: web({ existant: true, captures: ['/a/capture-1.png', '/a/capture-2.png.txt'] }) }))).toEqual({
      mark: '✓',
      tone: 'ok',
      text: 'preuve web : http://localhost:3000 (serveur déjà en marche) · 2 captures',
    })
    expect(webLine(view({ web: web({ captures: ['/a/capture-1.png'] }) }))!.text).toMatch(/ · 1 capture$/)
    expect(webLine(view({ web: web({ etat: 'refuse' }) }))).toEqual({ mark: '–', tone: 'dim', text: 'preuve web : serveur non démarré (votre choix)' })
    expect(webLine(view({ web: web({ etat: 'erreur', note: 'port 3000 occupé' }) }))).toEqual({ mark: '⚠', tone: 'warn', text: 'preuve web : port 3000 occupé' })
    expect(webLine(view({ web: web({ etat: 'arrete', captures: ['/a/c1.png', '/a/c2.png'] }) }))).toEqual({ mark: '·', tone: 'dim', text: 'preuve web : serveur arrêté · 2 captures' })
    expect(webLine(view({ web: web({ etat: 'arrete' }) }))!.text).toBe('preuve web : serveur arrêté')
  })

  test('verifNotes : après les critères, avant la question en attente', () => {
    const n = verifNotes(view({ criteres: { total: 1, ok: 1, verdicts: [] }, web: web(), enAttente: 'Continuer ?' }))
    expect(n.map(x => x.text.split(' ')[0])).toEqual(['Critères', 'preuve', 'en'])
    expect(verifNotes(view({ web: web({ etat: 'non-demande' }) }))).toEqual([])
  })
})

describe('v3.6 : critères, panne, budget et preuve restée sans réponse dans la bande et le panneau', () => {
  const crit = (verdicts: { id: string; verdict: 'ok' | 'ko' | 'non-verifiable' }[], total = 8) => ({
    total,
    ok: verdicts.filter(v => v.verdict === 'ok').length,
    verdicts: verdicts.map(v => ({ ...v, preuve: 'x' })),
  })

  test('verifLine : « vérif ✓ 3/3 · critères 6/8 », « · 1 ko » s’il y en a, orange ; sans critères, inchangée', () => {
    const run = [cmd({ id: 'eslint' }), cmd({ id: 'typecheck' }), cmd({ id: 'vitest' })]
    const ok6 = Array.from({ length: 6 }, (_, i) => ({ id: `C${i + 1}`, verdict: 'ok' as const }))
    const v = view({ etat: 'vert', commandes: run, criteres: crit([...ok6, { id: 'C7', verdict: 'non-verifiable' }]) })
    expect(verifLine(v)).toBe('vérif ✓ 3/3 · critères 6/8')
    expect(verifTone(v)).toBe('ok')
    const ko = view({ etat: 'vert', commandes: run, criteres: crit([...ok6, { id: 'C7', verdict: 'ko' }]) })
    expect(verifLine(ko)).toBe('vérif ✓ 3/3 · critères 6/8 · 1 ko')
    expect(verifTone(ko)).toBe('warn')
    expect(criteresSuffix(view({ etat: 'vert', commandes: run }))).toBe('')
    expect(verifLine(view({ etat: 'vert', commandes: run }))).toBe('vérif ✓ 3/3')
  })

  test('verifLine : la porte en panne nomme la commande ; sans commande en panne, « erreur » (revo-flow a planté)', () => {
    expect(verifLine(view({ etat: 'erreur', commandes: [cmd({ id: 'eslint' }), cmd({ id: 'flutter-test', etat: 'erreur', note: 'délai dépassé (10 min 00)' })] }))).toBe('vérif ⚠ panne flutter-test')
    expect(verifLine(view({ etat: 'erreur' }))).toBe('vérif ⚠ erreur')
  })

  const flowAvec = (plafond: number | undefined, depense: number) =>
    ({
      flow: { title: 'T', agents: [{ costUsd: depense / 2 }], budget: { estime: 1, base: 'defaut', flows: 0, ...(plafond === undefined ? {} : { plafond }) } },
      lead: { costUsd: depense / 2 },
    }) as never

  test('budgetView : dépense / plafond, la part, orange à 80 %, rouge à 100 % ; rien sans plafond', () => {
    expect(budgetView(flowAvec(1, 0.5))).toEqual({ text: '0,46 € / 0,92 €', percent: 50, tone: 'dim' })
    expect(budgetView(flowAvec(1, 0.85))!.tone).toBe('warn')
    expect(budgetView(flowAvec(1, 1.2))!.tone).toBe('ko')
    expect(budgetView(flowAvec(undefined, 0.5))).toBeUndefined()
    expect(budgetView({ flow: null, lead: { costUsd: 0 } } as never)).toBeUndefined()
  })

  test('bandNote : la vérification puis le budget ; la couleur du budget l’emporte dès l’alerte', () => {
    const vert = view({ etat: 'vert', commandes: [cmd({ id: 'eslint' })] })
    const d = (plafond: number | undefined, depense: number, verif: VerifView | null) => ({ ...(flowAvec(plafond, depense) as object), verif }) as never
    expect(bandNote(d(1, 0.5, vert))).toEqual({ text: 'vérif ✓ 1/1 · budget 0,46 € / 0,92 €', tone: 'ok' })
    expect(bandNote(d(1, 0.9, vert))).toEqual({ text: 'vérif ✓ 1/1 · budget 0,83 € / 0,92 €', tone: 'warn' })
    expect(bandNote(d(1, 0.5, null))).toEqual({ text: 'budget 0,46 € / 0,92 €', tone: 'dim' })
    expect(bandNote(d(undefined, 0.5, vert))).toEqual({ text: 'vérif ✓ 1/1', tone: 'ok' })
    expect(bandNote(d(undefined, 0.5, null))).toBeUndefined()
  })

  test('preuve web et mobile : « ferme » (question restée sans réponse) se distingue du refus ; le premier build peut être long', () => {
    expect(webLine(view({ web: { etat: 'ferme', captures: [] } }))).toEqual({ mark: '–', tone: 'dim', text: 'preuve web : serveur non démarré (question restée sans réponse)' })
    const m = (o: Partial<MobileView>): MobileView => ({ etat: 'refuse', captures: [], ...o })
    expect(mobileLine(view({ mobile: m({}) }))!.text).toBe('preuve mobile : app non lancée (votre choix)')
    expect(mobileLine(view({ mobile: m({ etat: 'ferme' }) }))!.text).toBe('preuve mobile : app non lancée (question restée sans réponse)')
    expect(mobileLine(view({ mobile: m({ etat: 'installation', commande: 'flutter run -d x', appareil: 'Pixel 8' }) }))!.text).toBe(
      'preuve mobile : « flutter run -d x » sur Pixel 8 (le premier build peut être long, 15 min au plus)',
    )
  })
})

describe('papercuts et agent bloqué (v3.7)', () => {
  test('papercutsLine : flow et projet ; rien si le projet n’en connaît aucun ou sans option', () => {
    expect(papercutsLine({ papercuts: { flow: 2, projet: 5 } })).toBe('papercuts : 2 ce flow · 5 au projet')
    expect(papercutsLine({ papercuts: { flow: 0, projet: 0 } })).toBeUndefined()
    expect(papercutsLine({})).toBeUndefined()
  })

  test('la carte d’un agent actif bloqué porte « semble bloqué » ; pas sans bloque ni à l’arrêt', () => {
    const agent = (o: object) => ({ key: 'a1', name: 'API', status: 'running', model: 'sonnet', effort: 'high', modelId: '', tasks: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, ...o })
    const d = (a: object) =>
      ({ flow: { phase: 'running', agents: [agent(a)], startedAt: 0 }, lead: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 }, busy: false, now: 1000, cache: null }) as never
    const bloque = { outil: 'Bash', suite: 3, depuis: 500 }
    expect(cards(d({ bloque })).find(c => c.id === 'a1')!.bloque).toBe('semble bloqué : 3 échecs de suite (Bash)')
    expect(cards(d({})).find(c => c.id === 'a1')!.bloque).toBeUndefined()
    expect(cards(d({ bloque, status: 'done' })).find(c => c.id === 'a1')!.bloque).toBeUndefined()
  })
})
