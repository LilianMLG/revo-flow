# Fiche UI - graphe de cache dans revo-flow

## 1. Éléments UI disponibles (.claude-plugin/types/claude-code/index.d.ts)

Tables par surface : `Elements` l.3866-3944.

| Surface | Éléments |
|---|---|
| terminal (l.3873) | Box, Text, Button, Input, Select, Link, Code, Markdown, Client, Raster, Image. **Pas de Svg** |
| desktop (l.3898) / vscode (l.3933) | Box, Text, Button, Input, Select, **Svg**, Link, Code, Markdown, Client (pas Client sur vscode) |
| mobile (l.3916) | Box, Text, Button, **Svg**, Link, Code, Markdown. Pas d'Input/Select, pas de Client |

Props utiles :
- BoxProps l.921 : flex (direction, grow, shrink, wrap, align, justify), gap, width/height (nombre ou %), margin/padding, borderStyle/borderColor, backgroundColor, overflow, display none|flex, position absolute + top/left/right/bottom (cellules), key + hover (style au survol, sans aller-retour plugin).
- TextProps l.12978 : color, backgroundColor, dimColor, size (caption..title, ignoré en terminal), weight, mono, tabular, bold/italic/underline/strikethrough/inverse.
- ButtonProps l.1086 : key, label ou enfants (strings + Text), hotkey (1 chiffre/lettre), action, plain (rendu "1: label" en terminal), onPress.
- SvgProps l.12687 : source (max 131072 car.), alt obligatoire, width, height, isInteractive (iframe sans script : :hover CSS, SMIL, infobulles `<title>` ; aucun clic).
- MarkdownProps l.5783 : text (max 100000), dimColor, onLinkPress (+ key) : liens cliquables qui rappellent le plugin.
- CodeProps l.1652 ; LinkProps l.5727 (href, label) ; InputProps l.5552 ; SelectProps l.10739 (desktop/terminal/vscode seulement) ; ClientProps l.1525 (module à état local, desktop/terminal, pas mobile).

**Aucun élément arbre / liste / tableau / pliable / onglet / barre de progression natif.** Tout se compose : Box+Text (terminal), Svg (desktop/mobile), `bar()` (hooks/lib.ts:369, blocs pleins/légers).

## 2. Existant à réutiliser

hooks/views.tsx :
- bandModel l.201 ; DesktopBand l.223 (Svg barSvg, options context + lastPrompt) ; TerminalBand l.249 (cadre round ; ligne 1 titre, étape, bar(pct,10), "n actifs" ; ligne 2 dim "Dernier prompt : ..." à gauche et `ctx NN %` à droite, orange >=70, rouge >=85) ; MobileBand l.304 = DesktopBand.
- TerminalTurnLine l.284 : ligne dim `durée · in · out · cache · coût · modèle`.
- DesktopPane l.325, ordre : en-tête (titre/projet/branche + pastille) > résumé > Tout arrêter > plan à valider > AGENTS (cartes) > FICHIERS MODIFIÉS (6 derniers) > pied CONSOMMATION (Session, Contexte, Semaine via usageRowSvg, seuils 70/85). Sections = sectionSvg(gauche, droite, w) ; vide = emptySvg ; séparateur ruleSvg. MobilePane l.542 = DesktopPane.
- TerminalPane l.550 : titre, plan, cartes agents (nom + modèle coloré, segments, "Σ usage"), "Fichiers modifiés · n" (3 derniers), jauges gauge() l.612 (label 9 car. + bar(.,10) + valeur + %).
- Couleurs (hooks/art.ts:6+) : haiku #7FB3C8, sonnet #B9A6E0, opus #E2C27A, live #4ADE80, orange #F0A03C, red #F0524F / redText #FF8A86, silver, muted, card, border.
- Hooks de rendu register.tsx : AbovePrompt l.889, Pane (id "revo-flow") l.901, TurnDuration l.915 (terminal seulement). Commande : enregistrement l.538 (argumentHint '<demande> | statut | panneau | stop'), command.run juste après ; renvoie `{ text }` (statusText).

## 3. Maquettes

### 3.1 Terminal : section "Cache" dans le panneau (après Fichiers modifiés, avant les jauges)
```
Cache · reservation-tool                        12 nœuds · 1 périmé
  Pages 3 · Composants 4 · Composables 2 · Stores 1 · Services 2
  ● Booking (feature)        <- Orchestrateur      2 fichiers
  ● useCart (composable)     <- Front              1 fichier
  ○ CartStore (store)        frais
  ⚠ PaymentService (service) périmé, modifié il y a 2 j
  Gain   ████████░░  ≈ 18k tokens évités (sur ≈ 26k)
  Coût   construction 7,4k tokens · 0,09 € · rentabilisé x2,4
```
Légende : ● hit du flow en cours (couleur de l'agent consommateur, colorOf), ○ muted = frais non utilisé, ⚠ orange (PALETTE.orange) = périmé, ✕ rouge = échec de build. Même grammaire que icon() l.561.

Vue arbre (par feature, 2 niveaux) :
```
▾ Booking (feature)                    ● 3 hits
  ├ BookingPage (page)                 ○ frais
  ├ BookingForm (composant)            ⚠ périmé
  └ useBooking (composable)            ● frais
      └─ appelle BookingApi (service)  ○ frais
▸ Paiement (feature)          5 nœuds
```
Vue liste par type : en-têtes "Pages 3", etc., puis lignes. ▾/▸ = Button plain dont onPress bascule un état. Arêtes : seulement en suffixe texte ("→ BookingApi, useCart") tronqué (wrap="truncate-end").

### 3.2 Terminal : bande (TerminalBand), ligne 3 dim si le graphe n'est pas vide
```
cache : 12 nœuds · 3 utilisés · ≈ 18k tokens évités                 ⚠ 1 périmé
```
"12 nœuds" dim, "3 utilisés" silver, "≈ 18k tokens évités" en PALETTE.live ; "⚠ 1 périmé" orange à droite (même Box justifyContent space-between que ctx). Étroit (<70 col) : `cache : 12 · 3 ✓ · ≈18k`. Pendant la construction : `cache : construction 7/12 nœuds · 3k tokens`.
Attention vocabulaire : la bande dit déjà "cache" pour cacheRead+cacheWrite (prompt cache API : "40k cache"). Libellé suggéré : "graphe" ou "mémoire projet" (`graphe : 12 nœuds · ...`), ou renommer l'existant en "cache API".

### 3.3 Terminal : ligne de fin de tour (TurnDuration, terminal seulement)
Aujourd'hui : `⏱ 12s · 3k in · 1k out · 40k cache · 0,12 € · Sonnet`.
Proposition : segment ajouté seulement s'il y a eu des hits pendant le tour :
`⏱ 12s · 3k in · 1k out · 40k cache · 0,12 € · Sonnet · graphe 3 hits ≈ -18k`
Ligne dim unique truncate-end : le segment, en dernier, est coupé en premier ; le placer avant le modèle si on y tient. Toujours "≈" : estimation, jamais mesure.

### 3.4 Desktop / mobile : composants (Svg, même style que sectionSvg / usageRowSvg)
Dans DesktopPane (MobilePane en hérite) : `sectionSvg('CACHE', '12 nœuds · 1 périmé', inner)` entre FICHIERS MODIFIÉS et le pied CONSOMMATION.
1. Bandeau chiffres (nouveau cacheSummarySvg, ~44 px) : 3 tuiles "12 nœuds" (silver), "3 utilisés" (live), "≈ 18k évités" (live) ; badge orange "1 périmé".
2. Répartition par type : barres fines (gabarit usageRowSvg, rect 4 px) Pages 3 / Composants 4 / ... ; part périmée en orange.
3. Liste/arbre : un Svg par ligne comme fileRowSvg : pastille d'état (couleur de l'agent si hit, silver si frais, orange si périmé), nom mono, type muted à droite, 2e ligne = résumé tronqué, fond PALETTE.card. ~8 lignes max puis Button "tout voir" (comme slice(-6) des fichiers).
4. Gains dans le pied CONSOMMATION : une rangée usageRowSvg({label:'Cache graphe', value:'≈ 18k évités', note:'coût 7,4k', percent: économisé/(économisé+dépensé)}). C'est une part, pas un seuil : warnAt [101,101] pour neutraliser orange/rouge, ou variante verte.
5. Infobulle : Svg isInteractive + `<title>` par nœud (résumé complet, fichiers, date). Pas de clic dans un Svg.
6. Bande desktop/mobile : barSvg a déjà context et lastPrompt ; ajouter une option `cache: '12 nœuds · 3 utilisés · ≈ 18k évités'` (petit texte muted/vert) sous le dernier prompt. Mobile = même Svg : version courte `12 · 3 ✓ · ≈18k` (~340 px).
7. Mobile : pas de Client ni Select, donc pas de filtre par type : seulement des Button qui basculent un état.

## 4. Où insérer la section "Cache" ?

Recommandation : section fixe entre FICHIERS MODIFIÉS et CONSOMMATION, repliable par Button, repliée par défaut hors flow (en-tête + ligne de gains), dépliée automatiquement pendant un flow avec des hits. Le cache est un contexte du plan (comme les fichiers) et ses gains une consommation (pied).
- Pliable : pas d'élément natif ; Button plain ("▾ Cache" / "▸ Cache") dont onPress bascule un atom (update($, cacheOpenA, ...)) puis le Pane se redessine, comme actions.clear(). Pas besoin de Client (absent du mobile).
- Onglets : non natifs ; simulables par une rangée de Button (Agents | Fichiers | Cache) mais cela cache les agents pendant un flow : à éviter. Option : second panneau `$.ui.open({ id: 'revo-flow-cache', title: 'revo-flow · cache' })` (un id par panneau, d.ts l.2508) pour le graphe complet, le pane principal ne gardant que résumé + gains. Placé à partir de 144 colonnes sauf demande explicite (commande/prompt, d.ts l.2509-2510).
- Sous les agents : seuls les hits du flow y gagnent : ajouter une ligne `line()` de type detail dans agentCard ("↳ cache : Booking, useCart (≈ 4k évités)"), sans nouvelle section.

## 5. Commande `/revo-flow cache [projet]`

Deux sorties, cumulables :
- Retour texte (`{ text }` comme statusText) : chaîne multi-lignes, pas de Box/Text. Garder <= ~60 lignes, tronquer ("... et 14 autres nœuds, /revo-flow cache <projet> --tout"). Gabarit :
```
Graphe de cache · reservation-tool (12 nœuds · 1 périmé · maj il y a 2 h)
Features (2)
  Booking : réservation d'un créneau · 4 fichiers · frais
    pages : BookingPage · composants : BookingForm ⚠ périmé
Services (2)
  PaymentService ⚠ périmé : modifié il y a 2 j
Gains · ≈ 18k tokens évités · construction 7,4k tokens (0,09 €) · x2,4
```
- Ouverture du panneau : même mécanique que `panneau` (openPane, register.tsx l.345) avec la section Cache dépliée (atom) ; réponse courte "revo-flow : graphe affiché dans le panneau." Si non placé (isPlaced false) : retomber sur le texte long.
- [projet] absent = projet courant (flow.project). Mettre à jour argumentHint : '<demande> | statut | panneau | stop | cache [projet]'. command.run traite tout argument inconnu comme une demande de flow : tester `cache` avant (comme statut) ; une vraie demande commençant par "cache ..." serait avalée : exiger le mot seul ou suivi d'un nom de projet connu.

## 6. Ce qui n'est PAS possible

- Vrai graphe nœuds/arêtes interactif : ni canvas, ni layout, ni clic/drag/zoom ; un Svg isInteractive est sans script (pas de callback plugin). Un Svg statique calculé par le plugin (colonnes par type, courbes) est faisable en desktop/mobile (max 131072 car., alt obligatoire) mais le layout est à écrire à la main, et rien de tel en terminal.
- Terminal : pas de Svg ; Raster/Image existent mais pas pour du dessin vectoriel. Seul le box-drawing : arbre ou liste "→" ; arêtes croisées et cycles non représentables.
- Pas d'arbre, table, liste virtualisée, scroll interne, onglets, accordéon : tout est simulé ; au-delà de ~30 nœuds le Pane devient très haut : pagination par Button obligatoire.
- Clic sur un nœud pour ouvrir un fichier : seulement Link (href) ou Button ; href restreint à https: sur surfaces distantes (d.ts l.5727).
- Mobile : pas d'Input/Select (pas de filtre ni recherche), pas de Client.
- TurnDuration n'existe que sur terminal : desktop/mobile n'ont pas de ligne de fin de tour ; les tokens évités du tour passent par la bande ou la carte de l'orchestrateur.
- Pas de hover en terminal pour afficher le résumé complet : prévoir `/revo-flow cache <nœud>`.
- Les tokens évités sont une estimation : "≈" partout ; pas de mesure exacte.
- L'état doit vivre dans des atoms lus par viewData (comme flowA, lastTurnA) pour que Pane/Band se redessinent.

## 7. Impacts de code (indicatif, rien n'a été modifié)
- ViewData (views.tsx:41) : +cache?: { project, nodes[], hits[], savedTokens, buildTokens, buildUsd, isBuilding }.
- art.ts : +cacheSummarySvg, +cacheNodeRowSvg, option `cache` de barSvg.
- views.tsx : +cacheLine(d) (texte partagé : bande terminal, TurnLine, commande), section dans DesktopPane/TerminalPane, ligne de hits dans agentCard.
- register.tsx : atoms (cache, cacheOpenA), branche `cache` dans command.run, argumentHint ; les hooks ui.render n'ont pas à changer.