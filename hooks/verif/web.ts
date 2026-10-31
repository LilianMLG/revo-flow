/**
 * La preuve à l'exécution web (v3, docs/rd-v3/README.md §3 et docs/rd-v2/execution.md §2) : détection du serveur de dev
 * d'un projet, lecture de son URL et du port pris dans sa sortie, filtre des outils navigateur du vérificateur (fermés
 * tant que le serveur n'est pas accordé, limités à son origine), extraction de la capture d'un résultat d'outil, et le
 * paragraphe « Preuve web » de la tâche du vérificateur.
 * Module PUR, sans aucune référence à `$` ni accès disque : les manifestes lus, la sortie du serveur et les résultats
 * d'outils viennent de l'appelant (register.tsx). Rien ne lève : webToolDenial tourne dans un hook fermé en cas d'erreur.
 */
import type { WebEtat, WebServeur } from '../../types/verif'

/** Délai d'attente de l'URL du serveur de dev, en ms (la CI d'ui-vel attend elle-même 90 s). */
export const WEB_ATTENTE_MS = 90_000

/**
 * Ce que le vérificateur peut faire côté web : l'option (extension Claude in Chrome, Chrome DevTools MCP en repli, ou
 * désactivée), le serveur détecté, et login : REVO_WEB_LOGIN est défini dans l'environnement (revo-flow ne lit jamais
 * sa valeur).
 */
export type WebDispo = { option: 'extension' | 'devtools' | 'off'; serveur?: WebServeur; login: boolean }

/** Les fichiers que detectDevServer lit s'ils existent (chemin relatif à la racine → texte, dans `read`). */
export const WEB_MANIFESTES: string[] = [
  'package.json',
  '.env',
  'nuxt.config.ts',
  'nuxt.config.js',
  'nuxt.config.mjs',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
]

// ── Détection du serveur de dev ───────────────────────────────────────────

/** Un chemin en barres obliques, sans « ./ » de tête (même règle que norm de scope.ts). */
function norm(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  return s
}

type Pkg = { scripts: Record<string, string>; deps: Record<string, string> }

/** package.json tolérant (comme readPkg de detect.ts) : illisible → vide. */
function readPkg(text: string | undefined): Pkg | undefined {
  if (typeof text !== 'string') return undefined
  try {
    const j = JSON.parse(text) as { scripts?: Record<string, unknown>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const scripts: Record<string, string> = {}
    for (const [k, v] of Object.entries(j?.scripts ?? {})) if (typeof v === 'string') scripts[k] = v
    return { scripts, deps: { ...(j?.dependencies ?? {}), ...(j?.devDependencies ?? {}) } }
  } catch {
    return { scripts: {}, deps: {} }
  }
}

/**
 * Un script start qui lance un serveur de dev reconnu : nuxt (nu ou dev), nuxi dev, next dev, vite (nu, dev ou serve),
 * astro dev, ng serve, remix dev, vinxi dev, svelte-kit dev. « nuxt start », « vite build », « node server.js » ne
 * comptent pas.
 */
const SERVEUR_DEV =
  /(?:^|[\s;&|])(?:nuxt(?:\s+dev)?|nuxi\s+dev|next\s+dev|vite(?:\s+(?:dev|serve))?|astro\s+dev|ng\s+serve|remix\s+dev|vinxi\s+dev|svelte-kit\s+dev)(?=\s+-|\s*$|\s*[;&|])/

/** Les frameworks et leur port par défaut, dans l'ordre d'essai (vite après ceux qui l'embarquent). */
const FRAMEWORKS: { port: number; script: RegExp; deps: string[]; stack: RegExp }[] = [
  { port: 3000, script: /\bnux[ti]\b/, deps: ['nuxt', 'nuxt3', 'nuxi', 'nuxt-edge'], stack: /\bnuxt/i },
  { port: 3000, script: /\bnext\b/, deps: ['next'], stack: /\bnext(?:\.?js)?\b/i },
  { port: 4321, script: /\bastro\b/, deps: ['astro'], stack: /\bastro\b/i },
  { port: 4200, script: /\bng\s+serve\b/, deps: ['@angular/core', '@angular/cli'], stack: /\bangular\b/i },
  { port: 5173, script: /\bsvelte-kit\b/, deps: ['@sveltejs/kit'], stack: /\bsvelte/i },
  { port: 5173, script: /\bvite\b/, deps: ['vite'], stack: /\bvite\b/i },
  { port: 3000, script: /\bremix\b/, deps: ['@remix-run/dev', '@remix-run/react'], stack: /\bremix\b/i },
]

const portValide = (s: string | undefined): number | undefined => {
  const n = Number(s)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined
}

/** --port N, --port=N, -p N ou PORT=N dans la ligne du script. */
function portDuScript(script: string): number | undefined {
  const m = /--port(?:=|\s+)(\d+)/.exec(script) ?? /(?:^|\s)-p\s+(\d+)/.exec(script) ?? /\bPORT=(\d+)/.exec(script)
  return portValide(m?.[1])
}

/** Le premier fichier présent parmi base.(ts|js|mjs). */
const configDe = (lus: Map<string, string>, base: string) => lus.get(`${base}.ts`) ?? lus.get(`${base}.js`) ?? lus.get(`${base}.mjs`)

/**
 * Le serveur de dev d'un projet web, ou undefined s'il n'en a pas. Le script dev d'abord ; sinon start, s'il lance un
 * serveur de dev reconnu. Gestionnaire d'après le lockfile de la racine (pnpm, yarn, bun, sinon npm). Port : celui du
 * script, sinon PORT du .env, sinon devServer.port de nuxt.config ou server.port de vite.config, sinon le défaut du
 * framework repéré (script, dépendances, puis stack) ; inconnu sinon. Ne lève jamais.
 */
export function detectDevServer(input: { files: string[]; read: Record<string, string | undefined>; stack?: string }): WebServeur | undefined {
  try {
    const lus = new Map<string, string>()
    for (const [k, v] of Object.entries(input?.read ?? {})) if (typeof v === 'string') lus.set(norm(k), v)
    const pkg = readPkg(lus.get('package.json'))
    if (!pkg) return undefined
    const dev = pkg.scripts.dev?.trim()
    const start = pkg.scripts.start?.trim()
    const nom = dev ? 'dev' : start && SERVEUR_DEV.test(start) ? 'start' : undefined
    if (!nom) return undefined
    const script = (nom === 'dev' ? dev : start) ?? ''

    const racine = new Set((Array.isArray(input?.files) ? input.files : []).filter(f => typeof f === 'string').map(norm))
    const argv = racine.has('pnpm-lock.yaml')
      ? ['pnpm', 'run', nom]
      : racine.has('yarn.lock')
        ? ['yarn', nom]
        : racine.has('bun.lockb') || racine.has('bun.lock')
          ? ['bun', 'run', nom]
          : ['npm', 'run', nom]

    const env = lus.get('.env')
    const nuxt = configDe(lus, 'nuxt.config')
    const vite = configDe(lus, 'vite.config')
    const fw =
      FRAMEWORKS.find(f => f.script.test(script)) ??
      FRAMEWORKS.find(f => f.deps.some(d => d in pkg.deps)) ??
      (typeof input?.stack === 'string' ? FRAMEWORKS.find(f => f.stack.test(input.stack!)) : undefined)
    const port =
      portDuScript(script) ??
      portValide(env ? /^\s*(?:export\s+)?PORT\s*=\s*["']?(\d+)/m.exec(env)?.[1] : undefined) ??
      portValide(nuxt ? /\bdevServer\s*:\s*\{[^}]*?\bport\s*:\s*(\d+)/.exec(nuxt)?.[1] : undefined) ??
      portValide(vite ? /\bserver\s*:\s*\{[^}]*?\bport\s*:\s*(\d+)/.exec(vite)?.[1] : undefined) ??
      fw?.port

    return { argv, ...(port !== undefined ? { port } : {}), origine: `script ${nom}` }
  } catch {
    return undefined
  }
}

/** La commande telle qu'un humain la tape : « npm run dev ». */
export function commandeText(s: WebServeur): string {
  return (Array.isArray(s?.argv) ? s.argv : []).join(' ')
}

// ── Sortie du serveur ─────────────────────────────────────────────────────

/** Une sortie de terminal sans ses codes ANSI (couleurs, curseur) ni ses séquences OSC (liens). */
export function sansAnsi(text: string): string {
  const t = typeof text === 'string' ? text : ''
  return t.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

const URL_LOCALE = /(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(:\d+)?/i

/**
 * L'origine du serveur lue dans sa sortie (« http://localhost:3000 », sans chemin ni barre finale), l'hôte local
 * réécrit en localhost ; undefined tant qu'elle n'y est pas. Une ligne « Local » l'emporte, une ligne « Network »
 * passe en dernier. Formes Nuxt, Next, Vite, Angular, « Listening on ».
 */
export function urlFromOutput(text: string): string | undefined {
  const lignes = sansAnsi(typeof text === 'string' ? text : '').split(/\r?\n/)
  const trouvees = lignes.flatMap(l => {
    const m = URL_LOCALE.exec(l)
    return m ? [{ l, url: `${m[1]!.toLowerCase()}://localhost${m[3] ?? ''}` }] : []
  })
  const choisie = trouvees.find(x => /\blocal\b/i.test(x.l)) ?? trouvees.find(x => !/\bnetwork\b/i.test(x.l)) ?? trouvees[0]
  return choisie?.url
}

/**
 * Le port est-il déjà pris d'après la sortie (EADDRINUSE, « address already in use », « Port 3000 is in use »…) ?
 * Vite et Nuxt essaient alors un autre port : l'appelant préfère l'URL quand urlFromOutput en trouve une.
 */
export function portTakenInOutput(text: string): boolean {
  return /EADDRINUSE|address already in use|port \d+ is (?:already )?in use|is already in use/i.test(sansAnsi(text))
}

/**
 * Le port est-il pris au point que le serveur ne démarrera pas ? EADDRINUSE, « address already in use », « port N is
 * already in use », sur une ligne sans « trying another » : « Port 3000 is in use, trying another one » de Vite et Nuxt
 * n'est pas fatal, le serveur rebascule et annonce son URL juste après.
 */
export function portFatalInOutput(text: string): boolean {
  return sansAnsi(text)
    .split(/\r?\n/)
    .some(l => /EADDRINUSE|address already in use|port \d+ is already in use/i.test(l) && !/trying another/i.test(l))
}

// ── Outils navigateur du vérificateur ─────────────────────────────────────

/** L'outil est-il un outil navigateur : 'chrome' (Claude in Chrome, navigateur de Claude), 'devtools' (Chrome DevTools MCP) ? */
export function isWebTool(tool: string): 'chrome' | 'devtools' | undefined {
  if (typeof tool !== 'string') return undefined
  if (tool.startsWith('mcp__claude-in-chrome__') || tool.startsWith('mcp__Claude_Browser__')) return 'chrome'
  if (tool.startsWith('mcp__chrome-devtools__')) return 'devtools'
  return undefined
}

/** L'appel prend-il une capture : computer (action screenshot ou zoom), take_screenshot, screenshot, get_screenshot ? */
export function isScreenshotCall(tool: string, input: Record<string, unknown>): boolean {
  if (typeof tool !== 'string') return false
  if (tool.endsWith('__computer')) {
    const a = typeof input === 'object' && input !== null ? input.action : undefined
    return a === 'screenshot' || a === 'zoom'
  }
  return /__(?:take_screenshot|screenshot|get_screenshot)$/.test(tool)
}

const FERMEE =
  'revo-flow : la preuve web n’est pas ouverte. Demande d’abord le serveur avec l’outil mcp__revo-flow__verif (action web) ; sans serveur accordé, le critère est non vérifiable.'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'])

/** L'origine comparable d'une URL absolue, les hôtes locaux confondus ; undefined si illisible. */
function origineDe(u: string): string | undefined {
  try {
    const x = new URL(u)
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return undefined
    const hote = LOOPBACK.has(x.hostname.toLowerCase()) ? 'localhost' : x.hostname.toLowerCase()
    return `${x.protocol}//${hote}${x.port ? `:${x.port}` : ''}`
  } catch {
    return undefined
  }
}

/** Une URL qui reste sur la page courante : chemin relatif (/, ./, ../, ?, #), about:blank, back, forward. */
const SUR_PLACE = (u: string) => /^(?:\/(?!\/)|\.{1,2}\/|[?#])/.test(u) || /^(?:about:blank|back|forward)$/i.test(u)

/**
 * Pourquoi l'appel de cet outil navigateur est refusé au vérificateur, ou undefined s'il est permis (ou n'est pas un
 * outil navigateur). Fermé tant que la preuve web n'est pas prête ; ensuite, une navigation (navigate, navigate_page,
 * new_page, tabs_create avec url, ou tout input url) doit rester sur l'origine accordée. Une URL sans schéma est essayée
 * avec le schéma de l'origine accordée, puis en https:// (« evil.example » reste refusé). Ne lève jamais : une navigation illisible est refusée par prudence.
 */
export function webToolDenial(tool: string, input: Record<string, unknown>, web: { etat: WebEtat; url?: string } | undefined): string | undefined {
  let navigation = false
  try {
    if (!isWebTool(tool)) return undefined
    if (!web || web.etat !== 'pret') return FERMEE
    const i: Record<string, unknown> = typeof input === 'object' && input !== null ? input : {}
    const nomOutil = tool.slice(tool.lastIndexOf('__') + 2)
    const url = i.url
    const estNav = ['navigate', 'navigate_page', 'new_page'].includes(nomOutil)
    navigation = estNav || typeof url === 'string'
    if (!navigation) return undefined
    if (typeof url !== 'string') {
      // navigate_page de DevTools : type back, forward ou reload, sans url.
      const type = typeof i.type === 'string' ? i.type.toLowerCase() : ''
      if (['back', 'forward', 'reload'].includes(type)) return undefined
      throw new Error('navigation sans url')
    }
    const u = url.trim()
    if (u === '' || SUR_PLACE(u)) return undefined
    const accordee = origineDe(web.url ?? '')
    // Sans schéma, l'URL est essayée avec celui de l'origine accordée (http: le plus souvent), puis en https://.
    const avecSchema = /^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[^/:]+:\d/.test(u)
    const schema = /^https?:/i.exec(web.url ?? '')?.[0]?.toLowerCase() ?? 'https:'
    const essais = avecSchema ? [u] : [`${schema}//${u}`, `https://${u}`]
    if (accordee && essais.some(e => origineDe(e) === accordee)) return undefined
    return `revo-flow : la preuve web se limite à ${web.url ?? '(aucune URL accordée)'} ; ${u} est une autre origine, le navigateur de l’utilisateur n’est pas à toi.`
  } catch {
    return navigation ? 'revo-flow : navigation refusée par prudence (le contrôle de l’origine a échoué).' : undefined
  }
}

// ── Capture ───────────────────────────────────────────────────────────────

const PROFONDEUR_MAX = 6
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** La base64 nue d'une chaîne, ou undefined si ce n'en est pas. */
function base64De(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const data = /^data:image\/[a-z+.-]+;base64,([\s\S]*)$/i.exec(v.trim())
  const s = (data ? data[1]! : v).replace(/\s+/g, '')
  return s && BASE64.test(s) ? s : undefined
}

function chercherPng(v: unknown, profondeur: number): string | undefined {
  if (profondeur > PROFONDEUR_MAX || v === null || v === undefined) return undefined
  if (typeof v === 'string') {
    const t = v.trim()
    if (/^data:image\/[a-z+.-]+;base64,/i.test(t) || t.startsWith('iVBORw0KGgo')) return base64De(t)
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return chercherPng(JSON.parse(t), profondeur + 1)
      } catch {
        return undefined
      }
    }
    return undefined
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = chercherPng(x, profondeur + 1)
      if (r) return r
    }
    return undefined
  }
  if (typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (o.type === 'image') {
    const source = typeof o.source === 'object' && o.source !== null ? (o.source as Record<string, unknown>) : undefined
    const r = base64De(source?.data) ?? base64De(o.data)
    if (r) return r
  }
  const image = typeof o.image === 'object' && o.image !== null ? (o.image as Record<string, unknown>) : undefined
  const direct = base64De(image?.base64) ?? base64De(o.png) ?? base64De(o.base64)
  if (direct) return direct
  for (const x of Object.values(o)) {
    const r = chercherPng(x, profondeur + 1)
    if (r) return r
  }
  return undefined
}

/**
 * La capture (base64 nue) d'un résultat d'outil de forme inconnue, cherchée sur 6 niveaux au plus : bloc image
 * ({ type: 'image', source: { data } } ou { type: 'image', data }), { image: { base64 } }, { png }, { base64 }, chaîne
 * data:image/…;base64, ou base64 PNG nue (iVBORw0KGgo…). undefined sinon. Ne lève jamais.
 */
export function extractPng(result: unknown): string | undefined {
  try {
    return chercherPng(result, 0)
  } catch {
    return undefined
  }
}

/** Le fichier de la capture n du flow : `${dir}/capture-${n}.png.txt` (texte base64 : le système de fichiers du mod n'écrit que du texte). */
export function capturePath(dir: string, n: number): string {
  let d = (typeof dir === 'string' ? dir : '').replace(/\\/g, '/')
  while (d.length > 1 && d.endsWith('/')) d = d.slice(0, -1)
  return `${d}/capture-${n}.png.txt`
}

// ── Tâche du vérificateur ─────────────────────────────────────────────────

/** Les outils navigateur permis au vérificateur, selon l'option. */
function outilsPermis(option: 'extension' | 'devtools'): string[] {
  const chrome = [
    'mcp__claude-in-chrome__navigate',
    'mcp__claude-in-chrome__read_page',
    'mcp__claude-in-chrome__find',
    'mcp__claude-in-chrome__get_page_text',
    'mcp__claude-in-chrome__computer (action screenshot)',
    'mcp__claude-in-chrome__read_console_messages',
    'mcp__claude-in-chrome__read_network_requests',
  ]
  const devtools = [
    'mcp__chrome-devtools__navigate_page',
    'mcp__chrome-devtools__take_snapshot',
    'mcp__chrome-devtools__take_screenshot',
    'mcp__chrome-devtools__list_console_messages',
    'mcp__chrome-devtools__list_network_requests',
  ]
  return option === 'devtools' ? [...chrome, ...devtools] : chrome
}

/**
 * Le paragraphe « ## Preuve web » ajouté à la tâche du vérificateur (5e paramètre de verifierTask) : désactivée, sans
 * serveur détecté, ou ouverte avec la commande, la façon d'obtenir le serveur, les outils permis et les règles.
 */
export function verifierWebTask(d: WebDispo): string {
  const titre = '## Preuve web'
  if (!d || d.option === 'off')
    return [
      titre,
      'La preuve web est désactivée pour ce projet (option web) : un critère qui demande de voir l’application dans un navigateur est non vérifiable. Dis-le et vérifie à côté ce que les commandes permettent.',
    ].join('\n')
  if (!d.serveur)
    return [
      titre,
      'Aucun serveur de dev détecté (pas de script dev dans package.json) : un critère qui demande de voir l’application dans un navigateur est non vérifiable. Dis-le et vérifie à côté ce que les commandes permettent.',
    ].join('\n')
  const cmd = commandeText(d.serveur)
  return [
    titre,
    `Ce projet a un serveur de dev : \`${cmd}\`${d.serveur.port ? ` (port ${d.serveur.port})` : ''}. Pour un critère qui se voit dans l’application (page, texte affiché, erreur console, appel réseau), ouvre la preuve web :`,
    '- Appelle l’outil mcp__revo-flow__verif avec action "web" : revo-flow demande à l’utilisateur, démarre le serveur et te rend l’URL, ou te dit pourquoi non. Sans URL rendue, le critère est non vérifiable.',
    `- Outils navigateur permis : ${outilsPermis(d.option).join(', ')}.`,
    '- Navigue seulement sur l’origine donnée, jamais ailleurs : revo-flow refuse toute autre origine, le navigateur de l’utilisateur n’est pas à toi.',
    '- Une preuve web cite l’URL visitée, l’élément ou le texte vu (read_page, find), le nombre d’erreurs console et de réponses réseau 4xx/5xx, et dit « capture n » : prends une capture par critère jugé. Une capture seule n’est pas une preuve.',
    '- Marque ces verdicts "web": true dans le bloc json.',
    d.login
      ? '- Une page de connexion apparaît : le serveur de dev connaît un compte de test (REVO_WEB_LOGIN), l’app peut se connecter seule ; toi, tu n’entres aucun identifiant.'
      : '- Une page de connexion apparaît : connexion requise, le critère est non vérifiable ; dis que REVO_WEB_LOGIN manque. Tu n’entres aucun identifiant.',
    '- Tu n’arrêtes pas le serveur : revo-flow le fait à la fin du flow.',
  ].join('\n')
}
