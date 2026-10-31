# R&D v3 : prêt pour les autres, puis la preuve à l'exécution

> Étude du 2026-10-31, sur la v2.2.0 (commit 31fb79a). Aucun fichier de code n'a été modifié.
> Entrées : le README, [rd-graphe-cache](../rd-graphe-cache/) et [rd-v2](../rd-v2/), l'historique git (16 commits
> du 2026-10-12 au 2026-10-31), le dépôt GitHub (`gh repo view`), les graphes et plans du poste
> (`~/.claude/revo-flow/`), le diapo « revo-flow » commencé le 2026-10-27, et une relecture ciblée de
> `hooks/register.tsx`, `hooks/verif/detect.ts` et `hooks/verif/runner.ts`.
>
> Question posée : « quelle prochaine version serait vraiment intéressante, et le mod est-il assez complet pour
> avoir des utilisateurs, en vue d'une pub sur LinkedIn ? »

> Lot B livré en v3.0 le 2026-10-31 : voir §3

## Verdict

**Le mod est fonctionnellement prêt. Ce qui lui manque pour avoir des utilisateurs n'est pas une feature, c'est tout
ce qui entoure le produit.** D'où deux lots, dans cet ordre :

- **v2.3, « prêt pour les autres »** (lot A, ≈ 5 jours) : dépôt public et licence, README bilingue, preuve visuelle,
  une commande `doctor` qui explique au premier utilisateur ce que le mod va faire sur son projet, la reprise d'un
  flow après redémarrage de Claude Code, et un rapport de flow en markdown. Puis la pub.
- **v3, « preuve à l'exécution web »** (lot B, ≈ 3 jours, après la première vague d'utilisateurs) : le vérificateur
  voit l'application tourner (console, réseau, capture). C'est le lot 3 de la R&D v2, resté non commencé.

Pourquoi cet ordre : un post LinkedIn qui renvoie vers un dépôt sans licence, sans visuel et sans parcours de
première utilisation coûte la première impression, et on ne la refait pas. Le lot B est la feature la plus
démonstrative, mais la plus fragile (ports, connexion, extension absente) : elle vaut mieux une fois qu'on sait sur
quels projets tournent les premiers utilisateurs.

## 1. Constats

### 1.1 Ce que le mod a déjà

| Domaine | État (v2.2.0) |
|---|---|
| Orchestration | Plan validé, 1 à 6 agents, modèle et effort par agent, attentes entre agents, reprise par `SendMessage`, éclaireur avant le plan |
| Suivi | Panneau, barre par agent, ligne d'état, coût, contexte, inactivité, notifications, historique |
| Cache projet | Graphe par hash git, fiches apprises, brief au lancement, extraits par agent, dérive de confiance, mesure par journal |
| Flow vérifié | Détection des commandes (CI, scripts), base de référence, porte en fin de flow, erreurs nouvelles seulement, 3 tentatives |
| Qualité | Critères C1 à C8, testeur, tests gelés, vérificateur en lecture seule, score CRAP (règle du scout) |
| Écosystème | Agents installés (projet, personnel, plugins) proposés au plan |
| Tests | 325 cas (`claude plugin test .`), deux machines simulées (Windows, macOS) |

C'est plus que la plupart des plugins Claude Code publiés. Le code fait 13 300 lignes ; `hooks/register.tsx` en
porte 3 700 à lui seul (voir §4, dette).

### 1.2 Ce qui bloque un premier utilisateur

| # | Constat | Preuve | Effet |
|---|---|---|---|
| B1 | **Dépôt privé** | `gh repo view LilianMLG/revo-flow` : `isPrivate: true`, 0 étoile, 0 fork, 0 issue | `/plugin install revo-flow --marketplace LilianMLG/revo-flow` échoue pour quiconque n'est pas l'auteur. *Décision du 2026-10-31 : l'auteur passe le dépôt en public lui-même.* |
| B2 | **Pas de licence** | Aucun `LICENSE` à la racine ; `licenseInfo: null` | Même public, personne ne sait s'il a le droit de l'utiliser ou de contribuer |
| B3 | **Tout en français** | README (211 lignes), options de `plugin.json`, messages du panneau, prompts injectés | L'audience Claude Code est très majoritairement anglophone. Le README est la porte d'entrée ; les messages peuvent attendre |
| B4 | **Aucune preuve visuelle** | Pas de capture ni de GIF dans le dépôt ; le diapo du 2026-10-27 a une vidéo ×10 mais n'est pas lié depuis le README | Un lecteur ne voit pas le panneau, les barres, la porte : il doit croire sur parole |
| B5 | **Trop de concepts d'un coup** | 7 options, 10 commandes, fiches, brouillons, zone grise, porte, base de référence, CRAP, gel, vérificateur | Un nouvel utilisateur ne sait pas ce qui va se passer à son premier `/revo-flow`, ni pourquoi un flow finit rouge |
| B6 | **Un flow meurt avec Claude Code** | `flowA = atom(…, null)` (register.tsx:165) : l'état du flow vit en mémoire ; seuls `day:`, `week:` et `migrated` passent par `$.store` (444-488) | Fermer la fenêtre pendant un flow de 10 min perd le suivi, les attentes, les tests gelés. C'est la piste 8 de la R&D v2, notée « à faire à part » |

### 1.3 Ce que disent les données du poste

| Donnée | Valeur |
|---|---|
| Flows au journal | 25 (router-app 18, router-console 4, revo-flow 3) |
| Fiches apprises | 36 (27, 6, 3) |
| Plans écrits | 31 (`~/.claude/revo-flow/plans/`) |
| Sorties de la porte gardées | 10 dossiers depuis le 2026-10-25 |
| Utilisateurs | 1 |

Il y a donc de la matière pour une pub honnête (vrais flows, vrais coûts, mesure des tokens évités), et aucune
donnée sur un autre poste que celui de l'auteur : le lot A doit aussi rendre le premier flow d'un inconnu
supportable sans l'auteur à côté.

## 2. Lot A : v2.3, « prêt pour les autres »

Gains : **estimations**. Effort en jours de développement.

| # | Piste | Gain attendu | Faisabilité API plugin | Effort | Risque | Verdict |
|---|---|---|---|---|---|---|
| A1 | Dépôt public, licence, README bilingue, preuve visuelle | Condition de toute adoption | Aucune API | 1 j | Nul | **Retenue** |
| A2 | `/revo-flow doctor` | Le premier flow ne surprend plus ; les flows rouges « sans comprendre » disparaissent | Haute : tout existe dans `hooks/verif/detect.ts` et `hooks/agents/catalogue.ts` | 1 j | Faible | **Retenue** |
| A3 | Reprise d'un flow après redémarrage | Fiabilité : plus de flow perdu | Haute : `$.store` | 1,5 à 2 j | Faible à moyen | **Retenue** |
| A4 | Rapport de flow en markdown | Utile au quotidien (description de MR) ; c'est ce que les gens partageront | Haute : `$.fs.write`, comme `plan.md` | 1 j | Faible | **Retenue** |
| A5 | Messages du panneau et prompts en anglais | Confort | Haute | 2 à 3 j | Moyen : tous les tests sur les textes | **Différée** : le README suffit pour la première vague ; à faire si des anglophones arrivent |
| A6 | `/revo-flow version` | Trivial | Haute | ¼ j | Nul | Retenue, dans A2 |

### 2.1 (A1) Dépôt, licence, README, visuel

- **Licence** : MIT, le standard des plugins Claude Code. Un fichier `LICENSE` à la racine, le champ `license` dans
  `.claude-plugin/plugin.json`.
- **README** : garder le français (`README.fr.md`) et écrire un `README.md` en anglais, plus court, avec dans cet
  ordre : une phrase, le GIF, l'installation, « votre premier flow » (ce qui s'affiche, ce qu'on clique, ce que fait
  la porte), puis un lien vers la doc complète. Le README actuel devient la doc complète.
- **Preuve visuelle** : un GIF de 20 à 30 secondes du panneau pendant un flow réel, à la racine (`docs/demo.gif`), et
  la vidéo ×10 déjà faite pour le diapo. Un mod de terminal se vend par son panneau, pas par son texte.
- **Diapo** : il annonce « v2.0 » et, en dernière diapo, « Bientôt : choix automatique de l'agent » ; c'est fait depuis
  la v2.2. À mettre à jour avant toute diffusion (§5).

### 2.2 (A2) `/revo-flow doctor`

Une commande en lecture seule qui lance la détection sur le projet courant et explique, en clair, ce que le mod a
trouvé et ce qu'il fera :

```
revo-flow doctor · reservation-tool
Stack        Nuxt 3 + Vitest (package.json, nuxt.config.ts)
Lint         npx eslint {fichiers}            CI .gitlab-ci.yml
Typage       npx nuxi typecheck               projet entier, ≈ 40 s la dernière fois
Tests        npx vitest related {fichiers}    couverture : @vitest/coverage-v8 présent
CRAP         actif (seuil 30)
Base         commit a1b2c3d, 0 erreur préexistante (lint), 2 (typage)
Cache        graphe de 212 fichiers, 9 fiches, 14 flows au journal
Agents       5 installés (savvy-flow ×5), proposés au plan
Pièges       .fvm demande Flutter 3.44.6, le poste a 3.44.4
```

- **Faisabilité** : `detectCommands` (detect.ts:337), `commandLabel` (552), `needsConfirm` (543), `durationOf`
  (runner.ts:48), `baseFor` (base.ts:60), le catalogue (`catalogue.ts`) et `computeStats` du graphe existent. Il
  manque la commande (`register.tsx:3041-3067`, à côté de `statut`, `stop`, `panneau`) et une vue dans le panneau.
- **Sans projet reconnu** : le dire, et dire ce que la porte fera (rien), plutôt que laisser le premier flow finir
  « non vérifié » sans explication.
- **`/revo-flow version`** : la même commande affiche la version de `plugin.json` ; c'est le prompt de test du diapo.

### 2.3 (A3) Reprise d'un flow après redémarrage

- **Aujourd'hui** : `flowA`, `leadA`, `isBusy`, `tokens` sont des atoms en mémoire (register.tsx:165-168). Au
  redémarrage, le mod repart à zéro ; les agents, eux, sont morts avec la session.
- **Cible** : à chaque changement du flow (plan, step, fin d'agent, porte), écrire un instantané dans `$.store`
  (`flow:<id>`) ; au chargement du mod, s'il existe un instantané non terminé, proposer **Reprendre** (relancer les
  agents dont les tâches restent, avec les tâches faites cochées, comme le fait déjà la relance après attente) ou
  **Abandonner** (journaliser comme arrêté). Les tests gelés et la base de référence sont déjà sur disque
  (`~/.claude/revo-flow/verif/`), seul l'état du flow manque.
- **Ce qu'on ne reprend pas** : le contexte de l'orchestrateur (c'est la session Claude Code) ni celui des agents.
  Reprendre, c'est relancer les agents sur leurs tâches restantes, pas restaurer leur mémoire.
- **Risque** : un instantané qui ment (agent marqué actif alors que mort). Règle : au chargement, tout agent non
  terminé est « à relancer », jamais « actif ».
- **Preuve** : un test qui sérialise un flow à mi-course, recharge, et vérifie les tâches restantes par agent.

### 2.4 (A4) Rapport de flow

En fin de flow, à côté du plan (`~/.claude/revo-flow/rapports/<titre>.md`, et proposé en copie dans le presse-papier
ou ouvert comme `plan.md`) :

1. La demande et le plan (agents, modèles, efforts, tâches faites).
2. Les fichiers modifiés, par agent.
3. Le verdict de la porte : commandes lancées, durée, erreurs nouvelles, exceptions accordées.
4. Les critères et le verdict du vérificateur, avec la preuve de chacun.
5. Le score CRAP des fonctions modifiées.
6. Durée, coût, tokens évités par le cache.

Tout est déjà dans `journalize` (register.tsx:597) et dans le rapport de la porte (`hooks/verif/report.ts`) : c'est
une mise en forme, pas une collecte. Le rapport sert de description de MR, et c'est le document qu'un utilisateur
content partagera : une pub qui se fait toute seule.

### 2.5 Ordre et calendrier

| Ordre | Piste | Pourquoi maintenant | Effort |
|---|---|---|---|
| 1 | A3 reprise | Le bug qu'un nouvel utilisateur rencontre la première semaine | 1,5 à 2 j |
| 2 | A2 doctor (+ version) | L'onboarding ; démontrable dans le diapo | 1 j |
| 3 | A4 rapport | Utile et partageable | 1 j |
| 4 | A1 dépôt, licence, README, GIF, diapo | En dernier, avec les fonctions 1 à 3 dedans | 1 j |
| 5 | Pub LinkedIn | | |

Environ 5 jours. La pub part quand les quatre sont livrés et que `claude plugin install` fonctionne depuis un poste
vierge (à tester sur une machine qui n'a jamais vu le dépôt : c'est le seul test de A1 qui compte).

## 3. Lot B : v3, « preuve à l'exécution web »

Reprise du lot 3 de la R&D v2 ([execution.md](../rd-v2/execution.md) §2), inchangé sur le fond. Rappel :

- **Ce qu'on attrape** : page blanche, erreur d'hydratation, erreur console, appel réseau en 4xx ou 5xx, composant
  absent, texte de traduction manquant. Rien de tout cela n'est vu par lint, typage ni tests unitaires.
- **Flux** : un critère observable au plan ; le vérificateur reçoit le droit d'exécution web ; revo-flow demande
  « Démarrer `npm run dev` ? », lance le serveur (`$.process.spawn`), attend l'URL ; le vérificateur navigue avec
  `claude-in-chrome` (`navigate`, `computer`, `read_console_messages`, `read_network_requests`) ; il rend par critère
  ok, ko ou non vérifiable avec les faits et la capture ; revo-flow arrête le serveur et range la capture.
- **Coût** : 0,2 à 0,6 $ et 1 à 3 min par flow qui le demande. Effort 2 à 3 jours.

Ce que cette étude ajoute :

| Point | Décision proposée |
|---|---|
| Quand lancer le lot | Après la première vague d'utilisateurs, quand on sait quels projets ils ont (Nuxt ? Next ? autre) et si l'extension Chrome est répandue chez eux |
| Repli sans extension | Chrome DevTools MCP déclaré dans `mcpServers` du plugin, plutôt que Playwright : console et réseau sans spec à écrire |
| Compte de test (question 6 de la R&D v2) | Jamais stocké par le mod. Une variable d'environnement nommée dans `doctor` (« preuve web : connexion requise, `REVO_WEB_LOGIN` absent ») |
| Capture | Texte base64 dans `~/.claude/revo-flow/verif/<flow>/`, affichée dans le terminal par `Image` ; jointe au rapport de flow (A4) comme lien |
| Mesure | Comme pour la porte : compter d'abord les flows où la preuve web trouve ce que la porte n'a pas vu. Si c'est rare, le lot s'arrête là |

### Décisions à la livraison (v3.0)

- **Option `web`** (`extension` par défaut, `devtools`, `off`) plutôt qu'un `mcpServers` au niveau du plugin : le serveur MCP Chrome DevTools ne part que pour le vérificateur, et seulement si l'utilisateur le choisit.
- **Action `web` de l'outil `verif`**, réservée au vérificateur et à l'orchestrateur : détection du serveur de dev, dialogue, démarrage, URL.
- **Port déjà pris** : revo-flow propose le serveur existant (« Utiliser http://localhost:3000 ? ») et ne tue rien ; un serveur qu'il n'a pas démarré n'est jamais arrêté.
- **Outils navigateur refusés** hors preuve web et hors de l'origine accordée.
- **Captures** : texte base64 (`capture-n.png.txt`) dans le dossier des sorties du flow, décodage en PNG au mieux (`certutil` ou `base64`), lien dans le rapport de flow.
- **`REVO_WEB_LOGIN`** : seule sa présence est signalée (doctor, consigne du vérificateur) ; le mod ne lit ni ne stocke aucun identifiant.
- **Journal `web`** (état, captures, verdicts web, ko web) pour la mesure : combien de flows où la preuve web trouve ce que la porte n'a pas vu.

Pourquoi c'est la bonne feature pour une v3 : c'est la plus démonstrative (une capture dans un rapport, c'est un
post à soi tout seul), aucun orchestrateur open source ne la fait proprement, et elle réutilise le vérificateur et
les critères du lot 2 sans rien changer au reste.

## 4. Écarté ou différé

| Piste | Verdict | Pourquoi |
|---|---|---|
| Embeddings, symboles, liens Front ↔ Back, export d'équipe | Différé | Déjà jugés dans [ameliorations.md](../rd-graphe-cache/ameliorations.md) ; aucun utilisateur ne les réclame |
| Worktrees par agent | Écarté | R&D v2, piste 6 : conflits de fusion, `node_modules`, `CLAUDE.md` non chargé |
| Preuve mobile (émulateur) | Différé | R&D v2, piste 4 : essai d'un jour d'abord, après le lot B |
| Mode « simple » qui cache le cache, le CRAP et le gel | Écarté | `doctor` (A2) répond au même besoin sans dédoubler le produit ; les options existent déjà |
| Découper `hooks/register.tsx` (3 700 lignes) | Dette, pas une feature | À faire par morceaux au fil des lots A3 et A4, qui touchent la fin de flow et l'état : sortir au moins l'état (`atoms`), les commandes et la fin de flow dans des modules |
| Messages en anglais (A5) | Différé | Voir §2 |

## 5. Diffusion : diapo, LinkedIn, artefacts

Le diapo « revo-flow » (artefact Slides, 4 diapos : ce qu'il fait, ce qu'il contient, démo vidéo ×10, installation)
est une bonne base. Trois points :

1. **Il est en retard sur le mod** : « v2.0 » en couverture, et la dernière diapo annonce en « Bientôt » le choix de
   l'agent installé, livré en v2.2. À mettre à jour avec A2 et A4 quand ils existent (le `doctor` et le rapport se
   montrent bien).
2. **LinkedIn n'intègre pas une page externe** : pas d'iframe, pas d'artefact embarqué. Trois voies, de la plus
   efficace à la moins :
   - **Document LinkedIn** (le « carrousel ») : exporter le diapo en PDF (Share, Export) et le joindre au post comme
     document. C'est natif, feuilletable dans le fil, et c'est le format que l'algorithme pousse le plus.
   - **Vidéo native** : la vidéo ×10 de la diapo 3, postée directement (pas en lien), est ce qui montre le mieux un
     mod de terminal.
   - **Lien vers l'artefact** : il marche (lien de partage), mais un lien sortant est moins montré, et le lecteur
     doit cliquer. À garder en commentaire du post, avec le lien GitHub.
3. **Le contenu du post** : un chiffre vrai du poste (flows, coût moyen, tokens évités, flows rouges rattrapés par la
   porte) vaut plus que la liste des features. Le rapport de flow (A4) en fournira un par flow.

Le post peut partir le jour où A1 est livré, pas avant (B1 à B4).
