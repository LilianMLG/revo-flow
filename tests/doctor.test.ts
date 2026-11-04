import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { doctorText, manifestsOf, pluginVersion, versionText, type DoctorInput } from '../hooks/doctor'
import { detectCommands } from '../hooks/verif/detect'
import { computeStats } from '../hooks/cache/graph'
import type { AgentDef } from '../types/agents'
import type { Graph } from '../types/cache'
import type { MobileDispo } from '../hooks/verif/mobile'
import type { WebDispo } from '../hooks/verif/web'
import type { ProjetVerif, VerifCommande } from '../types/verif'
import { OSES, diskKey, native, type Os } from './helpers/os'

const json = (x: unknown) => JSON.stringify(x)
const lines = (t: string) => t.split('\n')
const find = (t: string, titre: string) => lines(t).find(l => l.startsWith(titre))

// ── Un projet Nuxt 3 + Vitest, comme reservation-tool ────────────────────

const PKG = json({
  scripts: { lint: 'eslint --ext .ts,.js,.vue .', typecheck: 'nuxi typecheck', test: 'vitest' },
  devDependencies: { nuxt: '^3.9.0', vitest: '^1.6.0', eslint: '^8.57.0', typescript: '^5.4.0', '@vitest/coverage-v8': '^1.6.0' },
})
const CI = ['lint:', '  stage: test', '  script:', '    - npm ci', '    - npm run lint', '    - npm run typecheck'].join('\n')
const FILES = ['nuxt.config.ts', '.eslintrc.cjs', 'components/Cart.vue', 'composables/useCart.ts', 'tests/useCart.spec.ts']
const READ = { 'package.json': PKG, '.gitlab-ci.yml': CI }
const STACK = 'Nuxt 3, Pinia, TypeScript, vitest'

const detected = (crap = true) => detectCommands({ stack: STACK, files: FILES, read: READ, crap })

const agent = (type: string, source: AgentDef['source'], plugin?: string): AgentDef => ({
  type,
  nom: type.split(':').pop()!,
  description: 'x',
  source,
  ...(plugin ? { plugin } : {}),
  outils: [],
  chemin: `/a/${type}.md`,
})
const SAVVY = ['careful', 'fable', 'heavy', 'light', 'medium'].map(n => agent(`savvy-flow:savvy-${n}`, 'plugin', 'savvy-flow'))

/** Un graphe minimal : 212 fichiers, 9 fiches, 14 flows au journal. */
const graph = (): Graph =>
  ({
    v: 1,
    rev: 1,
    projet: { cle: 'k', racine: '/p', nom: 'reservation-tool', stack: STACK, indexe: { commit: 'a1b2c3d', branche: 'main', le: '2026-10-01T00:00:00.000Z', fichiers: 212, tok: 1 }, exclus: [] },
    fichiers: Object.fromEntries(Array.from({ length: 212 }, (_, i) => [`f${i}.ts`, { k: 'autre', h: 'h', tok: 1 }])),
    noeuds: {},
    features: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`feat${i}`, { id: `feat${i}`, titre: `Feat ${i}`, alias: [], fichiers: [], usages: { servie: 0 } }])),
    candidates: [],
    stats: { flows: 14, servis: 0, evites: 0, net: 0 },
    journal: [],
  }) as unknown as Graph

const verifBase = (commit = 'a1b2c3d4e5f6'): ProjetVerif => ({
  commandes: detected().commandes.map(c => (c.id === 'typecheck' ? { ...c, dureeMs: 40_000 } : c)),
  manifestes: {},
  instables: [],
  pieges: [],
  bases: [{ commit, le: '2026-10-01T00:00:00.000Z', commandes: ['eslint', 'typecheck'], signatures: ['typecheck|a.ts|TS2322|x', 'typecheck|b.ts|TS2339|y'] }],
})

function complet(over: Partial<DoctorInput> = {}): DoctorInput {
  const verif = verifBase()
  return {
    nom: 'reservation-tool',
    stack: STACK,
    manifestes: manifestsOf(FILES, READ),
    commandes: verif.commandes,
    confirmation: 'confirmee',
    verif,
    commit: 'a1b2c3d4e5f6a7b8',
    mode: 'bloquer',
    crap: true,
    cache: true,
    agentsActif: true,
    stats: computeStats(graph(), null, 'reservation-tool'),
    journal: 14,
    agents: SAVVY,
    pieges: [],
    ...over,
  }
}

describe('doctorText : projet reconnu', () => {
  test('Nuxt 3 + Vitest complet : la maquette, une rubrique par ligne, colonnes alignées', () => {
    const t = doctorText(complet())
    expect(lines(t)[0]).toBe('revo-flow doctor · reservation-tool')
    expect(find(t, 'Stack')).toBe('Stack        Nuxt 3 + Pinia + TypeScript + vitest (package.json, .eslintrc.cjs, nuxt.config.ts, .gitlab-ci.yml)')
    expect(find(t, 'Porte')).toMatch(/bloquer .* · commandes confirmées/)
    expect(find(t, 'Lint')).toMatch(/^Lint {9}npx eslint --ext \.ts,\.js,\.vue \{fichiers\} +CI \.gitlab-ci\.yml \(script lint\)$/)
    expect(find(t, 'Typage')).toMatch(/^Typage {7}npx nuxi typecheck +CI \.gitlab-ci\.yml \(script typecheck\) · projet entier · ≈ 40 s en moyenne$/)
    expect(find(t, 'Tests')).toMatch(/^Tests {8}npx vitest related \{fichiers\} +script test · tests liés aux fichiers du flow · couverture mesurée$/)
    expect(find(t, 'CRAP')).toBe('CRAP         actif (seuil 30)')
    expect(find(t, 'Base')).toBe('Base         commit a1b2c3d, 2 erreurs préexistantes (lint), 0 (typage)'.replace('2 erreurs préexistantes (lint), 0 (typage)', '0 erreur préexistante (lint), 2 (typage)'))
    expect(find(t, 'Cache')).toBe('Cache        graphe de 212 fichiers, 9 fiches, 14 flows au journal')
    expect(find(t, 'Agents')).toBe('Agents       5 installés (savvy-flow ×5), proposés au plan')
    expect(find(t, 'Pièges')).toBe('Pièges       aucun')
    // La colonne de la commande est la même d'une ligne à l'autre : les sources commencent au même rang.
    const col = (l: string) => l.search(/ (CI|script) /)
    expect(col(find(t, 'Lint')!)).toBe(col(find(t, 'Tests')!))
  })

  test('les formats machine et les options de couverture ne sont pas montrés ; aucun Markdown', () => {
    const t = doctorText(complet())
    expect(t).not.toMatch(/--reporter|-f json|--coverage|--passWithNoTests|\*\*|^#|`/m)
  })

  test('commandes détectées, pas encore confirmées : la porte le dit', () => {
    const t = doctorText(complet({ commandes: detected().commandes, confirmation: 'a-confirmer', verif: undefined, commit: '' }))
    expect(find(t, 'Porte')).toMatch(/commandes à confirmer au premier flow/)
    expect(find(t, 'Base')).toMatch(/pas de commit/)
    expect(find(t, 'Typage')).not.toMatch(/en moyenne/)
  })

  test('commit sans base de référence : elle se prendra à la planification', () => {
    expect(find(doctorText(complet({ commit: 'ffff000' })), 'Base')).toBe('Base         commit ffff000, pas encore de base : elle se prend pendant la planification du prochain flow')
  })

  test('CRAP : coupé par l’option, ou actif sans commande de score', () => {
    expect(find(doctorText(complet({ crap: false, commandes: detected(false).commandes })), 'CRAP')).toBe('CRAP         désactivé (option crap)')
    expect(find(doctorText(complet({ commandes: detected(false).commandes })), 'CRAP')).toMatch(/option active, mais les tests liés ne mesurent pas leur couverture/)
  })

  test('cache, agents : options coupées, rien de détecté', () => {
    const t = doctorText(complet({ stats: null, cache: false, agentsActif: false, agents: [] }))
    expect(find(t, 'Cache')).toMatch(/pas encore de graphe .*option cache désactivée/)
    expect(find(t, 'Agents')).toMatch(/option agents désactivée/)
    expect(find(doctorText(complet({ agents: [] })), 'Agents')).toMatch(/aucun agent installé : general-purpose et Explore/)
  })

  test('agents : regroupés par source (plugin, projet, personnels)', () => {
    const t = doctorText(complet({ agents: [...SAVVY.slice(0, 2), agent('front', 'projet'), agent('perso', 'utilisateur')] }))
    expect(find(t, 'Agents')).toBe('Agents       4 installés (savvy-flow ×2, projet ×1, personnels ×1), proposés au plan')
  })

  test('verif en observateur ou coupée : la ligne Porte le dit', () => {
    expect(find(doctorText(complet({ mode: 'observer' })), 'Porte')).toMatch(/observer \(affiche, ne bloque jamais\)/)
    expect(find(doctorText(complet({ mode: 'off' })), 'Porte')).toBe('Porte        désactivée (option verif) : aucune vérification ne sera lancée')
  })
})

describe('doctorText : la rubrique Web', () => {
  const web = (o: Partial<WebDispo> = {}): WebDispo => ({ option: 'extension', login: false, ...o })
  const serveur = (port?: number, argv = ['npm', 'run', 'dev']) => ({ argv, ...(port ? { port } : {}), origine: 'script dev' })

  const mobile = (o: Partial<MobileDispo> = {}): MobileDispo => ({ option: 'appareil', ...o })
  const FLUTTER = { framework: 'flutter' as const, plateformes: ['android' as const, 'ios' as const], origine: 'pubspec.yaml (flutter)' }

  test('rubrique Mobile (v3.1) : elle remplace la rubrique Web sur une app mobile ; désactivée ; appareils vus ou aucun', () => {
    const t = doctorText(
      complet({
        web: web({ serveur: serveur(3000) }),
        mobile: mobile({
          app: FLUTTER,
          appareils: [
            { id: '192.168.1.13:40481', nom: 'SM A515F', plateforme: 'android', type: 'physique', etat: 'connecte', sdk: 'Android 13 (API 33)', capture: true },
            { id: 'Pixel_8', nom: 'Pixel 8', plateforme: 'android', type: 'emulateur', etat: 'eteint' },
          ],
        }),
      }),
    )
    expect(find(t, 'Web')).toBeUndefined()
    expect(find(t, 'Mobile')).toBe('Mobile       app Flutter (pubspec.yaml (flutter), android et ios) · preuve mobile au vérificateur sur votre accord, en direct sur l’appareil · outils : outil mobile de revo-flow (capture, arbre, journal, gestes)')
    expect(t).toContain('appareils : SM A515F (téléphone branché, Android 13 (API 33)), Pixel 8 (émulateur, à démarrer)')
    expect(doctorText(complet({ mobile: mobile({ app: FLUTTER, option: 'mcp' }) }))).toContain('aucun appareil vu : branchez un téléphone')
    expect(doctorText(complet({ mobile: mobile({ app: FLUTTER, option: 'mcp' }) }))).toContain('et mobile-mcp (npx @mobilenext/mobile-mcp)')
    expect(find(doctorText(complet({ mobile: mobile({ option: 'off', app: FLUTTER }) })), 'Mobile')).toBe('Mobile       preuve mobile désactivée (option mobile)')
    // Un projet web : la rubrique Web reste, pas de rubrique Mobile.
    const w = doctorText(complet({ web: web({ serveur: serveur(3000) }), mobile: mobile() }))
    expect(find(w, 'Web')).toContain('npm run dev · port 3000')
    expect(find(w, 'Mobile')).toBeUndefined()
    // Ni l'un ni l'autre : la rubrique Mobile dit qu'aucune app n'est détectée seulement quand il n'y a pas d'entrée web.
    expect(find(doctorText(complet({ mobile: mobile() })), 'Mobile')).toBe('Mobile       aucune app mobile détectée (ni pubspec.yaml Flutter, ni react-native ou expo) : pas de preuve mobile')
  })

  test('sans l’entrée web, pas de rubrique', () => {
    expect(find(doctorText(complet()), 'Web')).toBeUndefined()
  })

  test('option coupée, ou pas de serveur de dev', () => {
    expect(find(doctorText(complet({ web: web({ option: 'off' }) })), 'Web')).toBe('Web          preuve web désactivée (option web)')
    expect(find(doctorText(complet({ web: web() })), 'Web')).toBe('Web          aucun serveur de dev détecté (pas de script dev) : pas de preuve web')
  })

  test('Nuxt en npm, port 3000, REVO_WEB_LOGIN absent', () => {
    const t = doctorText(complet({ web: web({ serveur: serveur(3000) }) }))
    expect(find(t, 'Web')).toBe('Web          npm run dev · port 3000 · script dev · preuve web au vérificateur sur votre accord · outils : extension Claude in Chrome')
    expect(lines(t)[lines(t).indexOf(find(t, 'Web')!) + 1]).toBe(`${' '.repeat(13)}REVO_WEB_LOGIN absent : si l’app demande une connexion, définissez-la pour le serveur de dev ; revo-flow ne la lit jamais`)
    expect(lines(t).findIndex(l => l.startsWith('Web'))).toBeGreaterThan(lines(t).findIndex(l => l.startsWith('Agents')))
  })

  test('pnpm, port inconnu, REVO_WEB_LOGIN défini, outils devtools', () => {
    const t = doctorText(complet({ web: web({ option: 'devtools', login: true, serveur: serveur(undefined, ['pnpm', 'run', 'dev']) }) }))
    expect(find(t, 'Web')).toBe('Web          pnpm run dev · port inconnu (lu dans la sortie) · script dev · preuve web au vérificateur sur votre accord · outils : extension Claude in Chrome, ou Chrome DevTools MCP (npx chrome-devtools-mcp)')
    expect(t).toContain('REVO_WEB_LOGIN défini : le serveur de dev connaît le compte de test (revo-flow ne le lit jamais)')
  })
})

describe('doctorText : pièges', () => {
  test('un piège : sur la ligne Pièges ; plusieurs : alignés dessous', () => {
    const un = doctorText(complet({ pieges: ['Flutter 3.44.4 sur ce poste, 3.44.6 attendu par .fvm : les résultats peuvent différer de la CI'] }))
    expect(find(un, 'Pièges')).toBe('Pièges       Flutter 3.44.4 sur ce poste, 3.44.6 attendu par .fvm : les résultats peuvent différer de la CI')
    const deux = lines(doctorText(complet({ pieges: ['node_modules absent : lancez npm install', 'env.test absent'] })))
    expect(deux.at(-2)).toBe('Pièges       node_modules absent : lancez npm install')
    expect(deux.at(-1)).toBe(`${' '.repeat(13)}env.test absent`)
  })

  test('les pièges de detectCommands sont repris tels quels (vitest sans fournisseur de couverture)', () => {
    const read = { 'package.json': json({ scripts: { test: 'vitest' }, devDependencies: { vitest: '^1.6.0' } }) }
    const f = detectCommands({ stack: 'vitest', files: [], read, crap: true })
    expect(f.pieges[0]).toMatch(/@vitest\/coverage-v8/)
    const t = doctorText(complet({ commandes: f.commandes, pieges: f.pieges }))
    expect(find(t, 'Pièges')).toContain('@vitest/coverage-v8')
    expect(find(t, 'CRAP')).toMatch(/aucun score/)
  })
})

describe('doctorText : rien de reconnu', () => {
  test('sans projet git : la porte ne fera rien, et pourquoi', () => {
    const t = doctorText({ ...complet(), nom: undefined, commandes: [], stats: null, agents: [] })
    expect(lines(t)[0]).toBe('revo-flow doctor')
    expect(t).toMatch(/Aucun projet git reconnu/)
    expect(t).toMatch(/La porte de vérification ne fera rien/)
    expect(t).toMatch(/« non vérifié »/)
    expect(t).not.toMatch(/^Lint|^Typage|^Tests/m)
  })

  test('projet sans CI, script ni outil connu : la porte ne fera rien, le cache et les agents restent dits', () => {
    const f = detectCommands({ stack: 'inconnue', files: ['notes.txt'], read: {} })
    expect(f.commandes).toEqual([])
    const t = doctorText(complet({ stack: 'inconnue', manifestes: [], commandes: f.commandes, confirmation: 'a-confirmer', verif: undefined }))
    expect(find(t, 'Stack')).toBe('Stack        non reconnue')
    expect(find(t, 'Porte')).toMatch(/^Porte {8}ne fera rien : aucune vérification reconnue .* « non vérifié »$/)
    expect(find(t, 'CRAP')).toMatch(/aucun test lié à lancer/)
    expect(find(t, 'Cache')).toMatch(/graphe de 212 fichiers/)
    expect(find(t, 'Agents')).toMatch(/5 installés/)
    expect(t).not.toMatch(/^(Lint|Typage|Tests|Format) /m)
  })
})

describe('manifestsOf', () => {
  test('package.json d’abord, puis les configurations de la racine ; au plus 5, le reste en « … »', () => {
    expect(manifestsOf(['nuxt.config.ts', 'vitest.config.ts', 'src/a.ts'], { 'package.json': '{}', 'tsconfig.json': '{}' })).toEqual(['package.json', 'nuxt.config.ts', 'vitest.config.ts', 'tsconfig.json'])
    const beaucoup = manifestsOf(['nuxt.config.ts'], { 'package.json': '{}', 'a.yml': '', 'b.yml': '', 'c.yml': '', 'd.yml': '', 'absent.json': undefined })
    expect(beaucoup).toHaveLength(6)
    expect(beaucoup.at(-1)).toBe('…')
    expect(beaucoup).not.toContain('absent.json')
  })
})

describe('version', () => {
  test('pluginVersion et versionText : la version de plugin.json, ou une phrase claire', () => {
    expect(pluginVersion(json({ name: 'revo-flow', version: '2.4.0' }))).toBe('2.4.0')
    expect(pluginVersion('pas du json')).toBeUndefined()
    expect(pluginVersion(undefined)).toBeUndefined()
    expect(pluginVersion(json({ version: 3 }))).toBeUndefined()
    expect(versionText('2.4.0')).toBe('revo-flow 2.4.0')
    expect(versionText(undefined)).toMatch(/version illisible/)
  })
})

// ── La commande, de bout en bout : un disque en mémoire, Windows et macOS ─

const rootOf = (os: Os) => native(os, 'Documents', 'Front', 'reservation-tool')
const COMMIT = 'c0ffee0000000000000000000000000000000000'
const run = async ($: Engine, args: string) => (await $.command.run({ command: 'revo-flow', args } as never)).text ?? ''

/** Le moteur minimal que la commande lit : dépôt, disque, git. `plugin` : le texte de plugin.json que fs.read rend pour le dossier du mod. */
function world(on: On, os: Os, disk: Record<string, string>, tracked: Record<string, string>, plugin: string | undefined, hasRepo = true) {
  mock.store(on, {})
  mock.env(on, os.env)
  mock.clock(on, { now: Date.UTC(2026, 9, 12, 9) })
  const runs: string[][] = []
  const writes: string[] = []
  const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    if (e.argv.includes('ls-files')) return out(Object.entries(tracked).map(([p, h]) => `100644 ${h.padEnd(40, '0')} 0\t${p}\0`).join(''))
    if (e.argv.includes('status') || e.argv.includes('log') || e.argv.includes('diff')) return out('')
    if (e.argv.includes('hash-object')) return out('a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0\n'.repeat(8))
    if (e.argv.includes('rev-parse') && !e.argv.includes('--abbrev-ref')) return out(`${COMMIT}\n`)
    return out('main\n')
  })
  on('fs.stat', () => ({ value: { realPath: rootOf(os), kind: 'directory' } }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('session.repo', () => ({ value: hasRepo ? { root: rootOf(os), remote: null, internal: false, name: 'reservation-tool' } : null }) as never)
  on('session.root', () => ({ value: undefined }) as never)
  on('fs.read', (_$, e) => {
    if (diskKey(e.path).endsWith('/.claude-plugin/plugin.json') && plugin !== undefined) return { value: plugin } as never
    return (diskKey(e.path) in disk ? { value: disk[diskKey(e.path)]! } : { deny: `ENOENT ${e.path}` }) as never
  })
  on('fs.write', (_$, e) => {
    writes.push(e.path)
    disk[diskKey(e.path)] = e.text
    return { value: undefined } as never
  })
  on('fs.exists', (_$, e) => ({ value: diskKey(e.path) in disk }) as never)
  on('command.register', () => ({ value: { command: 'revo-flow' } }) as never)
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__revo-flow__${(e as unknown as { name: string }).name}` } }) as never)
  on('agent.register', (_$, e) => ({ value: { agent: `revo-flow:${(e as unknown as { name: string }).name}` } }) as never)
  return { runs, writes }
}

const sources = (os: Os) => {
  const r = rootOf(os).replace(/\\/g, '/')
  return { [`${r}/package.json`]: PKG, [`${r}/.gitlab-ci.yml`]: CI, [`${r}/nuxt.config.ts`]: 'export default {}', [`${r}/composables/useCart.ts`]: 'export const useCart = () => 1' }
}
const tracked = { 'package.json': 'a1', '.gitlab-ci.yml': 'b2', 'nuxt.config.ts': 'c3', 'composables/useCart.ts': 'd4' }
const keyed = (os: Os) => Object.fromEntries(Object.entries(sources(os)).map(([p, t]) => [diskKey(p), t]))

for (const os of OSES) {
  describe(`/revo-flow version et doctor (${os.nom})`, () => {
    test('version : celle de plugin.json, lue par $.fs dans le dossier du mod', async ($, on) => {
      world(on, os, {}, {}, json({ name: 'revo-flow', version: '9.8.7' }))
      expect(await run($, 'version')).toBe('revo-flow 9.8.7')
    })

    test('version : plugin.json illisible, la commande le dit au lieu de lever', async ($, on) => {
      world(on, os, {}, {}, 'pas du json')
      expect(await run($, 'version')).toMatch(/version illisible/)
    })

    test('doctor : stack, commandes et pièges du projet, sans rien écrire ni lancer de vérification', async ($, on) => {
      const w = world(on, os, keyed(os), tracked, undefined)
      const t = await run($, 'doctor')
      expect(lines(t)[0]).toBe('revo-flow doctor · reservation-tool')
      expect(find(t, 'Stack')).toMatch(/^Stack {8}Nuxt 3/)
      expect(find(t, 'Porte')).toMatch(/commandes à confirmer au premier flow/)
      expect(find(t, 'Lint')).toMatch(/npx eslint .*\{fichiers\}/)
      expect(find(t, 'Typage')).toMatch(/npx nuxi typecheck/)
      expect(find(t, 'Tests')).toMatch(/npx vitest related \{fichiers\}/)
      expect(find(t, 'CRAP')).toMatch(/actif \(seuil 30\)|option active/)
      expect(find(t, 'Cache')).toMatch(/^Cache {8}graphe de \d+ fichiers?, 0 fiche, 0 flow au journal/)
      expect(find(t, 'Agents')).toMatch(/aucun agent installé/)
      // Lecture seule : ni écriture de graphe, ni eslint / nuxi / vitest lancés.
      expect(w.writes).toEqual([])
      expect(w.runs.some(a => a.some(x => /eslint|nuxi|vitest|tsc/.test(x)))).toBe(false)
    })

    test('doctor hors dépôt : la porte ne fera rien', async ($, on) => {
      world(on, os, {}, {}, undefined, false)
      expect(await run($, 'doctor')).toMatch(/Aucun projet git reconnu[\s\S]*La porte de vérification ne fera rien/)
    })
  })
}
