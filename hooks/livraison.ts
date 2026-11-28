/**
 * La livraison (v3.4 GitHub, v3.5 GitLab ; docs/rd-v3/README.md §3 ter) : à la fin d'un flow vérifié, revo-flow propose
 * d'ouvrir la PR (GitHub) ou la MR (GitLab, auto-hébergé compris). S'il a l'accord de l'utilisateur, il fait lui-même les
 * commandes (branche, commit des seuls fichiers du flow, push nommé, `gh pr create` ou `glab mr create`), puis dit de taper
 * /ship pour la revue et le suivi. Il ne fusionne jamais : la garde anti-merge le refuserait.
 * Logique pure, sans aucune référence à `$` : register.tsx lit git, gh et glab et passe leurs sorties ici.
 */
import type { StatusEntry } from './cache/store'
import { slug } from './lib'

/** La forge du remote origin : GitHub (gh), GitLab (glab, sur son hôte, auto-hébergé compris), ou autre (rien n'est livré). */
export type Forge = { forge: 'github'; hote: string } | { forge: 'gitlab'; hote: string } | { forge: 'autre'; hote?: string }

/** L'hôte d'une URL de remote : https://hote/…, ssh://git@hote:22/…, git@hote:o/r.git ; undefined sinon (chemin local). */
export function hoteDuRemote(url: string): string | undefined {
  const u = (url ?? '').trim()
  const web = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)/i.exec(u)
  if (web) return web[1]!.toLowerCase()
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)/.exec(u)
  if (scp && !/^[A-Za-z]$/.test(scp[1]!)) return scp[1]!.toLowerCase()
  return undefined
}

/**
 * La forge d'un hôte : github.com ou un hôte connu de `gh auth status` → GitHub ; un hôte connu de glab, un nom qui contient
 * « gitlab », ou un `.gitlab-ci.yml` à la racine → GitLab ; sinon autre.
 */
export function forgeDe(hote: string | undefined, o: { ghHotes?: string[]; glabHotes?: string[]; gitlabCi?: boolean } = {}): Forge {
  if (!hote) return { forge: 'autre' }
  const h = hote.toLowerCase()
  if (h === 'github.com' || (o.ghHotes ?? []).some(x => x.toLowerCase() === h)) return { forge: 'github', hote: h }
  if ((o.glabHotes ?? []).some(x => x.toLowerCase() === h) || /gitlab/.test(h) || o.gitlabCi) return { forge: 'gitlab', hote: h }
  return { forge: 'autre', hote: h }
}

/** Les hôtes que liste `gh auth status` ou `glab auth status` (« github.com », « git.entreprise.local »), connectés ou non. */
export function hotesGh(sortie: string): string[] {
  const out = new Set<string>()
  for (const l of (sortie ?? '').split(/\r?\n/)) {
    const m = /^\s*([a-z0-9.-]+\.[a-z]{2,})\s*$/i.exec(l)
    if (m) out.add(m[1]!.toLowerCase())
  }
  return [...out]
}

const BRANCHE_MAX = 48

/**
 * La branche où livrer : la branche courante si c'est une branche de travail ; sur une branche protégée (main, master, la
 * branche par défaut) ou une tête détachée, une nouvelle `revo/<titre>`, suffixée -2, -3… si le nom est déjà pris.
 */
export function brancheDeLivraison(courante: string | undefined, defaut: string | undefined, titre: string, existantes: string[] = []): { branche: string; nouvelle: boolean } {
  const c = (courante ?? '').trim()
  const protegees = ['main', 'master', ...(defaut ? [defaut] : [])].map(x => x.toLowerCase())
  if (c && c !== 'HEAD' && !protegees.includes(c.toLowerCase())) return { branche: c, nouvelle: false }
  const base = `revo/${slug(titre).slice(0, BRANCHE_MAX).replace(/-+$/, '') || 'flow'}`
  const noms = new Set(existantes.map(x => x.trim().replace(/^\*\s*/, '').replace(/^remotes\//, '')))
  const prise = (b: string) => noms.has(b) || noms.has(`origin/${b}`)
  let branche = base
  for (let n = 2; prise(branche); n++) branche = `${base}-${n}`
  return { branche, nouvelle: true }
}

const EMOJI_TYPE = /^\p{Extended_Pictographic}️?\s+[a-z]+(?:\([^)]*\))?!?:\s/u
const TYPE = /^[a-z]+(?:\([^)]*\))?!?:\s/

/**
 * Le message de commit, au style des derniers commits du dépôt : « ✨ feat: titre » si la plupart commencent par un emoji
 * et un type, « feat: titre » s'ils suivent les commits conventionnels, sinon le titre seul. Le résumé du plan en corps.
 */
export function messageCommit(titre: string, resume: string | undefined, sujets: string[] = []): string {
  const vus = sujets.map(s => s.trim()).filter(s => s && !/^Merge\b/.test(s))
  const t = titre.trim() || 'flow revo-flow'
  const minuscule = t.charAt(0).toLowerCase() + t.slice(1)
  const part = (re: RegExp) => vus.length > 0 && vus.filter(s => re.test(s)).length * 2 > vus.length
  const sujet = part(EMOJI_TYPE) ? `✨ feat: ${minuscule}` : part(TYPE) ? `feat: ${minuscule}` : t
  const corps = (resume ?? '').trim()
  return corps ? `${sujet}\n\n${corps}` : sujet
}

/** Les chemins d'une entrée de git status : le chemin, et la source d'un renommage (sans elle, le commit en garderait une copie). */
const cheminsDe = (e: StatusEntry) => (e.from !== undefined && (e.x === 'R' || e.y === 'R') ? [e.p, e.from] : [e.p])

/** Tous les chemins que git status voit changés (suppressions et sources de renommage comprises) : l'état au lancement du flow. */
export const cheminsChanges = (statut: StatusEntry[]): Set<string> => new Set(statut.flatMap(cheminsDe))

/**
 * Les fichiers à commiter : ceux du flow (modifiés par ses outils, ou changés depuis le lancement selon git status) que git
 * voit encore changés, suppressions et sources de renommage comprises. `depart` : tout ce que git status voyait au lancement.
 * La question les détaille : `dejaSales` avaient déjà des modifications avant le flow ; `horsOutils`, propres au lancement,
 * ont changé sans passer par les outils du flow (commande d'un agent, éditeur de l'utilisateur, fichier généré).
 */
export function fichiersDeLivraison(marques: string[], statut: StatusEntry[], depart: Set<string>): { fichiers: string[]; dejaSales: string[]; horsOutils: string[] } {
  const change = cheminsChanges(statut)
  const marque = new Set(marques)
  const retenus = new Set<string>()
  for (const e of statut) {
    const chemins = cheminsDe(e)
    if (chemins.some(p => marque.has(p) || !depart.has(p))) chemins.forEach(p => retenus.add(p))
  }
  const fichiers = [...retenus].filter(p => change.has(p)).sort()
  const dejaSales = fichiers.filter(p => depart.has(p))
  return { fichiers, dejaSales, horsOutils: fichiers.filter(p => !marque.has(p) && !depart.has(p)) }
}

/** La branche distante où pousser : celle que suit la branche courante sur origin (`origin/feature-x` → `feature-x`), sinon la même. */
export function cibleDistante(amont: string | undefined, branche: string): string {
  const a = (amont ?? '').trim()
  return a.startsWith('origin/') && a.length > 'origin/'.length && !/\s/.test(a) ? a.slice('origin/'.length) : branche
}

/** La taille maximale d'une description de PR sur GitHub est 65 536 caractères : au-delà, le rapport est coupé. */
export const CORPS_MAX = 60_000
/**
 * glab n'a pas d'option pour lire la description dans un fichier : elle passe en argument, et une ligne de commande Windows
 * ne dépasse pas 32 767 caractères. Le rapport est donc coupé plus tôt pour une MR.
 */
export const CORPS_MAX_GLAB = 25_000

/**
 * Le poids d'un texte passé en argument : sous Windows, chaque guillemet et chaque antislash peut doubler une fois échappé.
 * On compte donc large : un caractère, plus un pour chacun d'eux.
 */
export const poidsArgument = (s: string) => s.length + (s.match(/["\\]/g)?.length ?? 0)

/**
 * La description de la PR ou de la MR : le rapport, coupé au-delà de `max` avec le chemin du rapport complet. `poids` mesure
 * le texte (sa longueur, ou son poids une fois échappé pour un argument de ligne de commande).
 */
export function corpsDePr(rapport: string, chemin: string, max = CORPS_MAX, forge = 'GitHub', poids: (s: string) => number = s => s.length): { texte: string; coupe: boolean } {
  if (poids(rapport) <= max) return { texte: rapport, coupe: false }
  const note = `\n\n…\n\n_Rapport coupé pour ${forge} ; le rapport complet est sur le poste de l'auteur : ${chemin}_\n`
  let taille = Math.min(rapport.length, Math.max(0, max - poids(note)))
  let texte = ''
  for (let essai = 0; essai < 8; essai++) {
    const debut = rapport.slice(0, taille)
    const fin = debut.lastIndexOf('\n')
    texte = `${debut.slice(0, fin > 0 ? fin : taille)}${note}`
    const exces = poids(texte) - max
    if (exces <= 0) break
    taille = Math.max(0, taille - exces)
  }
  return { texte, coupe: true }
}

/**
 * Le projet du remote origin (hôte, et groupe/sous-groupe/projet), pour `--repo` de gh (`hote/proprietaire/depot`) et de glab
 * (`https://hote/groupe/projet`) : sans lui, ils choisissent le projet dans les remotes et préfèrent `upstream` à `origin`, où
 * revo-flow pousse. undefined : remote illisible.
 */
export function projetDuRemote(url: string): { hote: string; chemin: string } | undefined {
  const u = (url ?? '').trim()
  const hote = hoteDuRemote(u)
  if (!hote) return undefined
  const brut = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?[^/]+\/(.+)$/i.exec(u)?.[1] ?? /^(?:[^@/]+@)?[^/:]+:(.+)$/.exec(u)?.[1]
  const chemin = brut?.replace(/\.git\/?$/, '').replace(/^\/+|\/+$/g, '')
  return chemin && chemin.includes('/') ? { hote, chemin } : undefined
}

/** `--repo` pour gh (`hote/proprietaire/depot`) ou glab (URL web complète). */
export const repoPour = (cli: 'gh' | 'glab', p: { hote: string; chemin: string }) => (cli === 'gh' ? `${p.hote}/${p.chemin}` : `https://${p.hote}/${p.chemin}`)

/** Ce que la forge appelle une demande de fusion : PR sur GitHub, MR sur GitLab. */
export type Demande = 'PR' | 'MR'
export const demandeDe = (forge: Forge): Demande => (forge.forge === 'gitlab' ? 'MR' : 'PR')

export const LIVRER_BROUILLON = 'Brouillon'
export const LIVRER_PRETE = 'Prête à relire'
export const LIVRER_POUSSER = 'Pousser sur la PR'
export const LIVRER_POUSSER_MR = 'Pousser sur la MR'
export const LIVRER_NON = 'Pas maintenant'

const plural = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`

/** La question de fin de flow : ouvrir la PR ou la MR (brouillon ou prête), ou pousser sur celle qui existe déjà. */
export function questionLivraison(o: {
  /** PR (GitHub, par défaut) ou MR (GitLab). */
  nom?: Demande
  titre: string
  branche: string
  nouvelle: boolean
  base: string
  fichiers: string[]
  dejaSales: string[]
  horsOutils?: string[]
  /** Les commits déjà sur la branche et pas encore poussés : ils partent avec. */
  enAvance?: number
  prExistante?: string
}): { question: string; options: string[] } {
  const ou = o.nouvelle ? `sur une nouvelle branche ${o.branche}` : `sur ${o.branche}`
  const liste = (xs: string[]) => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? '…' : ''}`
  const details = [
    ...(o.dejaSales.length ? [`${plural(o.dejaSales.length, 'fichier')} déjà modifié${o.dejaSales.length > 1 ? 's' : ''} avant le flow : ${liste(o.dejaSales)}`] : []),
    ...(o.horsOutils?.length ? [`${plural(o.horsOutils.length, 'fichier')} changé${o.horsOutils.length > 1 ? 's' : ''} hors des outils du flow : ${liste(o.horsOutils)}`] : []),
  ]
  const avance = o.enAvance ? `, avec ${plural(o.enAvance, 'commit')} déjà sur la branche et pas encore poussé${o.enAvance > 1 ? 's' : ''},` : ''
  const quoi = `${plural(o.fichiers.length, 'fichier')} du flow${details.length ? ` (dont ${details.join(' ; ')})` : ''}${avance}`
  const nom = o.nom ?? 'PR'
  if (o.prExistante)
    return {
      question: `Flow vérifié. Commiter ${quoi} ${ou} et pousser sur la ${nom} ${o.prExistante} ? revo-flow ne fusionne jamais.`,
      options: [nom === 'MR' ? LIVRER_POUSSER_MR : LIVRER_POUSSER, LIVRER_NON],
    }
  return {
    question: `Flow vérifié. Commiter ${quoi} ${ou}, la pousser et ouvrir une ${nom} vers ${o.base} pour « ${o.titre} » ? Le rapport du flow en sera la description ; revo-flow ne fusionne jamais.`,
    options: [LIVRER_BROUILLON, LIVRER_PRETE, LIVRER_NON],
  }
}

/** Les arguments de `gh pr create` : base, branche, titre, rapport du flow en description, brouillon ou non. */
export function argsPrCreate(o: { base: string; branche: string; titre: string; corps: string; brouillon: boolean; repo?: string }): string[] {
  return ['gh', 'pr', 'create', ...(o.repo ? ['--repo', o.repo] : []), '--base', o.base, '--head', o.branche, '--title', o.titre, '--body-file', o.corps, ...(o.brouillon ? ['--draft'] : [])]
}

/** L'URL de la PR dans la sortie de `gh pr create` ou `gh pr view` (la dernière URL de PR). */
export function urlDePr(sortie: string): string | undefined {
  const m = (sortie ?? '').match(/https?:\/\/\S+\/pull\/\d+/g)
  return m ? m[m.length - 1] : undefined
}

/**
 * Les arguments de `glab mr create` : branche source et cible, titre, description en texte (glab ne la lit pas dans un
 * fichier), brouillon ou non, sans question (`--yes`). glab trouve le projet et son hôte dans le remote du dépôt.
 */
export function argsMrCreate(o: { base: string; branche: string; titre: string; description: string; brouillon: boolean; repo?: string }): string[] {
  return ['glab', 'mr', 'create', ...(o.repo ? ['--repo', o.repo] : []), '--source-branch', o.branche, '--target-branch', o.base, '--title', o.titre, '--description', o.description, '--yes', ...(o.brouillon ? ['--draft'] : [])]
}

/** Les arguments de `glab mr list` : les MR ouvertes dont la branche source est `branche`, en JSON. */
export const argsMrList = (branche: string, repo?: string): string[] => ['glab', 'mr', 'list', ...(repo ? ['--repo', repo] : []), '--source-branch', branche, '--output', 'json']

/** L'URL d'une MR dans une sortie de glab (la dernière : https://hote/groupe/projet/-/merge_requests/12). */
export function urlDeMr(sortie: string): string | undefined {
  const m = (sortie ?? '').match(/https?:\/\/\S+\/-\/merge_requests\/\d+/g)
  return m ? m[m.length - 1] : undefined
}

/** La première MR de `glab mr list --output json` (son web_url), ou undefined. */
export function urlDansListeMr(json: string): string | undefined {
  try {
    const liste = JSON.parse(json || '[]') as unknown
    const premiere = Array.isArray(liste) ? (liste[0] as { web_url?: unknown } | undefined) : undefined
    return typeof premiere?.web_url === 'string' ? premiere.web_url : undefined
  } catch {
    return urlDeMr(json)
  }
}

/** La branche par défaut dans `glab repo view --output json` (default_branch), ou undefined. */
export function defautDeGlab(json: string): string | undefined {
  try {
    const v = (JSON.parse(json || 'null') as { default_branch?: unknown } | null)?.default_branch
    return typeof v === 'string' && v && !/\s/.test(v) ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * Ce que /ship fait sur ce poste : la revue et le suivi (CI, conflits, commentaires), sauf sous Windows où le suivi ne
 * démarre pas (guide Claude Ship : sous Windows, /ship ouvre la PR et la relit, mais ne la suit pas).
 */
const shipFait = (windows: boolean) => (windows ? 'la revue (sous Windows, pas de suivi : CI, conflits et commentaires restent à toi)' : 'la revue et le suivi')

/** La ligne ajoutée au rapport du flow une fois la PR ou la MR ouverte ou mise à jour. */
export const ligneRapport = (url: string, branche: string, brouillon: boolean, existante: boolean, nom: Demande = 'PR', windows = false) =>
  `\n## Livraison\n\n${existante ? `Poussé sur la ${nom}` : brouillon ? `${nom} ouverte en brouillon` : `${nom} ouverte`} : ${url} (branche ${branche}). Le merge reste à l'utilisateur ; /ship fait ${shipFait(windows)}.\n`

/** Le toast de fin de livraison : ce qui est fait, et /ship à taper (sur GitLab, avec la branche de base ; sous Windows, sans suivi). */
export function finLivraison(o: { nom: Demande; url: string; brouillon: boolean; existante: boolean; base: string; windows?: boolean }): string {
  const fait = o.existante ? `poussé sur la ${o.nom} ${o.url}` : `${o.nom} ${o.brouillon ? 'ouverte en brouillon' : 'ouverte'} : ${o.url}`
  const pour = `Tape /ship pour ${shipFait(!!o.windows)}`
  const ship = o.nom === 'MR' ? `${pour} (sur GitLab, donne-lui la branche de base ${o.base})` : pour
  return `${fait}. ${ship} ; le merge reste à toi.`
}

/** La ligne Livraison de /revo-flow doctor. */
/** L'état d'un CLI de forge sur un hôte : connecté, pas connecté, absent du poste, ou en erreur (réseau, certificat, délai). */
export type EtatCli = 'connecte' | 'non-connecte' | 'absent' | 'erreur'

/**
 * L'état d'un CLI d'après son lancement : `absent` seulement s'il n'a pas pu être lancé (introuvable, code 127) ; une erreur
 * de connexion ou de certificat n'est pas une absence.
 */
export function etatCli(r: { ok: boolean; lance: boolean; code?: number; sortie: string }): EtatCli {
  if (r.ok) return 'connecte'
  if (!r.lance || r.code === 127 || /command not found|not recognized as|ENOENT|no such file or directory|introuvable/i.test(r.sortie)) return 'absent'
  if (/not logged|non connect|auth login|no token|401|unauthori[sz]ed/i.test(r.sortie)) return 'non-connecte'
  return 'erreur'
}

/** La première ligne utile d'une sortie d'erreur, pour la montrer (certificat, réseau). */
export const ligneErreur = (sortie: string) => (sortie ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean)?.slice(0, 160) ?? 'erreur inconnue'

/** Ce qu'il faut dire d'un CLI qui n'est pas connecté : comment l'installer, s'y connecter, ou l'erreur qu'il donne. */
export function conseilCli(cli: 'gh' | 'glab', etat: EtatCli, hote: string, detail = ''): string {
  if (etat === 'connecte') return `${cli} connecté`
  if (etat === 'non-connecte') return `${cli} non connecté : ${cli} auth login --hostname ${hote}`
  if (etat === 'erreur') return `${cli} en erreur sur ${hote} (${ligneErreur(detail)})`
  return cli === 'gh' ? 'gh absent : installez GitHub CLI (brew install gh), puis gh auth login' : `glab absent : installez GitLab CLI (brew install glab), puis glab auth login --hostname ${hote}`
}

/** La ligne Livraison de /revo-flow doctor. */
export function doctorLivraison(o: { option: boolean; forge: Forge; gh?: EtatCli; glab?: EtatCli; detail?: string; defaut?: string }): string {
  if (!o.option) return 'livraison désactivée (option livraison)'
  const base = o.defaut ? ` vers ${o.defaut}` : ''
  if (o.forge.forge === 'github')
    return `GitHub (${o.forge.hote}) · ${conseilCli('gh', o.gh ?? 'absent', o.forge.hote, o.detail)} · en fin de flow vérifié, PR${base} sur votre accord (brouillon ou prête), jamais de merge`
  if (o.forge.forge === 'gitlab')
    return `GitLab (${o.forge.hote}) · ${conseilCli('glab', o.glab ?? 'absent', o.forge.hote, o.detail)} · en fin de flow vérifié, MR${base} sur votre accord (brouillon ou prête), jamais de merge`
  if (!o.forge.hote) return 'aucun remote origin : pas de livraison'
  const h = o.forge.hote
  return `forge de ${h} non reconnue : pas de livraison ; un GitLab : glab auth login --hostname ${h} ; un GitHub Enterprise : gh auth login --hostname ${h}`
}
