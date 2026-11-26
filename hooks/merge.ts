/**
 * La garde anti-merge (v3.2, docs/rd-v3/README.md §3 ter) : une commande Bash ou PowerShell de Claude qui fusionnerait une PR
 * ou une MR, armerait l'auto-merge, ou pousserait sur une branche protégée est refusée. Le merge reste à l'utilisateur.
 * Au mieux : une commande détournée peut passer ; la vraie garantie est la protection de branche côté serveur.
 * Un push doit nommer sa branche de destination : `git push`, `git push origin` ou `git push origin HEAD` dépendent du
 * dossier où tourne le shell, de push.default et de l'amont, que la garde ne peut pas lire sûrement ; ils sont refusés.
 * Logique pure, sans aucune référence à `$` : la branche par défaut est lue par l'appelant, dans le dossier que donne
 * dossiersDuPush. mergeDenial tourne dans le hook tool.call : elle ne lève jamais, et refuse par prudence si son analyse échoue.
 */

/** Ce que l'appelant sait : la branche par défaut (origin/HEAD) si git a répondu, et le shell de l'outil (Bash par défaut). */
export type MergeContexte = { defaut?: string; shell?: 'bash' | 'powershell' }

/** Les branches protégées sans même connaître la branche par défaut. */
const TOUJOURS_PROTEGEES = ['main', 'master']

/**
 * Les programmes qui en lancent un autre : on regarde ce qui les suit. Pour chacun, ses options qui prennent une valeur
 * séparée (`sudo -u moi`, `xargs -n 1`), et le nombre d'arguments avant la commande (la durée de `timeout`).
 */
const ENVELOPPES = new Map<string, { valeur?: string[]; avant?: number }>([
  ['sudo', { valeur: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir', '--other-user'] }],
  ['doas', { valeur: ['-u', '-C'] }],
  ['env', { valeur: ['-u', '-C', '--unset', '--chdir'] }],
  ['command', {}],
  ['builtin', {}],
  ['exec', { valeur: ['-a'] }],
  ['nohup', {}],
  ['time', { valeur: ['-f', '-o', '--format', '--output'] }],
  ['nice', { valeur: ['-n', '--adjustment'] }],
  ['ionice', { valeur: ['-c', '-n', '-p', '--class', '--classdata'] }],
  ['xargs', { valeur: ['-n', '-L', '-P', '-I', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--max-lines', '--delimiter', '--arg-file', '--replace', '--eof'] }],
  ['timeout', { valeur: ['-s', '-k', '--signal', '--kill-after'], avant: 1 }],
  ['gtimeout', { valeur: ['-s', '-k', '--signal', '--kill-after'], avant: 1 }],
  ['stdbuf', { valeur: ['-i', '-o', '-e'] }],
  ['caffeinate', { valeur: ['-t', '-w'] }],
  ['chronic', {}],
  ['unbuffer', {}],
])
/** Les shells dont le -c (ou -Command) porte une commande à analyser à son tour, et qui exécutent ce qu'ils lisent sur stdin. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell'])
const PROFONDEUR_MAX = 4

// ── Lecture de la commande ───────────────────────────────────────────────

/** Ce qu'une commande contient : ses segments en mots, les commandes substituées dans du texte, ses heredocs et here-strings. */
type Lecture = {
  segments: string[][]
  /** Les `$(…)` et `` `…` `` trouvés entre guillemets doubles : le shell les exécute. */
  internes: string[]
  /** Chaque heredoc (ou here-string) : son corps, si son marqueur est cité ('EOF'), et les segments de sa ligne (qui le lit). */
  heredocs: { corps: string; cite: boolean; ligne: string[][] }[]
}

/** Les caractères qu'un antislash hors guillemets échappe (bash). Devant un autre, il reste tel quel (chemin Windows, `\gh`). */
const ECHAPPES = new Set([' ', '\t', ';', '&', '|', '"', "'", '$', '`', '(', ')', '<', '>', '\\', '*', '?', '#', '!', '{', '}', '[', ']', '~'])
/** Les caractères qu'un antislash échappe entre guillemets doubles (bash). */
const ECHAPPES_DOUBLES = new Set(['$', '`', '"', '\\', '\n'])
const HEREDOC = /^<<-?\s*(?:(['"])([A-Za-z_][\w-]*)\1|\\([A-Za-z_][\w-]*)|([A-Za-z_][\w-]*))/

/** L'indice de la parenthèse qui ferme `$(` (s[i] est la parenthèse ouvrante), guillemets sautés ; s.length si elle manque. */
function fermeture(s: string, i: number): number {
  let profondeur = 0
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === '\\') j++
    else if (c === "'") {
      const k = s.indexOf("'", j + 1)
      j = k < 0 ? s.length : k
    } else if (c === '(') profondeur++
    else if (c === ')' && --profondeur === 0) return j
  }
  return s.length
}

/** Les commandes substituées d'un texte (`$(…)`, `` `…` ``) : celles d'un heredoc non cité, que bash exécute. */
function substitutions(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === '$' && s[i + 1] === '(') {
      const f = fermeture(s, i + 1)
      out.push(s.slice(i + 2, f))
      i = f
    } else if (s[i] === '`') {
      const f = s.indexOf('`', i + 1)
      out.push(s.slice(i + 1, f < 0 ? s.length : f))
      i = f < 0 ? s.length : f
    }
  }
  return out
}

/**
 * Découpe une commande en segments (séparés par ; & | && || retour à la ligne, parenthèses, backticks en bash), chacun en
 * mots, guillemets retirés. Les redirections (`2>&1`, `> f`, `&>/dev/null`) et leur cible sont retirées, les commentaires
 * (`# …`) sautés. En PowerShell, l'antislash est un caractère ordinaire et le backtick échappe (ou continue la ligne).
 * Approximatif par nature : il vise les commandes qu'écrit un agent, pas un shell complet.
 */
function lire(command: string, ps = false): Lecture {
  const out: string[][] = []
  const internes: string[] = []
  const heredocs: Lecture['heredocs'] = []
  let mots: string[] = []
  let mot = ''
  let aMot = false
  /** Le prochain mot est la cible d'une redirection : il est retiré. */
  let cible = false
  /** Le prochain mot est une here-string (`<<<`) : c'est l'entrée de la commande, pas un argument. */
  let chaine = false
  let attente: { marqueur: string; cite: boolean }[] = []
  let debutLigne = 0
  const finMot = () => {
    if (aMot) {
      if (cible) cible = false
      else if (chaine) {
        chaine = false
        heredocs.push({ corps: mot, cite: true, ligne: [mots] })
      } else mots.push(mot)
    }
    mot = ''
    aMot = false
  }
  const finSegment = () => {
    finMot()
    cible = false
    chaine = false
    if (mots.length) out.push(mots)
    mots = []
  }
  const ajoute = (x: string) => {
    mot += x
    aMot = true
  }
  const s = command
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (!ps && c === '\\') {
      const d = s[i + 1]
      if (d === '\n') i += 2
      else if (d !== undefined && ECHAPPES.has(d)) {
        ajoute(d)
        i += 2
      } else {
        ajoute(c)
        i++
      }
      continue
    }
    if (ps && c === '`') {
      // PowerShell : backtick + fin de ligne continue la ligne ; devant un autre caractère, il l'échappe.
      if (s[i + 1] === '\n') i += 2
      else if (s[i + 1] === '\r' && s[i + 2] === '\n') i += 3
      else {
        if (i + 1 < s.length) ajoute(s[i + 1]!)
        i += 2
      }
      continue
    }
    if (c === '#' && !aMot) {
      // Commentaire : jusqu'à la fin de la ligne.
      const fin = s.indexOf('\n', i)
      i = fin < 0 ? s.length : fin
      continue
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1)
      ajoute(s.slice(i + 1, j < 0 ? s.length : j))
      i = j < 0 ? s.length : j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') {
        const x = s[j]!
        if (!ps && x === '\\' && j + 1 < s.length && ECHAPPES_DOUBLES.has(s[j + 1]!)) {
          mot += s[j + 1]
          j += 2
        } else if (ps && x === '`' && j + 1 < s.length) {
          mot += s[j + 1]
          j += 2
        } else if (x === '$' && s[j + 1] === '(') {
          const f = fermeture(s, j + 1)
          internes.push(s.slice(j + 2, f))
          mot += s.slice(j, f + 1)
          j = f + 1
        } else if (!ps && x === '`') {
          const f = s.indexOf('`', j + 1)
          const fin = f < 0 ? s.length : f
          internes.push(s.slice(j + 1, fin))
          mot += s.slice(j, fin + 1)
          j = fin + 1
        } else {
          mot += x
          j++
        }
      }
      aMot = true
      i = j + 1
      continue
    }
    if (c === '<' && s.startsWith('<<<', i)) {
      finMot()
      chaine = true
      i += 3
      continue
    }
    if (c === '<' && s[i + 1] === '<') {
      // Heredoc : on note le marqueur, son corps sera lu à la fin de la ligne.
      const m = HEREDOC.exec(s.slice(i))
      if (m) {
        finMot()
        attente.push({ marqueur: (m[2] ?? m[3] ?? m[4])!, cite: !m[4] })
        i += m[0].length
        continue
      }
    }
    if (c === '>' || c === '<' || (c === '&' && s[i + 1] === '>')) {
      // Redirection : le numéro de descripteur collé devant (2>) et la cible (> f, sauf >&1) ne sont pas des arguments.
      if (aMot && /^\d+$/.test(mot)) {
        mot = ''
        aMot = false
      } else finMot()
      let j = i + (c === '&' ? 2 : 1)
      while (s[j] === '>' || s[j] === '|') j++
      if (s[j] === '&') {
        let k = j + 1
        while (k < s.length && /[\d-]/.test(s[k]!)) k++
        if (k > j + 1) {
          i = k
          continue
        }
        j++
      }
      // <(…) et >(…) : une substitution de processus, lue comme un sous-shell.
      if (s[j] !== '(') cible = true
      i = j
      continue
    }
    if (c === '\n') {
      finSegment()
      i++
      const ligne = out.slice(debutLigne)
      for (const h of attente) {
        // Le corps : jusqu'à la ligne qui ne contient que le marqueur (tabulations de tête permises par <<-).
        const corps: string[] = []
        while (i < s.length) {
          const fin = s.indexOf('\n', i)
          const l = s.slice(i, fin < 0 ? s.length : fin)
          i = fin < 0 ? s.length : fin + 1
          if (l.replace(/^\t+/, '').trimEnd() === h.marqueur) break
          corps.push(l)
        }
        heredocs.push({ corps: corps.join('\n'), cite: h.cite, ligne })
      }
      attente = []
      debutLigne = out.length
      continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || (!ps && c === '`') || c === '\r') {
      finSegment()
      i++
      continue
    }
    if (c === '$' && s[i + 1] === '(') {
      finSegment()
      i += 2
      continue
    }
    if (c === ' ' || c === '\t') {
      finMot()
      i++
      continue
    }
    ajoute(c)
    i++
  }
  finSegment()
  return { segments: out, internes, heredocs }
}

/** Les segments d'une commande, en mots (pour les tests et l'appelant). */
export const segments = (command: string, shell: MergeContexte['shell'] = 'bash'): string[][] => lire(command, shell === 'powershell').segments

/** « /usr/local/bin/gh », « C:\tools\gh.exe », « GH » → « gh ». */
const programme = (mot: string) =>
  (mot.split(/[\\/]/).pop() ?? '')
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '')

/** L'indice du programme du segment : après les affectations (X=1), les enveloppes (sudo, env, xargs, timeout…) et leurs options. */
function debutCommande(mots: string[]): number {
  let i = 0
  while (i < mots.length) {
    const m = mots[i]!
    if (/^[A-Za-z_]\w*=/.test(m)) {
      i++
      continue
    }
    const env = ENVELOPPES.get(programme(m))
    if (!env) break
    i++
    while (i < mots.length && mots[i]!.startsWith('-') && mots[i] !== '-') {
      if (mots[i] === '--') {
        i++
        break
      }
      i += env.valeur?.includes(mots[i]!) ? 2 : 1
    }
    i += env.avant ?? 0
  }
  return i
}

/** Les mots qui ne sont pas des options, après `debut`, en sautant la valeur des options listées dans `avecValeur`. */
function positionnels(mots: string[], debut: number, avecValeur: Set<string>): string[] {
  const out: string[] = []
  for (let i = debut; i < mots.length; i++) {
    const m = mots[i]!
    if (m === '--') {
      out.push(...mots.slice(i + 1))
      break
    }
    if (m.startsWith('-') && m.length > 1) {
      if (avecValeur.has(m)) i++
      continue
    }
    out.push(m)
  }
  return out
}

/** La sous-commande git d'un segment (push, commit…) et son indice, après les options globales (-C, -c…). */
function sousCommandeGit(mots: string[], i: number): { nom: string | undefined; j: number } {
  let j = i + 1
  while (j < mots.length && mots[j]!.startsWith('-')) j += GIT_GLOBALES.has(mots[j]!) ? 2 : 1
  return { nom: mots[j], j }
}

// ── Les règles ───────────────────────────────────────────────────────────

const echapper = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Les appels d'API qui fusionnent ou modifient une branche protégée, GitHub et GitLab, REST et GraphQL. `lecture` : quelle
 * lecture les laisse passer : `explicite` (-X GET seulement), `implicite` (aussi un appel sans méthode ni données), aucune.
 */
function motifsApi(protegees: string[]): { re: RegExp; quoi: string; lecture?: 'explicite' | 'implicite' }[] {
  const b = protegees.map(echapper).join('|')
  return [
    { re: /\/pulls\/[^/\s'"]+\/merge(?![\w-])/i, quoi: "le merge d'une PR par l'API GitHub", lecture: 'explicite' },
    { re: /\brepos\/[^/\s'"]+\/[^/\s'"]+\/merges(?![\w-])/i, quoi: "le merge d'une branche par l'API GitHub (/merges)" },
    { re: new RegExp(`/git/refs/heads/(?:${b})(?![\\w./-])`), quoi: "la modification d'une branche protégée par l'API GitHub", lecture: 'implicite' },
    { re: new RegExp(`\\bref=['"]?refs/heads/(?:${b})(?![\\w./-])`), quoi: "la création d'une branche protégée par l'API GitHub" },
    { re: /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\b/, quoi: "le merge par l'API GraphQL de GitHub" },
    { re: /\/merge_requests\/[^/\s'"]+\/merge(?![\w-])/i, quoi: "le merge d'une MR par l'API GitLab" },
    { re: /\/merge_trains\/merge_requests\/[^/\s'"]+/i, quoi: "l'ajout d'une MR au train de merge GitLab", lecture: 'implicite' },
    { re: /\b(?:mergeRequestAccept|mergeRequestSetAutoMerge)\b/, quoi: "le merge d'une MR par l'API GraphQL de GitLab" },
    { re: /\bmerge_when_pipeline_succeeds\s*[=:]\s*['"]?(?:true|1)\b/i, quoi: "l'auto-merge d'une MR GitLab" },
    { re: /\bauto_merge\s*[=:]\s*['"]?(?:true|1)\b/i, quoi: "l'auto-merge d'une MR GitLab" },
  ]
}

/**
 * Les écritures directes sur une branche protégée par l'API : fichier (contents de GitHub, sur la branche par défaut si
 * `branch` manque), commit ou fichier de GitLab, et les mutations GraphQL qui écrivent une ref ou un commit.
 */
function ecritureBranche(texte: string, m: Methode, protegees: string[]): string | undefined {
  const protegee = (x: string | undefined) => !!x && protegees.some(p => p.toLowerCase() === x.replace(/^refs\/heads\//, '').toLowerCase())
  const branche = /\bbranch["']?\s*[=:]\s*['"]?([^\s'"&,}]+)/.exec(texte)?.[1]
  if (m === 'ecriture' && /\brepos\/[^/\s'"]+\/[^/\s'"]+\/contents\//i.test(texte) && (!branche || protegee(branche)))
    return "l'écriture d'un fichier sur une branche protégée par l'API GitHub"
  if (m === 'ecriture' && /\/repository\/(?:commits|files\/)/i.test(texte) && protegee(branche)) return "un commit sur une branche protégée par l'API GitLab"
  const b = protegees.map(echapper).join('|')
  if (/\b(?:createCommitOnBranch|updateRefs?)\b/.test(texte) && new RegExp(`(?:^|[^\\w./-])(?:refs/heads/)?(?:${b})(?![\\w./-])`).test(texte))
    return "l'écriture sur une branche protégée par l'API GraphQL de GitHub"
  return undefined
}

/** Les options qui envoient des données (gh api, glab api, curl, wget) : sans méthode explicite, l'appel n'est plus un GET. */
const DONNEES = /^(?:-f|-F|--field|--raw-field|--input|-d|--data|--data-raw|--data-binary|--data-urlencode|--json|--form|-T|--upload-file|--post-data|--post-file|--body-data)(?:=|$)/
type Methode = 'get' | 'ecriture' | 'defaut'
/** La méthode d'un appel d'API : GET explicite, une écriture (méthode ou données), ou rien de dit. */
function methode(mots: string[]): Methode {
  let donnees = false
  for (let k = 0; k < mots.length; k++) {
    const m = mots[k]!
    const v = /^(?:-X|--request|--method)$/.test(m) ? mots[k + 1] : /^(?:-X|--request=|--method=)(.+)$/.exec(m)?.[1]
    if (v !== undefined) return v.toUpperCase() === 'GET' ? 'get' : 'ecriture'
    if (DONNEES.test(m)) donnees = true
  }
  return donnees ? 'ecriture' : 'defaut'
}

/** Les options de gh et glab qui portent du texte libre : un titre ou une description qui cite une API ne l'appelle pas. */
const TEXTE_LIBRE = new Set(['-b', '--body', '-t', '--title', '-d', '--description', '-m', '--message'])

/** Le texte où chercher les motifs d'API : sans les valeurs de texte libre de gh et glab (hors gh api, glab api). */
function texteApi(mots: string[], i: number, prog: string): string {
  const suite = mots.slice(i)
  if ((prog !== 'gh' && prog !== 'glab') || positionnels(mots, i + 1, GH_VALEUR)[0] === 'api') return suite.join(' ')
  const out: string[] = []
  for (let k = 0; k < suite.length; k++) {
    const m = suite[k]!
    if (TEXTE_LIBRE.has(m)) k++
    else if (!/^--(?:body|title|description|message)=/.test(m)) out.push(m)
  }
  return out.join(' ')
}

/** Les options git qui prennent une valeur avant la sous-commande. */
const GIT_GLOBALES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
/** Les options de git push qui prennent une valeur séparée (--signed et --force-with-lease ne la prennent qu'avec =). */
const PUSH_VALEUR = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec', '--recurse-submodules'])
const GH_VALEUR = new Set(['-R', '--repo', '--hostname'])

/** gh pr merge (les API sont vues par motifsApi). */
function regleGh(mots: string[], i: number): string | undefined {
  const p = positionnels(mots, i + 1, GH_VALEUR)
  if (p[0] === 'pr' && p[1] === 'merge') return 'gh pr merge'
  return undefined
}

/** glab mr merge (ou accept), et toute option qui arme l'auto-merge. */
function regleGlab(mots: string[], i: number): string | undefined {
  const p = positionnels(mots, i + 1, GH_VALEUR)
  if (p[0] === 'mr' && (p[1] === 'merge' || p[1] === 'accept')) return `glab mr ${p[1]}`
  const auto = mots.slice(i + 1).find(m => /^--(?:auto-merge|when-pipeline-succeeds|merge-when-pipeline-succeeds)(?:=|$)/.test(m))
  if (auto && !/=\s*false$/i.test(auto)) return `glab ${auto}`
  return undefined
}

/** La branche visée par un refspec de push, ou undefined si elle dépend de la branche courante (HEAD, @). */
function destination(refspec: string): string | undefined {
  const r = refspec.replace(/^\+/, '')
  const dst = r.includes(':') ? r.slice(r.indexOf(':') + 1) || r.slice(0, r.indexOf(':')) : r
  const nom = dst.replace(/^refs\/heads\//, '')
  return nom === 'HEAD' || nom === '@' ? undefined : nom
}

/**
 * git push vers une branche protégée, --all, --branches, --mirror, avec une option de push GitLab qui fusionne, ou sans
 * branche de destination nommée (git push, git push origin, git push origin HEAD).
 */
function regleGit(mots: string[], i: number, protegees: string[]): string | undefined {
  const { nom, j } = sousCommandeGit(mots, i)
  if (nom !== 'push') return undefined
  const args = mots.slice(j + 1)
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    const option = a === '-o' || a === '--push-option' ? args[k + 1] : a.startsWith('--push-option=') ? a.slice('--push-option='.length) : a.startsWith('-o') && a.length > 2 ? a.slice(2) : undefined
    if (option && /^merge_request\.(?:merge_when_pipeline_succeeds|auto_merge)(?:=(?!false)|$)/i.test(option)) return `git push -o ${option}`
    if (a === '--all' || a === '--branches' || a === '--mirror') return `git push ${a}`
  }
  const p = positionnels(args, 0, PUSH_VALEUR)
  const estProtegee = (b: string) => b.includes('*') || protegees.some(x => x.toLowerCase() === b.toLowerCase())
  const refspecs = p.slice(1)
  if (refspecs.length === 0) {
    // --tags seul ne pousse que les tags ; sinon la branche courante part, selon le dossier du shell, push.default et l'amont.
    if (args.includes('--tags')) return undefined
    return 'git push sans branche nommée'
  }
  for (const r of refspecs) {
    const b = destination(r)
    if (b === undefined) return `git push ${r} (branche non nommée)`
    if (estProtegee(b)) return `git push vers ${b}`
  }
  return undefined
}

/** Le segment lance-t-il un shell qui lit une commande en argument (-c, -Command, /c) ? Son indice dans le segment. */
function optionCommande(mots: string[], i: number, prog: string): number {
  if (prog === 'cmd') return mots.findIndex((m, n) => n > i && /^\/[ck]$/i.test(m))
  return mots.findIndex((m, n) => n > i && /^-\w*c$|^-Command$|^-EncodedCommand$/i.test(m))
}

/** La raison du refus d'un segment, en suivant sh -c, cmd /c et eval jusqu'à PROFONDEUR_MAX. */
function refusSegment(mots: string[], protegees: string[], ctx: MergeContexte, profondeur: number): string | undefined {
  const i = debutCommande(mots)
  if (i >= mots.length) return undefined
  const prog = programme(mots[i]!)
  if (!TEXTE.has(prog)) {
    const m = methode(mots.slice(i))
    const texte = texteApi(mots, i, prog)
    const api = motifsApi(protegees).find(x => x.re.test(texte) && !(m === 'get' && x.lecture) && !(m === 'defaut' && x.lecture === 'implicite'))
    if (api) return api.quoi
    const ecriture = ecritureBranche(texte, m, protegees)
    if (ecriture) return ecriture
  }
  const cite = (q: string | undefined) => (q ? `« ${q} »` : undefined)
  if (prog === 'gh') return cite(regleGh(mots, i))
  if (prog === 'glab') return cite(regleGlab(mots, i))
  if (prog === 'git') return cite(regleGit(mots, i, protegees))
  if (SHELLS.has(prog) || prog === 'cmd') {
    const k = optionCommande(mots, i, prog)
    if (k > 0 && mots[k + 1] !== undefined) {
      if (/^-EncodedCommand$/i.test(mots[k]!)) return 'une commande PowerShell encodée'
      return refusTexte(prog === 'cmd' ? mots.slice(k + 1).join(' ') : mots[k + 1]!, protegees, ctx, profondeur + 1)
    }
  }
  if (prog === 'eval' || prog === 'invoke-expression' || prog === 'iex') return refusTexte(mots.slice(i + 1).join(' '), protegees, ctx, profondeur + 1)
  return undefined
}

/**
 * Les programmes qui ne font que manipuler du texte : un message de commit ou une recherche qui cite « /pulls/1/merge »
 * n'appelle aucune API.
 */
const TEXTE = new Set(['git', 'echo', 'printf', 'cat', 'grep', 'rg', 'ag', 'sed', 'awk', 'head', 'tail', 'less', 'more', 'wc', 'write-output', 'write-host'])

/** Le segment lance-t-il un shell (qui exécuterait le heredoc de sa ligne, ou ce qu'on lui envoie par un tube) ? */
const lanceShell = (s: string[]) => {
  const k = debutCommande(s)
  return k < s.length && SHELLS.has(programme(s[k]!))
}

function refusTexte(command: string, protegees: string[], ctx: MergeContexte, profondeur: number): string | undefined {
  if (profondeur > PROFONDEUR_MAX) return undefined
  const l = lire(command, ctx.shell === 'powershell')
  for (const seg of l.segments) {
    const r = refusSegment(seg, protegees, ctx, profondeur)
    if (r) return r
  }
  // Ce que le shell exécute aussi : les substitutions entre guillemets doubles, le corps d'un heredoc (ou une here-string)
  // donné à un shell, les substitutions d'un heredoc non cité. Le corps d'un heredoc cité donné à git ou cat reste du texte.
  const aussi = [
    ...l.internes,
    ...l.heredocs.flatMap(h => (h.ligne.some(lanceShell) ? [h.corps] : h.cite ? [] : substitutions(h.corps))),
  ]
  // Un shell qui lit son entrée (`echo '…' | sh` : ni -c ni script) : les arguments des autres segments peuvent être ses commandes.
  const lecteur = l.segments.some(s => {
    const k = debutCommande(s)
    return lanceShell(s) && optionCommande(s, k, programme(s[k]!)) < 0 && positionnels(s, k + 1, new Set()).length === 0
  })
  if (lecteur)
    for (const s of l.segments)
      if (!lanceShell(s)) aussi.push(s.slice(debutCommande(s) + 1).filter(m => !m.startsWith('-')).join(' '))
  for (const x of aussi) {
    const r = refusTexte(x, protegees, ctx, profondeur + 1)
    if (r) return r
  }
  return undefined
}

/**
 * Le texte du refus d'une commande Bash ou PowerShell qui fusionnerait une PR ou une MR, armerait l'auto-merge, ou pousserait
 * sur une branche protégée (main, master, et celle d'origin/HEAD) ou sans branche nommée ; undefined si elle passe. Ne lève
 * jamais : une analyse en échec sur une commande qui parle de merge ou de push est refusée par prudence.
 */
export function mergeDenial(command: string, ctx: MergeContexte = {}): string | undefined {
  const c = typeof command === 'string' ? command : ''
  if (!c.trim()) return undefined
  try {
    const defaut = ctx.defaut?.trim()
    const protegees = [...TOUJOURS_PROTEGEES, ...(defaut && !TOUJOURS_PROTEGEES.includes(defaut) ? [defaut] : [])]
    const quoi = refusTexte(c, protegees, ctx, 0)
    return quoi ? message(quoi, protegees) : undefined
  } catch {
    return refusPrudent(c)
  }
}

/** Le refus par prudence quand le contrôle a échoué : seulement pour une commande qui parle de merge ou de push. */
export function refusPrudent(command: unknown): string | undefined {
  return typeof command === 'string' && /\b(?:merge|push)\b/i.test(command)
    ? 'revo-flow : le contrôle anti-merge a échoué sur cette commande ; refusée par prudence. Découpe-la en commandes simples.'
    : undefined
}

const message = (quoi: string, protegees: string[]) =>
  `revo-flow : ${quoi} est refusé. Le merge d'une PR ou d'une MR et le push sur une branche protégée (${protegees.join(', ')}) ` +
  `sont réservés à l'utilisateur : pousse sur une branche de travail en la nommant (git push -u origin <branche>), ouvre ou ` +
  `mets à jour la PR ou la MR, et dis-lui qu'elle est prête à fusionner. Ne contourne pas ce refus (option « Garde anti-merge » de revo-flow).`

/**
 * Le dossier où tourne le premier git push de la commande, en suivant les `cd` (et `pushd`, `Set-Location`) qui le précèdent
 * et ses `git -C` : la liste des dossiers à passer à git en `-C`, dans l'ordre (relatifs au dossier de la session), pour y
 * lire la branche par défaut. `connu` est faux quand un `cd` est sans argument, vers `-` ou `~`, ou qu'un `popd` le précède :
 * seules main et master sont alors protégées. undefined : pas de git push.
 */
export function dossiersDuPush(command: string, shell: MergeContexte['shell'] = 'bash'): { dossiers: string[]; connu: boolean } | undefined {
  try {
    const dossiers: string[] = []
    let connu = true
    for (const seg of segments(typeof command === 'string' ? command : '', shell)) {
      const i = debutCommande(seg)
      if (i >= seg.length) continue
      const prog = programme(seg[i]!)
      if (prog === 'cd' || prog === 'pushd' || prog === 'set-location' || prog === 'sl' || prog === 'chdir') {
        const d = seg.slice(i + 1).find(m => !m.startsWith('-'))
        if (!d || d === '-' || d.startsWith('~')) connu = false
        else dossiers.push(d)
      } else if (prog === 'popd') connu = false
      else if (prog === 'git' && sousCommandeGit(seg, i).nom === 'push') {
        for (let k = i + 1; k < seg.length && seg[k]!.startsWith('-'); k++) {
          if (seg[k] === '-C' && seg[k + 1] !== undefined) {
            const d = seg[k + 1]!
            if (d.startsWith('~')) connu = false
            else dossiers.push(d)
          }
          if (GIT_GLOBALES.has(seg[k]!)) k++
        }
        return { dossiers, connu }
      }
    }
    return undefined
  } catch {
    return { dossiers: [], connu: false }
  }
}

/** « origin/main » (git symbolic-ref --short refs/remotes/origin/HEAD) → « main ». */
export function brancheParDefaut(sortie: string): string | undefined {
  const s = (sortie ?? '').trim()
  if (!s) return undefined
  const nom = s.replace(/^refs\/remotes\//, '').replace(/^[^/]+\//, '')
  return nom || undefined
}
