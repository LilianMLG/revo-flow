// Les papercuts (v3.7) : la friction que les agents signalent eux-mêmes (commande, doc, outil qui gêne), dédoublonnée par projet,
// et la trajectoire d'un agent (échecs d'outils de suite) pour le prévenir quand il s'acharne.
// Pur : des textes et des chiffres, aucun accès disque ni processus ; rien ne lève, une entrée bizarre rend une valeur sûre.

export type PapercutCible = 'projet' | 'revo-flow' | 'outil'

export type Papercut = {
  /** « pc- » et 8 caractères dérivés de papercutKey : même clé, même id. */
  id: string
  /** projet : le dépôt de l'utilisateur (commande, script, doc, test) ; revo-flow : le mod lui-même ; outil : un outil de Claude Code ou un MCP. */
  cible: PapercutCible
  /** L'outil ou la commande en cause : « Bash », « npm run lint », « mcp__x__y ». */
  outil?: string
  /** Ce que l'agent essayait de faire (300 caractères au plus, comme les champs suivants). */
  quoi: string
  attendu?: string
  obtenu: string
  correctif?: string
  /** Comment l'agent s'en est sorti : utile aux flows suivants. */
  contournement?: string
  /** Le nom de l'agent qui l'a signalé. */
  par: string
  /** Le titre du flow. */
  flow: string
  /** Date ISO. */
  le: string
  /** Nombre de signalements fusionnés (1 au départ). */
  vu: number
}

/** Au plus ce nombre de papercuts par projet : les plus anciens tombent. */
export const PAPERCUTS_MAX = 50

/** Longueur maximale d'un champ texte d'un papercut. */
const CHAMP_MAX = 300
/** Longueur de l'obtenu normalisé dans la clé. */
const CLE_MAX = 120
/** Longueur de la signature d'une erreur d'outil. */
const SIGNATURE_MAX = 80

const CIBLES: readonly PapercutCible[] = ['projet', 'revo-flow', 'outil']
const estCible = (v: unknown): v is PapercutCible => typeof v === 'string' && (CIBLES as readonly string[]).includes(v)

/** Un texte optionnel : la chaîne rognée, tronquée à 300 caractères avec « … » ; undefined si ce n'est pas une chaîne ou si elle est vide. */
function champ(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (!t) return undefined
  return t.length > CHAMP_MAX ? `${t.slice(0, CHAMP_MAX - 1).trimEnd()}…` : t
}

/**
 * Valide ce que l'agent a envoyé à l'outil papercut : quoi et obtenu sont obligatoires, une cible inconnue ou absente vaut « projet »,
 * les textes sont tronqués à 300 caractères. L'erreur est écrite pour l'agent, en français.
 */
export function parsePapercut(input: Record<string, unknown>, ctx: { par: string; flow: string; le: string }): { papercut: Papercut } | { error: string } {
  const i = input && typeof input === 'object' ? input : {}
  const quoi = champ(i.quoi)
  const obtenu = champ(i.obtenu)
  if (!quoi && !obtenu) return { error: 'revo-flow papercut : « quoi » (ce que tu essayais de faire) et « obtenu » (ce qui s’est passé) sont obligatoires.' }
  if (!quoi) return { error: 'revo-flow papercut : « quoi » est obligatoire : ce que tu essayais de faire.' }
  if (!obtenu) return { error: 'revo-flow papercut : « obtenu » est obligatoire : ce qui s’est passé.' }
  const cible: PapercutCible = estCible(i.cible) ? i.cible : 'projet'
  const outil = champ(i.outil)
  const base = { cible, outil, obtenu }
  const attendu = champ(i.attendu)
  const correctif = champ(i.correctif)
  const contournement = champ(i.contournement)
  return {
    papercut: {
      id: papercutId(base),
      cible,
      ...(outil ? { outil } : {}),
      quoi,
      ...(attendu ? { attendu } : {}),
      obtenu,
      ...(correctif ? { correctif } : {}),
      ...(contournement ? { contournement } : {}),
      par: String(ctx?.par ?? ''),
      flow: String(ctx?.flow ?? ''),
      le: String(ctx?.le ?? ''),
      vu: 1,
    },
  }
}

/** Le texte réduit à ce qui compte pour reconnaître deux fois la même erreur : minuscules, chemins et chiffres effacés, espaces repliés. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[a-z]:[\\/][^\s'"`]*/g, '<chemin>')
    .replace(/\/[^\s'"`/]+(?:\/[^\s'"`/]+)+/g, '<chemin>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * La clé de dédoublonnage : cible, outil (minuscules) et obtenu normalisé (minuscules, chiffres en « # », chemins en « <chemin> », espaces
 * repliés, 120 caractères) : deux erreurs qui ne diffèrent que par un numéro de ligne ou un chemin ont la même clé.
 */
export function papercutKey(p: Pick<Papercut, 'cible' | 'outil' | 'obtenu'>): string {
  const obtenu = normalise(String(p?.obtenu ?? '')).slice(0, CLE_MAX)
  return `${p?.cible ?? ''}|${String(p?.outil ?? '').trim().toLowerCase()}|${obtenu}`
}

/** « pc- » et 8 caractères hexadécimaux (FNV-1a) de la clé : stable, sans dépendance. */
function papercutId(p: Pick<Papercut, 'cible' | 'outil' | 'obtenu'>): string {
  let h = 0x811c9dc5
  for (const c of papercutKey(p)) {
    h ^= c.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `pc-${h.toString(16).padStart(8, '0')}`
}

/**
 * Ajoute un papercut à la liste : même clé, fusion (vu + 1, date, agent et flow du nouveau, correctif et contournement remplacés seulement
 * s'il en apporte) ; sinon ajout. L'entrée passe en tête ; la liste garde PAPERCUTS_MAX entrées, les plus anciennes tombent.
 */
export function addPapercut(list: readonly Papercut[], p: Papercut): { list: Papercut[]; nouveau: boolean; vu: number } {
  const key = papercutKey(p)
  const l = Array.isArray(list) ? list : []
  const old = l.find(x => papercutKey(x) === key)
  if (old) {
    const fusion: Papercut = {
      ...old,
      le: p.le,
      par: p.par,
      flow: p.flow,
      vu: old.vu + 1,
      ...(p.correctif ? { correctif: p.correctif } : {}),
      ...(p.contournement ? { contournement: p.contournement } : {}),
    }
    return { list: [fusion, ...l.filter(x => x !== old)].slice(0, PAPERCUTS_MAX), nouveau: false, vu: fusion.vu }
  }
  const neuf: Papercut = { ...p, vu: Number.isFinite(p.vu) && p.vu >= 1 ? Math.floor(p.vu) : 1 }
  return { list: [neuf, ...l].slice(0, PAPERCUTS_MAX), nouveau: true, vu: neuf.vu }
}

/** Relit ce que le store a gardé : seuls les objets valides sont rendus, tout le reste (ou autre chose qu'un tableau) donne []. */
export function readPapercuts(v: unknown): Papercut[] {
  if (!Array.isArray(v)) return []
  const out: Papercut[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    const quoi = champ(o.quoi)
    const obtenu = champ(o.obtenu)
    if (!quoi || !obtenu || typeof o.id !== 'string' || !o.id || !estCible(o.cible)) continue
    if (typeof o.par !== 'string' || typeof o.flow !== 'string' || typeof o.le !== 'string') continue
    const outil = champ(o.outil)
    const attendu = champ(o.attendu)
    const correctif = champ(o.correctif)
    const contournement = champ(o.contournement)
    out.push({
      id: o.id,
      cible: o.cible,
      ...(outil ? { outil } : {}),
      quoi,
      ...(attendu ? { attendu } : {}),
      obtenu,
      ...(correctif ? { correctif } : {}),
      ...(contournement ? { contournement } : {}),
      par: o.par,
      flow: o.flow,
      le: o.le,
      vu: typeof o.vu === 'number' && Number.isFinite(o.vu) && o.vu >= 1 ? Math.floor(o.vu) : 1,
    })
  }
  return out
}

/** Les plus vus d'abord, puis les plus récents (date ISO : l'ordre des chaînes est l'ordre du temps). */
const parImportance = (a: Papercut, b: Papercut): number => b.vu - a.vu || (a.le < b.le ? 1 : a.le > b.le ? -1 : 0)

/**
 * Le brief donné au modèle : les papercuts connus du projet (les plus vus, puis les plus récents, `max` au plus), une ligne chacun avec
 * son contournement s'il existe, et la consigne de signaler les nouveaux. Vide sans papercut.
 */
export function papercutBrief(list: readonly Papercut[], max = 5): string {
  const gardes = [...(Array.isArray(list) ? list : [])].sort(parImportance).slice(0, Math.max(0, Math.floor(max)))
  if (!gardes.length) return ''
  return [
    '## Papercuts connus du projet',
    ...gardes.map(p => `- [×${p.vu}] ${p.quoi} → ${p.obtenu}${p.contournement ? ` ; contournement : ${p.contournement}` : ''}`),
    'Évite ces pièges ; si tu en rencontres un nouveau, signale-le avec mcp__revo-flow__papercut.',
  ].join('\n')
}

const pluriel = (n: number) => `${n} papercut${n > 1 ? 's' : ''}`

/** Un papercut pour /revo-flow papercuts : cible, outil, quoi, attendu, obtenu, correctif, contournement, vu, par, date. */
function papercutBloc(p: Papercut): string {
  return [
    `- ${p.id} · ${p.cible}${p.outil ? ` · ${p.outil}` : ''}`,
    `  quoi : ${p.quoi}`,
    ...(p.attendu ? [`  attendu : ${p.attendu}`] : []),
    `  obtenu : ${p.obtenu}`,
    ...(p.correctif ? [`  correctif : ${p.correctif}`] : []),
    ...(p.contournement ? [`  contournement : ${p.contournement}`] : []),
    `  vu ×${p.vu} · par ${p.par || '?'} · ${p.le.slice(0, 10)}`,
  ].join('\n')
}

/** Le texte de /revo-flow papercuts : le compte puis un bloc par papercut ; « aucun papercut signalé » sans rien. */
export function papercutListText(list: readonly Papercut[], projet: string): string {
  const l = Array.isArray(list) ? list : []
  if (!l.length) return `revo-flow papercuts · ${projet} : aucun papercut signalé.`
  return [`revo-flow papercuts · ${projet} : ${pluriel(l.length)}`, '', ...l.map(papercutBloc).flatMap((b, i) => (i ? ['', b] : [b]))].join('\n')
}

/** Une cellule de tableau markdown : sans barre verticale ni retour à la ligne. */
const cellule = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

/**
 * La section « ## Papercuts et trajectoire » du rapport : les papercuts signalés pendant le flow (ou la ligne Absent), puis le tableau
 * des appels d'outils et des échecs par agent, s'il y a des trajectoires. Finit par une ligne vide, comme les autres sections.
 */
export function papercutRapport(list: readonly Papercut[], trajectoires: readonly { nom: string; appels: number; echecs: number }[]): string[] {
  const out = ['## Papercuts et trajectoire', '']
  const l = Array.isArray(list) ? list : []
  if (!l.length) out.push('*Absent : aucun papercut signalé.*', '')
  else {
    out.push(`${pluriel(l.length)} signalé${l.length > 1 ? 's' : ''} pendant ce flow :`, '')
    for (const p of l) {
      out.push(
        `- **${p.cible}**${p.outil ? ` (${p.outil})` : ''} : ${p.quoi} → ${p.obtenu}${p.correctif ? ` ; correctif : ${p.correctif}` : ''}${p.contournement ? ` ; contournement : ${p.contournement}` : ''} (×${p.vu}, ${p.par || '?'})`,
      )
    }
    out.push('')
  }
  const t = Array.isArray(trajectoires) ? trajectoires : []
  if (t.length) {
    out.push('| Agent | Appels d\'outils | Échecs |', '| --- | ---: | ---: |')
    for (const a of t) out.push(`| ${cellule(String(a.nom))} | ${a.appels} | ${a.echecs} |`)
    out.push('')
  }
  return out
}

/** La phrase ajoutée à la consigne de chaque sous-agent : signaler la friction plutôt que s'acharner. */
export const PAPERCUT_BRIEF =
  'Si un outil, une commande, un script ou une doc te gêne (option refusée, erreur silencieuse, doc fausse, test instable), ne t’acharne pas : signale-le avec l’outil mcp__revo-flow__papercut (quoi, attendu, obtenu, contournement si tu en as trouvé un), puis continue autrement.'

/** La consigne de réponse bornée : l'orchestrateur ne repaie pas un gros contexte à chaque agent. */
export const REPONSE_BORNEE =
  'Ta réponse finale : 15 lignes au plus : ce que tu as fait, les fichiers touchés, ce qui reste ouvert. Pas de code ni de journal recopiés : l’orchestrateur relit les fichiers s’il en a besoin.'

// ── La trajectoire d'un agent ────────────────────────────────────────────

/** Les appels d'outils d'un agent : leur nombre, les échecs, la série d'échecs en cours, la dernière erreur (signature) et si l'alerte est partie. */
export type Trajectoire = { appels: number; echecs: number; suite: number; derniereErreur?: string; memeErreur: number; alerte: boolean }

/** Échecs de suite à partir desquels l'agent est dit bloqué. */
export const SUITE_ALERTE = 3
/** Répétitions de la même erreur à partir desquelles l'agent est dit bloqué. */
export const MEME_ERREUR_ALERTE = 2

/** La signature d'une erreur : minuscules, chiffres en « # », espaces repliés, 80 caractères : deux erreurs qui ne diffèrent que par un nombre sont la même. */
const signature = (erreur: string | undefined): string =>
  String(erreur ?? '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SIGNATURE_MAX)

/**
 * Compte un appel d'outil d'un agent. Un échec allonge la série (et la répétition de la même erreur) ; un succès les remet à 0 et réarme l'alerte.
 * L'alerte est rendue une seule fois par série : à 3 échecs de suite, ou quand la même erreur revient 2 fois de suite.
 */
export function stepTrajectoire(t: Trajectoire | undefined, e: { outil: string; echec: boolean; erreur?: string }): { t: Trajectoire; alerte?: { outil: string; suite: number } } {
  const avant: Trajectoire = t ?? { appels: 0, echecs: 0, suite: 0, memeErreur: 0, alerte: false }
  const appels = avant.appels + 1
  if (!e?.echec) return { t: { appels, echecs: avant.echecs, suite: 0, memeErreur: 0, alerte: false } }
  const sig = signature(e.erreur)
  const suite = avant.suite + 1
  const memeErreur = sig && sig === avant.derniereErreur ? avant.memeErreur + 1 : 1
  const declenche = !avant.alerte && (suite >= SUITE_ALERTE || memeErreur >= MEME_ERREUR_ALERTE)
  const next: Trajectoire = { appels, echecs: avant.echecs + 1, suite, ...(sig ? { derniereErreur: sig } : {}), memeErreur, alerte: avant.alerte || declenche }
  return declenche ? { t: next, alerte: { outil: String(e.outil ?? ''), suite } } : { t: next }
}

/** Le texte ajouté au résultat d'un outil quand l'agent s'acharne : changer d'approche, signaler l'outil en cause, continuer autrement. */
export const struggleHint = (outil: string, suite: number): string =>
  `revo-flow : ${suite} échecs de suite (dernier : ${outil}). Arrête de réessayer à l’identique : relis l’erreur et change d’approche ; si l’outil ou la commande est en cause, signale-le avec mcp__revo-flow__papercut, puis continue autrement.`
