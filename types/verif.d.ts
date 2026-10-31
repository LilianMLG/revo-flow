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
export type CritereVerdict = { id: string; verdict: 'ok' | 'ko' | 'non-verifiable'; preuve: string }
export type Triche = { motif: string; fichier: string; extrait?: string; bloquant: boolean }
export type TestGele = { p: string; h: string; par: string }
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
}
