// La livraison (v3.4, docs/rd-v3/README.md §3 ter), module pur : forge, branche, message de commit, fichiers, question, gh.
// Écrits d'après la spec, pas d'après le code.
import { describe, expect, test } from 'claude-code/testing'

import {
  LIVRER_BROUILLON,
  LIVRER_NON,
  LIVRER_POUSSER,
  LIVRER_PRETE,
  argsPrCreate,
  brancheDeLivraison,
  doctorLivraison,
  fichiersDeLivraison,
  forgeDe,
  hoteDuRemote,
  hotesGh,
  ligneRapport,
  messageCommit,
  questionLivraison,
  urlDePr,
} from '../hooks/livraison'

describe('forge', () => {
  test('hoteDuRemote : https, ssh, scp, avec utilisateur et port ; rien pour un chemin local', () => {
    expect(hoteDuRemote('https://github.com/moi/app.git')).toBe('github.com')
    expect(hoteDuRemote('git@github.com:moi/app.git')).toBe('github.com')
    expect(hoteDuRemote('ssh://git@git.entreprise.local:2222/equipe/app.git')).toBe('git.entreprise.local')
    expect(hoteDuRemote('https://jeton@GHE.Entreprise.fr/o/r\n')).toBe('ghe.entreprise.fr')
    expect(hoteDuRemote('/srv/depots/app.git')).toBeUndefined()
    expect(hoteDuRemote('C:/depots/app.git')).toBeUndefined()
    expect(hoteDuRemote('')).toBeUndefined()
  })

  test('forgeDe : github.com et les hôtes de gh → GitHub ; gitlab, hôte de glab ou .gitlab-ci.yml → GitLab ; sinon autre', () => {
    expect(forgeDe('github.com')).toEqual({ forge: 'github', hote: 'github.com' })
    expect(forgeDe('ghe.entreprise.fr', { ghHotes: ['ghe.entreprise.fr'] })).toEqual({ forge: 'github', hote: 'ghe.entreprise.fr' })
    expect(forgeDe('gitlab.com')).toEqual({ forge: 'gitlab', hote: 'gitlab.com' })
    expect(forgeDe('git.entreprise.local', { glabHotes: ['git.entreprise.local'] }).forge).toBe('gitlab')
    expect(forgeDe('git.entreprise.local', { gitlabCi: true }).forge).toBe('gitlab')
    expect(forgeDe('bitbucket.org')).toEqual({ forge: 'autre', hote: 'bitbucket.org' })
    expect(forgeDe(undefined)).toEqual({ forge: 'autre' })
  })

  test('hotesGh : les hôtes listés par gh auth status', () => {
    const sortie = 'github.com\n  ✓ Logged in to github.com account moi (keyring)\n  - Active account: true\nghe.entreprise.fr\n  X Failed to log in\n'
    expect(hotesGh(sortie)).toEqual(['github.com', 'ghe.entreprise.fr'])
    expect(hotesGh('')).toEqual([])
  })
})

describe('branche', () => {
  test('une branche de travail est gardée', () => {
    expect(brancheDeLivraison('feat/panier', 'main', 'Code promo')).toEqual({ branche: 'feat/panier', nouvelle: false })
  })

  test('sur main, master, la branche par défaut ou une tête détachée : revo/<titre>, suffixée si prise', () => {
    expect(brancheDeLivraison('main', 'main', 'Code promo dans le panier')).toEqual({ branche: 'revo/code-promo-dans-le-panier', nouvelle: true })
    expect(brancheDeLivraison('develop', 'develop', 'Écran réservation')).toEqual({ branche: 'revo/ecran-reservation', nouvelle: true })
    expect(brancheDeLivraison('HEAD', 'main', 'x')).toEqual({ branche: 'revo/x', nouvelle: true })
    expect(brancheDeLivraison('master', undefined, '!!!')).toEqual({ branche: 'revo/flow', nouvelle: true })
    expect(brancheDeLivraison('main', 'main', 'Code promo', ['main', 'revo/code-promo', 'origin/revo/code-promo-2'])).toEqual({ branche: 'revo/code-promo-3', nouvelle: true })
    expect(brancheDeLivraison('main', 'main', 'a'.repeat(80)).branche.length).toBeLessThanOrEqual(5 + 48)
  })
})

describe('message de commit', () => {
  const GITMOJI = ['✨ feat: v3.2, garde', '🐛 fix: v3.1.1, vérificateur', 'Merge pull request #2 from x', '📝 docs: GIF']
  test('au style du dépôt : gitmoji, conventionnel, ou le titre seul ; le résumé en corps', () => {
    expect(messageCommit('Code promo dans le panier', 'Ajoute le champ et la validation.', GITMOJI)).toBe('✨ feat: code promo dans le panier\n\nAjoute le champ et la validation.')
    expect(messageCommit('Code promo', '', ['feat(panier): x', 'fix: y', 'chore: z'])).toBe('feat: code promo')
    expect(messageCommit('Code promo', undefined, ['Ajout du panier', 'Correction'])).toBe('Code promo')
    expect(messageCommit('Code promo', undefined, [])).toBe('Code promo')
    expect(messageCommit('  ', undefined, [])).toBe('flow revo-flow')
  })
})

describe('fichiers', () => {
  const st = (x: string, y: string, p: string) => ({ x, y, p })
  test('les fichiers du flow que git voit changés, suppressions et nouveaux compris ; pas ceux d’avant le flow non touchés', () => {
    const statut = [st(' ', 'M', 'components/Basket.vue'), st('?', '?', 'lib/promo.ts'), st(' ', 'D', 'lib/vieux.ts'), st(' ', 'M', 'notes.md'), st(' ', 'M', 'store/cart.ts')]
    const r = fichiersDeLivraison(['components/Basket.vue', 'lib/vieux.ts', 'lib/inchange.ts', 'store/cart.ts'], statut, new Set(['notes.md', 'store/cart.ts']))
    expect(r.fichiers).toEqual(['components/Basket.vue', 'lib/promo.ts', 'lib/vieux.ts', 'store/cart.ts'])
    expect(r.dejaSales).toEqual(['store/cart.ts'])
  })

  test('rien de changé : rien à livrer', () => {
    expect(fichiersDeLivraison(['a.ts'], [], new Set())).toEqual({ fichiers: [], dejaSales: [] })
  })
})

describe('question, gh, rapport, doctor', () => {
  test('nouvelle PR : brouillon, prête ou pas maintenant ; la branche, la base, les fichiers déjà modifiés', () => {
    const q = questionLivraison({ titre: 'Code promo', branche: 'revo/code-promo', nouvelle: true, base: 'main', fichiers: ['a.ts', 'b.ts'], dejaSales: ['b.ts'] })
    expect(q.options).toEqual([LIVRER_BROUILLON, LIVRER_PRETE, LIVRER_NON])
    expect(q.question).toContain('2 fichiers du flow (dont 1 fichier déjà modifié avant le flow : b.ts)')
    expect(q.question).toContain('nouvelle branche revo/code-promo')
    expect(q.question).toContain('PR vers main pour « Code promo »')
    expect(q.question).toContain('ne fusionne jamais')
  })

  test('PR déjà ouverte sur la branche : pousser dessus ou pas maintenant', () => {
    const q = questionLivraison({ titre: 'x', branche: 'feat/x', nouvelle: false, base: 'main', fichiers: ['a.ts'], dejaSales: [], prExistante: 'https://github.com/o/r/pull/7' })
    expect(q.options).toEqual([LIVRER_POUSSER, LIVRER_NON])
    expect(q.question).toContain('1 fichier du flow sur feat/x')
    expect(q.question).toContain('https://github.com/o/r/pull/7')
  })

  test('gh pr create : base, branche, titre, rapport en description, --draft pour un brouillon', () => {
    expect(argsPrCreate({ base: 'main', branche: 'revo/x', titre: 'X', corps: '/h/rapports/x.md', brouillon: true })).toEqual([
      'gh', 'pr', 'create', '--base', 'main', '--head', 'revo/x', '--title', 'X', '--body-file', '/h/rapports/x.md', '--draft',
    ])
    expect(argsPrCreate({ base: 'main', branche: 'revo/x', titre: 'X', corps: 'r.md', brouillon: false })).not.toContain('--draft')
  })

  test('urlDePr : la dernière URL de PR de la sortie', () => {
    expect(urlDePr('Creating pull request for revo/x into main\n\nhttps://github.com/o/r/pull/12\n')).toBe('https://github.com/o/r/pull/12')
    expect(urlDePr('Warning: 1 uncommitted change\nhttps://ghe.local/o/r/pull/3')).toBe('https://ghe.local/o/r/pull/3')
    expect(urlDePr('error: no commits')).toBeUndefined()
  })

  test('la ligne du rapport et la ligne de doctor', () => {
    expect(ligneRapport('https://github.com/o/r/pull/12', 'revo/x', true, false)).toContain('PR ouverte en brouillon : https://github.com/o/r/pull/12 (branche revo/x)')
    expect(ligneRapport('u', 'b', false, true)).toContain('Poussé sur la PR')
    expect(doctorLivraison({ option: true, forge: { forge: 'github', hote: 'github.com' }, gh: 'connecte', defaut: 'main' })).toMatch(/^GitHub \(github\.com\) · gh connecté · .*PR vers main.*jamais de merge$/)
    expect(doctorLivraison({ option: true, forge: { forge: 'github', hote: 'github.com' }, gh: 'absent' })).toContain('brew install gh')
    expect(doctorLivraison({ option: true, forge: { forge: 'gitlab', hote: 'git.entreprise.local' } })).toContain('prochaine version')
    expect(doctorLivraison({ option: false, forge: { forge: 'autre' } })).toContain('désactivée')
  })
})
