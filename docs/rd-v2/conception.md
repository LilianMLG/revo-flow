# Conception : le flow vérifié

> R&D du 2026-10-19, sur la v1.5.0. Résumé et classement : [README.md](README.md). Preuve à l'exécution (lots 3
> et 4) : [execution.md](execution.md). Les lignes citées sont celles de la v1.5.0 et des typings de Claude Code
> 2.1.303 (`.claude-plugin/types/claude-code/index.d.ts`, noté `cc:` ; `claude-code-tools/index.d.ts`, noté `tools:` ;
> `claude-code-mcp/index.d.ts`, noté `mcp:`).

## 0. En bref

- Un flow ne peut plus finir « terminé » sur une vérification rouge sans que quelqu'un l'ait décidé en le sachant.
- revo-flow **apprend** les commandes de vérification d'un projet, les **fait confirmer** une fois, les **exécute**
  sur la portée du flow, **compare** à une base de référence, **rapporte** les seules erreurs nouvelles et **garde la
  porte** de fin. Il ne corrige rien et ne relance personne : l'orchestrateur décide.
- Lot 2 : le plan porte des **critères d'acceptation** ; un **testeur** les traduit en tests, que revo-flow **gèle** ;
  un **vérificateur** en lecture seule juge chaque critère avec une preuve ; la **triche** est détectée et soumise à
  l'utilisateur.
- Le lot 1a tourne d'abord **en observateur** : il mesure le taux de flows qui finissent rouges sans rien bloquer.

## 1. Principes

1. **Le plugin outille et propose, l'orchestrateur décide.** Même règle que le cache (décision 1 du 2026-10-14).
2. **Une preuve s'exécute, elle ne se déclare pas.** « J'ai lancé les tests, tout passe » dans une réponse d'agent ne
   vaut rien pour la porte ; seul compte ce que revo-flow a exécuté lui-même, ou ce que le vérificateur cite avec la
   sortie de la commande.
3. **Confirmation explicite plutôt que comportement silencieux.** Toute décision qui engage l'utilisateur passe par
   `$.ui.ask` : commandes à exécuter, exception à la porte, test à dégeler, garde-fou modifié, serveur ou émulateur à
   démarrer. Sans personne à qui demander (`claude -p`), la réponse prudente s'applique (§4).
4. **Les erreurs déjà là ne bloquent pas.** Seules les erreurs nouvelles comptent ; les autres sont montrées à part.
5. **Rien de silencieux dans l'écran.** Chaque exécution, chaque refus et chaque relance de la porte apparaît dans le
   panneau et dans la bande.

## 2. Flux de bout en bout

Les étapes en **gras** sont nouvelles ; les autres existent en v1.5.

| # | Phase (lib.ts:225) | Qui | Ce qui se passe |
|---|---|---|---|
| 1 | planning | plugin | `/revo-flow <demande>` : flow, brief, cache (existant) |
| 2 | planning | plugin | **Commandes du projet** : lues dans `graph.projet.verif`. Absentes ou périmées (manifeste changé) : détection (§6), puis `$.ui.ask` « revo-flow a trouvé ces vérifications pour reservation-tool : eslint (fichiers), nuxi typecheck, vitest related. Les utiliser ? » : Utiliser / Ajuster / Pas de vérification |
| 3 | planning | plugin | **Base de référence** en arrière-plan (`$.process.spawn`) : lint et typecheck sur le projet, sauf si la base du même commit est déjà dans le graphe. La planification ne modifie rien (lib.ts:264), la base est donc propre |
| 4 | planning | orchestrateur | Lit, puis appelle `plan`. **Lot 2 : avec `criteres`** (1 à 8 critères vérifiables) et, s'il le juge utile, un agent de type `test` et un `revo-flow:verifier` |
| 5 | dispatch | utilisateur | Valide le plan (existant, register.tsx:2063-2070). La question montre les critères et le coût estimé du testeur et du vérificateur |
| 6 | running | agents | Codent. **La consigne de chaque agent (agentBrief) ajoute : « avant de finir, appelle `verif` action `lancer` sur tes fichiers ; corrige ce qui est nouveau et à toi »** |
| 7 | running | plugin | **Lot 2 : quand le testeur a fini, ses fichiers de test sont gelés** (hash git). Un `Edit` ou `Write` d'un autre agent dessus est refusé |
| 8 | running → review | plugin | Tous les agents ont fini (`toReview`, register.tsx:1473) : **la porte globale démarre aussitôt en arrière-plan**, pendant que l'orchestrateur lit les réponses |
| 9 | review | orchestrateur | Relit, peut lancer le vérificateur (lot 2), conclut |
| 10 | review | plugin | **`classic.Stop` de l'orchestrateur : la porte attend le résultat** (souvent déjà prêt). Vert : le tour finit, puis `finishFlow` (existant). Rouge et tentatives < 3 : `block` avec les erreurs nouvelles, le tour continue |
| 11 | review | orchestrateur | Décide : corrige lui-même, reprend l'agent par SendMessage (contexte gardé), relance un agent, ou demande une exception (`verif` action `exception`, avec motif) |
| 12 | review | plugin | **Exception ou plafond atteint : `$.ui.ask`** « La vérification reste rouge : 2 erreurs nouvelles de typecheck dans `stores/booking/Cart.ts`. Terminer quand même ? » : Terminer non vérifié / Une tentative de plus / Voir le détail |
| 13 | done | plugin | `finishFlow` : notification « terminé · vérifié ✓ » ou « terminé · non vérifié (typecheck ✗) » ; journal (§10) ; pièges appris (§6.5) |

Le même schéma en séquence :

```
utilisateur   orchestrateur          plugin revo-flow                       agents
    | /revo-flow  |                        |                                    |
    |------------>|  brief + cache         | commandes connues ? sinon ask ---->| (utilisateur)
    |             |                        | base de référence (spawn, fond)    |
    |             |-- plan + critères ---->| validation du plan (ask)           |
    |             |-- Agent x N ---------------------------------------------->| codent
    |             |                        |<-- verif lancer (fichiers) --------| portée de l'agent
    |             |                        | gel des tests du testeur           |
    |             |                        | tous finis : porte globale (fond)  |
    |             |-- conclusion, Stop --->| attend la porte                    |
    |             |<-- block : erreurs ----| rouge, tentative 1/3               |
    |             |-- corrige / SendMessage ---------------------------------->|
    |             |-- Stop --------------->| porte verte : laisse finir         |
    |<--------------------------------- notification « vérifié ✓ »            |
```

## 3. Rôles

| Rôle | Fait | Décide | Ne fait pas |
|---|---|---|---|
| **Plugin** | Détecte et propose les commandes ; exécute ; analyse les sorties ; compare à la base ; gèle les tests ; refuse un `Edit` sur un test gelé ; détecte les motifs de triche ; tient la porte ; affiche ; mesure | Rien sur le code. Seulement « vert, rouge, nouveau, préexistant, gelé », par règle fixe | Corriger, relancer un agent, choisir une stratégie, accorder une exception |
| **Orchestrateur** | Écrit les critères ; met ou non un testeur et un vérificateur au plan ; lit le rapport de la porte | Comment réparer, qui répare, quand demander une exception | Modifier un test gelé ; contourner la porte sans l'accord de l'utilisateur |
| **Implémenteurs** (agents du plan) | Codent ; lancent `verif` sur leurs fichiers avant de finir | Corriger leurs erreurs nouvelles | Toucher aux tests gelés |
| **Testeur** (lot 2, tâche de type `test`) | Traduit les critères en tests, à partir de la spec et des interfaces, pas du code écrit | Comment tester | Modifier le code de production (consigne et refus `deny` sur les fichiers non-test) |
| **Vérificateur** `revo-flow:verifier` (lot 2) | Lit le diff et les critères en contexte neuf ; exécute ; juge chaque critère : ok, ko, non vérifiable, avec la preuve | Son verdict par critère | Écrire un fichier (outils retirés, Bash filtré) |
| **Utilisateur** | Répond aux questions | Commandes, exception, dégel, garde-fou modifié, démarrage d'un serveur ou d'un émulateur | — |

Modèles proposés à l'orchestrateur (il garde le choix) : testeur au moins du niveau de l'implémenteur (ExecCritic :
des tests écrits par un meilleur modèle et gelés aident, ceux de l'agent lui-même nuisent) ; vérificateur Sonnet
medium, calibré par des exemples notés dans son prompt (Anthropic : « out of the box, Claude is a poor QA agent »).

## 4. Ce que fait le plugin, ce que décide l'orchestrateur : les questions posées

Toutes passent par `askOr` (register.tsx:444-451), qui distingue « personne à qui demander » et « dialogue fermé ».

| Question | Quand | Options | Sans interface (`-p`) | Dialogue fermé (Échap) |
|---|---|---|---|---|
| Commandes du projet | 1er flow du projet, ou manifeste ou CI changés | Utiliser / Ajuster / Pas de vérification | Utiliser, en mode observateur | Pas de vérification pour ce flow |
| Exception à la porte | L'orchestrateur appelle `verif exception`, ou plafond atteint | Terminer non vérifié / Une tentative de plus / Voir le détail | Terminer non vérifié (marqué) | Une tentative de plus |
| Dégeler un test (lot 2) | L'orchestrateur appelle `verif degeler` avec un motif | Dégeler / Garder gelé | Garder gelé | Garder gelé |
| Garde-fou modifié (lot 2) | Le diff touche la config de lint, de test, de typage ou les scripts | Accepter / Refuser (la porte reste rouge) | Refuser | Refuser |
| Démarrer un serveur ou un émulateur (lots 3, 4) | Le vérificateur en demande un | Démarrer / Pas cette fois | Pas cette fois | Pas cette fois |

Ce qui reste automatique, mais affiché : l'exécution des commandes déjà confirmées, la base de référence (si la
décision 2 du README l'accepte), le refus d'un `Edit` sur un test gelé, le `block` du Stop tant que le plafond n'est pas
atteint. Le `block` n'est pas une décision sur le code : c'est le même type de garde que « pas d'agent avant le plan »
(register.tsx:1970-1975).

## 5. Primitives de l'API plugin

| Besoin | Primitive | Où | Limite ou piège |
|---|---|---|---|
| Lancer une commande et lire sa sortie | `$.process.run(argv, { cwd, env, timeoutMs })` → `{ exitCode, stdout, stderr, isStdoutTruncated }` | cc:3581-3598, 8163-8219 | Sans shell ; 30 s par défaut, **10 min au plus** (cc:3591-3592, 8178-8181) ; 4 MiB par flux (cc:3593-3594) |
| Commande longue, base de référence en fond | `$.process.spawn({ argv, cwd, env })`, lu par `for await`, puis `{ code, signal }` | cc:3600-3636 | Aucune durée maximale déclarée ; tuée quand on quitte la boucle ou quand le module est déchargé (cc:3603-3605) : un rechargement du mod perd la base en cours |
| Attendre une commande dans un hook | Le budget de 10 s d'un hook ne compte que son propre code ; les attentes sur `next` et `$` sont libres | cc:5241-5250, 6913-6914 | À vérifier en vrai sur `classic.Stop` avec une attente de plusieurs minutes (lot 1b, premier test) |
| Refuser la fin du tour de l'orchestrateur | `on('classic.Stop')` qui rend `{ block: raison }` | cc:1263-1271 (nom `classic.Stop`), 1309-1314 (`block` = bloquer, veto ou re-prompt), 1419-1421 (tout événement classique lit `block`) | `stop_hook_active` (cc:12701-12703) dit qu'on est déjà dans une relance : sert au plafond. `background_tasks` (cc:12709) : ne pas bloquer un tour qui attend ses agents |
| Refuser la fin d'un agent (option, lot 1c) | `on('classic.SubagentStop')` avec `block` | cc:12835-12848 ; `agent_id` = id de `$.agent.list()` (cc:585-589) | Copie de travail partagée : filtrer les erreurs aux fichiers de cet agent |
| Un hook qui plante | Ignoré : la garde s'ouvre, sauf `.catch` qui refuse à sa place | cc:4036-4041 | La porte de fin s'ouvre en cas de bug (voulu) ; le gel des tests doit avoir un `.catch` qui refuse (fermé) |
| Refuser un `Edit` sur un test gelé | `on('tool.call')` qui rend `{ deny }` ; `e.agentId` dit quel agent | cc:13340-13349, cc:194-203 | Déjà fait pour les conflits (register.tsx:2138-2141) |
| Questions | `$.ui.ask(question, { options, header })` | cc:2448-2463 | 2 à 4 options ; rejette en `-p` (cc:2454) |
| Prévenir l'orchestrateur hors de son tour | `$.prompt.submit({ text, asUser: true })` | cc:3020 ; usage : register.tsx:1464-1469 | Apparaît comme un message de l'utilisateur, déjà le cas pour les attentes |
| Agent vérificateur en lecture seule | `$.agent.register({ name, prompt, tools, disallowedTools, model, effort, maxTurns, mcpServers })` | cc:467-556 (tools 486, disallowedTools 490, effort 500, mcpServers 512, maxTurns 521) ; usage : register.tsx:739-755 | `$.agent.spawn` ne prend ni effort ni outils (cc:251) : passer par le type enregistré |
| Forcer le type d'un agent du plan | Hook `agent.spawn` : réécrire `subagentType` | cc:286-293 | Le nom doit exister (`revo-flow:verifier`), sinon refus |
| Outil `verif` | `$.tool.register` + `on('tool.call', { tool })` | register.tsx:249-311 (outils existants) | — |
| Affichage d'une capture (lot 3) | Composant `Image` avec `source: { png }` ou `{ file, format }` | cc:3917, 5441-5465 | Terminal seulement ; le bureau n'a pas `Image` |
| Navigateur (lot 3) | `$.mcp.call('claude-in-chrome', …)` ou les outils `mcp__claude-in-chrome__*` du vérificateur | cc:2747-2768 (pas de demande de permission, cc:2752-2753) ; mcp:589 (computer), 691 (navigate), 698 (console), 711 (réseau) | Dépend de l'extension connectée |
| Statut et toasts | `$.ui.status`, `$.ui.toast`, `$.ui.notify` | cc:2510, 2480, 2498 | — |
| Agent en worktree (écarté) | `isolation` sur l'outil `Agent` ou dans `AgentSpec` | tools:23-24, cc:555 | Absent de `$.agent.spawn` (cc:251) |

Rien n'existe pour : lancer un émulateur (seulement `adb` et `emulator` via `$.process`), un `$.git`, un glob récursif
dans `$.fs`. Git passe par `$.process.run`, comme le cache.

## 6. Détection et apprentissage des commandes par stack

### 6.1 Sources, dans l'ordre de confiance

1. **La CI** (`.gitlab-ci.yml`, `.github/workflows/*.yml`, `lefthook.yml`) : ce qu'elle lance est ce qui comptera en
   MR. Lue comme texte ; seules les lignes qui appellent un script connu sont retenues.
2. **Les scripts** de `package.json` (`lint`, `typecheck`, `type-check`, `test`, `test:unit`, `codegen`, `build`) ;
   jamais `lint:fix`, `format` ni rien qui écrit.
3. **Les outils présents** : `biome.json`, config ESLint, `vitest` ou `jest` dans les devDependencies, `tsconfig.json`,
   `pubspec.yaml`, `analysis_options.yaml`, `.fvm/fvm_config.json`, `melos.yaml`, `build.yaml`.
4. **CLAUDE.md** du projet, quand il en a un (application-mobile-ui, application-mobile-api, ui-vel, lumos-front) :
   relu par l'orchestrateur, qui peut ajuster par `verif commandes`.

La famille vient déjà de `detectStack` (graph.ts:272) ; on y ajoute la lecture des scripts.

### 6.2 Commandes par famille

« Fichiers » : la commande ne reçoit que les fichiers du flow ; « liés » : seulement les tests qui importent un
fichier du flow ; « projet » : tout le projet.

| Famille (projets) | Lint | Typage | Tests | Déclencheurs | Hors porte par défaut |
|---|---|---|---|---|---|
| Nuxt 3 + Vitest (reservation-tool, lumos-front) | `npx eslint <fichiers>` | `npx nuxi typecheck` ou `npx vue-tsc --noEmit` (projet) | `npx vitest related <fichiers> --run --reporter=json` | `.graphql` modifié : `npm run codegen` avant le typage | `nuxt build` |
| Nuxt 2 + Jest (back-office, ui-vel) | `npx eslint <fichiers>` | aucun | `npx jest --findRelatedTests <fichiers> --json` | — | `nuxt build`, Playwright (lot 3) |
| NestJS + Jest (catering, graphql, order, ticketing) | `npx eslint <fichiers>` | `npx tsc --noEmit -p tsconfig.json` (projet) | `npx jest --findRelatedTests <fichiers> --json` | — | `nest build`, `test:e2e` |
| Architect + Vitest + Biome (application-mobile-api, lumos-serverless, reservations-api) | `npx biome check <fichiers>` | `npx tsc --noEmit` si `tsconfig.json` | `npx vitest related <fichiers> --run` | tests du sandbox exclus (motif appris, §6.5) | sandbox |
| Serverless + Mocha (serverless-vel-api) | `npx eslint <fichiers>` | aucun | aucun (0 test) | — | — |
| Flutter (application-mobile-ui, router_app) | `dart format --output=none --set-exit-if-changed <fichiers>` si la CI le fait | `dart analyze <fichiers>` (sortie `--format=machine`) | `flutter test <tests liés> --dart-define-from-file=env.test` si le fichier existe | annotation générée (`@riverpod`, `@freezed`, `part '*.g.dart'`) modifiée : `dart run build_runner build --delete-conflicting-outputs` avant l'analyse | suite complète, `integration_test/` |

Tests liés : `vitest related` et `jest --findRelatedTests` les trouvent eux-mêmes. Pour Dart, revo-flow les tire du
graphe : arêtes `teste` (graph.ts:922-926, « un test teste ce qu'il importe »), plus la convention
`lib/a/b.dart` → `test/a/b_test.dart`. Dans un monorepo (`packages/*` d'application-mobile-ui), chaque fichier va au
`pubspec.yaml` ou au `package.json` le plus proche, qui devient le `cwd` de la commande.

Ces formes de commande sont à confirmer au lot 1a sur chaque famille (option exacte de `dart analyze` sur des
fichiers, sortie JSON de Jest 27).

### 6.3 Windows

- `npm`, `npx` et `flutter` sont des `.cmd` ou `.bat` : sans shell (cc:3583), il faut `['cmd', '/c', 'npx', …]`,
  comme le fait déjà `openPlan` (register.tsx:1658). Chemins relatifs au `cwd`, pour éviter les espaces à protéger.
- Fin de ligne CRLF dans les sorties ; signal nul à l'arrêt d'un `spawn` (rapport « capacites »).
- Antivirus : la première exécution de Jest ou de Flutter peut doubler de durée. La durée apprise (§6.5) l'absorbe.

### 6.4 Confirmation et stockage

- La liste proposée est montrée en entier dans la question (commande exacte, portée, source : « CI », « script
  lint », « déduit »).
- **Utiliser** : rangée dans `graph.projet.verif` avec le hash des manifestes lus. **Ajuster** : l'orchestrateur
  reçoit la liste et la corrige par `verif` action `commandes`, puis la question revient. **Pas de vérification** : noté
  pour ce flow seulement.
- Redemandée quand un manifeste lu change de hash (le graphe suit déjà les hash git des fichiers).
- Une commande confirmée n'est jamais modifiée en silence : toute modification repasse par la question.

### 6.5 Ce qui s'apprend au fil des flows

Comme les pièges des fiches, mais au niveau du projet, dans `graph.projet.verif` :

- **Durée moyenne** de chaque commande (moyenne glissante) : sert à choisir `run` ou `spawn` et à afficher une durée
  attendue.
- **Tests instables** : un test rouge relancé une fois et vert devient « instable » ; il ne bloque plus, il est
  affiché à part.
- **Exclusions** : motif de tests qui demandent un service (sandbox Architect, Supabase, DynamoDB local), appris quand
  l'orchestrateur le dit par `verif commandes`.
- **Pièges d'environnement** : version Flutter du poste différente de `.fvm` (3.44.4 contre 3.44.6 pour
  application-mobile-ui), fichier `env.test` absent, `node_modules` absent. Affichés à la question du point 2 du flux.

C'est la seule part de la piste « mémoire validée » (README, piste 7) que la v2 reprend : courte, vérifiable,
non évidente.

## 7. Exécution et lecture des sorties

- **Portée** : les fichiers modifiés du flow, déjà suivis par `markFile` (register.tsx:2159), plus `git status` pour
  ceux modifiés par Bash. Une commande de projet (typecheck) tourne une fois par porte.
- **`run` ou `spawn`** : `run` si la durée apprise est sous 5 min, sinon `spawn` avec notre propre minuterie
  (application-mobile-ui en entier dépasserait probablement 10 min ; c'est une estimation).
- **Lecture** : formats machine quand l'outil en a un (Vitest et Jest en JSON, `dart analyze --format=machine`) ;
  sinon des motifs (`fichier(ligne,col): error TSxxxx`, sortie d'ESLint). Chaque erreur devient une **signature**
  `{ outil, fichier, règle ou code, message normalisé }`, sans numéro de ligne (il bouge).
- **Base de référence** : l'ensemble des signatures au commit de départ, gardé dans le graphe par commit (les 3
  derniers). Nouvelle erreur = signature absente de la base. Base inconnue (tests liés qu'on n'a pas pu lancer avant) :
  l'erreur est « nouvelle ? » ; l'orchestrateur peut la dire préexistante, l'utilisateur confirme.
- **Instabilité** : un test rouge est relancé une fois, seul.
- **Rapport à l'orchestrateur** : erreurs nouvelles seulement, groupées par fichier, 30 au plus, ≤ 4k tokens ;
  le reste est compté (« et 14 autres ») ; la sortie complète va dans un fichier texte (§10).
- **Copie partagée** : les agents écrivent tous dans la même copie. Un agent qui lance `verif` ne voit que les erreurs
  de *ses* fichiers ; la porte globale n'a lieu que quand tous ont fini.

## 8. Garde-fous

| Garde-fou | Mécanisme | Lot |
|---|---|---|
| **Plafond de tentatives** | 3 `block` au plus sur la porte de fin, compté par flow (et `stop_hook_active`, cc:12703) ; puis question (§4). 2 au plus par agent si l'option `SubagentStop` est prise | 1b |
| **Porte qui s'ouvre en cas de bug** | Hook sans `.catch` : un plantage laisse finir (cc:4036-4041) et le flow est marqué « non vérifié (erreur de revo-flow) » | 1b |
| **Tests gelés** | Fin du testeur : hash git (`hash-object`) de ses fichiers de test → ensemble gelé. `Edit`, `Write`, `NotebookEdit` d'un autre agent ou de l'orchestrateur sur ces chemins : `deny` (cc:13340-13349), avec un `.catch` qui refuse aussi. À chaque porte, re-hash : une modification par Bash est détectée | 2 |
| **Auteur des tests ≠ réparateur** | Le testeur n'a que des tâches `test` ; un `Edit` du testeur hors fichiers de test est refusé. L'implémenteur ne peut pas toucher aux tests gelés. Seul un dégel confirmé par l'utilisateur rouvre un test | 2 |
| **Vérificateur en lecture seule** | `disallowedTools: ['Edit', 'Write', 'NotebookEdit']` (cc:490) ; ses appels `Bash` passent par `tool.call` : seules les commandes confirmées et des lectures (`git diff`, `git show`, `cat`, `ls`) passent | 2 |
| **Triche détectée** | Dans le diff du flow : ajout de `.skip`, `.only`, `xit`, `test.todo`, `skip: true` (Dart) ; baisse du nombre d'`expect` dans un test modifié ; ajout de `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `biome-ignore`, `// ignore:` (Dart), `as any` ; modification de `.eslintrc*`, `tsconfig*.json`, `vitest.config.*`, `jest.config.*`, `analysis_options.yaml`, des scripts `lint` ou `test` | 2 |
| **Que faire d'une triche** | Signalée dans le panneau et au vérificateur. Test gelé modifié ou garde-fou modifié : la porte reste rouge jusqu'à la réponse de l'utilisateur (§4). Les autres motifs : signalés, pas bloquants (un `as any` peut être légitime) | 2 |
| **Exécution de code du dépôt** | Les scripts du dépôt sont du code arbitraire, comme quand un agent lance `npm test` ; d'où la confirmation de la liste exacte, et sa re-confirmation à chaque changement | 1a |

## 9. Affichage

**Panneau** : une section « Vérification », entre « Fichiers modifiés » et « Cache ». Exemple, flow rouge en
deuxième tentative :

```
Vérification · reservation-tool · tentative 2/3                 [Détail] [Relancer]
  ✓ eslint          12 fichiers                     6 s
  ✗ nuxi typecheck  2 nouvelles · 5 préexistantes  48 s   stores/booking/Cart.ts (2)
  ✓ vitest related  4 fichiers de test, 31 tests   14 s   1 instable
  ⚠ tests gelés     cart.spec.ts modifié par Bash (« cablage ») : en attente de votre réponse
  Critères 3/4 ✓ · vérificateur : « ko » sur C4 (preuve : sortie de vitest)
```

**Bande au-dessus du prompt** : un segment après la progression, `vérif ✓ 3/3` ou `vérif ✗ typecheck (2)`, ou
`vérif …` pendant l'exécution.

**Statut** (`$.ui.status`, cc:2510) pendant une commande : « revo-flow : typecheck… (≈ 45 s) ».

**Notification de fin** (existante, register.tsx:465) : le segment « vérifié ✓ » ou « non vérifié (typecheck ✗) ».

**Historique** (`/revo-flow historique`) : une colonne « vérif » : ✓, ✗ (accepté par l'utilisateur), observé, —.

**Détail** : le bouton ouvre le fichier texte de la sortie complète, comme le bouton « plan.md » (register.tsx:1654-1664).

## 10. Données persistées

| Donnée | Où | Taille (estimation) |
|---|---|---|
| Commandes confirmées, hash des manifestes, durées, tests instables, exclusions, pièges d'environnement | Graphe du projet, nouveau champ `projet.verif` (types/cache.d.ts:95-107 ; à recopier dans types/index.d.ts, piège connu de la fiche cache-projet) | 2 à 5 Ko |
| Base de référence par commit (3 derniers) | Graphe, `projet.verif.bases` | 1 à 30 Ko selon la dette de lint |
| Résultat par flow | Journal du graphe (`JournalEntry`, types/cache.d.ts:90) : `verif: { etat, tentatives, nouvelles, preexistantes, dureeMs, triches, criteres }` | ≈ 100 octets par flow, 200 flows |
| Résumé par flow pour l'historique | Journal du store (register.tsx:473-497), même champ | idem ; le store a 4 MiB au total |
| Sortie complète d'une exécution | `~/.claude/revo-flow/verif/<flow>/<commande>.txt`, via `$.fs.write` (texte, ≤ 4 MiB par fichier) ; les 20 derniers flows gardés | 10 à 500 Ko par flow |
| Ensemble des tests gelés | `$.state` pendant le flow ; recopié dans le journal à la fin | négligeable |
| Captures (lot 3) | `~/.claude/revo-flow/verif/<flow>/*.png.b64` : `$.fs` n'écrit que du texte | 0,2 à 1 Mo par capture |

## 11. Limites

- **10 min par commande** avec `$.process.run` (cc:3591-3592). Au-delà, `spawn`, sans limite déclarée mais tué au
  rechargement du mod (cc:3603-3605). Une suite entière de 351 fichiers Flutter n'a rien à faire dans la porte : tests
  liés seulement.
- **Copie partagée** : pas de worktree (piste 6 écartée). La porte globale attend que tous les agents aient fini.
- **Base de référence imparfaite** pour les tests liés : on ne connaît pas avant le plan les fichiers que le flow
  touchera. Repli : « nouvelle ? », que l'orchestrateur peut contester, l'utilisateur tranchant.
- **Windows** : `cmd /c` obligatoire ; durées plus longues ; aucune cible iOS.
- **Émulateurs** : aucun dans l'API ; `adb` et `emulator` via `$.process`, démarrage de 30 s à 2 min (estimation). Voir
  [execution.md](execution.md).
- **Tests qui demandent un service** (sandbox Architect, Supabase de router_app, DynamoDB local) : exclus par défaut.
- **Le typage du projet entier** peut être lent sur un gros Nuxt 3 (30 s à 2 min, estimation) : une fois par porte.
- **`claude plugin test`** n'a ni `fs`, ni réseau, ni `process` : toute la logique (détection, lecture des sorties,
  signatures, base, triche) doit être pure et recevoir ses accès en paramètre, comme `ioOf` pour le cache
  (register.tsx:504-519). C'est ce qui rend le lot testable.
- **API en accès anticipé** : `classic.Stop` avec une longue attente n'a pas encore été essayé dans ce mod.

## 12. Coûts estimés par flow

Tarifs de lib.ts:481-484 (Sonnet 2 / 10 / 0,2 / 2,5 $/M ; Opus 4 / 20 / 0,2 / 5 $/M, entrée / sortie / lecture de
cache / écriture de cache). Tout est **estimation**.

| Poste | Quand | Hypothèse | Coût |
|---|---|---|---|
| Exécuter les commandes | Chaque flow | 0 token | 0 $ ; 1 à 4 min de machine |
| Base de référence | Planification, si commit nouveau | 0 token | 0 $ ; 1 à 5 min de machine en fond |
| Rapport rouge à l'orchestrateur | Si rouge | 1 à 4k tokens écrits en cache Opus | < 0,03 $ |
| Reprise par l'orchestrateur | Si rouge | 5 à 10 tours, 100k de contexte relu, 20k écrits | 0,2 à 0,4 $ |
| Reprise d'un agent par SendMessage | Si rouge | Sonnet, 5 à 10 tours, 50k relus | 0,05 à 0,2 $ |
| Testeur | Lot 2, sur décision | Sonnet high, 20 à 40 tours, 30k de contexte moyen | 0,3 à 0,8 $ |
| Vérificateur | Lot 2, sur décision | Sonnet medium, 20 à 30 tours, 25k de contexte moyen, 5k de sortie | 0,2 à 0,5 $ |
| Preuve web | Lot 3, sur décision | 3 à 6 captures (≈ 1,5k tokens chacune), console et réseau | 0,2 à 0,6 $ |

| Profil de flow | Surcoût |
|---|---|
| Lot 1, vert du premier coup | 0 $, 1 à 4 min |
| Lot 1, une reprise | 0,05 à 0,4 $ |
| Lot 2 complet (testeur + vérificateur), une reprise | 0,5 à 1,7 $ |
| Lots 2 et 3 | 0,7 à 2,3 $ |

Les deux flows réels coûtent 9,47 $ et 1,22 $. Le lot 1 est négligeable devant eux ; le lot 2 pèse 10 à 40 % d'un flow
moyen, d'où la décision laissée à l'orchestrateur (et la question 4 du README). Anthropic mesure un évaluateur à
≈ 10 % du coût total sur des sessions longues [lu].

## 13. Lots

### Lot 1a : détection, exécution, observation (2,5 à 3 j)

1. Module pur `hooks/verif/` : détection par famille (§6.1-6.2), lecture des sorties en signatures, différence avec la
   base, rapport borné. Tests sur des sorties réelles capturées des 5 familles.
2. Accès injectés (`run`, `spawn`, `fs`, `now`), comme `ioOf`.
3. Question de confirmation ; `projet.verif` dans le graphe ; re-confirmation au changement de manifeste.
4. Base de référence pendant la planification (`spawn`, en fond).
5. Porte **en observateur** : lancée à `toReview`, résultat affiché et journalisé, jamais bloquante.
6. Section du panneau, segment de bande, colonne d'historique.
7. Champ `verif` du journal (graphe et store).

Sortie : après 15 à 20 flows, le taux réel de flows rouges (H1) et les durées (H3) par famille.

### Lot 1b : porte bloquante (1,5 à 2 j)

1. `classic.Stop` : attente du résultat, `block` borné, plafond, question de fin (§4).
2. Outil `mcp__revo-flow__verif` : `lancer` (portée = fichiers de l'appelant), `resultat`, `commandes`, `exception`.
3. Consignes : étape 4 du `leadBrief` (lib.ts:267) remplacée par « la porte revo-flow vérifie ; lis son rapport et
   décide » ; une ligne dans `agentBrief`.
4. Notification « vérifié ✓ / non vérifié ».
5. Option `verif: 'bloquer' | 'observer' | 'off'` à côté de `validerPlan` et `conflits` (register.tsx:135, 1678-1679).

### Lot 1c, facultatif : porte par agent (1 j)

`classic.SubagentStop` avec `block` sur les seules erreurs des fichiers de l'agent. À ne faire que si le lot 1a montre
beaucoup d'erreurs attribuables à un agent précis.

### Lot 2 : contrat, vérificateur, tests gelés (3 à 4 j)

1. `criteres` dans le schéma de l'outil `plan` (register.tsx:254-291) et dans `parsePlan` ; affichés à la validation
   et dans plan.md.
2. `revo-flow:verifier` enregistré (§5) avec un prompt calibré (3 exemples notés ok, ko, non vérifiable) ; verdict en
   JSON par critère avec la preuve.
3. Testeur : tâches `test`, consigne « à partir des critères et des interfaces » ; gel à sa fin ; `deny` et `.catch`
   fermé ; re-hash à chaque porte.
4. Détection de triche sur le diff (§8) ; questions de dégel et de garde-fou modifié.
5. Proposition, dans le brief, de lancer une revue (`review-agent`, `/code-review`) quand le flow est gros : une ligne,
   pas une feature.

### Lots 3 et 4 : preuve à l'exécution

Voir [execution.md](execution.md) : web 2 à 3 j ; mobile 1 j d'essai, puis 3 à 4 j.

## 14. Mesure du gain

Le journal des 200 derniers flows existe dans le graphe depuis la v1.5 (types/cache.d.ts:86-90, 113-114). On y ajoute
`verif`, et `computeStats` en tire, pour le panneau et l'historique :

| Indicateur | Calcul | Ce qu'il prouve |
|---|---|---|
| **Taux d'échappement** (lot 1a) | Flows dont la porte en observateur est rouge après la conclusion de l'orchestrateur | Ce que la v1.5 laisse passer aujourd'hui : c'est H1, et la base de tout le reste |
| Rouge au premier passage (lot 1b) | Flows dont la première porte est rouge | Combien de flows la porte a rattrapés |
| Erreurs nouvelles attrapées | Somme des erreurs nouvelles corrigées pendant le flow | Défauts qui n'atteignent pas la MR |
| Non vérifiés acceptés | Flows finis rouges sur décision de l'utilisateur | Le reste à charge |
| Coût de la vérification | Temps des commandes ; tokens des reprises, du testeur et du vérificateur | Ce que paie la garantie |
| Retouches à 48 h (facultatif) | Commits `fix` sur les mêmes fichiers dans les 48 h, lus par `git log` | Approximation de ce qui s'échappe encore |

Le contrefactuel est propre pour une fois : en mode observateur, la porte tourne **après** la conclusion de
l'orchestrateur, sans rien changer au flow. Ce qu'elle trouve rouge, c'est exactement ce que la v1.5 aurait livré.

## 15. Risques

| Risque | Effet | Parade |
|---|---|---|
| Commandes trop lentes | Flows plus longs, utilisateur qui coupe la porte | Portée ciblée, durées apprises, build hors porte, mesure au lot 1a |
| Faux rouges (dette, tests instables, services absents) | Reprises inutiles, perte de confiance | Base de référence, relance unique, exclusions apprises |
| Boucle de reprises | Coût | Plafond de 3, puis question |
| Vérificateur indulgent | Fausse assurance | Exemples notés, verdict avec preuve exécutée, la porte mécanique reste la référence |
| Test faux gelé | Implémenteur bloqué | Dégel par l'orchestrateur, confirmé par l'utilisateur |
| Agent qui contourne par Bash | Test modifié malgré le gel | Re-hash à chaque porte ; signalé, bloquant |
| API qui change (accès anticipé) | Hooks cassés | Hooks en échec ouverts pour la porte, fermés pour le gel ; tests du module pur |
