/**
 * La preuve à l'exécution mobile (v3.1, docs/rd-v3/README.md §3 bis et docs/rd-v2/execution.md §3) : détection d'une app
 * mobile (Flutter, React Native, Expo), lecture des appareils du poste (téléphone branché, émulateur Android, simulateur iOS),
 * choix de l'appareil, commandes de lancement et d'observation (capture, arbre des vues, journal, toucher), lecture de la
 * sortie de `flutter run` / `expo run` / `react-native run-*`, filtre des outils mobile-mcp du vérificateur et le paragraphe
 * « Preuve mobile » de sa tâche.
 * Module PUR, sans aucune référence à `$` ni accès disque : les manifestes lus, les sorties de commandes et les sondes viennent
 * de l'appelant (register.tsx). Rien ne lève : mobileToolDenial tourne dans un hook fermé en cas d'erreur.
 */
import type { Appareil, MobileApp, MobileEtat } from '../../types/verif'

/** Délai d'attente du lancement de l'app (build Gradle ou Xcode puis installation), en ms. */
export const MOBILE_ATTENTE_MS = 300_000
/** Délai d'attente du démarrage d'un émulateur ou d'un simulateur, en ms. */
export const EMULATEUR_ATTENTE_MS = 180_000
/** Intervalle entre deux lectures des appareils pendant le démarrage d'un émulateur, en ms. */
export const EMULATEUR_SONDE_MS = 3_000

/** Les fichiers que detectMobileApp lit s'ils existent (chemin relatif à la racine → texte, dans `read`). */
export const MOBILE_MANIFESTES: string[] = ['pubspec.yaml', 'package.json', 'app.json', 'app.config.js', 'app.config.ts']
/** Les dossiers dont seule la présence compte (plateformes de l'app) : à passer dans `sondes` (chemin → existe). */
export const MOBILE_SONDES: string[] = ['android', 'ios']

/**
 * Ce que le vérificateur peut faire côté mobile : l'option (appareil : l'outil mobile de revo-flow ; mcp : en plus le serveur
 * mobile-mcp ; off), l'app détectée et les appareils vus par le doctor (facultatif).
 */
export type MobileDispo = { option: 'appareil' | 'mcp' | 'off'; app?: MobileApp; appareils?: Appareil[] }

// ── Détection de l'app ────────────────────────────────────────────────────

/** Un chemin en barres obliques, sans « ./ » de tête (même règle que norm de scope.ts). */
function norm(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  return s
}

/** Les dépendances de package.json (dependencies et devDependencies) ; illisible → vide. */
function depsOf(text: string | undefined): Record<string, string> {
  if (typeof text !== 'string') return {}
  try {
    const j = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    return { ...(j?.dependencies ?? {}), ...(j?.devDependencies ?? {}) }
  } catch {
    return {}
  }
}

/**
 * L'app mobile d'un projet, ou undefined s'il n'en a pas. Flutter d'abord : pubspec.yaml qui dépend de flutter ; sinon package.json
 * qui dépend d'expo (Expo) ou de react-native (React Native). Plateformes : les dossiers android/ et ios/ présents (sondes, ou la
 * liste des fichiers) ; aucun des deux (Expo géré, dossiers non lus) : les deux. Ne lève jamais.
 */
export function detectMobileApp(input: { files: string[]; read: Record<string, string | undefined>; sondes?: Record<string, boolean>; stack?: string }): MobileApp | undefined {
  try {
    const lus = new Map<string, string>()
    for (const [k, v] of Object.entries(input?.read ?? {})) if (typeof v === 'string') lus.set(norm(k), v)
    const files = (Array.isArray(input?.files) ? input.files : []).filter(f => typeof f === 'string').map(norm)
    const sondes = input?.sondes ?? {}
    const a = (dir: 'android' | 'ios') => sondes[dir] === true || files.some(f => f.startsWith(`${dir}/`))
    const plateformes: ('android' | 'ios')[] = [...(a('android') ? (['android'] as const) : []), ...(a('ios') ? (['ios'] as const) : [])]
    const toutes = plateformes.length ? plateformes : (['android', 'ios'] as ('android' | 'ios')[])

    const pubspec = lus.get('pubspec.yaml')
    if (pubspec && (/^[ \t]+flutter[ \t]*:/m.test(pubspec) || /^[ \t]+sdk[ \t]*:[ \t]*flutter[ \t]*$/m.test(pubspec))) {
      return { framework: 'flutter', plateformes: toutes, origine: 'pubspec.yaml (flutter)' }
    }
    const deps = depsOf(lus.get('package.json'))
    if ('expo' in deps) return { framework: 'expo', plateformes: toutes, origine: 'package.json (expo)' }
    if ('react-native' in deps) return { framework: 'react-native', plateformes: toutes, origine: 'package.json (react-native)' }
    if (typeof input?.stack === 'string' && /\bFlutter\b/.test(input.stack) && pubspec === undefined) {
      return { framework: 'flutter', plateformes: toutes, origine: 'stack' }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** « Flutter », « Expo », « React Native ». */
export function frameworkLabel(f: MobileApp['framework']): string {
  return f === 'flutter' ? 'Flutter' : f === 'expo' ? 'Expo' : 'React Native'
}

// ── Appareils ─────────────────────────────────────────────────────────────

const texte = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * Les appareils de `flutter devices --machine` : le tableau JSON de la sortie (les avertissements qui le précèdent sont ignorés),
 * seuls les appareils Android et iOS pris en charge ; macOS, Windows, Linux et Chrome ne sont pas des appareils mobiles.
 * capture : la capacité screenshot annoncée (fausse sur un iPhone branché). Illisible → vide.
 */
export function parseFlutterDevices(text: string): Appareil[] {
  try {
    const t = texte(text)
    const a = t.indexOf('[')
    const z = t.lastIndexOf(']')
    if (a < 0 || z <= a) return []
    const liste = JSON.parse(t.slice(a, z + 1)) as unknown
    if (!Array.isArray(liste)) return []
    const out: Appareil[] = []
    for (const d of liste as Record<string, unknown>[]) {
      if (!d || typeof d !== 'object' || d.isSupported === false) continue
      const cible = texte(d.targetPlatform)
      const plateforme = cible.startsWith('android') ? 'android' : cible === 'ios' ? 'ios' : undefined
      const id = texte(d.id).trim()
      if (!plateforme || !id) continue
      const emul = d.emulator === true
      const caps = typeof d.capabilities === 'object' && d.capabilities !== null ? (d.capabilities as Record<string, unknown>) : {}
      out.push({
        id,
        nom: texte(d.name).trim() || id,
        plateforme,
        type: emul ? (plateforme === 'ios' ? 'simulateur' : 'emulateur') : 'physique',
        etat: 'connecte',
        ...(texte(d.sdk).trim() ? { sdk: texte(d.sdk).trim() } : {}),
        capture: caps.screenshot !== false,
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Les émulateurs de `flutter emulators` : « Pixel_8 • Pixel 8 • Google • android », « apple_ios_simulator • iOS Simulator • Apple • ios »,
 * éteints (à démarrer par `flutter emulators --launch <id>`). Sans source d'émulateur → vide.
 */
export function parseFlutterEmulators(text: string): Appareil[] {
  const out: Appareil[] = []
  for (const l of texte(text).split(/\r?\n/)) {
    const parts = l.split('•').map(s => s.trim())
    if (parts.length < 3 || !parts[0]) continue
    const plateforme = /^ios$/i.test(parts.at(-1) ?? '') ? 'ios' : /^android$/i.test(parts.at(-1) ?? '') ? 'android' : undefined
    if (!plateforme) continue
    out.push({ id: parts[0], nom: parts[1] || parts[0], plateforme, type: plateforme === 'ios' ? 'simulateur' : 'emulateur', etat: 'eteint' })
  }
  return out
}

/**
 * Les appareils de `adb devices -l` : une ligne « <id>  device product:… model:SM_A515F … » par appareil prêt ; offline et unauthorized
 * sont ignorés. emulator-NNNN est un émulateur, le reste un téléphone branché (USB ou Wi-Fi). Un même modèle vu par deux transports
 * (USB puis mDNS « adb-…._adb-tls-connect._tcp ») n'est gardé qu'une fois, le premier.
 */
export function parseAdbDevices(text: string): Appareil[] {
  const out: Appareil[] = []
  const vus = new Set<string>()
  for (const l of texte(text).split(/\r?\n/)) {
    const m = /^(\S+)\s+(device|offline|unauthorized|no permissions)\b(.*)$/.exec(l.trim())
    if (!m || m[2] !== 'device') continue
    const id = m[1]!
    const model = /\bmodel:(\S+)/.exec(m[3] ?? '')?.[1]
    const nom = model ? model.replace(/_/g, ' ') : id
    const type = id.startsWith('emulator-') ? 'emulateur' : 'physique'
    const cle = `${type}|${nom}`
    if (model && vus.has(cle)) continue
    vus.add(cle)
    out.push({ id, nom, plateforme: 'android', type, etat: 'connecte', capture: true })
  }
  return out
}

/**
 * Les simulateurs iOS de `xcrun simctl list devices --json` : disponibles seulement ; Booted → connecté, sinon éteint ; le runtime
 * (« com.apple.CoreSimulator.SimRuntime.iOS-18-3 ») donne le sdk « iOS 18.3 ». Illisible → vide.
 */
export function parseSimctl(json: string): Appareil[] {
  try {
    const j = JSON.parse(texte(json)) as { devices?: Record<string, unknown> }
    const out: Appareil[] = []
    for (const [runtime, liste] of Object.entries(j?.devices ?? {})) {
      if (!/iOS/i.test(runtime) || !Array.isArray(liste)) continue
      const sdk = /iOS[-.]?(\d+)(?:[-.](\d+))?/.exec(runtime)
      for (const d of liste as Record<string, unknown>[]) {
        if (!d || typeof d !== 'object' || d.isAvailable === false) continue
        const id = texte(d.udid).trim()
        if (!id) continue
        out.push({
          id,
          nom: texte(d.name).trim() || id,
          plateforme: 'ios',
          type: 'simulateur',
          etat: texte(d.state) === 'Booted' ? 'connecte' : 'eteint',
          ...(sdk ? { sdk: `iOS ${sdk[1]}${sdk[2] ? `.${sdk[2]}` : ''}` } : {}),
          capture: true,
        })
      }
    }
    return out
  } catch {
    return []
  }
}

/** Les AVD de `emulator -list-avds` : un nom par ligne (les lignes INFO sont ignorées), éteints. */
export function parseAvds(text: string): Appareil[] {
  return texte(text)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^INFO\b|^WARNING\b|^ERROR\b/.test(l) && !/\s/.test(l))
    .map(l => ({ id: l, nom: l.replace(/_/g, ' '), plateforme: 'android' as const, type: 'emulateur' as const, etat: 'eteint' as const }))
}

/** Plusieurs listes fondues en une, sans doublon d'id (le premier gagne). */
export function mergeDevices(...listes: Appareil[][]): Appareil[] {
  const out: Appareil[] = []
  const vus = new Set<string>()
  for (const l of listes) for (const d of l) if (d && !vus.has(d.id)) {
    vus.add(d.id)
    out.push(d)
  }
  return out
}

/** Le rang d'un appareil pour le choix : branché et capable de capture d'abord, puis émulateur ou simulateur allumé, puis à démarrer. */
function rang(d: Appareil): number {
  const allume = d.etat === 'connecte' ? 0 : 10
  const capture = d.capture === false ? 5 : 0
  const physique = d.type === 'physique' ? 0 : 1
  return allume + capture + physique
}

/**
 * Les appareils candidats pour une app, du meilleur au moins bon : ceux de ses plateformes ; un téléphone branché qui sait faire une
 * capture d'abord, puis un émulateur ou simulateur allumé, puis un téléphone sans capture (iPhone branché), puis ceux à démarrer.
 */
export function rankDevices(appareils: Appareil[], app: MobileApp): Appareil[] {
  const plateformes = new Set(app?.plateformes ?? [])
  return (Array.isArray(appareils) ? appareils : [])
    .filter(d => d && plateformes.has(d.plateforme))
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rang(a.d) - rang(b.d) || a.i - b.i)
    .map(x => x.d)
}

/** « SM A515F (téléphone branché, Android 13 (API 33)) », « Pixel 8 (émulateur, à démarrer) », « iPhone 16 (simulateur allumé) ». */
export function deviceLabel(d: Appareil): string {
  const type = d.type === 'physique' ? 'téléphone branché' : d.type === 'emulateur' ? 'émulateur' : 'simulateur'
  const etat = d.etat === 'connecte' ? (d.type === 'physique' ? '' : ' allumé') : ', à démarrer'
  const sdk = d.sdk && d.etat === 'connecte' ? `, ${d.sdk}` : ''
  return `${d.nom} (${type}${etat}${sdk})`
}

// ── Commandes ─────────────────────────────────────────────────────────────

/** La commande qui lance l'app sur l'appareil (argv sans shell ; le préfixe cmd /c de Windows est ajouté par l'appelant). */
export function runCommand(app: MobileApp, d: Appareil): string[] {
  if (app.framework === 'flutter') return ['flutter', 'run', '-d', d.id]
  if (app.framework === 'expo') return ['npx', 'expo', d.plateforme === 'ios' ? 'run:ios' : 'run:android', '--device', d.id]
  return d.plateforme === 'ios' ? ['npx', 'react-native', 'run-ios', '--udid', d.id] : ['npx', 'react-native', 'run-android', '--deviceId', d.id]
}

/**
 * Les commandes qui démarrent un émulateur ou un simulateur éteint, avec sa fenêtre (jamais -no-window : l'utilisateur regarde) :
 * Flutter sait lancer les deux (flutter emulators --launch) ; sinon `emulator -avd` (processus à garder) ou `xcrun simctl boot` puis
 * `open -a Simulator` pour montrer la fenêtre. `garder` : le processus est l'émulateur lui-même, à garder ouvert.
 */
export function launchCommands(app: MobileApp, d: Appareil): { argv: string[]; garder: boolean }[] {
  if (app.framework === 'flutter') return [{ argv: ['flutter', 'emulators', '--launch', d.id], garder: false }]
  if (d.plateforme === 'ios') {
    return [
      { argv: ['xcrun', 'simctl', 'boot', d.id], garder: false },
      { argv: ['open', '-a', 'Simulator'], garder: false },
    ]
  }
  return [{ argv: ['emulator', '-avd', d.id], garder: true }]
}

/** La commande qui éteint un émulateur ou un simulateur que revo-flow a démarré. */
export function shutdownCommand(d: Appareil): string[] {
  return d.plateforme === 'ios' ? ['xcrun', 'simctl', 'shutdown', d.id] : ['adb', '-s', d.id, 'emu', 'kill']
}

/** Les commandes qui listent les appareils connectés, selon l'app et le poste (simctl sur macOS seulement). */
export function listCommands(app: MobileApp, os: 'windows' | 'posix' | 'darwin'): { argv: string[]; parse: (text: string) => Appareil[] }[] {
  const out: { argv: string[]; parse: (text: string) => Appareil[] }[] = []
  if (app.framework === 'flutter') {
    out.push({ argv: ['flutter', 'devices', '--machine'], parse: parseFlutterDevices }, { argv: ['flutter', 'emulators'], parse: parseFlutterEmulators })
    return out
  }
  if (app.plateformes.includes('android')) out.push({ argv: ['adb', 'devices', '-l'], parse: parseAdbDevices }, { argv: ['emulator', '-list-avds'], parse: parseAvds })
  if (app.plateformes.includes('ios') && os === 'darwin') out.push({ argv: ['xcrun', 'simctl', 'list', 'devices', 'available', '--json'], parse: parseSimctl })
  return out
}

/**
 * L'émulateur ou le simulateur qui vient de s'allumer : pour un simulateur iOS, lui-même quand simctl le dit Booted ; pour un AVD
 * Android, l'emulator-NNNN connecté qui n'était pas là avant (adb ne connaît pas le nom de l'AVD). undefined tant qu'il n'y est pas.
 */
export function bootedDevice(lance: Appareil, avant: Appareil[], apres: Appareil[]): Appareil | undefined {
  if (lance.plateforme === 'ios') return apres.find(d => d.id === lance.id && d.etat === 'connecte')
  const connus = new Set(avant.filter(d => d.etat === 'connecte').map(d => d.id))
  return apres.find(d => d.plateforme === 'android' && d.type === 'emulateur' && d.etat === 'connecte' && !connus.has(d.id))
}

/** La commande telle qu'un humain la tape : « flutter run -d emulator-5554 ». */
export const commandeMobile = (argv: string[]) => (Array.isArray(argv) ? argv : []).join(' ')

// ── Sortie du lancement ───────────────────────────────────────────────────

/** Une sortie de terminal sans ses codes ANSI ni ses séquences OSC. */
function sansAnsi(text: string): string {
  return texte(text).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/**
 * L'app est-elle lancée d'après la sortie ? Flutter : « A Dart VM Service on … is available at: <url> » (l'URL est rendue), « Flutter run
 * key commands » ou « Syncing files to device ». Expo et React Native : « Starting the app », « Opening on », « Successfully launched »,
 * « Bundling complete », « Bundled ». undefined tant que rien ne le dit.
 */
export function appReadyFromOutput(text: string): { vmService?: string } | undefined {
  const t = sansAnsi(text)
  const vm = /A Dart VM Service on .* is available at:\s*(https?:\/\/\S+)/.exec(t)
  if (vm) return { vmService: vm[1]! }
  if (/Flutter run key commands|Syncing files to device|An Observatory debugger/.test(t)) return {}
  if (/Starting the app|Opening (?:on|the app)|Successfully launched|Bundling complete|(?:Android|iOS) Bundled|Launching app/i.test(t)) return {}
  return undefined
}

/**
 * Le lancement a-t-il échoué d'après la sortie ? La ligne d'erreur (200 caractères), ou undefined : « Error launching application »,
 * « No supported devices », « Gradle task … failed », « FAILURE: Build failed », « Could not build », « The following build commands
 * failed », « error: no such device », « Unable to locate a development device », « Error: Command failed ».
 */
export function appFailedFromOutput(text: string): string | undefined {
  for (const l of sansAnsi(text).split(/\r?\n/)) {
    if (
      /Error launching application|No supported devices|Gradle task .* failed|FAILURE: Build failed|Could not build|The following build commands failed|error: no such device|Unable to locate a development device|Error: Command failed|No devices? found|is not a valid device|Could not find a (?:device|simulator)/i.test(
        l,
      )
    )
      return l.trim().slice(0, 200)
  }
  return undefined
}

/**
 * Les ennuis vus dans le journal de l'app : exceptions Flutter (« EXCEPTION CAUGHT BY »), débordements de rendu (« overflowed by »),
 * erreurs React Native ou Android (« ERROR », « FATAL EXCEPTION », « E/ », lignes « E » de logcat).
 */
export function countIssues(text: string): { exceptions: number; debordements: number; erreurs: number } {
  const t = sansAnsi(text)
  const n = (re: RegExp) => (t.match(re) ?? []).length
  return {
    exceptions: n(/EXCEPTION CAUGHT BY/g),
    debordements: n(/overflowed by/g),
    erreurs: n(/^(?:.*\b(?:FATAL EXCEPTION|ERROR\b)|E\/|\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+E\s)/gm),
  }
}

/** Les n dernières lignes non vides d'une sortie, sans codes ANSI. */
export function tailLines(text: string, n: number): string {
  const lines = sansAnsi(text)
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
  return lines.slice(-Math.max(1, n)).join('\n')
}

// ── Observation de l'appareil ─────────────────────────────────────────────

/**
 * Les commandes d'une capture d'écran vers `out` (chemin absolu .png), dans l'ordre : Flutter avec capture possible →
 * `flutter screenshot` ; Android → screencap sur l'appareil puis pull ; simulateur iOS → simctl io screenshot ; iPhone branché sans
 * Flutter → undefined (pas de capture sans outil tiers).
 */
export function captureCommands(app: MobileApp, d: Appareil, out: string): string[][] | undefined {
  if (app.framework === 'flutter' && d.capture !== false) return [['flutter', 'screenshot', '-d', d.id, '-o', out]]
  if (d.plateforme === 'android') {
    return [
      ['adb', '-s', d.id, 'shell', 'screencap', '-p', '/sdcard/revo-flow-capture.png'],
      ['adb', '-s', d.id, 'pull', '/sdcard/revo-flow-capture.png', out],
    ]
  }
  if (d.type === 'simulateur') return [['xcrun', 'simctl', 'io', d.id, 'screenshot', out]]
  return undefined
}

/** Les commandes de l'arbre des vues (Android : uiautomator dump puis cat) ; iOS → undefined. */
export function treeCommands(d: Appareil): string[][] | undefined {
  if (d.plateforme !== 'android') return undefined
  return [
    ['adb', '-s', d.id, 'shell', 'uiautomator', 'dump', '/sdcard/revo-flow-ui.xml'],
    ['adb', '-s', d.id, 'shell', 'cat', '/sdcard/revo-flow-ui.xml'],
  ]
}

/** La commande du journal de l'appareil (Android : logcat des 200 dernières erreurs) ; iOS → undefined (le journal de l'app suffit). */
export function logCommand(d: Appareil): string[] | undefined {
  return d.plateforme === 'android' ? ['adb', '-s', d.id, 'logcat', '-d', '-t', '200', '*:E'] : undefined
}

const entier = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
}

/**
 * La commande d'un geste sur l'appareil (Android par adb ; iOS → undefined) : toucher (x, y), glisser (x1, y1, x2, y2), texte (saisie,
 * espaces en %s), touche (retour, accueil, entree). Coordonnées illisibles → undefined.
 */
export function gestureCommand(d: Appareil, action: 'toucher' | 'glisser' | 'texte' | 'touche', input: Record<string, unknown>): string[] | undefined {
  if (!d || d.plateforme !== 'android') return undefined
  const i = typeof input === 'object' && input !== null ? input : {}
  const adb = ['adb', '-s', d.id, 'shell', 'input']
  if (action === 'toucher') {
    const x = entier(i.x)
    const y = entier(i.y)
    return x === undefined || y === undefined ? undefined : [...adb, 'tap', String(x), String(y)]
  }
  if (action === 'glisser') {
    const c = [i.x1, i.y1, i.x2, i.y2].map(entier)
    return c.some(v => v === undefined) ? undefined : [...adb, 'swipe', ...c.map(v => String(v)), '300']
  }
  if (action === 'texte') {
    const t = typeof i.texte === 'string' ? i.texte : ''
    return t === '' ? undefined : [...adb, 'text', t.replace(/\s/g, '%s')]
  }
  const touche = typeof i.touche === 'string' ? i.touche.toLowerCase() : ''
  const code = touche === 'retour' || touche === 'back' ? '4' : touche === 'accueil' || touche === 'home' ? '3' : touche === 'entree' || touche === 'enter' ? '66' : undefined
  return code === undefined ? undefined : [...adb, 'keyevent', code]
}

/** Lignes de l'arbre condensé rendues au plus. */
const ARBRE_MAX = 120

/**
 * L'arbre des vues d'uiautomator, condensé pour le vérificateur : une ligne par nœud qui a un texte, une description ou un id cliquable :
 * « Button « Payer » · centre 540,1660 · cliquable » ; les bornes donnent le centre (pour toucher). 120 lignes au plus.
 */
export function condenseUiTree(xml: string): string {
  const lignes: string[] = []
  let total = 0
  for (const m of texte(xml).matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? ''
    const attr = (k: string) => {
      const a = new RegExp(`\\b${k}="([^"]*)"`).exec(attrs)
      return a ? a[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'") : ''
    }
    const text = attr('text')
    const desc = attr('content-desc')
    const id = attr('resource-id')
    const cliquable = attr('clickable') === 'true'
    if (!text && !desc && !(id && cliquable)) continue
    total++
    if (lignes.length >= ARBRE_MAX) continue
    const classe = attr('class').split('.').pop() || 'View'
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'))
    const centre = b ? ` · centre ${Math.round((Number(b[1]) + Number(b[3])) / 2)},${Math.round((Number(b[2]) + Number(b[4])) / 2)}` : ''
    const parts = [classe]
    if (text) parts.push(`« ${text} »`)
    if (desc && desc !== text) parts.push(`[${desc}]`)
    if (id) parts.push(`#${id.split('/').pop()}`)
    const flags = [cliquable ? 'cliquable' : '', attr('enabled') === 'false' ? 'désactivé' : '', attr('checked') === 'true' ? 'coché' : '', attr('focused') === 'true' ? 'focus' : ''].filter(Boolean)
    lignes.push(`${parts.join(' ')}${centre}${flags.length ? ` · ${flags.join(', ')}` : ''}`)
  }
  if (total > lignes.length) lignes.push(`… et ${total - lignes.length} autres nœuds`)
  return lignes.join('\n')
}

// ── Outils mobile du vérificateur ─────────────────────────────────────────

/** Le nom du serveur MCP mobile-mcp déclaré pour le vérificateur (option mobile mcp) : ses outils sont mcp__mobile-mcp__*. */
export const MOBILE_MCP = 'mobile-mcp'

/** L'outil est-il un outil du serveur mobile-mcp (option mcp) ? */
export function isMobileMcpTool(tool: string): boolean {
  return typeof tool === 'string' && tool.startsWith(`mcp__${MOBILE_MCP}__`)
}

const FERMEE =
  'revo-flow : la preuve mobile n’est pas ouverte. Demande d’abord l’app avec l’outil mcp__revo-flow__verif (action mobile) ; sans app lancée, le critère est non vérifiable.'

/**
 * Pourquoi l'appel de cet outil mobile-mcp est refusé au vérificateur, ou undefined s'il est permis (ou n'est pas un outil mobile-mcp) :
 * fermé tant que l'app n'est pas prête sur l'appareil accordé. Ne lève jamais.
 */
export function mobileToolDenial(tool: string, mobile: { etat: MobileEtat } | undefined): string | undefined {
  try {
    if (!isMobileMcpTool(tool)) return undefined
    return mobile?.etat === 'pret' ? undefined : FERMEE
  } catch {
    return FERMEE
  }
}

/**
 * Le paragraphe « ## Preuve mobile » ajouté à la tâche du vérificateur : désactivée, sans app détectée, ou ouverte avec l'app, les
 * appareils vus, l'outil mobile et ses actions, et les règles. L'utilisateur regarde l'appareil : chaque action va au panneau.
 */
export function verifierMobileTask(d: MobileDispo): string {
  const titre = '## Preuve mobile'
  if (!d || d.option === 'off')
    return [
      titre,
      'La preuve mobile est désactivée pour ce projet (option mobile) : un critère qui demande de voir l’application sur un appareil est non vérifiable. Dis-le et vérifie à côté ce que les commandes permettent.',
    ].join('\n')
  if (!d.app)
    return [
      titre,
      'Aucune app mobile détectée (ni pubspec.yaml Flutter, ni react-native ou expo dans package.json) : un critère qui demande de voir l’application sur un appareil est non vérifiable. Dis-le et vérifie à côté ce que les commandes permettent.',
    ].join('\n')
  const appareils = d.appareils?.length ? ` Appareils vus : ${d.appareils.map(deviceLabel).join(', ')}.` : ''
  const mcp = d.option === 'mcp' ? ' En plus, les outils mcp__mobile-mcp__* (liste des éléments, toucher, glisser, saisie, capture) sont permis une fois l’app lancée, sur cet appareil seulement.' : ''
  return [
    titre,
    `Ce projet est une app mobile ${frameworkLabel(d.app.framework)} (${d.app.origine}, ${d.app.plateformes.join(' et ')}).${appareils} Pour un critère qui se voit dans l’application (écran, texte affiché, navigation, exception, débordement), ouvre la preuve mobile :`,
    '- Appelle l’outil mcp__revo-flow__verif avec action "mobile" : revo-flow choisit l’appareil (téléphone branché, sinon émulateur ou simulateur, démarré avec sa fenêtre si besoin), demande à l’utilisateur, lance l’app et te dit quand elle est à l’écran, ou pourquoi non. Sans app lancée, le critère est non vérifiable.',
    `- Ensuite, l’outil mcp__revo-flow__mobile : capture (écrit capture-n.png ; lis-la avec Read pour la voir), arbre (les vues à l’écran avec le centre de chacune, Android), journal (exceptions, débordements et erreurs de l’app), toucher (x, y), glisser (x1, y1, x2, y2), texte (saisie), touche (retour, accueil, entree). Sur iOS, seules capture et journal existent.${mcp}`,
    '- L’utilisateur regarde l’appareil pendant que tu agis : une action à la fois, lisible, et une capture avant de juger.',
    '- Une preuve mobile cite l’écran vu (texte de l’arbre ou de la capture), le nombre d’exceptions, de débordements et d’erreurs du journal, et dit « capture n ». Une capture seule n’est pas une preuve.',
    '- Marque ces verdicts "mobile": true dans le bloc json.',
    '- Tu n’arrêtes ni l’app ni l’émulateur : revo-flow le fait à la fin du flow.',
  ].join('\n')
}
