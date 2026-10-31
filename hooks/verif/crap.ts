// Le score CRAP des fonctions (Change Risk Anti-Patterns, Savoia et Evans 2007) : cc² × (1 − couverture)³ + cc, seuil 30.
// La complexité cyclomatique vient d'un découpage tolérant du source (TS, JS, Vue, Dart) ; la couverture, des rapports
// istanbul (coverage-final.json) ou lcov (lcov.info) des tests liés. Règle du scout : seule une fonction modifiée par le flow
// au-dessus du seuil est « nouvelle » (bloque) ; une fonction identique à sa version du commit de départ est « preexistante »
// (montrée, ne bloque pas).
// Pur : ni `$`, ni fs. Les textes (version courante, version du commit de départ) et les rapports sont lus par l'appelant.
import type { VerifErreur } from '../../types/verif'
import { isTestFile } from './garde'
import { toRoot } from './parse'
import { DART_GENERE, norm } from './scope'

/** Au-delà, une fonction est trop risquée à changer : trop complexe pour ce que ses tests couvrent. */
export const CRAP_SEUIL = 30

/** cc² × (1 − cov)³ + cc ; cov borné à [0, 1] (une valeur non finie compte 0). */
export function crapScore(cc: number, cov: number): number {
  const c = Math.min(1, Math.max(0, Number.isFinite(cov) ? cov : 0))
  return cc * cc * (1 - c) ** 3 + cc
}

// ── Fichiers analysés ─────────────────────────────────────────────────────

/** Une fonction : lignes 1-indexées, inclusives (fin = ligne de l'accolade fermante), complexité cyclomatique. */
export type Fonction = { nom: string; debut: number; fin: number; cc: number }
export type Lang = 'ts' | 'dart'

const TS_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue'])

/** Le langage d'un fichier d'après son extension ; undefined si CRAP ne sait pas le lire. */
export function langOf(p: string): Lang | undefined {
  const n = norm(p)
  const nom = n.slice(n.lastIndexOf('/') + 1).toLowerCase()
  const i = nom.lastIndexOf('.')
  if (i < 0) return undefined
  const ext = nom.slice(i)
  if (ext === '.dart') return 'dart'
  return TS_EXT.has(ext) ? 'ts' : undefined
}

/** Le fichier est-il analysé ? Ni les tests, ni les Dart générés, ni les déclarations .d.ts (aucun corps de fonction). */
export function analysable(p: string): boolean {
  const n = norm(p)
  if (!langOf(n) || /\.d\.[cm]?ts$/.test(n)) return false
  return !isTestFile(n) && !/\.(test|spec)\./.test(n) && !DART_GENERE.test(n)
}

// ── Nettoyage : commentaires et chaînes ───────────────────────────────────
// Le texte garde sa longueur et ses sauts de ligne : un indice du texte nettoyé est un indice du texte d'origine.

const IDENT = /[\w$]/
const SPACE = /\s/
/** Après ces caractères, « / » ouvre une expression régulière (et non une division). */
const AVANT_REGEX = new Set([...'(,=:[!&|?{};+-*%~^}'])
const MOTS_AVANT_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'instanceof', 'new', 'delete', 'throw'])

type Scan = { src: string; out: string[]; lang: Lang }
/** Une chaîne en cours : délimiteur fermant, sur plusieurs lignes ou non, brute (r'…' Dart : ni \ ni ${}), avec ${} ou non. */
type Chaine = { close: string; multi: boolean; raw: boolean; interp: boolean }

/** Remplace par des espaces les caractères de [a, b[, sauts de ligne gardés. */
function blank(out: string[], a: number, b: number): void {
  for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
}

const skipWs = (s: string, k: number) => {
  while (k < s.length && SPACE.test(s[k]!)) k++
  return k
}
const prevNonWs = (s: string, k: number) => {
  while (k >= 0 && SPACE.test(s[k]!)) k--
  return k
}

/** Le mot qui finit en k (ou ''). */
function wordEndingAt(s: string, k: number): string {
  let d = k
  while (d >= 0 && IDENT.test(s[d]!)) d--
  return s.slice(d + 1, k + 1)
}

/** Commentaires et contenus de chaînes en espaces ; le code des interpolations (${…}) est gardé. */
function stripCode(text: string, lang: Lang): string {
  const sc: Scan = { src: text, out: text.split(''), lang }
  scanCode(sc, 0, false)
  return sc.out.join('')
}

/** Parcourt du code depuis i0 ; dans une interpolation, s'arrête sur l'accolade fermante et renvoie sa position. */
function scanCode(sc: Scan, i0: number, interp: boolean): number {
  let depth = 0
  let i = i0
  while (i < sc.src.length) {
    const c = sc.src[i]!
    if (interp && c === '}' && depth === 0) return i
    if (c === '{') depth++
    else if (c === '}') depth--
    const j = skipToken(sc, i)
    i = j > i ? j : i + 1
  }
  return i
}

/**
 * Si un commentaire, une chaîne ou une expression régulière commence en i : l'indice qui suit sa fin. Commentaires et
 * expressions régulières sont blanchis en entier ; d'une chaîne, seuls les délimiteurs restent (`? '' :` reste un ternaire).
 */
function skipToken(sc: Scan, i: number): number {
  const c = sc.src[i]
  if (c === '/') return skipSlash(sc, i)
  if (c === '"' || c === "'" || (c === '`' && sc.lang === 'ts')) return skipString(sc, i, i, false)
  if (c === 'r' && isRawStart(sc, i)) return skipString(sc, i, i + 1, true)
  return -1
}

/** r'…' ou r"…" en Dart (et non un identifiant qui finit par r). */
const isRawStart = (sc: Scan, i: number) => sc.lang === 'dart' && (sc.src[i + 1] === '"' || sc.src[i + 1] === "'") && !IDENT.test(sc.src[i - 1] ?? '')

function skipSlash(sc: Scan, i: number): number {
  const n = sc.src[i + 1]
  if (n === '/') return skipComment(sc, i, '\n', 0)
  if (n === '*') return skipComment(sc, i, '*/', 2)
  return sc.lang === 'ts' && regexAllowed(sc.out, i) ? skipRegex(sc, i) : -1
}

/** Un commentaire jusqu'à `fin` (gardée si c'est le saut de ligne, len 0 ; retirée sinon) ou la fin du texte. */
function skipComment(sc: Scan, i: number, fin: string, len: number): number {
  const e = sc.src.indexOf(fin, i + 2)
  const end = e < 0 ? sc.src.length : e + len
  blank(sc.out, i, end)
  return end
}

/** « / » en i ouvre-t-il une expression régulière ? D'après le dernier signe du code déjà nettoyé. */
function regexAllowed(out: string[], i: number): boolean {
  let k = i - 1
  while (k >= 0 && SPACE.test(out[k]!)) k--
  if (k < 0) return true
  const c = out[k]!
  if (AVANT_REGEX.has(c) || (c === '>' && out[k - 1] === '=')) return true
  let d = k
  while (d >= 0 && IDENT.test(out[d]!)) d--
  return MOTS_AVANT_REGEX.has(out.slice(d + 1, k + 1).join(''))
}

/** Une expression régulière littérale ; -1 si la ligne finit avant le « / » fermant (c'était une division). */
function skipRegex(sc: Scan, i: number): number {
  const { src } = sc
  let cls = false
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]
    if (c === '\n') return -1
    if (c === '\\') j++
    else if (c === '[') cls = true
    else if (c === ']') cls = false
    else if (c === '/' && !cls) return regexEnd(sc, i, j)
  }
  return -1
}

function regexEnd(sc: Scan, i: number, j: number): number {
  let e = j + 1
  while (e < sc.src.length && IDENT.test(sc.src[e]!)) e++
  blank(sc.out, i, e)
  return e
}

/** Une chaîne qui commence en `start` (préfixe r compris) et dont le délimiteur est en q. Non fermée : s'arrête au saut de ligne (ou à la fin). */
function skipString(sc: Scan, start: number, q: number, raw: boolean): number {
  const quote = sc.src[q]!
  const triple = sc.lang === 'dart' && sc.src.startsWith(quote.repeat(3), q)
  const ch: Chaine = { close: triple ? quote.repeat(3) : quote, multi: triple || quote === '`', raw, interp: !raw && (quote === '`' || sc.lang === 'dart') }
  let i = q + ch.close.length
  blank(sc.out, start, q)
  while (i < sc.src.length) {
    const r = stringStep(sc, i, ch)
    if (r.fin) return r.i
    i = r.i
  }
  return i
}

/** Un pas dans une chaîne : la position suivante, fin quand la chaîne se ferme. */
function stringStep(sc: Scan, i: number, ch: Chaine): { i: number; fin: boolean } {
  const { src, out } = sc
  const c = src[i]!
  if (c === '\n' && !ch.multi) return { i, fin: true }
  if (c === '\\' && !ch.raw) {
    blank(out, i, i + 2)
    return { i: i + 2, fin: false }
  }
  if (src.startsWith(ch.close, i)) return { i: i + ch.close.length, fin: true }
  if (ch.interp && src.startsWith('${', i)) return { i: skipInterp(sc, i), fin: false }
  blank(out, i, i + 1)
  return { i: i + 1, fin: false }
}

/** ${…} : le code est gardé (il peut contenir des chaînes, des fonctions fléchées), « ${ » et « } » blanchis. */
function skipInterp(sc: Scan, i: number): number {
  blank(sc.out, i, i + 2)
  const end = scanCode(sc, i + 2, true)
  blank(sc.out, end, end + 1)
  return end + 1
}

/** Un composant Vue (SFC) : une ligne qui commence par <script. */
const VUE_SCRIPT = /^[ \t]*<script\b/im

/** Vue : seuls les blocs <script …>…</script> restent, le reste devient des espaces (sauts de ligne gardés). */
function scriptsOnly(text: string): string {
  const out = text.replace(/[^\n]/g, ' ').split('')
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const debut = m.index + m[0].indexOf('>') + 1
    for (let k = 0; k < m[1]!.length; k++) out[debut + k] = text[debut + k]!
  }
  return out.join('')
}

// ── Appariement et lignes ─────────────────────────────────────────────────

const OUVRANTE: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const FERMANTES = new Set([')', ']', '}'])

/**
 * Appariement des parenthèses, crochets et accolades du code nettoyé : m[ouvrante] = fermante, m[fermante] = ouvrante.
 * Tolérant : une fermante orpheline est ignorée ; une ouvrante non fermée va jusqu'à la fin du texte.
 */
function pairsOf(s: string): Int32Array {
  const m = new Int32Array(s.length).fill(-1)
  const pile: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '(' || c === '[' || c === '{') pile.push(i)
    else if (FERMANTES.has(c)) closeAt(s, m, pile, i)
  }
  for (const o of pile) m[o] = s.length - 1
  return m
}

/** Ferme l'ouvrante du même type la plus proche ; celles restées ouvertes au-dessus se ferment avec elle. */
function closeAt(s: string, m: Int32Array, pile: number[], i: number): void {
  let k = pile.length - 1
  while (k >= 0 && OUVRANTE[s[pile[k]!]!] !== s[i]) k--
  if (k < 0) return
  m[i] = pile[k]!
  for (const o of pile.splice(k)) m[o] = i
}

function lineStarts(s: string): number[] {
  const r = [0]
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') r.push(i + 1)
  return r
}

/** La ligne (1-indexée) de l'indice idx. */
function lineAt(starts: number[], idx: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= idx) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

// ── Détection des fonctions ───────────────────────────────────────────────
// Le texte est parcouru comme un conteneur (module, classe, objet, bloc de premier niveau) : une parenthèse suivie d'un corps
// en accolades (après un éventuel type de retour TS, une liste d'initialisation ou async Dart) ou de « => { » ouvre une
// fonction ; son corps est sauté d'un bloc. Les fonctions imbriquées (callbacks, fonctions internes) ne sont donc pas
// séparées : leur complexité compte dans la fonction englobante.

type Ctx = { s: string; m: Int32Array; lang: Lang; starts: number[]; out: Fonction[] }
type Tete = { nom: string; debut: number }

/** Les mots qui, devant une parenthèse, ouvrent une structure de contrôle et non une fonction. */
const CONTROLE = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'await', 'yield', 'do', 'else', 'new', 'throw', 'in', 'of', 'case', 'delete', 'void', 'assert', 'super', 'this', 'when'])
/** Devant une parenthèse, une fonction sans nom propre (son nom vient de l'affectation ou de la propriété, sinon anonyme). */
const SANS_NOM = new Set(['', 'function', 'async'])
/** Mots d'un type TS (ou d'une liste d'initialisation) après lesquels un opérande est encore attendu. */
const MOTS_TYPE = new Set(['is', 'extends', 'keyof', 'typeof', 'infer', 'asserts', 'readonly', 'unique', 'new', 'in', 'as'])
const GROUPES = new Set(['{', '(', '['])
const FINS_TYPE = new Set([';', '}', ')', ']'])
const MODIFICATEURS = /^(?:async|sync)\b\s*\*?\s*/
const PREMIER_NOM = /^\s*(?:(?:export|default|declare|const|let|var|static|readonly|private|public|protected|override|abstract|late|final)\s+)*([\w$#]+)\s*[?!]?\s*:/
const DERNIER_NOM = /([\w$#]+)\s*[?!]?\s*$/
const DART_GETTER = /\bget\s+([\w$]+)\s*(?:async\*?|sync\*)?\s*$/

/**
 * Les fonctions d'un source, dans l'ordre. Tolérant : texte mal formé accepté, jamais d'exception. Vue (une ligne qui
 * commence par <script) : seuls les blocs script sont lus, lignes d'origine gardées. Fonctions fléchées à expression
 * (sans accolades) et fonctions Dart `=>` d'une ligne : ignorées (complexité minime).
 */
export function functionsOf(text: string, lang: Lang): Fonction[] {
  try {
    const src = lang === 'ts' && VUE_SCRIPT.test(text) ? scriptsOnly(text) : text
    const s = stripCode(src, lang)
    const cx: Ctx = { s, m: pairsOf(s), lang, starts: lineStarts(s), out: [] }
    walk(cx)
    return cx.out
  } catch {
    return []
  }
}

function walk(cx: Ctx): void {
  let i = 0
  while (i < cx.s.length) {
    const c = cx.s[i]
    const j = c === '(' ? atParen(cx, i) : c === '{' ? atBrace(cx, i) : i
    i = Math.max(i, j) + 1
  }
}

/** Une parenthèse : si elle ouvre les paramètres d'une fonction, la fonction est enregistrée et son corps sauté. */
function atParen(cx: Ctx, o: number): number {
  const corps = bodyAfter(cx, cx.m[o]!)
  if (!corps) return o
  const tete = headOf(cx, o, corps.fleche)
  return tete ? emit(cx, tete, corps.ouvre) : o
}

/** Une accolade atteinte sans parenthèse : `x => {`, getter Dart `get x {` ; sinon un conteneur où l'on entre. */
function atBrace(cx: Ctx, p: number): number {
  const { s } = cx
  const k = prevNonWs(s, p - 1)
  if (cx.lang === 'ts' && s[k] === '>' && s[k - 1] === '=') return emit(cx, arrowParamHead(cx, k - 1), p)
  if (cx.lang !== 'dart') return p
  const debutLigne = cx.starts[lineAt(cx.starts, p) - 1]!
  const get = DART_GETTER.exec(s.slice(debutLigne, p))
  return get ? emit(cx, { nom: get[1]!, debut: skipWs(s, debutLigne) }, p) : p
}

/** Enregistre la fonction (de debut à l'accolade fermante de son corps) ; renvoie la position de cette accolade. */
function emit(cx: Ctx, tete: Tete, ouvre: number): number {
  const fin = Math.max(cx.m[ouvre]!, ouvre)
  cx.out.push({ nom: tete.nom, debut: lineAt(cx.starts, tete.debut), fin: lineAt(cx.starts, fin), cc: complexity(cx, tete.debut, fin) })
  return fin
}

/** Le corps qui suit la parenthèse fermante `close` : `{` direct (ou après type de retour, initialisation, async) ou `=> {` (TS). */
function bodyAfter(cx: Ctx, close: number): { ouvre: number; fleche: boolean } | undefined {
  const { s } = cx
  let k = skipWs(s, close + 1)
  if (s[k] === ':') k = skipType(cx, k + 1)
  if (k < 0) return undefined
  const mod = MODIFICATEURS.exec(s.slice(k, k + 16))
  if (mod) k += mod[0].length
  if (s[k] === '{') return { ouvre: k, fleche: false }
  if (cx.lang !== 'ts' || !s.startsWith('=>', k)) return undefined
  const j = skipWs(s, k + 2)
  return s[j] === '{' ? { ouvre: j, fleche: true } : undefined
}

/** Le nom et le début d'une fonction dont les paramètres s'ouvrent en o ; undefined pour if (…) {, for (…) {, catch (…) {… */
function headOf(cx: Ctx, o: number, fleche: boolean): Tete | undefined {
  const id = identBefore(cx.s, o)
  if (fleche || SANS_NOM.has(id.nom)) return arrowName(cx, id.i)
  if (CONTROLE.has(id.nom)) return undefined
  return { nom: id.nom, debut: id.i }
}

/** L'identifiant juste avant la parenthèse o (génériques <T> sautés, noms à points Dart gardés) et où commence la tête. */
function identBefore(s: string, o: number): { nom: string; i: number } {
  let k = prevNonWs(s, o - 1)
  let i = o
  if (s[k] === '>' && s[k - 1] !== '=') {
    const g = genericStart(s, k)
    if (g < 0) return { nom: '', i: o }
    i = g
    k = prevNonWs(s, g - 1)
  }
  let d = k
  while (d >= 0 && /[\w$#.]/.test(s[d]!)) d--
  const nom = s.slice(d + 1, k + 1).replace(/^\.+|\.+$/g, '')
  return nom ? { nom, i: d + 1 } : { nom: '', i }
}

/** Le « < » qui ouvre le générique fermé en k ; -1 si introuvable. */
function genericStart(s: string, k: number): number {
  let depth = 0
  for (let j = k; j >= 0 && k - j < 400; j--) {
    if (s[j] === '>' && s[j - 1] !== '=') depth++
    else if (s[j] === '<') depth--
    if (depth === 0) return j
    if (s[j] === ';') return -1
  }
  return -1
}

/** Le nom d'une fonction sans nom propre qui commence en start : `nom = …`, `nom: …`, sinon « (anonyme l.N) ». */
function arrowName(cx: Ctx, start: number): Tete {
  const { s } = cx
  let k = prevNonWs(s, start - 1)
  if (wordEndingAt(s, k) === 'async') k = prevNonWs(s, k - 5)
  const affecte = s[k] === '=' && !'=!<>'.includes(s[k - 1] ?? ' ')
  const tete = affecte ? namedBefore(cx, k, true) : s[k] === ':' ? namedBefore(cx, k, false) : undefined
  return tete ?? { nom: `(anonyme l.${lineAt(cx.starts, start)})`, debut: start }
}

/**
 * Le nom devant le « = » ou le « : » en k, lu sur sa ligne : `const f: Type = …` → f (premier nom quand une annotation
 * suit), `f = …` et `f: …` → le dernier nom. Début = premier caractère de la ligne.
 */
function namedBefore(cx: Ctx, k: number, affecte: boolean): Tete | undefined {
  const debutLigne = cx.starts[lineAt(cx.starts, k) - 1]!
  const seg = cx.s.slice(debutLigne, k)
  const m = affecte && seg.includes(':') ? PREMIER_NOM.exec(seg) : DERNIER_NOM.exec(seg)
  return m ? { nom: m[1]!, debut: skipWs(cx.s, debutLigne) } : undefined
}

/** La tête d'une fonction fléchée dont le « => » finit en eq + 1 : `(…) =>` ou `x =>`. */
function arrowParamHead(cx: Ctx, eq: number): Tete {
  const { s, m } = cx
  const j = prevNonWs(s, eq - 1)
  if (s[j] === ')' && m[j]! >= 0) return headOf(cx, m[j]!, true) ?? arrowName(cx, m[j]!)
  let d = j
  while (d >= 0 && IDENT.test(s[d]!)) d--
  return arrowName(cx, d + 1)
}

// Le type de retour TS (ou la liste d'initialisation Dart) entre « ) : » et le corps. Une accolade qui arrive quand un
// opérande est attendu (après « : », « | », « < »…) fait partie du type ; après un opérande complet, c'est le corps.
/** attend : un opérande est attendu ; angle : profondeur des génériques ; fn : l'opérande précédent est une parenthèse (type fonction `() => T`). */
type TypeEtat = { attend: boolean; angle: number; fn: boolean }
type Pas = { k: number; fin: boolean }

/** La position du corps (`{` ou `=>`) après un type commencé en k0 ; -1 s'il n'y a pas de corps (déclaration seule). */
function skipType(cx: Ctx, k0: number): number {
  const st: TypeEtat = { attend: true, angle: 0, fn: false }
  let k = k0
  while (k < cx.s.length) {
    const r = typeStep(cx, st, k)
    if (r.fin) return r.k
    k = r.k
  }
  return -1
}

function typeStep(cx: Ctx, st: TypeEtat, k: number): Pas {
  const c = cx.s[k]!
  if (cx.s.startsWith('=>', k)) return arrowInType(st, k)
  if (st.angle > 0) return angleStep(st, c, k)
  if (GROUPES.has(c)) return groupInType(cx, st, k)
  if (FINS_TYPE.has(c)) return { k: -1, fin: true }
  if (IDENT.test(c)) return identInType(cx, st, k)
  punctInType(st, c)
  return { k: k + 1, fin: false }
}

/** Ponctuation d'un type : « < » ouvre un générique ; après | & , . ? : = un opérande est attendu, pas après > ni !. */
function punctInType(st: TypeEtat, c: string): void {
  if (SPACE.test(c)) return
  st.fn = false
  if (c === '<') st.angle = 1
  else st.attend = c !== '>' && c !== '!'
}

/** « => » : dans un générique ou après une parenthèse de type (`(): () => void {`), un type fonction ; sinon le corps d'une fléchée. */
function arrowInType(st: TypeEtat, k: number): Pas {
  if (st.angle === 0 && !st.fn) return { k, fin: true }
  st.attend = true
  st.fn = false
  return { k: k + 2, fin: false }
}

function angleStep(st: TypeEtat, c: string, k: number): Pas {
  if (c === '<') st.angle++
  else if (c === '>') st.angle--
  if (st.angle === 0) st.attend = false
  return { k: k + 1, fin: false }
}

function groupInType(cx: Ctx, st: TypeEtat, k: number): Pas {
  if (cx.s[k] === '{' && !st.attend) return { k, fin: true }
  st.fn = cx.s[k] === '(' && st.attend
  st.attend = false
  return { k: Math.max(cx.m[k]!, k) + 1, fin: false }
}

/** Un mot dans le type : deux opérandes de suite (`void` puis `foo`), ce n'était pas un type : pas de corps. */
function identInType(cx: Ctx, st: TypeEtat, k: number): Pas {
  let e = k
  while (e < cx.s.length && IDENT.test(cx.s[e]!)) e++
  const mot = cx.s.slice(k, e)
  st.fn = false
  if (MOTS_TYPE.has(mot)) st.attend = true
  else if (!st.attend) return { k: -1, fin: true }
  else st.attend = false
  return { k: e, fin: false }
}

// ── Complexité cyclomatique ───────────────────────────────────────────────
// cc = 1 + if (else if compte comme un if), for, while, do (le while d'un do … while ne recompte pas), case, catch,
// on sans catch (Dart), &&, ||, ?? (et leurs affectations &&=, ||=, ??=), ? ternaire (ni ?. ni ?: optionnel ni ? nullable Dart).

const CC_TOKENS = /(?<![\w$.])(?:if|for|while|do|case|catch|on)(?![\w$])|&&|\|\||\?\?|\?/g
const PAS_TERNAIRE = new Set([':', ')', ',', ';', ']', '>', '=', ''])

function complexity(cx: Ctx, a: number, b: number): number {
  let cc = 1
  for (const t of cx.s.slice(a, b + 1).matchAll(CC_TOKENS)) cc += tokenWeight(cx, t[0], a + t.index!)
  return cc
}

function tokenWeight(cx: Ctx, tok: string, i: number): number {
  if (tok === '?') return isTernary(cx, i) ? 1 : 0
  if (tok === 'while') return closesDo(cx, i) ? 0 : 1
  if (tok === 'on') return dartOn(cx, i) ? 1 : 0
  return 1
}

/** Un « ? » ternaire : ni ?. ni ?: (optionnel TS) ni a?) ; en Dart, précédé d'un espace (String? est un type nullable). */
function isTernary(cx: Ctx, i: number): boolean {
  const { s } = cx
  if (s[i + 1] === '.' || s[i - 1] === '?') return false
  if (cx.lang === 'dart' && !SPACE.test(s[i - 1] ?? '')) return false
  return !PAS_TERNAIRE.has(s[skipWs(s, i + 1)] ?? '')
}

/** Le while de `do { … } while (…)` : déjà compté par le do. */
function closesDo(cx: Ctx, i: number): boolean {
  const k = prevNonWs(cx.s, i - 1)
  if (cx.s[k] !== '}' || cx.m[k]! < 0) return false
  return wordEndingAt(cx.s, prevNonWs(cx.s, cx.m[k]! - 1)) === 'do'
}

/** `on Type {` Dart (gestionnaire sans catch) : après l'accolade d'un try ; `on Type catch (e)` ne compte que par son catch. */
function dartOn(cx: Ctx, i: number): boolean {
  if (cx.lang !== 'dart' || cx.s[prevNonWs(cx.s, i - 1)] !== '}') return false
  const brace = cx.s.indexOf('{', i)
  return !/\bcatch\b/.test(cx.s.slice(i + 2, brace < 0 ? undefined : brace))
}

// ── Couverture ────────────────────────────────────────────────────────────

/** Fichier relatif à la racine (norm) → ligne → hits. */
export type Couverture = Map<string, Map<number, number>>
type CouvCtx = { racine?: string; cwd?: string }
type IstanbulStatement = { start?: { line?: number }; end?: { line?: number } }
type IstanbulFichier = { path?: string; statementMap?: Record<string, IstanbulStatement>; s?: Record<string, number> }

/** Le format d'un rapport d'après son nom : coverage-final.json → istanbul, lcov.info et *.lcov → lcov. */
export function coverageFormatOf(nomFichier: string): 'istanbul' | 'lcov' | undefined {
  const n = norm(nomFichier)
  const nom = n.slice(n.lastIndexOf('/') + 1).toLowerCase()
  if (nom === 'coverage-final.json') return 'istanbul'
  return nom === 'lcov.info' || nom.endsWith('.lcov') ? 'lcov' : undefined
}

/** Parmi les noms des fichiers d'un dossier, les rapports de couverture lisibles. */
export function coverageFiles(noms: string[]): string[] {
  return noms.filter(n => coverageFormatOf(n) !== undefined)
}

/** Un rapport de couverture lu en lignes ; chemins rendus relatifs à la racine (absolus, ou relatifs au cwd du lancement). Illisible : carte vide. */
export function coverageOf(text: string, format: 'istanbul' | 'lcov', ctx: CouvCtx): Couverture {
  try {
    return format === 'istanbul' ? istanbul(text, ctx) : lcov(text, ctx)
  } catch {
    return new Map()
  }
}

/** La clé d'un fichier de couverture : relative à la racine. Le cwd du lancement peut être relatif à la racine (runner) ou absolu : il est ramené à la racine d'abord. */
const fileKey = (p: string, ctx: CouvCtx) => {
  const cwd = ctx.cwd ? toRoot(ctx.cwd, { cwd: '', racine: ctx.racine }) : ''
  return norm(toRoot(p, { cwd, racine: ctx.racine }))
}

function linesOf(c: Couverture, fichier: string): Map<number, number> {
  let m = c.get(fichier)
  if (!m) {
    m = new Map()
    c.set(fichier, m)
  }
  return m
}

/** coverage-final.json : `{ "<chemin>": { statementMap, s, fnMap, f } }`. */
function istanbul(text: string, ctx: CouvCtx): Couverture {
  const j = JSON.parse(text.replace(/^﻿/, '')) as Record<string, IstanbulFichier> | null
  const out: Couverture = new Map()
  if (!j || typeof j !== 'object') return out
  for (const [cle, f] of Object.entries(j)) {
    if (!f || typeof f !== 'object' || !f.statementMap) continue
    mergeCoverage(out, new Map([[fileKey(f.path ?? cle, ctx), statementLines(f)]]))
  }
  return out
}

/**
 * Les lignes d'un fichier istanbul : chaque statement donne ses lignes start..end et ses hits. Sur une ligne couverte par
 * plusieurs statements, le plus court l'emporte (un if qui englobe son bloc ne masque pas un statement interne jamais
 * exécuté) ; à longueur égale (deux statements sur la même ligne), le max des hits.
 */
function statementLines(f: IstanbulFichier): Map<number, number> {
  const portee = new Map<number, number>()
  const out = new Map<number, number>()
  for (const [id, st] of Object.entries(f.statementMap ?? {})) {
    const span = spanOf(st)
    if (!span) continue
    const [a, b] = span
    const hits = Number(f.s?.[id] ?? 0) || 0
    for (let l = a; l <= b; l++) keepLine(out, portee, l, b - a, hits)
  }
  return out
}

/** Les lignes start..end d'un statement istanbul ; undefined s'il est illisible. */
function spanOf(st: IstanbulStatement | undefined): [number, number] | undefined {
  const a = Number(st?.start?.line)
  const b = Number(st?.end?.line ?? a)
  return a > 0 && b >= a && b - a <= 100000 ? [a, b] : undefined
}

function keepLine(out: Map<number, number>, portee: Map<number, number>, l: number, len: number, hits: number): void {
  const p = portee.get(l)
  if (p === undefined || len < p) {
    portee.set(l, len)
    out.set(l, hits)
  } else if (len === p) out.set(l, Math.max(out.get(l) ?? 0, hits))
}

/** lcov : `SF:<chemin>`, `DA:<ligne>,<hits>[,somme]`, `end_of_record` ; CRLF toléré. */
function lcov(text: string, ctx: CouvCtx): Couverture {
  const out: Couverture = new Map()
  let cur: Map<number, number> | undefined
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim()
    if (l.startsWith('SF:')) cur = linesOf(out, fileKey(l.slice(3), ctx))
    else if (l === 'end_of_record') cur = undefined
    else if (cur && l.startsWith('DA:')) addHits(cur, l.slice(3))
  }
  return out
}

function addHits(cur: Map<number, number>, da: string): void {
  const [l, h] = da.split(',')
  const ligne = Number(l)
  const hits = Number(h)
  if (Number.isInteger(ligne) && ligne > 0 && Number.isFinite(hits)) cur.set(ligne, Math.max(cur.get(ligne) ?? 0, hits))
}

/** Fusionne `from` dans `into` (plusieurs lancements, plusieurs paquets) : ligne par ligne, le max des hits. Renvoie `into`. */
export function mergeCoverage(into: Couverture, from: Couverture): Couverture {
  for (const [f, lignes] of from) {
    const cible = linesOf(into, f)
    for (const [l, h] of lignes) cible.set(l, Math.max(cible.get(l) ?? 0, h))
  }
  return into
}

/** Part des lignes instrumentées de la fonction exécutées au moins une fois ; undefined si aucune ligne instrumentée. */
export function fnCoverage(fn: Fonction, lignes: Map<number, number> | undefined): number | undefined {
  if (!lignes) return undefined
  let n = 0
  let ok = 0
  for (let l = fn.debut; l <= fn.fin; l++) {
    const h = lignes.get(l)
    if (h === undefined) continue
    n++
    if (h > 0) ok++
  }
  return n ? ok / n : undefined
}

// ── Score et classement ───────────────────────────────────────────────────

export type CrapFonction = Fonction & { cov: number | undefined; crap: number; touchee: boolean }

/** La clé d'une fonction pour la comparaison avec le commit de départ : nom et texte ; une anonyme (nom lié à sa ligne) par son texte seul. */
const versionKey = (nom: string, texte: string) => (nom.startsWith('(anonyme') ? `(anonyme)\n${texte}` : `${nom}\n${texte}`)

/** Le texte des lignes debut..fin, espaces de fin et CRLF retirés. */
const fnText = (lignes: string[], fn: Fonction) =>
  lignes
    .slice(fn.debut - 1, fn.fin)
    .map(l => l.replace(/\s+$/, ''))
    .join('\n')

/** Les versions (nom et texte) des fonctions d'un source. */
function versionsOf(text: string, lang: Lang): Set<string> {
  const lignes = text.split(/\r?\n/)
  return new Set(functionsOf(text, lang).map(fn => versionKey(fn.nom, fnText(lignes, fn))))
}

/**
 * Le score CRAP de chaque fonction de `maintenant`. cov undefined (aucune ligne instrumentée) compte 0 : non testée = risque
 * maximal. touchee : fichier nouveau (avant undefined), ou aucune fonction de `avant` n'a le même nom et le même texte.
 */
export function crapOf(fichier: string, maintenant: string, avant: string | undefined, couv: Couverture, lang: Lang): CrapFonction[] {
  const lignesCouv = couv.get(norm(fichier))
  const versions = avant === undefined ? undefined : versionsOf(avant, lang)
  const lignes = maintenant.split(/\r?\n/)
  return functionsOf(maintenant, lang).map(fn => {
    const cov = fnCoverage(fn, lignesCouv)
    const touchee = !versions || !versions.has(versionKey(fn.nom, fnText(lignes, fn)))
    return { ...fn, cov, crap: crapScore(fn.cc, cov ?? 0), touchee }
  })
}

const pctOf = (cov: number | undefined) => Math.round((cov ?? 0) * 100)

/** Une erreur par fonction au-dessus du seuil : nouvelle si le flow l'a touchée, preexistante sinon (règle du scout). */
export function crapErreurs(fichier: string, fns: CrapFonction[], seuil = CRAP_SEUIL): VerifErreur[] {
  return fns
    .filter(f => f.crap > seuil)
    .map(
      (f): VerifErreur => ({
      outil: 'crap',
      fichier,
      code: 'CRAP',
      message: `${f.nom} : CRAP ${Math.round(f.crap)} (complexité ${f.cc}, couverture ${pctOf(f.cov)} %${f.cov === undefined ? ', non testée' : ''})`,
      ligne: f.debut,
      statut: f.touchee ? 'nouvelle' : 'preexistante',
    }),
    )
}

/** La plus grande complexité qui passe toujours le seuil (cc² + cc ≤ seuil) : 5 pour 30. */
const ccToujoursOk = (seuil: number) => Math.max(0, Math.floor((Math.sqrt(1 + 4 * seuil) - 1) / 2))

const markOf = (f: CrapFonction, seuil: number) => (f.crap <= seuil ? ' ' : f.touchee ? '✗' : '⚠')
const covText = (cov: number | undefined) => (cov === undefined ? 'non testée' : `${pctOf(cov)} %`)

/** La table d'un fichier : marque, nom, lignes, cc, couverture, CRAP ; colonnes numériques alignées à droite. */
function fileTable(fichier: string, fns: CrapFonction[], seuil: number): string[] {
  if (!fns.length) return [fichier, '  aucune fonction']
  const rows = [[' ', 'fonction', 'lignes', 'cc', 'couverture', 'CRAP'], ...fns.map(f => [markOf(f, seuil), f.nom.slice(0, 48), `${f.debut}-${f.fin}`, String(f.cc), covText(f.cov), String(Math.round(f.crap))])]
  const larg = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)))
  const cell = (c: string, i: number) => (i >= 3 ? c.padStart(larg[i]!) : c.padEnd(larg[i]!))
  return [fichier, ...rows.map(r => `  ${r.map(cell).join('  ')}`.trimEnd())]
}

/** La sortie complète (le .txt de la commande) : une table par fichier, puis la formule et la règle du scout. */
export function crapText(resultats: { fichier: string; fns: CrapFonction[] }[], seuil = CRAP_SEUIL): string {
  const out: string[] = []
  for (const r of resultats) out.push(...fileTable(r.fichier, r.fns, seuil), '')
  if (!resultats.length) out.push('Aucune fonction analysée.', '')
  out.push(
    `CRAP = cc² × (1 − couverture)³ + cc (Savoia et Evans, 2007) ; seuil ${seuil} : une fonction de complexité ≤ ${ccToujoursOk(seuil)} passe toujours.`,
    '✗ fonction modifiée par le flow, au-dessus du seuil : bloque. ⚠ fonction inchangée depuis le commit de départ, au-dessus du seuil : montrée, ne bloque pas (règle du scout).',
    'non testée : aucune ligne de la fonction dans les rapports de couverture des tests liés ; comptée 0 %.',
  )
  return out.join('\n')
}

// ── Lancement des tests avec couverture ───────────────────────────────────

/** Les options qui font écrire la couverture des tests dans `dir` (le jeton « {sorties}/couverture », remplacé par le runner). */
export function coverageArgs(outil: 'vitest' | 'jest' | 'flutter', dir: string): string[] {
  if (outil === 'vitest') return ['--coverage.enabled=true', '--coverage.reporter=json', `--coverage.reportsDirectory=${dir}`]
  if (outil === 'jest') return ['--coverage', '--coverageReporters=json', `--coverageDirectory=${dir}`]
  return ['--coverage', `--coverage-path=${dir}/lcov.info`]
}
