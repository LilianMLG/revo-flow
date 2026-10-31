/** Un agent installé sur le Claude Code de l'utilisateur, lisible par le plan revo-flow. */
export type AgentDef = {
  /** Le type à passer à l'outil Agent : `nom` pour un agent du projet ou du dossier personnel, `plugin:nom` pour un agent de plugin. */
  type: string
  nom: string
  description: string
  source: 'projet' | 'utilisateur' | 'plugin'
  /** Le nom du plugin (source plugin). */
  plugin?: string
  /** Modèle et effort déclarés dans le frontmatter, tels quels (haiku, sonnet, opus, fable, inherit…). */
  model?: string
  effort?: string
  /** `tools` du frontmatter (chaîne « A, B » ou liste), vide si absent. */
  outils: string[]
  /** Le chemin du .md. */
  chemin: string
}

/** Les accès disque dont le catalogue a besoin (sous-ensemble de Io de hooks/cache/store.ts). */
export type CatalogueIo = {
  read: (path: string) => Promise<string>
  list: (path: string) => Promise<{ name: string; kind: string }[]>
  exists: (path: string) => Promise<boolean>
  home: () => Promise<string | undefined>
}
