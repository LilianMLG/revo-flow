import { describe, expect, test } from 'claude-code/testing'

import {
  PAPERCUTS_MAX,
  PAPERCUT_BRIEF,
  REPONSE_BORNEE,
  addPapercut,
  papercutBrief,
  papercutKey,
  papercutListText,
  papercutRapport,
  parsePapercut,
  readPapercuts,
  stepTrajectoire,
  struggleHint,
  type Papercut,
  type Trajectoire,
} from '../hooks/papercut'

const ctx = { par: 'codeur', flow: 'Un flow', le: '2026-11-27T10:00:00.000Z' }

/** Un papercut valide : ce que parsePapercut rendrait, avec les champs qu'on veut changer. */
const pc = (over: Partial<Papercut> = {}): Papercut => {
  const r = parsePapercut({ quoi: 'lancer le lint', obtenu: 'erreur 12 dans src/a.ts', ...(over as Record<string, unknown>) }, { par: over.par ?? ctx.par, flow: over.flow ?? ctx.flow, le: over.le ?? ctx.le })
  if ('error' in r) throw new Error(r.error)
  return { ...r.papercut, ...(over.vu === undefined ? {} : { vu: over.vu }) }
}

describe('parsePapercut', () => {
  test('quoi et obtenu suffisent : cible « projet », vu 1, id « pc- » et 8 caractères, contexte repris', () => {
    const r = parsePapercut({ quoi: 'lancer les tests', obtenu: 'timeout' }, ctx)
    if ('error' in r) throw new Error(r.error)
    expect(r.papercut.cible).toBe('projet')
    expect(r.papercut.vu).toBe(1)
    expect(/^pc-[0-9a-f]{8}$/.test(r.papercut.id)).toBe(true)
    expect(r.papercut.par).toBe('codeur')
    expect(r.papercut.flow).toBe('Un flow')
    expect(r.papercut.le).toBe(ctx.le)
    expect(r.papercut.outil).toBe(undefined)
  })

  test('quoi ou obtenu manquant, vide ou non textuel : une erreur en français adressée à l’agent', () => {
    for (const input of [{}, { quoi: 'a' }, { obtenu: 'b' }, { quoi: '  ', obtenu: 'b' }, { quoi: 'a', obtenu: 42 }]) {
      const r = parsePapercut(input, ctx)
      expect('error' in r).toBe(true)
      if ('error' in r) expect(r.error.startsWith('revo-flow papercut : ')).toBe(true)
    }
    const r = parsePapercut({ obtenu: 'b' }, ctx)
    if ('error' in r) expect(r.error.includes('quoi')).toBe(true)
    const s = parsePapercut({ quoi: 'a' }, ctx)
    if ('error' in s) expect(s.error.includes('obtenu')).toBe(true)
  })

  test('cible inconnue ou absente : « projet » ; les trois cibles connues sont gardées', () => {
    const cible = (c: unknown) => {
      const r = parsePapercut({ quoi: 'a', obtenu: 'b', cible: c }, ctx)
      return 'papercut' in r ? r.papercut.cible : 'erreur'
    }
    expect(cible('revo-flow')).toBe('revo-flow')
    expect(cible('outil')).toBe('outil')
    expect(cible('projet')).toBe('projet')
    expect(cible('autre')).toBe('projet')
    expect(cible(undefined)).toBe('projet')
    expect(cible(3)).toBe('projet')
  })

  test('les textes sont rognés et tronqués à 300 caractères avec « … » ; les champs vides sont omis', () => {
    const long = 'x'.repeat(500)
    const r = parsePapercut({ quoi: `  ${long}  `, obtenu: 'o', attendu: long, correctif: long, contournement: long, outil: '  Bash  ' }, ctx)
    if ('error' in r) throw new Error(r.error)
    const p = r.papercut
    for (const t of [p.quoi, p.attendu, p.correctif, p.contournement]) {
      expect(t?.length).toBe(300)
      expect(t?.endsWith('…')).toBe(true)
    }
    expect(p.outil).toBe('Bash')
    const v = parsePapercut({ quoi: 'a', obtenu: 'b', attendu: '  ', correctif: '' }, ctx)
    if ('error' in v) throw new Error(v.error)
    expect('attendu' in v.papercut).toBe(false)
    expect('correctif' in v.papercut).toBe(false)
  })

  test('un texte de 300 caractères exactement n’est pas tronqué', () => {
    const r = parsePapercut({ quoi: 'y'.repeat(300), obtenu: 'b' }, ctx)
    if ('error' in r) throw new Error(r.error)
    expect(r.papercut.quoi).toBe('y'.repeat(300))
  })

  test('une entrée qui n’est pas un objet ne lève pas', () => {
    expect('error' in parsePapercut(null as never, ctx)).toBe(true)
    expect('error' in parsePapercut('x' as never, ctx)).toBe(true)
  })
})

describe('papercutKey', () => {
  test('cible, outil (minuscules) et obtenu séparés par « | »', () => {
    expect(papercutKey({ cible: 'outil', outil: 'Bash', obtenu: 'Boom' })).toBe('outil|bash|boom')
    expect(papercutKey({ cible: 'projet', obtenu: 'Boom' })).toBe('projet||boom')
  })

  test('deux erreurs qui ne diffèrent que par un numéro de ligne ont la même clé', () => {
    const a = papercutKey({ cible: 'projet', outil: 'npm run lint', obtenu: 'Error at line 12 col 4' })
    const b = papercutKey({ cible: 'projet', outil: 'npm run lint', obtenu: 'Error at line 340 col 18' })
    expect(a).toBe(b)
    expect(a.includes('#')).toBe(true)
  })

  test('deux erreurs qui ne diffèrent que par un chemin ont la même clé (POSIX et Windows)', () => {
    const a = papercutKey({ cible: 'projet', obtenu: 'ENOENT /home/ann/proj/src/a.ts introuvable' })
    const b = papercutKey({ cible: 'projet', obtenu: 'ENOENT /tmp/x/y/b.ts introuvable' })
    expect(a).toBe(b)
    expect(a.includes('<chemin>')).toBe(true)
    const c = papercutKey({ cible: 'projet', obtenu: 'ENOENT C:\\Users\\bob\\proj\\a.ts introuvable' })
    const d = papercutKey({ cible: 'projet', obtenu: 'ENOENT D:\\autre\\b.ts introuvable' })
    expect(c).toBe(d)
    expect(c).toBe(a)
  })

  test('la casse et les espaces ne comptent pas ; la partie obtenu est coupée à 120 caractères', () => {
    expect(papercutKey({ cible: 'projet', obtenu: '  Échec   TOTAL ' })).toBe(papercutKey({ cible: 'projet', obtenu: 'échec total' }))
    const k = papercutKey({ cible: 'projet', obtenu: 'a'.repeat(400) })
    expect(k).toBe(`projet||${'a'.repeat(120)}`)
  })

  test('une cible, un outil ou une erreur différents donnent des clés différentes', () => {
    const base = { cible: 'projet' as const, outil: 'Bash', obtenu: 'boom' }
    expect(papercutKey(base) === papercutKey({ ...base, cible: 'outil' })).toBe(false)
    expect(papercutKey(base) === papercutKey({ ...base, outil: 'Edit' })).toBe(false)
    expect(papercutKey(base) === papercutKey({ ...base, obtenu: 'bang' })).toBe(false)
  })

  test('l’id suit la clé : mêmes clés, même id ; clés différentes, ids différents', () => {
    const a = pc({ obtenu: 'erreur 12 dans /a/b/c.ts' } as never)
    const b = pc({ obtenu: 'erreur 99 dans /x/y/z.ts' } as never)
    const c = pc({ obtenu: 'tout autre chose' } as never)
    expect(a.id).toBe(b.id)
    expect(a.id === c.id).toBe(false)
  })
})

describe('addPapercut', () => {
  test('un papercut nouveau s’ajoute en tête', () => {
    const a = pc({ obtenu: 'un' } as never)
    const b = pc({ obtenu: 'deux' } as never)
    const r1 = addPapercut([], a)
    expect(r1.nouveau).toBe(true)
    expect(r1.vu).toBe(1)
    const r2 = addPapercut(r1.list, b)
    expect(r2.nouveau).toBe(true)
    expect(r2.list.map(p => p.id)).toEqual([b.id, a.id])
  })

  test('même clé : fusion, vu + 1, date, agent et flow du nouveau, l’entrée passe en tête', () => {
    const a = pc({ obtenu: 'erreur 1', par: 'ann', flow: 'F1', le: '2026-11-01T00:00:00.000Z' } as never)
    const autre = pc({ obtenu: 'autre' } as never)
    const base = addPapercut(addPapercut([], a).list, autre).list
    expect(base[0]?.id).toBe(autre.id)
    const neuf = pc({ obtenu: 'erreur 2', par: 'bob', flow: 'F2', le: '2026-11-02T00:00:00.000Z' } as never)
    const r = addPapercut(base, neuf)
    expect(r.nouveau).toBe(false)
    expect(r.vu).toBe(2)
    expect(r.list.length).toBe(2)
    expect(r.list[0]?.id).toBe(a.id)
    expect(r.list[0]?.vu).toBe(2)
    expect(r.list[0]?.par).toBe('bob')
    expect(r.list[0]?.flow).toBe('F2')
    expect(r.list[0]?.le).toBe('2026-11-02T00:00:00.000Z')
    expect(r.list[0]?.obtenu).toBe('erreur 1')
  })

  test('la fusion garde le correctif et le contournement quand le nouveau n’en a pas, les remplace sinon', () => {
    const a = pc({ obtenu: 'boom 1', correctif: 'corriger X', contournement: 'faire Y' } as never)
    const sans = addPapercut([a], pc({ obtenu: 'boom 2' } as never))
    expect(sans.list[0]?.correctif).toBe('corriger X')
    expect(sans.list[0]?.contournement).toBe('faire Y')
    const avec = addPapercut(sans.list, pc({ obtenu: 'boom 3', correctif: 'corriger Z', contournement: 'faire W' } as never))
    expect(avec.list[0]?.correctif).toBe('corriger Z')
    expect(avec.list[0]?.contournement).toBe('faire W')
    expect(avec.vu).toBe(3)
  })

  test('la liste ne dépasse jamais PAPERCUTS_MAX : les plus anciens tombent', () => {
    let list: Papercut[] = []
    for (let i = 0; i < PAPERCUTS_MAX + 10; i++) list = addPapercut(list, pc({ obtenu: `erreur-${'x'.repeat(i)}` } as never)).list
    expect(PAPERCUTS_MAX).toBe(50)
    expect(list.length).toBe(PAPERCUTS_MAX)
    expect(list[0]?.obtenu).toBe(`erreur-${'x'.repeat(PAPERCUTS_MAX + 9)}`)
    expect(list.some(p => p.obtenu === 'erreur-')).toBe(false)
  })

  test('la liste d’origine n’est pas modifiée', () => {
    const a = pc({ obtenu: 'un' } as never)
    const base = [a]
    addPapercut(base, pc({ obtenu: 'un' } as never))
    expect(base.length).toBe(1)
    expect(base[0]?.vu).toBe(1)
  })
})

describe('readPapercuts', () => {
  test('ce qui n’est pas un tableau donne []', () => {
    for (const v of [undefined, null, 'x', 3, {}, { id: 'pc-1' }]) expect(readPapercuts(v)).toEqual([])
  })

  test('seuls les objets valides sont gardés', () => {
    const bon = pc({ obtenu: 'bon' } as never)
    const lu = readPapercuts([bon, null, 'x', {}, { ...bon, id: 3 }, { ...bon, cible: 'ailleurs' }, { ...bon, quoi: '' }, { ...bon, par: undefined }, { ...bon, le: 1 }])
    expect(lu.length).toBe(1)
    expect(lu[0]).toEqual(bon)
  })

  test('un vu absent ou absurde vaut 1 ; les champs optionnels mal typés sont ignorés', () => {
    const bon = pc({ obtenu: 'bon' } as never)
    const lu = readPapercuts([{ ...bon, vu: 'beaucoup', attendu: 3, correctif: ['a'] }])
    expect(lu[0]?.vu).toBe(1)
    expect('attendu' in (lu[0] ?? {})).toBe(false)
    expect('correctif' in (lu[0] ?? {})).toBe(false)
    expect(readPapercuts([{ ...bon, vu: 0 }])[0]?.vu).toBe(1)
  })
})

describe('papercutBrief', () => {
  test('sans papercut : chaîne vide', () => {
    expect(papercutBrief([])).toBe('')
    expect(papercutBrief(undefined as never)).toBe('')
  })

  test('titre, une ligne par papercut avec ×vu, contournement seulement s’il existe, ligne finale', () => {
    const a = pc({ obtenu: 'bang', contournement: 'relancer en CI' } as never)
    const b = pc({ obtenu: 'boom' } as never)
    const t = papercutBrief([{ ...a, vu: 3 }, b])
    const lignes = t.split('\n')
    expect(lignes[0]).toBe('## Papercuts connus du projet')
    expect(lignes[1]).toBe('- [×3] lancer le lint → bang ; contournement : relancer en CI')
    expect(lignes[2]).toBe('- [×1] lancer le lint → boom')
    expect(lignes[3]).toBe('Évite ces pièges ; si tu en rencontres un nouveau, signale-le avec mcp__revo-flow__papercut.')
    expect(lignes.length).toBe(4)
  })

  test('les plus vus d’abord, puis les plus récents', () => {
    const vieux = { ...pc({ obtenu: 'vieux' } as never), le: '2026-01-01T00:00:00.000Z', vu: 1 }
    const recent = { ...pc({ obtenu: 'recent' } as never), le: '2026-06-01T00:00:00.000Z', vu: 1 }
    const frequent = { ...pc({ obtenu: 'frequent' } as never), le: '2026-02-01T00:00:00.000Z', vu: 4 }
    const lignes = papercutBrief([vieux, recent, frequent]).split('\n').slice(1, 4)
    expect(lignes.map(l => l.split('→ ')[1])).toEqual(['frequent', 'recent', 'vieux'])
  })

  test('max borne le nombre de lignes (5 par défaut)', () => {
    const l = Array.from({ length: 8 }, (_, i) => pc({ obtenu: `e${'z'.repeat(i)}` } as never))
    const lignes = (t: string) => t.split('\n').filter(x => x.startsWith('- ['))
    expect(lignes(papercutBrief(l)).length).toBe(5)
    expect(lignes(papercutBrief(l, 3)).length).toBe(3)
    expect(lignes(papercutBrief(l, 20)).length).toBe(8)
    expect(papercutBrief(l, 0)).toBe('')
  })

  test('la liste d’origine n’est pas réordonnée', () => {
    const a = { ...pc({ obtenu: 'a' } as never), vu: 1 }
    const b = { ...pc({ obtenu: 'b' } as never), vu: 9 }
    const l = [a, b]
    papercutBrief(l)
    expect(l[0]).toBe(a)
  })
})

describe('papercutListText', () => {
  test('vide : « aucun papercut signalé »', () => {
    expect(papercutListText([], 'mon-projet')).toBe('revo-flow papercuts · mon-projet : aucun papercut signalé.')
  })

  test('le compte, puis un bloc complet par papercut', () => {
    const a = pc({ obtenu: 'bang', outil: 'npm run lint', attendu: 'du vert', correctif: 'corriger la config', contournement: 'lancer à la main' } as never)
    const b = pc({ obtenu: 'boom' } as never)
    const t = papercutListText([{ ...a, vu: 2 }, b], 'mon-projet')
    expect(t.startsWith('revo-flow papercuts · mon-projet : 2 papercuts\n')).toBe(true)
    for (const s of [a.id, b.id, 'projet', 'npm run lint', 'lancer le lint', 'du vert', 'bang', 'corriger la config', 'lancer à la main', 'vu ×2', 'codeur', '2026-11-27']) expect(t.includes(s)).toBe(true)
    expect(t.includes('attendu : undefined')).toBe(false)
  })

  test('un seul papercut : singulier', () => {
    expect(papercutListText([pc()], 'p').split('\n')[0]).toBe('revo-flow papercuts · p : 1 papercut')
  })
})

describe('papercutRapport', () => {
  test('sans papercut ni trajectoire : le titre et la ligne Absent', () => {
    expect(papercutRapport([], [])).toEqual(['## Papercuts et trajectoire', '', '*Absent : aucun papercut signalé.*', ''])
  })

  test('avec papercuts : une ligne chacun, cible, outil, quoi, obtenu ; pas de tableau sans trajectoire', () => {
    const t = papercutRapport([pc({ obtenu: 'bang', outil: 'Bash', correctif: 'corriger' } as never)], []).join('\n')
    expect(t.includes('## Papercuts et trajectoire')).toBe(true)
    expect(t.includes('**projet** (Bash) : lancer le lint → bang ; correctif : corriger')).toBe(true)
    expect(t.includes('Absent')).toBe(false)
    expect(t.includes('| Agent |')).toBe(false)
  })

  test('avec trajectoires : le tableau Agent, Appels d’outils, Échecs', () => {
    const lignes = papercutRapport([], [{ nom: 'codeur', appels: 12, echecs: 3 }, { nom: 'a|b', appels: 0, echecs: 0 }])
    expect(lignes.includes('| Agent | Appels d\'outils | Échecs |')).toBe(true)
    expect(lignes.includes('| codeur | 12 | 3 |')).toBe(true)
    expect(lignes.includes('| a\\|b | 0 | 0 |')).toBe(true)
    expect(lignes.includes('*Absent : aucun papercut signalé.*')).toBe(true)
    expect(lignes[lignes.length - 1]).toBe('')
  })
})

describe('consignes', () => {
  test('PAPERCUT_BRIEF nomme l’outil papercut', () => {
    expect(PAPERCUT_BRIEF.includes('mcp__revo-flow__papercut')).toBe(true)
    expect(PAPERCUT_BRIEF.includes('ne t’acharne pas')).toBe(true)
  })

  test('REPONSE_BORNEE borne la réponse à 15 lignes', () => {
    expect(REPONSE_BORNEE.includes('15 lignes au plus')).toBe(true)
  })

  test('struggleHint : le nombre d’échecs, l’outil, l’outil papercut', () => {
    const h = struggleHint('Bash', 3)
    expect(h.startsWith('revo-flow : 3 échecs de suite (dernier : Bash).')).toBe(true)
    expect(h.includes('mcp__revo-flow__papercut')).toBe(true)
    expect(h.includes('change d’approche')).toBe(true)
  })
})

describe('stepTrajectoire', () => {
  const echec = (outil: string, erreur?: string) => ({ outil, echec: true, erreur })
  const ok = (outil: string) => ({ outil, echec: false })

  /** Rejoue des appels : la trajectoire finale et les alertes rendues. */
  const rejoue = (...appels: { outil: string; echec: boolean; erreur?: string }[]) => {
    let t: Trajectoire | undefined
    const alertes: ({ outil: string; suite: number } | undefined)[] = []
    for (const a of appels) {
      const r = stepTrajectoire(t, a)
      t = r.t
      alertes.push(r.alerte)
    }
    return { t: t as Trajectoire, alertes }
  }

  test('le premier appel part de zéro ; un succès compte l’appel seulement', () => {
    const { t, alertes } = rejoue(ok('Read'))
    expect(t).toEqual({ appels: 1, echecs: 0, suite: 0, memeErreur: 0, alerte: false })
    expect(alertes).toEqual([undefined])
  })

  test('trois échecs de suite avec des erreurs différentes : une alerte, à la troisième', () => {
    const { t, alertes } = rejoue(echec('Bash', 'a'), echec('Bash', 'b'), echec('Edit', 'c'))
    expect(alertes).toEqual([undefined, undefined, { outil: 'Edit', suite: 3 }])
    expect(t.appels).toBe(3)
    expect(t.echecs).toBe(3)
    expect(t.suite).toBe(3)
    expect(t.alerte).toBe(true)
  })

  test('l’alerte n’est rendue qu’une fois : pas de nouvelle alerte tant qu’aucun succès n’a eu lieu', () => {
    const { alertes, t } = rejoue(echec('Bash', 'a'), echec('Bash', 'b'), echec('Bash', 'c'), echec('Bash', 'd'), echec('Bash', 'e'))
    expect(alertes.filter(Boolean).length).toBe(1)
    expect(t.suite).toBe(5)
  })

  test('la même erreur deux fois de suite : alerte dès la deuxième', () => {
    const { alertes, t } = rejoue(echec('Bash', 'command not found: foo'), echec('Bash', 'command not found: foo'))
    expect(alertes).toEqual([undefined, { outil: 'Bash', suite: 2 }])
    expect(t.memeErreur).toBe(2)
    expect(t.alerte).toBe(true)
  })

  test('la signature ignore la casse et les nombres : « ligne 12 » et « LIGNE 40 » sont la même erreur', () => {
    const { alertes } = rejoue(echec('Bash', 'Erreur ligne 12'), echec('Bash', 'ERREUR LIGNE 40'))
    expect(alertes[1]).toEqual({ outil: 'Bash', suite: 2 })
  })

  test('la signature est coupée à 80 caractères', () => {
    const a = `${'x'.repeat(80)} fin 1`
    const b = `${'x'.repeat(80)} fin 2`
    const { t, alertes } = rejoue(echec('Bash', a), echec('Bash', b))
    expect(alertes[1]).toEqual({ outil: 'Bash', suite: 2 })
    expect(t.derniereErreur?.length).toBe(80)
  })

  test('un succès remet la série et la répétition à 0 et réarme l’alerte', () => {
    const { t, alertes } = rejoue(echec('Bash', 'x'), echec('Bash', 'x'), ok('Read'), echec('Bash', 'x'), echec('Bash', 'x'))
    expect(alertes.map(a => a !== undefined)).toEqual([false, true, false, false, true])
    expect(t.appels).toBe(5)
    expect(t.echecs).toBe(4)
    const apres = rejoue(echec('Bash', 'x'), echec('Bash', 'x'), ok('Read'))
    expect(apres.t).toEqual({ appels: 3, echecs: 2, suite: 0, memeErreur: 0, alerte: false })
  })

  test('des erreurs différentes entrecoupées de succès ne déclenchent rien', () => {
    const { alertes, t } = rejoue(echec('Bash', 'a'), ok('Read'), echec('Bash', 'b'), ok('Read'), echec('Bash', 'c'), ok('Read'))
    expect(alertes.filter(Boolean).length).toBe(0)
    expect(t.echecs).toBe(3)
    expect(t.suite).toBe(0)
  })

  test('des échecs sans texte d’erreur ne se comptent pas comme « la même erreur » : l’alerte vient à trois', () => {
    const { alertes } = rejoue(echec('Bash'), echec('Bash'), echec('Bash'))
    expect(alertes).toEqual([undefined, undefined, { outil: 'Bash', suite: 3 }])
  })

  test('la trajectoire d’origine n’est pas modifiée', () => {
    const t0: Trajectoire = { appels: 1, echecs: 1, suite: 1, derniereErreur: 'x', memeErreur: 1, alerte: false }
    const r = stepTrajectoire(t0, echec('Bash', 'x'))
    expect(t0.suite).toBe(1)
    expect(r.t.suite).toBe(2)
    expect(r.alerte).toEqual({ outil: 'Bash', suite: 2 })
  })
})
