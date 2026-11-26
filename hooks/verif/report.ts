// Le rapport de la porte à l'orchestrateur (docs/rd-v2/conception.md §7) : erreurs nouvelles seulement, groupées par fichier, 30 au plus,
// 4 000 tokens au plus ; le reste est compté (« et 14 autres ») et la sortie complète reste dans un fichier texte. Pur, texte seulement.
import type { VerifEtatCommande, VerifErreur, VerifResultat } from '../../types/verif'
import { norm } from './scope'

/** Erreurs détaillées au plus. */
const MAX_ERREURS = 30
/** Budget du rapport : 4 000 tokens, à 4 caractères par token (même estimation que le cache). */
const MAX_CARACTERES = 16_000
const MAX_MESSAGE = 200
const MAX_DETAIL = 160
const MAX_INSTABLES = 5

/** « 850 ms », « 6 s », « 2 min 05 ». */
export function dureeText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`
}

const plural = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`
const estNouvelle = (e: VerifErreur) => e.statut === 'nouvelle' || e.statut === 'nouvelle?'
const couper = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Une ligne par commande : « ✗ typecheck · 2 nouvelles · 5 préexistantes · 48 s ». */
function commandLine(c: VerifEtatCommande): string {
  const parts: string[] = []
  if (c.etat === 'saute') return `– ${c.id} · sautée${c.note ? ` (${c.note})` : ''}`
  if (c.etat === 'en_cours') return `… ${c.id} · en cours`
  if (c.etat === 'erreur') return `⚠ ${c.id} · erreur${c.note ? ` : ${c.note}` : ''}${c.dureeMs ? ` · ${dureeText(c.dureeMs)}` : ''}`
  if (c.nouvelles) parts.push(plural(c.nouvelles, 'nouvelle', 'nouvelles'))
  if (c.preexistantes) parts.push(plural(c.preexistantes, 'préexistante', 'préexistantes'))
  if (c.instables) parts.push(plural(c.instables, 'instable', 'instables'))
  if (!parts.length && c.fichiers) parts.push(plural(c.fichiers, 'fichier', 'fichiers'))
  parts.push(dureeText(c.dureeMs))
  const note = c.note ? ` (${c.note})` : ''
  return `${c.etat === 'ko' ? '✗' : '✓'} ${c.id} · ${parts.join(' · ')}${note}`
}

/** Une erreur sous son fichier : « l.12:5 TS2322 Type … (nouvelle ?) — attendu 3, reçu 4 ». */
function errorLine(e: VerifErreur): string {
  const pos = e.ligne ? `l.${e.ligne}${e.col ? `:${e.col}` : ''} ` : ''
  const marque = e.statut === 'nouvelle?' ? ' (nouvelle ?)' : ''
  const detail = e.detail ? ` — ${couper(e.detail, MAX_DETAIL)}` : ''
  return `  ${pos}${e.code} ${couper(e.message, MAX_MESSAGE)}${marque}${detail}`
}

/**
 * Le rapport texte d'un résultat de porte, borné à 4 000 tokens. `seulement` : fichiers d'un agent (copie partagée) ; ses erreurs sont détaillées,
 * celles des autres fichiers seulement comptées. `max` : erreurs détaillées au plus (30).
 */
export function reportText(r: VerifResultat, opts: { max?: number; tentative?: number; maxTentatives?: number; seulement?: string[] } = {}): string {
  const max = opts.max ?? MAX_ERREURS
  const tent = opts.tentative ? ` (tentative ${opts.tentative}${opts.maxTentatives ? `/${opts.maxTentatives}` : ''})` : ''
  const nouvelles = r.erreurs.filter(estNouvelle)
  const seul = opts.seulement ? new Set(opts.seulement.map(norm)) : undefined
  const miennes = seul ? nouvelles.filter(e => seul.has(norm(e.fichier))) : nouvelles
  const ailleurs = nouvelles.length - miennes.length
  const aConfirmer = miennes.filter(e => e.statut === 'nouvelle?').length

  const tete: string[] = []
  if (r.etat === 'vert') tete.push(`Vérification revo-flow : vert${tent} · ${dureeText(r.dureeMs)}`)
  else if (r.etat === 'rouge')
    tete.push(`Vérification revo-flow : rouge${tent} · ${plural(nouvelles.length, 'erreur nouvelle', 'erreurs nouvelles')}${aConfirmer ? ` (dont ${aConfirmer} à confirmer)` : ''} · ${dureeText(r.dureeMs)}`)
  else tete.push(`Vérification revo-flow : erreur${tent} · une commande n'a pas pu être lue · ${dureeText(r.dureeMs)}`)
  tete.push(...r.commandes.map(commandLine))

  // Erreurs nouvelles, groupées par fichier (ordre d'apparition), triées par ligne.
  const groupes = new Map<string, VerifErreur[]>()
  for (const e of miennes) groupes.set(e.fichier, [...(groupes.get(e.fichier) ?? []), e])
  const corps: string[] = []
  let montrees = 0
  for (const [fichier, errs] of groupes) {
    if (montrees >= max) break
    const lot = [...errs].sort((a, b) => (a.ligne ?? 0) - (b.ligne ?? 0)).slice(0, max - montrees)
    corps.push(`${fichier || '(projet)'}${errs.length > 1 ? ` (${errs.length})` : ''}`, ...lot.map(errorLine))
    montrees += lot.length
  }

  const pied = (autres: number): string[] => {
    const out: string[] = []
    if (autres > 0) out.push(`… et ${plural(autres, 'autre', 'autres')} (voir les sorties complètes)`)
    if (ailleurs > 0) out.push(`${plural(ailleurs, 'erreur nouvelle', 'erreurs nouvelles')} hors de ces fichiers (autres agents ou fichiers non modifiés), non détaillées ici`)
    const instables = r.erreurs.filter(e => e.statut === 'instable')
    if (instables.length) {
      out.push('', `Tests instables (rouges puis verts à la relance, non bloquants) : ${instables.length}`)
      out.push(...instables.slice(0, MAX_INSTABLES).map(e => `  ${e.fichier} · ${couper(e.message, MAX_MESSAGE)}`))
    }
    const pre = r.commandes.reduce((n, c) => n + c.preexistantes, 0)
    if (pre) out.push('', `Préexistantes (déjà là au commit de départ, non bloquantes) : ${pre}`)
    if (aConfirmer) out.push('« nouvelle ? » : pas de base de référence pour cette commande, l\'erreur peut être préexistante.')
    const sorties = r.commandes.filter(c => c.sortie && (c.etat === 'ko' || c.etat === 'erreur' || c.instables))
    if (sorties.length) out.push('', 'Sorties complètes :', ...sorties.map(c => `  ${c.id} → ${c.sortie}`))
    return out
  }

  // Borne de 4 000 tokens : on retire des erreurs détaillées par la fin jusqu'à tenir.
  let autres = miennes.length - montrees
  const texte = () => [...tete, ...(corps.length ? ['', 'Erreurs nouvelles :', ...corps] : []), ...pied(autres)].join('\n')
  let t = texte()
  while (t.length > MAX_CARACTERES && corps.length) {
    const last = corps.pop()!
    if (last.startsWith('  ')) autres++
    t = texte()
  }
  return t.length > MAX_CARACTERES ? `${t.slice(0, MAX_CARACTERES - 1)}…` : t
}

/** Les commandes en panne (état erreur) d'un résultat, une phrase chacune : « flutter-test : délai dépassé (10 min 00) » ; [] si aucune. */
export function pannesOf(r: VerifResultat): string[] {
  return r.commandes.filter(c => c.etat === 'erreur').map(c => (c.note ? `${c.id} : ${c.note}` : `${c.id} : en panne, voir la sortie complète`))
}

/** La panne d'une commande en peu de mots : la dernière note sans sa parenthèse (« délai dépassé (10 min 00) » → « délai dépassé »). */
const panneCourte = (c: VerifEtatCommande) => couper(`${c.id}${c.note ? ` ${(c.note.split(' ; ').at(-1) ?? '').replace(/\s*\(.*$/, '')}` : ''}`, 60)

/** « porte en panne : flutter-test délai dépassé » : la raison du verdict quand la porte n'a pas pu juger. */
export function panneText(r: VerifResultat): string {
  const courtes = r.commandes.filter(c => c.etat === 'erreur').map(panneCourte)
  return `porte en panne : ${courtes.join(', ') || 'erreur'}`
}

/** La question d'une porte en panne : les pannes, puis le choix (sans relance quand elle a déjà été relancée deux fois). */
export function panneQuestion(pannes: readonly string[], relancer: boolean): string {
  const fin = relancer ? 'Relancer la porte, ou terminer non vérifié ?' : 'Elle a déjà été relancée deux fois : terminer non vérifié ?'
  return `La porte n'a pas pu juger : ${pannes.join(' ; ') || 'une commande en panne'}. ${fin}`
}

/** « C2 Le total… : expected 10.005 to be 10.01 » : un critère ko et sa preuve, coupés pour tenir dans le block. */
const koLine = (c: { id: string; texte?: string; preuve: string }) => `- ${c.id}${c.texte ? ` ${couper(c.texte, 120)}` : ''} : ${couper(c.preuve.replace(/\s*\n\s*/g, ' '), 300)}`

/**
 * Le block des critères ko (v3.6) pour l'orchestrateur : chaque critère ko et sa preuve, puis quoi faire. `aRevoir` : le code a changé
 * depuis le verdict, un nouveau verdict du vérificateur est exigé. `outils` : le type du vérificateur et l'outil verif, à citer.
 */
export function criteresKoText(kos: readonly { id: string; texte?: string; preuve: string }[], total: number, aRevoir: boolean, outils: { verificateur: string; verif: string }): string {
  const ids = kos.map(c => c.id).join(', ')
  if (aRevoir) {
    return [
      `Critères d'acceptation (revo-flow) : le code a changé depuis le « ko » de ${ids} ; un nouveau verdict est obligatoire.`,
      `Lance le vérificateur avec l’outil Agent (subagent_type « ${outils.verificateur} », description « Vérificateur ») : il rejuge les critères. Attends sa réponse, puis conclus.`,
    ].join('\n')
  }
  return [
    `Critères d'acceptation (revo-flow) : ${plural(kos.length, 'critère ko', 'critères ko')} sur ${total}.`,
    ...kos.map(koLine),
    `Corrige (toi-même, ou en reprenant l’agent concerné avec SendMessage), puis relance le vérificateur (subagent_type « ${outils.verificateur} ») pour un nouveau verdict ; ou demande une exception (${outils.verif} action exception, avec motif) si ce critère ne relève pas de ce flow.`,
  ].join('\n')
}

/** Le segment de fin de flow : « vérifié ✓ », « non vérifié (typecheck ✗) », « non vérifié (codegen : erreur) ». */
export function summaryLine(r: VerifResultat): string {
  if (r.etat === 'vert') return 'vérifié ✓'
  if (r.etat === 'rouge') {
    const ko = r.commandes.filter(c => c.etat === 'ko').map(c => c.id)
    return ko.length ? `non vérifié (${ko.join(', ')} ✗)` : 'non vérifié ✗'
  }
  const err = r.commandes.filter(c => c.etat === 'erreur').map(c => c.id)
  return err.length ? `non vérifié (${err.join(', ')} : erreur)` : 'non vérifié (erreur)'
}
