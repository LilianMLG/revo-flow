import { describe, expect, test } from 'claude-code/testing'

import { catalogue, catalogueBrief, parseFrontmatter, trouveAgent } from '../../hooks/agents/catalogue'
import type { AgentDef, CatalogueIo } from '../../types/agents'
import { OSES, diskKey, native, type Os } from '../helpers/os'

// ── Un disque en mémoire : les chemins sont rangés sous diskKey, quelle que soit leur forme ──

type Disk = Map<string, string>

function ioOf(files: Record<string, string>, os: Os, over: Partial<CatalogueIo> = {}): CatalogueIo {
  const disk: Disk = new Map(Object.entries(files).map(([p, t]) => [diskKey(p), t]))
  return {
    read: async p => {
      const t = disk.get(diskKey(p))
      if (t === undefined) throw new Error('ENOENT')
      return t
    },
    list: async p => {
      const d = diskKey(p)
      const seen = new Map<string, string>()
      for (const k of disk.keys()) {
        if (!k.startsWith(d + '/')) continue
        const rest = k.slice(d.length + 1)
        seen.set(rest.split('/')[0]!, rest.includes('/') ? 'dir' : 'file')
      }
      if (seen.size === 0) throw new Error('ENOENT')
      return [...seen].map(([name, kind]) => ({ name, kind }))
    },
    exists: async p => disk.has(diskKey(p)),
    home: async () => os.home,
    ...over,
  }
}

const md = (front: Record<string, string>, body = 'Corps.') => `---\n${Object.entries(front).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`

const rootOf = (os: Os) => native(os, 'Documents', 'Front', 'app')
const claude = (os: Os, ...parts: string[]) => native(os, '.claude', ...parts)
const installPath = (os: Os, plugin: string) => native(os, '.claude', 'plugins', 'cache', 'kit', plugin, '1.0.0')

/** installed_plugins.json au format v2 ; les chemins sont ceux de l'hôte (antislashs échappés par JSON.stringify sous Windows). */
const installed = (os: Os, plugins: string[]) =>
  JSON.stringify({ version: 2, plugins: Object.fromEntries(plugins.map(p => [`${p}@kit`, [{ scope: 'user', installPath: installPath(os, p), version: '1.0.0' }]])) })

for (const os of OSES) describe(`catalogue (${os.nom})`, () => {
  const root = rootOf(os)

  test('source projet : type = name, chemin à « / »', async () => {
    const io = ioOf({ [`${root}/.claude/agents/front.md`.replace(/\//g, os.sep)]: md({ name: 'front-dev', description: 'Code Vue', model: 'sonnet', effort: 'medium' }) }, os)
    const defs = await catalogue(io, root)
    expect(defs).toHaveLength(1)
    expect(defs[0]).toMatchObject({ type: 'front-dev', nom: 'front-dev', description: 'Code Vue', source: 'projet', model: 'sonnet', effort: 'medium', outils: [] })
    expect(defs[0]!.chemin).not.toContain('\\')
    expect(defs[0]!.chemin.endsWith('/.claude/agents/front.md')).toBe(true)
  })

  test('source utilisateur : dossier personnel', async () => {
    const io = ioOf({ [claude(os, 'agents', 'perso.md')]: md({ name: 'perso', description: 'Mon agent' }) }, os)
    const defs = await catalogue(io, root)
    expect(defs.map(d => [d.type, d.source])).toEqual([['perso', 'utilisateur']])
  })

  test('source plugin : type plugin:nom, plugin = partie avant @', async () => {
    const io = ioOf(
      {
        [claude(os, 'plugins', 'installed_plugins.json')]: installed(os, ['savvy-flow']),
        [`${installPath(os, 'savvy-flow')}${os.sep}agents${os.sep}light.md`]: md({ name: 'savvy-light', description: 'Mécanique', model: 'opus', effort: 'low' }),
      },
      os,
    )
    const defs = await catalogue(io, root)
    expect(defs).toHaveLength(1)
    expect(defs[0]).toMatchObject({ type: 'savvy-flow:savvy-light', nom: 'savvy-light', source: 'plugin', plugin: 'savvy-flow', model: 'opus', effort: 'low' })
  })

  test('plugin désactivé exclu, activé gardé, settings illisible = tout activé', async () => {
    const files = {
      [claude(os, 'plugins', 'installed_plugins.json')]: installed(os, ['a', 'b']),
      [`${installPath(os, 'a')}/agents/x.md`]: md({ name: 'x' }),
      [`${installPath(os, 'b')}/agents/y.md`]: md({ name: 'y' }),
    }
    const off = ioOf({ ...files, [claude(os, 'settings.json')]: JSON.stringify({ enabledPlugins: { 'a@kit': false, 'b@kit': true } }) }, os)
    expect((await catalogue(off, root)).map(d => d.type)).toEqual(['b:y'])
    const broken = ioOf({ ...files, [claude(os, 'settings.json')]: '{ pas du json' }, os)
    expect((await catalogue(broken, root)).map(d => d.type)).toEqual(['a:x', 'b:y'])
    expect((await catalogue(ioOf(files, os), root)).map(d => d.type)).toEqual(['a:x', 'b:y'])
  })

  test('les agents du plugin revo-flow sont exclus', async () => {
    const io = ioOf(
      {
        [claude(os, 'plugins', 'installed_plugins.json')]: installed(os, ['revo-flow', 'autre']),
        [`${installPath(os, 'revo-flow')}/agents/verifier.md`]: md({ name: 'verifier' }),
        [`${installPath(os, 'autre')}/agents/z.md`]: md({ name: 'z' }),
      },
      os,
    )
    expect((await catalogue(io, root)).map(d => d.type)).toEqual(['autre:z'])
  })

  test('plugin.json déclare des agents en plus du dossier agents/ (chaîne, liste, dossier ou fichier, dédoublonné)', async () => {
    const ip = installPath(os, 'p')
    const io = ioOf(
      {
        [claude(os, 'plugins', 'installed_plugins.json')]: installed(os, ['p']),
        [`${ip}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'p', agents: ['./extra', './solo/one.md', './agents/base.md'] }),
        [`${ip}/agents/base.md`]: md({ name: 'base' }),
        [`${ip}/extra/e1.md`]: md({ name: 'e1' }),
        [`${ip}/solo/one.md`]: md({ name: 'one' }),
      },
      os,
    )
    expect((await catalogue(io, root)).map(d => d.type)).toEqual(['p:base', 'p:e1', 'p:one'])
    const str = ioOf(
      {
        [claude(os, 'plugins', 'installed_plugins.json')]: installed(os, ['p']),
        [`${ip}/.claude-plugin/plugin.json`]: JSON.stringify({ agents: './extra' }),
        [`${ip}/extra/e1.md`]: md({ name: 'e1' }),
      },
      os,
    )
    expect((await catalogue(str, root)).map(d => d.type)).toEqual(['p:e1'])
  })

  test('sans name : le nom du fichier ; sans description : gardé avec une description vide', async () => {
    const io = ioOf({ [`${root}/.claude/agents/sans-nom.md`]: '---\nmodel: haiku\n---\nTexte', [`${root}/.claude/agents/nu.md`]: 'Pas de frontmatter' }, os)
    const defs = await catalogue(io, root)
    expect(defs.map(d => [d.type, d.description, d.model])).toEqual([
      ['nu', '', undefined],
      ['sans-nom', '', 'haiku'],
    ])
  })

  test('ordre : projet, utilisateur, plugins par nom ; premier gagnant par type', async () => {
    const io = ioOf(
      {
        [`${root}/.claude/agents/dup.md`]: md({ name: 'dup', description: 'projet' }),
        [claude(os, 'agents', 'dup.md')]: md({ name: 'dup', description: 'perso' }),
        [claude(os, 'agents', 'autre.md')]: md({ name: 'autre' }),
        [claude(os, 'plugins', 'installed_plugins.json')]: installed(os, ['zeta', 'alpha']),
        [`${installPath(os, 'zeta')}/agents/a.md`]: md({ name: 'a' }),
        [`${installPath(os, 'alpha')}/agents/b.md`]: md({ name: 'b' }),
        [`${installPath(os, 'alpha')}/agents/a.md`]: md({ name: 'a' }),
      },
      os,
    )
    const defs = await catalogue(io, root)
    expect(defs.map(d => d.type)).toEqual(['dup', 'autre', 'alpha:a', 'alpha:b', 'zeta:a'])
    expect(defs[0]!.description).toBe('projet')
  })

  test('installed_plugins absent, JSON cassé ou home introuvable : pas d\'erreur', async () => {
    const perso = { [claude(os, 'agents', 'p.md')]: md({ name: 'p' }) }
    expect((await catalogue(ioOf(perso, os), root)).map(d => d.type)).toEqual(['p'])
    const cassé = ioOf({ ...perso, [claude(os, 'plugins', 'installed_plugins.json')]: 'pas du json' }, os)
    expect((await catalogue(cassé, root)).map(d => d.type)).toEqual(['p'])
    expect(await catalogue(ioOf({}, os, { home: async () => undefined }), root)).toEqual([])
    expect(await catalogue(ioOf({}, os, { home: async () => { throw new Error('boom') } }), root)).toEqual([])
    const tout: CatalogueIo = { read: async () => { throw new Error('x') }, list: async () => { throw new Error('x') }, exists: async () => false, home: async () => os.home }
    expect(await catalogue(tout, root)).toEqual([])
  })
})

describe('parseFrontmatter', () => {
  test('tools en chaîne, en liste inline et en lignes « - A »', () => {
    expect(parseFrontmatter('---\ntools: Read, Grep,Bash\n---\n').tools).toEqual(['Read', 'Grep', 'Bash'])
    expect(parseFrontmatter('---\ntools: [Read, "Grep"]\n---\n').tools).toEqual(['Read', 'Grep'])
    expect(parseFrontmatter('---\nname: x\ntools:\n  - Read\n  - Edit\nmodel: opus\n---\n')).toMatchObject({ name: 'x', tools: ['Read', 'Edit'], model: 'opus' })
    expect(parseFrontmatter('---\ntools:\n- Read\n- Edit\n---\n').tools).toEqual(['Read', 'Edit'])
    expect(parseFrontmatter('---\nname: x\n---\n').tools).toEqual([])
  })

  test('CRLF, guillemets, description en bloc', () => {
    const f = parseFrontmatter('﻿---\r\nname: "a"\r\ndescription: >\r\n  Première ligne\r\n  seconde\r\n---\r\ncorps')
    expect(f).toMatchObject({ name: 'a', description: 'Première ligne seconde' })
  })

  test('pas de frontmatter ou non fermé : vide', () => {
    expect(parseFrontmatter('juste du texte')).toEqual({ tools: [] })
    expect(parseFrontmatter('---\nname: x\nsans fin')).toEqual({ tools: [] })
  })

  test('les outils arrivent dans AgentDef.outils', async () => {
    const os = OSES[1]!
    const io = ioOf({ [`${rootOf(os)}/.claude/agents/t.md`]: md({ name: 't', tools: 'Read, Grep' }) }, os)
    expect((await catalogue(io, rootOf(os)))[0]!.outils).toEqual(['Read', 'Grep'])
  })
})

const def = (over: Partial<AgentDef> = {}): AgentDef => ({ type: 'a', nom: 'a', description: 'Fait A', source: 'projet', outils: [], chemin: '/x/a.md', ...over })

describe('catalogueBrief', () => {
  test('vide quand aucun agent', () => {
    expect(catalogueBrief([])).toBe('')
  })

  test('un agent : titre, consigne, ligne avec modèle et effort', () => {
    const t = catalogueBrief([def({ type: 'savvy-flow:light', source: 'plugin', plugin: 'savvy-flow', model: 'opus', effort: 'low', description: 'Mécanique' })])
    expect(t.split('\n')[0]).toBe('# Agents installés sur ce Claude Code (catalogue revo-flow)')
    expect(t).toContain('donne son type dans « type »')
    expect(t).toContain('Sinon, general-purpose comme d\'habitude.')
    expect(t).toContain('- `savvy-flow:light` (plugin ; opus, low) : Mécanique')
  })

  test('sans modèle ni effort, ou avec le seul modèle ; description coupée à 180', () => {
    const t = catalogueBrief([def(), def({ type: 'b', model: 'haiku' }), def({ type: 'c', description: 'x'.repeat(400) })])
    expect(t).toContain('- `a` (projet) : Fait A')
    expect(t).toContain('- `b` (projet ; haiku) : Fait A')
    const ligne = t.split('\n').find(l => l.startsWith('- `c`'))!
    expect(ligne.slice(ligne.indexOf(' : ') + 3).length).toBe(180)
  })

  test('au plus 30 agents puis « … et N autres »', () => {
    const defs = Array.from({ length: 33 }, (_, i) => def({ type: `a${i}` }))
    const t = catalogueBrief(defs)
    expect(t.split('\n').filter(l => l.startsWith('- `'))).toHaveLength(30)
    expect(t).toContain('- `a29`')
    expect(t).not.toContain('- `a30`')
    expect(t.endsWith('… et 3 autres')).toBe(true)
  })
})

describe('trouveAgent', () => {
  const defs = [def({ type: 'savvy-flow:Savvy-Light' }), def({ type: 'front' })]
  test('type exact, insensible à la casse', () => {
    expect(trouveAgent(defs, 'SAVVY-FLOW:savvy-light')?.type).toBe('savvy-flow:Savvy-Light')
    expect(trouveAgent(defs, 'front')?.type).toBe('front')
  })
  test('inconnu ou partiel : undefined', () => {
    expect(trouveAgent(defs, 'savvy-light')).toBeUndefined()
    expect(trouveAgent([], 'front')).toBeUndefined()
  })
})
