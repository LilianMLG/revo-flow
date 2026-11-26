# R&D v4 : ce qui serait vraiment utile aux gens

> Étude du 2026-11-04, sur la v3.1.0 (commit f3d4bd7). Aucun fichier de code n'a été modifié.
> Entrées : le README, [rd-v3](../rd-v3/), [rd-v2](../rd-v2/) (et [conception.md §5](../rd-v2/conception.md#5-primitives-de-lapi-plugin)),
> [rd-graphe-cache/ameliorations.md](../rd-graphe-cache/ameliorations.md) et [api-plugin.md](../rd-graphe-cache/api-plugin.md),
> l'historique git (22 commits du 2026-10-12 au 2026-11-04), `gh repo view` (dépôt public, 0 étoile, 0 fork, 0 issue),
> le poste (`~/.claude/revo-flow/` : 1 graphe, 1 flow au journal, 1 plan, 1 rapport ; les 25 flows de la R&D v3 sont sur
> l'autre poste et n'ont pas été relus), la référence officielle des mods (code.claude.com, v2.1.290 à 2.1.299 ; aucun
> typings sur ce poste), une relecture ciblée de `hooks/register.tsx` (5 068 lignes), `hooks/verif/garde.ts` et
> `hooks/verif/detect.ts`, et une veille web du 2026-11-04 (sources en fin, [lu] = source primaire lue, [sec.] = de
> seconde main ; chaque gain est une **estimation**, jamais une mesure).
>
> Question posée : « une R&D sur le futur de ce que pourrait avoir le mod, qui serait vraiment utile pour les gens »,
> pour la diapo « La suite » de la présentation publique.

## Verdict

**Les gens ne demandent pas plus d'orchestration : ils demandent à pouvoir faire confiance à ce qu'un agent a fait sans
tout relire, à ne pas être surpris par la facture, et à ne pas se faire piéger (secrets, commandes destructives).**
L'orchestration elle-même se banalise : Claude Code a ses agent teams (expérimentales) et une vue des sessions de fond
(`claude agents`) ; le cœur de revo-flow, c'est la porte, le vérificateur, la preuve et le rapport. Ce cœur reste
aujourd'hui **sur le poste de l'auteur, dans un fichier markdown**, alors que le goulot documenté par toutes les sources
est **la relecture par un autre humain** : une PR d'agent attend 17,6 h avant d'être prise contre 3,4 h pour une PR
manuelle, et 32,7 % des PR IA sont fusionnées sous 30 jours contre 84,4 % (LinearB 2026, 8,1 M de PR [lu]).

D'où trois lots :

- **v4.0, « confiance »** (≈ 5 à 7 jours) : le **dossier de preuve** du flow joint à la MR (intention, périmètre, ce qui a
  été exécuté, ce qui n'a pas pu l'être, refus et exceptions, captures), un **budget par flow** avec arrêt propre, et des
  **garde-fous** sur les secrets et les commandes dangereuses pour tous les sous-agents. Tout est à portée de l'API.
- **v4.1, « partout »** (≈ 3 à 4 jours) : la porte pour **Python** (puis Go et Rust à la demande) et pour les dépôts de
  mods eux-mêmes, et un **mode sans surveillance** qui tient la porte, le budget et les garde-fous quand personne ne
  répond.
- **v4.2, « équipe »**, sur déclencheur (un second poste, un premier utilisateur anglophone) : fiches et commandes de
  vérification partagées dans le dépôt, lecture de la CI après push, panneau en anglais.

Ce que l'étude ne montre pas : **aucun utilisateur de revo-flow n'a encore rien demandé** (0 étoile, 0 issue). Tous les
problèmes ci-dessous sont ceux des utilisateurs d'agents de code en général ; la mesure (§4) doit dire si ce sont ceux des
utilisateurs du mod.

## 1. Constats

### 1.1 Qui utiliserait le mod, et pourquoi

| Profil | Ce qu'il a aujourd'hui avec un agent | Ce que revo-flow lui donne déjà | Ce qui lui manque |
|---|---|---|---|
| **Dev solo** (Pro ou Max, projets TS, Vue, Flutter) | Un agent qui dit « terminé, tests verts » ; une facture ou un quota qu'il découvre après | Porte, vérificateur, preuve web et mobile, coût affiché, historique | Un plafond avant, pas un coût après ; une MR prête à montrer |
| **Dev en équipe** (MR relues par un collègue, CI GitLab ou GitHub) | Des MR d'agent plus grosses, relues plus tard, fusionnées moins souvent | Le rapport « peut servir de description de MR » (README), mais reste sur disque | Le dossier de preuve **dans** la MR ; le partage des commandes et des pièges entre postes |
| **Mainteneur open source** | Un flot de PR générées, « 1 sur 10 légitime » [lu] | Rien côté mainteneur | Un contributeur dont la PR dit ce qui a été vérifié et ce qui ne l'a pas été |
| **Agence, prestataire** (plusieurs projets, plusieurs stacks) | Un coût par client à justifier, des stacks Python ou Go à côté du TS | Rapport avec coût, cache par projet | Budget par flow ; porte hors TS et Dart |
| **Débutant, non-dev** (« vibe coding ») | Ne sait pas ce que l'agent a fait, ni ce qui a été testé, ni quand ça s'est arrêté [sec.] | `doctor`, panneau, notification | Un résumé en langage courant : changé, vérifié, non vérifié, reste à faire |

### 1.2 Ce que disent les gens (sources)

| # | Constat | Preuve | Conséquence pour revo-flow |
|---|---|---|---|
| C1 | **On ne fait pas confiance au code d'agent, et on ne le vérifie pas pour autant** | Sonar, janv. 2026, 1 100 devs [lu] : 96 % ne font pas pleinement confiance au code IA, 48 % le vérifient toujours, 38 % trouvent sa relecture plus coûteuse que celle d'un humain ; 64 % utilisent déjà des agents autonomes. Stack Overflow 2026 [lu] : 48 % font confiance « quand c'est facile à vérifier », 16 % au-delà | La porte et le vérificateur répondent au bon problème. Ce qui manque, c'est de rendre la vérification **visible à celui qui relit**, pas seulement à celui qui lance |
| C2 | **Le goulot est la file de relecture, pas l'écriture** | LinearB 2026, 8,1 M de PR, 4 813 équipes [lu] : prise en charge P75 17,6 h (agent) contre 8,3 h (assisté) et 3,4 h (manuel) ; fusion sous 30 j 32,7 % contre 84,4 % ; PR médiane 89 lignes contre 26 (corrélations). Faros 2025 [sec.] : +98 % de PR, +91 % de temps de revue | Un flow qui finit « vérifié ✓ » sur le poste n'a aucune valeur pour le relecteur s'il ne le voit pas |
| C3 | **Les relecteurs veulent un dossier, pas un diff** | Builder.io, mai 2026 [lu] : intention en clair, diff minimal, résultats de tests, preuve navigateur, journaux console et réseau, **liste de ce qui n'a pas été testé**. S. Khare, juil. 2026 [lu] : six questions (intention, contexte lu, trace des commandes, **autorisations** accordées ou refusées, vérification, responsabilité). r/ClaudeAI, mai 2026 [lu] : « implementation complete, tests passing », puis fichiers hors sujet refactorés et conventions contournées ; les résumés auto-déclarés ne valent rien | Le rapport de flow a déjà quatre des six réponses ; il lui manque le périmètre déclaré, la trace des commandes, les refus, et « ce qui n'a pas été testé » en tête |
| C4 | **Les PR d'agent passent les tests et ne sont pas fusionnables pour autant** | METR, mars 2026 [lu] : 296 PR qui passent SWE-bench, 4 mainteneurs, 3 dépôts ; ≈ la moitié ne seraient pas fusionnées (écart 24,2 points). Watanabe et al., 567 PR Claude Code [lu] : 83,8 % acceptées, 45,1 % après retouches, surtout « standards propres au projet » | Les critères et le vérificateur comptent ; les conventions du projet (pièges, fiches) aussi, d'où leur partage en équipe |
| C5 | **Plus de la moitié des PR d'agent sont fusionnées sans relecteur** | amplifying.ai, nov. 2026, 268 PR [lu] : 56 % sans second relecteur ; Claude Code relu dans 30,5 % des cas, tests touchés dans 47,5 % | Deux publics : ceux qui relisent (le dossier les aide) et ceux qui fusionnent seuls (la porte est leur seule relecture) |
| C6 | **Le coût d'un agent est imprévisible, et le plafond natif ne couvre pas la session interactive** | Référence CLI Claude Code [lu] : `--max-budget-usd` « print mode only », estimation côté client, sous-agents comptés. Unblocked, juin 2026 [lu] : jusqu'à 30 × de variance en tokens sur la même tâche (préprint [sec.]) ; agents ≈ 4 ×, multi-agents ≈ 15 × une conversation (Anthropic [lu, R&D v2]). Plugin `claude-session-cost` [lu] : plafond par session, estimé, 0 étoile | Un plafond **par flow**, en session interactive, n'existe nulle part ; revo-flow calcule déjà le coût par agent |
| C7 | **Les agents lisent des secrets et exécutent ce qu'on leur glisse** | « Comment and Control », avr. 2026 [sec.] : un titre de PR fait publier `ANTHROPIC_API_KEY` par l'action Claude Code Security Review (CVSS 9,4). Endor Labs, sept. 2026 [lu] : la parade est une **politique à l'exécution** (refus de lire `.env` et clés, refus des commandes destructives), pas un meilleur prompt ; arXiv 2509.22040 [sec.] : jusqu'à 84 % de succès en auto-approbation. Référence mods [lu] : le garde `sec-default@builtin` ne se charge qu'avec des réglages gérés ou un compte Team/Enterprise | Un dev solo sur Pro ou Max n'a que les règles de permission ; revo-flow lance jusqu'à 6 sous-agents sous les permissions de l'orchestrateur et peut leur appliquer une politique uniforme par `tool.call` |
| C8 | **Les mainteneurs open source sont submergés** | Godot, févr. 2026 [lu] : PR IA « draining and demoralizing » ; GitHub étudie la limitation des PR [lu] ; « 1 PR IA sur 10 légitime » [lu] | Un contributeur qui joint ce qui a été exécuté se distingue du flot ; c'est la pub la plus honnête du mod |
| C9 | **Les gens rebâtissent la porte de revo-flow à la main** | `isitdone`, sept. 2026 [lu] : hook Stop qui lance tests, typage et lint, 3 tentatives, cherche les tests affaiblis dans le diff, pour Cursor, Claude Code, Codex, Gemini CLI ; 1 like, 0 réponse. B. Watson, oct. 2026 [lu] : 1 345 tours audités, 31 finissent sur un check rouge, **1 seul** vrai faux « terminé », avec des consignes de vérification strictes | La porte est validée comme besoin ; mais ce n'est plus un différenciateur à lui seul, et un agent bien consigné triche peu : la valeur est dans la preuve montrée, pas dans le soupçon |
| C10 | **TypeScript et Python dominent** | Octoverse 2025 [sec.] : TypeScript 1er (2,64 M de contributeurs mensuels), Python 2e, JavaScript 3e. Stack Overflow 2026 [lu] : Claude Code chez 66 % des utilisateurs d'agents | La porte ne connaît ni pytest, ni ruff, ni Go, ni Rust, ni `claude plugin test` (`detect.ts`, aucune occurrence) : la moitié du public probable n'a pas de porte |

### 1.3 Ce que le mod a déjà, et le paysage

| Domaine | État (v3.1.0) | Ce que le paysage fait ou ne fait pas |
|---|---|---|
| Orchestration | 1 à 6 agents, modèle et effort, attentes, reprise, panneau, catalogue d'agents | Claude Code : agent teams expérimentales (désactivées par défaut, pas sous `-p`, pas de permission par équipier au lancement, tmux pour les panneaux) [lu] ; `claude agents` pour les sessions de fond [lu]. `claude-orchestration` (222 étoiles) : workflows, `@schedule`, `@review`, ni coût ni PR [lu]. Ruflo (ex claude-flow, ≈ 31 k étoiles) [sec.] : API seulement |
| Vérification | Porte exécutée par le mod, erreurs nouvelles seulement, critères, testeur, tests gelés, vérificateur lecture seule, triche, CRAP | `isitdone` refait la porte sans base de référence ni critères [lu]. Aucun orchestrateur ouvert ne joint une preuve d'exécution |
| Preuve | Web (Chrome, console, réseau, captures) et mobile (téléphone, émulateur, arbre, gestes) | Builder.io décrit exactement ce livrable comme « ce que les relecteurs veulent » [lu] ; personne ne le met dans la MR |
| Rapport | Markdown sur disque (plan, fichiers, porte, critères, CRAP, coût) ; « peut servir de description de MR » | Les six questions de Khare [lu] : quatre couvertes, deux absentes (trace et autorisations), le périmètre et « non testé » enfouis |
| Coût | Coût par agent en direct, historique par modèle, tokens évités | Plafond natif en `-p` seulement [lu] |
| Sécurité | Bash du vérificateur filtré (`verifierBashAllowed`), tests gelés, conflits de fichiers | Politique à l'exécution recommandée [lu] ; garde natif réservé aux comptes gérés [lu] |
| Tests | 473 cas (`claude plugin test .`), Windows et macOS simulés | — |

### 1.4 Les données du poste

Un seul graphe (`revo-flow-d91766.json`), un seul flow au journal : le flow « v3.0 : preuve à l'exécution web » du
2026-10-31, 6 agents, 28 tâches, **33 min 50, 16,90 €, 41,9 M de tokens**. Deux constats à prendre dans le lot 1 :

- **La porte n'a pas tourné sur le dépôt du mod lui-même** : `verif.etat: off`, `projet.verif` vide, et les 8 critères
  sont « non vérifiable » avec la même raison (« aucune commande confirmée »). Le vérificateur a coûté sans rien prouver.
  `detect.ts` ne connaît pas `claude plugin test` (C10).
- **Le rapport compte des fichiers hors dépôt** : des `scratchpad/*.txt` et des chemins préfixés par le worktree
  apparaissent dans « Fichiers modifiés ». Un relecteur n'en veut pas ; à filtrer sous la racine du dépôt.

## 2. Pistes

Gains : **estimations**. Effort en jours de développement. Faisabilité jugée sur [api-plugin.md](../rd-graphe-cache/api-plugin.md),
[conception.md §5](../rd-v2/conception.md#5-primitives-de-lapi-plugin) et la référence des mods en ligne [lu] ;
« à vérifier » = primitive lue dans la référence, pas dans les typings de ce poste.

| # | Piste | Problème (source) | Faisabilité API plugin | Effort | Risque | Gain attendu | Verdict |
|---|---|---|---|---|---|---|---|
| P1 | **Dossier de preuve dans la MR** | C2, C3, C5, C8 | Haute : `rapport.ts`, `tool.call` (commandes Bash déjà lues pour `bashReadFile`), `$.process.run` de `gh` ou `glab`, `$.ui.ask` | 2 à 3 j | Faible : sans `gh` ni `glab`, le dossier reste un fichier | Délai de première relecture plus court, moins d'allers-retours ; non mesurable avant 20 MR | **Retenue, lot 1** |
| P2 | **Résumé en clair** en tête du dossier et de la notification | C1, profil débutant | Haute : `$.model.complete` Haiku (≈ 0,01 €) ou gabarit sans modèle | ½ j | Faible | Un non-expert sait quoi relire ; un expert gagne 30 s par flow | **Retenue, dans P1** |
| P3 | **Budget par flow et arrêt propre** | C6 | Haute : coût par agent (`lib.ts`), `$.session.usage().cost` [lu, à vérifier], `$.ui.ask`, `TaskStop` par `$.tool.call`, `$.turn.abort` | 1 à 1,5 j | Faible : estimation ≠ facture, à dire comme le fait Claude Code | Plus de flow à 3 × l'estimation sans décision ; le chiffre « plafond » est aussi un argument de vente | **Retenue, lot 1** |
| P4 | **Garde-fous : secrets et commandes dangereuses**, trace des refus | C7 | Haute : `tool.call` avec `deny` et `e.agentId` (déjà utilisé pour le gel et les conflits), `verifierBashAllowed` comme modèle | 1,5 à 2 j | Moyen : faux refus qui bloquent un agent ; d'où `avertir` par défaut | Un flow ne peut plus lire `.env` ni `git push --force` même sur injection ; refus visibles dans le dossier | **Retenue, lot 1** |
| P5 | **Porte Python, dépôts de mods, puis Go et Rust** | C10, §1.4 | Haute : `$.process.run` ; `detect.ts` a le patron ; stack déjà lue dans `pyproject.toml`, `go.mod`, `Cargo.toml` | Python 2 j, plugin ½ j, Go 1 j, Rust 1 j | Moyen : tests liés moins nets qu'avec `vitest related` ; couverture à lire (coverage.py JSON, `-coverprofile`) | La porte pour la moitié du public probable ; le mod se vérifie lui-même | **Retenue, lot 2** (Python et plugin ; Go, Rust sur demande) |
| P6 | **Mode sans surveillance** | Profil solo et agence ; `claude-orchestration` a `@schedule` [lu] | Haute : la branche `claude -p` existe (choix par défaut) ; `--max-budget-usd` et `--max-turns` natifs [lu] | 1 j après P1, P3, P4 | Moyen : du code écrit sans personne ; MR brouillon seulement | Des flows de nuit qui finissent vérifiés, bornés, avec dossier | **Retenue, lot 2** |
| P7 | **Partage d'équipe** : fiches et commandes de vérification dans le dépôt | C4, Sonar : 4 outils IA par équipe, 35 % de comptes perso [lu] ; piste (h) différée dans ameliorations.md | Haute : `$.fs.write` sous la racine, import au chargement, hash recalculés | 1 à 1,5 j | Faible : résumés non relus commités ; export sur commande seulement | Le premier flow d'un collègue ne redemande pas les commandes ; conventions et pièges partagés | **Retenue, lot 3**, sur déclencheur (second poste) |
| P8 | **Lecture de la CI après push** | C2 ; décision 8 de la R&D v2 (hors v2) | Haute : `gh pr checks`, `glab ci status` par `$.process.run` (10 min, d'où un sondage `$.clock.every`) ; `$.http.fetch` existe (4 MiB, 30 s) [lu] | 1 j | Moyen : jeton et durée de CI | Boucle fermée avec l'équipe ; mais la porte lance déjà ce que la CI relance | **Différée** : mesurer d'abord combien de MR issues de flows échouent en CI (P1 donne l'id) |
| P9 | **Panneau et prompts en anglais** (A5 de la R&D v3) | Public anglophone majoritaire (inférence, C10) | Haute | 2 à 3 j | Moyen : tous les tests sur les textes | Confort ; aucun anglophone n'a encore rien demandé | **Différée**, déclencheur : premier utilisateur anglophone (issue, étoile avec message) |
| P10 | **Hot reload pendant la preuve mobile** (diapo actuelle) | Aucune source utilisateur | Moyenne : `flutter run --pid-file` + `SIGUSR1`, absent sous Windows ; `r` sur le stdin du spawn, à vérifier | 1 j | Moyen : deux chemins par OS | Quelques secondes par relance de preuve | **Différée** : pas de demande, auteur sous Windows |
| P11 | **Gestes et arbre des vues sur iOS** (diapo actuelle) | Aucune source utilisateur | Basse : `xcrun simctl` n'a ni toucher ni arbre ; il faut idb, WebDriverAgent ou mobile-mcp, et macOS | 2 à 3 j, non testable ici | Haut | Niche | **Écartée comme développement propre** : l'option `mobile: mcp` le couvre déjà |
| P12 | **Suivre les agent teams natives** | Paysage (§1.3) | Moyenne : `agent.spawn` reçoit `e.isTeammate`, `$.agent.list()` liste les équipiers [lu, à vérifier] | 1 à 2 j | Haut : expérimental, pas sous `-p`, plus de tokens | Un jour, le panneau et la porte sur une équipe native | **Différée** jusqu'à sortie d'expérimentation |
| P13 | Relecteur adverse avant MR | — | — | — | — | — | **Écartée** (R&D v2 : `/code-review` et agents installés existent) |
| P14 | Worktree par agent | Doc agent teams : « deux équipiers sur le même fichier s'écrasent » [lu] | — | — | — | — | **Écartée** (R&D v2) : l'option `conflits` suffit à 2 à 6 agents |
| P15 | Tableau de bord multi-sessions | — | — | — | — | — | **Écartée** : `claude agents` le fait nativement [lu] |

### 2.1 (P1) Le dossier de preuve dans la MR

Le rapport actuel devient un **dossier** qui répond, dans cet ordre, aux six questions d'un relecteur (Khare [lu],
Builder.io [lu]) ; ce qui existe est noté, ce qui manque est en gras :

| Question | Contenu | Source dans le mod |
|---|---|---|
| 1. Intention et périmètre | Demande, plan, critères C1 à C8 ; **fichiers du plan contre fichiers touchés** (hors plan = signalés) ; **hors périmètre déclaré par l'orchestrateur** | `plan`, `journalize`, fichiers modifiés par agent (existe) ; champ `horsPerimetre` du plan (nouveau) |
| 2. Contexte | Fiche servie et sa fraîcheur, fichiers lus par agent | `noteRead`, journal `lus` (existe, pas dans le rapport) |
| 3. Trace | **Commandes Bash lancées par agent** (sans leur sortie), relances, attentes, tentatives de porte | `tool.call` lit déjà `input.command` ; attentes et tentatives existent |
| 4. Autorisations | **Refus** (gel, conflits, garde-fous P4), exceptions et dégels accordés par l'utilisateur, plan validé par qui | `exception`, `degeler` (existe) ; refus à journaliser (nouveau) |
| 5. Vérification | Porte (commandes, erreurs nouvelles, préexistantes, instables), critères avec preuve, preuve web ou mobile et captures, CRAP ; **en tête : « non vérifié », « non vérifiable » et tests exclus** | Existe, à remonter |
| 6. Responsabilité | Modèles, efforts, durée, coût, **plafond** (P3), version du mod | Existe en partie |

- **Publication** : après la porte, « Ouvrir une MR brouillon avec le dossier ? » (`$.ui.ask`). Oui : `gh pr create --draft
  --body-file` ou `glab mr create --draft --description-file` par `$.process.run`, sur la branche courante, gestionnaire
  choisi d'après `$.session.repo().remote`. revo-flow **ne commit ni ne pousse pas** : l'orchestrateur le fait par ses
  outils comme aujourd'hui, ou l'utilisateur. Sans `gh` ni `glab`, ou sans push : le dossier reste dans
  `~/.claude/revo-flow/rapports/` et le panneau le dit.
- **Captures** : liens locaux dans le dossier (GitHub n'a pas d'API de téléversement d'image pour une PR ; GitLab a
  `projects/:id/uploads`, faisable par `$.http.fetch` avec un jeton que l'utilisateur met dans l'environnement, jamais
  stocké : lot 3).
- **Résumé en clair (P2)** en tête : trois phrases, « ce qui a changé, ce qui a été vérifié, ce qui ne l'a pas été »,
  écrites par Haiku depuis le dossier (≈ 1k tokens) ou par gabarit si le modèle échoue. C'est la ligne que lit un
  non-expert, et le message LinkedIn qui s'écrit tout seul.
- **Correctifs** : fichiers hors racine filtrés (§1.4) ; l'id de la MR ouverte entre au journal (§4).

À quoi ressemble la tête du dossier (le reste est le rapport actuel, réordonné) :

```
## En clair
Le code promo expiré affiche maintenant une erreur sous le champ (3 fichiers, 2 tests ajoutés).
Vérifié : lint, typage, 14 tests liés verts, C1 à C3 vus dans Chrome (2 captures).
Non vérifié : C4 (envoi du mail) demande le sandbox, exclu de la porte ; aucun test sur Cart.ts.

## Périmètre
Plan : components/promo/*, stores/booking/Cart.ts, tests/promo/*.
Hors plan, touché quand même : locales/fr.json (agent promo-ui, tâche 4).
Refus pendant le flow : 1 (lecture de .env.local par promo-api, avertie).
Plafond : 1,80 € · réel 1,12 €.
```

### 2.2 (P3) Budget par flow

- **À la validation du plan** : une estimation (coût moyen d'un agent par modèle dans l'historique, sinon tarifs de
  `lib.ts` sur un nombre de tokens typique) et un **plafond** proposé, 2 × l'estimation, modifiable dans le dialogue ;
  option `budget` (`/config`) : plafond par défaut en euros, `0` pour aucun.
- **Pendant** : à 80 %, toast et segment de bande (`budget 82 %`) ; à 100 %, dialogue « Arrêter », « +50 % » ou « Laisser
  finir ». Arrêter = ce que fait **Tout arrêter** aujourd'hui (TaskStop, `$.turn.abort`), flow journalisé « arrêté
  (budget) », dossier écrit quand même. Sous `claude -p` : arrêt sans question.
- **Relances** : un agent relancé plus de 3 fois passe par la même question (c'est la boucle qui coûte, Unblocked [lu]).
- **Honnêteté** : le coût est une estimation côté client, comme `--max-budget-usd` ; le dossier le dit, et le journal
  garde estimé, plafond et réel pour calibrer (§4).
- **Dans le dialogue de validation du plan**, une ligne de plus : « 4 agents · estimation ≈ 0,90 € (historique : 11
  flows) · plafond 1,80 € » ; la bande pendant le flow : `revo-flow · promo · 62 % · 3 actifs · 0,41 € / 1,80 €`.

### 2.3 (P4) Garde-fous

Une politique appliquée dans `tool.call`, à l'orchestrateur et à chaque sous-agent pendant un flow, sans dépendre du
mode de permission (le hook passe avant) :

| Famille | Exemples refusés | Primitive |
|---|---|---|
| Secrets | `Read`, `cat`, `sed -n` sur `.env*`, `*.pem`, `*.key`, `id_rsa*`, `~/.aws/credentials`, `~/.claude/*.json` | `tool.call` sur Read et Bash (`bashReadFile` donne déjà le fichier lu) |
| Destructif | `rm -rf` hors du dépôt, `git push --force`, `git reset --hard`, `git clean -fdx`, `DROP TABLE`, `curl … \| sh` | `tool.call` sur Bash, règles comme `verifierBashAllowed` |
| Hors dépôt | `Edit` et `Write` hors de la racine (scratchpad excepté) | `tool.call` sur Edit, Write, NotebookEdit (déjà filtrés pour le gel) |

- **Modes** : `avertir` (défaut : toast, ligne dans le dossier, l'action passe) et `refuser` (comme l'option `conflits`) ;
  `refuser` est forcé en mode sans surveillance (P6).
- **Ce que ça ne fait pas** : détecter une injection. Un hook ne lit pas l'intention ; il rend l'injection inoffensive
  en fermant ce qu'elle viserait (lecture de secrets, destruction, exfiltration par une commande réseau non confirmée).
  Les permissions de Claude Code et son mode auto restent la première ligne ; revo-flow ajoute l'uniformité sur les
  sous-agents et la trace dans le dossier.
- **Preuve** : un test par famille, un test « agent en `avertir` passe, en `refuser` reçoit le motif ».

### 2.4 (P5) La porte pour Python, les mods, puis Go et Rust

| Stack | Lint | Typage | Tests liés | Couverture (CRAP) |
|---|---|---|---|---|
| Python (`pyproject.toml`, `requirements.txt`) | `ruff check` si configuré | `mypy` ou `pyright` si configuré | `pytest` sur `tests/test_<module>.py` et sur les tests qui importent le module (grep d'import, comme `importedNames`) ; `pytest-testmon` s'il est là | `pytest --cov --cov-report=json` (coverage.py), nouveau lecteur à côté d'istanbul et lcov |
| Mod Claude Code (`.claude-plugin/plugin.json` + `hooks/`) | — | — | `claude plugin test <fichiers>` sur le miroir `tests/` | aucune |
| Go (`go.mod`) | `golangci-lint run` si présent, sinon `go vet` | inclus | `go test ./<paquet>/...` des fichiers modifiés | `-coverprofile` |
| Rust (`Cargo.toml`) | `cargo clippy` | inclus | `cargo test -p <crate>` | `cargo llvm-cov` s'il est installé, sinon pas de CRAP |

Base de référence, erreurs nouvelles, dialogue de confirmation, `doctor` : inchangés, c'est le même `detectCommands`.
Python et mods d'abord (2,5 j) ; Go et Rust quand un utilisateur les demande (1 j chacun).

### 2.5 (P6) Sans surveillance

Une option `surveillance` (`oui` par défaut, `non`) et la même branche que `claude -p` : plan lancé seul, fiche utilisée,
preuves web et mobile jamais lancées (déjà le cas). Ce qui change : la porte reste en `bloquer` et finit « non vérifié »
après 3 tentatives sans dialogue ; garde-fous en `refuser` ; budget : arrêt sans question ; fin : dossier, MR brouillon
si `gh` ou `glab` et si l'option le dit, notification. Lancement depuis le planificateur de l'OS :
`claude -p "/revo-flow <demande>" --max-budget-usd 10`, ou `claude --bg`. Rien n'est poussé sur `main` : ce n'est pas le
rôle du mod.

## 3. Feuille de route

| Lot | Version | Contenu | Effort | Livrable seul |
|---|---|---|---|---|
| 1 | v4.0 « confiance » | P1 dossier dans la MR, P2 résumé en clair, correctif fichiers hors dépôt, P3 budget, P4 garde-fous | 5 à 7 j | Oui ; c'est la matière de la pub (« la MR qui prouve ce qu'elle dit ») |
| 2 | v4.1 « partout » | P5 Python et mods, P6 sans surveillance | 3 à 4 j | Oui ; Go et Rust à la demande |
| 3 | v4.2 « équipe », sur déclencheur | P7 partage dans le dépôt, P8 CI après push, P9 anglais | 3 à 5 j | Oui, piste par piste |

Ordre dans le lot 1 : P3 budget (le plus court, visible dès le premier flow), P4 garde-fous (avant que des inconnus
lancent des flows), P1 dossier (le plus long, et celui qui se montre).

**Diapo « La suite »**, trois lignes grand public, à la place de « Gestes et vues sur iOS / Hot reload pendant la
preuve / Panneau en anglais » (les trois sont différées ou écartées, §2) :

1. **Dossier de preuve dans la MR**
2. **Budget par flow, arrêt propre**
3. **Garde-fous : secrets, commandes dangereuses**

Variantes si l'auteur préfère annoncer le lot 2 : « Python vérifié comme TypeScript », « Flows de nuit, sans
surveillance ». Ne pas annoncer plus de trois choses : la R&D v3 a montré que la diapo prend du retard sur le mod.

## 4. Ce qu'il faut mesurer

Le journal du graphe (`JournalEntry`, 200 derniers flows) a déjà `verif` (état, tentatives, erreurs nouvelles,
critères, CRAP, `web`, `mobile`). Les champs à ajouter, et le seuil au-delà duquel la piste a prouvé sa valeur :

| Piste | Champ du journal | Ça vaut le coup si | Flows nécessaires |
|---|---|---|---|
| P1 dossier | `mr: { ouverte, id, delaiPremiereRevueH?, fusionnee? }` (délai relu par `gh pr view --json reviews` au flow suivant ou par `/revo-flow mr`) | ≥ 30 % des flows finissent en MR avec dossier, et leur délai de première revue est sous celui des MR du même dépôt sans dossier | 20 MR |
| P2 résumé | `relu: boolean` (bouton **rapport.md** ou **MR** pressé) | Le dossier est ouvert dans plus de la moitié des flows | 20 |
| P3 budget | `budget: { estime, plafond, reel, atteint }` | ≥ 10 % des flows atteignent le plafond, ou l'erreur médiane d'estimation dépasse 30 % (sinon l'estimation seule suffit) | 30 |
| P4 garde-fous | `garde: { avertis, refus: { secrets, destructif, horsDepot } }` | Au moins un refus sur 50 flows qui aurait coûté quelque chose ; sinon rester en `avertir` et ne pas en faire un argument | 50 |
| P5 stacks | `stack` par flow (existe dans `projet.stack`, pas dans le journal) | Dès qu'un flow sur un projet Python existe sur un autre poste que celui de l'auteur | 1 |
| P6 nuit | `surveillance: false`, décisions par défaut prises, état final | Part de flows « vérifié ✓ » sans surveillance ≥ celle des flows surveillés, à budget égal | 20 |
| P7 équipe | `importe: boolean`, second poste sur la même clé de projet | Un second poste qui importe sans redemander les commandes | 1 équipe |

Comme pour le cache (ameliorations.md §3.2), la comparaison honnête est **dans le même dépôt** : MR avec dossier contre
MR sans dossier des mêmes auteurs, et non revo-flow contre le reste du monde ; les écarts de taille de MR (LinearB :
89 lignes contre 26 en médiane) suffisent à expliquer une différence de délai si on ne les contrôle pas.

Et pour la pub, les chiffres déjà mesurables (§ « Mesure » du README) : taux d'échappement, flows rouges au premier
passage, erreurs nouvelles attrapées, flows où la preuve web ou mobile trouve ce que la porte n'a pas vu. Sur ce poste
ils sont vides (un flow, porte `off`) : **les premiers vrais chiffres viendront des premiers utilisateurs**, pas de
l'auteur.

## 5. Écarté ou différé

| Piste | Verdict | Pourquoi |
|---|---|---|
| Embeddings, symboles, liens Front ↔ Back (ameliorations.md) | Différé, inchangé | Toujours aucune demande ; le journal n'a pas les chiffres attendus |
| Export Markdown des fiches (h) | **Jugement révisé** : retenue en lot 3 | Différée en v1.5 « en attendant (j) » ; (j) existe depuis, mais la vraie condition est un second poste, pas un chiffre |
| Lancement silencieux du cache (e) | Écarté, inchangé | Décision de l'auteur maintenue |
| Worktree par agent, relecteur adverse | Écartés, inchangés | R&D v2 |
| Mode « simple » | Écarté, inchangé | `doctor` et P2 (résumé en clair) répondent au besoin |
| Hot reload, gestes iOS | Différé, écarté | §2, P10 et P11 : aucune demande, non testables sous Windows |
| Panneau en anglais | Différé | Déclencheur : premier anglophone ; le README anglais suffit à la première vague |
| CI après push | Différée | Mesurer d'abord (§4, P1) |
| Agent teams natives | Différée | Expérimental ; `agent.spawn` et `$.agent.list()` permettront de les suivre quand elles sortiront d'expérimentation |
| Playwright existants dans la porte | Différé | 10 min par commande ; à revoir avec P8 |
| Découper `register.tsx` (5 068 lignes, +1 300 depuis la R&D v3) | Dette, pas une feature | P1 et P3 touchent la fin de flow : sortir le dossier, le budget et les garde-fous en modules, comme `verif/` |

## 6. Limites de l'étude

- **Zéro utilisateur externe.** Toutes les demandes viennent de sources générales sur les agents de code ; aucune ne
  parle de revo-flow. Le §4 est là pour ça.
- **Un seul flow au journal sur ce poste**, porte `off` : les constats du §1.4 tiennent sur un flow. Les 25 flows de la
  R&D v3 sont sur l'autre poste et n'ont pas été relus.
- **Pas de typings ici** : la faisabilité repose sur `api-plugin.md`, `conception.md §5` et la référence des mods en
  ligne (v2.1.290 à 2.1.299). Non vérifiés en vrai : `$.session.usage().cost`, `e.isTeammate`, le stdin de
  `$.process.spawn`, `tool.check`.
- **Veille** : recherche limitée aux résultats US ; deux sources non lisibles (agentsroom.dev, un fil Reddit d'avril
  2026 sur les fondateurs non techniques), remplacées par des résumés de seconde main ; Octoverse, « Comment and
  Control » et Faros de seconde main ; LinearB, Sonar et amplifying.ai sont des chiffres d'éditeurs, corrélationnels.
- **Aucune mesure n'existe** du gain d'un dossier de preuve sur le délai de relecture : c'est l'hypothèse centrale du
  lot 1, et le seuil du §4 la testera.

## Sources

- Sonar, « verification gap », 2026-01-08 [lu] : https://www.sonarsource.com/company/press-releases/sonar-data-reveals-critical-verification-gap-in-ai-coding/
- Stack Overflow Developer Survey 2026, section IA [lu] : https://survey.stackoverflow.co/2026/ai
- LinearB, benchmarks 2026 (8,1 M de PR) [lu] : https://linearb.io/library/engineering-benchmarks-and-research
- amplifying.ai, State of coding agents, nov. 2026 [lu] : https://edge.amplifying.ai/research/state-of-coding-agents
- METR, « Many SWE-bench-passing PRs would not be merged », 2026-03-10 [lu] : https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/ ; mise à jour productivité 2026-02-24 [lu] : https://metr.org/blog/2026-02-24-uplift-update/
- Watanabe et al., PR agentiques sur GitHub, arXiv 2509.14745 [lu, résumé] : https://arxiv.org/abs/2509.14745
- A. Moore (Builder.io), « I didn't become a developer to review AI slop », 2026-05-21 [lu] : https://builder.io/blog/developers-drowning-in-ai-prs
- S. Khare, « The review queue is the bottleneck », 2026-07-29 [lu] : https://siddhantkhare.com/writing/the-review-queue-is-the-bottleneck
- r/ClaudeAI, « implementation complete, tests passing », mai 2026 [lu, instantané] : https://reddit.sentinel-team.org/posts/1td1z4c/snapshots/2026-05-16T01%3A22%3A27.604243Z
- Unblocked, « The auto-loop tax », 2026-06-10 [lu] : https://getunblocked.com/blog/agent-auto-loop-token-cost
- Claude Code, référence CLI (`--max-budget-usd`, `--max-turns`, `claude agents`) [lu] : https://code.claude.com/docs/en/cli-reference ; agent teams [lu] : https://code.claude.com/docs/en/agent-teams ; référence des mods [lu] : https://code.claude.com/docs/en/plugins/mods/reference
- `claude-session-cost` [lu] : https://gitee.com/ProjectOpenSea/claude-session-cost ; `claude-orchestration` [lu] : https://github.com/mbruhler/claude-orchestration
- Endor Labs, prompt injection contre les agents de code, 2026-09-02 [lu] : https://www.endorlabs.com/learn/prompt-injection-against-coding-agents-the-attack-surface-nobody-owns
- « Comment and Control » (titre de PR, Claude Code Security Review) [sec.] : https://thenextweb.com/news/ai-agents-hijacked-prompt-injection-bug-bounties-no-cve
- Open Source For You, GitHub et les PR IA, 2026-02-04 [lu] : https://www.opensourceforu.com/2026/02/github-weighs-pull-request-kill-switch-as-ai-slop-floods-open-source/ ; The Register, Godot, 2026-02-18 [lu] : https://www.theregister.com/2026/02/18/godot_maintainers_struggle_with_draining/
- `isitdone`, forum Cursor, 2026-09-09 [lu] : https://forum.cursor.com/t/isitdone-a-stop-hook-that-runs-your-real-tests-before-the-agent-can-end-its-turn-done/171166
- B. Watson, audit des « tests verts » annoncés, 2026-10-17 [lu] : https://brycewatson.com/blog/agent-test-claims-after-failed-runs/
- Octoverse 2025 [sec.] : https://visualstudiomagazine.com/articles/2025/10/31/typescript-tops-github-octoverse-as-ai-era-reshapes-language-choices.aspx
- Non-développeurs et agents [sec.] : https://agentsroom.dev/blog/vibe-coding-without-drowning (non lisible le 2026-11-04) ; boucles coûteuses [sec.] : https://dev.to/devtoolpicks/ai-agents-are-burning-through-bills-overnight-how-to-stop-a-runaway-claude-code-session-201g
- Paysage des orchestrateurs [sec.] : https://claudefa.st/blog/tools/orchestrators/multi-agent-orchestrators
