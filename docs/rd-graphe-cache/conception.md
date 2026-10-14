# revo-flow : graphe de cache par projet (fiche de conception)

> R&D, 2026-10-14. Rien n'a été modifié dans les projets ni dans le dépôt revo-flow. Les chiffres viennent d'un
> scan en lecture seule de `Front/reservation-tool` (HEAD 4b3913e) et `Front/ui-vel` (HEAD 995d0209).
> Le prototype de scan est dans le scratchpad (`proto/scan.mjs`) ; ce n'est pas du code destiné au dépôt.

## 0. En bref

- Le graphe a **deux couches** :
  - une **couche mécanique** (fichiers, imports, routes, stores, opérations GraphQL), reconstruite sans LLM en 1 à 2 s et vérifiée à chaque usage grâce aux hash de blob git ;
  - une **couche « savoir »** : des **fiches de feature** (résumé, flux, points d'entrée, fichiers et leur rôle, pièges), écrites par un LLM.
- On alimente la couche « savoir » surtout **à la fin de chaque flow**, quand l'orchestrateur a déjà tout lu (coût presque nul). Une construction à la demande (`/revo-flow cache build <feature>`) la complète.
- Une fiche périmée n'est **jamais supprimée** : elle est servie avec la liste des fichiers modifiés depuis, à relire.
- Au lancement de `/revo-flow`, revo-flow injecte un **brief de cache** (≤ 1 200 tokens) et expose l'outil `mcp__revo-flow__cache`.
- Gain attendu : **50 à 65 % des tokens de lecture** sur une feature déjà connue, soit environ 30 à 40k tokens lus en moins par flow sur reservation-tool, sans compter l'effet de traîne (voir §5). Une fiche coûte 0,02 € quand elle est apprise en fin de flow, ou 0,15 à 0,25 € quand elle est construite à la demande. Elle est donc rentable dès sa première réutilisation.
- Mesure : **tokens évités = taille des fichiers listés par le cache (et frais) que personne n'a lus pendant le flow**, moins ce que le cache a lui-même injecté.

---

## 1. Ce que montrent les projets réels

### 1.1 Volume (hors node_modules, dist, .nuxt, .output, generated, coverage, static/public, lockfiles, .claude)

| | reservation-tool | ui-vel |
|---|---|---|
| Stack | Nuxt 3, Vue 3 `<script setup>`, **Pinia**, Apollo, Vuetify, vitest, sous-module `libraries/nuxt-components-library` | **Nuxt 2** (nuxt-edge), Vue 2 Options API, **Vuex** + mixins, Apollo 2, Jest, Playwright |
| Fichiers suivis par git | 315 | 633 (dont 139 images ou icônes) |
| Fichiers source retenus | **284** | **427** |
| Volume total | 1,01 M car. ≈ **254k tokens** | 2,21 M car. ≈ **553k tokens** |
| dont code hors tests | ≈ 200k tokens | ≈ 430k tokens |
| dont tests | 49 fichiers, 43k tokens | 93 fichiers, 113k tokens |
| Taille médiane d'un fichier | ≈ 465 tokens | ≈ 709 tokens |
| Plus gros fichiers | `stores/booking/Cart.ts` 11,1k · `pages/availabilities/index.vue` 8,3k · `CustomerForm.vue` 7,1k · `stores/booking/Booking.ts` 5,8k | `pages/accommodations/index.vue` 14,8k · `store/booking.ts` 14,4k · `pages/duration.vue` 11k · `pages/offers/category.vue` 8,1k |
| Routes (pages/) | 17 (`[id]`) | 35 (`_name`) |
| Docs | `docs/PLATFORMS.md`, `docs/CHATBOT.md`, README | 3 docs + `CLAUDE.md` + `.claude/{rules,skills,commands}` |

Répartition reservation-tool (tokens) : components 98k · tests 43k · stores 25k · pages 23k · composables 18k · utils 12k · services 10k · docs 9k · types 6k · graphql 3k.
Répartition ui-vel : components 172k · pages 130k · tests 113k · store 41k · services 17k · helpers 16k · utils 15k · plugins 12k · mixins 10k.

**Relire tout le code** coûte donc 200k tokens (reservation-tool) et 430k (ui-vel). Personne ne le fait, mais une feature moyenne en coûte déjà une bonne part :

| Feature (fichiers touchés par les commits du scope, hors tests, locales et md) | Fichiers | Tokens |
|---|---|---|
| reservation-tool `(complementary-products)` | 8 | 15k |
| reservation-tool `(chatbot)` | 7 | 6,6k |
| reservation-tool `(customer)` | 24 | 28k |
| reservation-tool `(booking)` | 83 | 102k (trop large, à découper) |
| reservation-tool double-session (12 fichiers du sujet) | 12 | 32k |
| ui-vel `(calendar)` | 19 | 53k |
| ui-vel `(basket)` | 24 | 100k |
| ui-vel `(restaurant)` | 36 | 103k |

Un commit touche en moyenne 5,5 à 6 fichiers (médiane 4 à 5, p90 13) : c'est le plancher incompressible, puisqu'il faut lire un fichier pour l'éditer. Tout ce qui est lu en plus sert à comprendre, et c'est cette part que le cache vise.

### 1.2 Constats qui pèsent sur la conception

1. **Les imports explicites ne suffisent pas.**
   - reservation-tool : 542 arêtes d'import résolues, mais aussi **140 usages de composables ou stores auto-importés** par Nuxt 3 (`useBookingStore()`, `usePlatform()` sans `import`) et 9 composants utilisés par balise sans import.
   - ui-vel : 502 imports, mais **909 usages Vuex par chaîne** (`$store.getters['booking/getDuration']`, `dispatch('calendarEntries/...')`, `mapGetters('booking', …)`) et **342 composants par balise** sans import (`components: true`).

   L'extracteur mécanique doit donc résoudre trois choses : les auto-imports Nuxt, les modules Vuex nommés par chaîne et les balises de composants.
2. **Des features toutes trouvées dans les commits.** Les deux dépôts suivent les conventional commits avec un scope :
   - reservation-tool : booking 40, ird 18, customer 10, pensioncanine 8, restaurant 7, es 6, chatbot 6…
   - ui-vel : calendar 30, completion 9, summary 7, shuttle 7, gtm 7, accommodations 7…

   Le scope, croisé avec les fichiers touchés et leur co-changement, donne une liste de features candidates **sans LLM**.
3. **Des liens vers le Back.** `services/offer.ts` appelle `POST /complementary-products (reservations-api)`, et `graphql/*.ts` déclare les opérations (`query allOffers`, `mutation saveBasket`) servies par `Back/graphql`. Le graphe peut porter un nœud « API externe » qui relie Front et Back (en v2).
4. **Des fichiers à exclure ou à résumer.** `generated/gql-types/graphql.ts` (types générés, énorme), le sous-module `libraries/nuxt-components-library`, `locales/*.json` et les images n'ont pas leur place dans le graphe. Ils y figurent au mieux comme nœuds « externes », sans contenu.
5. **Une connaissance déjà écrite à certains endroits** (`CLAUDE.md`, `docs/cheminement-payment.md`, `docs/PLATFORMS.md`). Ces documents deviennent des nœuds `doc` reliés aux fichiers qu'ils citent : on les signale au lieu de les réécrire.

---

## 2. Modèle du graphe

### 2.1 Nœuds

| Type (`k`) | Source | Exemple | Clé |
|---|---|---|---|
| `projet` | mécanique | front/reservation-tool | `front/reservation-tool` |
| `feature` | **LLM** (ou candidate mécanique) | complementary-products, double-session, panier | `f:complementary-products` |
| `route` | mécanique (pages/) | `/booking/offer`, `/orders/:id` | `r:/booking/offer` |
| `page` | mécanique | pages/booking/offer.vue | chemin |
| `composant` | mécanique | components/booking/BookingComplementaries.vue | chemin |
| `composable` | mécanique | composables/products/useComplementaryProducts.ts | chemin |
| `store` | mécanique (Pinia `defineStore`, module Vuex `store/x.ts`) | stores/booking/Booking.ts | chemin |
| `service` | mécanique | services/offer.ts | chemin |
| `gql` (opération) | mécanique (regex `query|mutation X` dans les gabarits gql) | `query allOffers` | `q:allOffers` |
| `api` (endpoint externe) | mécanique (URL littérale) puis LLM | `POST /complementary-products` → Back/reservations-api | `a:POST /complementary-products` |
| `type`, `util`/`helper`, `mixin`, `middleware`, `plugin`, `layout`, `config` | mécanique | utils/complementaryProducts.ts | chemin |
| `test` | mécanique | tests/unit/utils/complementaryProducts.spec.ts | chemin |
| `doc` | mécanique, résumé LLM facultatif | docs/PLATFORMS.md | chemin |
| `externe` | mécanique | sous-module, `generated/`, paquets npm | `x:~/generated/gql-types` |

On s'arrête au fichier : pas de nœud par fonction. Les exports (noms seulement) sont stockés en attribut. L'unité de lecture est le fichier, et c'est lui qu'on veut éviter de relire.

### 2.2 Arêtes

| Arête | Sens | Comment on la trouve |
|---|---|---|
| `importe` | fichier → fichier | `import … from`, `import()`, alias `~/` `@/` `~~/` et chemins relatifs, extensions .ts/.js/.vue/index |
| `rend` | page/composant → composant | import d'un `.vue` ou balise `<PascalCase>` / `<kebab-case>` résolue sur components/ (règle de préfixe de dossier Nuxt) |
| `utilise` | fichier → composable/store/util | auto-imports Nuxt 3 (nom exporté par composables/, utils/, stores/ puis appel `nom(`), Vuex par chaîne (`'module/…'`), `mixins: [...]` |
| `appelle` | service/store → gql ou api | identifiant importé depuis graphql/ (`mutationSaveBasket` → `q:saveBasket`), URL littérale `fetch`/axios |
| `sert` | route → page | arborescence pages/ |
| `garde` | middleware → route | `definePageMeta({ middleware })`, `*.global.ts` |
| `teste` | test → fichier | imports du test (spec → source) |
| `documente` | doc → fichier ou feature | chemins cités entre backticks dans le .md |
| `contient` | feature → fichier | **LLM** ou co-changement, avec un rôle : `entree`, `coeur`, `donnees`, `ui`, `test`, `peripherique` |
| `depend` | feature → feature | LLM |
| `sert-par` | api/gql → projet Back | v2 : relie Front et Back |

Chaque arête porte `src` (`meca` ou `llm`). Seules les arêtes `meca` sont recalculées automatiquement.

### 2.3 Attributs

**Fichier** :
- `k` : type ;
- `h` : hash du blob git, 12 premiers caractères, lu par `git ls-files -s`, **sans lire le fichier** ;
- `tok` : taille / 4 ;
- `exp` : noms exportés ;
- `out` : arêtes sortantes par type ;
- `sum` : une ligne écrite par le LLM, facultative, ≤ 120 caractères ;
- `vu` : date du dernier calcul.

**Feature** :
- `titre` et `alias` (mots-clés pour la recherche, scope des commits) ;
- `resume` : ≤ 600 caractères ;
- `flux` : étapes ordonnées ;
- `entrees` : routes et pages ;
- `fichiers` : chemin, rôle, hash au moment de l'apprentissage ;
- `pieges` : liste, chacun avec le fichier concerné ;
- `deps` ;
- `confiance` : 0 à 1 ;
- `source` : `build`, `flow:<id>` ou `manuel` ;
- `modele` ;
- `appris` : date, commit et branche ;
- `perime` : fichiers modifiés depuis l'apprentissage ;
- `usages` : nombre de fois servie, tokens évités cumulés.

### 2.4 Exemple JSON (extrait réaliste, reservation-tool)

```json
{
  "v": 1,
  "projet": {
    "cle": "front/reservation-tool",
    "racine": "C:/Users/lmalinge/Documents/Front/reservation-tool",
    "stack": "Nuxt 3 SPA, Vue 3 script setup, Pinia, Apollo (types generes dans generated/gql-types), Vuetify, vitest. Auto-imports Nuxt : composables/, utils/, stores/.",
    "conventions": "Plateforme fr|es via PLATFORM (docs/PLATFORMS.md). Commits conventionnels avec scope.",
    "indexe": { "commit": "4b3913e", "branche": "master", "le": "2026-10-14T09:12:00Z", "fichiers": 284, "tok": 253650 },
    "exclus": ["node_modules/", "dist/", ".nuxt/", ".output/", "generated/", "libraries/nuxt-components-library/", "locales/*.json", "public/"]
  },
  "fichiers": {
    "services/offer.ts": {
      "k": "service", "h": "7ee42e0d9c17", "tok": 1185,
      "exp": ["OfferService"],
      "out": { "importe": ["graphql/offers.ts", "utils/complementaryProducts.ts"], "appelle": ["q:allOffers", "a:POST /complementary-products"] },
      "sum": "Offres du rule engine (GraphQL) et produits complementaires (POST /complementary-products, reservations-api) remappes en Offer."
    },
    "utils/complementaryProducts.ts": {
      "k": "util", "h": "bb8961cc4d76", "tok": 3433,
      "exp": ["resolveText", "mapComplementaryProductsToOffers", "buildProductDates", "parseTagList"],
      "out": { "importe": ["x:~/generated/gql-types"] }
    },
    "stores/booking/Booking.ts": {
      "k": "store", "h": "5e296ca96f90", "tok": 5758,
      "exp": ["useBookingStore"],
      "out": { "importe": ["utils/complementaryProducts.ts", "services/offer.ts"] }
    },
    "components/booking/BookingComplementaries.vue": {
      "k": "composant", "h": "9f76bb1105a0", "tok": 416,
      "out": { "rend": ["components/booking/ComplementaryOfferCard.vue", "components/booking/ComplementarySessionOfferCard.vue", "components/booking/ComplementaryFilter.vue"], "importe": ["utils/booking.ts"] }
    },
    "tests/unit/utils/complementaryProducts.spec.ts": {
      "k": "test", "h": "2aa55968ff7a", "tok": 4367,
      "out": { "teste": ["utils/complementaryProducts.ts"] }
    }
  },
  "noeuds": {
    "r:/booking/offer": { "k": "route", "out": { "sert": ["pages/booking/offer.vue"] } },
    "q:allOffers": { "k": "gql", "def": "graphql/offers.ts", "out": { "sert-par": ["back/graphql"] } },
    "a:POST /complementary-products": { "k": "api", "out": { "sert-par": ["back/reservations-api"] } }
  },
  "features": {
    "complementary-products": {
      "titre": "Produits complementaires et transports (onglets du tunnel de reservation)",
      "alias": ["complementary-products", "complementaires", "navettes", "transferts", "taxe de sejour", "J-1", "SHUTTLE", "TRANSFERT"],
      "resume": "Les onglets Complementaires et Transports de /booking/offer chargent les produits Experticket via POST /complementary-products (reservations-api), filtres par tags de plateforme (nuxt.config PLATFORM_PRODUCT_TAGS, surchargeables par env), puis remappes au format Offer du rule engine pour reutiliser les cartes d'offre. Les dates proposees suivent les regles du rule engine (fenetre J-1 pour navettes, transferts et taxe de sejour).",
      "flux": [
        "pages/booking/offer.vue (onglet) -> useBookingStore().loadComplementary*",
        "stores/booking/Booking.ts -> services/offer.ts (POST /complementary-products, tags = complementaryProductsTags / transportProductsTags)",
        "utils/complementaryProducts.ts : mapComplementaryProductsToOffers + buildProductDates (J-1)",
        "components/booking/BookingComplementaries.vue -> ComplementaryOfferCard / ComplementarySessionOfferCard -> panier (stores/booking/Cart.ts)"
      ],
      "entrees": ["r:/booking/offer"],
      "fichiers": [
        { "p": "utils/complementaryProducts.ts", "role": "coeur", "h": "bb8961cc4d76" },
        { "p": "services/offer.ts", "role": "donnees", "h": "7ee42e0d9c17" },
        { "p": "stores/booking/Booking.ts", "role": "donnees", "h": "5e296ca96f90" },
        { "p": "components/booking/BookingComplementaries.vue", "role": "ui", "h": "9f76bb1105a0" },
        { "p": "tests/unit/utils/complementaryProducts.spec.ts", "role": "test", "h": "2aa55968ff7a" },
        { "p": "docs/PLATFORMS.md", "role": "peripherique", "h": "5f0eff3cf0db" }
      ],
      "pieges": [
        { "txt": "Le J-1 doit rester aligne sur le rule engine : navettes, transferts ET taxes de sejour (2 correctifs recents).", "p": "utils/complementaryProducts.ts" },
        { "txt": "En ES, les transports s'affichent dans l'onglet Complementaires (complementariesCount).", "p": "pages/booking/offer.vue" },
        { "txt": "TRANSPORTS_DISABLE : toute valeur non vide desactive, 'false' compris.", "p": "docs/PLATFORMS.md" },
        { "txt": "Les forfaits 2e chien ne sont plus des produits masques.", "p": "docs/PLATFORMS.md" }
      ],
      "deps": ["panier", "plateformes"],
      "confiance": 0.85,
      "source": "flow:1760432400000", "modele": "claude-opus-5-5",
      "appris": { "le": "2026-10-14T10:02:00Z", "commit": "4b3913e", "branche": "master" },
      "perime": [],
      "usages": { "servie": 3, "evites": 41200 }
    }
  },
  "candidates": [
    { "id": "booking", "commits": 40, "fichiers": 83, "tok": 102433, "note": "trop large : decouper (offres, panier, workers, etapes)" },
    { "id": "ird", "commits": 18 },
    { "id": "customer", "commits": 10, "fichiers": 24, "tok": 28467 }
  ],
  "stats": { "flows": 3, "servis": 4100, "evites": 41200 }
}
```

### 2.5 Où stocker le fichier

| Option | Avantages | Inconvénients |
|---|---|---|
| **A. `~/.claude/revo-flow/graphs/<front\|back>-<projet>.json`** (ex. `C:\Users\lmalinge\.claude\revo-flow\graphs\front-reservation-tool.json`) | Le dépôt n'est jamais touché : rien à ajouter au `.gitignore`, aucune MR polluée, c'est cohérent avec « ne modifie aucun projet ». Un seul dossier pour voir le graphe de n'importe quel projet (`/revo-flow cache <projet>`). La clé `front/back` évite la collision `Front/x` / `Back/x`. Le graphe suit les changements de branche grâce aux hash. | Pas de partage d'équipe. Perdu en changeant de poste. Il faut prévoir l'écriture concurrente entre plusieurs sessions. |
| **B. `<projet>/.revo-flow/graph.json`** | Le graphe voyage avec le code et peut se partager par git. | Il faut un `.gitignore` (donc modifier chaque projet). S'il est commité : conflits de merge sur un gros JSON, bruit dans les MR, des hash qui ne correspondent jamais à la branche du collègue, des résumés LLM non relus dans le dépôt. |

**Recommandation : A pour v1.**
- La couche mécanique n'a pas à être partagée : elle se régénère en 1 à 2 s.
- Seules les fiches de feature ont de la valeur pour l'équipe. En v2, `/revo-flow cache export <feature>` les écrit en **Markdown lisible** dans `<projet>/docs/` (ou `.revo-flow/features/*.md`), un fichier par feature et sans hash. Un humain les relit et les commite comme de la doc ; l'import, lui, recalcule les hash.
- Au passage, ces fiches enrichissent les `CLAUDE.md` et `docs/` qui existent déjà au lieu de leur faire concurrence.

Clé d'un projet hors Documents/Front|Back : slug du nom de la racine du dépôt + 6 caractères du hash du chemin.

### 2.6 Taille cible

| | reservation-tool | ui-vel |
|---|---|---|
| Nœuds fichiers (≈ 180 octets) | 284 → 50 Ko | 427 → 77 Ko |
| Arêtes (≈ 40 octets en liste d'adjacence) | ≈ 700 → 28 Ko | ≈ 1 200 → 48 Ko |
| Fiches (≈ 2,5 Ko) | 15 à 20 → 50 Ko | 20 à 25 → 60 Ko |
| **Total** | **≈ 130 Ko** | **≈ 190 Ko** |

Cibles :
- le fichier : < 300 Ko, avec un plafond dur de 1 Mo (au-delà, on élague les `sum` des fichiers puis les fiches jamais servies) ;
- une fiche servie : ≤ 1 500 tokens ;
- le brief injecté : ≤ 1 200 tokens ;
- une réponse de l'outil : ≤ 2 500 tokens.

Le store clé-valeur (4 Mio) ne garde que l'état du flow courant (fichiers servis, fichiers lus, compteurs). Le graphe et les statistiques cumulées vivent dans le fichier.

---

## 3. Construction et invalidation

### 3.1 Couche mécanique (plugin, sans LLM)

1. `git ls-files -s` donne la liste des fichiers et leur **hash de blob**, sans rien lire (mesuré : moins d'1 s avec `git status` sur Windows).
2. On filtre les exclusions (§2.4 `exclus`), puis on déduit le **type** du chemin : `pages/`, `components/`, `composables/`, `stores/` ou `store/`, `services/`, `graphql/`, `types/`, `utils/`, `helpers/`, `mixins/`, `middleware/`, `plugins/`, `layouts/`, `tests/` ou `*.spec.*`, `docs/*.md`. On détecte Nuxt 2 ou Nuxt 3 par `package.json` (`nuxt`/`nuxt-edge`) et par l'extension de `nuxt.config`.
3. On lit les fichiers à indexer (1 à 2 Mo de texte en local : aucun token consommé) et on applique les regex :
   - `import … from '…'`, `import('…')`, avec résolution des alias et extensions ;
   - **auto-imports Nuxt 3** : on fait la table des noms exportés par composables/, utils/ et stores/ (dont l'id `useXStore` de `defineStore`), puis on cherche les appels `nom(` ;
   - **Vuex par chaîne** (Nuxt 2) : `dispatch|commit('mod/…')`, `getters['mod/…']`, `map(State|Getters|Actions|Mutations)('mod'` → `store/mod.ts` ;
   - **balises de composants** `<PascalCase>` et `<kebab-case>`, résolues sur components/ avec la règle de préfixe de dossier ;
   - gabarits `gql` : `(query|mutation|subscription) Nom` donne un nœud `gql`. Un import de cette constante dans un service ou un store donne une arête `appelle` ;
   - URL littérales `fetch`/axios (`/complementary-products`) donnent un nœud `api` ;
   - pages/ donne les routes (Nuxt 3 `[id]`, Nuxt 2 `_id`) ; `definePageMeta({ middleware })` donne les gardes ;
   - docs : chemins cités entre backticks → `documente`.
4. **Features candidates** (sans LLM) : `git log -n 500 --pretty=%s --name-only` → scope du commit → fichiers touchés, pondérés par fréquence, puis regroupement par co-changement. Résultat : `candidates` avec nombre de commits, de fichiers et de tokens (le coût de construction estimé).

Durée : le prototype naïf met 1,4 s par projet ; une version propre tient sous 1 s. Pas de LLM, rien à confirmer.

Limites connues, qu'on assume et qu'on signale dans les réponses par « liste indicative » :
- `<component :is>`, `resolveComponent` ;
- provide/inject, bus d'événements ;
- `apollo: {}` en Options API ;
- `$platformConfig` injecté par plugin ;
- `this.$store` passé à un helper.

### 3.2 Couche « savoir » (LLM)

Deux chemins pour écrire une fiche de feature :

| | **Apprentissage en fin de flow** (chemin principal) | **Construction à la demande** `cache build <feature>` |
|---|---|---|
| Qui | L'orchestrateur, à l'étape 4 du LEAD_BRIEF | Un sous-agent **en arrière-plan** lancé par la commande : Sonnet medium par défaut, Haiku pour une feature de moins de 10k tokens |
| Entrée | Ce qu'il a déjà lu. revo-flow pré-remplit les fichiers lus et modifiés par tous les agents du flow (vu par le hook `tool.call`) | Le sous-graphe de la candidate : fichiers du scope + voisins à 1 saut, avec leur taille, plus les docs liées |
| Sortie | Appel `cache {action:"apprendre", feature, resume, flux, fichiers+role, pieges, corrections}` | Même appel, via le même outil |
| Coût | 1 à 2k tokens de sortie (≈ 0,02 à 0,04 €) | ≈ 0,15 à 0,25 € pour une feature de 15 à 30k tokens (§5) |

Règles :
- Une fiche **ne liste que des fichiers qui existent dans la couche mécanique** : l'outil rejette les chemins inconnus et le dit.
- Chaque fichier d'une fiche garde le hash vu au moment de l'apprentissage, ce qui permet de savoir précisément ce qui a changé depuis.
- `confiance` vaut 0,9 pour un apprentissage en fin de flow (fichiers réellement lus et modifiés), 0,75 pour une construction à la demande, 0,5 pour une candidate sans résumé.
- Une feature trop large (plus de 40k tokens, comme `booking`) est **découpée** par l'agent de construction en sous-features (offres, panier, workers, étapes), chacune avec sa fiche.
- Le sous-agent de construction doit être **exempté du refus « aucun agent avant le plan »** (`agent.spawn` refuse tout agent en phase planning). On le marque par son nom (`revo-flow-cache`) et le hook le laisse passer.

### 3.3 Fraîcheur, invalidation, incrémental

On vérifie au lancement de `/revo-flow`, à la commande `cache`, et à chaque appel de l'outil `cache` (au plus une fois toutes les 30 s) :

1. `git ls-files -s` + `git status --porcelain`, puis `git hash-object` sur les fichiers modifiés non commités, pour avoir le hash réel du disque.
2. On compare aux `h` stockés. Ce sont les **hash qui font foi, pas le commit** : ça marche même après un changement de branche, un rebase ou un `gc`, alors que `git diff <commit indexé>` échoue si le commit a disparu. Le commit indexé ne sert qu'à l'affichage (« indexé il y a 12 commits »).
3. Pour chaque fichier dont le hash a changé :
   - **ajouté ou modifié** : on recalcule son nœud et ses arêtes `meca`. Ça ne relit que ce fichier, sans LLM ;
   - **supprimé** : on retire le nœud et ses arêtes ;
   - **renommé** (statut `R` de `git diff --name-status -M`) : on met à jour le chemin dans les fiches.
4. Les **fiches ne sont jamais supprimées automatiquement**. Pour chaque fichier listé dont le hash diffère du hash appris, on ajoute une entrée à `perime` : `{p, depuis: <hash appris>, nouveau: <hash>}`. La confiance servie devient `confiance × (1 − tok_modifiés / tok_fiche)`.
5. Ce qui est servi dépend de la fraîcheur :
   - **fraîche** : la fiche entière ;
   - **partiellement périmée** (moins de 50 % des tokens modifiés) : la fiche, avec en tête « ⚠ modifiés depuis l'apprentissage : X, Y : relis ces fichiers avant de te fier au flux » ;
   - **très périmée** (50 % ou plus) : seulement la liste des fichiers, les points d'entrée et les pièges, marqués « à revérifier » ; le flux est masqué.
6. Le prochain `apprendre` sur la feature remet les hash à jour et vide `perime`.

Projets sans git : repli sur `mtime + taille` via `$.fs.stat`.

Écriture concurrente (deux sessions sur le même projet) : relire le fichier juste avant d'écrire, fusionner par feature (la dernière écriture gagne par feature, pas pour tout le fichier), puis écriture atomique (`.tmp` puis renommage). Un compteur `rev` détecte les écritures intercalées.

---

## 4. Usage par l'orchestrateur

### 4.1 Au lancement de `/revo-flow <demande>`

Dans `command.run`, avant `prompt.submit`, revo-flow enchaîne cinq étapes :

1. Il situe le projet (`projectOf(cwd)` ou le dépôt de la session).
2. Il charge le graphe et le rafraîchit (§3.3). S'il n'y a pas de graphe, il construit la couche mécanique tout de suite (< 2 s).
3. Il **associe la demande aux features** : normalisation (`slug`), puis score sur `alias` et `titre`, sur les noms de fichiers ou de routes cités, et sur les mots du scope. Le score suit une logique de type BM25 : un mot rare compte plus.
4. Il ajoute au `context` (à côté de `LEAD_BRIEF`) un **CACHE_BRIEF** d'au plus 1 200 tokens :

```
# Cache revo-flow — front/reservation-tool (indexé 4b3913e, 284 fichiers, 0 modifié)
Stack : Nuxt 3 SPA, Pinia, Apollo (generated/gql-types), auto-imports composables/ utils/ stores/. Plateformes fr|es (docs/PLATFORMS.md).
Features connues (fraîcheur) : complementary-products ✓ · double-session ✓ · panier ⚠2 · customer ✓ · chatbot ✓ · ird (candidate, sans fiche)
## Fiche probable : complementary-products (confiance 0,85, apprise le 14/10 en flow)
<résumé, flux, fichiers et rôles avec leur taille, pièges>
Outil mcp__revo-flow__cache : chercher (mots-clés), feature (id), voisins (chemin : qui l'utilise, ce qu'il utilise).
```

5. Si aucune feature ne dépasse le seuil, seules les 2 premières lignes et la liste des features partent (≈ 200 tokens).

### 4.2 L'outil `mcp__revo-flow__cache`

Il est enregistré dès `session.start` (et pas seulement au premier `/revo-flow`) pour que le sous-agent de construction et les sous-agents du flow y aient accès. Il est autorisé en phase planning et ses réponses sont **en texte compact, pas en JSON**.

| action | Entrée | Réponse |
|---|---|---|
| `chercher` | `requete` | Les 5 features et 8 fichiers les plus pertinents, une ligne chacun (type, taille en tokens, résumé d'une ligne, fraîcheur) |
| `feature` | `id` | La fiche (voir les règles de fraîcheur §3.3) |
| `voisins` | `chemin`, `profondeur` (1 par défaut, 2 au plus) | Ce que le fichier importe, rend, utilise et appelle, et qui l'utilise, avec les tests et les docs liés. Remplace les `grep -r useBookingStore` qui coûtent cher |
| `apprendre` | `feature`, `titre`, `alias`, `resume`, `flux[]`, `fichiers[{p, role}]`, `pieges[{txt, p}]`, `deps[]`, `corrections[]` | Accusé de réception, avec les chemins rejetés (inconnus) |
| `oublier` | `feature` | Accusé de réception |

`projet` est facultatif dans chaque action (projet courant par défaut), ce qui permet d'interroger un autre graphe : un agent Front peut demander `voisins` sur `back/graphql`.

### 4.3 Modification du LEAD_BRIEF (proposition de texte)

Changements par rapport au texte actuel, dans `hooks/lib.ts` (étapes 1 et 4, plus une ligne sur les sous-agents) :

> 1. Plan : **commence par le cache revo-flow ci-dessous (ou l'outil mcp__revo-flow__cache). S'il connaît la feature, fie-toi à sa fiche pour comprendre le flux et ne lis que les fichiers à modifier et ceux signalés « modifiés depuis l'apprentissage ». Le cache est une carte, pas la vérité : vérifie dans le code tout ce que tu vas affirmer ou changer.** Lis ensuite toi-même la demande et les specs utiles, seulement le nécessaire, sans rien modifier et sans lancer de sous-agent…
>
> 3. Exécution : … prompt = sa mission avec tout le contexte utile, **dont l'extrait de fiche du cache qui le concerne (fichiers, rôles, pièges) : il ne doit pas réexplorer ce que le cache sait déjà**…
>
> 4. Fin : quand tous ont fini, vérifie l'ensemble (tests et lint ciblés), corrige si besoin, **puis appelle mcp__revo-flow__cache action « apprendre » pour chaque feature touchée : résumé, flux, fichiers et rôles, pièges découverts, et corrections de ce que le cache disait de faux. revo-flow pré-remplit les fichiers lus et modifiés pendant le flow.** Conclus par une synthèse courte.

`agentBrief` reçoit une ligne : « Avant de chercher qui utilise un fichier (grep), essaie mcp__revo-flow__cache action voisins. »

`flowRecap` (réinjecté après compaction) reprend le CACHE_BRIEF en version courte : la liste des features, sans fiche.

### 4.4 Écriture en retour

- revo-flow tient pendant le flow la liste `lus` (Read réussis : chemin, tokens, par qui) et `modifies` (Edit/Write), via le hook `tool.call` existant (`markFile` sait déjà ce qui est édité).
- Quand la phase passe à `review`, la réponse du dernier agent rappelle à l'orchestrateur d'appeler `apprendre`, avec la liste pré-calculée de « fichiers du flow, regroupés par feature probable ».
- Si l'orchestrateur ne l'a pas fait quand le flow passe à `done`, revo-flow écrit lui-même une **fiche minimale mécanique** : fichiers et hash, sans résumé, `confiance` 0,5, `source: "flow-auto"`. Elle sert déjà à `chercher` et `voisins`.
- Les fichiers lus pendant le flow qui n'étaient **pas** dans la fiche servie y sont ajoutés avec le rôle `peripherique` : la fiche se complète d'elle-même.

### 4.5 Sous-commandes

| Commande | Effet |
|---|---|
| `/revo-flow cache` | Graphe du **projet courant** : texte au terminal (fichiers, arêtes, commit indexé, fichiers modifiés depuis, features avec fraîcheur et confiance, candidates avec coût estimé, gains cumulés) et ouverture de l'onglet « Graphe » du panneau (UI : autre agent) |
| `/revo-flow cache <projet>` | Même chose pour n'importe quel projet de Documents/Front ou Back (`reservation-tool`, `back/graphql`). S'il n'y a pas de graphe, il propose d'en construire un |
| `/revo-flow cache build` | Couche mécanique tout de suite, puis liste des candidates avec leur coût estimé. `build --top 5` ou `build --tout` déclenche les sous-agents de construction, après confirmation `$.ui.ask` avec le coût en € |
| `/revo-flow cache build <feature>` | Mécanique plus une fiche pour cette feature (sous-agent en arrière-plan, notification à la fin) |
| `/revo-flow cache clear [feature]` | Supprime le graphe du projet (ou une fiche), après confirmation |
| `/revo-flow cache <mot-clé>` | `chercher` : features et fichiers trouvés, puis la fiche si une seule feature ressort nettement |

**Collision de syntaxe** : « cache » est aussi un verbe (« cache le bouton panier en ES »).
- On ne traite `cache …` comme une sous-commande que si la suite fait au plus 3 mots, ou commence par `build`, `clear`, `export`, ou un nom de projet connu.
- Sinon, c'est une demande ordinaire.
- Alias sans ambiguïté : `/revo-flow graphe …`.

---

## 5. Économie de tokens

### 5.1 Scénario : correctif double-session sur reservation-tool

Exemple réel : commit c2532e4, 10 fichiers modifiés. Les fichiers du sujet pèsent 32k tokens : `Cart.ts` 11,1k, `Booking.ts` 5,8k, `useStockTimeline.ts` 4,3k, `offer.vue` 4,3k, `BookingOfferCard.vue` 2,9k, `utils/doubleSessionStock.ts` 1,3k, le reste moins de 0,7k.

| | Sans cache | Avec cache (fiche fraîche) |
|---|---|---|
| Orchestrateur (Opus) | grep `doubleSession` (13 fichiers) + lecture de 8 fichiers pour comprendre ≈ **25k** | brief + fiche ≈ **2,4k** + 1 ou 2 fichiers de vérification ≈ 2k |
| Agent « Front » (Sonnet) | réexplore : 7 fichiers ≈ **18k** | ne lit que ses fichiers à modifier (service, store, useStockTimeline, SessionSelector, BookingOfferCard) ≈ **8,3k** |
| Agent « Tests » (Sonnet) | 6 fichiers (specs + sources) ≈ **11k** | 3 specs + extrait de fiche ≈ **5k** |
| **Lecture de fichiers** | **≈ 54k** | **≈ 18k** |

Gain direct : **≈ 36k tokens lus en moins (≈ 65 %)**.

À cela s'ajoute l'**effet de traîne** : un fichier lu reste dans le contexte et repasse en lecture de cache (cacheRead) à chaque tour suivant. Le compteur de tokens de revo-flow inclut `cacheRead`, donc c'est ce chiffre-là qui bouge dans le panneau. Sur ce scénario :
- orchestrateur : 23k de moins × environ 30 tours restants ≈ 0,7 M de cacheRead évités ;
- agents : 16k de moins × environ 20 tours ≈ 0,3 M.

En € (tarifs de `lib.ts`) :

| Poste | Gain |
|---|---|
| Écritures de cache évitées (Opus 23k × 5 $/M + Sonnet 16k × 2,5 $/M) | ≈ 0,15 $ |
| Traîne (1 M × 0,2 $/M) | ≈ 0,20 $ |
| **Total** | **≈ 0,35 $ ≈ 0,32 € par flow** |

Avec un abonnement, le vrai gain est surtout sur la **fenêtre de 5 h** et sur le **contexte** : moins de compactions.

Ordres de grandeur selon la feature :

| Feature | Lecture sans cache | Avec cache | Gain direct |
|---|---|---|---|
| petite (chatbot 6,6k, complementary-products 15k) | 15 à 30k | 6 à 12k | 10 à 18k (≈ 55 %) |
| moyenne (customer 28k, double-session 32k) | 40 à 60k | 15 à 22k | 25 à 40k (≈ 60 %) |
| grosse ui-vel (basket 100k, restaurant 103k) | 80 à 150k | 25 à 45k | 55 à 100k (≈ 65 %) |
| feature inconnue du cache | identique | +200 tokens de brief | ≈ 0 (le flow l'apprend pour la prochaine fois) |

Le plancher reste les fichiers modifiés (médiane 4 à 5 par commit) : le cache n'économise rien sur un petit correctif dans un seul fichier déjà connu de l'utilisateur.

### 5.2 Coût de construction

| Mode | Coût |
|---|---|
| Couche mécanique | **0 token**, moins de 2 s |
| Apprentissage en fin de flow | 1 à 2k tokens de sortie Opus + une réponse d'outil ≈ **0,02 à 0,04 €** |
| `build <feature>` Sonnet, feature de 15 à 30k | environ 10 tours : écriture de cache ≈ 50k × 2,5 $/M + lectures ≈ 350k × 0,2 $/M + 2k de sortie × 10 $/M ≈ 0,22 $ ≈ **0,20 €** |
| `build <feature>` grosse feature découpée (booking 100k, basket ui-vel 100k) | ≈ **0,5 à 0,8 €** |
| `build --tout` reservation-tool (≈ 200k de code, 15 à 20 fiches) | ≈ **2 à 4 €** |
| `build --tout` ui-vel (≈ 430k) | ≈ **5 à 8 €** |

**ROI** :
- Une fiche construite à la demande (≈ 0,20 €) est rentabilisée dès la première réutilisation (≈ 0,3 € par flow).
- Une fiche apprise en fin de flow est rentable tout de suite.
- `build --tout` n'est **pas** recommandé : les scopes sont très concentrés (sur les 400 derniers commits, booking, ird et customer font environ 45 % des commits avec scope de reservation-tool ; calendar environ 20 % de ceux de ui-vel), si bien qu'une partie des fiches ne serait jamais servie.
- Stratégie conseillée : apprentissage en fin de flow plus `build --top 5` sur les scopes les plus actifs, soit environ 1 € par projet.

### 5.3 Mesurer les gains réels (données pour le panneau)

Dans le store clé-valeur, pour le flow courant :

- `servis` : pour chaque chemin servi par le cache (CACHE_BRIEF, `feature`, `voisins`), sa taille en tokens, la feature d'origine et sa fraîcheur ;
- `lus` : pour chaque chemin lu (hook `tool.call` sur Read réussi, par l'orchestrateur ou un agent du flow), sa taille en tokens, ajustée à `limit` × taille moyenne d'une ligne si le Read est partiel ;
- `injecte` : tokens du brief et des réponses de l'outil (caractères / 4).

Les indicateurs :

| Indicateur | Calcul |
|---|---|
| Tokens évités (direct, prudent) | somme des `tok` des fichiers **servis frais** et **non lus** pendant le flow. Un fichier compte **une seule fois**, même si 3 agents auraient pu le lire |
| Gain net | tokens évités − tokens injectés |
| Traîne estimée (affichée comme estimation) | tokens évités × nombre de tours restants de l'orchestrateur au moment où la fiche a été servie |
| Taux de complétude de la fiche | part des fichiers lus pendant le flow qui figuraient dans la fiche. S'il est bas, la fiche est incomplète (et se complète, §4.4) |

On le garde par projet, cumulé dans `stats` du fichier graphe (`flows`, `servis`, `evites`, `net`), et par fiche (`usages`). C'est cette dernière vue qui montre quelles fiches rapportent.

**Calibrer (lot 0)** : avant tout cache, enregistrer pendant quelques flows les tokens lus par flow et par projet. Ensuite, comparer la moyenne avec cache, et prévoir une option `cache: off` pour faire de l'A/B ponctuel. Le calcul « servis non lus » est un contrefactuel optimiste (il suppose que ces fichiers auraient été lus) : la baseline le corrige.

Contrat de données proposé pour l'agent UI, un atom `cacheStats` : `{ projet, features, fraiches, perimees, flow: { injecte, evites, net, completude }, cumul: { flows, evites, net } }`.

---

## 6. Risques

| Risque | Gravité | Parade |
|---|---|---|
| **Graphe périmé qui induit en erreur** (flux faux après un refactor) | haute | Vérification par hash à chaque usage (moins d'1 s). Fiche annotée avec les fichiers modifiés depuis. Flux masqué au-delà de 50 % de tokens modifiés. Phrase « le cache est une carte, pas la vérité » dans le brief. Il faut de toute façon lire un fichier pour l'éditer, donc une erreur se voit tôt |
| **Résumé LLM faux qui se perpétue** | haute | `confiance`, `source`, `modele` et date visibles. Chaque fin de flow peut corriger (`corrections`). Pièges rattachés à un fichier. Relecture humaine par `/revo-flow cache <feature>`. Export Markdown pour revue d'équipe (v2) |
| Coût de construction qui dérape (`build --tout`) | moyenne | Estimation en € avant confirmation. Chemin principal = apprentissage en fin de flow. Découpage des grosses features. Haiku pour les petites |
| Brief trop gros qui coûte plus qu'il ne rapporte | moyenne | Plafonds (1 200 / 1 500 / 2 500 tokens). Gain net mesuré. Brief réduit à 200 tokens sans correspondance |
| Arêtes manquantes (auto-imports, Vuex, `:is`, `apollo:{}`) | moyenne | Les trois résolveurs en v1. Mention « liste indicative » dans `voisins`. Le grep reste possible |
| Fichier corrompu ou écritures concurrentes | basse | Écriture atomique, `rev`, fusion par feature. Fichier illisible → reconstruction mécanique (on ne perd que les fiches ; garder un `.bak` du fichier précédent) |
| Sous-agent de construction refusé en phase planning | basse | Exemption par nom dans `agent.spawn` |
| « cache » pris pour une sous-commande alors que c'est une demande | basse | Grammaire stricte, alias `graphe` |
| Confidentialité (résumés de code dans `~/.claude`) | basse | Hors dépôt, local. Export vers le dépôt seulement explicite |
| Injection de prompt par un contenu du dépôt recopié dans une fiche | basse | Le brief présente les fiches comme des données. Résumés écrits par le modèle, pas copiés du code |

---

## 7. Découpage en lots

| Lot | Contenu | Valeur | Effort |
|---|---|---|---|
| **0. Mesurer d'abord** | Hook `tool.call` : tokens lus par flow et par projet (orchestrateur et agents), gardés dans `stats`. Rien d'autre | Baseline indispensable pour prouver le gain | ½ j |
| **1. Graphe mécanique (v1 minimale)** | Fichier `~/.claude/revo-flow/graphs/<clé>.json`. Indexeur (ls-files -s, types, imports et alias, **auto-imports Nuxt 3, Vuex par chaîne, balises de composants**, routes, opérations gql). Rafraîchissement par hash. Outil `cache` avec `chercher` et `voisins`. Commandes `cache`, `cache <projet>`, `cache clear` | Remplace les grep « qui utilise X » ; permet de voir le graphe de n'importe quel projet | 2 à 3 j |
| **2. Fiches apprises en fin de flow** | Action `apprendre` (validation des chemins, hash). LEAD_BRIEF étapes 1, 3 et 4. CACHE_BRIEF injecté au lancement avec correspondance par mots-clés. Pré-remplissage `lus`/`modifies`. Fiche minimale automatique. Marquage `perime`. Mesure des tokens évités et `cacheStats` pour le panneau | **L'essentiel du gain**, pour un coût de construction presque nul | 2 à 3 j |
| **3. Construction à la demande** | Candidates par scope et co-changement avec coût estimé. `cache build [feature]`, `--top N` avec sous-agent en arrière-plan, exemption `agent.spawn`, notification. `cache <mot-clé>`. Découpage des grosses features | Amorce un projet sans attendre les flows | 2 j |
| **4. v2** | Complétude automatique des fiches (fichiers lus hors fiche). Extraits de fiche injectés dans le prompt de chaque agent par revo-flow (pas seulement par l'orchestrateur). Liens Front ↔ Back (`gql`/`api` → `back/graphql`, `back/reservations-api`). Export et import Markdown pour l'équipe. Vue graphe dans le panneau. Décroissance de confiance avec l'âge. Option `cache: off` pour l'A/B | Fiabilité, partage, transverse | 4 à 6 j |

---

## 8. Questions ouvertes (tranchées le 2026-10-14, voir README.md : orchestrateur seul maître des extraits ; confirmation au lancement ; nom « cache »)

1. Faut-il que revo-flow passe **lui-même** l'extrait de fiche à chaque sous-agent (dans `agent.spawn`, comme `agentBrief`) plutôt que de compter sur l'orchestrateur ? C'est plus fiable, mais il faut savoir quelle partie de la fiche concerne quel agent (on peut rapprocher les fichiers cités dans ses tâches et son prompt).
2. Seuil de correspondance demande ↔ feature : faut-il demander confirmation à l'utilisateur (« Je pense qu'il s'agit de complementary-products : utiliser la fiche ? ») ou rester silencieux ? Proposition : silencieux, et la fiche servie est affichée dans le panneau.
3. Doit-on indexer `CLAUDE.md` et `.claude/rules` de ui-vel comme des docs, ou les laisser à Claude Code, qui les charge déjà ? Proposition : nœud `doc` sans résumé, jamais injecté.
4. Faut-il partager le graphe entre worktrees ? Même dépôt, même clé, mêmes hash : oui, naturellement.
