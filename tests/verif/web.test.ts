import { describe, expect, test } from 'claude-code/testing'

import {
  WEB_ATTENTE_MS,
  capturePath,
  commandeText,
  detectDevServer,
  extractPng,
  isScreenshotCall,
  isWebTool,
  portFatalInOutput,
  portTakenInOutput,
  sansAnsi,
  urlFromOutput,
  verifierWebTask,
  webToolDenial,
} from '../../hooks/verif/web'

const pkg = (scripts: Record<string, string>, deps: Record<string, string> = {}) => JSON.stringify({ name: 'app', scripts, devDependencies: deps })
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// ── detectDevServer ──────────────────────────────────────────────────────

describe('detectDevServer', () => {
  test('Nuxt 3 avec npm : npm run dev, port 3000 par défaut', () => {
    const s = detectDevServer({ files: ['package.json', 'package-lock.json', 'nuxt.config.ts'], read: { 'package.json': pkg({ dev: 'nuxt dev', build: 'nuxt build' }, { nuxt: '^3.12.0' }) } })
    expect(s).toEqual({ argv: ['npm', 'run', 'dev'], port: 3000, origine: 'script dev' })
    expect(commandeText(s!)).toBe('npm run dev')
  })

  test('Next avec pnpm : pnpm run dev, port du script (-p)', () => {
    const s = detectDevServer({ files: ['package.json', 'pnpm-lock.yaml'], read: { 'package.json': pkg({ dev: 'next dev -p 4000' }, { next: '14.2.0' }) } })
    expect(s).toEqual({ argv: ['pnpm', 'run', 'dev'], port: 4000, origine: 'script dev' })
  })

  test('Vite avec yarn : yarn dev, 5173 par défaut ; port de vite.config sinon', () => {
    const files = ['package.json', 'yarn.lock']
    const s = detectDevServer({ files, read: { 'package.json': pkg({ dev: 'vite' }, { vite: '^5.0.0' }) } })
    expect(s).toEqual({ argv: ['yarn', 'dev'], port: 5173, origine: 'script dev' })
    const c = detectDevServer({ files, read: { 'package.json': pkg({ dev: 'vite' }), 'vite.config.ts': 'export default defineConfig({\n  server: { host: true, port: 8080 },\n})' } })
    expect(c?.port).toBe(8080)
  })

  test('Angular : start « ng serve » sans script dev → npm run start, port 4200', () => {
    const s = detectDevServer({ files: ['package.json'], read: { 'package.json': pkg({ start: 'ng serve', build: 'ng build' }, { '@angular/core': '^17.0.0' }) } })
    expect(s).toEqual({ argv: ['npm', 'run', 'start'], port: 4200, origine: 'script start' })
  })

  test('bun : bun run dev ; framework repéré par la stack quand rien d’autre ne le dit', () => {
    const s = detectDevServer({ files: ['bun.lockb', 'package.json'], read: { 'package.json': pkg({ dev: 'bunx --bun custom-dev' }) }, stack: 'Astro, Tailwind' })
    expect(s).toEqual({ argv: ['bun', 'run', 'dev'], port: 4321, origine: 'script dev' })
    expect(detectDevServer({ files: ['bun.lock'], read: { 'package.json': pkg({ dev: 'x' }) } })?.argv).toEqual(['bun', 'run', 'dev'])
  })

  test('sans script dev ni start de dev : pas de serveur', () => {
    expect(detectDevServer({ files: ['package.json'], read: { 'package.json': pkg({ build: 'tsc', test: 'vitest run' }) } })).toBeUndefined()
    expect(detectDevServer({ files: ['package.json'], read: { 'package.json': pkg({ start: 'node server.js' }) } })).toBeUndefined()
    expect(detectDevServer({ files: ['package.json'], read: { 'package.json': pkg({ start: 'nuxt start' }) } })).toBeUndefined()
    expect(detectDevServer({ files: ['package.json'], read: { 'package.json': pkg({ start: 'vite build' }) } })).toBeUndefined()
    expect(detectDevServer({ files: [], read: {} })).toBeUndefined()
  })

  test('start qui lance un serveur de dev reconnu (nuxt nu, next dev, vite --port)', () => {
    expect(detectDevServer({ files: [], read: { 'package.json': pkg({ start: 'nuxt' }) } })).toEqual({ argv: ['npm', 'run', 'start'], port: 3000, origine: 'script start' })
    expect(detectDevServer({ files: [], read: { 'package.json': pkg({ start: 'next dev' }) } })?.port).toBe(3000)
    expect(detectDevServer({ files: [], read: { 'package.json': pkg({ start: 'vite --port 3001' }) } })?.port).toBe(3001)
  })

  test('ports : --port=N, PORT=N, .env, nuxt.config devServer ; le script l’emporte', () => {
    const nuxt = { nuxt: '^3.0.0' }
    expect(detectDevServer({ files: [], read: { 'package.json': pkg({ dev: 'nuxt dev --port=3333' }, nuxt) } })?.port).toBe(3333)
    expect(detectDevServer({ files: [], read: { 'package.json': pkg({ dev: 'nuxt dev --port 3334' }, nuxt) } })?.port).toBe(3334)
    expect(detectDevServer({ files: [], read: { 'package.json': pkg({ dev: 'cross-env PORT=4100 nuxt dev' }, nuxt) } })?.port).toBe(4100)
    expect(detectDevServer({ files: [], read: { 'package.json': pkg({ dev: 'nuxt dev' }, nuxt), '.env': 'API_URL=http://x\nPORT=4200\n' } })?.port).toBe(4200)
    const conf = 'export default defineNuxtConfig({\n  devServer: {\n    port: 3500,\n  },\n})'
    expect(detectDevServer({ files: [], read: { 'package.json': pkg({ dev: 'nuxt dev' }, nuxt), 'nuxt.config.ts': conf } })?.port).toBe(3500)
    expect(detectDevServer({ files: [], read: { 'package.json': pkg({ dev: 'nuxt dev -p 3600' }, nuxt), 'nuxt.config.ts': conf, '.env': 'PORT=4200' } })?.port).toBe(3600)
  })

  test('port inconnu : pas de champ port ; package.json illisible ne lève pas', () => {
    const s = detectDevServer({ files: [], read: { 'package.json': pkg({ dev: 'node watch.js' }) } })
    expect(s).toEqual({ argv: ['npm', 'run', 'dev'], origine: 'script dev' })
    expect('port' in s!).toBe(false)
    expect(detectDevServer({ files: [], read: { 'package.json': '{ pas du json' } })).toBeUndefined()
  })

  test('chemins Windows et « ./ » normalisés', () => {
    const s = detectDevServer({ files: ['.\\pnpm-lock.yaml'], read: { './package.json': pkg({ dev: 'nuxt dev' }) } })
    expect(s?.argv).toEqual(['pnpm', 'run', 'dev'])
  })
})

// ── Sortie du serveur ────────────────────────────────────────────────────

describe('urlFromOutput', () => {
  test('Nuxt, Next, Vite, Angular, Listening on', () => {
    expect(urlFromOutput('Nuxt 3.12.4 with Nitro 2.9.7\n  ➜ Local:    http://localhost:3000/\n  ➜ Network:  use --host to expose')).toBe('http://localhost:3000')
    expect(urlFromOutput('   ▲ Next.js 14.2.3\n   - Local:        http://localhost:3000\n   - Environments: .env')).toBe('http://localhost:3000')
    expect(urlFromOutput('ready - started server on 0.0.0.0:3000, url: http://localhost:3000')).toBe('http://localhost:3000')
    expect(urlFromOutput('  VITE v5.2.0  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  press h + enter to show help')).toBe('http://localhost:5173')
    expect(urlFromOutput('** Angular Live Development Server is listening on localhost:4200 **\n  ➜  Local:   http://localhost:4200/')).toBe('http://localhost:4200')
    expect(urlFromOutput('Listening on http://localhost:3000')).toBe('http://localhost:3000')
  })

  test('codes ANSI retirés ; 127.0.0.1, 0.0.0.0 et [::1] réécrits en localhost', () => {
    expect(urlFromOutput('\x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m')).toBe('http://localhost:5173')
    expect(urlFromOutput('Listening on http://127.0.0.1:8080/app')).toBe('http://localhost:8080')
    expect(urlFromOutput('Server at http://0.0.0.0:3000')).toBe('http://localhost:3000')
    expect(urlFromOutput('Listening on http://[::1]:3000')).toBe('http://localhost:3000')
  })

  test('la ligne Local l’emporte, Network ignoré ; rien tant que l’URL n’est pas sortie', () => {
    expect(urlFromOutput('  ➜  Network: http://192.168.1.12:5173/\n  ➜  Local:   http://localhost:5173/')).toBe('http://localhost:5173')
    expect(urlFromOutput('Network: http://192.168.1.12:3000')).toBeUndefined()
    expect(urlFromOutput('Starting Nuxt...\nℹ Vite client warmed up')).toBeUndefined()
    expect(urlFromOutput(undefined as unknown as string)).toBeUndefined()
  })
})

describe('portTakenInOutput', () => {
  test('EADDRINUSE et les formes courantes, insensible à la casse', () => {
    expect(portTakenInOutput('Error: listen EADDRINUSE: address already in use :::3000')).toBe(true)
    expect(portTakenInOutput('Port 3000 is in use, trying another one...')).toBe(true)
    expect(portTakenInOutput('Error: port 3000 is already in use')).toBe(true)
    expect(portTakenInOutput('Something IS ALREADY IN USE')).toBe(true)
    expect(portTakenInOutput('➜ Local: http://localhost:3000/')).toBe(false)
  })
})

describe('portFatalInOutput', () => {
  test('fatal : EADDRINUSE, address already in use, port N is already in use', () => {
    expect(portFatalInOutput('Error: listen EADDRINUSE: address already in use :::3000')).toBe(true)
    expect(portFatalInOutput('\x1b[31mError: address already in use 0.0.0.0:3000\x1b[39m')).toBe(true)
    expect(portFatalInOutput('Error: Port 4200 is already in use. Use \'--port\' to specify a different port.')).toBe(true)
  })

  test('pas fatal : Vite et Nuxt rebasculent sur un autre port', () => {
    expect(portFatalInOutput('Port 3000 is in use, trying another one...')).toBe(false)
    expect(portFatalInOutput('Port 5173 is in use, trying another one...\n  ➜  Local:   http://localhost:5174/')).toBe(false)
    expect(portFatalInOutput('➜ Local: http://localhost:3000/')).toBe(false)
    expect(portFatalInOutput(undefined as unknown as string)).toBe(false)
  })
})

test('sansAnsi retire couleurs et liens OSC', () => {
  expect(sansAnsi('\x1b[32m➜\x1b[39m \x1b]8;;http://x\x07lien\x1b]8;;\x07 ok')).toBe('➜ lien ok')
  expect(sansAnsi(undefined as unknown as string)).toBe('')
})

test('WEB_ATTENTE_MS vaut 90 s', () => {
  expect(WEB_ATTENTE_MS).toBe(90_000)
})

// ── Outils navigateur ────────────────────────────────────────────────────

describe('isWebTool et isScreenshotCall', () => {
  test('préfixes reconnus', () => {
    expect(isWebTool('mcp__claude-in-chrome__navigate')).toBe('chrome')
    expect(isWebTool('mcp__Claude_Browser__computer')).toBe('chrome')
    expect(isWebTool('mcp__chrome-devtools__take_snapshot')).toBe('devtools')
    expect(isWebTool('Bash')).toBeUndefined()
    expect(isWebTool('mcp__revo-flow__verif')).toBeUndefined()
  })

  test('captures : computer screenshot ou zoom, take_screenshot, screenshot, get_screenshot', () => {
    expect(isScreenshotCall('mcp__claude-in-chrome__computer', { action: 'screenshot' })).toBe(true)
    expect(isScreenshotCall('mcp__claude-in-chrome__computer', { action: 'zoom', region: [0, 0, 10, 10] })).toBe(true)
    expect(isScreenshotCall('mcp__claude-in-chrome__computer', { action: 'left_click' })).toBe(false)
    expect(isScreenshotCall('mcp__chrome-devtools__take_screenshot', {})).toBe(true)
    expect(isScreenshotCall('mcp__x__screenshot', {})).toBe(true)
    expect(isScreenshotCall('mcp__x__get_screenshot', {})).toBe(true)
    expect(isScreenshotCall('mcp__claude-in-chrome__read_page', {})).toBe(false)
    expect(isScreenshotCall('mcp__claude-in-chrome__computer', undefined as unknown as Record<string, unknown>)).toBe(false)
  })
})

describe('webToolDenial', () => {
  const ouvert = { etat: 'pret' as const, url: 'http://localhost:3000' }

  test('pas un outil web : jamais refusé', () => {
    expect(webToolDenial('Bash', { url: 'https://evil.example' }, undefined)).toBeUndefined()
  })

  test('preuve web fermée : tout outil navigateur refusé', () => {
    for (const web of [undefined, { etat: 'question' as const }, { etat: 'demarrage' as const }, { etat: 'arrete' as const, url: 'http://localhost:3000' }]) {
      const r = webToolDenial('mcp__claude-in-chrome__read_page', {}, web)
      expect(r).toContain('la preuve web n’est pas ouverte')
      expect(r).toContain('mcp__revo-flow__verif')
    }
  })

  test('ouverte : même origine, chemins relatifs, about:blank, back et forward passent', () => {
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: 'http://localhost:3000/panier?x=1' }, ouvert)).toBeUndefined()
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: 'http://127.0.0.1:3000/' }, ouvert)).toBeUndefined()
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: '/panier' }, ouvert)).toBeUndefined()
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: 'localhost:3000/panier' }, ouvert)).toBeUndefined()
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: '127.0.0.1:3000' }, ouvert)).toBeUndefined()
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: 'localhost:3000' }, { etat: 'pret', url: 'https://localhost:3000' })).toBeUndefined()
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: 'localhost:4000/panier' }, ouvert)).toContain('autre origine')
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: 'about:blank' }, ouvert)).toBeUndefined()
    expect(webToolDenial('mcp__Claude_Browser__navigate', { url: 'back' }, ouvert)).toBeUndefined()
    expect(webToolDenial('mcp__Claude_Browser__navigate', { url: 'forward' }, ouvert)).toBeUndefined()
    expect(webToolDenial('mcp__chrome-devtools__navigate_page', { type: 'reload' }, ouvert)).toBeUndefined()
    expect(webToolDenial('mcp__claude-in-chrome__read_console_messages', { tabId: 1 }, ouvert)).toBeUndefined()
    expect(webToolDenial('mcp__claude-in-chrome__computer', { action: 'screenshot' }, ouvert)).toBeUndefined()
  })

  test('ouverte : une autre origine est refusée, quel que soit l’outil qui navigue', () => {
    const r = webToolDenial('mcp__claude-in-chrome__navigate', { url: 'https://mail.google.com/' }, ouvert)
    expect(r).toBe('revo-flow : la preuve web se limite à http://localhost:3000 ; https://mail.google.com/ est une autre origine, le navigateur de l’utilisateur n’est pas à toi.')
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: 'http://localhost:4000/' }, ouvert)).toContain('autre origine')
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: 'evil.example' }, ouvert)).toContain('autre origine')
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: '//evil.example/x' }, ouvert)).toContain('autre origine')
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: 'javascript:alert(1)' }, ouvert)).toContain('autre origine')
    expect(webToolDenial('mcp__chrome-devtools__new_page', { url: 'https://example.com' }, ouvert)).toContain('autre origine')
    expect(webToolDenial('mcp__claude-in-chrome__tabs_create_mcp', { url: 'https://example.com' }, ouvert)).toContain('autre origine')
  })

  test('navigation illisible : refusée par prudence, sans lever', () => {
    expect(webToolDenial('mcp__claude-in-chrome__navigate', {}, ouvert)).toContain('refusée par prudence')
    expect(webToolDenial('mcp__claude-in-chrome__navigate', null as unknown as Record<string, unknown>, ouvert)).toContain('refusée par prudence')
    expect(webToolDenial('mcp__claude-in-chrome__navigate', { url: 'http://localhost:3000' }, { etat: 'pret' })).toContain('autre origine')
  })
})

// ── Capture ──────────────────────────────────────────────────────────────

describe('extractPng', () => {
  test('toutes les formes connues', () => {
    expect(extractPng({ content: [{ type: 'text', text: 'ok' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] })).toBe(PNG)
    expect(extractPng({ content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] })).toBe(PNG)
    expect(extractPng({ image: { base64: PNG } })).toBe(PNG)
    expect(extractPng({ png: PNG })).toBe(PNG)
    expect(extractPng({ base64: PNG })).toBe(PNG)
    expect(extractPng(`data:image/png;base64,${PNG}`)).toBe(PNG)
    expect(extractPng(PNG)).toBe(PNG)
    expect(extractPng([{ result: { content: [{ type: 'image', source: { data: PNG } }] } }])).toBe(PNG)
    expect(extractPng({ content: [{ type: 'text', text: JSON.stringify({ png: PNG }) }] })).toBe(PNG)
  })

  test('rien : undefined, sans lever (profondeur bornée, cycles)', () => {
    expect(extractPng({ content: [{ type: 'text', text: 'Capture prise' }] })).toBeUndefined()
    expect(extractPng('pas une image')).toBeUndefined()
    expect(extractPng({ base64: 'pas du base64 !' })).toBeUndefined()
    expect(extractPng(null)).toBeUndefined()
    expect(extractPng(undefined)).toBeUndefined()
    expect(extractPng({ a: { b: { c: { d: { e: { f: { g: { png: PNG } } } } } } } })).toBeUndefined()
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(extractPng(cycle)).toBeUndefined()
  })
})

test('capturePath : barres obliques, sans barre finale', () => {
  expect(capturePath('C:\\Users\\a\\.claude\\revo-flow\\verif\\f1\\', 2)).toBe('C:/Users/a/.claude/revo-flow/verif/f1/capture-2.png.txt')
  expect(capturePath('/home/a/.claude/revo-flow/verif/f1', 1)).toBe('/home/a/.claude/revo-flow/verif/f1/capture-1.png.txt')
})

// ── Tâche du vérificateur ────────────────────────────────────────────────

describe('verifierWebTask', () => {
  test('désactivée par l’option web', () => {
    const t = verifierWebTask({ option: 'off', serveur: { argv: ['npm', 'run', 'dev'], port: 3000, origine: 'script dev' }, login: false })
    expect(t).toContain('## Preuve web')
    expect(t).toContain('désactivée')
    expect(t).toContain('non vérifiable')
    expect(t).not.toContain('mcp__claude-in-chrome__navigate')
  })

  test('sans serveur détecté', () => {
    const t = verifierWebTask({ option: 'extension', login: false })
    expect(t).toContain('Aucun serveur de dev détecté (pas de script dev')
    expect(t).toContain('non vérifiable')
  })

  test('ouverte : commande, port, outil verif action web, outils permis, règles, connexion', () => {
    const serveur = { argv: ['pnpm', 'run', 'dev'], port: 3000, origine: 'script dev' }
    const t = verifierWebTask({ option: 'extension', serveur, login: false })
    for (const s of [
      'pnpm run dev',
      'port 3000',
      'mcp__revo-flow__verif avec action "web"',
      'mcp__claude-in-chrome__navigate',
      'mcp__claude-in-chrome__read_console_messages',
      'mcp__claude-in-chrome__read_network_requests',
      'seulement sur l’origine donnée',
      'capture n',
      'Une capture seule n’est pas une preuve',
      '"web": true',
      'REVO_WEB_LOGIN manque',
      'Tu n’arrêtes pas le serveur',
    ])
      expect(t).toContain(s)
    expect(t).not.toContain('mcp__chrome-devtools__')
    const d = verifierWebTask({ option: 'devtools', serveur, login: true })
    expect(d).toContain('mcp__chrome-devtools__take_snapshot')
    expect(d).toContain('mcp__chrome-devtools__list_network_requests')
    expect(d).toContain('l’app peut se connecter seule')
    expect(d).toContain('tu n’entres aucun identifiant')
    expect(d).not.toContain('REVO_WEB_LOGIN manque')
  })
})
