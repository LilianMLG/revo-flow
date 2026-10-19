# Preuve à l'exécution : web (lot 3) et mobile (lot 4)

> Annexe de [conception.md](conception.md). Ces lots ne valent que si le lot 1 est en place : ils ajoutent au
> vérificateur du lot 2 la possibilité de **voir l'application tourner**. Aucune mesure indépendante ne chiffre leur
> gain (veille du 2026-10-19) : ils sont conditionnés aux chiffres du lot 1a.

## 1. Ce qu'on cherche à attraper

Ce qu'aucun lint, typecheck ni test unitaire ne voit :

| Web (Nuxt) | Mobile (Flutter) |
|---|---|
| Page blanche ou erreur d'hydratation | Écran rouge (exception de build de widget) |
| Erreur dans la console | Débordement de rendu (« RenderFlex overflowed ») |
| Appel réseau en 4xx ou 5xx, appel GraphQL en erreur | Navigation go_router cassée |
| Composant absent, texte de traduction manquant | Clé de traduction manquante (gen-l10n) |
| Régression visuelle grossière | Régression visuelle grossière |

Une capture n'est pas une preuve en soi : « j'ai pris une capture » ≠ « c'est bon ». La preuve, ce sont des faits
lisibles : console sans erreur, réseau sans 4xx/5xx, élément attendu présent dans l'arbre d'accessibilité ou de
widgets, et la capture en appui pour l'humain.

## 2. Web (lot 3, 2 à 3 j)

### 2.1 Flux

1. Le plan comporte un critère observable (« le panier affiche le total TTC après ajout d'une option »).
2. L'orchestrateur lance le vérificateur avec le droit d'exécution web.
3. Le vérificateur demande un serveur : revo-flow pose la question « Démarrer `npm run dev` pour reservation-tool
   (port 3000) ? » ; sur « Démarrer », `$.process.spawn` (cc:3600-3636) lance le serveur, revo-flow lit sa sortie
   jusqu'à « Listening on » ou un délai (90 s : la CI d'ui-vel attend elle-même 90 s), et donne l'URL.
4. Le vérificateur navigue avec les outils `claude-in-chrome` (mcp:691 `navigate`, mcp:589 `computer` pour les
   captures, mcp:698 `read_console_messages`, mcp:711 `read_network_requests`), ajoutés à ses outils autorisés.
5. Il rend, par critère : ok, ko ou non vérifiable, avec les faits (erreurs de console, requêtes en échec) et la
   capture.
6. revo-flow arrête le serveur à la fin du flow (sortie de la boucle `for await`, cc:3603-3605), et range la capture
   (texte base64, `$.fs` n'écrivant que du texte) ; le panneau l'affiche dans le terminal par `Image` (cc:5441-5465).

### 2.2 Choix techniques

| Option | Pour | Contre | Choix |
|---|---|---|---|
| `claude-in-chrome` (extension déjà sur le poste) | Typé (mcp:579-760), appelable sans demande de permission par `$.mcp.call` (cc:2752-2753), session réelle de l'utilisateur | Dépend de l'extension connectée ; partage le navigateur de l'utilisateur | **Par défaut** |
| Playwright MCP ou Chrome DevTools MCP | Navigateur isolé, sans tête ; DevTools donne console, réseau, performance [lu] | Serveur MCP à installer et à déclarer (`mcpServers`, cc:512) | Repli si l'extension n'est pas là |
| Specs Playwright du projet (ui-vel, 4 specs) | Rejouable en CI, déterministe | Config sans `webServer` ni `baseURL` ; `allow_failure` en CI | À réparer une fois (tâche proposée à l'orchestrateur), puis à intégrer à la porte du lot 1 comme commande « e2e » facultative |

### 2.3 Par projet

| Projet | Démarrage | Obstacle |
|---|---|---|
| reservation-tool | `npm run dev` (Nuxt 3) | API GraphQL à joindre : environnement de recette ou local ? |
| lumos-front | `npm run dev` (Nuxt 3) | idem |
| back-office | `npm run dev` (Nuxt 2) | Connexion obligatoire : compte de test (question 6 du README) |
| ui-vel | `npm run dev` (Nuxt 2), 90 s | Playwright à réparer d'abord |

### 2.4 Coût et durée (estimations)

Démarrage 20 à 90 s ; 3 à 6 captures à ≈ 1,5k tokens chacune ; 5 à 15 appels d'outils (veille [sec.]). Total 0,2 à
0,6 $ et 1 à 3 min par flow qui le demande.

### 2.5 Garde-fous

- Le serveur ne démarre que sur réponse de l'utilisateur ; il est toujours arrêté en fin de flow.
- Pas d'identifiants dans le graphe, le journal ni le prompt : une variable d'environnement nommée par l'utilisateur,
  lue par le serveur de dev, jamais par revo-flow.
- Un port déjà pris : revo-flow le dit, ne tue rien.

## 3. Mobile (lot 4 : 1 j d'essai, puis 3 à 4 j)

### 3.1 Ce que le lot 1 couvre déjà

Pour application-mobile-ui (351 tests) et router_app (146 tests), la porte du lot 1 lance déjà `dart analyze` et les
`flutter test` liés, sans émulateur. C'est l'essentiel de la valeur mobile, et elle est livrée dès le lot 1. Le lot 4
ne vise que ce qui demande l'application en marche.

### 3.2 Trois voies, de la moins chère à la plus chère

| Voie | Principe | Sous Windows | Coût | Risque |
|---|---|---|---|---|
| **A. Tests de golden** (`matchesGoldenFile`) dans `flutter test` | Le testeur du lot 2 écrit un golden de l'écran touché ; la porte du lot 1 le rejoue | Oui, sans émulateur | Celui d'un test | Rendu dépendant de l'OS et des polices : goldens à générer sur le même poste, et à exclure de la CI Linux ou à y régénérer |
| **B. Dart MCP** (`dart mcp-server` : `take_screenshot`, `get_widget_tree`, `hot_reload`) | Le vérificateur se branche sur l'app lancée par `flutter run` | Oui pour une cible Windows, web ou Android ; Dart 3.12.2 présent | Démarrage 1 à 3 min ; 0,3 à 0,8 $ | Serveur récent [sec.] ; à déclarer par `mcpServers` de l'agent (cc:512) |
| **C. Maestro ou mobile-mcp** sur émulateur Android | Le vérificateur explore, écrit un flow `.maestro/*.yaml`, `maestro test` le rejoue | Android seulement ; iOS impossible sous Windows ; à vérifier : Maestro CLI sous Windows | Démarrage émulateur 30 s à 2 min ; RAM | Flows fragiles aux libellés ; alertes natives invisibles |

### 3.3 Essai d'un jour (avant tout développement)

1. `adb devices` et `emulator -list-avds` : un AVD existe-t-il sur le poste ?
2. `flutter run -d windows` ou `-d chrome` sur application-mobile-ui : l'app démarre-t-elle hors mobile (Mapbox,
   Firebase et Supabase de router_app risquent de ne pas le permettre) ?
3. `dart mcp-server` déclaré dans un agent de test : `get_widget_tree` et `take_screenshot` répondent-ils ?
4. Un golden sur un écran simple : stable entre deux exécutions sur le poste ?
5. Version : `.fvm` demande 3.44.6, le poste a 3.44.4 ; l'écart casse-t-il `flutter test` ?

Décision à la fin de l'essai : A seule (le moins cher, déjà dans la porte), A + B, ou A + C.

### 3.4 Ce que revo-flow ferait (si l'essai passe)

- Question « Démarrer l'émulateur Pixel_8 et lancer l'app ? » ; `$.process.spawn` sur `emulator` puis `flutter run`.
- Le vérificateur reçoit le serveur Dart MCP dans ses `mcpServers` ; il rend les mêmes faits qu'en web : erreurs du
  journal Flutter, arbre de widgets contenant l'élément attendu, capture.
- Arrêt de l'app et de l'émulateur en fin de flow, sauf si l'utilisateur les avait déjà lancés.

## 4. Questions propres à ces lots

1. Quel environnement d'API pour le web local : recette, ou des mocks ?
2. Compte de test pour back-office et reservation-tool : existe-t-il, et sous quel nom de variable ?
3. Faut-il réparer la config Playwright d'ui-vel dans un flow dédié, avant le lot 3 ?
4. Émulateur Android sur le poste, et Flutter web ou Windows acceptables comme cibles de capture ?
5. Goldens Flutter : gardés dans le dépôt, avec quelle règle pour la CI ?
