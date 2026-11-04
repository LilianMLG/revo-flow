// Le rapport de flow (docs/rd-v3 §2.4) : un markdown écrit en fin de flow, à côté du plan, qui sert de description de MR.
// Pur : une mise en forme de ce que le flow sait déjà (agents, fichiers, porte, critères, cache), aucune collecte.
import type { CacheStats, Critere, CritereVerdict, Entry, Flow, Lead, MobileView, VerifErreur, VerifJournal, VerifResultat, WebView } from '../types'
import { MODELS, euros, fmt, fmtDuration, total } from './lib'
import { dureeText } from './verif/report'

/** Ce que la porte a vu : le dernier résultat (commandes, erreurs) et les décisions de l'utilisateur. */
export type RapportPorte = {
  resultat?: VerifResultat
  /** Fini rouge sur décision de l'utilisateur. */
  accepte?: boolean
  /** Les tests gelés modifiés hors outil, avec la réponse. */
  gelesModifies?: { p: string; par: string; decision?: 'accepte' | 'refuse' }[]
}

export type RapportInput = {
  flow: Flow
  lead: Lead
  entries: readonly Entry[]
  /** « 2026-10-12 09:00 » : la date de fin, déjà formatée. */
  date?: string
  verif?: VerifJournal
  porte?: RapportPorte
  criteres?: readonly Critere[]
  verdicts?: readonly CritereVerdict[]
  /** CacheStats.flow : tokens injectés et évités par le cache pendant ce flow ; absent sans cache. */
  cache?: CacheStats['flow']
  /** La preuve web du vérificateur (serveur de dev, captures) ; absente sans navigateur. */
  web?: WebView
  /** La preuve mobile du vérificateur (appareil, app lancée, captures) ; absente sans appareil. */
  mobile?: MobileView
}

const plural = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`
const ABSENT = '*Absent : '
const estNouvelle = (e: VerifErreur) => e.statut === 'nouvelle' || e.statut === 'nouvelle?'

const ETAT: Record<VerifJournal['etat'], string> = {
  verifie: 'vérifié ✓',
  'non-verifie': 'non vérifié ✗',
  observe: 'observé (non bloquant)',
  off: 'désactivée',
  erreur: 'erreur de revo-flow, la porte s\'est ouverte',
}

const VERDICT: Record<CritereVerdict['verdict'], string> = { ok: 'ok ✓', ko: 'ko ✗', 'non-verifiable': 'non vérifiable' }

/** 1. La demande et le plan : chaque agent, son modèle, son effort et ses tâches (✓ faite). */
function planSection(flow: Flow): string[] {
  const tasks = flow.agents.reduce((n, a) => n + a.tasks.length, 0)
  const done = flow.agents.reduce((n, a) => n + a.tasks.filter(t => t.status === 'completed').length, 0)
  const out = ['## Demande et plan', '', `**Demande** : ${flow.request}`, '']
  if (flow.summary) out.push(flow.summary, '')
  out.push(`**${plural(flow.agents.length, 'agent', 'agents')} · ${done}/${tasks} ${tasks > 1 ? 'tâches faites' : 'tâche faite'}**`, '')
  for (const a of flow.agents) {
    out.push(`### ${a.name}`, '', `${MODELS[a.model].label} · effort ${a.effort} · ${a.subagentType} · ${a.status}`, '')
    out.push(...a.tasks.map((t, i) => `${i + 1}. ${t.status === 'completed' ? '✓' : '○'} ${t.title} \`${t.kind}\``), '')
  }
  if (!flow.agents.length) out.push('*Aucun agent dans ce plan.*', '')
  return out
}

/** 2. Les fichiers modifiés, groupés par agent (le champ `by`, « lead » sans auteur). */
function filesSection(flow: Flow, entries: readonly Entry[]): string[] {
  const out = ['## Fichiers modifiés', '']
  if (!entries.length) return [...out, `${ABSENT}aucun fichier modifié pendant ce flow.*`, '']
  const nameOf = (by: string | undefined) => (!by || by === 'lead' ? 'orchestrateur' : (flow.agents.find(a => a.key === by)?.name ?? by))
  const groups = new Map<string, Entry[]>()
  for (const e of entries) groups.set(nameOf(e.by), [...(groups.get(nameOf(e.by)) ?? []), e])
  out.push(`**${plural(entries.length, 'fichier', 'fichiers')}**`, '')
  for (const [name, list] of groups) {
    out.push(`### ${name} (${list.length})`, '')
    out.push(...list.map(e => `- \`${e.rel}\`${e.count > 1 ? ` ×${e.count}` : ''}${e.reason ? ` : ${e.reason}` : ''}${e.conflict?.length ? ' ⚠ conflit' : ''}`), '')
  }
  return out
}

/** 3. La porte : verdict, commandes, durée, erreurs nouvelles, exceptions accordées. */
function gateSection(verif: VerifJournal | undefined, porte: RapportPorte | undefined): string[] {
  const out = ['## Vérification (porte)', '']
  if (!verif || verif.etat === 'off') return [...out, `${ABSENT}pas de porte de vérification pour ce flow.*`, '']
  out.push(`**Verdict** : ${ETAT[verif.etat]}${verif.accepte ? ' · accepté par l\'utilisateur' : ''}  `)
  out.push(`**Tentatives** : ${verif.tentatives}${verif.premierRouge ? ' (rouge à la première)' : ''}  `)
  out.push(`**Durée** : ${dureeText(verif.dureeMs)}  `)
  out.push(`**Erreurs** : ${plural(verif.nouvelles, 'nouvelle', 'nouvelles')} · ${plural(verif.preexistantes, 'préexistante', 'préexistantes')}`, '')
  const r = porte?.resultat
  if (r?.commandes.length) {
    out.push('Commandes lancées :', '')
    for (const c of r.commandes) {
      const mark = c.etat === 'ok' ? '✓' : c.etat === 'ko' ? '✗' : c.etat === 'saute' ? '–' : '⚠'
      const detail = c.etat === 'saute' ? 'sautée' : `${plural(c.nouvelles, 'nouvelle', 'nouvelles')} · ${dureeText(c.dureeMs)}`
      out.push(`- ${mark} \`${c.id}\` : ${detail}${c.note ? ` (${c.note})` : ''}`)
    }
    out.push('')
  }
  const fresh = (r?.erreurs ?? []).filter(estNouvelle).filter(e => e.outil !== 'crap')
  if (fresh.length) {
    out.push('Erreurs nouvelles :', '', ...fresh.slice(0, 20).map(e => `- \`${e.fichier || '(projet)'}${e.ligne ? `:${e.ligne}` : ''}\` ${e.code} ${e.message}`))
    if (fresh.length > 20) out.push(`- … et ${fresh.length - 20} autres`)
    out.push('')
  }
  const exceptions = [
    ...(porte?.accepte || verif.accepte ? ['Fini rouge sur décision de l\'utilisateur.'] : []),
    ...(verif.triches ? [`${plural(verif.triches, 'triche détectée', 'triches détectées')} (tests affaiblis ou contournés).`] : []),
    ...(porte?.gelesModifies ?? []).filter(g => g.decision === 'accepte').map(g => `Test gelé modifié, accepté : \`${g.p}\` (${g.par}).`),
  ]
  out.push(exceptions.length ? 'Exceptions :' : '*Aucune exception accordée.*', '')
  if (exceptions.length) out.push(...exceptions.map(x => `- ${x}`), '')
  return out
}

/** Le paragraphe « Preuve web » : le serveur et les captures (liens vers les fichiers), ou pourquoi il n'y en a pas. */
function webParagraph(web: WebView | undefined): string {
  const w = web
  if (!w || w.etat === 'non-demande') return `**Preuve web** : ${ABSENT}le vérificateur n’a pas demandé le navigateur.*`
  if (w.etat === 'refuse') return '**Preuve web** : serveur non démarré (choix de l’utilisateur) : les critères web sont non vérifiables'
  if (w.etat === 'erreur') return `**Preuve web** : le serveur n’a pas démarré : ${w.note ?? 'erreur inconnue'}`
  if (w.etat === 'demarrage' || w.etat === 'question') return '**Preuve web** : serveur en cours de démarrage'
  const liens = w.captures.map(c => `[${c.split(/[\\/]/).pop()}](<${c}>)`)
  const nb = liens.length ? `${plural(liens.length, 'capture', 'captures')} : ${liens.join(', ')}` : 'aucune capture'
  const serveur = `serveur${w.commande ? ` « ${w.commande} »` : ''}${w.url ? ` sur ${w.url}` : ''}`
  return `**Preuve web** : ${serveur} (${w.existant ? 'déjà en marche' : 'démarré par revo-flow'}), ${nb}`
}

/** Le paragraphe « Preuve mobile » : l'appareil, l'app et les captures (liens vers les fichiers), ou pourquoi il n'y en a pas. */
function mobileParagraph(mobile: MobileView | undefined): string | undefined {
  const m = mobile
  if (!m || m.etat === 'non-demande') return undefined
  if (m.etat === 'refuse') return '**Preuve mobile** : app non lancée (choix de l’utilisateur) : les critères mobiles sont non vérifiables'
  if (m.etat === 'erreur') return `**Preuve mobile** : l’app n’a pas été lancée : ${m.note ?? 'erreur inconnue'}`
  if (m.etat === 'demarrage' || m.etat === 'installation' || m.etat === 'question') return '**Preuve mobile** : app en cours de lancement'
  const liens = m.captures.map(c => `[${c.split(/[\\/]/).pop()}](<${c}>)`)
  const nb = liens.length ? `${plural(liens.length, 'capture', 'captures')} : ${liens.join(', ')}` : 'aucune capture'
  const app = `app${m.framework ? ` ${m.framework}` : ''}${m.commande ? ` « ${m.commande} »` : ''}${m.appareil ? ` sur ${m.appareil}` : ''}`
  return `**Preuve mobile** : ${app}${m.emulateurLance ? ' (émulateur démarré par revo-flow)' : ''}, ${nb}`
}

/** 4. Les critères d'acceptation et le verdict du vérificateur, avec la preuve de chacun. */
function criteriaSection(criteres: readonly Critere[] | undefined, verdicts: readonly CritereVerdict[] | undefined, web?: WebView, mobile?: MobileView): string[] {
  const out = [`## Critères d'acceptation`, '']
  if (!criteres?.length) return [...out, `${ABSENT}le plan n'avait pas de critères.*`, '']
  const ok = verdicts?.filter(v => v.verdict === 'ok').length ?? 0
  out.push(verdicts?.length ? `**${ok}/${criteres.length} critères ok**` : '*Pas de verdict du vérificateur.*', '')
  for (const c of criteres) {
    const v = verdicts?.find(x => x.id === c.id)
    out.push(`- **${c.id}** ${c.texte} : ${v ? `${VERDICT[v.verdict]}${v.web ? ' · preuve web' : ''}${v.mobile ? ' · preuve mobile' : ''}` : 'sans verdict'}`)
    if (v?.preuve) out.push(`  > ${v.preuve.replace(/\s*\n\s*/g, ' ')}`)
  }
  // Un projet a l'une ou l'autre : la preuve mobile remplace le paragraphe web quand le vérificateur l'a demandée.
  const mobileP = mobileParagraph(mobile)
  return [...out, '', mobileP ?? webParagraph(web), '']
}

/** 5. Le score CRAP : les fonctions au-dessus du seuil, touchées par le flow (nouvelles) ou non (préexistantes). */
function crapSection(verif: VerifJournal | undefined, porte: RapportPorte | undefined): string[] {
  const out = ['## Score CRAP', '']
  if (!verif?.crap) return [...out, `${ABSENT}pas de score CRAP pour ce flow.*`, '']
  const { fonctions, nouvelles, preexistantes } = verif.crap
  if (!fonctions) return [...out, 'Aucune fonction au-dessus du seuil.', '']
  out.push(`${plural(fonctions, 'fonction', 'fonctions')} au-dessus du seuil : ${nouvelles} modifiée${nouvelles > 1 ? 's' : ''} par le flow, ${preexistantes} préexistante${preexistantes > 1 ? 's' : ''} (non bloquantes).`, '')
  const fns = (porte?.resultat?.erreurs ?? []).filter(e => e.outil === 'crap')
  if (fns.length) out.push(...fns.map(e => `- ${e.statut === 'preexistante' ? '⚠' : '✗'} \`${e.fichier}${e.ligne ? `:${e.ligne}` : ''}\` ${e.message}`), '')
  return out
}

/** 6. Durée, coût, tokens, et tokens évités par le cache. */
function costSection(flow: Flow, lead: Lead, date: string | undefined, cache: CacheStats['flow'] | undefined): string[] {
  const out = ['## Durée, coût et tokens', '']
  const cost = lead.costUsd + flow.agents.reduce((n, a) => n + a.costUsd, 0)
  const tokens = total(lead.tokens) + flow.agents.reduce((n, a) => n + total(a.tokens), 0)
  out.push(`**Durée** : ${fmtDuration((flow.endedAt ?? flow.startedAt) - flow.startedAt)}${date ? ` (fini le ${date})` : ''}  `)
  out.push(`**Coût** : ${euros(cost)}  `, `**Tokens** : ${fmt(tokens)}`, '')
  out.push(`- orchestrateur : ${euros(lead.costUsd)} · ${fmt(total(lead.tokens))} tokens`)
  out.push(...flow.agents.map(a => `- ${a.name} : ${euros(a.costUsd)} · ${fmt(total(a.tokens))} tokens${a.attempts && a.attempts > 1 ? ` · ${a.attempts} lancements` : ''}`), '')
  out.push(cache ? `**Cache** : ${fmt(cache.evites)} tokens évités, ${fmt(cache.injecte)} injectés (net ${fmt(cache.net)}).` : `${ABSENT}pas de mesure du cache pour ce flow.*`, '')
  return out
}

/** Le rapport de flow en markdown : six sections, chacune dite absente en une ligne quand elle n'a rien à montrer. */
export function rapportMarkdown(input: RapportInput): string {
  const { flow, lead, entries, verif, porte, criteres, verdicts, cache, date, web, mobile } = input
  const where = [flow.project, flow.branch].filter(Boolean).join(' · ')
  const head = [`# Rapport : ${flow.title}`, '']
  if (where) head.push(`**Projet** : ${where}  `)
  head.push(`**Fin** : ${flow.isStopped ? 'arrêté' : 'terminé'}${date ? `, le ${date}` : ''}`, '')
  return [
    ...head,
    ...planSection(flow),
    ...filesSection(flow, entries),
    ...gateSection(verif, porte),
    ...criteriaSection(criteres, verdicts, web, mobile),
    ...crapSection(verif, porte),
    ...costSection(flow, lead, date, cache),
  ]
    .join('\n')
    .trimEnd() + '\n'
}
