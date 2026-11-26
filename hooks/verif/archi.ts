/**
 * La revue d'architecture (v3.2) : l'étape ARCHI du vérificateur, obligatoire à chaque flow vérifié. Le vérificateur juge si le code
 * de la branche (ou de la PR) respecte l'architecture du projet : fichiers au bon endroit, conventions suivies, rien de redéfini qui
 * existe déjà (types, fonctions, classes, composants). revo-flow lui prépare des indices factuels : un fichier rangé ailleurs que ses
 * semblables, un nom de fichier déjà présent, une définition qui existe déjà sous le même nom.
 * Module PUR : aucune référence à `$`, aucun accès disque ; les sorties de git viennent de l'appelant (register.tsx). Rien ne lève.
 */
import type { Critere } from '../../types/verif'

/** L'identifiant de l'étape d'architecture dans les verdicts du vérificateur. */
export const ARCHI_ID = 'ARCHI'

/** L'étape d'architecture, jugée comme un critère d'acceptation de plus, toujours présente. */
export const ARCHI_CRITERE: Critere = {
  id: ARCHI_ID,
  texte: 'Le code de la branche respecte l’architecture du projet : fichiers rangés au bon endroit, conventions suivies, rien de redéfini qui existe déjà (types, fonctions, composants).',
}

/** Les documents qui décrivent l'architecture d'un projet, dans l'ordre où le vérificateur les lit. */
export const ARCHI_DOCS = ['ARCHITECTURE.md', 'docs/architecture.md', 'docs/ARCHITECTURE.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'README.md']

/** Au plus tant d'indices de chaque sorte, et de noms cherchés en double. */
const INDICES_MAX = 12
const NOMS_MAX = 20

/** Un fichier du diff de la branche : A ajouté, M modifié, D supprimé, R renommé (avant = l'ancien chemin). */
export type ArchiFichier = { statut: 'A' | 'M' | 'D' | 'R'; p: string; avant?: string }

const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/^"(.*)"$/, '$1').replace(/^\.\//, '')
const dossier = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')
const nomDe = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** `git diff --name-status -M <base>` (et les fichiers non suivis, en « A ») → les fichiers de la branche. Lignes illisibles ignorées. */
export function parseNameStatus(text: string): ArchiFichier[] {
  const out: ArchiFichier[] = []
  for (const ligne of (typeof text === 'string' ? text : '').split(/\r?\n/)) {
    const cols = ligne.split('\t')
    const code = (cols[0] ?? '').trim().charAt(0)
    if (code === 'R' && cols[1] && cols[2]) out.push({ statut: 'R', p: norm(cols[2]), avant: norm(cols[1]) })
    else if ((code === 'A' || code === 'M' || code === 'D') && cols[1]) out.push({ statut: code, p: norm(cols[1]) })
  }
  return out
}

/**
 * La « sorte » d'un fichier, pour comparer son emplacement à celui de ses semblables : « *.service.ts » (suffixe à point),
 * « *_page.dart » (suffixe Dart), « use*.ts » (composable), « *.vue ». undefined pour un nom sans motif reconnaissable.
 */
export function fileKind(p: string): string | undefined {
  const nom = nomDe(norm(p))
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(nom) || nom.endsWith('_test.dart') || nom.endsWith('.d.ts')) return undefined
  const dart = /^[a-z0-9]+(?:_[a-z0-9]+)*_([a-z0-9]+)\.dart$/.exec(nom)
  if (dart) return `*_${dart[1]}.dart`
  const points = /^[^.]+(\.[a-z0-9-]+\.[cm]?[jt]sx?)$/i.exec(nom)
  if (points) return `*${points[1]}`
  const use = /^use[A-Z][A-Za-z0-9]*(\.[cm]?[jt]sx?)$/.exec(nom)
  if (use) return `use*${use[1]}`
  if (nom.endsWith('.vue')) return '*.vue'
  return undefined
}

/**
 * Les fichiers ajoutés rangés ailleurs que leurs semblables : au moins 3 fichiers de la même sorte existent dans le projet, et aucun
 * dans le dossier du nouveau. Ex. « src/utils/useCart.ts : les fichiers use*.ts du projet sont sous composables/ (12) ».
 */
export function placementHints(ajoutes: string[], existants: string[]): string[] {
  const nouveaux = new Set(ajoutes.map(norm))
  const parSorte = new Map<string, Map<string, number>>()
  for (const f of existants.map(norm)) {
    if (nouveaux.has(f)) continue
    const k = fileKind(f)
    if (!k) continue
    const dirs = parSorte.get(k) ?? new Map<string, number>()
    dirs.set(dossier(f), (dirs.get(dossier(f)) ?? 0) + 1)
    parSorte.set(k, dirs)
  }
  const out: string[] = []
  for (const p of [...nouveaux]) {
    const k = fileKind(p)
    const dirs = k ? parSorte.get(k) : undefined
    if (!k || !dirs) continue
    const total = [...dirs.values()].reduce((n, x) => n + x, 0)
    if (total < 3 || dirs.has(dossier(p))) continue
    const top = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, n]) => `${d}/ (${n})`)
    out.push(`${p} : les fichiers ${k} du projet sont sous ${top.join(', ')} ; celui-ci est sous ${dossier(p)}/`)
  }
  return out.slice(0, INDICES_MAX)
}

/** Les fichiers ajoutés dont le nom existe déjà ailleurs dans le projet (même nom, autre dossier) : un doublon possible. */
export function homonymHints(ajoutes: string[], existants: string[]): string[] {
  const nouveaux = new Set(ajoutes.map(norm))
  const parNom = new Map<string, string[]>()
  for (const f of existants.map(norm)) {
    if (nouveaux.has(f)) continue
    parNom.set(nomDe(f), [...(parNom.get(nomDe(f)) ?? []), f])
  }
  const generiques = /^(index|main|mod|types?|utils?|constants?|README)\.[a-z]+$|^__init__\.py$/i
  const out: string[] = []
  for (const p of nouveaux) {
    const deja = parNom.get(nomDe(p))
    if (!deja?.length || generiques.test(nomDe(p))) continue
    out.push(`${p} : un fichier du même nom existe déjà (${deja.slice(0, 3).join(', ')}${deja.length > 3 ? '…' : ''})`)
  }
  return out.slice(0, INDICES_MAX)
}

/**
 * Les noms définis par les lignes ajoutées : TypeScript et JavaScript (export interface, type, class, enum, function, const) et Dart
 * (class, enum, mixin, extension, typedef). Les noms d'une lettre ou génériques (Props, State, Options…) sont écartés.
 */
export function definedNames(ajouts: string[]): string[] {
  const vus = new Set<string>()
  const generiques = new Set(['Props', 'Emits', 'State', 'Options', 'Config', 'Params', 'Args', 'Data', 'Result', 'Default'])
  const ts = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|enum|function\*?|const|let)\s+([A-Za-z_$][\w$]*)/
  const dart = /^\s*(?:(?:abstract|sealed|final|base|interface)\s+)*(?:class|enum|mixin|extension|typedef)\s+([A-Za-z_]\w*)/
  for (const l of Array.isArray(ajouts) ? ajouts : []) {
    const m = ts.exec(l) ?? dart.exec(l)
    const nom = m?.[1]
    if (nom && nom.length > 2 && !generiques.has(nom)) vus.add(nom)
    if (vus.size >= NOMS_MAX) break
  }
  return [...vus]
}

/** Le motif git grep (-E) qui trouve la définition de ces noms, en TypeScript, JavaScript et Dart. undefined sans nom. */
export function definitionPattern(noms: string[]): string | undefined {
  const sur = noms.filter(n => /^[A-Za-z_$][\w$]*$/.test(n)).map(n => n.replace(/\$/g, '\\$'))
  if (!sur.length) return undefined
  return `(interface|type|class|enum|function|const|let|mixin|extension|typedef)[[:space:]]+(${sur.join('|')})([^A-Za-z0-9_$]|$)`
}

/**
 * La sortie de `git grep -n -E <definitionPattern>` → les définitions qui existaient déjà ailleurs : une par nom, hors des fichiers de la
 * branche où ce nom est défini (sa propre définition), et hors des tests. « type Panier (lib/x.ts) existe déjà : types/cart.ts:12 ».
 */
export function duplicateHints(grep: string, noms: string[], ouDefini: Record<string, string>): string[] {
  const out: string[] = []
  const faits = new Set<string>()
  for (const ligne of (typeof grep === 'string' ? grep : '').split(/\r?\n/)) {
    const m = /^(.+?):(\d+):(.*)$/.exec(ligne)
    if (!m) continue
    const [, fichier, num, code] = m
    const p = norm(fichier!)
    if (/\.(test|spec)\.|_test\.dart$|(^|\/)(tests?|__tests__)\//.test(p)) continue
    for (const nom of noms) {
      if (faits.has(nom) || ouDefini[nom] === p) continue
      const def = new RegExp(`(interface|type|class|enum|function|const|let|mixin|extension|typedef)\\s+${nom.replace(/\$/g, '\\$')}([^\\w$]|$)`)
      if (!def.test(code!)) continue
      const sorte = /(interface|type|class|enum|function|const|let|mixin|extension|typedef)\s/.exec(code!)?.[1] ?? 'définition'
      out.push(`${sorte} ${nom}${ouDefini[nom] ? ` (${ouDefini[nom]})` : ''} existe déjà : ${p}:${num}`)
      faits.add(nom)
    }
    if (out.length >= INDICES_MAX) break
  }
  return out
}

/** Ce que le paragraphe « Architecture » reçoit : la base de comparaison, les fichiers de la branche, les docs présents, les indices. */
export type ArchiContexte = {
  /** Le commit de base (merge-base avec la branche par défaut, sinon le commit de départ du flow). */
  base: string
  /** D'où vient la base : « main », « origin/main », « commit de départ du flow ». */
  baseLabel: string
  fichiers: ArchiFichier[]
  docs: string[]
  indices: string[]
}

/** Le paragraphe « ## Architecture (étape ARCHI, obligatoire) » de la tâche du vérificateur. */
export function archiTask(c: ArchiContexte): string {
  const court = (c.base || '').slice(0, 9)
  const fichiers = (c.fichiers ?? []).slice(0, 60).map(f => `- ${f.statut} ${f.avant ? `${f.avant} → ` : ''}${f.p}`)
  const reste = (c.fichiers ?? []).length > 60 ? [`- … et ${(c.fichiers ?? []).length - 60} autres`] : []
  return [
    '## Architecture (étape ARCHI, obligatoire)',
    `À chaque flow, juge aussi l’étape ${ARCHI_ID} : ${ARCHI_CRITERE.texte}`,
    `Base de comparaison : ${court} (${c.baseLabel}). Tout le code de la branche compte, pas seulement celui de ce flow : \`git diff --name-status -M ${court}\`, \`git diff ${court} -- <fichier>\`.`,
    '',
    'Fichiers de la branche :',
    ...(fichiers.length ? [...fichiers, ...reste] : ['(aucun)']),
    '',
    c.docs.length
      ? `Lis d’abord ce que le projet dit de son architecture : ${c.docs.join(', ')}.`
      : 'Le projet n’a pas de document d’architecture : déduis-la de l’arborescence (`git ls-files`, `git ls-tree -r --name-only ' + court + '`) et des fichiers voisins.',
    '',
    'Ce que tu vérifies, sur les fichiers ajoutés ou modifiés :',
    '- Emplacement : chaque fichier est rangé là où le projet range ses semblables (couche, dossier, module) ; pas de nouveau dossier qui double un dossier existant.',
    '- Conventions : nommage des fichiers et des symboles, découpage en couches (vue, état, service, données), imports dans le bon sens, pas de logique métier dans une vue si le projet la met ailleurs.',
    '- Réutilisation : rien de redéfini qui existe déjà (types, interfaces, modèles, fonctions utilitaires, composants, constantes) ; cherche avec `git grep -n -w <Nom>` avant de juger.',
    '- Ce qui est préexistant et que la branche ne touche pas n’est pas à juger.',
    ...(c.indices.length ? ['', 'Indices repérés par revo-flow (à confirmer, pas des verdicts) :', ...c.indices.map(i => `- ${i}`)] : []),
    '',
    `Verdict ${ARCHI_ID} : « ok » si, après avoir lu ces fichiers, rien ne contredit l’architecture ; « ko » en citant chaque problème (fichier, ce qui ne va pas, ce qui existe déjà avec chemin:ligne, où il faudrait le mettre) ; « non-verifiable » seulement si tu n’as pas pu lire le code.`,
  ].join('\n')
}
