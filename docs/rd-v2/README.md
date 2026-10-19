# R&D v2 : le flow vérifié

> Étude du 2026-10-19, sur la v1.5.0 (commit 42a6a20). Aucun fichier de code n'a été modifié.
> Trois documents : ce résumé, [conception.md](conception.md) (la feature en détail, lignes des typings comprises)
> et [execution.md](execution.md) (preuve à l'exécution, web puis mobile : lots 3 et 4).
> Entrées : une veille web sourcée (2026-10-19), une lecture de l'API plugin de Claude Code 2.1.303
> (`.claude-plugin/types/claude-code/index.d.ts`, 16 700 lignes) et des 14 projets Front et Back du poste.

## Verdict

**La v2 doit faire de revo-flow un « flow vérifié » : revo-flow apprend les commandes de vérification de chaque projet
(lint, typecheck, tests ciblés), les exécute lui-même et refuse de déclarer un flow « terminé » tant qu'elles sont
rouges ; ensuite, un contrat d'acceptation, un vérificateur indépendant et des tests gelés empêchent que la preuve soit
truquée.**

Pourquoi c'est elle qui gagne le plus, sur le web comme sur le mobile :

1. **Le goulot n'est plus l'écriture du code, c'est sa vérification.** Le code co-écrit par une IA porte 1,7 fois plus
   de problèmes (CodeRabbit, chiffre d'éditeur) ; les PR fusionnées augmentent, le temps de revue aussi (Faros, source
   secondaire). La première consigne d'Anthropic pour Claude Code est « donner un moyen de vérifier » [lu].
2. **C'est le plus gros trou du mod.** Aujourd'hui, `finishFlow` (register.tsx:454-467) marque le flow « terminé » sans
   aucun contrôle. Les tests et le lint ne sont qu'une phrase du brief (lib.ts:267). Dans le flow réel « Cache v1.5 »
   (9,47 $), les tests finaux ont été lancés à la main par l'orchestrateur.
3. **Le même mécanisme sert les 14 projets.** Les scripts `lint`, `test`, `build` sont homogènes par famille : Nuxt 2
   (Jest), Nuxt 3 (Vitest et typecheck), NestJS (Jest), Architect (Vitest et Biome), Flutter (`flutter test` et
   `analyze`). `flutter analyze` et `flutter test` tournent sous Windows sans émulateur : le mobile en profite dès le
   lot 1.
4. **Le lot 1 ne coûte presque rien en tokens.** C'est revo-flow qui lance les commandes (`$.process.run`), pas un
   modèle. Un modèle ne lit que les erreurs nouvelles, et seulement quand c'est rouge.
5. **Tout existe dans l'API plugin** : exécution de commandes, hook `classic.Stop` qui peut refuser la fin d'un tour,
   agent enregistré en lecture seule, refus d'un `Edit` par agent, question `$.ui.ask`. Rien n'est bloqué par l'API ;
   les limites sont la durée (10 min par commande) et Windows.

Ce que l'étude ne montre pas : **aucune mesure indépendante ne chiffre le gain d'une boucle de vérification sur des
projets comme les vôtres.** Les seuls chiffres solides sont sur SWE-bench (ExecCritic, préprint : +4 points avec des
tests gelés écrits par un autre modèle, −3,9 points quand l'agent écrit ses propres tests). D'où un lot 1 qui commence
par **mesurer** le taux de flows qui finissent rouges.

## Classement des pistes

Gains : **estimations** sauf mention. Effort en jours de développement. « Preuve » : [lu] = source primaire lue,
[sec.] = résumé non recoupé, [éditeur] = chiffre du vendeur.

| # | Piste | Gain attendu | Preuve | Faisabilité API plugin | Coût en marche | Effort | Risque | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | **Porte de vérification exécutée par revo-flow** : commandes apprises par projet, tests ciblés par le graphe, base de référence, fin du flow refusée si rouge | Plus aucun flow « terminé » avec un lint, un typecheck ou un test rouge. Rentable dès 12 % de flows rouges (§ Gains) | Anthropic, bonnes pratiques et harness [lu] ; mod : `finishFlow` sans contrôle, tests lancés à la main dans « Cache v1.5 » | Haute : `$.process.run` / `spawn`, `classic.Stop` avec `block`, `$.ui.ask` | 0 token pour exécuter ; 1 à 4 min de machine par flow ; 0,05 à 0,4 $ par reprise si rouge | 4 à 5 j | Faible à moyen : durées, Windows, erreurs préexistantes | **Retenue, lot 1** |
| 2 | **Contrat d'acceptation, vérificateur indépendant, tests gelés** (auteur des tests ≠ réparateur, triche détectée) | Vérifie le comportement, pas seulement la compilation. Indispensable là où il n'y a presque pas de tests (back-office 6, lumos-front 5, lumos-serverless 1, serverless-vel-api 0) | ExecCritic [lu, préprint] : +4 / −3,9 points ; ImpossibleBench [sec.] : agents qui modifient les tests ; Anthropic : « Claude est un mauvais QA sans calibrage » [lu] | Haute : `$.agent.register` avec `disallowedTools`, refus `deny` dans `tool.call` | 0,5 à 1,3 $ par flow quand l'orchestrateur les met au plan | 3 à 4 j | Moyen : vérificateur indulgent, test faux gelé | **Retenue, lot 2** |
| 3 | **Preuve à l'exécution web** : l'app tourne, console et réseau propres, capture | Attrape ce qu'aucun test ne voit sur Nuxt (rendu, erreurs console, 4xx/5xx) | Anthropic : tests par navigateur « significativement » meilleurs, sans chiffre [lu] ; aucune mesure indépendante | Moyenne : outils `claude-in-chrome` via `$.mcp.call` ou l'agent ; serveur de dev à lancer ; connexion | 0,2 à 0,6 $ et 1 à 3 min par flow | 2 à 3 j | Moyen à haut : apps derrière connexion, ports, extension absente | **Retenue, lot 3, si le lot 1 le justifie** |
| 4 | **Preuve à l'exécution mobile** : émulateur Android, Dart MCP, flows Maestro | Zéro test d'intégration aujourd'hui sur les deux apps Flutter | Aucune mesure ; outils récents [sec.] | Basse à moyenne : aucun émulateur dans l'API ; Dart MCP par `mcpServers` ; iOS impossible sous Windows | 0,3 à 0,8 $ et 2 à 5 min (démarrage) | 1 j d'essai, puis 3 à 4 j | Haut | **Différée : essai d'un jour d'abord** |
| 5 | Revue adverse avant MR (relecteur en contexte neuf) | Moyen ; F1 de 51 à 61 % selon les outils | Martian [sec.] ; chiffres d'éditeurs ; aucun gain de temps mesuré | Haute | 0,3 à 1 $ par revue | ½ j | Faible | **Écartée comme feature** : `review-agent`, `puydufou-pipelines:revue-de-mr` et `/code-review` existent déjà sur le poste. Le lot 2 se contente de les proposer à l'orchestrateur |
| 6 | Parallélisme isolé par worktree | Faible tant qu'un flow a 2 à 4 agents ; le conflit de chemin existe déjà (register.tsx:412-425) | Cursor [lu] : verrous et intégrateur deviennent le goulot | Moyenne : `isolation` seulement via l'outil `Agent` ou `$.agent.register`, pas `$.agent.spawn` | 1 à 3 min et 0,5 à 1 Go de `node_modules` par worktree Nuxt ; `pub get` en Flutter | 4 à 6 j | Haut : fusion, `.env`, `CLAUDE.md` non chargé dans le worktree | **Écartée pour la v2** |
| 7 | Mémoire validée par citation | Faible au-delà de la v1.5 | ETH Zurich [lu] : fichiers de contexte sans gain de réussite, +20 % de coût ; Copilot [lu] : +7 points de fusion | Haute | 0 | 2 j | Faible | **Écartée** : le cache v1.5 a déjà hash, dérive et pièges. Sa part utile (commandes, pièges d'environnement) entre dans la piste 1 |
| 8 | Reprise d'un flow après redémarrage de Claude Code | Fiabilité ; l'état vit dans `$.state`, perdu au redémarrage | Constat du mod | Haute : `$.store` | 0 | 1,5 à 2 j | Faible | **À faire à part**, hors v2 : utile, pas une grosse feature |
| 9 | Routage modèle et effort (stratégie « conseiller ») | Inconnu sur du code agentique | Anthropic [lu] : +2,7 points, −11,9 % de coût, API bêta hors Claude Code | Basse | — | — | — | **Écartée** : revo-flow choisit déjà modèle et effort par agent |

**Pourquoi la porte (1) passe avant le vérificateur (2), contrairement au classement de la veille.** La veille met en
tête un agent vérificateur. Nous le gardons, mais en lot 2 : une commande lancée par le plugin ne coûte aucun token,
ne peut pas se déclarer verte à tort et sert tous les projets dès le premier jour. Le vérificateur ajoute le jugement
(critères, comportement) ; il coûte 0,2 à 0,5 $ par flow et son intérêt dépend de critères bien écrits. Le lot 1 se
livre seul et rapporte seul.

## Ce que vous gagneriez sur vos projets

« Filet » : ce que la porte du lot 1 peut attraper sans aucun test écrit en plus.

| Projet | Famille | Ce que la porte lance (lot 1) | Filet | Ce que les lots 2 à 4 ajoutent |
|---|---|---|---|---|
| reservation-tool | Nuxt 3.9, Vitest, codegen GraphQL | `eslint` sur les fichiers modifiés, `codegen` si un `.graphql` change, `nuxi typecheck`, `vitest related` | Fort (39 tests, typecheck) | Critères vérifiés ; parcours de réservation dans Chrome (lot 3) |
| lumos-front | Nuxt 3.14, Vitest, vue-tsc | `eslint`, `vue-tsc`, `vitest related` | Moyen : typecheck oui, 5 tests | Le testeur écrit les tests des critères (lot 2) : c'est là que le gain est le plus net |
| back-office | Nuxt 2.15, Jest 27 | `eslint`, `jest --findRelatedTests` | Faible : 6 tests, pas de typecheck | Tests de critères (lot 2) et preuve dans Chrome (lot 3) : le projet qui en a le plus besoin |
| ui-vel | Nuxt 2, Jest, Playwright | `eslint`, `jest --findRelatedTests` | Moyen : 93 tests | Les 4 specs Playwright, aujourd'hui sans `webServer` ni `baseURL` (lot 3) |
| catering, graphql, order, ticketing | NestJS 9/10, Jest 29 | `eslint`, `tsc --noEmit`, `jest --findRelatedTests` | Moyen (11 à 32 tests, typage fort) | `test:e2e` n'a pas de dossier : le testeur peut l'amorcer |
| application-mobile-api | Architect, Vitest séquentiel, Biome | `biome check`, `vitest related` hors tests qui demandent le sandbox | Fort (91 tests) | Tests du sandbox à la demande |
| reservations-api | Architect, Vitest | `tsc --noEmit` si `tsconfig`, `vitest related` | Fort (156 tests), aucun lint | — |
| serverless-vel-api | Serverless, Mocha | `eslint` | Très faible : 0 test, job commenté en CI | Tests de caractérisation par le testeur (lot 2) |
| application-mobile-ui | Flutter 3.44.6 (.fvm), Riverpod, monorepo `packages/*` | `dart analyze` sur les fichiers modifiés, `build_runner` si une annotation générée change, `flutter test --dart-define-from-file=env.test` sur les tests liés, dans le bon paquet | Fort (351 tests) | Captures et arbre de widgets (lot 4) ; avertit que le poste a Flutter 3.44.4, pas 3.44.6 |
| router_app | Flutter, Riverpod, Supabase | `dart format --set-exit-if-changed`, `flutter analyze`, `flutter test` liés | Fort (146 tests) | Tests SQL et Deno seulement si `supabase/` change |

Concrètement, pour vous :

- **Un flow « terminé » veut dire « vert »** sur ce que la CI GitLab va relancer (lint, typecheck, tests). Moins
  d'allers-retours avec la CI et le quality gate Sonar, moins de nouveaux flows pour réparer le précédent.
- **Les erreurs déjà présentes ne vous bloquent pas** : la porte compare à une base de référence prise pendant la
  planification et ne retient que les erreurs nouvelles.
- **Sur les projets presque sans tests** (back-office, lumos-front, serverless-vel-api), le lot 2 fait écrire les tests
  des critères par un agent qui ne touche pas au code. Ces tests restent dans le dépôt si vous le décidez : la
  couverture monte au fil des flows.
- **Sur Flutter**, la porte tourne sans émulateur. Elle sait qu'il faut `env.test`, le bon paquet du monorepo et
  `build_runner` : ce sont les pièges qui font échouer un agent aujourd'hui.

## Gains et coûts, en chiffres

Hypothèses (**estimations**, à remplacer par la mesure du lot 1a) :

- H1. Part des flows qui finissent avec au moins une erreur nouvelle de lint, de typecheck ou de test : 20 à 40 %.
  Aucune mesure aujourd'hui.
- H2. Une erreur qui s'échappe coûte 10 à 30 min d'attention (CI, Sonar, reprise du contexte, nouveau flow) et 1 à 3 $
  de tokens pour relire le contexte.
- H3. La porte ajoute 1 à 4 min de machine par flow (2,5 min en moyenne).

| Pour 10 flows | Sans porte | Avec porte (lot 1) |
|---|---|---|
| Flows qui s'échappent rouges | 2 à 4 | ≈ 0 (sauf plafond atteint, signalé) |
| Temps humain perdu | 20 à 120 min | 0 à 10 min |
| Temps machine ajouté | 0 | 10 à 40 min |
| Tokens | 2 à 12 $ de reprises en nouveaux flows | 0,5 à 2 $ de reprises dans le flow, contexte déjà chaud |

Seuil de rentabilité : 2,5 min de machine par flow contre 20 min par erreur échappée, soit **dès 12 % de flows
rouges**. Coûts par flow et par lot : [conception.md §12](conception.md#12-coûts-estimés-par-flow). Pour mémoire, les
deux flows réels du journal ont coûté 9,47 $ et 1,22 $ (5,34 $ en moyenne).

## Architecture retenue

- **Le plugin outille, l'orchestrateur décide.** revo-flow détecte, propose, exécute, rapporte et garde la porte.
  Il ne corrige jamais le code, ne relance jamais un agent de lui-même et ne choisit pas la stratégie de correction.
- **Commandes apprises par projet**, rangées dans le graphe du cache (`projet.verif`), proposées une fois et confirmées
  par `$.ui.ask`, redemandées si `package.json`, `pubspec.yaml` ou la CI changent.
- **Portée ciblée par le graphe** : fichiers modifiés du flow (déjà suivis), tests liés par `vitest related`,
  `jest --findRelatedTests` ou les arêtes `teste` du graphe (graph.ts:922-926) pour Dart.
- **Base de référence** prise pendant la planification, qui ne modifie rien : seules les erreurs nouvelles comptent.
- **Porte de fin** sur `classic.Stop` : rouge, elle renvoie à l'orchestrateur les erreurs nouvelles (≤ 4k tokens) et
  le tour continue ; plafond de 3 tentatives, puis `$.ui.ask` à l'utilisateur.
- **Nouvel outil `mcp__revo-flow__verif`** : l'orchestrateur et les agents lancent eux-mêmes la porte sur leurs
  fichiers, lisent le résultat, demandent une exception (toujours confirmée par l'utilisateur).
- **Lot 2** : critères d'acceptation dans le plan ; agent `revo-flow:verifier` en lecture seule ; tests du testeur
  gelés par hash, `Edit` refusé aux autres, modifications par Bash détectées ; motifs de triche signalés.
- **Affichage** : section « Vérification » du panneau, segment de bande, notification de fin « vérifié ✓ » ou « non
  vérifié ✗ », colonne dans l'historique.
- **Mesure** : le journal des flows v1.5 du graphe gagne un champ `verif` ; le lot 1a tourne d'abord en observateur.

## Lots

| Lot | Contenu | Effort | Livrable seul |
|---|---|---|---|
| 1a | Détection et confirmation des commandes, exécution ciblée, sortie analysée, base de référence, **mode observateur** (on mesure, on ne bloque pas), journal, panneau | 2,5 à 3 j | Oui : donne H1 et H3 réels |
| 1b | Porte bloquante sur `classic.Stop`, plafond, outil `verif`, consigne aux agents, notification et historique | 1,5 à 2 j | Oui |
| 2 | Critères dans le plan, agent `revo-flow:verifier`, testeur et tests gelés, détection de triche | 3 à 4 j | Oui, sur le lot 1 |
| 3 | Preuve à l'exécution web : serveur de dev, `claude-in-chrome`, captures dans le panneau ; Playwright d'ui-vel | 2 à 3 j | Oui, si l'extension est connectée |
| 4 | Mobile à l'exécution : essai d'un jour (émulateur Android, Dart MCP, Maestro), puis décision | 1 j, puis 3 à 4 j | Après l'essai |

Total : 6 à 7 j pour les lots 1 et 2, 10 à 15 j pour tout. Détail des tâches : [conception.md §13](conception.md#13-lots).

## Décisions à prendre

1. **Mode par défaut après le lot 1a** : la porte *bloque* la fin (proposé) ou *signale* seulement ? Dans les deux cas
   le panneau et la notification disent « vérifié » ou « non vérifié ».
2. **Base de référence** : acceptez-vous que revo-flow lance lint, typecheck et tests en arrière-plan pendant la
   planification (CPU occupé 1 à 5 min, aucun fichier modifié) ?
3. **Build** : `nuxt build` et `nest build` prennent 1 à 5 min. Hors porte par défaut, sur demande seulement ?
4. **Vérificateur et testeur (lot 2)** : à la décision de l'orchestrateur à chaque plan (proposé), ou systématiques
   au-delà d'une taille de flow ? Coût : 0,5 à 1,3 $ par flow.
5. **Tests écrits par le testeur** : gardés dans le dépôt (la couverture monte) ou jetables ?
6. **Web (lot 3)** : back-office et reservation-tool sont derrière une connexion. Faut-il un compte de test local, et
   où le ranger (variable d'environnement, jamais dans le graphe) ?
7. **Mobile (lot 4)** : un émulateur Android est-il disponible sur le poste ? Flutter web est-il acceptable comme cible
   de capture pour application-mobile-ui ? Faut-il installer fvm (3.44.6 attendue, 3.44.4 installée) ?
8. **CI** : lire le résultat du pipeline GitLab après un push (`$.http.fetch` et un jeton) est faisable ; dans le
   périmètre de la v2 ou non ?

## Sources

- Claude Code, bonnes pratiques (moyen de vérifier, hook Stop, sous-agent vérificateur) [lu] : https://code.claude.com/docs/en/best-practices
- Anthropic, harness planner / generator / evaluator, contrats de sprint [lu] : https://www.anthropic.com/engineering/harness-design-long-running-apps
- Anthropic, harness pour agents longs (coûts du QA, tests par navigateur) [lu] : https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- ExecCritic, arXiv 2609.09133 (tests gelés écrits par un autre modèle) [lu, préprint]
- SWE-HERO, SWE-Gym, SWE-RM (Best-of-K avec vérificateur) [sec.] : https://arxiv.org/pdf/2604.01496
- ImpossibleBench, EvilGenie (triche des agents) [sec.] : https://www.alphaxiv.org/abs/2511.21654.md
- METR 2025 et 2026 (gain de productivité incertain) [lu] : https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/ et https://metr.org/blog/2026-02-24-uplift-update/
- CodeRabbit, code IA contre code humain [éditeur] : https://www.coderabbit.ai/blog/state-of-ai-vs-human-code-generation-report
- Chrome DevTools MCP [lu] : https://developer.chrome.com/blog/chrome-devtools-mcp
- Maestro et agents de code [lu] : https://maestro.dev/blog/mobile-ui-testing-with-coding-agents
- Dart MCP server [sec.] : https://dart.googlesource.com/ai/+/HEAD/pkgs/dart_mcp_server ; mobile-mcp [sec.] : https://github.com/mobile-next/mobile-mcp
- Claude Code, worktrees [lu] : https://code.claude.com/docs/en/worktrees.md ; Cursor, agents à l'échelle [lu] : https://cursor.com/blog/scaling-agents
- Anthropic, système multi-agent [lu] : https://www.anthropic.com/engineering/multi-agent-research-system ; stratégie « conseiller » [lu] : https://claude.com/blog/the-advisor-strategy
- ETH Zurich, fichiers de contexte, arXiv 2602.11988 [lu] : https://arxiv.org/abs/2602.11988 ; Copilot, mémoire agentique [lu] : https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/
- Revue automatique, comparatifs [sec.] : https://www.morphllm.com/comparisons/coderabbit-vs-greptile
- API plugin : `.claude-plugin/types/claude-code/index.d.ts`, `claude-code-tools/index.d.ts`, `claude-code-mcp/index.d.ts` (Claude Code 2.1.303) ; lignes citées dans [conception.md §5](conception.md#5-primitives-de-lapi-plugin).
