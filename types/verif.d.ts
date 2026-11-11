// La vérification d'un flow (voir docs/rd-v2/conception.md). Autonome : aucun import.
export type VerifMode = 'bloquer' | 'observer' | 'off'
/** qualite : le score CRAP des fonctions touchées (complexité × couverture, hooks/verif/crap.ts). */
export type VerifOutil = 'lint' | 'typage' | 'tests' | 'format' | 'generation' | 'qualite'
/** fichiers : reçoit les fichiers du flow ; lies : les tests liés aux fichiers du flow ; projet : tout le projet, une fois par porte. */
export type VerifPortee = 'fichiers' | 'lies' | 'projet'
export type VerifSource = 'ci' | 'script' | 'deduit' | 'orchestrateur'
export type VerifFormat = 'eslint-json' | 'tsc' | 'vitest-json' | 'jest-json' | 'biome' | 'dart-machine' | 'flutter-json' | 'texte' | 'crap'
/** Une commande de vérification. argv sans shell, '{fichiers}' remplacé par les fichiers de la portée (relatifs au cwd) ; le préfixe Windows est ajouté à l'exécution. */
export type VerifCommande = {
  id: string
  outil: VerifOutil
  argv: string[]
  portee: VerifPortee
  format: VerifFormat
  source: VerifSource
  /** Motif glob : la commande ne tourne que si un fichier du flow y correspond (ex. '**\/*.graphql' pour le codegen). */
  declencheur?: string
  /** Moyenne glissante des durées, en ms. */
  dureeMs?: number
  /** Motifs de tests exclus (tests qui demandent un service). */
  exclus?: string[]
  /** Où la commande a été trouvée, pour la question de confirmation : '.gitlab-ci.yml', 'script lint', 'biome.json'… (ajout de verif-coeur). */
  origine?: string
  /** Seuil CRAP d'une commande qualite (30 par défaut, CRAP_SEUIL). */
  seuil?: number
}
/** Une erreur sans numéro de ligne : la clé de comparaison avec la base (signatureKey). */
export type VerifSignature = { outil: string; fichier: string; code: string; message: string }
export type VerifStatut = 'nouvelle' | 'nouvelle?' | 'preexistante' | 'instable'
export type VerifErreur = VerifSignature & {
  ligne?: number
  col?: number
  statut: VerifStatut
  /** Première ligne de la raison d'un échec de test (attendu / reçu), hors signature : elle varie d'une exécution à l'autre (ajout de verif-coeur). */
  detail?: string
}
export type VerifBase = { commit: string; le: string; commandes: string[]; signatures: string[] }
/** Rangé dans graph.projet.verif. */
export type ProjetVerif = {
  commandes: VerifCommande[]
  /** Chemin relatif → hash git des manifestes lus (package.json, pubspec.yaml, CI…) : un hash changé redemande la confirmation. */
  manifestes: Record<string, string>
  /** Confirmé par l'utilisateur, ou utilisé sans question (headless, en observateur). */
  confirme?: { le: string; par: 'utilisateur' | 'headless' }
  instables: string[]
  pieges: string[]
  bases: VerifBase[]
}
export type VerifEtatCommande = {
  id: string
  outil: VerifOutil
  etat: 'en_cours' | 'ok' | 'ko' | 'erreur' | 'saute'
  dureeMs: number
  nouvelles: number
  preexistantes: number
  instables: number
  /** Fichiers passés à la commande (ou tests liés). */
  fichiers: number
  /** Chemin absolu du .txt de la sortie complète. */
  sortie?: string
  note?: string
}
export type VerifResultat = { etat: 'vert' | 'rouge' | 'erreur'; le: string; dureeMs: number; commandes: VerifEtatCommande[]; erreurs: VerifErreur[] }
// Lot 2
export type Critere = { id: string; texte: string }
/** La revue d'architecture telle que le panneau et le rapport la montrent : attendue, ou le verdict ARCHI et sa preuve ; passee = terminé sans revue, sur décision. */
export type ArchiView = { verdict: 'attente' | 'ok' | 'ko' | 'non-verifiable' | 'passee'; preuve?: string }
export type CritereVerdict = {
  id: string
  verdict: 'ok' | 'ko' | 'non-verifiable'
  preuve: string
  /** Le verdict s'appuie sur la preuve web (navigateur). */
  web?: boolean
  /** Le verdict s'appuie sur la preuve mobile (appareil). */
  mobile?: boolean
}
export type Triche = { motif: string; fichier: string; extrait?: string; bloquant: boolean }
export type TestGele = { p: string; h: string; par: string }
// Lot 3 : preuve à l'exécution web (docs/rd-v3/README.md §3)
/** Le serveur de dev d'un projet web (hooks/verif/web.ts, detectDevServer) : argv sans shell, port attendu, d'où il vient (« script dev », « script start »). */
export type WebServeur = { argv: string[]; port?: number; origine: string }
/** L'état de la preuve web d'un flow. */
export type WebEtat = 'non-demande' | 'question' | 'demarrage' | 'pret' | 'refuse' | 'erreur' | 'arrete'
/** La preuve web telle que le panneau, le rapport et le journal la voient. */
export type WebView = {
  etat: WebEtat
  /** « npm run dev », telle qu'un humain la tape. */
  commande?: string
  /** L'origine du serveur accordée au vérificateur : « http://localhost:3000 ». */
  url?: string
  /** Un serveur déjà à l'écoute, réutilisé sur accord : revo-flow ne l'arrête pas. */
  existant?: boolean
  /** Chemins absolus des captures écrites, dans l'ordre (capture-1.png.txt, ou capture-1.png quand le décodage a marché). */
  captures: string[]
  /** La raison d'un refus ou d'une erreur, en une phrase. */
  note?: string
}
// Lot 4 : preuve à l'exécution mobile (docs/rd-v3/README.md §3 bis)
/** L'app mobile d'un projet (hooks/verif/mobile.ts, detectMobileApp) : framework, plateformes présentes, d'où elle vient (« pubspec.yaml (flutter) »). */
export type MobileApp = { framework: 'flutter' | 'react-native' | 'expo'; plateformes: ('android' | 'ios')[]; origine: string }
/** Un appareil du poste : téléphone branché, émulateur Android ou simulateur iOS ; connecté ou à démarrer ; capture = sait faire une capture d'écran. */
export type Appareil = {
  id: string
  nom: string
  plateforme: 'android' | 'ios'
  type: 'physique' | 'emulateur' | 'simulateur'
  etat: 'connecte' | 'eteint'
  sdk?: string
  capture?: boolean
}
/** L'état de la preuve mobile d'un flow : demarrage = l'émulateur s'allume, installation = l'app se construit et s'installe. */
export type MobileEtat = 'non-demande' | 'question' | 'demarrage' | 'installation' | 'pret' | 'refuse' | 'erreur' | 'arrete'
/** La preuve mobile telle que le panneau, le rapport et le journal la voient. */
export type MobileView = {
  etat: MobileEtat
  /** « Flutter », « Expo », « React Native ». */
  framework?: string
  /** L'appareil accordé : « SM A515F (téléphone branché) ». */
  appareil?: string
  /** « flutter run -d emulator-5554 », telle qu'un humain la tape. */
  commande?: string
  /** L'émulateur ou le simulateur a été démarré par revo-flow (il sera éteint en fin de flow). */
  emulateurLance?: boolean
  /** Chemins absolus des captures écrites, dans l'ordre (capture-1.png). */
  captures: string[]
  /** La raison d'un refus ou d'une erreur, en une phrase. */
  note?: string
}
/** Le champ verif du journal (graphe et store). */
export type VerifJournal = {
  etat: 'verifie' | 'non-verifie' | 'observe' | 'off' | 'erreur'
  tentatives: number
  /** Rouge à la première porte. */
  premierRouge: boolean
  nouvelles: number
  preexistantes: number
  dureeMs: number
  triches: number
  /** Terminé rouge sur décision de l'utilisateur. */
  accepte?: boolean
  criteres?: { total: number; ok: number }
  /** Score CRAP à la dernière porte : fonctions au-dessus du seuil (fonctions = nouvelles + preexistantes), touchées par le flow (nouvelles) ou non (preexistantes). */
  crap?: { fonctions: number; nouvelles: number; preexistantes: number }
  /** La preuve web (v3) : son état, les captures écrites, les verdicts marqués web (web: true) et ceux parmi eux qui sont ko. */
  web?: { etat: WebEtat; captures: number; verdicts: number; ko: number }
  /** La preuve mobile (v3.1) : son état, les captures écrites, les verdicts marqués mobile et ceux parmi eux qui sont ko. */
  mobile?: { etat: MobileEtat; captures: number; verdicts: number; ko: number }
  /** La revue d'architecture (v3.2) : le verdict de l'étape ARCHI du vérificateur ; absente si elle n'a pas eu lieu. */
  archi?: 'ok' | 'ko' | 'non-verifiable' | 'passee'
}
/** Ce que le panneau et la bande montrent (atom `verif` de register.tsx). */
export type VerifView = {
  projet: string
  mode: VerifMode
  etat: 'off' | 'a-confirmer' | 'base' | 'attente' | 'en_cours' | 'vert' | 'rouge' | 'erreur'
  tentative: number
  max: number
  commandes: VerifEtatCommande[]
  /** Base de référence : en cours, prête, absente. */
  base: 'en_cours' | 'prete' | 'absente'
  geles: { p: string; modifie?: string }[]
  triches: Triche[]
  criteres?: { total: number; ok: number; verdicts: CritereVerdict[] }
  /** Question en attente de l'utilisateur, en une phrase. */
  enAttente?: string
  /** Chemin du .txt de la dernière sortie complète (bouton Détail). */
  detail?: string
  /** La preuve web du flow (v3). */
  web?: WebView
  /** La preuve mobile du flow (v3.1). */
  mobile?: MobileView
  /** La revue d'architecture (v3.2) : attendue, puis le verdict de l'étape ARCHI et sa preuve. */
  archi?: ArchiView
}
