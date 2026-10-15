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

**Mise à jour :**

```
claude plugin marketplace update revo-flow
claude plugin update revo-flow@revo-flow
```

## Utilisation

```
/revo-flow <ta demande>
```

1. **Analyse** : le modèle de la session lit la demande et les specs. Le panneau affiche « En attente du plan d'exécution ».
2. **Plan** : il décide combien de sous-agents il faut (1 à 6), le modèle (Haiku, Sonnet, Opus) et l'effort de chacun, et la liste des tâches de chacun.
3. **Validation** : le plan s'affiche (agents, modèles, efforts, nombre de tâches) et attend **Lancer** ou **Annuler**, dans le dialogue ou avec les boutons du panneau. Aucun agent ne part avant. Annuler renvoie l'orchestrateur à la planification.
4. **Exécution** : les agents sont lancés. revo-flow ajoute au prompt de chacun sa liste de tâches, la façon de les signaler et, avec le cache, l'extrait de la fiche servie qui le concerne. Chacun a sa barre de progression, de sa couleur, avec « n/total » et la tâche en cours. Un agent qui dépend du travail d'un autre signale une **attente** (« Attend « Y » » dans le panneau, ni fini ni en échec) et termine son tour ; quand Y a fini, revo-flow demande à l'orchestrateur de le relancer pour ses tâches restantes. Si Y a échoué, n'est pas du plan ou l'attend lui-même, l'orchestrateur est prévenu et décide. Un Agent lancé hors du plan n'est pas suivi.
5. **Fin** : l'orchestrateur vérifie le tout et fait la synthèse. Une notification donne la durée, le coût et le nombre de fichiers.

Sans `/revo-flow`, le mod ne fait rien.

| Commande | Effet |
| --- | --- |
| `/revo-flow <demande>` | lance un flow |
| `/revo-flow statut` | où en est chaque agent |
| `/revo-flow panneau` | affiche ou masque le panneau latéral |
| `/revo-flow stop` | arrête vraiment : les agents en cours (TaskStop) et le tour de l'orchestrateur, après confirmation, puis retire la barre et le panneau |
| `/revo-flow cache` | le graphe du projet courant : panneau (section « Cache » dépliée) et texte dans le terminal |
| `/revo-flow cache <projet>` | le graphe de n'importe quel projet de `Documents/Front` ou `Documents/Back` (`reservation-tool`, `back/graphql`) |
| `/revo-flow cache build [feature \| --top N \| --tout]` | sans argument : reconstruit la couche mécanique et liste les features candidates avec leur coût ; avec : lance un sous-agent en arrière-plan qui écrit la fiche, après confirmation du coût (`--tout` déconseillé) |
| `/revo-flow cache clear [feature]` | supprime le graphe du projet, ou une seule fiche, après confirmation |
| `/revo-flow cache <mot-clé>` | cherche dans le graphe (3 mots au plus) ; alias sans ambiguïté : `/revo-flow graphe …` |

**Boutons du panneau** : **Lancer** / **Annuler** (validation du plan), **Arrêter** sur chaque agent en cours, **Tout arrêter**, et **Relancer** sur un agent en échec ou en attente (« Attend « Y » ») : il repart de ses tâches non terminées et l'orchestrateur le relance. Un agent en attente est aussi relancé tout seul dès que l'agent qu'il attend a fini. Le panneau s'adapte aussi au mobile.

**Tokens et contexte** : en terminal, la ligne de fin de tour (« Baked for… ») devient `⏱ durée · tokens in · out · cache API · coût · modèle` (et `cache n hits ≈ -18k` quand le cache projet a servi). La barre au-dessus du prompt ajoute une 2e ligne avec le dernier prompt et `ctx n %`, et le panneau a une jauge de contexte. Après une compaction, le rôle d'orchestrateur et l'état des agents sont réinjectés.

## Cache projet

revo-flow garde pour chaque projet un **graphe de connaissances** dans `~/.claude/revo-flow/graphs/<front-projet>.json`, hors des dépôts.

- **Couche mécanique**, sans LLM : fichiers, imports (alias, auto-imports Nuxt 3, Vuex par chaîne, balises de composants ; en Dart, `package:<projet>/` et relatifs, avec la stack lue dans `pubspec.yaml`), routes, stores, opérations GraphQL, endpoints, tests et docs. Reconstruite en 1 à 2 s, vérifiée par hash git à chaque usage ; un graphe d'un format plus ancien est reconstruit tout seul, fiches gardées.
- **Fiches de feature**, écrites par un modèle : résumé, flux, points d'entrée, fichiers et rôles, pièges, confiance. Apprises par l'orchestrateur **à la fin de chaque flow** (≈ 0,02 €), ou construites à la demande par `cache build` (≈ 0,20 €). Une fiche périmée n'est jamais supprimée : elle signale les fichiers modifiés depuis, et masque son flux au-delà de 50 % de changements.

**Au lancement de `/revo-flow <demande>`** : si une fiche correspond à la demande, un dialogue propose **Utiliser** ou **Ignorer** (sous `claude -p`, elle est utilisée). Un brief d'au plus 1 200 tokens est alors injecté à l'orchestrateur. Le brief est une carte, pas la vérité : l'orchestrateur vérifie dans le code ce qu'il modifie. Sans fiche, seule la liste des features connues part (≈ 200 tokens).

**Côté agents** : quand une fiche est servie, revo-flow ajoute au prompt de chaque sous-agent un **extrait** d'au plus 600 tokens : les fichiers de la fiche que sa mission cite (sinon les fichiers d'entrée, cœur et données), marqués ⚠ s'ils ont changé depuis l'apprentissage, leurs pièges et le résumé. Ces fichiers sont comptés comme servis à cet agent (sa couleur dans le panneau). L'orchestrateur n'ajoute que ce qui manque (pièges transverses, décisions). Chaque agent a aussi l'outil ci-dessous, avec la consigne de chercher dans le cache avant d'explorer.

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

**Panneau et bande** : section « Cache » pliable avec les nœuds servis (● couleur de l'agent), frais (○) et périmés (⚠), les tokens évités et le coût de construction ; la bande ajoute `cache : 12 nœuds · 3 utilisés · ≈ 18k tokens évités`. Les tokens évités sont une estimation (« ≈ ») : la taille des fichiers servis, encore frais, que personne n'a relus, moins ce que le brief a injecté. Ordre de grandeur mesuré : 50 à 65 % de lecture en moins et ≈ 0,3 € par flow sur une feature connue. Sans fiche servie, revo-flow garde une baseline des tokens lus pour comparer.

## Options (`/config`)

| Option | Défaut | Effet |
| --- | --- | --- |
| `validerPlan` | oui | demande « Lancer » ou « Annuler » avant de lancer les agents ; sans personne à qui demander (`claude -p`), le plan part tout seul |
| `conflits` | `avertir` | fichier déjà modifié par un autre agent encore au travail : `avertir` affiche un toast, `refuser` bloque la modification |
| `notifier` | oui | notification système à la fin d'un flow et quand un agent échoue (un toast si elle ne peut pas partir) |
| `cache` | oui | brief du cache projet au lancement, extrait de fiche dans le prompt de chaque agent et outil `cache` proposé ; `non` : ni brief, ni extrait, ni outil, la commande `cache` reste |

Sur l'app desktop, `/revo-flow` n'apparaît pas toujours dans le menu `/` : tape la commande en entier, elle fonctionne.

## Développement

```
claude plugin validate .
claude plugin test .
```
