# R&D : graphe de cache par projet

> **Statut : lots 0 à 3 implémentés en v1.2.0 (2026-10-14) ; lot 4 en partie en v1.3.0 (2026-10-15) : extrait de fiche injecté à chaque agent, actions `rafraichir` et `diff` ; le reste du lot 4 à venir.**
>
> Étude de faisabilité du 2026-10-14. Trois fiches détaillées :
> [conception.md](conception.md) (modèle, construction, usage, gains), [api-plugin.md](api-plugin.md)
> (ce que l'API plugin permet, avec les lignes des typings), [ui.md](ui.md) (panneau, bande, terminal).
> Suite du 2026-10-15 : [ameliorations.md](ameliorations.md) (limites mesurées, état de l'art, pistes chiffrées pour la v1.4).

## Verdict : faisable

Tout ce dont la feature a besoin existe dans l'API plugin de Claude Code (2.1.299, early access) :

| Besoin | Primitive | Limite |
| --- | --- | --- |
| Stocker un graphe par projet | `$.fs.write` / `$.fs.read` en chemin absolu, sous `~/.claude/revo-flow/graphs/<projet>.json` | 4 MiB par fichier, largement assez (130 à 190 Ko par projet) ; `~` à expanser via `USERPROFILE` |
| Lister les fichiers et détecter les changements | `$.process.run(['git','ls-files','-s'])`, `git status` | pas de glob natif dans `$.fs`, git fait le travail en moins d'une seconde |
| Outil interrogeable par l'orchestrateur et les agents | `$.tool.register` + hook `tool.call` qui renvoie `{ result }` | à enregistrer dès `session.start` (aujourd'hui les outils ne le sont qu'au premier `/revo-flow`) |
| Injecter un brief au début du plan | retour `context: [...]` de `command.run` (déjà utilisé pour `LEAD_BRIEF`) | 100 000 caractères par entrée |
| Écrire les résumés | `$.model.complete({ model: 'haiku', ... })` pour un fichier, ou `$.agent.spawn` d'un agent `revo-flow:indexer` (effort et outils fixés par `$.agent.register`) | pas d'`effort` au spawn direct ; le garde « aucun agent avant le plan » doit exempter l'indexeur |
| Savoir quels fichiers ont été lus ou modifiés pendant un flow | hook `tool.call` sur Read / Edit / Write (déjà en place pour les fichiers modifiés) | ne voit pas les éditions faites par Bash ou hors Claude : d'où la vérification par hash git |
| Afficher dans le panneau et la bande | Box, Text, Button, Svg (desktop) | aucun arbre, table ou pliable natif : à composer ; pas de vrai rendu nœuds/arêtes interactif |

Ce qui n'est **pas** possible : un graphe interactif (clic, zoom) dans le panneau, et une détection des modifications faites hors des outils Claude autrement que par git.

## Ce que les projets réels imposent

| | reservation-tool | ui-vel |
| --- | --- | --- |
| Fichiers source | 284 | 427 |
| Volume | ≈ 254k tokens | ≈ 553k tokens |
| Une feature (fichiers touchés par ses commits) | 15k à 32k tokens | 53k à 100k tokens |

Les imports explicites ne suffisent pas : auto-imports Nuxt (140 dans reservation-tool), appels Vuex par chaîne (909 dans ui-vel) et composants utilisés par balise (342) doivent être résolus dès la v1, sinon `voisins` ment.

## Architecture retenue

- **Deux couches.** Une couche mécanique (fichiers, imports, routes, stores, opérations GraphQL) reconstruite sans LLM en 1 à 2 s et vérifiée par hash git à chaque usage. Une couche « savoir » : des fiches par feature (résumé, flux, points d'entrée, fichiers et rôles, pièges, confiance) écrites par un modèle.
- **Alimentation principale : la fin de chaque flow.** L'orchestrateur a déjà tout lu, il appelle `cache apprendre` pour 0,02 € environ. `cache build <feature>` complète à la demande (0,15 à 0,25 € par fiche). `build --tout` est déconseillé.
- **Jamais de suppression.** Une fiche périmée est servie avec la liste des fichiers modifiés depuis ; au-delà de 50 % modifié, seuls les fichiers et pièges sont servis.
- **Au lancement de `/revo-flow`** : brief de cache d'au plus 1 200 tokens (stack, features connues avec fraîcheur, fiche probable), plus l'outil `mcp__revo-flow__cache` (`chercher`, `feature`, `voisins`, `apprendre`, `oublier`). Le brief dit explicitement : « le cache est une carte, pas la vérité ».
- **Commandes** : `cache`, `cache <projet>`, `cache build [feature]`, `cache clear`, `cache <mot-clé>`. Alias `graphe` car « cache » est aussi un verbe en français.

## Gains et mesure

- Scénario mesuré (correctif double-session sur reservation-tool) : ≈ 54k tokens lus sans cache, ≈ 18k avec, soit 65 % de lecture en moins et ≈ 0,32 € par flow en comptant le contexte qui repasse à chaque tour.
- Une fiche est rentable dès sa première réutilisation.
- Mesure réelle dans le panneau : tokens évités = taille des fichiers servis par le cache, encore frais, que personne n'a relus, moins ce que le brief a injecté. Toujours affiché avec « ≈ ».
- Un **lot 0 de mesure** (tokens lus par flow, sans cache) est indispensable pour prouver le gain.

## Affichage

- Panneau : section « Cache » entre « Fichiers modifiés » et « Consommation », pliable par bouton, avec les nœuds servis (● couleur de l'agent), les frais (○), les périmés (⚠), la jauge de gain et le coût de construction.
- Bande au-dessus du prompt : 3e ligne `graphe : 12 nœuds · 3 utilisés · ≈ 18k tokens évités`.
- Ligne de fin de tour (terminal) : segment `graphe 3 hits ≈ -18k` seulement s'il y a eu des hits.
- Vocabulaire à trancher : la bande dit déjà « cache » pour le cache de prompt API. Proposition : « graphe » pour la nouvelle feature.

## Lots

| Lot | Contenu | Effort |
| --- | --- | --- |
| 0 | Mesurer les tokens lus par flow (baseline) | ½ j |
| 1 | Graphe mécanique, outil `cache` (`chercher`, `voisins`), commandes de consultation | 2 à 3 j |
| 2 | Fiches apprises en fin de flow, brief injecté au lancement, mesure des gains, section du panneau | 2 à 3 j |
| 3 | `cache build` avec sous-agent en arrière-plan | 2 j |
| 4 (v2) | Liens Front ↔ Back, export Markdown équipe, vue graphe Svg | 4 à 6 j |

## Implémentation (v1.2.0)

- `hooks/cache/graph.ts` : module pur (modèle, indexeur, fraîcheur, recherche, apprentissage, stats, textes) ; tests dans `tests/cache/graph.test.ts`. Mesuré : 65 Ko et 163 ms pour reservation-tool, 95 Ko et 193 ms pour ui-vel.
- `hooks/cache/store.ts` : fichier `~/.claude/revo-flow/graphs/<cle>.json`, git (ls-files, status, hash-object, log, diff -M), écriture atomique et fusion par feature, rafraîchissement incrémental ; tests dans `tests/cache/store.test.ts`.
- `hooks/register.tsx` : outil `mcp__revo-flow__cache`, commande `cache`/`graphe`, brief au lancement avec confirmation, mesure des tokens lus et servis, fiche auto en fin de flow, agent `revo-flow:cache-indexer` pour `cache build`.
- `hooks/lib.ts` : `LEAD_BRIEF`, `agentBrief` et `flowRecap` adaptés.
- `hooks/ui/views.tsx`, `hooks/ui/art.ts` : section « Cache », ligne de bande, segment de fin de tour.
- `types/cache.d.ts` : contrat du graphe (recopié en partie dans `types/index.d.ts`, qui doit rester autonome).

## Décisions (2026-10-14)

1. **L'orchestrateur gère tout.** revo-flow ne passe pas lui-même les extraits de fiche aux sous-agents : c'est l'orchestrateur, modèle le plus intelligent de la session, qui choisit ce qu'il transmet à chacun. Le `LEAD_BRIEF` le lui demande (étape 3), revo-flow fournit l'outil et le brief, rien de plus.
   *Amendée en v1.3.0 (2026-10-15)* : revo-flow injecte lui-même dans `agent.spawn` l'extrait de la fiche servie qui concerne chaque agent (fichiers cités par sa mission, sinon entrée, cœur et données ; pièges ; ≤ 600 tokens) et lui donne la consigne d'utiliser l'outil (`chercher`, `feature`, `voisins`, `diff`, `rafraichir`). L'orchestrateur complète avec ce qui manque (pièges transverses, décisions). Une fiche périmée se vérifie (`diff`) puis se rafraîchit (`rafraichir`) ou se corrige (`apprendre` avec `corrections`).
2. **Confirmation au lancement.** Quand une feature du cache correspond à la demande, revo-flow demande via `$.ui.ask` (« Je pense qu'il s'agit de complementary-products : utiliser la fiche ? », options Utiliser / Ignorer) avant d'injecter la fiche. Sans personne à qui demander (`claude -p`), la fiche est utilisée.
3. **Nom : `cache`.** Sous-commande `/revo-flow cache …`, outil `mcp__revo-flow__cache`. Dans la bande, l'existant « 40k cache » (cache de prompt API) devient « 40k cache API » pour lever l'ambiguïté.
