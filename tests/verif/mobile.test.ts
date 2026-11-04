import { describe, expect, test } from 'claude-code/testing'

import {
  EMULATEUR_ATTENTE_MS,
  MOBILE_ATTENTE_MS,
  appFailedFromOutput,
  appReadyFromOutput,
  bootedDevice,
  captureCommands,
  commandeMobile,
  condenseUiTree,
  countIssues,
  detectMobileApp,
  deviceLabel,
  gestureCommand,
  isMobileMcpTool,
  launchCommands,
  listCommands,
  logCommand,
  mergeDevices,
  mobileToolDenial,
  parseAdbDevices,
  parseAvds,
  parseFlutterDevices,
  parseFlutterEmulators,
  parseSimctl,
  rankDevices,
  runCommand,
  shutdownCommand,
  tailLines,
  treeCommands,
  verifierMobileTask,
} from '../../hooks/verif/mobile'
import type { Appareil, MobileApp } from '../../types/verif'

const PUBSPEC = ['name: router_app', 'environment:', "  sdk: '>=3.0.0 <4.0.0'", 'dependencies:', '  flutter:', '    sdk: flutter', '  go_router: ^14.0.0'].join('\n')
const PUBSPEC_DART = ['name: outil', 'dependencies:', '  args: ^2.0.0'].join('\n')
const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'app', dependencies: deps })

const FLUTTER: MobileApp = { framework: 'flutter', plateformes: ['android', 'ios'], origine: 'pubspec.yaml (flutter)' }
const RN: MobileApp = { framework: 'react-native', plateformes: ['android'], origine: 'package.json (react-native)' }

const A51: Appareil = { id: '192.168.1.13:40481', nom: 'SM A515F', plateforme: 'android', type: 'physique', etat: 'connecte', sdk: 'Android 13 (API 33)', capture: true }
const IPHONE: Appareil = { id: '00008140-00007969262B001C', nom: 'iPhone de Lilian', plateforme: 'ios', type: 'physique', etat: 'connecte', sdk: 'iOS 27.2', capture: false }
const PIXEL: Appareil = { id: 'Pixel_8', nom: 'Pixel 8', plateforme: 'android', type: 'emulateur', etat: 'eteint' }
const SIM: Appareil = { id: 'ABCD-1234', nom: 'iPhone 16', plateforme: 'ios', type: 'simulateur', etat: 'connecte', sdk: 'iOS 18.3', capture: true }

// ── detectMobileApp ──────────────────────────────────────────────────────

describe('detectMobileApp', () => {
  test('Flutter : pubspec.yaml qui dépend de flutter ; plateformes d’après les dossiers android/ et ios/ sondés', () => {
    expect(detectMobileApp({ files: ['lib/main.dart'], read: { 'pubspec.yaml': PUBSPEC }, sondes: { android: true, ios: false } })).toEqual({
      framework: 'flutter',
      plateformes: ['android'],
      origine: 'pubspec.yaml (flutter)',
    })
    // Sans dossier sondé ni fichier de plateforme : les deux.
    expect(detectMobileApp({ files: [], read: { 'pubspec.yaml': PUBSPEC } })?.plateformes).toEqual(['android', 'ios'])
    // Les fichiers de la liste suffisent.
    expect(detectMobileApp({ files: ['ios/Runner/Info.plist'], read: { 'pubspec.yaml': PUBSPEC } })?.plateformes).toEqual(['ios'])
  })

  test('Expo avant React Native ; React Native seul ; Dart pur, web ou rien : pas d’app', () => {
    expect(detectMobileApp({ files: [], read: { 'package.json': pkg({ expo: '~51.0.0', 'react-native': '0.74.0' }) } })).toEqual({ framework: 'expo', plateformes: ['android', 'ios'], origine: 'package.json (expo)' })
    expect(detectMobileApp({ files: ['android/build.gradle'], read: { 'package.json': pkg({ 'react-native': '0.74.0' }) }, sondes: { android: true } })).toEqual({
      framework: 'react-native',
      plateformes: ['android'],
      origine: 'package.json (react-native)',
    })
    expect(detectMobileApp({ files: [], read: { 'pubspec.yaml': PUBSPEC_DART } })).toBeUndefined()
    expect(detectMobileApp({ files: [], read: { 'package.json': pkg({ nuxt: '^3.9.0' }) } })).toBeUndefined()
    expect(detectMobileApp({ files: [], read: {} })).toBeUndefined()
    expect(detectMobileApp({ files: [], read: { 'package.json': '{ pas du json' } })).toBeUndefined()
  })

  test('Flutter d’après la stack quand pubspec.yaml n’a pas été lu', () => {
    expect(detectMobileApp({ files: [], read: {}, stack: 'Flutter, Riverpod' })?.framework).toBe('flutter')
    expect(detectMobileApp({ files: [], read: { 'pubspec.yaml': PUBSPEC_DART }, stack: 'Flutter' })).toBeUndefined()
  })
})

// ── Appareils ─────────────────────────────────────────────────────────────

const DEVICES_JSON = [
  'Error 1 retrieving device properties for SM A515F:',
  'adb: device not found',
  '',
  JSON.stringify([
    { name: 'SM A515F', id: '192.168.1.13:40481', isSupported: true, targetPlatform: 'android-arm64', emulator: false, sdk: 'Android 13 (API 33)', capabilities: { screenshot: true } },
    { name: 'SM A515F', id: 'adb-R58N-8y4roB', isSupported: false, targetPlatform: 'unsupported', emulator: false, sdk: 'Android null', capabilities: { screenshot: true } },
    { name: 'iPhone de Lilian ', id: '00008140-00007969262B001C', isSupported: true, targetPlatform: 'ios', emulator: false, sdk: 'iOS 27.2 24B119', capabilities: { screenshot: false } },
    { name: 'sdk gphone64 arm64', id: 'emulator-5554', isSupported: true, targetPlatform: 'android-arm64', emulator: true, sdk: 'Android 14 (API 34)', capabilities: { screenshot: true } },
    { name: 'iPhone 16', id: 'ABCD-1234', isSupported: true, targetPlatform: 'ios', emulator: true, sdk: 'iOS 18.3', capabilities: { screenshot: true } },
    { name: 'macOS', id: 'macos', isSupported: true, targetPlatform: 'darwin', emulator: false, sdk: 'macOS 15', capabilities: { screenshot: false } },
    { name: 'Chrome', id: 'chrome', isSupported: true, targetPlatform: 'web-javascript', emulator: false, sdk: 'Edge 156', capabilities: { screenshot: false } },
  ]),
].join('\n')

describe('appareils', () => {
  test('parseFlutterDevices : Android et iOS pris en charge, téléphone, émulateur et simulateur ; ni macOS ni Chrome ; capture d’après screenshot', () => {
    const d = parseFlutterDevices(DEVICES_JSON)
    expect(d.map(x => x.id)).toEqual(['192.168.1.13:40481', '00008140-00007969262B001C', 'emulator-5554', 'ABCD-1234'])
    expect(d[0]).toEqual({ id: '192.168.1.13:40481', nom: 'SM A515F', plateforme: 'android', type: 'physique', etat: 'connecte', sdk: 'Android 13 (API 33)', capture: true })
    expect(d[1]).toMatchObject({ nom: 'iPhone de Lilian', plateforme: 'ios', type: 'physique', capture: false })
    expect(d[2]).toMatchObject({ type: 'emulateur', plateforme: 'android' })
    expect(d[3]).toMatchObject({ type: 'simulateur', plateforme: 'ios', capture: true })
    expect(parseFlutterDevices('Unable to find any devices')).toEqual([])
    expect(parseFlutterDevices('[ pas du json')).toEqual([])
  })

  test('parseFlutterEmulators : un émulateur Android et le simulateur iOS, éteints ; rien sans source', () => {
    const t = ['Pixel_8 • Pixel 8 • Google • android', 'apple_ios_simulator • iOS Simulator • Apple • ios', '', 'To run an emulator, run flutter emulators --launch <emulator id>.'].join('\n')
    expect(parseFlutterEmulators(t)).toEqual([
      { id: 'Pixel_8', nom: 'Pixel 8', plateforme: 'android', type: 'emulateur', etat: 'eteint' },
      { id: 'apple_ios_simulator', nom: 'iOS Simulator', plateforme: 'ios', type: 'simulateur', etat: 'eteint' },
    ])
    expect(parseFlutterEmulators('Unable to find any emulator sources.')).toEqual([])
  })

  test('parseAdbDevices : les appareils « device » seuls, modèle lisible, émulateur reconnu, doublon mDNS du même téléphone écarté', () => {
    const t = [
      'List of devices attached',
      '192.168.1.13:40481     device product:a51nseea model:SM_A515F device:a51 transport_id:5',
      'adb-R58N72APNFT-8y4roB._adb-tls-connect._tcp device product:a51nseea model:SM_A515F device:a51 transport_id:18',
      'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:3',
      'ZY22FXXX               unauthorized',
      'ZY22FYYY               offline',
      '',
    ].join('\n')
    expect(parseAdbDevices(t)).toEqual([
      { id: '192.168.1.13:40481', nom: 'SM A515F', plateforme: 'android', type: 'physique', etat: 'connecte', capture: true },
      { id: 'emulator-5554', nom: 'sdk gphone64 arm64', plateforme: 'android', type: 'emulateur', etat: 'connecte', capture: true },
    ])
    expect(parseAdbDevices('List of devices attached\n\n')).toEqual([])
  })

  test('parseSimctl : simulateurs iOS disponibles, Booted connecté sinon éteint, sdk d’après le runtime ; parseAvds', () => {
    const j = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-3': [
          { udid: 'ABCD-1234', name: 'iPhone 16', state: 'Booted', isAvailable: true },
          { udid: 'EFGH-5678', name: 'iPad Air', state: 'Shutdown', isAvailable: true },
          { udid: 'IJKL-9012', name: 'iPhone 15', state: 'Shutdown', isAvailable: false },
        ],
        'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'WXYZ', name: 'Apple Watch', state: 'Shutdown', isAvailable: true }],
      },
    })
    expect(parseSimctl(j)).toEqual([
      { id: 'ABCD-1234', nom: 'iPhone 16', plateforme: 'ios', type: 'simulateur', etat: 'connecte', sdk: 'iOS 18.3', capture: true },
      { id: 'EFGH-5678', nom: 'iPad Air', plateforme: 'ios', type: 'simulateur', etat: 'eteint', sdk: 'iOS 18.3', capture: true },
    ])
    expect(parseSimctl('{"devices":{}}')).toEqual([])
    expect(parseSimctl('pas du json')).toEqual([])
    expect(parseAvds('INFO    | Storing crashdata in: /tmp\nPixel_8\nPixel_Tablet\n')).toEqual([
      { id: 'Pixel_8', nom: 'Pixel 8', plateforme: 'android', type: 'emulateur', etat: 'eteint' },
      { id: 'Pixel_Tablet', nom: 'Pixel Tablet', plateforme: 'android', type: 'emulateur', etat: 'eteint' },
    ])
  })

  test('mergeDevices : sans doublon d’id, le premier gagne', () => {
    expect(mergeDevices([A51], [{ ...A51, nom: 'autre' }, PIXEL], [PIXEL]).map(d => d.nom)).toEqual(['SM A515F', 'Pixel 8'])
  })

  test('rankDevices : téléphone branché avec capture, puis émulateur ou simulateur allumé, puis iPhone sans capture, puis à démarrer ; plateformes de l’app', () => {
    const all = [PIXEL, IPHONE, SIM, A51]
    expect(rankDevices(all, FLUTTER).map(d => d.nom)).toEqual(['SM A515F', 'iPhone 16', 'iPhone de Lilian', 'Pixel 8'])
    expect(rankDevices(all, RN).map(d => d.nom)).toEqual(['SM A515F', 'Pixel 8'])
    expect(rankDevices([], FLUTTER)).toEqual([])
  })

  test('deviceLabel', () => {
    expect(deviceLabel(A51)).toBe('SM A515F (téléphone branché, Android 13 (API 33))')
    expect(deviceLabel(PIXEL)).toBe('Pixel 8 (émulateur, à démarrer)')
    expect(deviceLabel(SIM)).toBe('iPhone 16 (simulateur allumé, iOS 18.3)')
  })

  test('bootedDevice : le simulateur lui-même une fois Booted ; l’emulator-NNNN nouveau pour un AVD', () => {
    const simEteint = { ...SIM, etat: 'eteint' as const }
    expect(bootedDevice(simEteint, [simEteint], [simEteint])).toBeUndefined()
    expect(bootedDevice(simEteint, [simEteint], [SIM])?.id).toBe('ABCD-1234')
    const emu: Appareil = { id: 'emulator-5554', nom: 'sdk gphone64', plateforme: 'android', type: 'emulateur', etat: 'connecte' }
    expect(bootedDevice(PIXEL, [A51, PIXEL], [A51, PIXEL])).toBeUndefined()
    expect(bootedDevice(PIXEL, [A51, PIXEL], [A51, emu])?.id).toBe('emulator-5554')
    // Un émulateur déjà connecté avant n'est pas celui qu'on vient de lancer.
    expect(bootedDevice(PIXEL, [emu], [emu])).toBeUndefined()
  })
})

// ── Commandes ─────────────────────────────────────────────────────────────

describe('commandes', () => {
  test('runCommand : flutter run -d ; expo run:android --device ; react-native run-android --deviceId, run-ios --udid', () => {
    expect(runCommand(FLUTTER, A51)).toEqual(['flutter', 'run', '-d', '192.168.1.13:40481'])
    expect(commandeMobile(runCommand(FLUTTER, A51))).toBe('flutter run -d 192.168.1.13:40481')
    expect(runCommand({ ...RN, framework: 'expo' }, A51)).toEqual(['npx', 'expo', 'run:android', '--device', '192.168.1.13:40481'])
    expect(runCommand({ ...RN, framework: 'expo' }, SIM)).toEqual(['npx', 'expo', 'run:ios', '--device', 'ABCD-1234'])
    expect(runCommand(RN, A51)).toEqual(['npx', 'react-native', 'run-android', '--deviceId', '192.168.1.13:40481'])
    expect(runCommand(RN, SIM)).toEqual(['npx', 'react-native', 'run-ios', '--udid', 'ABCD-1234'])
  })

  test('launchCommands : avec fenêtre, jamais -no-window ; flutter emulators --launch, emulator -avd gardé, simctl boot puis open Simulator', () => {
    expect(launchCommands(FLUTTER, PIXEL)).toEqual([{ argv: ['flutter', 'emulators', '--launch', 'Pixel_8'], garder: false }])
    expect(launchCommands(RN, PIXEL)).toEqual([{ argv: ['emulator', '-avd', 'Pixel_8'], garder: true }])
    expect(launchCommands(RN, { ...SIM, etat: 'eteint' })).toEqual([
      { argv: ['xcrun', 'simctl', 'boot', 'ABCD-1234'], garder: false },
      { argv: ['open', '-a', 'Simulator'], garder: false },
    ])
    for (const app of [FLUTTER, RN]) for (const c of launchCommands(app, PIXEL)) expect(c.argv.join(' ')).not.toContain('no-window')
    expect(shutdownCommand({ ...PIXEL, id: 'emulator-5554' })).toEqual(['adb', '-s', 'emulator-5554', 'emu', 'kill'])
    expect(shutdownCommand(SIM)).toEqual(['xcrun', 'simctl', 'shutdown', 'ABCD-1234'])
  })

  test('listCommands : Flutter lit flutter devices et flutter emulators ; sinon adb, emulator et simctl (macOS seulement)', () => {
    expect(listCommands(FLUTTER, 'darwin').map(c => c.argv)).toEqual([
      ['flutter', 'devices', '--machine'],
      ['flutter', 'emulators'],
    ])
    expect(listCommands({ ...RN, plateformes: ['android', 'ios'] }, 'darwin').map(c => c.argv[0])).toEqual(['adb', 'emulator', 'xcrun'])
    expect(listCommands({ ...RN, plateformes: ['android', 'ios'] }, 'windows').map(c => c.argv[0])).toEqual(['adb', 'emulator'])
    expect(listCommands(RN, 'darwin').map(c => c.argv[0])).toEqual(['adb', 'emulator'])
  })

  test('captureCommands : flutter screenshot quand l’appareil le permet ; adb screencap puis pull ; simctl io ; rien pour un iPhone branché sans Flutter', () => {
    expect(captureCommands(FLUTTER, A51, '/s/capture-1.png')).toEqual([['flutter', 'screenshot', '-d', '192.168.1.13:40481', '-o', '/s/capture-1.png']])
    expect(captureCommands(FLUTTER, IPHONE, '/s/c.png')).toBeUndefined()
    expect(captureCommands(RN, A51, '/s/c.png')).toEqual([
      ['adb', '-s', '192.168.1.13:40481', 'shell', 'screencap', '-p', '/sdcard/revo-flow-capture.png'],
      ['adb', '-s', '192.168.1.13:40481', 'pull', '/sdcard/revo-flow-capture.png', '/s/c.png'],
    ])
    expect(captureCommands(RN, SIM, '/s/c.png')).toEqual([['xcrun', 'simctl', 'io', 'ABCD-1234', 'screenshot', '/s/c.png']])
    expect(captureCommands(RN, IPHONE, '/s/c.png')).toBeUndefined()
  })

  test('treeCommands, logCommand : Android seulement', () => {
    expect(treeCommands(A51)?.map(a => a.slice(4))).toEqual([
      ['uiautomator', 'dump', '/sdcard/revo-flow-ui.xml'],
      ['cat', '/sdcard/revo-flow-ui.xml'],
    ])
    expect(treeCommands(SIM)).toBeUndefined()
    expect(logCommand(A51)).toEqual(['adb', '-s', '192.168.1.13:40481', 'logcat', '-d', '-t', '200', '*:E'])
    expect(logCommand(SIM)).toBeUndefined()
  })

  test('gestureCommand : tap, swipe, text (espaces en %s), keyevent ; coordonnées illisibles ou iOS → undefined', () => {
    const adb = ['adb', '-s', '192.168.1.13:40481', 'shell', 'input']
    expect(gestureCommand(A51, 'toucher', { x: 540, y: 1660.4 })).toEqual([...adb, 'tap', '540', '1660'])
    expect(gestureCommand(A51, 'toucher', { x: '12', y: '34' })).toEqual([...adb, 'tap', '12', '34'])
    expect(gestureCommand(A51, 'toucher', { x: 540 })).toBeUndefined()
    expect(gestureCommand(A51, 'toucher', { x: -1, y: 2 })).toBeUndefined()
    expect(gestureCommand(A51, 'glisser', { x1: 500, y1: 1500, x2: 500, y2: 300 })).toEqual([...adb, 'swipe', '500', '1500', '500', '300', '300'])
    expect(gestureCommand(A51, 'texte', { texte: 'salle 12' })).toEqual([...adb, 'text', 'salle%s12'])
    expect(gestureCommand(A51, 'texte', {})).toBeUndefined()
    expect(gestureCommand(A51, 'touche', { touche: 'retour' })).toEqual([...adb, 'keyevent', '4'])
    expect(gestureCommand(A51, 'touche', { touche: 'accueil' })).toEqual([...adb, 'keyevent', '3'])
    expect(gestureCommand(A51, 'touche', { touche: 'entree' })).toEqual([...adb, 'keyevent', '66'])
    expect(gestureCommand(A51, 'touche', { touche: 'x' })).toBeUndefined()
    expect(gestureCommand(SIM, 'toucher', { x: 1, y: 1 })).toBeUndefined()
  })
})

// ── Sortie du lancement ───────────────────────────────────────────────────

describe('sortie du lancement', () => {
  test('appReadyFromOutput : l’URL du VM Service Dart, les commandes de flutter run, Expo et React Native ; rien avant', () => {
    expect(appReadyFromOutput('Launching lib/main.dart on SM A515F in debug mode...\nRunning Gradle task \'assembleDebug\'...')).toBeUndefined()
    expect(appReadyFromOutput('\x1b[32m✓\x1b[0m Built build/app/outputs/flutter-apk/app-debug.apk.\nA Dart VM Service on SM A515F is available at: http://127.0.0.1:61234/abcDEF=/\n')).toEqual({ vmService: 'http://127.0.0.1:61234/abcDEF=/' })
    expect(appReadyFromOutput('Flutter run key commands.\nr Hot reload.')).toEqual({})
    expect(appReadyFromOutput('info Starting the app on 192.168.1.13:40481...')).toEqual({})
    expect(appReadyFromOutput('› Opening on SM A515F')).toEqual({})
    expect(appReadyFromOutput('Android Bundled 1234ms index.js')).toEqual({})
  })

  test('appFailedFromOutput : la ligne d’erreur de build ou de pose ; rien sinon', () => {
    expect(appFailedFromOutput("Running Gradle task 'assembleDebug'...\nFAILURE: Build failed with an exception.\n* What went wrong:")).toBe('FAILURE: Build failed with an exception.')
    expect(appFailedFromOutput('Error launching application on SM A515F.')).toBe('Error launching application on SM A515F.')
    expect(appFailedFromOutput('No supported devices found with name or id matching \'x\'.')).toContain('No supported devices')
    expect(appFailedFromOutput('error: no such device')).toBe('error: no such device')
    expect(appFailedFromOutput('Launching lib/main.dart on SM A515F in debug mode...')).toBeUndefined()
  })

  test('countIssues et tailLines', () => {
    const t = [
      'I/flutter ( 1234): ══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞════',
      'I/flutter ( 1234): The following assertion was thrown building ReservationCard:',
      'I/flutter ( 1234): A RenderFlex overflowed by 42 pixels on the right.',
      '',
      '11-04 10:00:00.123  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main',
      'E/ReactNativeJS( 1234): TypeError: undefined is not a function',
      'ok',
    ].join('\n')
    expect(countIssues(t)).toEqual({ exceptions: 1, debordements: 1, erreurs: 2 })
    expect(countIssues('')).toEqual({ exceptions: 0, debordements: 0, erreurs: 0 })
    expect(tailLines(t, 2)).toBe('E/ReactNativeJS( 1234): TypeError: undefined is not a function\nok')
    expect(tailLines('\x1b[31mrouge\x1b[0m\n\n', 5)).toBe('rouge')
  })

  test('délais : 5 min pour l’app, 3 min pour l’émulateur', () => {
    expect(MOBILE_ATTENTE_MS).toBe(300_000)
    expect(EMULATEUR_ATTENTE_MS).toBe(180_000)
  })
})

// ── Arbre des vues ────────────────────────────────────────────────────────

test('condenseUiTree : une ligne par vue avec texte, description ou id cliquable, le centre d’après bounds, entités décodées, 120 lignes au plus', () => {
  const xml = [
    '<?xml version=\'1.0\' encoding=\'UTF-8\' standalone=\'yes\' ?><hierarchy rotation="0">',
    '<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="x" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focused="false" bounds="[0,0][1080,2340]">',
    '<node index="0" text="Réservation &amp; options" resource-id="" class="android.widget.TextView" content-desc="" clickable="false" enabled="true" focused="false" bounds="[40,100][600,180]" />',
    '<node index="1" text="Payer" resource-id="com.app:id/pay" class="android.widget.Button" content-desc="Payer la réservation" clickable="true" enabled="false" focused="false" bounds="[80,1600][1000,1720]" />',
    '<node index="2" text="" resource-id="com.app:id/menu" class="android.widget.ImageView" content-desc="" clickable="true" enabled="true" focused="false" bounds="[0,0][120,120]" />',
    '<node index="3" text="" resource-id="" class="android.view.View" content-desc="" clickable="false" enabled="true" bounds="[0,0][1,1]" />',
    '</node></hierarchy>',
  ].join('')
  expect(condenseUiTree(xml)).toBe(['TextView « Réservation & options » · centre 320,140', 'Button « Payer » [Payer la réservation] #pay · centre 540,1660 · cliquable, désactivé', 'ImageView #menu · centre 60,60 · cliquable'].join('\n'))
  expect(condenseUiTree('')).toBe('')
  const beaucoup = Array.from({ length: 130 }, (_, i) => `<node text="t${i}" class="a.T" bounds="[0,0][2,2]" />`).join('')
  const lignes = condenseUiTree(beaucoup).split('\n')
  expect(lignes.length).toBe(121)
  expect(lignes.at(-1)).toBe('… et 10 autres nœuds')
})

// ── Outils mobile-mcp et consigne ─────────────────────────────────────────

describe('mobileToolDenial', () => {
  test('mobile-mcp fermé tant que l’app n’est pas prête ; ouvert ensuite ; les autres outils ne sont pas filtrés', () => {
    expect(isMobileMcpTool('mcp__mobile-mcp__mobile_take_screenshot')).toBe(true)
    expect(isMobileMcpTool('mcp__claude-in-chrome__navigate')).toBe(false)
    expect(mobileToolDenial('mcp__mobile-mcp__mobile_click_on_screen_at_coordinates', undefined)).toContain('preuve mobile n’est pas ouverte')
    expect(mobileToolDenial('mcp__mobile-mcp__mobile_take_screenshot', { etat: 'installation' })).toContain('action mobile')
    expect(mobileToolDenial('mcp__mobile-mcp__mobile_take_screenshot', { etat: 'pret' })).toBeUndefined()
    expect(mobileToolDenial('Read', undefined)).toBeUndefined()
  })
})

describe('verifierMobileTask', () => {
  test('désactivée par l’option mobile', () => {
    const t = verifierMobileTask({ option: 'off', app: FLUTTER })
    expect(t.startsWith('## Preuve mobile')).toBe(true)
    expect(t).toContain('désactivée pour ce projet (option mobile)')
    expect(t).not.toContain('mcp__revo-flow__mobile')
  })

  test('sans app détectée', () => {
    expect(verifierMobileTask({ option: 'appareil' })).toContain('Aucune app mobile détectée')
  })

  test('ouverte : framework, plateformes, appareils vus, action mobile, outil mobile et ses actions, règles, en direct', () => {
    const t = verifierMobileTask({ option: 'appareil', app: FLUTTER, appareils: [A51, PIXEL] })
    expect(t).toContain('app mobile Flutter (pubspec.yaml (flutter), android et ios)')
    expect(t).toContain('Appareils vus : SM A515F (téléphone branché, Android 13 (API 33)), Pixel 8 (émulateur, à démarrer).')
    expect(t).toContain('mcp__revo-flow__verif avec action "mobile"')
    expect(t).toContain('mcp__revo-flow__mobile : capture')
    expect(t).toContain('"mobile": true')
    expect(t).toContain('L’utilisateur regarde l’appareil')
    expect(t).toContain('Tu n’arrêtes ni l’app ni l’émulateur')
    expect(t).not.toContain('mcp__mobile-mcp__')
    expect(verifierMobileTask({ option: 'mcp', app: RN })).toContain('mcp__mobile-mcp__*')
  })
})
