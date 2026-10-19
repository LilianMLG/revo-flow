# revo-flow

Mod Claude Code qui orchestre une demande avec une équipe de sous-agents, et montre l'avancement de chacun.

## Installation

Rien à télécharger : Claude Code récupère le dépôt tout seul depuis GitHub. Deux façons, au choix.

**Depuis une session Claude Code en terminal :**

```
/plugin install revo-flow --marketplace LilianMLG/revo-flow
```

Réponds `y` pour ajouter le marketplace, puis Entrée pour la portée **user**. Le mod est actif tout de suite.

**Depuis n'importe quel terminal (PowerShell, bash…), sans ouvrir Claude :**

```
claude plugin marketplace add LilianMLG/revo-flow
claude plugin install revo-flow@revo-flow
```

Dans les deux cas, le mod est ensuite chargé dans chaque nouvelle session, en terminal comme dans l'app desktop.

**Mise à jour automatique (recommandé) :** dans Claude Code, `/plugin` → **Marketplaces** → **revo-flow** → **Enable auto-update**. Au lancement de chaque session, Claude Code récupère alors la dernière version publiée du mod, sans commande à taper ; **Disable auto-update** au même endroit l'arrête. Les marketplaces tiers sont désactivés par défaut, d'où ce réglage à faire une fois.

Une nouvelle version n'est détectée que si `version` change dans `.claude-plugin/plugin.json` : chaque modification publiée sur `main` monte ce numéro. Si l'option n'apparaît pas, c'est que les mises à jour automatiques de Claude Code sont coupées sur ce poste (`DISABLE_AUTOUPDATER`) ; `FORCE_AUTOUPDATE_PLUGINS=1` les rétablit pour les plugins seuls.

**Mise à jour à la main :**

```
claude plugin marketplace update revo-flow
claude plugin update revo-flow@revo-flow
```

## Utilisation

```
/revo-flow <ta demande>
```

1. **Analyse** : le modèle de la session lit la demande et les specs. Le panneau affiche « En attente du plan d'exécution ». Pour une lecture large, il peut lancer un **éclaireur** Explore (lecture seule) : revo-flow demande d'abord **Autoriser** ou **Refuser** ; son coût compte pour l'orchestrateur. Tout autre agent est refusé avant le plan.
2. **Plan** : il décide combien de sous-agents il faut (1 à 6), le modèle (Haiku, Sonnet, Opus) et l'effort de chacun, et la liste des tâches de chacun.
3. **Validation** : le plan s'affiche (agents, modèles, efforts, nombre de tâches) et attend **Lancer** ou **Annuler**, dans le dialogue ou avec les boutons du panneau. Le dialogue montre le plan complet en markdown dans un aperçu à côté des deux choix : chaque agent, son rôle, la raison de son modèle et ses tâches numérotées. Le même plan est écrit dans `~/.claude/revo-flow/plans/<titre>.md`, que le bouton **plan.md** du panneau ouvre dans l'application par défaut. Aucun agent ne part avant. Annuler, ou fermer le dialogue (Échap), renvoie l'orchestrateur à la planification.
4. **Exécution** : les agents sont lancés. revo-flow ajoute au prompt de chacun sa liste de tâches (celles déjà faites cochées ✓ quand il est relancé), la façon de les signaler (un appel `step` au début de chaque tâche) et, avec le cache, l'extrait de la fiche servie qui le concerne. Chacun a sa barre de progression, de sa couleur, avec « n/total » et la tâche en cours. Un agent qui dépend du travail d'un autre signale une **attente** (« Attend « Y » » dans le panneau, ni fini ni en échec) et termine son tour ; quand Y a fini, revo-flow demande à l'orchestrateur de le reprendre avec `SendMessage` (il garde tout son contexte et revo-flow le suit de nouveau) ou de le relancer avec l'outil Agent, pour ses tâches restantes. Si Y a échoué, n'est pas du plan ou l'attend lui-même, l'orchestrateur est prévenu et décide. Un Agent lancé hors du plan n'est pas suivi. Un agent qui a rendu son rapport mais que Claude Code garde en `waiting` (un travail de fond à lui) compte comme fini, et reprend sa barre s'il se réveille.
5. **Fin** : l'orchestrateur vérifie le tout et fait la synthèse. Une notification donne la durée, le coût et le nombre de fichiers, et le flow entre au journal (`/revo-flow historique`).

Pendant le flow, les durées et « inactif depuis » avancent seuls, un agent sans aucune requête depuis 3 min est signalé une fois (toast et notification), et une ligne d'état sous le prompt résume `revo-flow · titre · 62 % · 3 actifs · 0,41 €`.

Sans `/revo-flow`, le mod ne fait rien : pas même un outil déclaré (`plan`, `step` et `cache` arrivent au premier flow ou `cache build`). Un nouveau `/revo-flow` pendant un flow pas fini demande **Remplacer** ou **Garder le flow en cours**.

| Commande | Effet |
| --- | --- |
| `/revo-flow <demande>` | lance un flow |
| `/revo-flow statut` | où en est chaque agent |
| `/revo-flow panneau` | affiche ou masque le panneau latéral |
| `/revo-flow historique [n]` | les n derniers flows (10 par défaut) : date, durée, coût, agents, échecs et relances, puis par modèle le coût moyen d'un agent, son taux d'échec et ses relances |
| `/revo-flow stop` | arrête vraiment : les agents en cours (TaskStop) et le tour de l'orchestrateur, après confirmation (Échap : rien ne change), puis retire la barre et le panneau |
| `/revo-flow cache` | le graphe du projet courant : panneau (section « Cache » dépliée) et texte dans le terminal |
| `/revo-flow cache <projet>` | le graphe de n'importe quel projet de `Documents/Front` ou `Documents/Back` (`reservation-tool`, `back/graphql`) |
| `/revo-flow cache build [feature \| --top N \| --tout]` | sans argument : reconstruit la couche mécanique et liste les features candidates avec leur coût ; avec : lance un sous-agent en arrière-plan qui écrit la fiche, après confirmation du coût (`--tout` déconseillé) |
| `/revo-flow cache clear [feature]` | supprime le graphe du projet, ou une seule fiche, après confirmation |
| `/revo-flow cache <mot-clé>` | cherche dans le graphe (3 mots au plus) ; alias sans ambiguïté : `/revo-flow graphe …` |

**Boutons du panneau** : **Lancer** / **Annuler** / **plan.md** (validation du plan), **Arrêter** sur chaque agent en cours et **Tout arrêter**, après confirmation avec le coût déjà dépensé (un flow arrêté finit « arrêté », sans relance ni fiche apprise), et **Relancer** sur un agent en échec ou en attente (« Attend « Y » ») : il repart de ses tâches non terminées et l'orchestrateur le relance. Un agent en attente est aussi relancé tout seul dès que l'agent qu'il attend a fini. Le panneau s'adapte aussi au mobile.

**Tokens et contexte** : en terminal, la ligne de fin de tour (« Baked for… ») devient `⏱ durée · tokens in · out · cache API · coût · modèle` (et `cache n hits ≈ -18k` quand le cache projet a servi). La barre au-dessus du prompt ajoute une 2e ligne avec le dernier prompt et `ctx n %`, et le panneau a une jauge de contexte. Après une compaction, le rôle d'orchestrateur et l'état des agents sont réinjectés.

## Cache projet

revo-flow garde pour chaque projet un **graphe de connaissances** dans `~/.claude/revo-flow/graphs/<front-projet>.json`, hors des dépôts.

- **Couche mécanique**, sans LLM : fichiers, imports (alias, auto-imports Nuxt 3, Vuex par chaîne, balises de composants ; en Dart, `package:<projet>/` et relatifs, avec la stack lue dans `pubspec.yaml` ; stack aussi lue dans `package.json`, `.claude-plugin/plugin.json`, `tsconfig.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml`), un **résumé d'une ligne par fichier** (1re phrase du commentaire de tête ou titre d'un .md, sans LLM), routes, stores, opérations GraphQL et endpoints (jamais tirés des fichiers de test), tests et docs. Reconstruite en 1 à 2 s, vérifiée par hash git à chaque usage ; un graphe d'un format plus ancien est reconstruit tout seul, fiches gardées.
- **Fiches de feature**, écrites par un modèle : résumé, flux, points d'entrée, fichiers et rôles, pièges, confiance. Apprises par l'orchestrateur **à la fin de chaque flow** (≈ 0,02 €), ou construites à la demande par `cache build` (≈ 0,20 €). Une fiche périmée n'est jamais supprimée : elle signale les fichiers modifiés depuis, et masque son flux au-delà de 50 % de changements. Une nouvelle fiche sans aucun fichier connu est refusée ; les fichiers ajoutés en fin de flow sans relecture comptent « à vérifier ».
- **Fiche auto de fin de flow** (quand personne n'a appelé `apprendre`) : ses fichiers rejoignent la fiche existante qui en partage le plus (au moins 2 et 30 %), sinon ils forment un **brouillon** : hors brief, hors correspondance et hors rappel après compaction, supprimé après 10 flows sans usage, promu en vraie fiche par un `apprendre`. La notification de fin dit « fiche auto « x » (rattachée) » ou « brouillon « x » ».

**Au lancement de `/revo-flow <demande>`** : si une fiche correspond à la demande, un dialogue propose **Utiliser** ou **Ignorer** (sous `claude -p`, elle est utilisée ; dialogue fermé : ignorée). Quand la recherche hésite (zone grise : aucune fiche ne ressort nettement, mais certaines touchent la demande), **Haiku tranche** entre les 25 meilleures fiches (id, titre, alias ; ≈ 1k tokens, 5 s au plus) : sa réponse passe par la même question, marquée « proposée par Haiku » ; « aucune », un échec ou un délai dépassé : pas de fiche. La confiance affichée **décroît** quand le code autour a bougé : −10 % par tranche de 20 commits sur les fichiers voisins de la fiche (hors fiche) depuis son apprentissage, −5 % par mois au-delà d'un mois, jamais sous 0,3 par ce seul effet. Un brief d'au plus 1 200 tokens est alors injecté à l'orchestrateur. Le brief est une carte, pas la vérité : l'orchestrateur vérifie dans le code ce qu'il modifie. Sans fiche, le brief garde la liste des features connues et ajoute une **carte à froid** (≈ 700 tokens au plus) : les fichiers probables pour la demande, classés par pertinence (nom, exports, résumé, mots-clés des commentaires, avec quelques mots français traduits vers ceux du code) puis par centralité (PageRank sur les imports, personnalisé par la demande), chacun avec son résumé d'une ligne. Rien ne ressort : les fichiers les plus centraux.

**Côté agents** : quand une fiche est servie, revo-flow ajoute au prompt de chaque sous-agent un **extrait** d'au plus 600 tokens : les fichiers de la fiche que sa mission cite (sinon les fichiers d'entrée, cœur et données), marqués ⚠ s'ils ont changé depuis l'apprentissage, leurs pièges et le résumé. Ces fichiers sont comptés comme servis à cet agent (sa couleur dans le panneau). L'orchestrateur n'ajoute que ce qui manque (pièges transverses, décisions). Chaque agent a aussi l'outil ci-dessous, avec la consigne de chercher dans le cache avant d'explorer quand le projet a des fiches (sinon seulement `voisins`).

**Fiche périmée** : elle n'est pas seulement signalée, elle se vérifie. L'agent voit ce qui a changé (`diff`), relit ce qu'il faut, puis `rafraichir` si la fiche reste juste pour ces fichiers (leurs hash sont remis à jour, la fiche redevient fraîche quand plus rien n'est périmé), ou `apprendre` avec `corrections` si elle est fausse.

**Outil `mcp__revo-flow__cache`**, pour l'orchestrateur et les agents :

| Action | Effet |
| --- | --- |
| `chercher` | mots-clés → features et fichiers pertinents, une ligne chacun |
| `feature` | la fiche d'une feature, avec sa fraîcheur |
| `voisins` | ce qu'un fichier utilise et qui l'utilise : à essayer avant un grep « qui utilise X » |
| `diff` | ce qui a changé depuis l'apprentissage : `feature` → ses fichiers modifiés (5 au plus), `chemin` → ce fichier seul (≤ 2 500 tokens) |
| `rafraichir` | `feature` et `fichiers` relus, toujours conformes : leurs hash sont remis à jour, sans toucher au résumé, au flux ni aux pièges |
| `apprendre` | enregistre ou complète une fiche (chemins inconnus rejetés ; un champ absent garde sa valeur) |
| `oublier` | supprime une fiche |
| `candidates` | les features repérées dans les commits, sans fiche, avec leur coût de construction |

**Panneau et bande** : section « Cache » pliable avec les nœuds servis (● couleur de l'agent), frais (○) et périmés (⚠), la mesure, les tokens évités et le coût de construction ; la bande ajoute `cache : 12 nœuds · 3 utilisés · ≈ 18k tokens évités`. Les tokens évités sont une estimation prudente (« ≈ ») : un fichier de fiche servi frais et non relu ne compte que s'il est cœur, entrée ou données, ou s'il a été lu dans un flow antérieur de la même fiche ; un fichier seulement listé par `chercher` ou `voisins` compte pour un quart de sa taille (un dixième au second saut) ; le tout moins ce que le cache a injecté.

**Mesure** : chaque flow terminé (pas un flow arrêté) entre au **journal** du graphe (200 derniers), cache activé ou non : tokens lus par Read (≈ 9 tokens par ligne d'une lecture partielle) et par une lecture Bash d'un seul fichier (`cat`, `sed -n`, `head`, `tail` ; les autres commandes Bash ne comptent pas), sorties de Grep et Glob, tokens injectés et évités. La section « Cache » en tire une ligne `Lus par flow : sans cache 12k (4) · sans fiche 9k (6) · avec fiche 5k (3)`, et la feature qui gagne le plus entre ses flows d'avant sa fiche et ceux où elle a été servie (même feature : bien moins de variance). Pour remplir la colonne « sans cache », désactive l'option `cache` sur quelques flows ; le graphe doit déjà exister (il n'est pas construit pour mesurer). Un fichier modifié par un agent fait revérifier le graphe au prochain appel, sans attendre 30 s.

## Options (`/config`)

| Option | Défaut | Effet |
| --- | --- | --- |
| `validerPlan` | oui | demande « Lancer » ou « Annuler » avant de lancer les agents ; sans personne à qui demander (`claude -p`), le plan part tout seul |
| `conflits` | `avertir` | fichier déjà modifié par un autre agent encore au travail : `avertir` affiche un toast, `refuser` bloque la modification |
| `notifier` | oui | notification système à la fin d'un flow et quand un agent échoue (un toast si elle ne peut pas partir) |
| `cache` | oui | brief du cache projet au lancement, extrait de fiche dans le prompt de chaque agent et outil `cache` proposé ; `non` : ni brief, ni extrait, ni outil, la commande `cache` reste et les flows comptent dans la mesure « sans cache » |

Sur l'app desktop, `/revo-flow` n'apparaît pas toujours dans le menu `/` : tape la commande en entier, elle fonctionne.

## Développement

```
claude plugin validate .
claude plugin test .
```

Les tests vivent dans `tests/`, à la racine, en miroir de `hooks/` : c'est ce que prévoit le `tsconfig.json` que Claude Code écrit pour le mod (`hooks`, `types`, `tests`).

### Arborescence

```
revo-flow/
├── .claude-plugin/
│   ├── plugin.json        manifeste (version, options)
│   ├── marketplace.json   pour /plugin install
│   └── types/             écrit par Claude Code au chargement (ignoré par git)
├── hooks/                 le code du mod, chargé par le moteur
│   ├── hooks.json         désigne le module d'entrée
│   ├── register.tsx       entrée : commande /revo-flow, outils plan, step et cache, suivi des agents
│   ├── lib.ts             logique pure du flow : plan, tâches, progression, consignes, coûts
│   ├── ui/
│   │   ├── views.tsx      panneau et bande (terminal, desktop, mobile)
│   │   └── art.ts         les dessins SVG
│   └── cache/
│       ├── graph.ts       graphe du cache, module pur
│       └── store.ts       disque et git du cache
├── tests/                 lancés par claude plugin test .
│   ├── flow.test.ts
│   ├── cache/             graph.test.ts, store.test.ts
│   └── helpers/os.ts      les deux machines simulées (Windows, macOS)
├── types/                 contrats : état du mod (index.d.ts), graphe du cache (cache.d.ts)
├── docs/rd-graphe-cache/  conception et R&D du cache
└── tsconfig.json
```
