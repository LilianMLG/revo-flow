// Découverte des agents installés sur le Claude Code de l'utilisateur : projet, dossier personnel, plugins.
// Module PUR : aucun accès à `$`, tout le disque passe par CatalogueIo (sous-ensemble de Io, voir hooks/cache/store.ts).
// Rien ne lève : toute erreur d'accès rend une source vide.
import type { AgentDef, CatalogueIo } from '../../types/agents'
import { normalizePath } from '../cache/store'

/** Le plugin du mod lui-même : ses agents (revo-flow:*) ne sont jamais proposés. */
const PLUGIN_SELF = 'revo-flow'
/** Au plus tant d'agents dans le brief, et la longueur max d'une description dans le brief. */
const BRIEF_MAX = 30
const DESC_MAX = 180

// ── Frontmatter ──────────────────────────────────────────────────────────

type Front = { name?: string; description?: string; model?: string; effort?: string; tools: string[] }

const unquote = (s: string) => {
  const t = s.trim()
  return t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) ? t.slice(1, -1) : t
}

/** « A, B », « [A, B] » ou lignes « - A » → liste sans vides. */
function toList(inline: string, lines: string[]): string[] {
  const items = lines.filter(l => /^\s*-\s/.test(l) || /^\s*-$/.test(l)).map(l => l.replace(/^\s*-\s?/, ''))
  const raw = items.length > 0 ? items : [inline.trim().replace(/^\[/, '').replace(/\]$/, '')]
  return raw
    .flatMap(r => (items.length > 0 ? [r] : r.split(',')))
    .map(unquote)
    .filter(s => s !== '')
}

/** Le frontmatter `---` … `---` d'un .md ; absent ou mal fermé = vide. Parse minimal : pas de YAML complet. */
export function parseFrontmatter(text: string): Front {
  const res: Front = { tools: [] }
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return res
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return res
  const body = lines.slice(1, end)
  for (let i = 0; i < body.length; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(body[i]!)
    if (!m) continue
    // Les lignes suivantes qui appartiennent à cette clé : indentées, ou « - x » collé à la marge.
    const rest: string[] = []
    while (i + 1 < body.length && (/^\s+\S/.test(body[i + 1]!) || /^-(\s|$)/.test(body[i + 1]!))) rest.push(body[++i]!)
    const key = m[1]!.toLowerCase()
    const inline = m[2]!.trim()
    if (key === 'tools') {
      res.tools = toList(inline, rest)
      continue
    }
    if (key !== 'name' && key !== 'description' && key !== 'model' && key !== 'effort') continue
    const block = /^[>|][+-]?$/.test(inline) || inline === ''
    const value = (block ? rest.map(l => l.trim()).join(' ') : unquote(inline)).replace(/\s+/g, ' ').trim()
    if (value !== '') res[key] = value
  }
  return res
}

// ── Lecture du disque ────────────────────────────────────────────────────

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const safe = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await f()
  } catch {
    return fallback
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Les .md d'un dossier (hors sous-dossiers), triés par nom ; dossier absent ou illisible = aucun. */
async function listMd(io: CatalogueIo, dir: string): Promise<string[]> {
  const entries = await safe(() => io.list(dir), [])
  return entries
    .filter(e => e.kind !== 'dir' && e.name.toLowerCase().endsWith('.md'))
    .map(e => e.name)
    .sort()
    .map(n => `${dir}/${n}`)
}

/** Lit un .md d'agent. Le type et la source sont posés par l'appelant. */
async function readAgent(io: CatalogueIo, chemin: string): Promise<Omit<AgentDef, 'type' | 'source' | 'plugin'> | undefined> {
  const text = await safe(() => io.read(chemin), undefined)
  if (text === undefined) return undefined
  const f = parseFrontmatter(text)
  const file = chemin.slice(chemin.lastIndexOf('/') + 1).replace(/\.md$/i, '')
  const def: Omit<AgentDef, 'type' | 'source' | 'plugin'> = { nom: f.name ?? file, description: f.description ?? '', outils: f.tools, chemin }
  if (f.model) def.model = f.model
  if (f.effort) def.effort = f.effort
  return def
}

type Lu = NonNullable<Awaited<ReturnType<typeof readAgent>>>

async function readAll(io: CatalogueIo, chemins: string[]): Promise<Lu[]> {
  return (await Promise.all(chemins.map(c => readAgent(io, c)))).filter((d): d is Lu => d !== undefined)
}

/** Les agents d'un dossier de source projet ou utilisateur. */
async function fromDir(io: CatalogueIo, dir: string, source: 'projet' | 'utilisateur'): Promise<AgentDef[]> {
  return (await readAll(io, await listMd(io, dir))).map(d => ({ ...d, type: d.nom, source }))
}

/** Les chemins que déclare `agents` dans .claude-plugin/plugin.json : chaîne ou liste, fichiers .md ou dossiers. */
async function manifestPaths(io: CatalogueIo, installPath: string): Promise<string[]> {
  const manifest = parseJson(await safe(() => io.read(`${installPath}/.claude-plugin/plugin.json`), ''))
  const decl = isObject(manifest) ? manifest.agents : undefined
  const rels = (typeof decl === 'string' ? [decl] : Array.isArray(decl) ? decl : []).filter((r): r is string => typeof r === 'string' && r.trim() !== '')
  const res: string[] = []
  for (const rel of rels) {
    const p = `${installPath}/${normalizePath(rel).replace(/^\/+/, '')}`
    if (/\.md$/i.test(p)) res.push(p)
    else res.push(...(await listMd(io, normalizePath(p))))
  }
  return res
}

/** Les agents d'un plugin installé : dossier agents/ par défaut, plus ce que déclare son plugin.json (dédoublonné par chemin). */
async function fromPlugin(io: CatalogueIo, plugin: string, installPath: string): Promise<AgentDef[]> {
  const chemins = [...new Set([...(await listMd(io, `${installPath}/agents`)), ...(await manifestPaths(io, installPath))])]
  return (await readAll(io, chemins)).map(d => ({ ...d, type: `${plugin}:${d.nom}`, source: 'plugin' as const, plugin }))
}

/** Les plugins installés { nom, installPath } : la première entrée de chacun, ceux désactivés dans settings.json exclus. */
async function installedPlugins(io: CatalogueIo, home: string): Promise<{ plugin: string; installPath: string }[]> {
  const installed = parseJson(await safe(() => io.read(`${home}/.claude/plugins/installed_plugins.json`), ''))
  const plugins = isObject(installed) && isObject(installed.plugins) ? installed.plugins : {}
  const settings = parseJson(await safe(() => io.read(`${home}/.claude/settings.json`), ''))
  const enabled = isObject(settings) && isObject(settings.enabledPlugins) ? settings.enabledPlugins : {}
  const res: { plugin: string; installPath: string }[] = []
  for (const [key, entries] of Object.entries(plugins)) {
    if (enabled[key] === false) continue
    const first: unknown = Array.isArray(entries) ? entries[0] : undefined
    const installPath = isObject(first) && typeof first.installPath === 'string' ? normalizePath(first.installPath) : ''
    const at = key.indexOf('@')
    const plugin = at < 0 ? key : key.slice(0, at)
    if (installPath === '' || plugin === '' || plugin === PLUGIN_SELF) continue
    res.push({ plugin, installPath })
  }
  return res.sort((a, b) => cmp(a.plugin, b.plugin))
}

/** Les agents installés : projet, dossier personnel, puis plugins (par plugin puis par agent). Premier par type gagnant. Ne lève jamais. */
export async function catalogue(io: CatalogueIo, root: string): Promise<AgentDef[]> {
  const home = await safe(() => io.home(), undefined)
  const h = home ? normalizePath(home) : undefined
  const projet = await safe(() => fromDir(io, `${normalizePath(root)}/.claude/agents`, 'projet'), [])
  const utilisateur = h ? await safe(() => fromDir(io, `${h}/.claude/agents`, 'utilisateur'), []) : []
  const parPlugin = h
    ? await Promise.all((await safe(() => installedPlugins(io, h), [])).map(p => safe(() => fromPlugin(io, p.plugin, p.installPath), [])))
    : []
  // Les plugins sont déjà triés par nom : on ne trie que les agents de chacun.
  const plugins = parPlugin.flatMap(l => l.sort((a, b) => cmp(a.nom, b.nom)))
  const seen = new Set<string>()
  const res: AgentDef[] = []
  for (const d of [...projet, ...utilisateur, ...plugins]) {
    const k = d.type.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    res.push(d)
  }
  return res
}

// ── Brief et recherche ───────────────────────────────────────────────────

const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t
}

/** Le bloc que l'orchestrateur lit pour proposer ces agents dans son plan ; vide si aucun agent. */
export function catalogueBrief(defs: AgentDef[]): string {
  if (defs.length === 0) return ''
  const lines = defs.slice(0, BRIEF_MAX).map(d => {
    const decl = [d.model, d.effort].filter(Boolean).join(', ')
    const desc = cut(d.description, DESC_MAX)
    return `- \`${d.type}\` (${d.source}${decl ? ` ; ${decl}` : ''})${desc ? ` : ${desc}` : ''}`
  })
  if (defs.length > BRIEF_MAX) lines.push(`… et ${defs.length - BRIEF_MAX} autres`)
  return [
    '# Agents installés sur ce Claude Code (catalogue revo-flow)',
    '',
    'Pour un sous-agent du plan dont le rôle correspond à l\'un d\'eux (code, doc, test, revue…), donne son type dans « type » ; revo-flow lui laisse le modèle et l\'effort de sa définition. Sinon, general-purpose comme d\'habitude.',
    '',
    ...lines,
  ].join('\n')
}

/** L'agent de ce type exact, sans tenir compte de la casse. */
export function trouveAgent(defs: AgentDef[], type: string): AgentDef | undefined {
  const t = type.trim().toLowerCase()
  return defs.find(d => d.type.toLowerCase() === t)
}
