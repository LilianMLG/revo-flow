# Fiche API plugin - faisabilite "graphe de cache"
Source : .claude-plugin/types/claude-code/index.d.ts (16466 lignes, ecrit par Claude Code 2.1.299, EARLY ACCESS : l'API peut changer). Numeros = lignes de ce fichier.

## 1. $.fs : PARTIEL (OUI ecriture/lecture hors cwd ; NON glob, NON recursif, NON hash natif)
- L3273-3282 : "An absolute path is used as given; where one may go is an `fs.*` hook's to say. A read or write over 4 MiB rejects". OUI : ecriture hors cwd en chemin absolu possible (ex. <home>/.claude/revo-flow/graphs/x.json), sauf si un hook fs.* d'un autre plugin refuse (events fs.read/write/list/exists/stat/ancestors, L7141-7175). Chemin reseau rejete.
- `~` n'est PAS expanse (L3335-3336 le cite comme spelling non resolu). Home via `$.env.get("HOME")` (L3647-3657 ; sous Windows USERPROFILE ; `name` doit etre un litteral).
- `read(path, {as:"text"|"bytes"})` : texte UTF-8 ou `{ base64 }` ; rejette si absent ou > 4 MiB (L3287-3298).
- `write(path, text) => Promise<void>` : TEXTE seulement (pas d'ecriture binaire), cree les dossiers (L3300-3306). 4 MiB max.
- `list(path?) => FsEntry[]` : `{ name, kind:'file'|'dir'|'other', size, mtimeMs, isLink }` (L3308-3325 ; FsEntry L4996). Lien symbolique = `other` + isLink. Pas de glob ni recursion : lister dossier par dossier, ou `$.process.run(["git","ls-files"])`.
- `exists(path)` L3326-3330 ; `stat(path,{resolve})` -> `{kind,size,mtimeMs,isLink,realPath?}`, rejette ENOENT (L3331-3392). mtimeMs+size permettent une invalidation sans hash.
- `ancestors({names, of, below})` : lit des fichiers type CLAUDE.md dans les dossiers parents (L3394-3412). Inutile ici.
- Hash : OUI via Web Crypto. Globals (en-tete L16-22 ; declaration L15335-15350) : `crypto.subtle.digest(algorithm, data: ArrayBufferView|ArrayBuffer): Promise<ArrayBuffer>`, `crypto.randomUUID()`, `getRandomValues`, URL, TextEncoder, atob/btoa, structuredClone, performance.now. Pas de Node, pas de require, pas d'import(). Hash d'un fichier = fs.read({as:"bytes"}) -> base64 -> octets -> digest. Moins cher : git (`git ls-files -s`, `git hash-object`, `rev-parse HEAD:path`).

## 2. $.store / $.state : $.store OUI (confirme) ; $.state NON persistant
- `$.store` (L3410-3434) : "This plugin's own key-value store, kept between sessions and hot reloads; values are JSON data. A JSON file of the plugin's own under the user's Claude Code configuration directory." get/set/delete/keys. `set` rejette fonction, cycle, ou "a store over 4 MiB of JSON text in all" (L3423) : 4 MiB TOTAL pour tout le plugin, global, pas par projet. register.tsx y stocke deja `day:` / `week:` (L211-216).
- `$.state` (L3436-3470) : valeurs nommees tenues par l'hote "for the session", survivent au hot reload du code ; "Persist through `$.store`" -> PAS persistant entre sessions. Sert au rendu reactif (un get dans ui.render abonne le rendu).
- Conclusion : le cache durable multi-projets = fichiers via `$.fs.write` en chemin absolu (4 MiB par fichier, pas de total) ; `$.store` seulement pour un petit index.

## 3. $.tool.register : OUI
- `register(tool: ToolSpec) => Promise<{tool}>` (L3094-3110). ToolSpec L13569-13593 : `name` (lettres/chiffres/_/-, <=64), `description`, `inputSchema` (defaut `{type:"object"}`), `isDeferred?: boolean`. Outil = `mcp__<plugin>__<name>` des le prompt suivant ; rejette tant que la session n'est pas liee (appeler a session.start).
- Reponse : `on('tool.call', { tool: 'mcp__revo-flow__x' }, ...)` ; "a call no hook answers fails" (L3100-3101). Retour `{ result }` ou `{ deny: string }` (ToolCallResult L13152-13200), plus `context?: readonly string[]` optionnel (texte cache apres le resultat).
- Forme dans register.tsx : outil `plan` declare L140-182, servi L774-811 : `return { result: dispatchText(plan) as never }` / `{ deny: '...' }` (result = string castee `as never`). `step` : L184-199 / L813+. `e.agentId` distingue orchestrateur (undefined) et sous-agent (L777).
- `isDeferred` : OUI (L13581-13593 : false = schema dans la liste de prompt, true = derriere ToolSearch ; omis = deferred comme un outil MCP). plan/step sont `isDeferred: false`. `tool.describe` peut aussi le changer (L13395-13400).
- Budget de hook 10 s (HookBudget.ms L5182-5186) mais le temps d'un appel `$.*` en vol ne compte pas (L5173-5178) : fs/process/model.complete longs OK.

## 4. $.agent.spawn : PARTIEL (pas d'effort ni de tools au spawn)
- `spawn: EventCalls['agent']['spawn']` (L3228-3240). Entree `AgentSpawnArgs` (L245-251) = `prompt` (requis) + Partial<`description`, `subagentType`, `model`, `name`, `cwd`>. PAS de `effort`, PAS de `tools`, PAS de `background` en argument.
- `model` : alias (haiku) ou id complet. `subagentType` : general-purpose, Explore, ou `<plugin>:<name>` d'un agent enregistre.
- Pour effort/tools/permissionMode/maxTurns/isolation/omitClaudeMd : `$.agent.register(spec: AgentSpec)` (L3244-3270 ; AgentSpec L460-535) : name, description, prompt, tools[], disallowedTools[], model, `effort` ('low'|'medium'|'high'|'xhigh'|'max' ou entier), permissionMode, maxTurns, skills, memory, background:true, omitClaudeMd:true, isolation. Type nomme `<plugin>:<name>` ; masquable au modele par `on("agent.offer",{agent:"revo-flow:x"},()=>({isOffered:false}))` (exemple L3258-3264).
- Retour : `{ model, agentId }` ou `{ deny }` une fois le sous-agent DEMARRE (L415-451) ; il tourne en arriere-plan (L248-250).
- Resultat final : evenement `turn.complete` avec `e.agentId` ; `e.answer` = texte final (L13719-13726). Pas d'evenement `agent.end`/`agent.complete`. Motif documente (L429-433) : `on("turn.complete",($,e,next)=>(got[e.agentId]?.(e.answer),next(e)))`. Aussi `$.session.messages({agentId})` (L2767-2800, 4096 derniers messages ou `{deny}`) et `$.agent.list()` (statut, L3237-3248).
- ALTERNATIVE : `$.model.complete({ model:"haiku", prompt, system?, maxTokens (defaut 1024, <=64000), effort, timeoutMs }, {signal})` (L2615-2660 ; request L6285-6340) -> `{ isAnswered, text, usage }` ou `{ reason }`. Sans outils ni historique, via les credentials de la session : parfait pour resumer un fichier fourni ; pas pour explorer le depot (agent requis, il a Read/Grep).

## 5. Injection de contexte invisible : OUI (mais pas via $.prompt.submit)
- `command.run` : retour `{ text?, context?: readonly string[], exitCode? }` (CommandRunResult L1863-1895). `context` = "what the model reads after the command's output and the person never sees, each entry one hidden user message". Utilise register.tsx L620-623 : `return { text, context: [LEAD_BRIEF] }`.
- `$.prompt.submit` (L2984-2996) : PromptSubmitArgs = `Omit<..., 'origin'|'turnId'|'wait'|'context'|'command'|'isMeta'>` (L9204) : PAS de `context` en argument ; `{ text, asUser: true }`. register.tsx L624 l'appelle dans `$.clock.after(0, ...)`.
- Hook `prompt.submit` sans commande : OUI (L9271-9300) : "A hook attaches on the way down: `next({ ...e, context: [...(e.context ?? []), mine] })` ... none empty, any length: past 100,000 characters (200,000 together) the model reads a head and path". Donc `on('prompt.submit',($,e,next)=>next({...e,context:[bloc]}))` injecte le cache a chaque prompt (filtrer e.command, e.isMeta, e.origin).
- Autres points : `prompt.section` (section du system prompt, L9177-9215, `{text|null}`), `prompt.context` (blocs du 1er message, L8569-8620 ; la doc renvoie a `instructionFiles` ou au `context` de prompt.submit pour du texte changeant), `agent.spawn` peut reecrire `prompt` (L255-259), `tool.call` result accepte `context`. `turn.start` (L13834-13870) : resultat `{ turnId }` seul -> PAS d'injection la.
- Variante lazy : un outil `mcp__revo-flow__cache` renvoie le sous-graphe a la demande.

## 6. Projet courant et invalidation : PARTIEL
- `$.session.root()` (L2810-2815) : racine projet absolue (demarrage, ou /cd, worktree ; un cd shell ne la deplace pas). `$.session.cwd` est une FONCTION async `cwd()` (L2801-2807), pas une propriete. `$.session.repo()` (L2829-2836) -> `SessionRepo|null` = `{ root (arbre principal pour un worktree), remote, internal, name }` (L11776-11803) : cle projet stable = repo.remote / repo.name / root. register.tsx L133-137 l'utilise deja.
- Invalidation : OUI partielle via `on('tool.call')` sur Edit/Write/NotebookEdit (`e.file_path` / `notebook_path`) comme register.tsx L822-830. Ne voit que les edits faits par les outils (orchestrateur et sous-agents, `e.agentId`), PAS les modifs externes ni Bash (sed, git checkout). Pas d'evenement fs.changed pour `on()` ; `FileChanged`/`watchPaths` (L1335, L4891) existent seulement cote hooks classiques settings.json (non verifie plus loin).
- Robuste : au debut du plan, comparer `git rev-parse HEAD` et `git diff --name-only <sha_cache>` / `git status --porcelain`, ou fs.stat mtime/size.

## 7. $.process.run : OUI
- `run(argv: readonly string[], init?)` (L3557-3574) : argv direct, pas de shell ; init `{ cwd, env, stdin, timeoutMs }` (ProcessRunInit L8098-8117) ; timeout 30 s par defaut, 10 min max ; resultat `{ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }`, chaque flux tronque a 4 194 304 octets (L8125-8153). "Git runs with repo hooks off" (L3564). "CLI only" (L3552). Rejette si le process ne demarre pas ou tourne encore au timeout.
- git ls-files / log / diff --name-only / rev-parse : tous faisables. Sur gros depot, verifier isStdoutTruncated (ou paginer par pathspec). Streaming : `$.process.spawn({argv,cwd})` (L3585-3600).
- En test (`claude plugin test`) : "no fs, network or process" (L36-37) -> mocks.

## 8. $.ui : PARTIEL (pas d'arbre/pliable/table natifs)
- Texte long : OUI. `command.run` -> `{ text }` (ligne de transcript) ; `$.ui.log` (L2440) ; toast/status limites a 2000 car. (L2503).
- Pane dedie : OUI, `$.ui.open({id,title,focus,closeOnEscape,holdToasts,rows,columns})` (L2526 ; PaneOpenArgs L7485+), dessine par hook `ui.render` sur `{component:"Pane"}` ; un pane par id.
- `$.ui.ask(question, options)` (L2456) : 2-4 labels ou `{options, header, multiSelect}` ; rejette en -p.
- Elements (L3865-3950) : terminal = Box, Text, Button, Input, Select, Link, Code, Markdown, Client, Raster, Image (PAS de Svg) ; desktop = Box, Text, Button, Input, Select, Svg, Link, Code, Markdown, Client ; mobile sans Input/Select ; vscode ~ desktop. Grep Tree / Collapsible / Accordion / Table / Disclosure : AUCUN element de ce nom (`isExpanded` L10069/10259 = props de lignes du transcript, pas des widgets). Arbre pliable = a construire avec Box/Text/Button + etat ($.state, ou setState d'instance L1583) ; graphe visuel = `Svg` desktop seulement (source <= 131072 car., `alt` requis, interactive hover sans script, L12687-12712), `Image` terminal (base64 <= 2 MiB, L5423), sinon ASCII/Markdown. `Client` (module de surface) pour une interaction riche.
- `Markdown` dispo partout, liens pressables (`onLinkPress`, L8022, L14675+).

## 9. $.clock.every / fond : OUI avec precautions
- `after(ms, fn)` / `every(ms, fn)` -> Timer avec `cancel()` (L3513-3524 ; TimerCall L13077 `(ms, fn: () => void) => Timer`) ; `sleep(ms,{signal})`. register.tsx utilise `after(0, ...)` (L624). Chaque periode passe par un dispatch ; "a refused period ends the interval".
- Indexage : serie de `$.fs`/`$.process`/`$.model.complete` par petits lots depuis un `void` async, annulable (AbortController -> model.complete). Le budget 10 s ne compte pas les `$.*` en vol, mais le JS pur long oui. Persistance des timers entre sessions : rien dans les typings (supposer non).
- Vraie tache de fond : `$.agent.spawn` (arriere-plan, L248-250) d'un agent haiku `background`/`omitClaudeMd`, resultat via turn.complete.

## Synthese
- Stockage : fichiers JSON absolus par projet (4 MiB/fichier) + `$.store` (petit index, 4 MiB total partage).
- Fraicheur : git (rev-parse/diff/ls-files -s) ou fs.stat ; `crypto.subtle.digest` dispo.
- Consultation : outil `mcp__revo-flow__cache` (isDeferred:false) servi par `tool.call` -> `{result}` et/ou hook `prompt.submit` avec `context`.
- Construction : `/revo-flow cache ...` (command.run) + `$.model.complete` (haiku) ou agent enregistre `revo-flow:indexer` (haiku, effort low, tools Read/Grep/Glob) spawne en fond.
- Affichage : pane + Markdown/Box/Button ; pas de Tree natif ; Svg desktop uniquement.
- Risques : API early access ; hooks fs.* d'autres plugins pouvant refuser une ecriture hors cwd ; pas d'evenement de modification hors outils Claude.
