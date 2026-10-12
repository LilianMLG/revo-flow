/**
 * Les dessins du mod, d'après la maquette « Claude Mods — Progression & panneau » (thème « Argent »).
 * Des fonctions pures, sans dépendance : on peut les rendre dans un navigateur pour les regarder.
 */

export const PALETTE = {
  // Fonds
  app: '#0B0C0E',
  panel: '#121417',
  panelFoot: '#0F1114',
  bar: '#16191D',
  card: '#181B1F',
  cardWait: '#15181B',
  avatar: '#1F2328',
  segDone: '#2C3138',
  miniDone: '#5E6670',
  // Bordures
  border: '#2A2F36',
  cardBorder: '#262B31',
  sep: '#23272D',
  dotted: '#3E454E',
  waitBorder: '#30353C',
  // Texte
  text: '#ECEEF1',
  text2: '#A7AEB8',
  muted: '#7D8590',
  dim: '#5E6670',
  // Accent unique : l'argent
  silver: '#D5DAE2',
  onSilver: '#0E1013',
  // Signaux
  mascot: '#E07B4C',
  eyes: '#14161A',
  opus: '#E2C27A',
  sonnet: '#B9A6E0',
  haiku: '#7FB3C8',
  red: '#F0524F',
  redText: '#FF8A86',
  redBg: '#3A1A1B',
  redBorder: '#5A2426',
  orange: '#F0A03C',
  ok: '#7FB069',
  // Un agent actif : vert franc, lisible d'un coup d'œil
  live: '#4ADE80',
  liveBorder: '#1F4A31',
} as const

/**
 * Une couleur par sous-agent pour sa barre, dans l'ordre du plan : assez éloignées pour se distinguer,
 * sans vert (réservé à « Actif ») ni rouge (réservé à l'échec). L'orchestrateur garde le blanc.
 */
export const AGENT_COLORS = ['#60A5FA', '#C084FC', '#FBBF24', '#F472B6', '#22D3EE', '#FB923C'] as const

export const FONT = "Geist, Inter, 'Segoe UI', system-ui, -apple-system, sans-serif"
export const MONO = "'Geist Mono', 'Cascadia Mono', Consolas, 'SF Mono', monospace"

export type StageKind = 'now' | 'reached' | 'todo' | 'failed'
export type BarStage = { name: string; kind: StageKind; detail?: string }

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)
const num = (n: number) => String(Math.round(n * 10) / 10)

// ── La mascotte : un monstre pixel-art, un accessoire par modèle ─────────

export type MascotKind = 'opus' | 'sonnet' | 'haiku' | 'none'

type Rect = [number, number, number, number]
const BODY: Rect[] = [
  [2, 0, 1, 1],
  [6, 0, 1, 1],
  [1, 1, 7, 1],
  [0, 2, 9, 2],
  [1, 4, 7, 1],
  [1, 5, 1, 1],
  [3, 5, 1, 1],
  [5, 5, 1, 1],
  [7, 5, 1, 1],
]
const rects = (list: Rect[], fill: string) =>
  list.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`).join('')

/** L'accessoire posé sur la tête : couronne (Opus), chapeau (Sonnet), antenne (Haiku). */
function accessory(kind: MascotKind): string {
  if (kind === 'opus') {
    return rects(
      [
        [2, -1, 5, 1],
        [2, -2, 1, 1],
        [4, -2, 1, 1],
        [6, -2, 1, 1],
      ],
      PALETTE.opus,
    )
  }
  if (kind === 'sonnet') {
    return rects(
      [
        [2, -2, 5, 1],
        [1, -1, 8, 1],
      ],
      PALETTE.sonnet,
    )
  }
  if (kind === 'haiku') {
    return `<rect x="4" y="-1" width="1" height="2" fill="${PALETTE.muted}"/><rect x="3" y="-3" width="3" height="2" fill="${PALETTE.haiku}"/>`
  }
  return ''
}

/** Le corps et les yeux, en unités de pixel ; endormie = yeux fermés. */
function mascotBody(isAsleep: boolean): string {
  const eyes: Rect[] = isAsleep
    ? [
        [2, 3, 2, 1],
        [5, 3, 2, 1],
      ]
    : [
        [2, 2, 1, 1],
        [6, 2, 1, 1],
      ]
  return `${rects(BODY, PALETTE.mascot)}${rects(eyes, PALETTE.eyes)}`
}

/** La mascotte seule, avec la place de l'accessoire (viewBox « 0 -3 9 9 »). */
export function mascotSvg(kind: MascotKind, size = 27, isAsleep = false): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -3 9 9" width="${size}" height="${size}" shape-rendering="crispEdges">${accessory(kind)}${mascotBody(isAsleep)}</svg>`
}

/** L'avatar d'une carte d'agent : pastille 36×36 aux coins arrondis avec la mascotte dedans. */
export function avatarSvg(kind: MascotKind, isAsleep = false): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36"><rect width="36" height="36" rx="8" fill="${PALETTE.avatar}"/><svg x="4.5" y="4.5" width="27" height="27" viewBox="0 -3 9 9" shape-rendering="crispEdges">${accessory(kind)}${mascotBody(isAsleep)}</svg></svg>`
}

// ── La barre de progression du chat ──────────────────────────────────────

export type BarOptions = {
  title: string
  /** Largeur disponible en pixels : la barre s'y ajuste. */
  width: number
  percent: number
  agents: number
  /** Toutes les étapes sont faites : la mascotte dort. */
  isDone?: boolean
}

type Tier = 'full' | 'compact' | 'tiny'

const tierOf = (width: number): Tier => (width >= 700 ? 'full' : width >= 440 ? 'compact' : 'tiny')

const check = (cx: number, cy: number, color: string) =>
  `<path d="M${num(cx - 4)} ${num(cy)} l2.8 2.8 l5.4 -5.6" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`

/**
 * La barre : toutes les étapes sont visibles dès le départ (fait, en cours, à venir, échoué).
 * Hauteur 44, largeur fluide. Trois niveaux de détail selon la place : complet, compact, minimal.
 */
export function barSvg(stages: readonly BarStage[], o: BarOptions): string {
  const W = Math.max(300, Math.round(o.width))
  const H = 44
  const tier = tierOf(W)
  const n = stages.length
  const active = stages.findIndex(s => s.kind === 'now' || s.kind === 'failed')
  const reached = stages.filter(s => s.kind === 'reached').length
  const isError = stages.some(s => s.kind === 'failed')
  const pctColor = isError ? PALETTE.redText : PALETTE.text

  // Le groupe de droite, aligné sur le bord : réessayer, %, mascotte, ×n, fermer.
  const closeW = 32
  const countW = 24
  const mascotW = 27
  const pctW = 40
  const retryW = isError && tier === 'full' ? 96 : 0
  const closeX = W - closeW
  const countX = closeX - 8 - countW + 2
  const mascotX = countX - 8 - mascotW
  const pctRight = mascotX - 12
  const retryX = pctRight - pctW - 10 - 84

  // Le groupe de gauche : pastille et titre.
  const showTitle = tier !== 'tiny'
  const title = clip(o.title, tier === 'full' ? 30 : 12)
  const titleW = showTitle ? Math.min(title.length * 7.4, tier === 'full' ? 232 : 92) : 0
  const x0 = 16 + 8 + (showTitle ? 8 + titleW : 0) + 14
  const x1 = (retryW > 0 ? retryX : pctRight - pctW + 6) - 12
  const gap = 4
  const usable = Math.max(60, x1 - x0) - gap * (n - 1)
  const weights = stages.map((_, i) => (i === active ? (tier === 'full' ? 1.5 : 3) : 1))
  const sum = weights.reduce((a, b) => a + b, 0)
  const widths = weights.map(w => (usable * w) / sum)
  const xs: number[] = []
  widths.reduce((x, w, i) => {
    xs[i] = x
    return x + w + gap
  }, x0)

  const seg = stages
    .map((s, i) => {
      const x = xs[i]!
      const w = widths[i]!
      const y = 9
      const h = 26
      const cx = x + w / 2
      const base = y + 17
      const showLabel = tier === 'full' || ((tier === 'compact' || tier === 'tiny') && (s.kind === 'now' || s.kind === 'failed'))
      if (s.kind === 'now') {
        const text = tier === 'tiny' ? `${i + 1}/${n}` : `${s.name} ${i + 1}/${n}`
        return `<g><rect x="${num(x - 1)}" y="${y - 1}" width="${num(w + 2)}" height="${h + 2}" rx="8" fill="none" stroke="${PALETTE.silver}"><animate attributeName="stroke-opacity" values=".6;0;.6" dur="1.8s" repeatCount="indefinite"/><animate attributeName="stroke-width" values="1;4;1" dur="1.8s" repeatCount="indefinite"/></rect><rect x="${num(x)}" y="${y}" width="${num(w)}" height="${h}" rx="7" fill="${PALETTE.silver}"/><text x="${num(cx)}" y="${base}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="${PALETTE.onSilver}">${esc(clip(text, Math.max(3, Math.floor(w / 6.3))))}</text></g>`
      }
      if (s.kind === 'failed') {
        const text = tier === 'full' ? `✕ ${s.name} échouée` : '✕'
        return `<g><rect x="${num(x)}" y="${y}" width="${num(w)}" height="${h}" rx="7" fill="${PALETTE.redBg}" stroke="${PALETTE.red}"/><text x="${num(cx)}" y="${base}" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="${PALETTE.redText}">${esc(clip(text, Math.max(2, Math.floor(w / 6.3))))}</text></g>`
      }
      if (s.kind === 'reached') {
        if (!showLabel)
          return `<g><rect x="${num(x)}" y="${y}" width="${num(w)}" height="${h}" rx="7" fill="${PALETTE.segDone}"/>${check(cx, y + h / 2, PALETTE.text2)}</g>`
        const label = clip(s.name, Math.max(3, Math.floor((w - 28) / 6.2)))
        const tw = label.length * 6.1
        return `<g><rect x="${num(x)}" y="${y}" width="${num(w)}" height="${h}" rx="7" fill="${PALETTE.segDone}"/>${check(cx - tw / 2 - 8, y + h / 2, PALETTE.text2)}<text x="${num(cx + 7)}" y="${base}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="500" fill="${PALETTE.text2}">${esc(label)}</text></g>`
      }
      const label = showLabel
        ? `<text x="${num(cx)}" y="${base}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="500" fill="${PALETTE.muted}">${esc(clip(s.name, Math.max(3, Math.floor(w / 6.2))))}</text>`
        : ''
      return `<g><rect x="${num(x + 0.5)}" y="${y + 0.5}" width="${num(w - 1)}" height="${h - 1}" rx="6.5" fill="none" stroke="${PALETTE.dotted}" stroke-dasharray="3 3"/>${label}</g>`
    })
    .join('')

  const left = `<circle cx="20" cy="22" r="4" fill="${PALETTE.text}"/>${
    showTitle
      ? `<text x="36" y="26.5" font-family="${FONT}" font-size="13" font-weight="700" fill="${PALETTE.text}">${esc(title)}</text>`
      : ''
  }`
  const retry =
    retryW > 0
      ? `<g><rect x="${num(retryX)}" y="9" width="84" height="26" rx="13" fill="${PALETTE.bar}" stroke="${PALETTE.border}"/><text x="${num(retryX + 42)}" y="26" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="${PALETTE.text}">Réessayer</text></g>`
      : ''
  const pct = `<text x="${num(pctRight)}" y="26.5" text-anchor="end" font-family="${MONO}" font-size="12" font-weight="700" fill="${pctColor}">${Math.round(o.percent)}%</text>`
  const mascot = `<svg x="${num(mascotX)}" y="13" width="27" height="18" viewBox="0 0 9 6" shape-rendering="crispEdges">${mascotBody(o.isDone === true)}</svg>`
  const count = `<text x="${num(countX)}" y="26" font-family="${MONO}" font-size="11" fill="${PALETTE.muted}">×${o.agents}</text>`
  const close = `<path d="M${closeX + 11} 18 l10 8 M${closeX + 21} 18 l-10 8" fill="none" stroke="${PALETTE.muted}" stroke-width="1.5" stroke-linecap="round"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="22" fill="${PALETTE.bar}" stroke="${isError ? PALETTE.redBorder : PALETTE.border}"/>${left}${seg}${retry}${pct}${mascot}${count}${close}<title>${esc(`${o.title} — ${reached}/${n} étapes, ${Math.round(o.percent)} %`)}</title></svg>`
}

// ── Les cartes d'agent ───────────────────────────────────────────────────

/** Une pastille de modèle : texte coloré, fond à 10 %, bordure à 30 %. */
export function modelPillSvg(text: string, color: string): string {
  const w = Math.round(text.length * 6.9 + 18)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 20" width="${w}" height="20"><rect x=".5" y=".5" width="${w - 1}" height="19" rx="9.5" fill="${color}" fill-opacity=".1" stroke="${color}" stroke-opacity=".3"/><text x="${w / 2}" y="14" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="500" fill="${color}">${esc(text)}</text></svg>`
}

/** Une pastille d'état : « Review · 68 % », « Terminé · 100 % », « Échec · Review ». */
export function statusPillSvg(text: string, tone: 'outline' | 'silver' | 'red'): string {
  const w = Math.round(text.length * 6.7 + 20)
  const fill = tone === 'silver' ? PALETTE.silver : tone === 'red' ? PALETTE.redBg : 'none'
  const stroke = tone === 'silver' ? PALETTE.silver : tone === 'red' ? PALETTE.redBorder : PALETTE.border
  const color = tone === 'silver' ? PALETTE.onSilver : tone === 'red' ? PALETTE.redText : PALETTE.text
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 22" width="${w}" height="22"><rect x=".5" y=".5" width="${w - 1}" height="21" rx="10.5" fill="${fill}" stroke="${stroke}"/><text x="${w / 2}" y="15" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${color}">${esc(text)}</text></svg>`
}

/**
 * La mini-barre d'un agent : 4 segments de 6 px (fait, en cours, à venir) avec leurs libellés dessous.
 * `fraction` remplit le segment en cours selon l'avancement du plan de l'agent.
 */
export function miniBarSvg(stages: readonly BarStage[], width: number, fraction = 0.5): string {
  const W = Math.max(120, Math.round(width))
  const n = stages.length
  const gap = 3
  const segW = (W - gap * (n - 1)) / n
  const bars = stages
    .map((s, i) => {
      const x = i * (segW + gap)
      if (s.kind === 'reached')
        return `<rect x="${num(x)}" y="0" width="${num(segW)}" height="6" rx="3" fill="${PALETTE.miniDone}"/>`
      if (s.kind === 'now' || s.kind === 'failed') {
        const fill = Math.max(0.15, Math.min(1, fraction))
        const bg = s.kind === 'failed' ? PALETTE.redBg : PALETTE.sep
        const fg = s.kind === 'failed' ? PALETTE.red : PALETTE.text
        const pulse =
          s.kind === 'now' ? `<animate attributeName="opacity" values="1;.55;1" dur="1.8s" repeatCount="indefinite"/>` : ''
        return `<rect x="${num(x)}" y="0" width="${num(segW)}" height="6" rx="3" fill="${bg}"/><rect x="${num(x)}" y="0" width="${num(segW * fill)}" height="6" rx="3" fill="${fg}">${pulse}</rect>`
      }
      return `<rect x="${num(x + 0.5)}" y="0.5" width="${num(segW - 1)}" height="5" rx="2.5" fill="none" stroke="${PALETTE.dotted}" stroke-dasharray="2 2"/>`
    })
    .join('')
  const labels = stages
    .map((s, i) => {
      const x = i * (segW + gap)
      const isActive = s.kind === 'now' || s.kind === 'failed'
      const fill = s.kind === 'failed' ? PALETTE.redText : isActive ? PALETTE.text : PALETTE.dim
      return `<text x="${num(x)}" y="20" font-family="${FONT}" font-size="10" font-weight="${isActive ? 700 : 500}" fill="${fill}">${esc(s.name)}</text>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 24" width="${W}" height="24">${bars}${labels}</svg>`
}

// ── Consommation ─────────────────────────────────────────────────────────

/** La couleur d'une jauge selon son niveau : argent, orange dès 80 %, rouge dès 95 %. */
export const gaugeTone = (percent: number) => (percent >= 95 ? 'red' : percent >= 80 ? 'orange' : 'silver')

/** Une jauge horizontale de 4 px. */
export function gaugeSvg(percent: number, width: number): string {
  const p = Math.max(0, Math.min(100, percent))
  const W = Math.max(60, Math.round(width))
  const tone = gaugeTone(p)
  const fill = tone === 'red' ? PALETTE.red : tone === 'orange' ? PALETTE.orange : PALETTE.silver
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 4" width="${W}" height="4"><rect width="${W}" height="4" rx="2" fill="${PALETTE.border}"/><rect width="${num(Math.max(p > 0 ? 3 : 0, (p / 100) * W))}" height="4" rx="2" fill="${fill}"/></svg>`
}

/** Une zone vide en pointillés avec son message (« Aucun fichier modifié pour l'instant. »). */
export function emptySvg(text: string, width: number): string {
  const W = Math.max(120, Math.round(width))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 44" width="${W}" height="44"><rect x=".5" y=".5" width="${W - 1}" height="43" rx="10" fill="none" stroke="${PALETTE.dotted}" stroke-dasharray="4 4"/><text x="${W / 2}" y="26" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${PALETTE.muted}">${esc(text)}</text></svg>`
}

// ── Les blocs du panneau latéral ─────────────────────────────────────────

const iconFolder = (x: number, y: number) =>
  `<path d="M${x} ${y + 2.5}a1.5 1.5 0 0 1 1.5-1.5h2.2l1.2 1.4h3.6a1.5 1.5 0 0 1 1.5 1.5v5.6a1.5 1.5 0 0 1-1.5 1.5h-7a1.5 1.5 0 0 1-1.5-1.5z" fill="none" stroke="${PALETTE.muted}" stroke-width="1.2" stroke-linejoin="round"/>`
const iconBranch = (x: number, y: number) =>
  `<g fill="none" stroke="${PALETTE.muted}" stroke-width="1.2" stroke-linecap="round"><circle cx="${x + 2.5}" cy="${y + 2.5}" r="1.5"/><circle cx="${x + 2.5}" cy="${y + 10.5}" r="1.5"/><circle cx="${x + 9.5}" cy="${y + 4.5}" r="1.5"/><path d="M${x + 2.5} ${y + 4}v5M${x + 9.5} ${y + 6}c0 3-7 1.5-7 3.5"/></g>`

/** L'en-tête : « FEATURE DEMANDÉE », le titre, le projet et la branche. La pastille d'état est ajoutée par la vue. */
export function headerSvg(o: { title: string; project: string; branch: string; width: number }): string {
  const W = Math.max(200, Math.round(o.width))
  const title = clip(o.title || 'En attente d’une demande', Math.floor((W - 8) / 8.6))
  const project = clip(o.project, 18)
  const branch = clip(o.branch, Math.max(8, Math.floor((W - 40 - project.length * 7.4) / 7.4)))
  const bx = 22 + project.length * 7.4 + 22
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 62" width="${W}" height="62"><text x="0" y="11" font-family="${FONT}" font-size="11" font-weight="600" letter-spacing=".7" fill="${PALETTE.muted}">FEATURE DEMANDÉE</text><text x="0" y="38" font-family="${FONT}" font-size="16" font-weight="600" fill="${PALETTE.text}">${esc(title)}</text>${
    o.project
      ? `${iconFolder(0, 46)}<text x="20" y="57" font-family="${MONO}" font-size="12" fill="${PALETTE.text2}">${esc(project)}</text>`
      : ''
  }${
    o.branch
      ? `${iconBranch(bx - 18, 46)}<text x="${num(bx)}" y="57" font-family="${MONO}" font-size="12" fill="${PALETTE.text2}">${esc(branch)}</text>`
      : ''
  }</svg>`
}

/** L'intitulé d'une section : « AGENTS » à gauche, « 3 · 2 actifs » à droite. */
export function sectionSvg(left: string, right: string, width: number): string {
  const W = Math.max(160, Math.round(width))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 16" width="${W}" height="16"><text x="0" y="12" font-family="${FONT}" font-size="11" font-weight="600" letter-spacing=".7" fill="${PALETTE.muted}">${esc(left)}</text>${
    right
      ? `<text x="${W}" y="12" text-anchor="end" font-family="${MONO}" font-size="11" fill="${PALETTE.muted}">${esc(right)}</text>`
      : ''
  }</svg>`
}

/** Un trait fin de séparation. */
export function ruleSvg(width: number): string {
  const W = Math.max(40, Math.round(width))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 1" width="${W}" height="1"><rect width="${W}" height="1" fill="${PALETTE.sep}"/></svg>`
}

export type AgentHead = {
  name: string
  kind: MascotKind
  modelLabel: string
  modelColor: string
  /** « Actif », « En attente », « Terminé », « Échec ». */
  status: string
  tone: 'live' | 'wait' | 'done' | 'fail'
  width: number
}

/** La tête d'une carte d'agent : avatar, nom, pastille du modèle, état à droite. */
export function agentHeadSvg(o: AgentHead): string {
  const W = Math.max(220, Math.round(o.width))
  const reserve = 46 + Math.round(o.modelLabel.length * 6.9 + 18) + 8 + o.status.length * 6.2 + 28
  const name = clip(o.name, Math.max(6, Math.floor((W - reserve) / 7.4)))
  const nameW = name.length * 7.4
  const pillW = Math.round(o.modelLabel.length * 6.9 + 18)
  const px = 46 + nameW + 8
  const dot = o.tone === 'live' ? PALETTE.live : o.tone === 'fail' ? PALETTE.red : o.tone === 'done' ? PALETTE.muted : 'none'
  const color = o.tone === 'fail' ? PALETTE.redText : o.tone === 'live' ? PALETTE.live : PALETTE.muted
  const mx = W - 4 - o.status.length * 6.2 - 12
  const marker =
    o.tone === 'wait'
      ? `<circle cx="${num(mx)}" cy="18" r="3" fill="none" stroke="${PALETTE.muted}" stroke-width="1.3"/>`
      : `<circle cx="${num(mx)}" cy="18" r="3" fill="${dot}">${o.tone === 'live' ? `<animate attributeName="opacity" values="1;.4;1" dur="1.8s" repeatCount="indefinite"/>` : ''}</circle>`
  const avatar = avatarSvg(o.kind, o.tone === 'done').replace('<svg ', '<svg x="0" y="0" ')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 36" width="${W}" height="36">${avatar}<text x="46" y="23" font-family="${FONT}" font-size="13" font-weight="600" fill="${PALETTE.text}">${esc(name)}</text><svg x="${num(px)}" y="8" width="${pillW}" height="20" viewBox="0 0 ${pillW} 20"><rect x=".5" y=".5" width="${pillW - 1}" height="19" rx="9.5" fill="${o.modelColor}" fill-opacity=".1" stroke="${o.modelColor}" stroke-opacity=".3"/><text x="${pillW / 2}" y="14" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="500" fill="${o.modelColor}">${esc(o.modelLabel)}</text></svg>${marker}<text x="${W - 4}" y="22" text-anchor="end" font-family="${FONT}" font-size="11.5" fill="${color}">${esc(o.status)}</text></svg>`
}

/** La ligne « ● 212k tokens · 1,86 € » à droite de la mini-barre (avec son point d'activité). */
export function usageSvg(text: string, isLive: boolean, width: number): string {
  const W = Math.max(80, Math.round(width))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 24" width="${W}" height="24"><circle cx="5" cy="7" r="2.5" fill="${isLive ? PALETTE.text : PALETTE.muted}">${isLive ? `<animate attributeName="opacity" values="1;.35;1" dur="1.2s" repeatCount="indefinite"/>` : ''}</circle><text x="14" y="10.5" font-family="${MONO}" font-size="11.5" fill="${PALETTE.text2}">${esc(clip(text, Math.floor((W - 16) / 6.9)))}</text></svg>`
}

/** Une ligne de consommation : libellé, total, pourcentage, et la jauge dessous. */
export function usageRowSvg(o: {
  label: string
  value: string
  note: string
  percent: number | undefined
  width: number
}): string {
  const W = Math.max(160, Math.round(o.width))
  const p = o.percent ?? 0
  const tone = gaugeTone(p)
  const fill = tone === 'red' ? PALETTE.red : tone === 'orange' ? PALETTE.orange : PALETTE.silver
  const color = tone === 'red' ? PALETTE.redText : tone === 'orange' ? PALETTE.orange : PALETTE.text
  const warn = tone !== 'silver' ? '▲ ' : ''
  const right = `${warn}${o.value}${o.note ? ` · ${o.note}` : ''}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 30" width="${W}" height="30"><text x="0" y="12" font-family="${FONT}" font-size="12.5" font-weight="600" fill="${PALETTE.text}">${esc(o.label)}</text><text x="${W}" y="12" text-anchor="end" font-family="${MONO}" font-size="12" fill="${color}">${esc(right)}</text><rect x="0" y="22" width="${W}" height="4" rx="2" fill="${PALETTE.border}"/><rect x="0" y="22" width="${num(Math.max(o.percent ? 3 : 0, (p / 100) * W))}" height="4" rx="2" fill="${fill}"/></svg>`
}

/** Un fichier modifié : son chemin en mono, et dessous la phrase qui résume la modification. */
export function fileRowSvg(o: { path: string; summary: string; count: number; width: number }): string {
  const W = Math.max(200, Math.round(o.width))
  const room = Math.max(8, Math.floor((W - 40) / 7.2))
  const path = o.path.length > room ? `…${o.path.slice(-(room - 1))}` : o.path
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 38" width="${W}" height="38"><text x="0" y="14" font-family="${MONO}" font-size="12" fill="${PALETTE.text}">${esc(path)}</text>${
    o.count > 1
      ? `<text x="${W}" y="14" text-anchor="end" font-family="${MONO}" font-size="11" fill="${PALETTE.muted}">×${o.count}</text>`
      : ''
  }<text x="0" y="31" font-family="${FONT}" font-size="12" fill="${PALETTE.muted}">${esc(clip(o.summary, Math.floor(W / 6.1)))}</text></svg>`
}

// ── La barre d'un agent : un segment par étape de SA tâche ───────────────

/**
 * La barre d'un agent : un segment par étape de sa tâche (son plan), avec dessous le titre de l'étape en cours
 * et « faites/total ». Sans étape connue, une barre unique : pleine quand il a fini, animée tant qu'il travaille.
 */
export function planBarSvg(
  segs: readonly BarStage[],
  width: number,
  o: { label: string; count: string; isRunning: boolean; isDone: boolean; color?: string },
): string {
  const W = Math.max(120, Math.round(width))
  // La couleur de l'agent : faite en plein, en cours en pulsation, à venir en pointillé teinté.
  const tint = o.color ?? PALETTE.text
  const doneFill = o.color ?? PALETTE.miniDone
  const n = segs.length
  const gap = 3
  const segW = n > 0 ? (W - gap * (n - 1)) / n : W
  const failed = segs.some(s => s.kind === 'failed')
  const bars =
    n === 0
      ? o.isDone
        ? `<rect width="${W}" height="6" rx="3" fill="${doneFill}"/>`
        : `<rect width="${W}" height="6" rx="3" fill="${PALETTE.sep}"/>${
            o.isRunning
              ? `<rect width="${num(W * 0.28)}" height="6" rx="3" fill="${tint}"><animate attributeName="x" values="0;${num(W * 0.72)};0" dur="2.4s" repeatCount="indefinite"/></rect>`
              : ''
          }`
      : segs
          .map((s, i) => {
            const x = i * (segW + gap)
            if (s.kind === 'reached')
              return `<rect x="${num(x)}" y="0" width="${num(segW)}" height="6" rx="3" fill="${doneFill}"/>`
            if (s.kind === 'now')
              return `<rect x="${num(x)}" y="0" width="${num(segW)}" height="6" rx="3" fill="${tint}"><animate attributeName="opacity" values="1;.5;1" dur="1.8s" repeatCount="indefinite"/></rect>`
            if (s.kind === 'failed')
              return `<rect x="${num(x)}" y="0" width="${num(segW)}" height="6" rx="3" fill="${PALETTE.red}"/>`
            return `<rect x="${num(x + 0.5)}" y="0.5" width="${num(segW - 1)}" height="5" rx="2.5" fill="none" stroke="${o.color ?? PALETTE.dotted}" stroke-opacity="${o.color ? 0.45 : 1}" stroke-dasharray="2 2"/>`
          })
          .join('')
  const countW = o.count.length * 6.6 + 4
  const label = clip(o.label, Math.max(6, Math.floor((W - countW - 8) / 5.9)))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 24" width="${W}" height="24">${bars}<text x="0" y="20" font-family="${FONT}" font-size="10.5" font-weight="600" fill="${failed ? PALETTE.redText : PALETTE.text}">${esc(label)}</text><text x="${W}" y="20" text-anchor="end" font-family="${MONO}" font-size="10.5" fill="${PALETTE.muted}">${esc(o.count)}</text></svg>`
}
