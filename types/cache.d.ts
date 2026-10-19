// Le graphe de cache d'un projet (voir docs/rd-graphe-cache/conception.md §2).
// Couche mécanique (fichiers, arêtes, routes, opérations) recalculée sans LLM ; couche « savoir » (fiches de feature) écrite par un modèle.

export type NodeKind =
  | 'page'
  | 'composant'
  | 'composable'
  | 'store'
  | 'service'
  | 'gql'
  | 'api'
  | 'route'
  | 'type'
  | 'util'
  | 'mixin'
  | 'middleware'
  | 'plugin'
  | 'layout'
  | 'config'
  | 'test'
  | 'doc'
  | 'externe'
  | 'autre'
export type EdgeKind = 'importe' | 'rend' | 'utilise' | 'appelle' | 'sert' | 'garde' | 'teste' | 'documente'
export type Edges = Partial<Record<EdgeKind, string[]>>
/** Un fichier source indexé (clé = chemin relatif au projet, séparateur /). */
export type FileNode = {
  k: NodeKind
  /** Hash du blob git (tel que fourni par l'appelant, 12 caractères ou plus). */
  h: string
  /** Taille estimée en tokens (caractères / 4). */
  tok: number
  /** Noms exportés. */
  exp?: string[]
  /** Arêtes sortantes, vers des clés de `fichiers` ou de `noeuds`. */
  out?: Edges
  /** Une ligne écrite par un modèle, facultative. */
  sum?: string
  /** Date du dernier calcul, quand il diffère de projet.indexe.le. */
  vu?: string
}
/** Un nœud qui n'est pas un fichier : route (r:/x), opération gql (q:nom), endpoint (a:POST /x), externe (x:nom). */
export type GraphNode = {
  k: 'route' | 'gql' | 'api' | 'externe'
  /** gql : le fichier qui déclare l'opération. */
  def?: string
  out?: Edges
  /** gql : les constantes exportées qui portent l'opération (queryAllOffers…), pour résoudre les imports. */
  c?: string[]
}
export type FileRole = 'entree' | 'coeur' | 'donnees' | 'ui' | 'test' | 'peripherique'
/** h : hash du blob appris ; '' = fichier ajouté sans vérification (autoFiche, completeFiche) : à relire avant de s'y fier. */
export type FeatureFile = { p: string; role: FileRole; h: string }
export type Feature = {
  id: string
  titre: string
  alias: string[]
  resume: string
  flux: string[]
  entrees: string[]
  fichiers: FeatureFile[]
  pieges: { txt: string; p?: string }[]
  deps: string[]
  /** 0 à 1. */
  confiance: number
  /** build, flow:<id>, flow-auto ou manuel. */
  source: string
  modele?: string
  appris: { le: string; commit: string; branche: string }
  /** Fichiers de la fiche dont le hash a changé depuis l'apprentissage (nouveau = '' : supprimé). */
  perime: { p: string; depuis: string; nouveau: string }[]
  usages: { servie: number; evites: number }
}
export type Candidate = { id: string; commits: number; fichiers: number; tok: number; note?: string }
export type Graph = {
  v: 1
  rev: number
  projet: {
    cle: string
    racine: string
    nom: string
    stack: string
    /** Version du format de la couche mécanique (MECA_FORMAT) ; absente = 1. */
    format?: number
    /** Nom du paquet Dart (pubspec.yaml), quand le projet en a un. */
    dart?: string
    conventions?: string
    indexe: { commit: string; branche: string; le: string; fichiers: number; tok: number }
    exclus: string[]
  }
  fichiers: Record<string, FileNode>
  noeuds: Record<string, GraphNode>
  features: Record<string, Feature>
  candidates: Candidate[]
  stats: { flows: number; servis: number; evites: number; net: number }
}
/** Un fichier servi par le cache pendant le flow courant. par = 'brief' | 'feature' | 'voisins' | 'chercher'. */
export type CacheHit = { p: string; tok: number; feature?: string; frais: boolean; par: string }
/** Ce que le flow courant a lu et reçu du cache (gardé dans un atom par register.tsx). */
export type FlowCache = {
  cle: string
  servis: CacheHit[]
  lus: { p: string; tok: number; par: string }[]
  /** Tokens injectés par le cache (brief et réponses de l'outil). */
  injecte: number
  feature?: string
}
/**
 * perimes : fichiers modifiés, supprimés ou jamais vérifiés (h = '') ; nonVerifies : ceux de perimes jamais vérifiés (ils ne comptent pas dans ratio) ;
 * vide : la fiche n'a plus aucun fichier, à reconstruire (jamais fraîche, jamais servie par matchRequest).
 */
export type Freshness = { niveau: 'fraiche' | 'partielle' | 'perimee'; ratio: number; perimes: string[]; confiance: number; nonVerifies?: string[]; vide?: boolean }
/** Les données pour le panneau et la bande, calculées par graph.ts computeStats. */
export type CacheStats = {
  projet: string
  cle: string
  fichiers: number
  features: number
  fraiches: number
  /** Fiches partiellement ou très périmées. */
  perimees: number
  /** Nombre de fichiers par type (clés = NodeKind). */
  parType: Record<string, number>
  indexe?: { commit: string; le: string }
  /** Features d'abord (k = 'feature'), puis fichiers servis pendant le flow. hit = par (brief, feature, voisins, chercher) si servi. */
  noeuds: { id: string; k: string; titre: string; niveau: Freshness['niveau']; hit?: string; tok: number }[]
  /**
   * injecte : tokens injectés ; evites : tokens des fichiers servis frais et non lus (comptés une fois) ; net = evites − injecte ;
   * lus : tokens lus pendant le flow ; completude : part (0 à 1) des fichiers lus qui figuraient dans les fiches servies.
   */
  flow: { injecte: number; evites: number; net: number; lus: number; completude: number; feature?: string }
  cumul: { flows: number; evites: number; net: number }
  build?: { feature: string; tokens: number; costUsd: number }
}
export type LearnInput = {
  feature: string
  titre?: string
  alias?: string[]
  resume?: string
  flux?: string[]
  entrees?: string[]
  fichiers?: { p: string; role?: string }[]
  pieges?: { txt: string; p?: string }[]
  deps?: string[]
  corrections?: string[]
}
/** Résultat de learn : refus = fiche nouvelle sans aucun fichier valide (graphe inchangé, rien à écrire) ; avertissement = fiche existante restée sans fichier. */
export type LearnResult = { graph: Graph; rejected: string[]; refus?: string; avertissement?: string }
export type LearnContext = { source: string; modele?: string; commit: string; branche: string; le: string; confiance?: number }
export type SourceFile = { p: string; h: string; text: string }
/** Un fichier de fiche dont le hash courant diffère du hash appris (nouveau = '' : supprimé). */
export type PerimeEntry = { p: string; depuis: string; nouveau: string }
/** Le diff d'un fichier depuis l'apprentissage ; diff undefined = indisponible (blob absent), '' = aucune différence. */
export type DiffEntry = { p: string; depuis: string; diff: string | undefined }
/** Ce que le prompt d'un sous-agent dit de sa mission, pour choisir l'extrait de fiche (agentExtract). */
export type AgentInfo = { name: string; tasks: string[]; prompt: string }
/** Contexte d'un rafraîchissement : date, commit court et branche au moment de la relecture. */
export type RefreshContext = { le: string; commit: string; branche: string }
