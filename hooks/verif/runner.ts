// L'exécuteur de la porte (docs/rd-v2/conception.md §7, §10, §11) : lance chaque commande sur sa portée, lit la sortie, classe contre la base,
// relance une fois seuls les tests rouges, apprend les durées et écrit la sortie complète en .txt.
// Pas de `$` ici (le moteur ne le suit pas à travers un import) : register.tsx construit un VerifIo dont chaque méthode appelle $.process, $.fs, $.clock.
import type { ProjetVerif, VerifBase, VerifCommande, VerifErreur, VerifEtatCommande, VerifResultat } from '../../types/verif'
import { baseFor, classify } from './base'
import { parseOutput, signatureKey } from './parse'
import { dureeText } from './report'
import { FICHIERS, norm, plan, toolOf, withShell, type Lancement } from './scope'

/** Ce que la vérification demande au moteur. racine : chemin absolu du projet ; sorties : dossier absolu ~/.claude/revo-flow/verif/<flow>. */
export type VerifIo = {
  run(argv: string[], init: { cwd: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>
  write(path: string, text: string): Promise<void>
  list?(dir: string): Promise<string[]>
  remove?(path: string): Promise<void>
  now(): Promise<number>
  os: 'windows' | 'posix'
  racine: string
  sorties: string
}

/** Plafond de $.process.run (cc:3591-3592) ; plancher d'un délai appris. */
export const RUN_MAX_MS = 600_000
const RUN_MIN_MS = 60_000
/** Au-delà de cette durée apprise, la commande devrait passer par spawn (§7) : VerifIo n'expose que run pour l'instant, c'est noté. */
export const SPAWN_SEUIL_MS = 300_000
/** Un .txt écrit par $.fs.write : 4 MiB au plus. */
const MAX_SORTIE = 4 * 1024 * 1024 - 64 * 1024
/** Erreurs préexistantes gardées dans le résultat (les compteurs restent exacts). */
const MAX_PREEXISTANTES = 200
/** Tests instables retenus dans projet.verif. */
const MAX_INSTABLES = 100
/** Codes de sortie d'une commande introuvable (sh, cmd.exe). */
const INTROUVABLE = new Set([127, 9009])
/** Ordre d'exécution : la génération avant le typage, les tests en dernier. */
const ORDRE = ['generation', 'format', 'lint', 'typage', 'tests']

/** Moyenne glissante des durées de la commande, en ms (undefined si jamais lancée). */
export function durationOf(verif: ProjetVerif | undefined, id: string): number | undefined {
  return verif?.commandes.find(c => c.id === id)?.dureeMs
}

/** Le délai d'un lancement : 3 fois la durée apprise, entre 1 et 10 min ; 10 min sans durée connue. */
export function timeoutOf(dureeMs: number | undefined): number {
  if (!dureeMs) return RUN_MAX_MS
  return Math.min(RUN_MAX_MS, Math.max(RUN_MIN_MS, Math.round(dureeMs * 3)))
}

const sepOf = (io: Pick<VerifIo, 'os'>) => (io.os === 'windows' ? '\\' : '/')
/** Un chemin de l'hôte : dossier absolu + morceaux relatifs à « / », au séparateur de l'OS. */
const joinPath = (io: Pick<VerifIo, 'os'>, dir: string, rel: string) => {
  const sep = sepOf(io)
  return rel ? `${dir.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}` : dir
}

/**
 * argv de la commande sur tout le projet, pour la base de référence : '{fichiers}' devient '.' pour ESLint, Biome, Prettier et dart ;
 * undefined pour une commande qui ne sait pas tourner sur tout le projet (tests liés, commande de l'orchestrateur sur fichiers).
 */
export function projectArgv(cmd: VerifCommande): string[] | undefined {
  if (!cmd.argv.includes(FICHIERS)) return cmd.portee === 'projet' ? cmd.argv : undefined
  if (cmd.portee !== 'fichiers') return undefined
  const t = toolOf(cmd.argv)
  if (!['eslint', 'biome', 'prettier', 'dart'].includes(t)) return undefined
  return cmd.argv.map(x => (x === FICHIERS ? '.' : x))
}

type Exec = { l: Lancement; exitCode: number; stdout: string; stderr: string; dureeMs: number; echec?: string }

/** Un lancement : jamais d'exception, une erreur de run devient `echec`. */
async function exec(io: VerifIo, l: Lancement, timeoutMs: number): Promise<Exec> {
  const t0 = await io.now()
  try {
    const r = await io.run(withShell(l.argv, io.os), { cwd: joinPath(io, io.racine, l.cwd), timeoutMs })
    const exitCode = typeof r.exitCode === 'number' ? r.exitCode : -1
    return { l, exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', dureeMs: (await io.now()) - t0, ...(typeof r.exitCode === 'number' ? {} : { echec: 'arrêtée sans code de sortie' }) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const dureeMs = (await io.now()) - t0
    const delai = /time ?out|timed out|délai/i.test(msg) || dureeMs >= timeoutMs
    return { l, exitCode: -1, stdout: '', stderr: msg, dureeMs, echec: delai ? `délai dépassé (${dureeText(timeoutMs)})` : `lancement impossible : ${msg.slice(0, 160)}` }
  }
}

/** Le texte complet des lancements, pour le .txt (borné à 4 MiB). */
function sortieText(cmd: VerifCommande, execs: { titre: string; e: Exec }[]): string {
  const parts = [`revo-flow · vérification « ${cmd.id} » (${cmd.outil}, portée ${cmd.portee})`, '']
  for (const { titre, e } of execs) {
    parts.push(
      `── ${titre} ──`,
      `$ ${e.l.argv.join(' ')}`,
      `dossier : ${e.l.cwd || '.'} · code de sortie ${e.exitCode} · ${dureeText(e.dureeMs)}${e.echec ? ` · ${e.echec}` : ''}`,
      '',
      '--- stdout ---',
      e.stdout.replace(/\r\n/g, '\n'),
      '--- stderr ---',
      e.stderr.replace(/\r\n/g, '\n'),
      '',
    )
  }
  const t = parts.join('\n')
  return t.length > MAX_SORTIE ? `${t.slice(0, MAX_SORTIE)}\n… sortie coupée à 4 Mo` : t
}

/** Pourquoi un lancement est illisible, ou undefined s'il est lisible (code 0, ou des erreurs lues). */
function illisible(e: Exec, lues: number): string | undefined {
  if (e.echec) return e.echec
  if (INTROUVABLE.has(e.exitCode)) return `commande introuvable (code ${e.exitCode})`
  if (e.exitCode !== 0 && lues === 0) return `code de sortie ${e.exitCode} sans erreur lisible : voir la sortie complète`
  return undefined
}

type Portee = { changed: string[]; files: string[]; testsOf?: (p: string) => string[]; annotes?: string[] }
type Etape = { etat: VerifEtatCommande; erreurs: VerifErreur[]; instables: string[]; lancee: boolean }

/** Une commande de la porte : lancements, lecture, classement, relance unique des tests rouges, sortie écrite. */
/** filtre : la vérification d'un agent (seulement = ses fichiers, flow = tous les fichiers du flow). */
type Filtre = { seulement: Set<string>; flow: Set<string> }

async function runCommand(io: VerifIo, cmd: VerifCommande, portee: Portee, base: VerifBase | undefined, instables: string[], filtre: Filtre | undefined, onProgress?: (c: VerifEtatCommande) => void): Promise<Etape> {
  const vide: VerifEtatCommande = { id: cmd.id, outil: cmd.outil, etat: 'saute', dureeMs: 0, nouvelles: 0, preexistantes: 0, instables: 0, fichiers: 0 }
  const lancements = plan(cmd, portee)
  if (!lancements.length) {
    const etat = { ...vide, note: cmd.declencheur ? `aucun fichier ${cmd.declencheur.replace(/^\*\*\//, '')} modifié` : 'aucun fichier concerné' }
    onProgress?.(etat)
    return { etat, erreurs: [], instables: [], lancee: false }
  }
  const fichiers = lancements.reduce((n, l) => n + l.fichiers.length, 0)
  onProgress?.({ ...vide, etat: 'en_cours', fichiers })
  const notes: string[] = []
  if ((cmd.dureeMs ?? 0) > SPAWN_SEUIL_MS) notes.push(`durée apprise ${dureeText(cmd.dureeMs!)} : au-delà de 5 min, à passer par spawn (run plafonné à 10 min)`)
  const timeoutMs = timeoutOf(cmd.dureeMs)

  const execs: { titre: string; e: Exec }[] = []
  let lues: Omit<VerifErreur, 'statut'>[] = []
  const pannes: string[] = []
  for (const l of lancements) {
    const e = await exec(io, l, timeoutMs)
    execs.push({ titre: `lancement${l.cwd ? ` dans ${l.cwd}` : ''}`, e })
    const errs = parseOutput(cmd.format, e, { outil: cmd.id, cwd: l.cwd, racine: io.racine, argv: l.argv })
    const panne = illisible(e, errs.length)
    if (panne) pannes.push(panne)
    lues.push(...errs)
  }
  // Copie partagée : la vérification d'un agent ignore les erreurs de lint ou de typage dans les fichiers modifiés par un autre agent.
  if (filtre && cmd.outil !== 'tests') lues = lues.filter(e => filtre.seulement.has(e.fichier) || !filtre.flow.has(e.fichier))
  let erreurs = classify(lues, base, instables, cmd.id)

  // Relance unique, seule, des tests rouges : vert à la relance → instable.
  const nouveauxInstables: string[] = []
  const rouges = erreurs.filter(e => e.statut === 'nouvelle' || e.statut === 'nouvelle?')
  if (cmd.outil === 'tests' && rouges.length) {
    const aRelancer = [...new Set(rouges.map(e => e.fichier).filter(Boolean))]
    const relance = plan({ ...cmd, declencheur: undefined }, { changed: aRelancer, files: [...portee.files, ...aRelancer] })
    const encore = new Set<string>()
    const relues = new Set<string>()
    for (const l of relance) {
      const e = await exec(io, l, timeoutMs)
      execs.push({ titre: `relance des tests rouges${l.cwd ? ` dans ${l.cwd}` : ''}`, e })
      const errs = parseOutput(cmd.format, e, { outil: cmd.id, cwd: l.cwd, racine: io.racine, argv: l.argv })
      if (illisible(e, errs.length)) continue
      for (const f of l.fichiers) relues.add(f)
      for (const x of errs) encore.add(signatureKey(x))
    }
    erreurs = erreurs.map((e): VerifErreur => {
      if ((e.statut !== 'nouvelle' && e.statut !== 'nouvelle?') || !relues.has(e.fichier)) return e
      const k = signatureKey(e)
      if (encore.has(k)) return e
      nouveauxInstables.push(k)
      return { ...e, statut: 'instable' }
    })
  }

  const dureeMs = execs.reduce((n, x) => n + x.e.dureeMs, 0)
  const nouvelles = erreurs.filter(e => e.statut === 'nouvelle' || e.statut === 'nouvelle?').length
  const preexistantes = erreurs.filter(e => e.statut === 'preexistante').length
  const nbInstables = erreurs.filter(e => e.statut === 'instable').length
  if (pannes.length) notes.push(...new Set(pannes))
  const etat: VerifEtatCommande = {
    id: cmd.id,
    outil: cmd.outil,
    etat: nouvelles > 0 ? 'ko' : pannes.length ? 'erreur' : 'ok',
    dureeMs,
    nouvelles,
    preexistantes,
    instables: nbInstables,
    fichiers,
  }
  // La sortie complète est écrite dans tous les cas, illisible comprise.
  const chemin = joinPath(io, io.sorties, `${cmd.id}.txt`)
  try {
    await io.write(chemin, sortieText(cmd, execs))
    etat.sortie = chemin
  } catch {
    notes.push('sortie complète non écrite')
  }
  if (notes.length) etat.note = notes.join(' ; ')
  onProgress?.(etat)
  return { etat, erreurs, instables: nouveauxInstables, lancee: true }
}

/**
 * La porte : chaque commande confirmée, dans l'ordre génération, format, lint, typage, tests. `seulement` : fichiers d'un agent (sa portée,
 * copie partagée) ; sinon `changed`, les fichiers du flow. Rend le résultat et projet.verif mis à jour (durées, instables).
 * Rouge : au moins une erreur nouvelle (ou « nouvelle ? ») ; erreur : aucune nouvelle mais une commande illisible ; sinon vert.
 */
export async function runGate(
  io: VerifIo,
  verif: ProjetVerif,
  input: { changed: string[]; files: string[]; testsOf?: (p: string) => string[]; commit: string; seulement?: string[]; onProgress?: (c: VerifEtatCommande) => void; annotes?: string[] },
): Promise<{ resultat: VerifResultat; verif: ProjetVerif }> {
  const t0 = await io.now()
  const base = baseFor(verif, input.commit)
  const filtre: Filtre | undefined = input.seulement ? { seulement: new Set(input.seulement.map(norm)), flow: new Set(input.changed.map(norm)) } : undefined
  const portee: Portee = { changed: filtre ? [...filtre.seulement] : input.changed, files: input.files, testsOf: input.testsOf, annotes: input.annotes }
  const ordre = [...verif.commandes].sort((a, b) => ORDRE.indexOf(a.outil) - ORDRE.indexOf(b.outil))
  const etats: VerifEtatCommande[] = []
  const erreurs: VerifErreur[] = []
  const appris: string[] = []
  const durees = new Map<string, number>()
  for (const cmd of ordre) {
    const r = await runCommand(io, cmd, portee, base, verif.instables, filtre, input.onProgress)
    etats.push(r.etat)
    erreurs.push(...r.erreurs)
    appris.push(...r.instables)
    if (r.lancee && r.etat.etat !== 'erreur') durees.set(cmd.id, r.etat.dureeMs)
  }
  const nouvelles = erreurs.filter(e => e.statut === 'nouvelle' || e.statut === 'nouvelle?')
  const etat: VerifResultat['etat'] = nouvelles.length ? 'rouge' : etats.some(c => c.etat === 'erreur') ? 'erreur' : 'vert'
  const gardees = [...nouvelles, ...erreurs.filter(e => e.statut === 'instable'), ...erreurs.filter(e => e.statut === 'preexistante').slice(0, MAX_PREEXISTANTES)]
  const resultat: VerifResultat = { etat, le: new Date(t0).toISOString(), dureeMs: (await io.now()) - t0, commandes: etats, erreurs: gardees }
  const commandes = verif.commandes.map(c => {
    const d = durees.get(c.id)
    if (d === undefined) return c
    return { ...c, dureeMs: c.dureeMs ? Math.round(c.dureeMs * 0.7 + d * 0.3) : d }
  })
  const instables = [...new Set([...verif.instables, ...appris])].slice(-MAX_INSTABLES)
  return { resultat, verif: { ...verif, commandes, instables } }
}

/**
 * La base de référence au commit de départ : lint, typage et format sur tout le projet (projectArgv), à la racine.
 * Une commande illisible n'entre pas dans base.commandes : ses erreurs à la porte seront « nouvelle ? ».
 */
export async function runBase(io: VerifIo, verif: ProjetVerif, commit: string, onProgress?: (c: VerifEtatCommande) => void): Promise<VerifBase> {
  const t0 = await io.now()
  const commandes: string[] = []
  const signatures: string[] = []
  for (const cmd of verif.commandes) {
    if (cmd.outil !== 'lint' && cmd.outil !== 'typage' && cmd.outil !== 'format') continue
    const argv = projectArgv(cmd)
    if (!argv) continue
    const l: Lancement = { id: cmd.id, cwd: '', argv, fichiers: [] }
    onProgress?.({ id: cmd.id, outil: cmd.outil, etat: 'en_cours', dureeMs: 0, nouvelles: 0, preexistantes: 0, instables: 0, fichiers: 0 })
    const e = await exec(io, l, timeoutOf(cmd.dureeMs))
    const errs = parseOutput(cmd.format, e, { outil: cmd.id, cwd: '', racine: io.racine, argv })
    const panne = illisible(e, errs.length)
    const chemin = joinPath(io, io.sorties, `base-${cmd.id}.txt`)
    let sortie: string | undefined
    try {
      await io.write(chemin, sortieText(cmd, [{ titre: `base de référence au commit ${commit}`, e }]))
      sortie = chemin
    } catch {
      sortie = undefined
    }
    if (!panne) {
      commandes.push(cmd.id)
      signatures.push(...errs.map(signatureKey))
    }
    onProgress?.({
      id: cmd.id,
      outil: cmd.outil,
      etat: panne ? 'erreur' : 'ok',
      dureeMs: e.dureeMs,
      nouvelles: 0,
      preexistantes: errs.length,
      instables: 0,
      fichiers: 0,
      ...(sortie ? { sortie } : {}),
      ...(panne ? { note: panne } : {}),
    })
  }
  return { commit, le: new Date(t0).toISOString(), commandes, signatures }
}

/** Ne garde que les `garder` derniers dossiers de sortie (noms triés : un nom horodaté trie dans l'ordre des flows). Rend le nombre retirés. */
export async function purgeOutputs(io: VerifIo, dossierParent: string, garder = 20): Promise<number> {
  if (!io.list || !io.remove) return 0
  let noms: string[]
  try {
    noms = await io.list(dossierParent)
  } catch {
    return 0
  }
  const tries = [...new Set(noms.map(n => n.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '').filter(Boolean))].sort()
  const trop = tries.slice(0, Math.max(0, tries.length - garder))
  let n = 0
  for (const nom of trop) {
    try {
      await io.remove(joinPath(io, dossierParent, nom))
      n++
    } catch {
      // dossier verrouillé (Windows) : retenté à la prochaine purge
    }
  }
  return n
}
