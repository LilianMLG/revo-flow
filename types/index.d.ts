/** L'état partagé du mod : flow, agents, tâches, orchestrateur et tokens. */
export type ModelKey = 'haiku' | 'sonnet' | 'opus'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'
export type TaskKind = 'analyse' | 'codage' | 'test' | 'review' | 'doc' | 'deploy'
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/** Une tâche confiée à un sous-agent par l'orchestrateur. */
export type FlowTask = { title: string; kind: TaskKind; status: TaskStatus }

/** Ce qu'un agent fait en direct : action en cours, dernières actions, fichier touché. */
export type Activity = {
  doing?: string
  isDoing?: boolean
  history?: string[]
  filePath?: string
  reason?: string
}

export type Tally = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Un sous-agent prévu par le plan : son modèle, son effort et SES tâches. */
export type FlowAgent = Activity & {
  key: string
  name: string
  role: string
  subagentType: string
  model: ModelKey
  effort: Effort
  why: string
  tasks: FlowTask[]
  /** Connu une fois l'agent lancé. */
  agentId?: string
  /**
   * L'id de son dernier lancement, gardé quand il quitte son lancement (attente, relance) : l'orchestrateur peut le
   * reprendre avec SendMessage, contexte compris, et revo-flow le reconnaît à son premier tour.
   */
  lastAgentId?: string
  /** Le modèle réellement utilisé (identifiant complet). */
  modelId?: string
  /** blocked : son tour est fini, mais il attend le travail d'un autre agent (waitingFor) ; revo-flow le relance ensuite. */
  status: 'waiting' | 'running' | 'blocked' | 'done' | 'failed'
  /**
   * Ce qu'il attend, signalé avec l'outil step (statut attente) : key = la clé de l'agent prévu s'il est reconnu,
   * name = ce que l'agent a écrit (ou le nom de l'agent reconnu), since = l'heure du signalement.
   */
  waitingFor?: { key?: string; name: string; since: number }
  /** Vrai dès que l'agent a signalé lui-même une tâche. */
  hasReported?: boolean
  /** Son dernier tour s'est terminé ; il n'est fini que quand Claude Code le dit (il peut tourner encore en fond). */
  hasEndedTurn?: boolean
  tokens: Tally
  costUsd: number
  /** Lancé (agent.spawn accepté). */
  startedAt?: number
  /** Fini, en succès ou en échec. */
  endedAt?: number
  /** Dernier signe de vie : un appel d'outil ou une requête au modèle. */
  lastActiveAt?: number
  /** Nombre de lancements : 1 au premier, +1 à chaque relance. */
  attempts?: number
}

/**
 * planning : l'orchestrateur lit la demande et les specs (le panneau attend le plan d'exécution) ;
 * dispatch : le plan et les tâches sont posés, les agents apparaissent ; running : les agents travaillent ;
 * review : tous ont fini, l'orchestrateur vérifie ; done : terminé.
 */
export type Phase = 'planning' | 'dispatch' | 'running' | 'review' | 'done'

export type Flow = {
  id: string
  request: string
  title: string
  summary: string
  project: string
  branch: string
  phase: Phase
  startedAt: number
  agents: FlowAgent[]
  /** Fermé à la main pendant ce flow : on ne le rouvre pas tout seul. */
  isPaneClosed?: boolean
  /** Passé en done. */
  endedAt?: number
  /** Le plan a été validé (ou n'avait pas à l'être) : en dispatch sans cela, il attend l'utilisateur. */
  isApproved?: boolean
  /** Le plan en markdown sur le disque (~/.claude/revo-flow/plans/<titre>.md), une fois posé. */
  planFile?: string
  /** Arrêté par l'utilisateur (Tout arrêter) : sa fin n'est ni une conclusion, ni une fiche à apprendre. */
  isStopped?: boolean
}

/** L'orchestrateur : le fil principal, sur le modèle de la session. */
export type Lead = Activity & { modelId: string; effort?: string; tokens: Tally; costUsd: number }

export type Tokens = { dayKey: string; weekKey: string; day: Tally; week: Tally }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** Un fichier modifié pendant le flow, avec la raison en une phrase. */
export type Entry = {
  path: string
  rel: string
  reason: string
  count: number
  at: number
  /** Qui l'a modifié en dernier : 'lead' ou la clé de l'agent. */
  by?: string
  /** Les clés des autres agents qui ont aussi touché ce fichier pendant qu'il tournait. */
  conflict?: string[]
}

/** Le dernier tour de l'orchestrateur : en cours (isLive, cumul via turn.step) puis figé par turn.complete. */
export type LastTurn = { at: number; durationMs: number; tokens: Tally; modelId: string; costUsd: number; isLive: boolean }

/** Fenêtre de contexte de l'orchestrateur. */
export type Context = { percent: number; tokens: number; window: number }

// Le cache projet, tel que l'état partagé le porte. Le contrat doit se suffire à lui-même (pas d'import) :
// ces types reprennent à l'identique ceux de types/cache.d.ts (graph.ts), qui restent la référence.

/** Un fichier servi par le cache pendant le flow courant. par = 'brief' | 'feature' | 'voisins' | 'chercher' ; poids : part comptée comme évitée (1 par défaut). */
export type CacheHit = { p: string; tok: number; feature?: string; frais: boolean; par: string; poids?: number }

/** Ce que le flow courant a lu et reçu du cache. */
export type FlowCache = {
  cle: string
  /** Le cache est actif pour ce flow. */
  cache: boolean
  servis: CacheHit[]
  /** Fichiers lus ; via 'bash' : lu par cat, sed -n, head ou tail. */
  lus: { p: string; tok: number; par: string; via?: 'bash' }[]
  /** Tokens renvoyés par Grep, Glob et les commandes Bash de lecture non attribuables à un fichier. */
  outils?: number
  /** Tokens injectés par le cache (brief et réponses de l'outil). */
  injecte: number
  feature?: string
}

/** Les données du cache pour le panneau et la bande (graph.ts computeStats). */
export type CacheStats = {
  projet: string
  cle: string
  fichiers: number
  features: number
  fraiches: number
  perimees: number
  parType: Record<string, number>
  indexe?: { commit: string; le: string }
  noeuds: { id: string; k: string; titre: string; niveau: 'fraiche' | 'partielle' | 'perimee'; hit?: string; tok: number }[]
  flow: { injecte: number; evites: number; net: number; lus: number; completude: number; feature?: string }
  cumul: { flows: number; evites: number; net: number }
  /** La mesure tirée du journal des flows : lus = moyenne par flow de (lus + outils). */
  mesure: {
    sans: { flows: number; lus: number }
    sansFiche: { flows: number; lus: number }
    avecFiche: { flows: number; lus: number }
    parFeature: { id: string; avant: { flows: number; lus: number }; apres: { flows: number; lus: number } }[]
  }
  build?: { feature: string; tokens: number; costUsd: number }
  /**
   * Indicateurs de vérification tirés du journal (absent si aucun flow vérifié). echappement : part (0 à 1) des flows observés rouges ;
   * premierRouge : part des flows dont la première porte est rouge ; attrapees : erreurs nouvelles des flows vérifiés ;
   * acceptes : flows finis rouges sur décision de l'utilisateur ; dureeMoyMs : durée moyenne de la porte.
   */
  verif?: { flows: number; echappement: number; premierRouge: number; attrapees: number; acceptes: number; dureeMoyMs: number }
}

// La vérification d'un flow (v2, docs/rd-v2/conception.md). Reprise à l'identique de types/verif.d.ts, qui reste la référence.

export type VerifMode = 'bloquer' | 'observer' | 'off'
export type VerifOutil = 'lint' | 'typage' | 'tests' | 'format' | 'generation'
/** fichiers : reçoit les fichiers du flow ; lies : les tests liés aux fichiers du flow ; projet : tout le projet, une fois par porte. */
export type VerifPortee = 'fichiers' | 'lies' | 'projet'
export type VerifSource = 'ci' | 'script' | 'deduit' | 'orchestrateur'
export type VerifFormat = 'eslint-json' | 'tsc' | 'vitest-json' | 'jest-json' | 'biome' | 'dart-machine' | 'flutter-json' | 'texte'
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
  /** D'où vient la commande, pour la question : « .gitlab-ci.yml », « script lint », « biome.json »… */
  origine?: string
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
/** Un critère d'acceptation du plan (lot 2) : C1 à C8, vérifiable. */
export type Critere = { id: string; texte: string }
export type CritereVerdict = { id: string; verdict: 'ok' | 'ko' | 'non-verifiable'; preuve: string }
export type Triche = { motif: string; fichier: string; extrait?: string; bloquant: boolean }
/** Un fichier de test gelé à la fin du testeur : chemin relatif à la racine, hash git, auteur (clé de l'agent). */
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

/**
 * Ce qui doit survivre à un rechargement du mod pendant un flow vérifié (register.tsx) : le gel des tests (qui reste fermé),
 * les critères, le compte des tentatives. La base de référence en cours, elle, est perdue (base absente, erreurs « nouvelle ? »).
 */
export type VerifFlow = {
  flowId: string
  mode: VerifMode
  commit: string
  gel: TestGele[]
  criteres: Critere[]
  blocks: number
  portes: number
  accepte?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'revo-flow': {
      flow: Flow | null
      lead: Lead
      isBusy: boolean
      tokens: Tokens | null
      limits: Limit[]
      session: Tally
      entries: Entry[]
      lastTurn: LastTurn | null
      context: Context | null
      sessionCostUsd: number
      /** Le cache projet tel que les vues l'affichent : graphe, fiches, gains du flow et cumulés. */
      cacheStats: CacheStats | null
      /** Ce que le cache a servi et ce qui a été lu pendant le flow courant. */
      flowCache: FlowCache | null
      /** La section « Cache » du panneau est dépliée. */
      cacheOpen: boolean
      /** La vérification du flow courant (v2) telle que le panneau et la bande l'affichent ; null hors flow. */
      verif: VerifView | null
      /** L'état de la porte du flow courant qui survit à un rechargement du mod (gel, critères, tentatives). */
      verifFlow: VerifFlow | null
    }
  }
}
