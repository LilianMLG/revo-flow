/**
 * Les garde-fous du flow vérifié (lot 2, docs/rd-v2/conception.md §3, §4 et §8) : critères d'acceptation, gel des tests
 * du testeur, refus des éditions interdites, Bash filtré du vérificateur, détection de triche dans le diff, prompt
 * calibré du vérificateur et lecture de ses verdicts, consigne du testeur.
 * Logique pure, sans aucune référence à `$` : le module est importé par register.tsx (bug v1.2.1). Les chemins, les hash
 * et le diff sont lus par l'appelant et passés en paramètre.
 * frozenDenial et testerDenial tournent dans un hook fermé en cas d'erreur : elles ne lèvent jamais.
 */
import type { Critere, CritereVerdict, TestGele, Triche, VerifCommande } from '../../types/verif'

// ── Critères d'acceptation ───────────────────────────────────────────────

export const CRITERES_MAX = 8
/** En deçà, un critère n'est pas vérifiable (« ça marche », « code propre ») : il faut un sujet, une action, un résultat. */
const CRITERE_MOTS_MIN = 3
const CRITERE_LONGUEUR_MAX = 300

/** Le texte d'un critère, donné en chaîne ou en objet ({ texte } ou { text }). Les puces de liste sont retirées. */
function critereText(x: unknown): string {
  const v = typeof x === 'string' ? x : typeof x === 'object' && x !== null ? ((x as Record<string, unknown>).texte ?? (x as Record<string, unknown>).text) : ''
  return typeof v === 'string'
    ? v
        .replace(/^\s*(?:[-*•]|\d+[.)]|C\d+\s*[:.)-])\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
    : ''
}

/**
 * Lit les critères d'acceptation de l'outil plan : 1 à 8, numérotés C1..C8 dans l'ordre donné (les ids reçus sont
 * ignorés), chacun vérifiable (3 mots au moins, 300 caractères au plus) et distinct des autres. Accepte un tableau de
 * chaînes ou d'objets, ou une chaîne d'une ligne par critère. L'erreur est renvoyée telle quelle à l'orchestrateur.
 */
export function parseCriteres(raw: unknown): { criteres: Critere[] } | { error: string } {
  const list = Array.isArray(raw) ? (raw as unknown[]) : typeof raw === 'string' ? raw.split(/\r?\n/) : undefined
  if (!list) return { error: '« criteres » doit être une liste de 1 à 8 critères vérifiables (une phrase chacun).' }
  const textes = list.map(critereText).filter(t => t.length > 0)
  if (textes.length === 0) return { error: '« criteres » vide : donne au moins un critère d’acceptation vérifiable.' }
  if (textes.length > CRITERES_MAX)
    return { error: `${textes.length} critères : ${CRITERES_MAX} au plus. Garde ceux qui disent si la feature est faite.` }
  const vus = new Set<string>()
  for (const [i, t] of textes.entries()) {
    const id = `C${i + 1}`
    if (t.length > CRITERE_LONGUEUR_MAX)
      return { error: `${id} fait ${t.length} caractères (${CRITERE_LONGUEUR_MAX} au plus) : découpe-le en critères plus courts.` }
    if (t.split(' ').filter(m => /[\p{L}\p{N}]/u.test(m)).length < CRITERE_MOTS_MIN)
      return { error: `${id} « ${t} » n’est pas vérifiable : dis ce qui doit se passer et comment le constater (ex. « Un code promo expiré affiche une erreur sous le champ »).` }
    const k = t.toLowerCase()
    if (vus.has(k)) return { error: `${id} répète un critère précédent : retire le doublon.` }
    vus.add(k)
  }
  return { criteres: textes.map((texte, i) => ({ id: `C${i + 1}`, texte })) }
}

// ── Chemins ──────────────────────────────────────────────────────────────

/** Un chemin en barres obliques, sans « ./ » de tête ni « / » final (même règle que normalizePath du cache). */
function chemin(p: unknown): string {
  let s = (typeof p === 'string' ? p : '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/**
 * La clé de comparaison d'un chemin : en minuscules, car le disque ignore la casse sous Windows et par défaut sous macOS
 * (APFS) ; une comparaison sensible à la casse laisserait passer « Tests/Panier.test.ts » sur un test gelé.
 */
const cle = (p: unknown) => chemin(p).toLowerCase()

/**
 * Deux chemins désignent-ils le même fichier ? Égaux, ou l'un est la fin de l'autre à une frontière de dossier :
 * l'outil Edit donne un chemin absolu, le gel garde des chemins relatifs à la racine. Dans le doute, ça correspond
 * (le gel se ferme).
 */
function memeFichier(a: unknown, b: unknown): boolean {
  const x = cle(a)
  const y = cle(b)
  if (!x || !y) return false
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

/** Le chemin relatif à racine quand il est dessous, sinon le chemin tel quel (normalisé). */
function relatif(p: unknown, racine?: string): string {
  const s = chemin(p)
  const r = cle(racine)
  return r && s.toLowerCase().startsWith(`${r}/`) ? s.slice(r.length + 1) : s
}

// ── Fichiers de test et gel ──────────────────────────────────────────────

/** Les dossiers dont tout le contenu compte comme test (aides et fixtures comprises). */
const DOSSIERS_TEST = new Set(['test', 'tests', '__tests__', 'integration_test'])

/**
 * Un fichier de test : *.test.* ou *.spec.* (JS, TS, JSX, TSX, mjs, cts…), *_test.dart, ou sous un dossier test/,
 * tests/, __tests__/, integration_test/. racine (facultatif) : retirée d'un chemin absolu, pour qu'un dossier « tests »
 * au-dessus du projet ne compte pas.
 */
export function isTestFile(p: string, racine?: string): boolean {
  const parts = cle(relatif(p, racine)).split('/').filter(Boolean)
  const nom = parts.pop()
  if (!nom) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(nom) || nom.endsWith('_test.dart')) return true
  return parts.some(d => DOSSIERS_TEST.has(d))
}

/**
 * Gèle les fichiers de test du testeur par (fin du testeur, §8) : chemin relatif à la racine et hash git. existant : le
 * gel déjà posé, gardé ; un chemin regelé prend le nouveau hash et le nouvel auteur. Entrées sans chemin ou sans hash
 * ignorées.
 */
export function freeze(files: { p: string; h: string }[], par: string, existant: TestGele[] = []): TestGele[] {
  const gel = new Map<string, TestGele>()
  for (const g of Array.isArray(existant) ? existant : []) if (cle(g?.p) && g.h) gel.set(cle(g.p), g)
  for (const f of Array.isArray(files) ? files : []) {
    const p = chemin(f?.p)
    const h = typeof f?.h === 'string' ? f.h.trim() : ''
    if (p && h) gel.set(cle(p), { p, h, par })
  }
  return [...gel.values()]
}

/** Retire un fichier du gel (dégel confirmé par l'utilisateur, §4). */
export function unfreeze(gel: TestGele[], path: string): TestGele[] {
  return (Array.isArray(gel) ? gel : []).filter(g => !memeFichier(g.p, path))
}

const memeAgent = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.trim() !== '' && a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Pourquoi l'édition de path par who est refusée, ou undefined si elle est permise. Seul l'auteur du test gelé (par)
 * peut encore y toucher ; tout autre agent, et l'orchestrateur, sont refusés jusqu'au dégel. Ne lève jamais : sur une
 * entrée inattendue, refuse (gel fermé).
 */
export function frozenDenial(gel: TestGele[], path: string, who: string): string | undefined {
  try {
    const g = (Array.isArray(gel) ? gel : []).find(x => memeFichier(x?.p, path))
    if (!g || memeAgent(who, g.par)) return undefined
    return (
      `revo-flow : « ${g.p} » est un test gelé (écrit par « ${g.par} » à partir des critères d'acceptation) : il ne se modifie pas. ` +
      `Si le test est faux, dis-le dans ta réponse avec le motif : l'orchestrateur peut demander à l'utilisateur de le dégeler (outil verif, action degeler). ` +
      `Sinon, corrige le code de production pour qu'il passe.`
    )
  } catch {
    return 'revo-flow : édition refusée par prudence (le contrôle des tests gelés a échoué).'
  }
}

/** Pourquoi le testeur ne peut pas éditer path (il ne touche qu'aux fichiers de test, §3), ou undefined. Ne lève jamais. */
export function testerDenial(path: string, racine?: string): string | undefined {
  try {
    if (isTestFile(path, racine)) return undefined
    return (
      `revo-flow : « ${relatif(path, racine) || path} » n'est pas un fichier de test. Le testeur n'écrit que des tests ` +
      `(*.test.ts, *.spec.ts, *_test.dart, ou sous test/, tests/, __tests__/, integration_test/) et ne modifie jamais le code de production : ` +
      `si une interface manque pour tester un critère, dis-le dans ta réponse.`
    )
  } catch {
    return 'revo-flow : édition refusée par prudence (le contrôle des fichiers du testeur a échoué).'
  }
}

/** Deux hash git égaux, l'un pouvant être abrégé (le cache garde 12 caractères) ; 7 caractères au moins. */
function memeHash(a: unknown, b: unknown): boolean {
  const x = typeof a === 'string' ? a.trim().toLowerCase() : ''
  const y = typeof b === 'string' ? b.trim().toLowerCase() : ''
  if (x.length < 7 || y.length < 7) return false
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y)
}

/**
 * Re-hash à chaque porte (§8) : les fichiers gelés dont le hash a changé depuis le gel, par un Edit refusé contourné,
 * un Bash ou autre. hashes : chemin relatif → hash git actuel ; un fichier absent (supprimé, illisible) compte comme
 * modifié.
 */
export function rehash(gel: TestGele[], hashes: Record<string, string>): { p: string; par: string }[] {
  const actuels = new Map<string, string>()
  for (const [p, h] of Object.entries(hashes ?? {})) actuels.set(cle(p), h)
  return (Array.isArray(gel) ? gel : []).filter(g => !memeHash(actuels.get(cle(g.p)), g.h)).map(g => ({ p: g.p, par: g.par }))
}

// ── Bash du vérificateur ─────────────────────────────────────────────────

/**
 * Ce qui enchaîne, redirige ou substitue (;, &, &&, |, <, >, $( ), backticks, retour à la ligne) : refusé partout,
 * même entre guillemets. Plus strict que le shell, donc plus simple à garantir ; le vérificateur reformule
 * (`grep -e a -e b` au lieu de `grep 'a|b'`).
 */
const SHELL_INTERDIT = /[;&|<>`\r\n]|\$\(/

/** Les mots d'une commande, guillemets simples et doubles retirés ; undefined si un guillemet n'est pas fermé. */
function mots(command: string): string[] | undefined {
  const out: string[] = []
  let cur = ''
  let plein = false
  let q = ''
  for (const c of command) {
    if (q) {
      if (c === q) q = ''
      else cur += c
    } else if (c === "'" || c === '"') {
      q = c
      plein = true
    } else if (/\s/.test(c)) {
      if (plein) out.push(cur)
      cur = ''
      plein = false
    } else {
      cur += c
      plein = true
    }
  }
  if (q) return undefined
  if (plein) out.push(cur)
  return out
}

const egaux = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** m est-elle la commande confirmée argv ? « {fichiers} » y vaut zéro, un ou plusieurs chemins (pas d'option). */
function estConfirmee(m: string[], argv: string[]): boolean {
  const i = argv.indexOf('{fichiers}')
  if (i < 0) return egaux(m, argv)
  const avant = argv.slice(0, i)
  const apres = argv.slice(i + 1)
  if (m.length < avant.length + apres.length) return false
  if (!egaux(m.slice(0, i), avant) || !egaux(m.slice(m.length - apres.length), apres)) return false
  return m.slice(i, m.length - apres.length).every(f => f !== '' && !f.startsWith('-'))
}

/** Les sous-commandes git qui ne font que lire. checkout, reset, restore, stash, clean… n'y sont pas. */
const GIT_LECTURES = new Set(['diff', 'show', 'log', 'status', 'blame', 'ls-files'])
/** Les commandes de lecture permises telles quelles (sans chemin : un « ./cat » du dépôt serait un script arbitraire). */
const LECTURES = new Set(['cat', 'ls', 'head', 'tail', 'grep', 'wc', 'pwd'])
/** Un script sed qui n'imprime que des lignes : adresses (numéro, $, /motif/), plage facultative, puis p. Ni w, ni e. */
const SED_SCRIPT = /^(\d+|\$|\/[^/]*\/)(,(\d+|\$|\/[^/]*\/|[+~]\d+))?p$/

function estLecture(m: string[]): boolean {
  const [prog = '', ...args] = m
  if (prog === 'git') {
    let i = 0
    while (args[i] === '--no-pager' || args[i] === '-C') i += args[i] === '-C' ? 2 : 1
    const sub = args[i] ?? ''
    // --output écrit un fichier, --ext-diff lance un programme externe.
    return GIT_LECTURES.has(sub) && !args.slice(i + 1).some(a => /^--(output|ext-diff)/.test(a))
  }
  if (prog === 'sed') {
    const opts = args.filter(a => a.startsWith('-'))
    const autres = args.filter(a => !a.startsWith('-'))
    // -n obligatoire (rien n'est imprimé hors du script), -E / -r permis, tout le reste refusé (-i, -e, -f, --in-place…).
    if (!opts.every(o => /^-[nEr]+$/.test(o) || o === '--quiet' || o === '--silent')) return false
    if (!opts.some(o => /^-[Er]*n/.test(o) || o === '--quiet' || o === '--silent')) return false
    return SED_SCRIPT.test(autres[0] ?? '')
  }
  if (prog === 'tail' && args.some(a => /^-[a-zA-Z]*[fF]|^--follow/.test(a))) return false
  return LECTURES.has(prog)
}

/**
 * Le vérificateur peut-il lancer command (§8, lecture seule) ? Oui pour une commande confirmée donnée exactement
 * (argv joint par des espaces, ou mot à mot avec « {fichiers} » remplacé ; le préfixe Windows « cmd /c » est toléré),
 * et pour les lectures : git diff, show, log, status, blame, ls-files ; cat, ls, head, tail, grep, wc, pwd ;
 * sed -n avec un script d'impression. Tout enchaînement, redirection ou substitution est refusé. Ne lève jamais.
 */
export function verifierBashAllowed(command: string, confirmees: string[][]): boolean {
  try {
    const c = typeof command === 'string' ? command.trim() : ''
    if (!c) return false
    const listes = (Array.isArray(confirmees) ? confirmees : []).filter(a => Array.isArray(a) && a.length > 0)
    if (listes.some(a => a.join(' ') === c)) return true
    if (SHELL_INTERDIT.test(c)) return false
    const m = mots(c)
    if (!m || m.length === 0) return false
    const sansPrefixe = m.length > 2 && m[0]!.toLowerCase() === 'cmd' && m[1]!.toLowerCase() === '/c' ? m.slice(2) : m
    if (listes.some(a => estConfirmee(m, a) || estConfirmee(sansPrefixe, a))) return true
    return estLecture(m)
  } catch {
    return false
  }
}

// ── Triche dans le diff du flow ──────────────────────────────────────────

/** Un fichier d'un diff unifié : ses lignes ajoutées et retirées (jamais le contexte). */
type FichierDiff = { p: string; ajouts: string[]; retraits: string[] }

/** « "b/caf\303\251.ts" » ou « b/x.ts » → « x.ts » (les échappements C de git sont gardés tels quels). */
const cheminDiff = (s: string) => s.trim().replace(/^"(.*)"$/, '$1').replace(/^[ab]\//, '')

/**
 * Découpe un diff unifié (`git diff`, CRLF toléré) par fichier. Les hunks sont comptés d'après leur en-tête
 * (@@ -a,b +c,d @@) : une ligne retirée qui commence par « -- » ne passe pas pour un en-tête, et un diff sans
 * « diff --git » (diff -u) se lit aussi.
 */
function fichiersDuDiff(diff: string): FichierDiff[] {
  const out: FichierDiff[] = []
  let cur: FichierDiff | undefined
  let ancien = 0
  let nouveau = 0
  const ouvrir = (p: string) => {
    cur = { p, ajouts: [], retraits: [] }
    out.push(cur)
  }
  for (const ligne of (typeof diff === 'string' ? diff : '').split(/\r?\n/)) {
    if (ancien > 0 || nouveau > 0) {
      const c = ligne[0]
      if (c === '\\') continue
      if (c === '+') {
        cur?.ajouts.push(ligne.slice(1))
        nouveau--
      } else if (c === '-') {
        cur?.retraits.push(ligne.slice(1))
        ancien--
      } else {
        // Contexte (une ligne vide est un contexte dont l'espace a été rogné).
        ancien--
        nouveau--
      }
      continue
    }
    const git = /^diff --git (.+?) ("?b\/.*)$/.exec(ligne)
    if (git) {
      ouvrir(cheminDiff(git[2]!))
      continue
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(ligne)
    if (hunk) {
      ancien = hunk[1] === undefined ? 1 : Number(hunk[1])
      nouveau = hunk[2] === undefined ? 1 : Number(hunk[2])
      continue
    }
    if (ligne.startsWith('--- ')) {
      const p = cheminDiff(ligne.slice(4).split('\t')[0]!)
      // Sans « diff --git », « --- » ouvre le fichier ; avec, il le précise (fichier supprimé : +++ /dev/null).
      if (!cur || cur.ajouts.length + cur.retraits.length > 0) ouvrir(p)
      else if (p !== '/dev/null' && !cur.p) cur.p = p
      continue
    }
    if (ligne.startsWith('+++ ') && cur) {
      const p = cheminDiff(ligne.slice(4).split('\t')[0]!)
      if (p !== '/dev/null') cur.p = p
    }
  }
  return out
}

/** Les fichiers de configuration des vérifications : toute modification est bloquante (§4, garde-fou modifié). */
const GARDE_FOUS = [
  /^\.eslintrc(\..+)?$/,
  /^\.eslintignore$/,
  /^eslint\.config\.[^/]+$/,
  /^tsconfig[^/]*\.json$/,
  /^vitest\.(config|workspace)\.[^/]+$/,
  /^jest\.config\.[^/]+$/,
  /^biome\.jsonc?$/,
  /^analysis_options\.yaml$/,
]
/** Une ligne de scripts lint, test ou typage d'un package.json (pas une dépendance : sa valeur serait une version). */
const SCRIPT_GARDE = /^\s*"(pre|post)?(lint|test|typecheck|type-check)(:[^"]*)?"\s*:\s*"(?!\^|~|\d|\*|workspace:|npm:|file:|link:|latest")/

/** Les motifs cherchés dans les seules lignes ajoutées. ext : limité à ces extensions. Signalés, pas bloquants. */
const MOTIFS: { motif: string; re: RegExp; ext?: RegExp }[] = [
  { motif: 'test sauté (.skip)', re: /\b(describe|it|test|context|suite|bench)\.skip(If)?\b/ },
  { motif: 'test isolé (.only)', re: /\b(describe|it|test|context|suite)\.only\b/ },
  { motif: 'test désactivé (xit, xdescribe)', re: /\bx(it|describe|test)\s*\(/ },
  { motif: 'test laissé à faire (test.todo)', re: /\b(it|test)\.todo\b/ },
  { motif: 'test sauté (skip: true)', re: /\bskip\s*:\s*(true\b|['"])/, ext: /\.dart$/ },
  { motif: 'règle eslint désactivée (eslint-disable)', re: /eslint-disable/ },
  { motif: 'erreur de typage masquée (@ts-ignore)', re: /@ts-ignore/ },
  { motif: 'erreur de typage masquée (@ts-expect-error)', re: /@ts-expect-error/ },
  { motif: 'typage coupé (@ts-nocheck)', re: /@ts-nocheck/ },
  { motif: 'règle biome désactivée (biome-ignore)', re: /biome-ignore/ },
  { motif: 'avertissement Dart ignoré (// ignore:)', re: /\/\/\s*ignore(_for_file)?\s*:/, ext: /\.dart$/ },
  { motif: 'typage contourné (as any)', re: /\bas\s+any\b/ },
]
/** Ni code ni test : une doc qui cite « @ts-ignore » n'est pas une triche. */
const DOC = /\.(md|mdx|markdown|txt|rst|adoc)$/

const EXPECT = /\bexpect\s*\(/g
const nbExpect = (lignes: string[]) => lignes.reduce((n, l) => n + (l.match(EXPECT)?.length ?? 0), 0)
const extraitDe = (l: string) => (l.trim().length > 120 ? `${l.trim().slice(0, 119)}…` : l.trim())

/**
 * Les motifs de triche du diff du flow (§8). Bloquants : un test gelé modifié (gel, facultatif), un fichier de
 * configuration des vérifications modifié, les scripts lint, test ou typage d'un package.json modifiés. Signalés :
 * .skip, .only, xit, xdescribe, test.todo, skip: true (Dart), eslint-disable, @ts-ignore, @ts-expect-error, @ts-nocheck,
 * biome-ignore, // ignore: (Dart), as any dans une ligne ajoutée, et la baisse du nombre d'expect( d'un fichier de test.
 * Une ligne de contexte ou retirée ne compte jamais. Un motif répété dans un fichier ne donne qu'une triche (« +N »).
 * Bloquants d'abord.
 */
export function detectCheats(diff: string, gel: TestGele[] = []): Triche[] {
  const out: Triche[] = []
  const compte = new Map<Triche, number>()
  const ajouter = (t: Triche) => {
    const deja = out.find(x => x.motif === t.motif && x.fichier === t.fichier)
    if (deja) compte.set(deja, (compte.get(deja) ?? 1) + 1)
    else out.push(t)
  }
  for (const f of fichiersDuDiff(diff)) {
    if (!f.p) continue
    const nom = cle(f.p).split('/').pop() ?? ''
    const g = (Array.isArray(gel) ? gel : []).find(x => memeFichier(x?.p, f.p))
    if (g) ajouter({ motif: 'test gelé modifié', fichier: f.p, extrait: `gelé, écrit par « ${g.par} »`, bloquant: true })
    if (GARDE_FOUS.some(re => re.test(nom))) {
      const l = [...f.ajouts, ...f.retraits].find(x => x.trim() !== '')
      ajouter({ motif: 'garde-fou modifié (configuration des vérifications)', fichier: f.p, ...(l ? { extrait: extraitDe(l) } : {}), bloquant: true })
    }
    if (nom === 'package.json')
      for (const l of [...f.ajouts, ...f.retraits].filter(x => SCRIPT_GARDE.test(x)))
        ajouter({ motif: 'garde-fou modifié (script lint, test ou typage)', fichier: f.p, extrait: extraitDe(l), bloquant: true })
    if (DOC.test(nom)) continue
    for (const l of f.ajouts)
      for (const m of MOTIFS) if ((!m.ext || m.ext.test(nom)) && m.re.test(l)) ajouter({ motif: m.motif, fichier: f.p, extrait: extraitDe(l), bloquant: false })
    if (isTestFile(f.p)) {
      const avant = nbExpect(f.retraits)
      const apres = nbExpect(f.ajouts)
      if (avant > apres)
        ajouter({ motif: 'moins d’assertions (expect)', fichier: f.p, extrait: `${avant} expect( retirés, ${apres} ajoutés`, bloquant: false })
    }
  }
  return out
    .map(t => (compte.has(t) ? { ...t, extrait: `${t.extrait ?? ''} (+${compte.get(t)! - 1})`.trim() } : t))
    .sort((a, b) => Number(b.bloquant) - Number(a.bloquant))
}

// ── Vérificateur : prompt calibré, tâche et lecture des verdicts ─────────

/**
 * Le prompt système de revo-flow:verifier (§3 : Sonnet medium proposé). Calibré par trois exemples notés, un par
 * verdict, avec le contre-exemple classique (« ok » sur simple lecture du code) : sans eux, le modèle valide trop.
 */
export const VERIFIER_PROMPT = [
  'Tu es le vérificateur de revo-flow. Tu arrives en contexte neuf : tu n’as pas écrit ce code et tu ne dois rien à ceux qui l’ont écrit.',
  'Pour chaque critère d’acceptation de ta tâche, tu rends un verdict : « ok », « ko » ou « non-verifiable », avec sa preuve.',
  '',
  '## Règles',
  '1. Une preuve s’exécute, elle ne se déclare pas. Un « ok » exige une commande que TU as lancée pendant cette vérification et un extrait de sa sortie qui montre le critère tenu (le test nommé qui passe, la sortie attendue). Lire le code ne suffit jamais pour un « ok ». Ce que les agents affirment dans leurs réponses ne compte pas.',
  '2. « ko » : la commande et l’extrait qui montrent l’échec, ou le fichier et la ligne qui contredisent le critère, avec la raison.',
  '3. « non-verifiable » : aucune commande permise ne peut le montrer (serveur, émulateur, navigateur, service externe, donnée absente). Dis ce qui manquerait et ce que tu as pu vérifier à côté. Entre « ok » et « non-verifiable », dans le doute, choisis « non-verifiable » : ne devine jamais un « ok ».',
  '4. Lecture seule : tu ne modifies, ne crées ni ne supprimes aucun fichier, et tu ne corriges rien. Bash est filtré : les commandes confirmées données dans ta tâche, et les lectures git diff, git show, git log, git status, cat, ls, head, tail, grep, wc, sed -n \'10,40p\'. Pas d’enchaînement (;, &&, |), pas de redirection (>, <), pas de $( ) ni de backticks. Une commande refusée : prends une autre lecture, ne cherche pas à contourner.',
  '5. Triche : un test sauté (.skip, .only, xit), une assertion retirée, un @ts-ignore, un eslint-disable ou un as any ajouté pour faire passer, une config de lint ou de test assouplie : cite-le dans la preuve du critère concerné et juge « ko ».',
  '6. Méthode : lis le diff (git diff, git diff --stat), puis pour chaque critère trouve le test ou la sortie qui le couvre, lance la commande, lis la sortie, puis juge.',
  '',
  '## Exemples notés',
  'Exemple 1, « ok » bien jugé. Critère C1 : « Un code promo expiré affiche "Code expiré" sous le champ. »',
  '{"id":"C1","verdict":"ok","preuve":"npx vitest run tests/promo/Champ.test.ts → ✓ C1 : affiche « Code expiré » pour un code échu (12 ms) ; Tests 4 passed (4)"}',
  'Juste : la commande a été lancée par le vérificateur, l’extrait de sortie est cité, le test nommé porte exactement sur le critère.',
  'Mal jugé, pour le même critère : {"id":"C1","verdict":"ok","preuve":"Le composant gère bien le cas expiré (Champ.vue:42)."} : simple lecture du code, rien d’exécuté ; c’était « non-verifiable » au mieux.',
  '',
  'Exemple 2, « ko ». Critère C2 : « Le total du panier est arrondi au centime. »',
  '{"id":"C2","verdict":"ko","preuve":"npx vitest run tests/panier/total.test.ts → ✗ C2 : arrondit au centime, expected 10.005 to be 10.01 ; stores/panier.ts:88 additionne sans arrondir"}',
  'Juste : la commande échoue sur le critère, l’extrait le montre, la cause est située.',
  '',
  'Exemple 3, « non-verifiable ». Critère C3 : « La notification push arrive sur le téléphone après la réservation. »',
  '{"id":"C3","verdict":"non-verifiable","preuve":"Demande un appareil et le service de push ; aucune commande confirmée ne l’exerce. À côté : npx vitest run tests/notif/envoi.test.ts → 2 passed, l’appel à l’API d’envoi est fait."}',
  'Juste : la limite est dite, ce qui a été vérifié à côté est cité, sans conclure « ok ».',
  '',
  '## Réponse',
  'Quelques lignes au plus, puis un seul bloc json : un tableau, un objet par critère, dans l’ordre des critères.',
  '```json',
  '[{"id":"C1","verdict":"ok","preuve":"<commande> → <extrait de sortie>"}]',
  '```',
  'verdict vaut "ok", "ko" ou "non-verifiable" ; preuve : une ou deux phrases, 400 caractères au plus, avec la commande et l’extrait. Un critère sans verdict compte comme non vérifiable ; un « ok » sans preuve aussi.',
].join('\n')

/** Le diff --stat donné au vérificateur : 60 lignes au plus. */
const STAT_MAX = 60

/**
 * La tâche donnée au vérificateur : les critères, les fichiers du flow (git diff --stat), les commandes confirmées
 * qu'il peut lancer (argv exact ; « {fichiers} » = un ou plusieurs chemins) et, facultatif, les triches déjà repérées.
 */
export function verifierTask(criteres: Critere[], diffStat: string, commandes: VerifCommande[], triches: Triche[] = []): string {
  const stat = (typeof diffStat === 'string' ? diffStat : '').split(/\r?\n/).filter(l => l.trim() !== '')
  const statLignes = stat.length > STAT_MAX ? [...stat.slice(0, STAT_MAX), `… et ${stat.length - STAT_MAX} autres lignes (git diff --stat)`] : stat
  const cmds = (Array.isArray(commandes) ? commandes : []).filter(c => Array.isArray(c?.argv) && c.argv.length > 0)
  const ids = criteres.map(c => c.id).join(', ')
  return [
    '# Vérification du flow',
    '',
    'Critères d’acceptation à juger :',
    ...criteres.map(c => `- ${c.id} : ${c.texte}`),
    '',
    'Fichiers du flow (git diff --stat) :',
    ...(statLignes.length ? statLignes : ['(aucun fichier modifié)']),
    '',
    ...(cmds.length
      ? [
          'Commandes confirmées, à lancer telles quelles depuis la racine du projet (« {fichiers} » = un ou plusieurs chemins) :',
          ...cmds.map(c => `- ${c.argv.join(' ')} (${c.outil}, portée ${c.portee})`),
        ]
      : ['Aucune commande confirmée : seules les lectures sont permises ; un critère qui demande une exécution est non vérifiable.']),
    ...(triches.length
      ? ['', 'Triches repérées par revo-flow dans le diff (à confirmer et à citer dans la preuve) :', ...triches.map(t => `- ${t.motif} : ${t.fichier}${t.extrait ? ` (${t.extrait})` : ''}`)]
      : []),
    '',
    `Rends le bloc json avec un verdict pour ${ids}.`,
  ].join('\n')
}

/** JSON.parse tolérant : retente sans les virgules finales ; undefined si illisible. */
function lireJson(s: string): unknown {
  for (const essai of [s, s.replace(/,\s*([\]}])/g, '$1')]) {
    try {
      return JSON.parse(essai)
    } catch {
      // essai suivant
    }
  }
  return undefined
}

/** Les verdicts bruts d'une valeur JSON : tableau, { verdicts: [...] }, ou { C1: {...} | "ok" }. */
function entreesDe(v: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(v)) return v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  for (const k of ['verdicts', 'criteres', 'resultats', 'results']) if (Array.isArray(o[k])) return entreesDe(o[k])
  const parId = Object.entries(o).filter(([k]) => /^c?\s*\d+$/i.test(k.trim()))
  if (parId.length === 0) return undefined
  return parId.map(([id, x]) => (typeof x === 'object' && x !== null ? { id, ...(x as Record<string, unknown>) } : { id, verdict: x }))
}

const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
const VERDICT_OK = new Set(['ok', 'pass', 'passe', 'passed', 'vert', 'valide', 'true', '✓'])
const VERDICT_KO = new Set(['ko', 'fail', 'failed', 'echec', 'echoue', 'rouge', 'false', '✗'])
const PREUVE_MAX = 600

/** « c2 », « 2 », « C 2 » → « C2 ». */
const idDe = (x: unknown) => {
  const m = /^c?\s*(\d+)$/i.exec(String(x ?? '').trim())
  return m ? `C${Number(m[1])}` : String(x ?? '').trim().toUpperCase()
}

/**
 * Lit la réponse du vérificateur : le dernier bloc json lisible (```json ou ```), sinon le tableau ou l'objet du texte.
 * Un verdict par critère, dans l'ordre des critères : critère absent → non-verifiable ; « ok » sans preuve →
 * non-verifiable (une preuve s'exécute, §1) ; verdict inconnu → non-verifiable ; ids inconnus ignorés.
 */
export function parseVerdicts(text: string, criteres: Critere[]): CritereVerdict[] {
  const t = typeof text === 'string' ? text : ''
  const candidats = [...t.matchAll(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/g)].map(m => m[1]!).reverse()
  const crochet = t.indexOf('[')
  if (crochet >= 0 && t.lastIndexOf(']') > crochet) candidats.push(t.slice(crochet, t.lastIndexOf(']') + 1))
  const accolade = t.indexOf('{')
  if (accolade >= 0 && t.lastIndexOf('}') > accolade) candidats.push(t.slice(accolade, t.lastIndexOf('}') + 1))
  let entrees: Record<string, unknown>[] | undefined
  for (const c of candidats) {
    entrees = entreesDe(lireJson(c.trim()))
    if (entrees?.length) break
  }
  const parId = new Map<string, CritereVerdict>()
  for (const e of entrees ?? []) {
    const id = idDe(e.id ?? e.critere)
    const brut = sansAccents(String(e.verdict ?? e.statut ?? '').trim().toLowerCase())
    const preuve = String(e.preuve ?? e.proof ?? e.evidence ?? '').trim().slice(0, PREUVE_MAX)
    const verdict = VERDICT_OK.has(brut) ? 'ok' : VERDICT_KO.has(brut) ? 'ko' : 'non-verifiable'
    parId.set(
      id,
      verdict === 'ok' && !preuve ? { id, verdict: 'non-verifiable', preuve: 'verdict « ok » sans preuve exécutée' } : { id, verdict, preuve },
    )
  }
  const absent = entrees ? 'pas de verdict du vérificateur pour ce critère' : 'réponse du vérificateur illisible (pas de bloc json)'
  return criteres.map(c => parId.get(c.id) ?? { id: c.id, verdict: 'non-verifiable', preuve: absent })
}

// ── Testeur ──────────────────────────────────────────────────────────────

/**
 * La consigne ajoutée au brief d'un agent testeur (tâches de type test, §3). Tests écrits à partir des critères et des
 * interfaces, jamais calqués sur le code des implémenteurs (ExecCritic : les tests de l'agent lui-même nuisent).
 * Décision de l'utilisateur (2026-10-25) : les tests restent dans le dépôt après le flow.
 */
export const TESTER_BRIEF = [
  '# Ton rôle : testeur revo-flow',
  'Tu écris les tests qui diront si la feature est faite. Pars des critères d’acceptation du plan (C1, C2…) et des interfaces : signatures, types, schéma GraphQL, props, routes, spec. Ne pars pas du code que les implémenteurs écrivent : ne lis pas leurs fichiers pour calquer tes tests sur ce qu’ils font.',
  '- Au moins un test par critère, nommé d’après lui (ex. « C2 : arrondit le total au centime ») pour que le vérificateur s’y retrouve.',
  '- Tu n’écris que des fichiers de test (*.test.ts, *.spec.ts, *_test.dart, ou sous test/, tests/, __tests__/, integration_test/) : revo-flow refuse toute autre édition. Ne modifie jamais le code de production ; si une interface manque ou est ambiguë, dis-le dans ta réponse au lieu de la créer.',
  '- Suis les conventions de test du projet (framework, dossiers, aides existantes). Un test qui demande un serveur, une base ou un émulateur : signale-le dans ta réponse.',
  '- Des assertions précises sur le résultat attendu. Pas de .skip, .only, test.todo, ni de test qui passe quoi qu’il arrive.',
  '- Tes tests peuvent échouer tant que la feature n’est pas finie : c’est attendu, ne les affaiblis pas pour qu’ils passent.',
  '- À ta fin, revo-flow gèle tes fichiers de test : plus personne ne les modifie sans l’accord de l’utilisateur. Ils restent dans le dépôt après le flow.',
  '- Termine en listant tes fichiers de test et, pour chaque critère, le ou les tests qui le couvrent.',
].join('\n')
