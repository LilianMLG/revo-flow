import { describe, expect, test } from 'claude-code/testing'

import type { VerifCommande } from '../types/verif'
import { STEWARD_DEBUT, STEWARD_FIN, STEWARD_PAPERCUTS_MAX, stewardRegles, stewardSkill } from '../hooks/steward'
import type { Papercut } from '../hooks/papercut'

const pc = (over: Partial<Papercut> = {}): Papercut => ({
  id: 'pc-00000000',
  cible: 'projet',
  quoi: 'lancer le lint',
  obtenu: 'option --fix refusée',
  contournement: 'lancer eslint sans --fix',
  par: 'codeur',
  flow: 'Un flow',
  le: '2026-11-27T10:00:00.000Z',
  vu: 2,
  ...over,
})

const cmd = (over: Partial<VerifCommande> = {}): VerifCommande => ({ id: 'lint', outil: 'lint', argv: ['npm', 'run', 'lint'], portee: 'projet', format: 'texte', source: 'script', ...over })

const vide = { papercuts: [], commandes: [], instables: [] }

describe('stewardSkill : papercuts', () => {
  test('seuls les papercuts du projet vus au moins 2 fois avec un contournement ou un correctif deviennent des règles', () => {
    const r = stewardRegles({
      ...vide,
      papercuts: [
        pc({ quoi: 'gardé contournement' }),
        pc({ quoi: 'gardé correctif', contournement: undefined, correctif: 'ajouter le script' }),
        pc({ quoi: 'vu une fois', vu: 1 }),
        pc({ quoi: 'cible outil', cible: 'outil' }),
        pc({ quoi: 'cible revo-flow', cible: 'revo-flow' }),
        pc({ quoi: 'rien d actionnable', contournement: undefined }),
      ],
    })
    expect(r.length).toBe(2)
    expect(r.some(x => x.includes('gardé contournement') && x.includes('Contournement : lancer eslint sans --fix'))).toBe(true)
    expect(r.some(x => x.includes('gardé correctif') && x.includes('Correctif à faire : ajouter le script'))).toBe(true)
  })

  test('triés par vu puis date, plafonnés, sur une ligne', () => {
    const list = Array.from({ length: STEWARD_PAPERCUTS_MAX + 5 }, (_, i) => pc({ quoi: `p${i}`, obtenu: `erreur\n  ${i}`, vu: 2, le: `2026-11-${String(10 + i).padStart(2, '0')}T00:00:00.000Z` }))
    list.push(pc({ quoi: 'le plus vu', vu: 9, le: '2026-01-01T00:00:00.000Z' }))
    const r = stewardRegles({ ...vide, papercuts: list })
    expect(r.length).toBe(STEWARD_PAPERCUTS_MAX)
    expect(r[0].startsWith('le plus vu')).toBe(true)
    expect(r[1].startsWith(`p${STEWARD_PAPERCUTS_MAX + 4}`)).toBe(true)
    expect(r.every(x => !x.includes('\n'))).toBe(true)
  })
})

describe('stewardSkill : fichier neuf', () => {
  test('frontmatter exact, intro, bloc entre marqueurs', () => {
    const { texte, regles } = stewardSkill(undefined, { ...vide, commandes: [cmd()] })
    expect(regles).toBe(1)
    expect(
      texte.startsWith(
        "---\nname: steward\ndescription: Règles maison pour s'occuper des PR de ce dépôt\nuser-invocable: false\ndisable-model-invocation: true\n---\n\n",
      ),
    ).toBe(true)
    expect(texte.includes(`${STEWARD_DEBUT}\n`)).toBe(true)
    expect(texte.endsWith(`${STEWARD_FIN}\n`)).toBe(true)
    expect(texte.includes('- Avant de pousser un correctif, lance `npm run lint`.')).toBe(true)
  })

  test('sans règle : 0 et un bloc qui le dit, sans puce', () => {
    const { texte, regles } = stewardSkill(undefined, vide)
    expect(regles).toBe(0)
    expect(texte.includes('Rien encore')).toBe(true)
    expect(texte.includes('\n- ')).toBe(false)
  })
})

describe('stewardSkill : fichier existant', () => {
  test('le texte hors marqueurs est gardé, seul le bloc change ; idempotent', () => {
    const premier = stewardSkill(undefined, { ...vide, instables: ['e2e-nightly'] }).texte
    const main = premier.replace(STEWARD_DEBUT, `- Règle écrite à la main.\n\n${STEWARD_DEBUT}`) + '\nNote de fin.\n'
    const r = stewardSkill(main, { ...vide, commandes: [cmd()] })
    const avant = main.slice(0, main.indexOf(STEWARD_DEBUT))
    const apres = main.slice(main.indexOf(STEWARD_FIN) + STEWARD_FIN.length)
    expect(r.texte.startsWith(avant)).toBe(true)
    expect(r.texte.endsWith(apres)).toBe(true)
    expect(r.texte.includes('e2e-nightly')).toBe(false)
    expect(r.texte.includes('npm run lint')).toBe(true)
    expect(stewardSkill(r.texte, { ...vide, commandes: [cmd()] }).texte).toBe(r.texte)
  })

  test('sans marqueurs : bloc ajouté à la fin, le reste gardé, puis idempotent', () => {
    const main = '---\nname: steward\n---\n\n- Ma règle.'
    const r = stewardSkill(main, { ...vide, instables: ['e2e-nightly'] })
    expect(r.texte.startsWith(`${main}\n\n${STEWARD_DEBUT}`)).toBe(true)
    expect(r.texte.endsWith(`${STEWARD_FIN}\n`)).toBe(true)
    expect(stewardSkill(r.texte, { ...vide, instables: ['e2e-nightly'] }).texte).toBe(r.texte)
  })

  test('marqueur de début sans fin : le bloc remplace la suite, puis idempotent', () => {
    const main = `- Ma règle.\n${STEWARD_DEBUT}\nvieux`
    const r = stewardSkill(main, vide)
    expect(r.texte.startsWith(`- Ma règle.\n${STEWARD_DEBUT}`)).toBe(true)
    expect(r.texte.includes('vieux')).toBe(false)
    expect(stewardSkill(r.texte, vide).texte).toBe(r.texte)
  })

  test('fins de ligne CRLF gardées', () => {
    const main = '- Ma règle.\r\n'
    const r = stewardSkill(main, { ...vide, commandes: [cmd()] })
    expect(r.texte.includes(`${STEWARD_DEBUT}\r\n`)).toBe(true)
    expect(stewardSkill(r.texte, { ...vide, commandes: [cmd()] }).texte).toBe(r.texte)
  })
})

describe('stewardSkill : commandes, instables, pièges', () => {
  test('lint, typage et tests présents, jetons retirés ; crap, format et argv vide ignorés', () => {
    const r = stewardRegles({
      ...vide,
      commandes: [
        cmd(),
        cmd({ id: 'tsc', outil: 'typage', argv: ['npx', 'tsc', '--noEmit'] }),
        cmd({ id: 'vitest', outil: 'tests', argv: ['npx', 'vitest', 'related', '--run', '{fichiers}', '--outputFile', '{sorties}/v.json', '--reporter=json'] }),
        cmd({ id: 'crap', outil: 'qualite', argv: [], format: 'crap' }),
        cmd({ id: 'prettier', outil: 'format', argv: ['npx', 'prettier', '--check', '.'] }),
        cmd({ id: 'vide', outil: 'tests', argv: [] }),
      ],
      instables: ['e2e-nightly'],
      pieges: ['Pas de package.json : lancer depuis la racine.'],
    })
    expect(r).toEqual([
      'Avant de pousser un correctif, lance `npm run lint`.',
      'Avant de pousser un correctif, lance `npx tsc --noEmit`.',
      'Avant de pousser un correctif, lance `npx vitest related --run --reporter=json` sur les fichiers modifiés.',
      "`e2e-nightly` est instable : relance-le une fois avant d'en chercher la cause.",
      'Pas de package.json : lancer depuis la racine.',
    ])
  })

  test('doublons retirés', () => {
    expect(stewardRegles({ ...vide, commandes: [cmd(), cmd({ id: 'lint2' })] }).length).toBe(1)
  })
})

describe('stewardSkill : entrées bizarres', () => {
  test('rien ne lève', () => {
    const bizarres: unknown[] = [undefined, null, 42, 'x', {}, { papercuts: 'x', commandes: [null, 1, { outil: 'lint', argv: [null, 3] }], instables: [null, 4, ''], pieges: [{}, ''] }]
    for (const b of bizarres) {
      const r = stewardSkill(undefined, b as never)
      expect(r.regles).toBe(0)
      expect(r.texte.includes(STEWARD_DEBUT)).toBe(true)
    }
    expect(stewardSkill(42 as never, vide).texte.startsWith('---\nname: steward')).toBe(true)
    expect(stewardSkill('   \n', vide).texte.startsWith('---\nname: steward')).toBe(true)
  })

  test('un marqueur glissé dans un texte ne casse pas le bloc', () => {
    const r = stewardSkill(undefined, { ...vide, papercuts: [pc({ quoi: `a ${STEWARD_FIN} b` })] })
    expect(r.texte.split(STEWARD_FIN).length).toBe(2)
    expect(stewardSkill(r.texte, { ...vide, papercuts: [pc({ quoi: `a ${STEWARD_FIN} b` })] }).texte).toBe(r.texte)
  })
})
