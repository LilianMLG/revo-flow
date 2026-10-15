# R&D : améliorer le cache projet, 2026-10-15

> R&D, 2026-10-15. Aucun fichier de code n'a été modifié. Les constats viennent d'une lecture du code de la v1.2.2
> (commit 8b836a6, numéros de ligne de cette version), du seul graphe présent sur ce poste
> (`~/.claude/revo-flow/graphs/revo-flow-d91766.json`, le dépôt revo-flow lui-même), du store du plugin
> (`~/.claude/plugins/store/revo-flow_revo-flow-abc92b870fb0.json`) et des chiffres de [conception.md](conception.md) §1 et §5
> pour reservation-tool et ui-vel, absents de ce poste. Les travaux v1.3 en cours (fiche périmée actionnable,
> actions `rafraichir` et `diff`, `agentExtract`, consignes renforcées des sous-agents) sont considérés comme acquis.

## 0. En bref

- Le cache fonctionne de bout en bout, mais **sa valeur dépend de fiches qui n'existent pas encore** : sur le seul graphe réel, 0 fiche, 0 candidate, stack « inconnue », stats à zéro. Le démarrage à froid est le vrai problème.
- **La mesure du gain n'est pas encore fiable** : la baseline est écrite mais jamais relue, mélange flows avec et sans cache, ignore Grep et Bash ; les « évités » gonflent tout seuls quand `completeFiche` agrandit une fiche.
- **Un bug fait perdre du savoir** : un `apprendre` partiel (sans `flux`, `entrees` ni `deps`) efface ces trois champs (§1.2, limite L1).
- L'état de l'art converge : **pas d'embeddings pour du code local** (Claude Code et Sourcegraph les ont abandonnés), mais **une carte structurelle classée** (Aider) et **une mémoire écrite par l'agent** (Cline, auto memory de Claude Code). revo-flow a déjà les deux briques ; il lui manque le classement et le résumé par fichier.
- Recommandation v1.4, dans l'ordre : corriger `apprendre` partiel, mesurer honnêtement, résumés Haiku d'une ligne par fichier, carte classée pour le démarrage à froid, lancement silencieux au-dessus d'un seuil. Environ 5 à 6 jours.

---

## 1. Ce que le cache fait aujourd'hui et ce qu'il ne fait pas

### 1.1 Le flux réel, lu dans le code

1. `/revo-flow <demande>` appelle `startFlowCache` (register.tsx) : l'état du flow repart à zéro, la mesure des lectures démarre même si le cache est désactivé.
2. `graphOf` charge `~/.claude/revo-flow/graphs/<cle>.json`, le rafraîchit par hash git (`ls-files -s`, `status`, `hash-object`), ou construit la couche mécanique s'il n'existe pas.
3. `matchRequest` score la demande contre les fiches (BM25 simplifié) : une fiche n'est retenue que si son score vaut au moins 6 (`MATCH_MIN`) et 1,5 fois celui de la deuxième.
4. Si une fiche est retenue, `$.ui.ask` demande « Utiliser / Ignorer » (ligne 715) ; sans interface, la fiche est utilisée.
5. `briefText` produit le brief (≤ 1 200 tokens), injecté dans le `context` avec `LEAD_BRIEF`. Les fichiers de la fiche sont notés « servis ».
6. L'orchestrateur lit le brief, interroge l'outil `mcp__revo-flow__cache` (`chercher`, `feature`, `voisins`, `candidates`), puis transmet un extrait à chaque sous-agent (v1.3 : `agentExtract` le fait aussi).
7. Chaque Read réussi passe par `noteRead` : chemin, taille, lecteur.
8. Seule l'action `feature` enregistre des fichiers servis ; `chercher` et `voisins` ne comptent que comme tokens injectés.
9. En fin de flow, l'orchestrateur appelle `apprendre` (`learn` : chemins validés, hash courants, confiance 0,9).
10. S'il ne l'a pas fait, `learnAtEnd` écrit une fiche auto (`autoFiche`) : fichiers modifiés en `coeur`, lus en `peripherique`, confiance 0,5, ni résumé ni flux.
11. `closeFlowCache` écrit la baseline si rien n'a été servi, appelle `recordUsage` (usages, évités, net) et `completeFiche` sur la fiche du brief.
12. `saveGraph` écrit le `.tmp`, le relit, puis écrit la cible, après fusion par feature avec la version disque.
13. Le panneau et la bande lisent `computeStats` : évités, net, complétude.
14. `/revo-flow cache build` lance `revo-flow:cache-indexer` (Sonnet medium, arrière-plan) qui finit lui aussi par `apprendre`.
15. Le graphe en mémoire est réutilisé 30 s (`REFRESH_MS`) avant toute nouvelle vérification par hash.

### 1.2 Limites constatées, avec preuve

| # | Limite | Preuve | Effet |
|---|---|---|---|
| L1 | **`apprendre` partiel efface `flux`, `entrees` et `deps`** | register.tsx 668-676 : `flux: texts(e.flux)` vaut `[]` quand le champ manque ; graph.ts 1273 et 1280 testent `input.flux ?` et `input.deps ?`, vrais pour `[]` ; 1243 `if (input.entrees)` idem. Toujours présent dans l'arbre de travail v1.3 | Un agent qui ajoute un piège vide le flux de la fiche. Le test `learn` appelle `learn` directement, sans passer par `learnTool`, et ne le voit pas |
| L2 | Stack « inconnue » hors Nuxt, Vue, React, Nest, Dart | `detectStack` (graph.ts 255-297) ne lit que `package.json` et `pubspec.yaml`. Le dépôt revo-flow n'a ni l'un ni l'autre : stack « inconnue », alors que `.claude-plugin/plugin.json` existe | Brief vide d'information sur un plugin, un projet Python, Go ou Rust |
| L3 | Types de fichiers mal reconnus hors conventions Nuxt | Graphe réel : 6 fichiers sur 17 en `autre` (`hooks/*.ts`, `hooks/register.tsx`), soit 71k tokens sur 116k | `chercher` et les rôles par défaut perdent leur sens |
| L4 | 0 candidate sans scope de commit | `SUBJECT_SCOPE` (933) exige `type(scope):`. revo-flow : 6 commits, 1 seul avec scope (`docs(readme)`, ignoré par `SCOPES_IGNORES`) ; il faut en plus 2 commits par scope (962) | Pas d'amorce sans flow ni `build` manuel |
| L5 | Candidates figées | Calculées seulement dans `buildMechanical` (`git log -n 500`, store.ts 603) ; `refreshGraph` ne les recalcule pas | Liste qui vieillit jusqu'au prochain build complet |
| L6 | Faux nœuds tirés des fixtures | Graphe réel : `q:allOffers`, `q:Accommodations` et `x:generated/gql-types` viennent des chaînes de `graph.test.ts` | Bruit dans `voisins` et dans les futurs liens Front ↔ Back |
| L7 | **Baseline écrite, jamais lue** | Seule écriture : register.tsx 765-767 (`baseline:<cle>` dans `$.store`) ; aucun lecteur. Store réel : aucune clé `baseline:` | Le gain affiché n'est comparé à rien |
| L8 | Baseline contaminée | Écrite si `servis.length === 0` : inclut les flows avec cache actif mais sans fiche, qui ont reçu le brief et ont pu utiliser `chercher` et `voisins` | La baseline mélange deux populations |
| L9 | Lectures sous-comptées | `noteRead` ne voit que Read (1554) ; Grep, Glob et `cat` par Bash ne comptent pas. Un Read partiel vaut `limit × 3` tokens (518), soit 3 tokens par ligne contre 8 à 10 en pratique | Baseline et complétude sous-estimées |
| L10 | **« Évités » contrefactuel et optimiste** | `gains` : tout fichier servi frais et non lu compte comme évité, même s'il n'aurait jamais été lu (un `peripherique` lu une fois par hasard) | Gain surévalué, sans borne connue |
| L11 | Boucle d'auto-gonflement | `completeFiche` (1330-1338) ajoute chaque fichier lu hors fiche. Au flow suivant, s'il n'est pas relu, il devient « évité » | Estimation : une fiche de 8 fichiers qui gagne 5 périphériques par flow (médiane 465 à 709 tokens) ajoute 2 à 3,5k « évités » par flow sans aucun gain réel |
| L12 | `voisins` et `chercher` jamais crédités | `cacheTool` : `hits` reste vide pour ces actions ; seul `tokensOf(answer)` est compté | À l'inverse de L10, le net est pessimiste sur l'outil le plus utile pour remplacer les grep |
| L13 | Fichiers ajoutés sans validation | `completeFiche` et `autoFiche` enregistrent le hash courant (1338, 1319) d'un fichier dont personne n'a vérifié le rôle | La fiche paraît fraîche pour des fichiers jamais compris |
| L14 | `learn` remet tous les hash | 1276 : `h: graph.fichiers[p]!.h` pour tous les fichiers, y compris ceux non relus | Une mise à jour partielle masque des fichiers périmés. Corrigé par `rafraichir` en v1.3, pas par `apprendre` |
| L15 | Fiches auto sans résumé ni flux, une par flow | `autoFiche` : id = `slug(flow.title)` quand aucune fiche n'a été servie ; confiance 0,5, `resume: ''`, `flux: []` | Chaque flow sans `apprendre` crée une nouvelle fiche au nom unique. Elle sert à `chercher` (liste de fichiers), presque pas au brief. Pollution probable de la ligne « features connues » |
| L16 | Confirmation à chaque correspondance | `$.ui.ask` (715) | Un clic et une attente à chaque flow, pour protéger d'un risque qui coûte < 0,01 $ (§3.5) |
| L17 | Fenêtre de 30 s | `REFRESH_MS` (394) : un fichier édité par un agent reste « frais » jusqu'à 30 s | Fiche déclarée fraîche à tort pendant le flow même qui la modifie |
| L18 | `sum` jamais écrit | `sum` existe (types/cache.d.ts 38), est conservé (834, 904), indexé par BM25 (1059) et affiché (1597, 1641), mais rien ne l'écrit | `chercher` et `voisins` donnent un chemin et une taille, pas ce que fait le fichier |
| L19 | Pas de nœud par symbole | Choix de conception.md §2.1 ; `exp` garde les noms exportés sans arêtes. `hooks/lib.ts` : 53 exports, aucun lien vers leurs appelants | Impossible de classer les fichiers par importance ni de répondre « qui appelle `slug` » |
| L20 | Pas de liens Front ↔ Back, pas de partage d'équipe | Lot 4 non commencé ; graphe dans `~/.claude` seulement | Savoir perdu en changeant de poste, flows transverses non aidés |
| L21 | Copie `.tmp` laissée sur disque | store.ts 383 : choix assumé (secours) ; réel : 5 577 octets en double | Négligeable (65 à 95 Ko par projet réel) : à garder |
| L22 | Blobs absents de la base git | `hash-object --stdin-paths` sans `-w` (store.ts 475) : le hash d'un fichier non commité n'existe pas comme objet | Le `diff` v1.3 depuis un hash appris sur un fichier modifié non commité échouera : repli nécessaire sur `git diff <appris.commit> -- <chemin>` |

### 1.3 Ce que disent les données de consommation

Le store du plugin donne les cumuls réels du poste (tous flows confondus) :

| Jour | Écriture de cache | Lecture de cache | Rapport lecture / écriture |
|---|---|---|---|
| 2026-10-14 | 1,35 M | 18,3 M | **13,6** |
| 2026-10-15 (partiel) | 0,60 M | 4,72 M | 7,8 |
| Semaine 42 | 1,95 M | 23,0 M | 11,8 |

Un token entré dans le contexte est donc relu **8 à 14 fois** en moyenne. Conception.md supposait 20 à 30 tours de traîne ; la mesure réelle est plus basse. Conséquence pour tous les chiffrages ci-dessous :

| Coût d'un token lu (tarifs de `lib.ts`, traîne ×12) | Écriture | Traîne | Total |
|---|---|---|---|
| Opus (orchestrateur) | 5 $/M | 12 × 0,2 $/M | **≈ 7,4 $/M**, soit 0,007 $ pour 1k tokens |
| Sonnet (agents) | 2,5 $/M | 12 × 0,2 $/M | **≈ 4,9 $/M** |

Le gain par flow de conception.md §5.1 (≈ 0,32 €) reste du bon ordre de grandeur, mais plutôt vers 0,25 € avec ce facteur. Avec un abonnement, la vraie monnaie reste la fenêtre de 5 h et le contexte.

---

## 2. État de l'art

### 2.1 Synthèse

| Outil | Principe | Transposable à revo-flow | Pas transposable |
|---|---|---|---|
| **Aider, repo map** | tree-sitter extrait définitions et références ; graphe de symboles ; PageRank personnalisé sur les fichiers du chat ; carte rendue dans un budget (1 024 tokens par défaut, ajusté par recherche binaire) | Le classement : PageRank sur les arêtes que revo-flow a déjà (importe, utilise, rend), personnalisé par la demande ; la carte en budget fixe pour le démarrage à froid ; les exports (`exp`) comme lignes de la carte | tree-sitter : pas de npm ni de WASM dans l'API plugin. Les regex existantes restent l'extracteur |
| **Cursor** | Arbre de Merkle des hash de fichiers, découpage AST, embeddings calculés côté serveur, réutilisation de l'index d'un collègue via un simhash | Le principe des hash est déjà là (blobs git). L'idée « réutiliser l'index d'équipe » plaide pour l'export Markdown des fiches | Embeddings et base vectorielle distante : pas de réseau, pas d'API d'embeddings dans `$.model` |
| **Continue** | Hybride : embeddings locaux (transformers.js) + plein texte, puis reranking par LLM (25 candidats, 5 gardés) | **Le reranking par LLM** : BM25 propose 5 à 25 fiches, Haiku tranche la zone grise | transformers.js, index vectoriel local |
| **Sourcegraph Cody** | A retiré les embeddings en 5.3 au profit de la recherche ; résultats « aussi bons, parfois meilleurs » selon l'éditeur | Conforte le choix BM25 + graphe | Moteur de recherche serveur |
| **Claude Code** | Recherche agentique (Grep, Glob, Read) après abandon d'un RAG local ; `CLAUDE.md` écrit par l'humain, auto memory (`MEMORY.md`, 200 lignes ou 25 Ko chargés) écrite par Claude, rechargés après compaction | Le cache doit rester une carte qui guide le grep, pas un substitut ; ce qui doit survivre à la compaction passe par `flowRecap` (déjà fait) | Écrire dans `CLAUDE.md` ou la mémoire auto : ce n'est pas au plugin de le faire |
| **Cline, memory bank** | Fichiers Markdown dans le dépôt (`projectbrief`, `activeContext`, `systemPatterns`, `techContext`, `progress`), mis à jour par l'agent en fin de session | Format lisible et versionné pour l'export d'équipe ; l'équivalent d'`activeContext` est l'`apprendre` de fin de flow | La mise à jour manuelle « update memory bank » : revo-flow l'automatise déjà |
| **Augment, context engine** | Index sémantique propriétaire, synchronisation quasi temps réel, servi par MCP ; +70 % annoncés (chiffre de l'éditeur) | Rien de direct ; confirme que la qualité du contexte pèse plus que le modèle | Modèles d'embeddings et de retrieval entraînés, service distant |
| **Codebase-Memory (arXiv 2603.27277), CodeGraph, Code Graph RAG** | Graphe de connaissance tree-sitter servi par MCP ; Codebase-Memory mesure 83 % de qualité contre 92 % pour un agent qui explore, avec **10 fois moins de tokens** et 2,1 fois moins d'appels | L'ordre de grandeur du compromis : le graphe fait perdre un peu de justesse et gagne beaucoup de tokens. D'où la règle « carte, pas vérité » et la lecture des fichiers à modifier | Base de graphe (Neo4j, SQLite) et parseurs natifs |
| **Serena (LSP via MCP)** | Outils au niveau symbole adossés à un vrai serveur de langage : `find_symbol`, `find_referencing_symbols` | L'idée d'un `voisins` par symbole | Un serveur de langage persistant : `$.process.run` est limité à 10 min, `$.process.spawn` existerait mais dépend d'outils installés chez l'utilisateur. Trop fragile |

### 2.2 Ce qu'on en retient

1. **Pas d'embeddings.** `$.model.complete` renvoie du texte, pas de vecteurs. Les simuler par un LLM serait coûteux et faux. Les deux acteurs qui avaient des embeddings pour du code local les ont retirés.
2. **Classer avant de servir.** La force d'Aider est le classement (PageRank), pas l'extraction. revo-flow a déjà le graphe, il ne le classe pas.
3. **Un LLM bon marché comme arbitre, pas comme index.** Continue reranke par LLM ; c'est transposable tel quel avec Haiku sur 5 à 25 candidats.
4. **La mémoire écrite par l'agent est la norme** (Cline, auto memory). L'apprentissage de fin de flow est la bonne architecture ; il faut le rendre fiable (L1, L13, L15) plutôt que le remplacer.
5. **Le gain réel est d'un ordre de grandeur sur les tokens, au prix d'un peu de justesse** (Codebase-Memory). Il faut le mesurer chez nous, pas le supposer.

---

## 3. Pistes d'amélioration chiffrées

Les gains sont des **estimations** sauf mention contraire. Hypothèses communes : feature moyenne de reservation-tool (28 à 32k tokens, conception.md §1.1), traîne ×12 (§1.3), fichier médian 465 tokens (reservation-tool) et 709 (ui-vel).

### 3.1 Tableau de classement

| Rang | Piste | Gain attendu | Coût en marche | Effort | Valeur / effort |
|---|---|---|---|---|---|
| 0 | Corriger `apprendre` partiel (L1) | Fiabilité : plus de flux effacé | 0 | ¼ j | Bug, à faire d'abord |
| 1 | (j) Mesure honnête et baseline corrigée | Rend tous les autres chiffres vérifiables | 0 token | 1 j | Très haute |
| 2 | (b) `sum` Haiku d'une ligne par fichier | 2 à 4k tokens par flow à froid ; meilleure recherche | 0,03 à 0,6 $ par projet, une fois | 1,5 à 2 j | Haute |
| 3 | (e) Lancement silencieux au-dessus d'un seuil | Un clic par flow ; 0 token | < 0,01 $ par faux positif | ½ j | Haute |
| 4 | (a) Carte classée par PageRank (fichiers d'abord) | 2 à 8k tokens par flow à froid | ≈ 1k tokens injectés | 1 à 1,5 j (fichiers), +2 j (symboles) | Haute pour les fichiers, moyenne pour les symboles |
| 5 | (c) `diff` comme mode principal de rafraîchissement | 50 à 90 % de la relecture des gros fichiers périmés | Quelques centaines de tokens par diff | ½ à 1 j au-delà de la v1.3 | Haute |
| 6 | (m1) Reranking Haiku de la zone grise | Plus de fiches trouvées (synonymes, FR/EN) | ≈ 1k tokens Haiku et 1 à 2 s par lancement ambigu | ½ j | Moyenne à haute |
| 7 | (f) Candidates sans scope | Amorce sur les dépôts sans conventions | 0 token | 1 à 1,5 j | Moyenne |
| 8 | (d) Décroissance de confiance | Fiabilité | 1 appel git par fiche servie | ½ j | Moyenne |
| 9 | (k) Extraits par agent | 8 à 16k tokens par flow (conception.md §5.1) | ≤ 600 tokens par agent | En cours (v1.3) | Déjà engagée |
| 10 | (l) Fiches voisines en une ligne | Faible, quelques centaines de tokens | ≈ 50 tokens par dépendance | ¼ j | Moyenne |
| 11 | (g) Stack et imports élargis | Utile seulement hors Nuxt | 0 | ½ j (stack) à 3 j (imports Python, Go) | Selon les projets réels |
| 12 | (h) Export et import Markdown | Partage d'équipe | 0 | 1 à 1,5 j | Moyenne, dépend de l'équipe |
| 13 | (i) Liens Front ↔ Back | Flows transverses | 0 | 2 à 3 j | Basse tant que la fréquence est inconnue |
| 14 | (m2) Embeddings via `$.model.complete` | Aucun | Élevé | n/a | À écarter |

### 3.2 (j) Une vraie mesure, et une baseline corrigée

- **Principe.** Remplacer les sommes cumulées par un journal de flows (les 200 derniers, dans le fichier graphe) : `{ cache: on|off, fiche servie, feature, lus, lus par Grep, injecté, servis, durée, tours }`. Écrire la baseline **seulement** quand le cache est désactivé. Compter les sorties de Grep et de Bash `cat`/`sed -n`. Créditer `voisins` (fichiers listés et non lus ensuite) et `chercher`, avec un poids prudent.
- **Contrefactuel plus honnête.** Un fichier servi et non lu ne compte comme évité que s'il a été lu dans un flow antérieur de la même feature, ou s'il a le rôle `coeur`, `entree` ou `donnees`. Cela coupe la boucle L11.
- **A/B.** Les tailles de features varient de 6k à 100k (écart-type du même ordre que la moyenne). Pour voir une baisse de 50 % avec une confiance raisonnable, il faut environ 30 à 60 flows par bras (estimation : effet de 0,5 à 0,7 écart-type). Une alternance automatique d'un flow sur cinq sans cache coûterait cher en tokens perdus pour un signal lent. Proposition : option `cache: off` manuelle, plus une comparaison **par feature** (même feature, avant et après sa fiche), qui réduit fortement la variance.
- **Coût.** 0 token, quelques Ko dans le graphe.
- **Effort.** 1 j.
- **Risque.** Faible. Le chiffre affiché baissera : c'est le but.

### 3.3 (b) Un résumé d'une ligne par fichier, écrit par Haiku

- **Principe.** À la construction mécanique, puis à chaque fichier modifié, `$.model.complete({ model: 'haiku' })` écrit `sum` (≤ 120 caractères). Regrouper 5 à 10 petits fichiers par appel. Tronquer les fichiers de plus de 6k tokens à leurs exports et à leur début. Exclure les tests et les docs.
- **Gain.** `chercher` et `voisins` deviennent lisibles : « services/offer.ts · service · 1,2k · offres du rule engine et produits complémentaires ». Un agent choisit sans ouvrir. Estimation : 3 à 5 lectures exploratoires évitées par flow à froid, soit 2 à 4k tokens directs, 15 à 30k avec la traîne. `sum` est déjà indexé par BM25 : `matchRequest` et `chercher` progressent aussi sans fiche.
- **Coût de construction.** Hypothèses : code hors tests, 250 tokens de consigne par fichier, 40 tokens de sortie.

| Projet | Fichiers | Entrée | Sortie | Tarifs `lib.ts` (0,1 / 0,5 $/M) | Tarif public Haiku 4.5 (1 / 5 $/M) |
|---|---|---|---|---|---|
| reservation-tool | 284 | ≈ 270k | ≈ 11k | ≈ 0,03 $ | ≈ 0,33 $ |
| ui-vel | 427 | ≈ 540k | ≈ 17k | ≈ 0,06 $ | ≈ 0,62 $ |

  Le regroupement par lots divise la part « consigne » par 5 à 10. Ensuite, l'incrémental coûte presque rien : 4 à 5 fichiers par commit.
- **Temps.** 284 appels à 1,5 à 3 s : 7 à 14 min en série, 2 à 4 min avec 4 appels en parallèle. À faire en arrière-plan, jamais au lancement d'un flow.
- **Taille.** 120 caractères × 427 fichiers ≈ 50 Ko : sous la cible de 300 Ko.
- **Effort.** 1,5 à 2 j (file d'attente, reprise, annulation, invalidation par hash, affichage).
- **Risques.** Résumé faux sur un gros fichier tronqué (le marquer « partiel ») ; quota consommé sur un abonnement ; code envoyé à Haiku, comme il l'est déjà au modèle de la session.

### 3.4 (a) Une carte classée, d'abord par fichier, puis par symbole

- **Principe.** PageRank personnalisé à la Aider sur les arêtes `importe`, `utilise`, `rend`, `appelle`. Le vecteur de personnalisation vient des résultats de `chercher` sur la demande. La carte liste les 30 à 50 fichiers les mieux classés avec leur `sum` et 3 à 5 exports, dans un budget fixe de 800 à 1 000 tokens. Elle remplace le brief vide quand aucune fiche ne correspond.
- **Gain.** Surtout à froid, soit aujourd'hui 100 % des flows du graphe réel. Estimation : 1 à 3 explorations (grep plus 2 ou 3 lectures, 2 à 8k tokens) évitées par flow. Avec la traîne : 0,02 à 0,06 $ par flow pour l'orchestrateur.
- **Coût.** ≈ 1k tokens injectés par flow. Le calcul est négligeable : 284 nœuds, environ 1 500 arêtes, 20 itérations, moins de 10 ms.
- **Niveau symbole.** Il faut des arêtes « fichier → symbole utilisé ». `CALL_RE` et `importedNames` donnent déjà une bonne partie des appels et des imports nommés. Plus 2 jours, et un graphe 2 à 3 fois plus gros (estimation : 150 à 300 Ko pour ui-vel, sous le plafond de 1 Mo). À ne faire que si la carte par fichier prouve sa valeur dans la mesure (j).
- **Effort.** 1 à 1,5 j (fichiers).
- **Risques.** Une carte générique qui coûte 1k tokens sans servir. Parade : ne l'injecter que si la personnalisation trouve au moins un fichier pertinent, sinon garder les 200 tokens actuels.

### 3.5 (e) Alléger la confirmation au lancement

- **Constat.** Un faux positif coûte au plus le brief : 1 200 tokens × 7,4 $/M, soit **moins de 0,01 $**, plus un risque d'induire en erreur déjà borné par « carte, pas vérité ». La confirmation coûte un clic et une attente à chaque flow qui correspond, c'est-à-dire exactement aux flows où le cache sert.
- **Proposition.** Trois zones :

| Zone | Condition (indicative) | Comportement |
|---|---|---|
| Nette | score ≥ 2 × `MATCH_MIN` et ≥ 2 × la deuxième, fiche fraîche ou partielle | Silencieux ; fiche affichée dans le panneau et la bande |
| Grise | entre le seuil actuel et la zone nette | Reranking Haiku (m1) ou question actuelle |
| Absente | sous le seuil | Brief court ou carte (a) |

- **Effort.** ½ j.
- **Risque.** Revient sur la décision 2 du 2026-10-14 : à trancher par l'utilisateur (§4).

### 3.6 (c) Le diff comme mode principal de rafraîchissement

- **Principe.** Pour une fiche partielle, servir le diff de chaque fichier modifié depuis l'apprentissage au lieu d'inviter à relire. Règle : diff si sa taille est inférieure à 30 % du fichier, sinon « relire ».
- **Gain.** Hypothèses : un correctif change 20 à 40 lignes par fichier ; avec 3 lignes de contexte, 60 à 100 lignes à 8 tokens.

| Fichier | Taille | Diff estimé | Gain sur la relecture |
|---|---|---|---|
| médian reservation-tool | 465 | 400 à 800 | nul (relire) |
| `useStockTimeline.ts` | 4,3k | 0,5 à 0,8k | ≈ 85 % |
| `stores/booking/Cart.ts` | 11,1k | 0,5 à 0,8k | ≈ 93 % |
| `store/booking.ts` (ui-vel) | 14,4k | 0,5 à 1k | ≈ 95 % |

  Sur une fiche partielle où 3 gros fichiers ont bougé (≈ 20k), la relecture tombe à 2k environ. Les fichiers à modifier restent à lire en entier : le gain ne porte que sur ceux qu'on relit pour comprendre.
- **Piège (L22).** Les hash appris sur un fichier non commité n'existent pas dans la base git. Repli : `git diff <appris.commit> -- <chemin>`, ou `hash-object -w` au moment d'apprendre (écrit un objet orphelin, nettoyé par `gc`).
- **Effort.** ½ à 1 j au-delà de l'action `diff` de la v1.3.
- **Risque.** Un diff de refactor (renommage massif) est illisible : le plafond de 30 % le renvoie à la relecture.

### 3.7 (m1) Haiku pour trancher la correspondance

- **Principe.** Quand BM25 hésite (zone grise, ou aucune fiche au-dessus du seuil mais au moins une au-dessus de 2), envoyer à Haiku la demande et les 5 à 25 meilleures fiches (id, titre, alias : ≈ 30 tokens chacune). Il répond un id ou « aucune ».
- **Gain.** BM25 rate les synonymes et le mélange français-anglais (« panier » et `Cart`, « navette » et `SHUTTLE`) ; les alias l'atténuent sans le régler. Fiabilité plutôt que tokens.
- **Coût.** ≈ 1k tokens Haiku (0,0001 à 0,001 $) et 1 à 2 s au lancement, seulement dans la zone grise.
- **Effort.** ½ j.

### 3.8 (f) Candidates sans scope de commit

- **Principe.** Trois replis, dans l'ordre :
  1. **Mots du sujet** : `terms()` du sujet (« cache projet », « tokens terminal ») croisé avec les fichiers du commit ; un mot présent dans au moins 3 commits devient une candidate. Le gitmoji ou le type (`feat`, `fix`) ne désignent pas une feature : ils servent seulement à écarter `docs` et `chore`.
  2. **Co-changement** : paires de fichiers modifiés ensemble dans au moins 3 commits, regroupées par composantes connexes (Jaccard ≥ 0,3).
  3. **Dossiers** : `components/booking/*` et assimilés, quand le dossier pèse plus de 3k tokens.
- **Gain.** Amorce sur les dépôts sans conventional commits. Sur revo-flow, 6 commits ne suffisent à aucune méthode : la piste vise les dépôts plus anciens.
- **Effort.** 1 à 1,5 j, recalcul au rafraîchissement compris (L5).
- **Risque.** Candidates bruitées. Les garder hors du brief et ne les montrer que dans `candidates` et `cache build`.

### 3.9 (d) Décroissance de confiance

- **Principe.** `confiance servie = confiance × fraîcheur × f(âge) × g(commits sur les voisins à 1 saut hors fiche depuis appris.commit)`. Exemple : −10 % par tranche de 20 commits sur les voisins, plancher 0,3. Les hash couvrent déjà les fichiers de la fiche ; la décroissance couvre ce qu'ils ne voient pas : une dépendance qui change de contrat.
- **Coût.** Un `git rev-list --count <commit>..HEAD -- <voisins>` par fiche servie (< 100 ms). Commit disparu : repli sur l'âge seul.
- **Effort.** ½ j. **Gain.** Fiabilité ; aucun token.

### 3.10 (k) et (l) : extraits par agent, fiches voisines

- **(k)** est en cours (v1.3, `agentExtract`, ≤ 600 tokens par agent). Conception.md §5.1 attribue aux agents 16k des 36k tokens économisés : c'est la deuxième source de gain après l'orchestrateur. À mesurer avec (j) dès sa sortie.
- **(l)** Précharger une fiche voisine entière coûte jusqu'à 1 500 tokens pour un usage incertain. Proposition : une ligne par dépendance (`deps`) dans la fiche servie (id, titre, fraîcheur, ≈ 50 tokens), l'agent appelle `feature` s'il en a besoin. ¼ j.

### 3.11 (g) Stack et imports élargis

- **Stack** (½ j) : `.claude-plugin/plugin.json` donne « plugin Claude Code » ; `pyproject.toml` ou `requirements.txt`, `go.mod`, `Cargo.toml`, `pom.xml` donnent la famille. `kindOf` gagne `hooks/` et les dossiers NestJS (`*.controller.ts`, `*.resolver.ts`, `*.module.ts`).
- **Imports génériques** (1 à 1,5 j par langage) : Python (`import x`, `from x import y`), Go (chemins de paquet sous le module). À ne faire que si l'utilisateur travaille sur ces langages.
- **Mode générique** sans résolution : nœuds fichiers, exports par regex large, arêtes par co-changement. Mieux que rien, et presque gratuit une fois (f) fait.

### 3.12 (h) Export et import Markdown pour l'équipe

- **Principe.** `/revo-flow cache export [feature]` écrit `docs/revo-flow/<feature>.md` (titre, résumé, flux, fichiers et rôles, pièges, date, modèle), sans hash. `import` relit ces fichiers, valide les chemins et recalcule les hash : la confiance importée vaut 0,7.
- **Gain.** Le savoir survit au poste et se relit en MR. C'est le modèle de la memory bank de Cline, en mieux : écrit en fin de flow, pas à la main.
- **Effort.** 1 à 1,5 j. **Risque.** Résumés non relus dans le dépôt : export uniquement sur commande, jamais automatique.

### 3.13 (i) Liens Front ↔ Back

- **Principe.** Côté Back, reconnaître les résolveurs (`@Query() allOffers`, `@Mutation()`) et les routes (`@Post('complementary-products')`) ; relier les nœuds `q:` et `a:` des deux graphes par leur nom. `voisins` sur `q:allOffers` répond alors par le résolveur.
- **Préalable.** Corriger les faux nœuds tirés des fixtures (L6), sinon les liens seront faux.
- **Effort.** 2 à 3 j. **Valeur.** Inconnue tant qu'on ignore la part de flows qui touchent les deux côtés (§4).

### 3.14 (m) Autres pistes après l'état de l'art

| Piste | Verdict |
|---|---|
| Embeddings via `$.model.complete` | **Non.** Pas d'API de vecteurs ; demander à un LLM des vecteurs serait coûteux, lent et sans garantie de cohérence. Claude Code et Sourcegraph ont abandonné les embeddings pour du code |
| Invalider le graphe sur Edit et Write (L17) | **Oui, trivial** : vider l'entrée de `graphCache` dans le hook `tool.call` qui suit déjà les fichiers modifiés. ¼ j |
| Ignorer les chaînes des tests pour `gql` et `api` (L6) | **Oui.** ¼ j |
| Ranger les fiches auto (L15) | **Oui.** Rattacher les fichiers à la fiche existante qui en partage le plus ; sinon fiche « brouillon », hors brief, supprimée après 10 flows sans usage. ½ j |
| Ne pas valider ce que personne n'a lu (L13) | **Oui.** `completeFiche` enregistre `h: ''` pour un périphérique ajouté : il apparaît « à vérifier » jusqu'au prochain `apprendre` ou `rafraichir` |
| Serveur de langage (Serena) | **Non** pour l'instant : dépend d'outils installés, processus persistant fragile dans l'API plugin |

### 3.15 Recommandation pour la v1.4

| Ordre | Piste | Pourquoi maintenant | Effort |
|---|---|---|---|
| 0 | Corriger `apprendre` partiel (L1), plus les correctifs rapides L6, L15, L17 | Bugs qui détruisent ou faussent le savoir ; 1 j au total | 1 j |
| 1 | (j) Mesure honnête | Sans elle, aucune des pistes suivantes ne peut prouver son gain, et le panneau affiche un chiffre gonflé (L10, L11) | 1 j |
| 2 | (b) `sum` Haiku | Rend `chercher` et `voisins` utiles dès le premier flow, améliore la recherche ; coût de quelques centimes à 0,6 $ par projet | 1,5 à 2 j |
| 3 | (a) Carte classée par fichier | Donne un brief utile à froid, là où le cache n'apporte rien aujourd'hui ; s'appuie sur `sum` | 1 à 1,5 j |
| 4 | (e) Lancement silencieux, avec (m1) pour la zone grise si le temps le permet | Retire une friction à chaque flow utile ; le risque coûte moins d'un centime | ½ à 1 j |

Total : 5 à 6,5 jours. (c) se prolonge naturellement de l'action `diff` v1.3 et peut s'y glisser si elle a pris le piège L22 en compte. (f), (g), (h), (i) et la carte par symbole attendent les chiffres de (j).

---

## 4. Questions ouvertes

1. **Confirmation au lancement** : acceptez-vous le mode silencieux au-dessus d'un seuil net, avec la fiche visible dans le panneau (revient sur la décision 2 du 2026-10-14) ?
2. **Résumés Haiku** : la construction coûte de 0,03 à 0,6 $ par projet selon le tarif réel de Haiku, et consomme du quota avec un abonnement. Lancement automatique à la construction, ou seulement sur `cache build` ?
3. **Mesure** : préférez-vous une option `cache: off` manuelle (proposée) ou une alternance automatique d'un flow sur cinq, plus rapide à conclure mais qui perd le gain sur ces flows ?
4. **Projets cibles** : hors reservation-tool et ui-vel, quelles stacks comptent (Back NestJS, Python, Go, plugins comme revo-flow) ? Cela décide de (g) et (i).
5. **Partage d'équipe** : l'export Markdown des fiches doit-il aller dans `docs/` du projet, et qui le relit avant commit ?

---

## Sources

- Aider, repository map : https://aider.chat/docs/repomap.html et la synthèse https://www.agentpatterns.ai/context-engineering/repository-map-pattern/
- Aider, budget de la carte : https://fast.io/resources/aider-token-limit.md
- Cursor, indexation sécurisée (Merkle, simhash) : https://cursor.com/blog/secure-codebase-indexing ; analyse : https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast
- Continue, contexte du codebase (hybride, reranking) : https://docs.continue.dev/customize/deep-dives/codebase
- Sourcegraph Cody, abandon des embeddings : https://sourcegraph.com/docs/cody/faq
- Claude Code, glossaire (CLAUDE.md, auto memory, compaction) : https://code.claude.com/docs/en/glossary.md ; mémoire : https://code.claude.com/docs/en/memory
- Claude Code, recherche agentique plutôt que RAG (source secondaire) : https://www.besthub.dev/articles/why-top-ai-coding-agents-dropped-vector-databases-for-grep-based-retrieval-e16a7a8ee9f5
- Cline, memory bank : https://docs.cline.bot/prompting/cline-memory-bank
- Augment, context engine MCP : https://augmentcode.com/blog/context-engine-mcp-now-live
- Codebase-Memory (graphe tree-sitter via MCP, mesures de tokens) : https://arxiv.org/abs/2603.27277
- Graphes de code pour agents (CodeGraph, Code Graph RAG) : https://www.buildmvpfast.com/blog/codebase-knowledge-graph-ast-coding-agents-2026 et https://moclaw.ai/blog/what-is-code-graph-rag
- Serena, outils par symbole : https://mcp.directory/blog/serena-mcp-complete-guide-2026
