// La base de référence (docs/rd-v2/conception.md §7) : les signatures d'erreurs au commit de départ, gardées par commit (les 3 derniers).
// Nouvelle erreur = signature absente de la base ; base inconnue pour la commande = « nouvelle ? » ; test instable connu = « instable ».
// Pur.
import type { ProjetVerif, VerifBase, VerifErreur, VerifStatut } from '../../types/verif'
import { signatureKey } from './parse'

/** Bases gardées dans le graphe. */
export const BASES_MAX = 3

/** Deux hash de commit désignent-ils le même commit (l'un peut être abrégé) ? */
const sameCommit = (a: string, b: string) => !!a && !!b && (a.startsWith(b) || b.startsWith(a))

/**
 * Le statut de chaque erreur. La base est un multiensemble : une signature présente 2 fois dans la base et 3 fois maintenant donne
 * 2 préexistantes et 1 nouvelle (deux erreurs identiques dans un même fichier n'ont pas de ligne pour les distinguer).
 * Base absente, ou commande absente de la base (tests liés, commande en erreur à la prise de la base) : 'nouvelle?'.
 */
export function classify(erreurs: Omit<VerifErreur, 'statut'>[], base: VerifBase | undefined, instables: string[], commandeId: string): VerifErreur[] {
  const instable = new Set(instables)
  const connue = !!base && base.commandes.includes(commandeId)
  const reste = new Map<string, number>()
  if (connue) for (const s of base!.signatures) reste.set(s, (reste.get(s) ?? 0) + 1)
  return erreurs.map(e => {
    const k = signatureKey(e)
    let statut: VerifStatut
    if (instable.has(k)) statut = 'instable'
    else if (!connue) statut = 'nouvelle?'
    else if ((reste.get(k) ?? 0) > 0) {
      reste.set(k, reste.get(k)! - 1)
      statut = 'preexistante'
    } else statut = 'nouvelle'
    return { ...e, statut }
  })
}

/** L'id de commande d'une signature (outil = id de la commande, premier champ de signatureKey). */
const commandOf = (k: string) => k.slice(0, k.indexOf('|'))

/**
 * Ajoute une base (3 dernières gardées, la plus récente en dernier). Même commit déjà présent : fusion, les commandes de la nouvelle base
 * remplacent leurs signatures, les autres sont gardées.
 */
export function addBase(verif: ProjetVerif, base: VerifBase): ProjetVerif {
  const avant = verif.bases.find(b => sameCommit(b.commit, base.commit))
  let nouvelle = base
  if (avant) {
    const remplacees = new Set(base.commandes)
    nouvelle = {
      commit: base.commit,
      le: base.le,
      commandes: [...new Set([...avant.commandes, ...base.commandes])],
      signatures: [...avant.signatures.filter(s => !remplacees.has(commandOf(s))), ...base.signatures],
    }
  }
  const bases = [...verif.bases.filter(b => b !== avant), nouvelle].slice(-BASES_MAX)
  return { ...verif, bases }
}

/** La base d'un commit (hash complet ou abrégé), ou undefined. */
export function baseFor(verif: ProjetVerif | undefined, commit: string): VerifBase | undefined {
  if (!verif || !commit) return undefined
  for (let i = verif.bases.length - 1; i >= 0; i--) if (sameCommit(verif.bases[i]!.commit, commit)) return verif.bases[i]
  return undefined
}
