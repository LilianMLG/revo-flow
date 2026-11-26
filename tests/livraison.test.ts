// La livraison (v3.4, docs/rd-v3/README.md §3 ter), module pur : forge, branche, message de commit, fichiers, question, gh.
// Écrits d'après la spec, pas d'après le code.
import { describe, expect, test } from 'claude-code/testing'

import {
  LIVRER_BROUILLON,
  LIVRER_NON,
  LIVRER_POUSSER,
  LIVRER_PRETE,
  CORPS_MAX,
  CORPS_MAX_GLAB,
  LIVRER_POUSSER_MR,
  argsMrCreate,
  argsMrList,
  argsPrCreate,
  brancheDeLivraison,
  cheminsChanges,
  cibleDistante,
  conseilCli,
  corpsDePr,
  defautDeGlab,
  demandeDe,
  doctorLivraison,
  etatCli,
  finLivraison,
  fichiersDeLivraison,
  forgeDe,
  hoteDuRemote,
  hotesGh,
  ligneRapport,
  messageCommit,
  poidsArgument,
  projetDuRemote,
  questionLivraison,
  repoPour,
  urlDansListeMr,
  urlDeMr,
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
    // lib/promo.ts : propre au lancement, changé sans passer par les outils du flow ; la question le dit.
    expect(r.horsOutils).toEqual(['lib/promo.ts'])
  })

  test('une suppression faite avant le flow n’est pas un fichier du flow (revue PR #3, point 1)', () => {
    const statut = [st(' ', 'M', 'a.ts'), st(' ', 'D', 'vieux.ts')]
    const depart = cheminsChanges([st(' ', 'D', 'vieux.ts')])
    expect(fichiersDeLivraison(['a.ts'], statut, depart)).toEqual({ fichiers: ['a.ts'], dejaSales: [], horsOutils: [] })
  })

  test('un renommage du flow emporte sa source (revue PR #3, point 2)', () => {
    const statut = [{ x: 'R', y: ' ', p: 'src/b.ts', from: 'src/a.ts' }]
    expect(fichiersDeLivraison([], statut, new Set()).fichiers).toEqual(['src/a.ts', 'src/b.ts'])
    expect(cheminsChanges(statut)).toEqual(new Set(['src/b.ts', 'src/a.ts']))
    // une copie ne retire pas sa source
    expect(fichiersDeLivraison([], [{ x: 'C', y: ' ', p: 'c.ts', from: 'a.ts' }], new Set()).fichiers).toEqual(['c.ts'])
  })

  test('rien de changé : rien à livrer', () => {
    expect(fichiersDeLivraison(['a.ts'], [], new Set())).toEqual({ fichiers: [], dejaSales: [], horsOutils: [] })
  })

  test('cibleDistante : la branche suivie sur origin, sinon la même (revue PR #3, point 7)', () => {
    expect(cibleDistante('origin/feature-login', 'wip')).toBe('feature-login')
    expect(cibleDistante('origin/feat/x', 'feat/x')).toBe('feat/x')
    expect(cibleDistante('upstream/main', 'wip')).toBe('wip')
    expect(cibleDistante('', 'wip')).toBe('wip')
    expect(cibleDistante(undefined, 'wip')).toBe('wip')
  })

  test('corpsDePr : le rapport tel quel, coupé au-delà de la limite de GitHub avec le chemin du complet (revue PR #3, point 9)', () => {
    expect(corpsDePr('# Rapport\n', '/h/r.md')).toEqual({ texte: '# Rapport\n', coupe: false })
    const long = `${'ligne de rapport\n'.repeat(5000)}`
    const r = corpsDePr(long, '/h/r.md')
    expect(r.coupe).toBe(true)
    expect(r.texte.length).toBeLessThanOrEqual(CORPS_MAX + 200)
    expect(r.texte).toContain('le rapport complet est sur le poste de l’auteur : /h/r.md'.replace('’', "'"))
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

  test('la question dit les fichiers changés hors des outils du flow et les commits pas encore poussés (revue PR #3, points 7 et 8)', () => {
    const q = questionLivraison({ titre: 'x', branche: 'wip', nouvelle: false, base: 'main', fichiers: ['a.ts', 'README.md'], dejaSales: [], horsOutils: ['README.md'], enAvance: 2 })
    expect(q.question).toContain('2 fichiers du flow (dont 1 fichier changé hors des outils du flow : README.md), avec 2 commits déjà sur la branche et pas encore poussés,')
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
    expect(doctorLivraison({ option: true, forge: { forge: 'gitlab', hote: 'git.entreprise.local' } })).toContain('glab absent : installez GitLab CLI (brew install glab), puis glab auth login --hostname git.entreprise.local')
    expect(doctorLivraison({ option: true, forge: { forge: 'gitlab', hote: 'git.entreprise.local' }, glab: 'connecte', defaut: 'main' })).toMatch(/^GitLab \(git\.entreprise\.local\) · glab connecté · .*MR vers main.*jamais de merge$/)
    expect(doctorLivraison({ option: true, forge: { forge: 'gitlab', hote: 'g.local' }, glab: 'non-connecte' })).toContain('glab non connecté : glab auth login --hostname g.local')
    expect(doctorLivraison({ option: false, forge: { forge: 'autre' } })).toContain('désactivée')
    // revue PR #3, point 10 : sans remote, pas d'hôte inventé ; un hôte inconnu peut être un GitHub Enterprise pas connecté
    expect(doctorLivraison({ option: true, forge: { forge: 'autre' } })).toBe('aucun remote origin : pas de livraison')
    expect(doctorLivraison({ option: true, forge: { forge: 'autre', hote: 'ghe.corp' } })).toContain('gh auth login --hostname ghe.corp')
    // revue PR #4, point 6 : un hôte non reconnu peut aussi être un GitLab pas encore connecté
    expect(doctorLivraison({ option: true, forge: { forge: 'autre', hote: 'git.entreprise.local' } })).toContain('un GitLab : glab auth login --hostname git.entreprise.local')
  })
})

describe('GitLab (v3.5)', () => {
  test('PR sur GitHub, MR sur GitLab', () => {
    expect(demandeDe({ forge: 'github', hote: 'github.com' })).toBe('PR')
    expect(demandeDe({ forge: 'gitlab', hote: 'git.entreprise.local' })).toBe('MR')
  })

  test('glab mr create : source, cible, titre, description en texte, sans question, --draft pour un brouillon', () => {
    expect(argsMrCreate({ base: 'main', branche: 'revo/x', titre: 'X', description: '# Rapport', brouillon: true })).toEqual([
      'glab', 'mr', 'create', '--source-branch', 'revo/x', '--target-branch', 'main', '--title', 'X', '--description', '# Rapport', '--yes', '--draft',
    ])
    expect(argsMrCreate({ base: 'develop', branche: 'f', titre: 'X', description: 'd', brouillon: false })).not.toContain('--draft')
    expect(argsMrList('feat/x')).toEqual(['glab', 'mr', 'list', '--source-branch', 'feat/x', '--output', 'json'])
  })

  test('les URL de MR, la MR ouverte de la liste, la branche par défaut de glab repo view', () => {
    expect(urlDeMr('Creating merge request for revo/x into main in equipe/boutique\n\n!7 X (revo/x)\n https://git.entreprise.local/equipe/boutique/-/merge_requests/7\n')).toBe('https://git.entreprise.local/equipe/boutique/-/merge_requests/7')
    expect(urlDeMr('error: 403 Forbidden')).toBeUndefined()
    expect(urlDansListeMr('[{"iid":7,"web_url":"https://g.local/e/b/-/merge_requests/7"}]')).toBe('https://g.local/e/b/-/merge_requests/7')
    expect(urlDansListeMr('[]')).toBeUndefined()
    expect(urlDansListeMr('')).toBeUndefined()
    expect(urlDansListeMr('pas du json https://g.local/e/b/-/merge_requests/3')).toBe('https://g.local/e/b/-/merge_requests/3')
    expect(defautDeGlab('{"id":12,"default_branch":"develop","name":"boutique"}')).toBe('develop')
    expect(defautDeGlab('{"default_branch":""}')).toBeUndefined()
    expect(defautDeGlab('pas du json')).toBeUndefined()
  })

  test('la question, la ligne du rapport et le message de fin disent MR ; /ship avec la branche de base', () => {
    const q = questionLivraison({ nom: 'MR', titre: 'Promo', branche: 'revo/promo', nouvelle: true, base: 'main', fichiers: ['a.ts'], dejaSales: [] })
    expect(q.question).toContain('ouvrir une MR vers main pour « Promo »')
    const p = questionLivraison({ nom: 'MR', titre: 'x', branche: 'f', nouvelle: false, base: 'main', fichiers: ['a.ts'], dejaSales: [], prExistante: 'https://g.local/e/b/-/merge_requests/7' })
    expect(p.options).toEqual([LIVRER_POUSSER_MR, LIVRER_NON])
    expect(ligneRapport('u', 'b', true, false, 'MR')).toContain('MR ouverte en brouillon : u (branche b)')
    expect(finLivraison({ nom: 'MR', url: 'u', brouillon: false, existante: false, base: 'develop' })).toBe('MR ouverte : u. Tape /ship pour la revue et le suivi (sur GitLab, donne-lui la branche de base develop) ; le merge reste à toi.')
    expect(finLivraison({ nom: 'PR', url: 'u', brouillon: true, existante: false, base: 'main' })).toBe('PR ouverte en brouillon : u. Tape /ship pour la revue et le suivi ; le merge reste à toi.')
  })

  test('la description d’une MR est coupée plus tôt (elle passe en argument de glab)', () => {
    const r = corpsDePr('x\n'.repeat(20_000), '/h/r.md', CORPS_MAX_GLAB, 'GitLab')
    expect(r.coupe).toBe(true)
    expect(r.texte.length).toBeLessThanOrEqual(CORPS_MAX_GLAB + 200)
    expect(r.texte).toContain('Rapport coupé pour GitLab')
  })
})

describe('revue de la PR #4', () => {
  test('point 1 : une description de MR est mesurée une fois échappée (guillemets et antislashs comptent double)', () => {
    expect(poidsArgument('a"b\\c')).toBe(7)
    // 6 caractères bruts, 9 une fois échappés : sous la limite en longueur, au-dessus en poids.
    const rapport = `${'"x\\y" '.repeat(1700)}\n`.repeat(2)
    expect(rapport.length).toBeLessThan(CORPS_MAX_GLAB)
    expect(poidsArgument(rapport)).toBeGreaterThan(CORPS_MAX_GLAB)
    const r = corpsDePr(rapport, '/h/r.md', CORPS_MAX_GLAB, 'GitLab', poidsArgument)
    expect(r.coupe).toBe(true)
    expect(poidsArgument(r.texte)).toBeLessThanOrEqual(CORPS_MAX_GLAB)
    // sans guillemets ni antislash, rien ne change
    expect(corpsDePr('court', '/h/r.md', CORPS_MAX_GLAB, 'GitLab', poidsArgument)).toEqual({ texte: 'court', coupe: false })
  })

  test('point 2 : le projet d’origin pour --repo, https, ssh, scp, sous-groupes ; gh sans schéma, glab en URL', () => {
    expect(projetDuRemote('git@git.entreprise.local:equipe/web/boutique.git')).toEqual({ hote: 'git.entreprise.local', chemin: 'equipe/web/boutique' })
    expect(projetDuRemote('ssh://git@git.entreprise.local:2222/equipe/boutique.git')).toEqual({ hote: 'git.entreprise.local', chemin: 'equipe/boutique' })
    expect(projetDuRemote('https://github.com/moi/app.git')).toEqual({ hote: 'github.com', chemin: 'moi/app' })
    expect(projetDuRemote('https://github.com/moi')).toBeUndefined()
    expect(projetDuRemote('/srv/depot.git')).toBeUndefined()
    expect(repoPour('gh', { hote: 'github.com', chemin: 'moi/app' })).toBe('github.com/moi/app')
    expect(repoPour('glab', { hote: 'g.local', chemin: 'e/b' })).toBe('https://g.local/e/b')
    expect(argsMrList('f', 'https://g.local/e/b')).toEqual(['glab', 'mr', 'list', '--repo', 'https://g.local/e/b', '--source-branch', 'f', '--output', 'json'])
    expect(argsPrCreate({ base: 'main', branche: 'b', titre: 't', corps: 'r.md', brouillon: false, repo: 'github.com/o/r' }).slice(3, 5)).toEqual(['--repo', 'github.com/o/r'])
  })

  test('point 4 : absent seulement s’il n’a pas pu être lancé ; une erreur de certificat ou de réseau est une erreur', () => {
    expect(etatCli({ ok: true, lance: true, code: 0, sortie: '' })).toBe('connecte')
    expect(etatCli({ ok: false, lance: false, sortie: 'spawn glab ENOENT' })).toBe('absent')
    expect(etatCli({ ok: false, lance: true, code: 127, sortie: '' })).toBe('absent')
    expect(etatCli({ ok: false, lance: true, code: 1, sortie: 'x git.corp: no token found' })).toBe('non-connecte')
    expect(etatCli({ ok: false, lance: true, code: 1, sortie: 'x509: certificate signed by unknown authority' })).toBe('erreur')
    expect(conseilCli('glab', 'erreur', 'git.corp', 'x509: certificate signed by unknown authority\nautre')).toBe('glab en erreur sur git.corp (x509: certificate signed by unknown authority)')
    expect(doctorLivraison({ option: true, forge: { forge: 'gitlab', hote: 'git.corp' }, glab: 'erreur', detail: 'dial tcp: i/o timeout' })).toContain('glab en erreur sur git.corp (dial tcp: i/o timeout)')
  })
})
