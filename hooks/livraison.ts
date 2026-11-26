/**
 * La livraison (v3.4, docs/rd-v3/README.md §3 ter) : à la fin d'un flow vérifié, revo-flow propose d'ouvrir la PR. S'il a
 * l'accord de l'utilisateur, il fait lui-même les commandes (branche, commit des seuls fichiers du flow, push nommé,
 * `gh pr create`), puis dit de taper /ship pour la revue et le suivi. Il ne fusionne jamais : la garde anti-merge le refuserait.
 * Logique pure, sans aucune référence à `$` : register.tsx lit git et gh et passe leurs sorties ici.
 */
import type { StatusEntry } from './cache/store'
import { slug } from './lib'

/** La forge du remote origin : GitHub (gh) seulement pour l'instant ; GitLab est reconnu pour le dire, pas encore livré. */
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

/** Les hôtes que liste `gh auth status` (« github.com », « ghe.entreprise.local »), connectés ou non. */
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

/**
 * Les fichiers à commiter : ceux du flow (modifiés par ses outils, ou vus par git status et propres au lancement) que git
 * voit encore changés, suppressions comprises. `dejaSales` : ceux qui avaient déjà des modifications avant le flow
 * (ils partent avec, la question le dit).
 */
export function fichiersDeLivraison(marques: string[], statut: StatusEntry[], saleAuDepart: Set<string>): { fichiers: string[]; dejaSales: string[] } {
  const change = new Set(statut.map(e => e.p))
  const nouveaux = statut.map(e => e.p).filter(p => !saleAuDepart.has(p))
  const fichiers = [...new Set([...marques, ...nouveaux])].filter(p => change.has(p)).sort()
  return { fichiers, dejaSales: fichiers.filter(p => saleAuDepart.has(p)) }
}

export const LIVRER_BROUILLON = 'Brouillon'
export const LIVRER_PRETE = 'Prête à relire'
export const LIVRER_POUSSER = 'Pousser sur la PR'
export const LIVRER_NON = 'Pas maintenant'

const plural = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`

/** La question de fin de flow : ouvrir la PR (brouillon ou prête), ou pousser sur celle qui existe déjà. */
export function questionLivraison(o: { titre: string; branche: string; nouvelle: boolean; base: string; fichiers: string[]; dejaSales: string[]; prExistante?: string }): { question: string; options: string[] } {
  const ou = o.nouvelle ? `sur une nouvelle branche ${o.branche}` : `sur ${o.branche}`
  const sales = o.dejaSales.length ? ` (dont ${plural(o.dejaSales.length, 'fichier')} déjà modifié${o.dejaSales.length > 1 ? 's' : ''} avant le flow : ${o.dejaSales.slice(0, 3).join(', ')}${o.dejaSales.length > 3 ? '…' : ''})` : ''
  const quoi = `${plural(o.fichiers.length, 'fichier')} du flow${sales}`
  if (o.prExistante)
    return {
      question: `Flow vérifié. Commiter ${quoi} ${ou} et pousser sur la PR ${o.prExistante} ? revo-flow ne fusionne jamais.`,
      options: [LIVRER_POUSSER, LIVRER_NON],
    }
  return {
    question: `Flow vérifié. Commiter ${quoi} ${ou}, la pousser et ouvrir une PR vers ${o.base} pour « ${o.titre} » ? Le rapport du flow en sera la description ; revo-flow ne fusionne jamais.`,
    options: [LIVRER_BROUILLON, LIVRER_PRETE, LIVRER_NON],
  }
}

/** Les arguments de `gh pr create` : base, branche, titre, rapport du flow en description, brouillon ou non. */
export function argsPrCreate(o: { base: string; branche: string; titre: string; corps: string; brouillon: boolean }): string[] {
  return ['gh', 'pr', 'create', '--base', o.base, '--head', o.branche, '--title', o.titre, '--body-file', o.corps, ...(o.brouillon ? ['--draft'] : [])]
}

/** L'URL de la PR dans la sortie de `gh pr create` ou `gh pr view` (la dernière URL de PR). */
export function urlDePr(sortie: string): string | undefined {
  const m = (sortie ?? '').match(/https?:\/\/\S+\/pull\/\d+/g)
  return m ? m[m.length - 1] : undefined
}

/** La ligne ajoutée au rapport du flow une fois la PR ouverte ou mise à jour. */
export const ligneRapport = (url: string, branche: string, brouillon: boolean, existante: boolean) =>
  `\n## Livraison\n\n${existante ? 'Poussé sur la PR' : brouillon ? 'PR ouverte en brouillon' : 'PR ouverte'} : ${url} (branche ${branche}). Le merge reste à l'utilisateur ; /ship fait la revue et le suivi.\n`

/** La ligne Livraison de /revo-flow doctor. */
export function doctorLivraison(o: { option: boolean; forge: Forge; gh?: 'connecte' | 'non-connecte' | 'absent'; defaut?: string }): string {
  if (!o.option) return 'livraison désactivée (option livraison)'
  const base = o.defaut ? ` vers ${o.defaut}` : ''
  if (o.forge.forge === 'github') {
    const gh = o.gh === 'connecte' ? 'gh connecté' : o.gh === 'non-connecte' ? `gh non connecté : gh auth login --hostname ${o.forge.hote}` : 'gh absent : installez GitHub CLI (brew install gh), puis gh auth login'
    return `GitHub (${o.forge.hote}) · ${gh} · en fin de flow vérifié, PR${base} sur votre accord (brouillon ou prête), jamais de merge`
  }
  if (o.forge.forge === 'gitlab') return `GitLab (${o.forge.hote}) · la MR en fin de flow arrive dans une prochaine version ; /ship peut déjà relire une MR poussée`
  return `pas de remote GitHub (${o.forge.hote ?? 'aucun remote origin'}) : pas de livraison`
}
