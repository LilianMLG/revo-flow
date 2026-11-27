// Le rapport de flow (docs/rd-v3 §2.4) : un markdown écrit en fin de flow, à côté du plan, qui sert de description de MR.
// Pur : une mise en forme de ce que le flow sait déjà (agents, fichiers, porte, critères, cache), aucune collecte.
import type { ArchiView, CacheStats, Critere, CritereVerdict, Entry, Flow, Lead, MobileView, VerifErreur, VerifJournal, VerifResultat, WebView } from '../types'
import { BUDGET_HONNETETE, type BudgetJournal } from './budget'
import { MODELS, euros, fmt, fmtDuration, total } from './lib'
import { papercutRapport, type Papercut } from './papercut'
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
  /** La revue d'architecture du vérificateur (étape ARCHI, v3.2) ; absente si elle n'a pas eu lieu. */
  archi?: ArchiView
  /** Les fichiers modifiés par un agent hors du périmètre qu'il avait déclaré au plan ; absent ou vide : pas de section « Périmètre ». */
  horsPlan?: { agent: string; fichiers: string[] }[]
  /** Le budget du flow (docs/rd-v4 §2.2) : estimé, plafond, réel (en dollars) ; absent sans budget. */
  budget?: BudgetJournal
  /** La racine du dépôt : les fichiers modifiés qui n'y sont pas (scratchpad, worktree) ne sont pas listés. Absente : seuls les chemins de scratchpad sont écartés. */
  racine?: string
  /** Les papercuts signalés pendant ce flow (v3.7) ; absent ou vide : la section dit qu'il n'y en a pas. */
  papercuts?: Papercut[]
  /** Les appels d'outils et les échecs de chaque sous-agent (v3.7) ; absent : pas de tableau. */
  trajectoires?: { nom: string; appels: number; echecs: number }[]
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

/** Un chemin au format unique : barres obliques, sans barre finale. */
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** Le fichier est-il dans le dépôt ? Hors de la racine (si connue) ou dans un scratchpad : non (docs/rd-v4 §1.4). */
function dansDepot(path: string, racine: string | undefined): boolean {
  const p = norm(path)
  if (p.includes('/scratchpad/')) return false
  if (!racine) return true
  const r = norm(racine)
  const win = /^[a-z]:/i.test(r)
  return (win ? p.toLowerCase() : p).startsWith(`${win ? r.toLowerCase() : r}/`)
}

/** « Changé : » le nombre de fichiers (dont ceux hors plan) et d'agents, et le titre du flow. */
function changeLine(flow: Flow, entries: readonly Entry[], horsPlan: RapportInput['horsPlan']): string {
  const hors = new Set((horsPlan ?? []).flatMap(h => h.fichiers)).size
  const fichiers = `${plural(entries.length, 'fichier', 'fichiers')}${hors ? ` (dont ${hors} hors plan)` : ''}`
  return `Changé : ${fichiers}, ${plural(flow.agents.length, 'agent', 'agents')} : ${flow.title}`
}

/** « Vérifié : » ce qui est vert : commandes de la porte, critères, revue d'architecture, preuve web ou mobile. */
function verifieLine({ porte, criteres, verdicts, archi, web, mobile }: RapportInput): string {
  const vertes = (porte?.resultat?.commandes ?? []).filter(c => c.etat === 'ok').map(c => c.id)
  const ok = verdicts?.filter(v => v.verdict === 'ok').length ?? 0
  const captures = (web?.captures.length ?? 0) + (mobile?.captures.length ?? 0)
  const parts = [
    // « porte verte » seulement quand toute la porte l'est : sur une porte rouge ou en panne, seules les commandes vertes sont nommées.
    vertes.length ? `${porte?.resultat?.etat === 'vert' ? 'porte verte' : 'commandes vertes de la porte'} (${vertes.join(', ')})` : '',
    criteres?.length && ok ? `critères ${ok}/${criteres.length}` : '',
    archi?.verdict === 'ok' ? 'revue d\'architecture' : '',
    captures ? `preuve ${mobile?.captures.length ? 'mobile' : 'web'} (${plural(captures, 'capture', 'captures')})` : '',
  ].filter(Boolean)
  return `Vérifié : ${parts.length ? parts.join(', ') : 'rien de prouvé'}.`
}

/** Les critères ko, non vérifiables ou sans verdict, par identifiant. */
function criteresNonVerifies(criteres: readonly Critere[] | undefined, verdicts: readonly CritereVerdict[] | undefined): string[] {
  return (criteres ?? []).flatMap(c => {
    const v = verdicts?.find(x => x.id === c.id)?.verdict
    return v === 'ok' ? [] : [`${c.id} ${v ? VERDICT[v].replace(/ [✓✗]/, '') : 'sans verdict'}`]
  })
}

/** Les commandes de la porte qui n'ont pas dit « vert » : en panne, sautées ou rouges, avec leur raison. */
function commandesNonVerifiees(porte: RapportPorte | undefined): string[] {
  const NOTE = { erreur: 'en panne', saute: 'sautée', ko: 'ko' } as const
  return (porte?.resultat?.commandes ?? []).flatMap(c => (c.etat in NOTE ? [`${c.id} : ${c.note ?? NOTE[c.etat as keyof typeof NOTE]}`] : []))
}

/** La revue d'architecture quand elle n'est pas conforme : ko, non vérifiable, en attente, passée ou absente. */
function archiNonVerifiee(archi: ArchiView | undefined): string[] {
  if (!archi) return ['pas de revue d\'architecture']
  return archi.verdict === 'ok' ? [] : [`revue d'architecture ${ARCHI_TEXTE[archi.verdict].replace(/ [✓✗]/, '')}`]
}

/** Les exceptions de la porte : rouge accepté, triches, tests gelés modifiés et acceptés ; et la porte elle-même quand elle n'est pas verte. */
function porteNonVerifiee(verif: VerifJournal | undefined, porte: RapportPorte | undefined): string[] {
  if (!verif || verif.etat === 'off') return ['pas de porte de vérification']
  const gel = (porte?.gelesModifies ?? []).filter(g => g.decision === 'accepte').length
  return [
    ...(verif.etat === 'erreur' ? ['porte en erreur'] : []),
    ...(porte?.accepte || verif.accepte ? ['fini rouge sur décision de l\'utilisateur'] : []),
    ...(verif.triches ? [plural(verif.triches, 'triche détectée', 'triches détectées')] : []),
    ...(gel ? [`${plural(gel, 'test gelé modifié', 'tests gelés modifiés')}, accepté`] : []),
  ]
}

/** « Non vérifié : » tout ce qu'un relecteur doit savoir ; « rien à signaler » sinon. */
function nonVerifieLine(input: RapportInput): string {
  const items = [
    ...(input.flow.isStopped ? ['flow arrêté'] : []),
    ...porteNonVerifiee(input.verif, input.porte),
    ...commandesNonVerifiees(input.porte),
    ...criteresNonVerifies(input.criteres, input.verdicts),
    ...archiNonVerifiee(input.archi),
  ]
  return items.length ? `Non vérifié : ${items.join(' ; ')}.` : 'Non vérifié : rien à signaler.'
}

/** « En clair » : trois lignes au plus, par gabarit : ce qui a changé, ce qui est vérifié, ce qui ne l'est pas. */
export function enClair(input: RapportInput): string[] {
  const entries = input.entries.filter(e => dansDepot(e.path, input.racine))
  return [changeLine(input.flow, entries, input.horsPlan), verifieLine(input), nonVerifieLine(input)]
}

/** 0. La section « En clair » : les trois lignes de enClair, une par ligne dans le rendu. */
function enClairSection(input: RapportInput): string[] {
  const lines = enClair(input)
  return ['## En clair', '', ...lines.map((l, i) => (i < lines.length - 1 ? `${l}  ` : l)), '']
}

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
function filesSection(flow: Flow, entries: readonly Entry[], ecartes = 0): string[] {
  const out = ['## Fichiers modifiés', '']
  if (!entries.length) return [...out, `${ABSENT}aucun fichier modifié pendant ce flow.*`, ...(ecartes ? [`*${plural(ecartes, 'fichier hors du dépôt non listé', 'fichiers hors du dépôt non listés')}.*`] : []), '']
  const nameOf = (by: string | undefined) => (!by || by === 'lead' ? 'orchestrateur' : (flow.agents.find(a => a.key === by)?.name ?? by))
  const groups = new Map<string, Entry[]>()
  for (const e of entries) groups.set(nameOf(e.by), [...(groups.get(nameOf(e.by)) ?? []), e])
  out.push(`**${plural(entries.length, 'fichier', 'fichiers')}**`, '')
  for (const [name, list] of groups) {
    out.push(`### ${name} (${list.length})`, '')
    out.push(...list.map(e => `- \`${e.rel}\`${e.count > 1 ? ` ×${e.count}` : ''}${e.reason ? ` : ${e.reason}` : ''}${e.conflict?.length ? ' ⚠ conflit' : ''}`), '')
  }
  if (ecartes) out.push(`*${plural(ecartes, 'fichier hors du dépôt non listé', 'fichiers hors du dépôt non listés')}.*`, '')
  return out
}

/** 2 bis. Le périmètre : ce que des agents ont touché hors de ce que le plan leur avait donné ; pas de section sans cela. */
function perimetreSection(horsPlan: RapportInput['horsPlan']): string[] {
  const liste = (horsPlan ?? []).filter(h => h.fichiers.length)
  if (!liste.length) return []
  return ['## Périmètre', '', ...liste.flatMap(h => [`Hors plan, touché quand même : ${h.fichiers.join(', ')} (agent ${h.agent})`, ''])]
}

/** Le verdict de la porte : « non vérifié (porte en panne : flutter-test : délai dépassé (10 min 00)) » quand elle n'a pas pu juger (v3.6). */
function verdictText(verif: VerifJournal): string {
  return verif.etat === 'non-verifie' && verif.pannes?.length && !verif.nouvelles ? `non vérifié (porte en panne : ${verif.pannes.join(' ; ')})` : ETAT[verif.etat]
}

/** 3. La porte : verdict, commandes, durée, erreurs nouvelles, exceptions accordées. */
function gateSection(verif: VerifJournal | undefined, porte: RapportPorte | undefined): string[] {
  const out = ['## Vérification (porte)', '']
  if (!verif || verif.etat === 'off') return [...out, `${ABSENT}pas de porte de vérification pour ce flow.*`, '']
  out.push(`**Verdict** : ${verdictText(verif)}${verif.accepte ? ' · accepté par l\'utilisateur' : ''}  `)
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
  if (w.etat === 'ferme') return `**Preuve web** : serveur non démarré, question restée sans réponse (${w.note ?? 'dialogue fermé'}) : les critères web sont non vérifiables`
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
  if (m.etat === 'ferme') return `**Preuve mobile** : app non lancée, question restée sans réponse (${m.note ?? 'dialogue fermé'}) : les critères mobiles sont non vérifiables`
  if (m.etat === 'erreur') return `**Preuve mobile** : l’app n’a pas été lancée : ${m.note ?? 'erreur inconnue'}`
  if (m.etat === 'demarrage' || m.etat === 'installation' || m.etat === 'question') return '**Preuve mobile** : app en cours de lancement'
  const liens = m.captures.map(c => `[${c.split(/[\\/]/).pop()}](<${c}>)`)
  const nb = liens.length ? `${plural(liens.length, 'capture', 'captures')} : ${liens.join(', ')}` : 'aucune capture'
  const app = `app${m.framework ? ` ${m.framework}` : ''}${m.commande ? ` « ${m.commande} »` : ''}${m.appareil ? ` sur ${m.appareil}` : ''}`
  return `**Preuve mobile** : ${app}${m.emulateurLance ? ' (émulateur démarré par revo-flow)' : ''}, ${nb}`
}

/** 4. Les critères d'acceptation et le verdict du vérificateur, avec la preuve de chacun. */
const ARCHI_TEXTE: Record<ArchiView['verdict'], string> = {
  attente: 'en attente du vérificateur',
  ok: 'conforme ✓',
  ko: 'ko ✗',
  'non-verifiable': 'non vérifiable',
  passee: 'terminé sans revue (décision de l’utilisateur)',
}

/** La revue d'architecture : le verdict de l'étape ARCHI et sa preuve, ou ce qui l'a remplacée. */
function archiSection(archi: ArchiView | undefined): string[] {
  const out = ['## Architecture', '']
  if (!archi) return [...out, `${ABSENT}pas de revue d'architecture pour ce flow.*`, '']
  out.push(`**Revue du vérificateur** : ${ARCHI_TEXTE[archi.verdict]}`)
  if (archi.preuve) out.push(`> ${archi.preuve.replace(/\s*\n\s*/g, ' ')}`)
  return [...out, '']
}

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

/** 4 bis. Les papercuts signalés pendant le flow et la trajectoire des agents (v3.7). */
function papercutsSection(papercuts: RapportInput['papercuts'], trajectoires: RapportInput['trajectoires']): string[] {
  const corps = papercutRapport(papercuts ?? [], trajectoires ?? [])
  return [...(corps[0]?.startsWith('## ') ? [] : ['## Papercuts et trajectoire', '']), ...corps, '']
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

/** « **Budget** : estimé 0,90 € · plafond 1,80 € · réel 1,12 € » ; « plafond atteint » en fin de ligne si c'est le cas. */
function budgetLine(b: BudgetJournal): string {
  const plafond = b.plafond === undefined ? 'sans plafond' : `plafond ${euros(b.plafond)}`
  return `**Budget** : estimé ${euros(b.estime)} · ${plafond} · réel ${euros(b.reel)}${b.atteint ? ' · plafond atteint' : ''}  `
}

/** 6. Durée, coût, tokens, et tokens évités par le cache. */
function costSection(flow: Flow, lead: Lead, date: string | undefined, cache: CacheStats['flow'] | undefined, budget?: BudgetJournal): string[] {
  const out = ['## Durée, coût et tokens', '']
  const cost = lead.costUsd + flow.agents.reduce((n, a) => n + a.costUsd, 0)
  const tokens = total(lead.tokens) + flow.agents.reduce((n, a) => n + total(a.tokens), 0)
  out.push(`**Durée** : ${fmtDuration((flow.endedAt ?? flow.startedAt) - flow.startedAt)}${date ? ` (fini le ${date})` : ''}  `)
  out.push(`**Coût** : ${euros(cost)}  `, `**Tokens** : ${fmt(tokens)}`, '')
  if (budget) out.push(budgetLine(budget), `*${BUDGET_HONNETETE}*`, '')
  out.push(`- orchestrateur : ${euros(lead.costUsd)} · ${fmt(total(lead.tokens))} tokens`)
  out.push(...flow.agents.map(a => `- ${a.name} : ${euros(a.costUsd)} · ${fmt(total(a.tokens))} tokens${a.attempts && a.attempts > 1 ? ` · ${a.attempts} lancements` : ''}`), '')
  out.push(cache ? `**Cache** : ${fmt(cache.evites)} tokens évités, ${fmt(cache.injecte)} injectés (net ${fmt(cache.net)}).` : `${ABSENT}pas de mesure du cache pour ce flow.*`, '')
  return out
}

/** Le rapport de flow en markdown : « En clair » en tête puis six sections, chacune dite absente en une ligne quand elle n'a rien à montrer. */
export function rapportMarkdown(input: RapportInput): string {
  const { flow, lead, verif, porte, criteres, verdicts, cache, date, web, mobile, archi, horsPlan, budget } = input
  const entries = input.entries.filter(e => dansDepot(e.path, input.racine))
  const ecartes = input.entries.length - entries.length
  const where = [flow.project, flow.branch].filter(Boolean).join(' · ')
  const head = [`# Rapport : ${flow.title}`, '']
  if (where) head.push(`**Projet** : ${where}  `)
  head.push(`**Fin** : ${flow.isStopped ? 'arrêté' : 'terminé'}${date ? `, le ${date}` : ''}`, '')
  return [
    ...head,
    ...enClairSection(input),
    ...planSection(flow),
    ...filesSection(flow, entries, ecartes),
    ...perimetreSection(horsPlan),
    ...gateSection(verif, porte),
    ...criteriaSection(criteres, verdicts, web, mobile),
    ...archiSection(archi),
    ...papercutsSection(input.papercuts, input.trajectoires),
    ...crapSection(verif, porte),
    ...costSection(flow, lead, date, cache, budget),
  ]
    .join('\n')
    .trimEnd() + '\n'
}
