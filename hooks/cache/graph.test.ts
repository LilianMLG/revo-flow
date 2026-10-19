import { expect, test } from 'claude-code/testing'

import {
  agentExtract,
  autoFiche,
  briefText,
  buildGraph,
  candidatesFromLog,
  candidatesText,
  completeFiche,
  computeStats,
  detectStack,
  diffText,
  extractFiles,
  featureText,
  freshness,
  graphText,
  hashPath,
  isExcluded,
  EXCLUS_DEFAUT,
  kindOf,
  learn,
  matchRequest,
  neighbors,
  neighborsText,
  perimeOf,
  projectKey,
  recordUsage,
  refreshFiles,
  search,
  searchText,
  servedFiles,
  servedSubset,
  tokensOf,
  updateFiles,
  MECA_FORMAT,
  MANIFESTES,
  coldMap,
  coldRank,
  headSummary,
  keywordsOf,
} from './graph'
import type { Feature, FlowCache, Graph, LearnContext, SourceFile } from '../../types/cache'

// ── Mini projet Nuxt 3 ───────────────────────────────────────────────────

const NUXT3_PKG = JSON.stringify({
  dependencies: { nuxt: '^3.12.0', pinia: '^2.1.0', '@pinia/nuxt': '^0.5.0', '@nuxtjs/apollo': '^5.0.0', vuetify: '^3.5.0' },
  devDependencies: { vitest: '^1.6.0', typescript: '^5.4.0' },
})

const N3: Record<string, string> = {
  'nuxt.config.ts': `export default defineNuxtConfig({ ssr: false })`,
  'pages/booking/offer.vue': `<template>
  <div>
    <BookingComplementaries :offers="offers" />
    <booking-offer-card />
    <v-btn>ok</v-btn>
  </div>
</template>
<script setup lang="ts">
import { formatPrice } from '~/utils/price'
definePageMeta({ middleware: 'guard' })
const store = useBookingStore()
const { items } = useCart()
const total = formatPrice(items.length)
</script>`,
  'pages/orders/[id].vue': `<template><div>{{ id }}</div></template>
<script setup lang="ts">
const id = useRoute().params.id
</script>`,
  'pages/index.vue': `<template><div>Accueil</div></template>`,
  'components/booking/BookingComplementaries.vue': `<template><div><slot /></div></template>
<script setup lang="ts">
defineProps<{ offers: unknown[] }>()
</script>`,
  'components/booking/OfferCard.vue': `<template><div>carte</div></template>`,
  'composables/useCart.ts': `export function useCart() {
  const s = useBookingStore()
  return { items: s.items }
}`,
  'stores/booking/Booking.ts': `import { defineStore } from 'pinia'
import { OfferService } from '~/services/offer'
export const useBookingStore = defineStore('booking', () => {
  const s = new OfferService()
  return { items: [], load: () => s.all() }
})`,
  'services/offer.ts': `import { queryAllOffers } from '~/graphql/offers'
import type { Offer } from '~/generated/gql-types/graphql'
export class OfferService {
  async all(): Promise<Offer[]> {
    return apollo.query({ query: queryAllOffers })
  }
  async complementary() {
    const r = await fetch(\`\${$config.public.api}/complementary-products?tags=1\`, { method: 'POST', body: '{}' })
    return r.json()
  }
}`,
  'graphql/offers.ts': `import gql from 'graphql-tag'
export const queryAllOffers = gql\`
  query allOffers($day: String!) {
    offers(day: $day) { id }
  }
\``,
  'utils/price.ts': `export const formatPrice = (n: number) => n.toFixed(2)`,
  'middleware/guard.ts': `export default defineNuxtRouteMiddleware(() => {})`,
  'middleware/auth.global.ts': `export default defineNuxtRouteMiddleware(() => {})`,
  'tests/unit/x.spec.ts': `import { formatPrice } from '~/utils/price'
import { useCart } from '../../composables/useCart'
test('prix', () => expect(formatPrice(1)).toBe('1.00'))`,
  'docs/A.md': 'Voir `services/offer.ts` et `stores/booking/Booking.ts`, et [le prix](../utils/price.ts).',
  'generated/gql-types/graphql.ts': `export type Offer = { id: string }`,
  'node_modules/x/index.js': `module.exports = 1`,
  'locales/fr.json': `{}`,
}

const files = (src: Record<string, string>, prefix = 'h'): SourceFile[] =>
  Object.entries(src).map(([p, text]) => ({ p, text, h: `${prefix}-${p}` }))

const CTX = { commit: 'abc1234', branche: 'master', le: '2026-10-14T10:00:00.000Z' }
const LEARN: LearnContext = { source: 'flow:1', modele: 'claude-opus-5-5', ...CTX }

const nuxt3 = (): Graph =>
  buildGraph({ cle: 'front/demo', racine: 'C:/Users/x/Documents/Front/demo', nom: 'demo', files: files(N3), pkgJson: NUXT3_PKG, ...CTX })

test('buildGraph Nuxt 3 : fichiers, types, exclusions et tailles', () => {
  const g = nuxt3()
  expect(g.v).toBe(1)
  expect(g.projet.stack).toContain('Nuxt 3')
  expect(g.projet.stack).toContain('Pinia')
  expect(g.fichiers['generated/gql-types/graphql.ts']).toBeUndefined()
  expect(g.fichiers['node_modules/x/index.js']).toBeUndefined()
  expect(g.fichiers['locales/fr.json']).toBeUndefined()
  expect(g.fichiers['pages/booking/offer.vue']!.k).toBe('page')
  expect(g.fichiers['components/booking/OfferCard.vue']!.k).toBe('composant')
  expect(g.fichiers['stores/booking/Booking.ts']!.k).toBe('store')
  expect(g.fichiers['stores/booking/Booking.ts']!.exp).toContain('useBookingStore')
  expect(g.fichiers['tests/unit/x.spec.ts']!.k).toBe('test')
  expect(g.fichiers['docs/A.md']!.k).toBe('doc')
  expect(g.fichiers['utils/price.ts']!.tok).toBe(tokensOf(N3['utils/price.ts']!))
  expect(g.fichiers['services/offer.ts']!.h).toBe('h-services/offer.ts')
  expect(g.projet.indexe.fichiers).toBe(Object.keys(g.fichiers).length)
})

test('buildGraph Nuxt 3 : imports, auto-imports, balises, gql, api, routes, gardes, tests, docs', () => {
  const g = nuxt3()
  const page = g.fichiers['pages/booking/offer.vue']!.out!
  expect(page.importe).toEqual(['utils/price.ts'])
  expect(page.utilise).toContain('stores/booking/Booking.ts')
  expect(page.utilise).toContain('composables/useCart.ts')
  expect(page.rend).toContain('components/booking/BookingComplementaries.vue')
  expect(page.rend).toContain('components/booking/OfferCard.vue')
  expect(g.fichiers['composables/useCart.ts']!.out!.utilise).toEqual(['stores/booking/Booking.ts'])
  expect(g.fichiers['stores/booking/Booking.ts']!.out!.importe).toEqual(['services/offer.ts'])

  const svc = g.fichiers['services/offer.ts']!.out!
  expect(svc.importe).toContain('graphql/offers.ts')
  expect(svc.importe).toContain('x:generated/gql-types')
  expect(svc.appelle).toContain('q:allOffers')
  expect(svc.appelle).toContain('a:POST /complementary-products')
  expect(g.noeuds['q:allOffers']).toEqual({ k: 'gql', def: 'graphql/offers.ts', c: ['queryAllOffers'] })
  expect(g.noeuds['a:POST /complementary-products']!.k).toBe('api')
  expect(g.noeuds['x:generated/gql-types']!.k).toBe('externe')

  expect(g.noeuds['r:/booking/offer']!.out!.sert).toEqual(['pages/booking/offer.vue'])
  expect(g.noeuds['r:/orders/:id']!.out!.sert).toEqual(['pages/orders/[id].vue'])
  expect(g.noeuds['r:/']!.out!.sert).toEqual(['pages/index.vue'])
  expect(g.fichiers['middleware/guard.ts']!.out!.garde).toEqual(['r:/booking/offer'])
  expect(g.fichiers['middleware/auth.global.ts']!.out!.garde).toHaveLength(3)

  expect(g.fichiers['tests/unit/x.spec.ts']!.out!.teste).toEqual(['utils/price.ts', 'composables/useCart.ts'])
  expect(g.fichiers['docs/A.md']!.out!.documente).toEqual(['services/offer.ts', 'stores/booking/Booking.ts', 'utils/price.ts'])

  // Les arêtes ne pointent que vers des clés existantes
  for (const n of [...Object.values(g.fichiers), ...Object.values(g.noeuds)])
    for (const list of Object.values(n.out ?? {})) for (const t of list ?? []) expect(Boolean(g.fichiers[t] ?? g.noeuds[t])).toBe(true)
})

// ── Mini projet Nuxt 2 (Vuex, mixins, _param) ────────────────────────────

const N2: Record<string, string> = {
  'nuxt.config.js': `export default { components: true }`,
  'store/booking.js': `export const state = () => ({})
export const getters = { getDuration: () => 1 }
export const actions = { load({ dispatch }) { dispatch('calendar/fetch', null, { root: true }) } }`,
  'store/calendar.js': `export const actions = { fetch() {} }`,
  'store/moncompte/orders.js': `export const getters = { list: () => [] }`,
  'pages/_name.vue': `<template><div><BookingSummary /><calendar-grid /></div></template>
<script>
import { mapGetters } from 'vuex'
import formatDates from '~/mixins/formatDates'
export default {
  mixins: [formatDates],
  middleware: ['auth'],
  computed: { ...mapGetters('booking', ['getDuration']), ...mapGetters({ orders: 'moncompte/orders/list' }) },
  methods: { go() { this.$store.dispatch('calendar/fetch'); formatDate(1) } },
}
</script>`,
  'pages/index.vue': `<template><div /></template>
<script>
export default { computed: { d() { return this.$store.getters['booking/getDuration'] } } }
</script>`,
  'components/BookingSummary/BookingSummary.vue': `<template><div /></template>`,
  'components/calendar/Grid.vue': `<template><div /></template>`,
  'mixins/formatDates.js': `export default { methods: { fmt() {} } }`,
  'middleware/auth.js': `export default function () {}`,
  'utils/format.js': `export function formatDate() {}`,
  'graphql/accommodations.ts': 'import gql from "graphql-tag"\nexport const queryAccommodations = gql`\n  query Accommodations($d: String!) { accommodation(d: $d) { code } }\n`',
}

test('buildGraph Nuxt 2 : Vuex par chaîne, mixins, balises, _param, pas d’auto-import', () => {
  const g = buildGraph({
    cle: 'front/v2',
    racine: '/x',
    nom: 'v2',
    files: files(N2),
    pkgJson: JSON.stringify({ dependencies: { 'nuxt-edge': '^2.16', vuex: '^3' }, devDependencies: { jest: '^29' } }),
    ...CTX,
  })
  expect(g.projet.stack).toBe('Nuxt 2, Vuex, Jest')
  const page = g.fichiers['pages/_name.vue']!.out!
  expect(page.utilise).toContain('mixins/formatDates.js')
  expect(page.utilise).toContain('store/booking.js')
  expect(page.utilise).toContain('store/moncompte/orders.js')
  expect(page.utilise).toContain('store/calendar.js')
  expect(page.utilise).not.toContain('utils/format.js')
  expect(page.rend).toEqual(['components/BookingSummary/BookingSummary.vue', 'components/calendar/Grid.vue'])
  expect(g.fichiers['pages/index.vue']!.out!.utilise).toEqual(['store/booking.js'])
  expect(g.fichiers['store/booking.js']!.out!.utilise).toEqual(['store/calendar.js'])
  expect(g.noeuds['r:/:name']!.out!.sert).toEqual(['pages/_name.vue'])
  expect(g.fichiers['middleware/auth.js']!.out!.garde).toEqual(['r:/:name'])
  expect(g.fichiers['mixins/formatDates.js']!.k).toBe('mixin')
  expect(g.noeuds['q:Accommodations']!.def).toBe('graphql/accommodations.ts')
})

// ── Incrémental ──────────────────────────────────────────────────────────

test('updateFiles : modification, suppression, renommage, ajout de page, perime', () => {
  const base = nuxt3()
  const { graph: g0, rejected } = learn(
    base,
    {
      feature: 'complementary-products',
      fichiers: [{ p: 'services/offer.ts', role: 'donnees' }, { p: 'utils/price.ts' }, { p: 'services/nope.ts' }],
      pieges: [{ txt: 'J-1 aligné sur le rule engine', p: 'utils/price.ts' }],
    },
    LEARN,
  )
  expect(rejected).toEqual(['services/nope.ts'])

  const changed: SourceFile[] = [
    { p: 'services/offer.ts', h: 'h2', text: `import { queryAllOffers } from '~/graphql/offers'\nexport const x = queryAllOffers` },
    { p: 'pages/new.vue', h: 'h3', text: `<template><div /></template>` },
  ]
  const g = updateFiles(g0, changed, ['docs/A.md'], [['utils/price.ts', 'utils/money.ts']], { ...CTX, commit: 'def5678', le: '2026-10-15T08:00:00.000Z' })

  // modification : arêtes recalculées, endpoint orphelin retiré, date de calcul posée
  expect(g.fichiers['services/offer.ts']!.out!.appelle).toEqual(['q:allOffers'])
  expect(g.noeuds['a:POST /complementary-products']).toBeUndefined()
  expect(g.fichiers['services/offer.ts']!.vu).toBe('2026-10-15T08:00:00.000Z')
  // suppression
  expect(g.fichiers['docs/A.md']).toBeUndefined()
  // renommage : nœud, arêtes entrantes et fiche suivent
  expect(g.fichiers['utils/price.ts']).toBeUndefined()
  expect(g.fichiers['utils/money.ts']!.exp).toEqual(['formatPrice'])
  expect(g.fichiers['pages/booking/offer.vue']!.out!.importe).toEqual(['utils/money.ts'])
  expect(g.fichiers['tests/unit/x.spec.ts']!.out!.teste).toContain('utils/money.ts')
  const f = g.features['complementary-products']!
  expect(f.fichiers.map(x => x.p)).toContain('utils/money.ts')
  expect(f.pieges[0]!.p).toBe('utils/money.ts')
  // perime : seul le fichier dont le hash a changé
  expect(f.perime).toEqual([{ p: 'services/offer.ts', depuis: 'h-services/offer.ts', nouveau: 'h2' }])
  // ajout de page : route et garde globale
  expect(g.noeuds['r:/new']!.out!.sert).toEqual(['pages/new.vue'])
  expect(g.fichiers['middleware/auth.global.ts']!.out!.garde).toContain('r:/new')
  expect(g.fichiers['middleware/guard.ts']!.out!.garde).toEqual(['r:/booking/offer'])
  expect(g.projet.indexe.commit).toBe('def5678')
  // le graphe d'origine n'est pas modifié
  expect(g0.fichiers['utils/price.ts']).toBeDefined()
})

// ── Fraîcheur ────────────────────────────────────────────────────────────

const small = () =>
  buildGraph({
    cle: 'x',
    racine: '/x',
    nom: 'x',
    files: [
      { p: 'utils/a.ts', h: 'a1', text: 'a'.repeat(400) },
      { p: 'utils/b.ts', h: 'b1', text: 'b'.repeat(400) },
      { p: 'utils/c.ts', h: 'c1', text: 'c'.repeat(1600) },
    ],
    ...CTX,
  })

test('freshness : fraîche, partielle (< 50 %), périmée (≥ 50 %), confiance réduite', () => {
  const { graph } = learn(
    small(),
    { feature: 'f', resume: 'Résumé', flux: ['étape un', 'étape deux'], fichiers: [{ p: 'utils/a.ts' }, { p: 'utils/b.ts' }, { p: 'utils/c.ts' }] },
    { ...LEARN, confiance: 0.8 },
  )
  const f = graph.features.f!
  expect(freshness(graph, f).niveau).toBe('fraiche')
  expect(freshness(graph, f).confiance).toBe(0.8)

  const g1 = updateFiles(graph, [{ p: 'utils/a.ts', h: 'a2', text: 'a'.repeat(400) }], [], [], CTX)
  const fr1 = freshness(g1, g1.features.f!)
  expect(fr1.niveau).toBe('partielle')
  expect(fr1.ratio).toBe(0.17)
  expect(fr1.perimes).toEqual(['utils/a.ts'])
  expect(fr1.confiance).toBe(0.67)
  expect(featureText(g1, g1.features.f!)).toContain('Flux :')
  expect(featureText(g1, g1.features.f!)).toContain('⚠ Modifiés depuis l')
  expect(featureText(g1, g1.features.f!)).toContain('action rafraichir (feature, fichiers = ceux relus)')
  expect(featureText(g1, g1.features.f!)).toContain('action apprendre avec corrections')
  expect(featureText(g1, g1.features.f!)).toContain('Action diff (feature ou chemin)')

  const g2 = updateFiles(g1, [{ p: 'utils/c.ts', h: 'c2', text: 'c'.repeat(1600) }], [], [], CTX)
  const fr2 = freshness(g2, g2.features.f!)
  expect(fr2.niveau).toBe('perimee')
  expect(fr2.ratio).toBe(0.83)
  const txt = featureText(g2, g2.features.f!)
  expect(txt).not.toContain('Flux :')
  expect(txt).not.toContain('étape un')
  expect(txt).toContain('très périmée')
  expect(txt).toContain('Relis les fichiers (ou action diff) puis action apprendre pour la réécrire.')
  expect(txt).not.toContain('action rafraichir')

  // Un nouvel apprentissage remet les hash à jour et vide perime
  const g3 = learn(g2, { feature: 'f' }, LEARN).graph
  expect(g3.features.f!.perime).toEqual([])
  expect(freshness(g3, g3.features.f!).niveau).toBe('fraiche')
  expect(g3.features.f!.flux).toEqual(['étape un', 'étape deux'])
})

// ── Recherche, correspondance, voisins ───────────────────────────────────

const withFeatures = () => {
  let g = nuxt3()
  g = learn(
    g,
    {
      feature: 'complementary-products',
      titre: 'Produits complémentaires et transports',
      alias: ['navettes', 'transferts', 'taxe de séjour'],
      resume: 'Onglets Complémentaires et Transports de /booking/offer.',
      entrees: ['/booking/offer'],
      fichiers: [{ p: 'services/offer.ts' }, { p: 'stores/booking/Booking.ts' }, { p: 'pages/booking/offer.vue', role: 'entrée' }],
    },
    LEARN,
  ).graph
  g = learn(g, { feature: 'panier', titre: 'Panier', alias: ['cart', 'basket'], fichiers: [{ p: 'composables/useCart.ts', role: 'cœur' }] }, LEARN).graph
  return g
}

test('search et matchRequest : mots rares, seuil, fichiers', () => {
  const g = withFeatures()
  expect(matchRequest(g, "les navettes J-1 ne s'affichent plus")?.id).toBe('complementary-products')
  expect(matchRequest(g, 'ajouter un bouton dans le panier')?.id).toBe('panier')
  expect(matchRequest(g, 'refactor général du code')).toBeUndefined()
  const r = search(g, 'offer')
  expect(r.files.map(x => x.p)).toContain('services/offer.ts')
  expect(searchText(g, 'navettes')).toContain('complementary-products')
  expect(searchText(g, 'zzzz')).toContain('Rien trouvé')
  expect(g.features['complementary-products']!.entrees).toEqual(['r:/booking/offer'])
  expect(g.features['complementary-products']!.fichiers.find(x => x.p === 'pages/booking/offer.vue')!.role).toBe('entree')
  expect(g.features.panier!.fichiers[0]!.role).toBe('coeur')
})

test('neighbors : sortants, entrants, tests, docs, profondeur 2', () => {
  const g = nuxt3()
  const nb = neighbors(g, 'stores/booking/Booking.ts')
  expect(nb.in.utilise).toEqual(['pages/booking/offer.vue', 'composables/useCart.ts'])
  expect(nb.out.importe).toEqual(['services/offer.ts'])
  expect(nb.docs).toEqual(['docs/A.md'])
  expect(neighbors(g, 'utils/price.ts').tests).toEqual(['tests/unit/x.spec.ts'])
  const deep = neighbors(g, 'stores/booking/Booking.ts', 2)
  expect(deep.out['importe/appelle']).toContain('q:allOffers')
  expect(deep.in['utilise/sert']).toContain('r:/booking/offer')
  // chemin absolu et suffixe unique
  expect(neighbors(g, 'C:\\Users\\x\\Documents\\Front\\demo\\utils\\price.ts').tests).toEqual(['tests/unit/x.spec.ts'])
  const txt = neighborsText(g, 'Booking.ts')
  expect(txt).toContain('Voisins de stores/booking/Booking.ts')
  expect(txt).toContain('utilisé par : pages/booking/offer.vue')
  expect(neighborsText(g, 'inconnu.ts')).toContain("n'est pas dans le graphe")
})

// ── Apprentissage, fiche auto, complétion ────────────────────────────────

test('learn : chemins rejetés, hash enregistrés, confiance, corrections', () => {
  const g0 = nuxt3()
  const { graph, rejected } = learn(
    g0,
    {
      feature: 'Double Session',
      fichiers: [{ p: 'stores/booking/Booking.ts' }, { p: 'C:/Users/x/Documents/Front/demo/services/offer.ts' }, { p: 'nope/x.ts' }],
      pieges: [{ txt: 'piège', p: 'ailleurs.ts' }],
      entrees: ['/inexistante'],
      corrections: ['le stock vient du service'],
    },
    LEARN,
  )
  expect(rejected).toEqual(['nope/x.ts', 'ailleurs.ts'])
  const f = graph.features['double-session']!
  expect(f.entrees).toEqual(['/inexistante'])
  expect(f.fichiers).toEqual([
    { p: 'stores/booking/Booking.ts', role: 'donnees', h: 'h-stores/booking/Booking.ts' },
    { p: 'services/offer.ts', role: 'donnees', h: 'h-services/offer.ts' },
  ])
  expect(f.confiance).toBe(0.9)
  expect(f.source).toBe('flow:1')
  expect(f.appris).toEqual({ le: CTX.le, commit: CTX.commit, branche: CTX.branche })
  expect(f.pieges).toEqual([{ txt: 'piège' }, { txt: 'Corrigé : le stock vient du service' }])
  expect(learn(g0, { feature: '  ' }, LEARN).rejected).toHaveLength(1)
})

test('autoFiche et completeFiche : fiche minimale, puis fichiers lus hors fiche en périphérique', () => {
  const g0 = nuxt3()
  const g1 = autoFiche(g0, 'paiement', [{ p: 'pages/booking/offer.vue' }, { p: 'nope.ts' }], { ...LEARN, source: 'flow:2' })
  const f = g1.features.paiement!
  expect(f.source).toBe('flow-auto')
  expect(f.confiance).toBe(0.5)
  expect(f.resume).toBe('')
  expect(f.entrees).toEqual(['r:/booking/offer'])
  expect(f.fichiers).toEqual([{ p: 'pages/booking/offer.vue', role: 'entree', h: '' }])
  expect(autoFiche(g0, 'vide', [{ p: 'nope.ts' }], LEARN)).toBe(g0)
  const g2 = completeFiche(g1, 'paiement', ['utils/price.ts', 'pages/booking/offer.vue', 'nope.ts'])
  expect(g2.features.paiement!.fichiers.map(x => `${x.p}:${x.role}`)).toEqual(['pages/booking/offer.vue:entree', 'utils/price.ts:peripherique'])
  expect(featureText(g2, g2.features.paiement!)).toContain('Fiche automatique')
})

// ── Mesure des gains ─────────────────────────────────────────────────────

test('computeStats et recordUsage : évités comptés une fois, net, complétude', () => {
  const g = withFeatures()
  const f = g.features['complementary-products']!
  const hits = servedFiles(g, f, 'brief')
  expect(hits).toHaveLength(3)
  expect(hits.every(h => h.frais && h.feature === f.id)).toBe(true)
  const tok = (p: string) => g.fichiers[p]!.tok
  const flow: FlowCache = {
    cle: g.projet.cle,
    servis: [...hits, { p: 'services/offer.ts', tok: tok('services/offer.ts'), frais: true, par: 'voisins' }],
    lus: [
      { p: 'pages/booking/offer.vue', tok: tok('pages/booking/offer.vue'), par: 'lead' },
      { p: 'utils/price.ts', tok: tok('utils/price.ts'), par: 'front' },
    ],
    injecte: 100,
    feature: f.id,
  }
  const s = computeStats(g, flow, 'demo')!
  const evites = tok('services/offer.ts') + tok('stores/booking/Booking.ts')
  expect(s.flow.evites).toBe(evites)
  expect(s.flow.net).toBe(evites - 100)
  expect(s.flow.completude).toBe(0.5)
  expect(s.flow.lus).toBe(tok('pages/booking/offer.vue') + tok('utils/price.ts'))
  expect(s.features).toBe(2)
  expect(s.fraiches).toBe(2)
  expect(s.noeuds[0]).toMatchObject({ id: f.id, k: 'feature', hit: 'brief', niveau: 'fraiche' })
  expect(s.parType.page).toBe(3)
  expect(computeStats(null, null, 'demo')).toBeNull()

  const g2 = recordUsage(g, flow)
  expect(g2.stats).toEqual({ flows: 1, servis: tok('services/offer.ts') + tok('stores/booking/Booking.ts') + tok('pages/booking/offer.vue'), evites, net: evites - 100 })
  expect(g2.features[f.id]!.usages).toEqual({ servie: 1, evites })
  expect(computeStats(g2, null, 'demo')!.cumul).toEqual({ flows: 1, evites, net: evites - 100 })
})

// ── Textes ───────────────────────────────────────────────────────────────

test('briefText : ≤ 1 200 tokens avec une grosse fiche, ≈ 200 sans fiche', () => {
  let g = withFeatures()
  const long = 'x'.repeat(290)
  g = learn(
    g,
    {
      feature: 'complementary-products',
      resume: long.repeat(3),
      flux: Array.from({ length: 12 }, (_, i) => `${i} ${long}`),
      pieges: Array.from({ length: 12 }, (_, i) => ({ txt: `${i} ${long}` })),
    },
    LEARN,
  ).graph
  const b = briefText(g, g.features['complementary-products'])
  expect(tokensOf(b)).toBeLessThanOrEqual(1200)
  expect(b).toContain('## Fiche probable : complementary-products')
  expect(b).toContain('Le cache est une carte, pas la vérité')
  const short = briefText(g, undefined)
  expect(tokensOf(short)).toBeLessThan(250)
  expect(short).toContain('complementary-products ✓')
  expect(short).toContain('Outil mcp__revo-flow__cache')
  expect(short).toContain('diff (feature ou chemin')
  expect(short).toContain('rafraichir')
})

test('graphText ≤ 60 lignes, candidatesFromLog par scope', () => {
  let g = withFeatures()
  for (let i = 0; i < 70; i++) g = autoFiche(g, `f${i}`, [{ p: 'utils/price.ts' }], LEARN)
  const log = [
    'feat(booking): ajoute X',
    'pages/booking/offer.vue',
    'stores/booking/Booking.ts',
    '',
    'fix(booking): corrige Y',
    'stores/booking/Booking.ts',
    'tests/unit/x.spec.ts',
    '',
    '✨ feat(chatbot): Z',
    'services/offer.ts',
    '',
    'chore(deps): bump',
    'package.json',
    '',
    'chore(deps): bump encore',
    'package.json',
  ].join('\n')
  const c = candidatesFromLog(log, g)
  expect(c).toEqual([
    { id: 'booking', commits: 2, fichiers: 2, tok: g.fichiers['pages/booking/offer.vue']!.tok + g.fichiers['stores/booking/Booking.ts']!.tok },
  ])
  g = { ...g, candidates: c }
  const txt = graphText(g, computeStats(g, null, 'demo'))
  expect(txt.split('\n').length).toBeLessThanOrEqual(60)
  expect(txt).toContain('Graphe de cache · demo')
  expect(txt).toContain('autres fiches')
  expect(txt).toContain('Candidates sans fiche (1)')
  expect(candidatesText(g)).toContain('booking · 2 commits')
})

// ── Bases ────────────────────────────────────────────────────────────────

// ── Mini projet Flutter ──────────────────────────────────────────────────

const PUBSPEC = `name: router_app
description: "A new Flutter project."
environment:
  sdk: ^3.9.0
dependencies:
  flutter:
    sdk: flutter
  flutter_riverpod: ^3.0.0
  supabase_flutter: ^2.9.0
dev_dependencies:
  flutter_test:
    sdk: flutter
  mocktail: ^1.0.0
`

const FL: Record<string, string> = {
  'lib/main.dart': `import 'package:flutter/material.dart';
import 'package:router_app/features/map/presentation/screens/map_screen.dart';

void main() => runApp(const MapScreen());
`,
  'lib/features/map/presentation/screens/map_screen.dart': `import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:other_pkg/features/map/domain/road_graph.dart';
import '../providers/graph_providers.dart';
import '../widgets/legend.dart' show Legend;

class MapScreen extends ConsumerWidget {
  const MapScreen({super.key});
}
`,
  'lib/features/map/presentation/providers/graph_providers.dart': `import 'package:router_app/features/map/domain/road_graph.dart';
part 'graph_providers.g.dart';

final graphProvider = Provider<RoadGraph?>((ref) => null);
`,
  'lib/features/map/presentation/providers/graph_providers.g.dart': `part of 'graph_providers.dart';`,
  'lib/features/map/presentation/widgets/legend.dart': `class Legend {}`,
  'lib/features/map/domain/road_graph.dart': `import 'dart:math' as math;

/// A graph.
const double kRoadGraphToleranceM = 0.5;

class RoadGraph {
  RoadGraph(this.edges);
  final List<int> edges;
  int degree(int node) => 0;
}

sealed class RoadEvent {}

enum RoadFlow { direct, inverse }

extension on RoadGraph {}

typedef Clock = DateTime Function();

RoadGraph buildRoadGraph(List<int> sections, {double toleranceM = 0.5}) => RoadGraph(sections);

List<RoadGraph> _private() => [];
`,
  'test/features/map/road_graph_test.dart': `import 'package:flutter_test/flutter_test.dart';
import 'package:router_app/features/map/domain/road_graph.dart';

void main() {}
`,
  '.dart_tool/flutter_build/x.dart': `void x() {}`,
}

test('buildGraph Flutter : pubspec, package: et relatifs, types de fichiers, exports, tests, générés exclus', () => {
  const g = buildGraph({ cle: 'dev/router-app', racine: '/Users/x/Dev/router_app', nom: 'router_app', files: files(FL), pubspec: PUBSPEC, ...CTX })
  expect(g.projet.stack).toBe('Flutter, Riverpod, Supabase, mocktail')
  expect(g.projet.dart).toBe('router_app')
  expect(g.projet.format).toBe(MECA_FORMAT)
  expect(g.fichiers['lib/features/map/presentation/providers/graph_providers.g.dart']).toBeUndefined()
  expect(g.fichiers['.dart_tool/flutter_build/x.dart']).toBeUndefined()
  expect(g.fichiers['lib/main.dart']!.k).toBe('autre')
  expect(g.fichiers['lib/features/map/presentation/screens/map_screen.dart']!.k).toBe('page')
  expect(g.fichiers['lib/features/map/presentation/providers/graph_providers.dart']!.k).toBe('store')
  expect(g.fichiers['lib/features/map/presentation/widgets/legend.dart']!.k).toBe('composant')
  expect(g.fichiers['lib/features/map/domain/road_graph.dart']!.k).toBe('service')
  expect(g.fichiers['test/features/map/road_graph_test.dart']!.k).toBe('test')

  expect(g.fichiers['lib/main.dart']!.out!.importe).toEqual(['lib/features/map/presentation/screens/map_screen.dart'])
  // other_pkg n'est pas le paquet du projet : son chemin homonyme dans lib/ n'est pas un import.
  expect(g.fichiers['lib/features/map/presentation/screens/map_screen.dart']!.out!.importe!.sort()).toEqual([
    'lib/features/map/presentation/providers/graph_providers.dart',
    'lib/features/map/presentation/widgets/legend.dart',
  ])
  expect(g.fichiers['lib/features/map/presentation/providers/graph_providers.dart']!.out!.importe).toEqual(['lib/features/map/domain/road_graph.dart'])
  expect(g.fichiers['test/features/map/road_graph_test.dart']!.out!.teste).toEqual(['lib/features/map/domain/road_graph.dart'])

  expect(g.fichiers['lib/features/map/domain/road_graph.dart']!.exp!.sort()).toEqual(
    ['Clock', 'RoadEvent', 'RoadFlow', 'RoadGraph', 'buildRoadGraph', 'kRoadGraphToleranceM'].sort(),
  )
  expect(g.fichiers['lib/features/map/presentation/providers/graph_providers.dart']!.exp).toEqual(['graphProvider'])

  const n = neighbors(g, 'lib/features/map/domain/road_graph.dart')
  expect(n.in.importe ?? []).toContain('lib/features/map/presentation/providers/graph_providers.dart')
  expect([...(n.in.teste ?? []), ...n.tests]).toContain('test/features/map/road_graph_test.dart')

  const { rejected } = learn(g, { feature: 'graphe', fichiers: [{ p: 'lib/features/map/domain/road_graph.dart' }] }, LEARN)
  expect(rejected).toEqual([])

  const u = updateFiles(g, [{ p: 'lib/features/map/presentation/widgets/legend.dart', h: 'h2', text: `import '../../domain/road_graph.dart';\nclass Legend {}` }], [], [], CTX)
  expect(u.fichiers['lib/features/map/presentation/widgets/legend.dart']!.out!.importe).toEqual(['lib/features/map/domain/road_graph.dart'])
})

test('kindOf, isExcluded, detectStack, projectKey, hashPath', () => {
  expect(kindOf('components/a/B.vue')).toBe('composant')
  expect(kindOf('store/booking.ts')).toBe('store')
  expect(kindOf('helpers/x.js')).toBe('util')
  expect(kindOf('components/a/B.spec.ts')).toBe('test')
  expect(kindOf('src/pages/x.vue')).toBe('page')
  expect(kindOf('nuxt.config.ts')).toBe('config')
  expect(kindOf('types/a.d.ts')).toBe('type')
  expect(isExcluded('node_modules/a/b.js', EXCLUS_DEFAUT)).toBe(true)
  expect(isExcluded('src/locales/fr.json', EXCLUS_DEFAUT)).toBe(true)
  expect(isExcluded('locales/fr.ts', EXCLUS_DEFAUT)).toBe(false)
  expect(isExcluded('yarn.lock', EXCLUS_DEFAUT)).toBe(true)
  expect(isExcluded('libraries/lib/x.vue', EXCLUS_DEFAUT)).toBe(true)
  expect(detectStack(NUXT3_PKG, [])).toBe('Nuxt 3, Pinia, Apollo, Vuetify, TypeScript, vitest')
  expect(detectStack(undefined, ['nuxt.config.js', 'store/a.js'])).toBe('Nuxt 2, Vuex')
  expect(projectKey('C:\\Users\\x\\Documents\\Front\\reservation-tool')).toBe('front/reservation-tool')
  expect(projectKey('C:/Users/x/Documents/Back/graphql/')).toBe('back/graphql')
  const k = projectKey('C:\\dev\\My Proj')
  expect(k).toMatch(/^my-proj-[0-9a-f]{6}$/)
  expect(hashPath('C:\\dev\\My Proj')).toBe(hashPath('c:/dev/my proj/'))
})

test('featureText : fiche fraîche complète (résumé, entrées, rôles, tailles)', () => {
  const g = withFeatures()
  const f: Feature = g.features['complementary-products']!
  const t = featureText(g, f)
  expect(t).toContain('## Fiche complementary-products : Produits complémentaires et transports (confiance 0,90')
  expect(t).toContain('Opus 5.5')
  expect(t).toContain('Entrées : /booking/offer')
  expect(t).toContain('- pages/booking/offer.vue · entree · ')
  expect(tokensOf(t)).toBeLessThanOrEqual(1500)
})
// ── Fiche périmée actionnable, rafraîchissement, extrait d'agent, diff ───

const LATER = { commit: 'def5678', branche: 'master', le: '2026-10-15T08:00:00.000Z' }
const fiche = (): Graph => learn(small(), { feature: 'f', resume: 'Résumé', flux: ['étape un'], fichiers: [{ p: 'utils/a.ts' }, { p: 'utils/b.ts' }, { p: 'utils/c.ts' }] }, { ...LEARN, confiance: 0.8 }).graph
const touch = (g: Graph, ...ps: string[]) => updateFiles(g, ps.map(p => ({ p, h: `${p}-2`, text: 'z'.repeat(400) })), [], [], LATER)

test('perimeOf : dérivé des hash de la fiche (modifié, supprimé), pas de f.perime', () => {
  const g0 = fiche()
  expect(perimeOf(g0, g0.features.f!)).toEqual([])
  const g1 = updateFiles(touch(g0, 'utils/a.ts'), [], ['utils/b.ts'], [], LATER)
  const f = { ...g1.features.f!, perime: [] }
  expect(perimeOf(g1, f)).toEqual([
    { p: 'utils/a.ts', depuis: 'a1', nouveau: 'utils/a.ts-2' },
    { p: 'utils/b.ts', depuis: 'b1', nouveau: '' },
  ])
  expect(g1.features.f!.perime).toEqual(perimeOf(g1, g1.features.f!))
  expect(perimeOf(g1, undefined as never)).toEqual([])
})

test('refreshFiles : hash remis sur les fichiers relus, perime nettoyé, résumé et confiance intacts', () => {
  const g1 = touch(fiche(), 'utils/a.ts', 'utils/b.ts')
  expect(g1.features.f!.perime.map(x => x.p)).toEqual(['utils/a.ts', 'utils/b.ts'])
  const r = refreshFiles(g1, 'f', ['utils/a.ts'], LATER)
  expect(r.refreshed).toEqual(['utils/a.ts'])
  expect(r.unknown).toEqual([])
  const f = r.graph.features.f!
  expect(f.fichiers.find(x => x.p === 'utils/a.ts')!.h).toBe('utils/a.ts-2')
  expect(f.fichiers.find(x => x.p === 'utils/b.ts')!.h).toBe('b1')
  expect(f.perime).toEqual([{ p: 'utils/b.ts', depuis: 'b1', nouveau: 'utils/b.ts-2' }])
  expect([f.resume, f.flux, f.confiance, f.source]).toEqual(['Résumé', ['étape un'], 0.8, 'flow:1'])
  // un fichier encore périmé : la date d'apprentissage ne bouge pas
  expect(f.appris).toEqual({ le: CTX.le, commit: CTX.commit, branche: CTX.branche })
  // le graphe d'origine n'est pas modifié
  expect(g1.features.f!.fichiers.find(x => x.p === 'utils/a.ts')!.h).toBe('a1')

  // tout est relu (suffixe unique accepté) : la fiche est fraîche et reprend la date de la relecture
  const r2 = refreshFiles(r.graph, 'f', ['b.ts'], LATER)
  expect(r2.refreshed).toEqual(['utils/b.ts'])
  expect(r2.graph.features.f!.perime).toEqual([])
  expect(r2.graph.features.f!.appris).toEqual({ le: LATER.le, commit: 'def5678', branche: 'master' })
  expect(freshness(r2.graph, r2.graph.features.f!).niveau).toBe('fraiche')
  expect(r2.graph.features.f!.confiance).toBe(0.8)
})

test('refreshFiles : fichier hors fiche rejeté, supprimé retiré, fiche inconnue ou entrée bizarre : rien ne casse', () => {
  const g0 = learn(small(), { feature: 'ab', fichiers: [{ p: 'utils/a.ts' }, { p: 'utils/b.ts' }] }, LEARN).graph
  const g1 = updateFiles(touch(g0, 'utils/a.ts'), [], ['utils/b.ts'], [], LATER)
  const r = refreshFiles(g1, 'ab', ['utils/c.ts', 'nope.ts', 'utils/b.ts', 'utils/a.ts', 'utils/a.ts'], LATER)
  expect(r.unknown).toEqual(['utils/c.ts', 'nope.ts'])
  expect(r.refreshed).toEqual(['utils/b.ts', 'utils/a.ts'])
  const f = r.graph.features.ab!
  expect(f.fichiers.map(x => x.p)).toEqual(['utils/a.ts'])
  expect(f.perime).toEqual([])
  expect(f.appris.le).toBe(LATER.le)

  const none = refreshFiles(g1, 'inconnue', ['utils/a.ts'], LATER)
  expect(none.graph).toBe(g1)
  expect(none.refreshed).toEqual([])
  const hors = refreshFiles(g1, 'ab', ['utils/c.ts'], LATER)
  expect(hors.graph).toBe(g1)
  expect(hors.graph.features.ab!.fichiers.some(x => x.p === 'utils/c.ts')).toBe(false)
  expect(() => refreshFiles(g1, 'ab', undefined as never, LATER)).not.toThrow()
  expect(() => refreshFiles(g1, 'ab', [42, null] as never, LATER)).not.toThrow()
})

test('featureText : fiche partielle avec consignes (rafraichir, apprendre, diff) et taille du fichier modifié, budget tenu', () => {
  const g = touch(fiche(), 'utils/a.ts')
  const t = featureText(g, g.features.f!)
  expect(t).toContain("⚠ Modifiés depuis l'apprentissage : utils/a.ts")
  expect(t).toContain('Après relecture : si la fiche reste juste pour ces fichiers, action rafraichir (feature, fichiers = ceux relus) ; si elle est fausse, action apprendre avec corrections (et flux/pieges corrigés).')
  expect(t).toContain('Action diff (feature ou chemin) pour voir ce qui a changé sans tout relire.')
  expect(t).toMatch(/- utils\/a\.ts · .+ · 100 ⚠ modifié/)
  expect(tokensOf(t)).toBeLessThanOrEqual(1500)
  const long = 'x'.repeat(290)
  const gros = learn(g, { feature: 'f', resume: long.repeat(2), flux: Array.from({ length: 12 }, (_, i) => `${i} ${long}`) }, LEARN).graph
  const g2 = touch(gros, 'utils/a.ts')
  expect(tokensOf(featureText(g2, g2.features.f!))).toBeLessThanOrEqual(1500)
})

test('servedFiles et servedSubset : limités aux chemins demandés', () => {
  const g = touch(fiche(), 'utils/a.ts')
  const f = g.features.f!
  expect(servedFiles(g, f, 'feature').map(h => h.p)).toEqual(['utils/a.ts', 'utils/b.ts', 'utils/c.ts'])
  const sub = servedSubset(g, f, ['utils/a.ts', 'utils/c.ts', 'hors.ts'], 'agent')
  expect(sub).toEqual([
    { p: 'utils/a.ts', tok: 100, feature: 'f', frais: false, par: 'agent' },
    { p: 'utils/c.ts', tok: 400, feature: 'f', frais: true, par: 'agent' },
  ])
  expect(servedFiles(g, f, 'x', [])).toEqual([])
})

const CP = 'complementary-products'
const extractGraph = () =>
  learn(
    withFeatures(),
    {
      feature: CP,
      resume: 'Onglets Complémentaires et Transports de /booking/offer.',
      pieges: [
        { txt: 'Le stock vient du service', p: 'services/offer.ts' },
        { txt: 'Le store garde un cache', p: 'stores/booking/Booking.ts' },
        { txt: 'Sans fichier : prix en centimes' },
      ],
    },
    LEARN,
  ).graph
const ag = (prompt: string, tasks: string[] = []) => ({ name: 'agent', tasks, prompt })

test('extractFiles : par chemin, par nom de base, par export, repli sur les rôles centraux', () => {
  const g = extractGraph()
  const f = g.features[CP]!
  expect(extractFiles(g, f, ag('Corrige services/offer.ts pour le stock'))).toEqual(['services/offer.ts'])
  expect(extractFiles(g, f, ag('', ['Ajouter un getter dans useBookingStore']))).toEqual(['stores/booking/Booking.ts'])
  expect(extractFiles(g, f, ag('Brancher OfferService sur la page'))).toEqual(['services/offer.ts'])
  expect(extractFiles(g, f, ag('adapte le BOOKING store'))).toEqual(['stores/booking/Booking.ts'])
  expect(extractFiles(g, f, ag('Relis le slug use-booking-store'))).toEqual(['stores/booking/Booking.ts'])
  // un nom plus long qui contient celui d'un fichier n'est pas une citation
  expect(extractFiles(g, f, ag('OfferServices et Bookings'))).toEqual(extractFiles(g, f, ag('rien')))
  // rien de cité : fichiers entree, coeur et donnees dans l'ordre de la fiche
  expect(extractFiles(g, f, ag('Écris la documentation'))).toEqual(f.fichiers.filter(x => ['entree', 'coeur', 'donnees'].includes(x.role)).map(x => x.p))
  expect(extractFiles(g, f, ag('Corrige index et utils'))).toEqual(extractFiles(g, f, ag('rien')))
  expect(() => extractFiles(g, f, { name: 'a', tasks: undefined as never, prompt: undefined as never })).not.toThrow()
})

test('agentExtract : en-tête, fichiers cités, pièges rattachés, résumé, ligne d’outil', () => {
  const g = extractGraph()
  const f = g.features[CP]!
  const t = agentExtract(g, f, ag('Corrige services/offer.ts'))
  expect(t.split('\n')[0]).toBe('# Cache revo-flow — fiche « complementary-products : Produits complémentaires et transports » (✓ fraîche, confiance 0,90)')
  expect(t).toMatch(/\n- services\/offer\.ts · donnees · \d+\n/)
  expect(t).not.toContain('stores/booking/Booking.ts')
  expect(t).toContain('Pièges :')
  expect(t).toContain('- Le stock vient du service (services/offer.ts)')
  expect(t).not.toContain('Le store garde un cache')
  expect(t).toContain('- Sans fichier : prix en centimes')
  expect(t).toContain('Résumé : Onglets Complémentaires')
  expect(t.split('\n').pop()).toBe('Outil mcp__revo-flow__cache : feature « complementary-products » pour la fiche entière, voisins (chemin), diff (fichier modifié), rafraichir ou apprendre après relecture d’un fichier ⚠.')
  expect(tokensOf(t)).toBeLessThanOrEqual(600)
})

test('agentExtract : ⚠ modifié et ✕ supprimé, pas de résumé quand la fiche est très périmée', () => {
  const g0 = extractGraph()
  const prompt = ag('services/offer.ts, stores/booking/Booking.ts et pages/booking/offer.vue')
  const g1 = updateFiles(g0, [{ p: 'services/offer.ts', h: 'n1', text: 'export const x = 1' }], [], [], LATER)
  const t1 = agentExtract(g1, g1.features[CP]!, prompt)
  expect(freshness(g1, g1.features[CP]!).niveau).toBe('partielle')
  expect(t1).toMatch(/- services\/offer\.ts · donnees · \d+ ⚠ modifié depuis l'apprentissage/)
  expect(t1).not.toMatch(/Booking\.ts · donnees · \d+ ⚠/)
  expect(t1).toContain('Résumé :')
  // tout change ou disparaît : très périmée, résumé masqué, supprimé marqué
  const g2 = updateFiles(
    g1,
    [
      { p: 'stores/booking/Booking.ts', h: 'n2', text: 'export const y = 1'.repeat(400) },
      { p: 'pages/booking/offer.vue', h: 'n3', text: '<template><div /></template>'.repeat(400) },
    ],
    ['services/offer.ts'],
    [],
    LATER,
  )
  expect(freshness(g2, g2.features[CP]!).niveau).toBe('perimee')
  const t2 = agentExtract(g2, g2.features[CP]!, prompt)
  expect(t2).toContain('✕ très périmée')
  expect(t2).toContain('- services/offer.ts · donnees ✕ supprimé')
  expect(t2).not.toContain('Résumé :')
  expect(t2).toContain('Outil mcp__revo-flow__cache')
})

test('agentExtract : budget tenu, le résumé saute avant le reste, la ligne d’outil reste', () => {
  let g = extractGraph()
  g = learn(g, { feature: CP, resume: 'r'.repeat(600) }, LEARN).graph
  const f = g.features[CP]!
  const all = ag('services/offer.ts stores/booking/Booking.ts pages/booking/offer.vue')
  const big = agentExtract(g, f, all)
  expect(big).toContain('Résumé :')
  const court = agentExtract(g, f, all, 160)
  expect(tokensOf(court)).toBeLessThanOrEqual(160)
  expect(court).not.toContain('Résumé :')
  expect(court).toContain('Outil mcp__revo-flow__cache')
  expect(court.split('\n')[0]).toContain('# Cache revo-flow')
  expect(tokensOf(agentExtract(g, f, all, 40))).toBeLessThanOrEqual(40)
})

const hunk = (n: number, len = 100) => [`@@ -${n},20 +${n},20 @@`, ...Array.from({ length: 20 }, (_, i) => `${i % 2 ? '+' : '-'}${'x'.repeat(len)}`)]

test('diffText : en-tête, compte des lignes, diff indisponible, aucune différence', () => {
  const g = extractGraph()
  const f = g.features[CP]!
  const t = diffText(g, f, undefined, [
    { p: 'services/offer.ts', depuis: 'a', diff: '@@ -1,3 +1,3 @@\n a\n-b\n+c\n+d\n e\n' },
    { p: 'stores/booking/Booking.ts', depuis: 'b', diff: undefined },
    { p: 'pages/booking/offer.vue', depuis: 'c', diff: '' },
  ])
  expect(t.split('\n')[0]).toMatch(/^Diff depuis l'apprentissage de « complementary-products » \(le \d\d\/\d\d, commit abc1234\)$/)
  expect(t).toContain('### services/offer.ts (+2/-1 lignes)\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n+d\n e')
  expect(t).toContain('### stores/booking/Booking.ts\ndiff indisponible (blob absent) : relis le fichier.')
  expect(t).toContain('### pages/booking/offer.vue\naucune différence.')
  expect(diffText(g, undefined, 'services/offer.ts', [{ p: 'services/offer.ts', depuis: 'a', diff: '@@ -1 +1 @@\n-a\n+b' }]).split('\n')[0]).toBe("Diff depuis l'apprentissage de services/offer.ts")
  expect(diffText(g, f, undefined, [])).toContain('aucun fichier modifié')
  expect(() => diffText(g, f, undefined, undefined as never)).not.toThrow()
  expect(() => diffText(g, f, undefined, [null, { p: 3, diff: 5 }] as never)).not.toThrow()
})

test('diffText : ≤ 2 500 tokens, hunks entiers puis ligne de troncature', () => {
  const g = extractGraph()
  const f = g.features[CP]!
  const lines = Array.from({ length: 200 }, (_, i) => hunk(i * 30 + 1)).flat()
  const t = diffText(g, f, undefined, [{ p: 'services/offer.ts', depuis: 'a', diff: lines.join('\n') }])
  expect(tokensOf(t)).toBeLessThanOrEqual(2500)
  const rows = t.split('\n').slice(2)
  const last = rows.pop()!
  expect(last).toMatch(/^… \(tronqué, \d+ lignes de plus\)$/)
  expect(rows.length % 21).toBe(0)
  expect(rows[rows.length - 1]).toMatch(/^[+-]x+$/)
  const left = Number(/(\d+) lignes de plus/.exec(last)![1])
  expect(rows.length + left).toBe(lines.length)
  expect(t).toContain('(+2000/-2000 lignes)')
})

test('diffText : un seul gros hunk coupé par lignes, budget partagé entre les fichiers', () => {
  const g = extractGraph()
  const f = g.features[CP]!
  const one = ['@@ -1,3000 +1,3000 @@', ...Array.from({ length: 3000 }, () => `+${'y'.repeat(80)}`)].join('\n')
  const t1 = diffText(g, f, undefined, [{ p: 'services/offer.ts', depuis: 'a', diff: one }])
  expect(tokensOf(t1)).toBeLessThanOrEqual(2500)
  expect(t1).toMatch(/… \(tronqué, \d+ lignes de plus\)$/)
  expect(t1).toContain('@@ -1,3000 +1,3000 @@')
  const huge = Array.from({ length: 100 }, (_, i) => hunk(i * 30 + 1)).flat().join('\n')
  const paths = ['services/offer.ts', 'stores/booking/Booking.ts', 'pages/booking/offer.vue']
  const t2 = diffText(g, f, undefined, paths.map(p => ({ p, depuis: 'a', diff: huge })))
  expect(tokensOf(t2)).toBeLessThanOrEqual(2500)
  for (const p of paths) expect(t2).toContain(`### ${p} (+1000/-1000 lignes)`)
  expect(t2.match(/… \(tronqué/g)).toHaveLength(3)
  // trop de fichiers pour le budget : les derniers sont annoncés
  const many = Array.from({ length: 30 }, (_, i) => ({ p: `f${i}.ts`, depuis: 'a', diff: huge }))
  const t3 = diffText(g, f, undefined, many)
  expect(tokensOf(t3)).toBeLessThanOrEqual(2500)
})

// ── Correctifs v1.3.2 ────────────────────────────────────────────────────

test('learn : une fiche nouvelle sans fichier valide est refusée ; une fiche existante restée sans fichier n’est ni fraîche ni servie', () => {
  const g0 = withFeatures()
  const r = learn(g0, { feature: 'transitions-ecrans', resume: 'Transitions', fichiers: [{ p: 'lib/nope.dart' }] }, LEARN)
  expect(r.refus).toContain('aucun fichier valide')
  expect(r.graph).toBe(g0)
  expect(r.graph.features['transitions-ecrans']).toBeUndefined()
  expect(r.rejected).toEqual(['lib/nope.dart'])
  expect(learn(g0, { feature: 'sans-rien', resume: 'x' }, LEARN).refus).toBeDefined()

  // Fiche existante dont le seul fichier disparaît : écrite avec un avertissement, puis vide
  const g1 = updateFiles(g0, [], ['composables/useCart.ts'], [], LATER)
  const r2 = learn(g1, { feature: 'panier', resume: 'Le panier' }, LEARN)
  expect(r2.refus).toBeUndefined()
  expect(r2.avertissement).toContain('à reconstruire')
  const f = r2.graph.features.panier!
  expect(f.fichiers).toEqual([])
  const fr = freshness(r2.graph, f)
  expect(fr).toMatchObject({ niveau: 'perimee', vide: true, confiance: 0 })
  expect(matchRequest(r2.graph, 'ajouter un bouton dans le panier')).toBeUndefined()
  expect(featureText(r2.graph, f)).toContain('Fiche sans aucun fichier du projet : à reconstruire')
  expect(featureText(r2.graph, f)).not.toContain('Fichiers (0')
  expect(briefText(r2.graph, undefined)).toContain('panier ✕ vide')
  expect(computeStats(r2.graph, null, 'demo')!.fraiches).toBe(1)
})

test('learn : les entrées sont du texte (commandes, outils, routes), jamais rejetées comme chemins', () => {
  const { graph, rejected } = learn(
    nuxt3(),
    {
      feature: 'flow',
      fichiers: [{ p: 'pages/booking/offer.vue' }],
      entrees: ['/revo-flow <demande>', '/revo-flow stop', 'outil plan', '/booking/offer', 'services/offer.ts', 'mutation createOrder'],
    },
    LEARN,
  )
  expect(rejected).toEqual([])
  expect(graph.features.flow!.entrees).toEqual(['/revo-flow <demande>', '/revo-flow stop', 'outil plan', 'r:/booking/offer', 'services/offer.ts', 'mutation createOrder'])
  expect(featureText(graph, graph.features.flow!)).toContain('Entrées : /revo-flow <demande>, /revo-flow stop, outil plan, /booking/offer')
})

test('briefText et agentExtract : les pièges passent avant la liste des fichiers et survivent à la coupe', () => {
  const many: Record<string, string> = {}
  for (let i = 0; i < 40; i++) many[`utils/fichier-au-nom-assez-long-${i}.ts`] = `export const v${i} = ${i}`
  const g0 = buildGraph({ cle: 'front/demo', racine: 'C:/x', nom: 'demo', files: files(many), ...CTX })
  const { graph } = learn(
    g0,
    {
      feature: 'gros',
      resume: 'Une grosse fiche.',
      fichiers: Object.keys(many).map(p => ({ p })),
      pieges: [{ txt: 'Piège capital : le prix est en centimes', p: 'utils/fichier-au-nom-assez-long-3.ts' }],
    },
    LEARN,
  )
  const f = graph.features.gros!
  const b = briefText(graph, f, 400)
  expect(tokensOf(b)).toBeLessThanOrEqual(400)
  expect(b).toContain('Piège capital')
  expect(b).toContain('… (tronqué)')
  expect(b.indexOf('Pièges :')).toBeLessThan(b.indexOf('Fichiers ('))
  const t = agentExtract(graph, f, ag('Corrige tout'), 120)
  expect(tokensOf(t)).toBeLessThanOrEqual(120)
  expect(t).toContain('Piège capital')
})

test('buildGraph : un fichier de test ne crée ni opération GraphQL, ni endpoint, ni externe', () => {
  const fixture = [
    "const N3 = { 'graphql/x.ts': `export const q = gql`",
    '  query Accommodations { id }',
    '`,',
    "  'services/y.ts': `import type { Offer } from '~/generated/gql-types/graphql'",
    "const r = await fetch('/complementary-products/test-only')`,",
    '}',
  ].join('\n')
  const src = { ...N3, 'hooks/cache/graph.test.ts': fixture }
  const g = buildGraph({ cle: 'front/demo', racine: 'C:/x', nom: 'demo', files: files(src), pkgJson: NUXT3_PKG, ...CTX })
  expect(g.fichiers['hooks/cache/graph.test.ts']!.k).toBe('test')
  expect(g.noeuds['q:Accommodations']).toBeUndefined()
  expect(g.noeuds['a:GET /complementary-products/test-only']).toBeUndefined()
  expect(g.fichiers['hooks/cache/graph.test.ts']!.out).toBeUndefined()
  // Les nœuds du vrai code restent
  expect(g.noeuds['q:allOffers']!.def).toBe('graphql/offers.ts')
  expect(g.noeuds['x:generated/gql-types']).toBeDefined()
  const u = updateFiles(g, [{ p: 'hooks/cache/graph.test.ts', h: 'h2', text: fixture }], [], [], LATER)
  expect(u.noeuds['q:Accommodations']).toBeUndefined()
})

test('autoFiche et completeFiche : fichiers non vérifiés (h vide), à relire, jamais comptés frais', () => {
  const g0 = withFeatures()
  const g1 = completeFiche(g0, 'panier', ['utils/price.ts'])
  const f = g1.features.panier!
  expect(f.fichiers.find(x => x.p === 'utils/price.ts')!.h).toBe('')
  const fr = freshness(g1, f)
  expect(fr.niveau).toBe('partielle')
  expect(fr.ratio).toBe(0)
  expect(fr.perimes).toEqual(['utils/price.ts'])
  expect(fr.nonVerifies).toEqual(['utils/price.ts'])
  expect(fr.confiance).toBe(0.9)
  const t = featureText(g1, f)
  expect(t).toContain('⚠ 1 fichier non vérifié')
  expect(t).toContain('Jamais vérifiés (ajoutés automatiquement) : utils/price.ts')
  expect(t).not.toContain("Modifiés depuis l'apprentissage")
  expect(t).toMatch(/- utils\/price\.ts · peripherique · \d+ ⚠ non vérifié/)
  expect(servedFiles(g1, f, 'brief').find(h => h.p === 'utils/price.ts')!.frais).toBe(false)
  expect(perimeOf(g1, f)).toEqual([{ p: 'utils/price.ts', depuis: '', nouveau: g1.fichiers['utils/price.ts']!.h }])
  expect(diffText(g1, f, undefined, [{ p: 'utils/price.ts', depuis: '', diff: undefined }])).toContain('jamais vérifié')
  // Une relecture confirme le fichier : la fiche redevient fraîche
  const g2 = refreshFiles(g1, 'panier', ['utils/price.ts'], LATER).graph
  expect(freshness(g2, g2.features.panier!).niveau).toBe('fraiche')
  // Fiche automatique neuve : tous ses fichiers sont à relire, confiance intacte
  const g3 = autoFiche(g0, 'auto', [{ p: 'utils/price.ts' }, { p: 'services/offer.ts' }], LEARN)
  expect(freshness(g3, g3.features.auto!)).toMatchObject({ niveau: 'partielle', ratio: 0, confiance: 0.5 })
})

test('detectStack par manifestes, kindOf hooks/, brief sans « Stack : inconnue », MECA_FORMAT 4', () => {
  expect(MECA_FORMAT).toBe(4)
  expect(MANIFESTES).toContain('.claude-plugin/plugin.json')
  expect(detectStack(undefined, [], undefined, { '.claude-plugin/plugin.json': '{}', 'tsconfig.json': '{}' })).toBe('Plugin Claude Code, TypeScript')
  expect(detectStack(undefined, [], undefined, { 'tsconfig.json': '{}' })).toBe('TypeScript')
  expect(detectStack(undefined, [], undefined, { 'pyproject.toml': '' })).toBe('Python')
  expect(detectStack(undefined, [], undefined, { 'requirements.txt': 'x' })).toBe('Python')
  expect(detectStack(undefined, [], undefined, { 'go.mod': 'module x' })).toBe('Go')
  expect(detectStack(undefined, [], undefined, { 'Cargo.toml': '' })).toBe('Rust')
  expect(detectStack(NUXT3_PKG, [], undefined, { 'tsconfig.json': '{}' })).toBe('Nuxt 3, Pinia, Apollo, Vuetify, TypeScript, vitest')
  expect(detectStack(undefined, [])).toBe('inconnue')
  expect(kindOf('hooks/register.tsx', 'Plugin Claude Code, TypeScript')).toBe('service')
  expect(kindOf('hooks/cache/graph.ts', 'Plugin Claude Code')).toBe('service')
  expect(kindOf('src/hooks/useCart.ts', 'React')).toBe('composable')
  const plugin = buildGraph({
    cle: 'revo-flow-abcdef',
    racine: 'C:/x/revo-flow',
    nom: 'revo-flow',
    files: files({ 'hooks/register.tsx': 'export const a = 1', 'types/cache.d.ts': 'export type A = 1' }),
    manifestes: { '.claude-plugin/plugin.json': '{}', 'tsconfig.json': '{}' },
    ...CTX,
  })
  expect(plugin.projet.stack).toBe('Plugin Claude Code, TypeScript')
  expect(plugin.fichiers['hooks/register.tsx']!.k).toBe('service')
  expect(briefText(plugin, undefined)).toContain('Stack : Plugin Claude Code, TypeScript')
  const inconnu = buildGraph({ cle: 'x-abcdef', racine: 'C:/x', nom: 'x', files: files({ 'a/b.ts': 'export const b = 1' }), ...CTX })
  expect(inconnu.projet.stack).toBe('inconnue')
  expect(briefText(inconnu, undefined)).not.toContain('Stack')
  expect(briefText({ ...inconnu, projet: { ...inconnu.projet, conventions: 'Code en français' } }, undefined)).toContain('Conventions : Code en français')
})

// ── Démarrage à froid : sum mécanique et carte ───────────────────────────

test('headSummary : 1re phrase du commentaire de tête (JSDoc, //, Dart ///), titre d’un .md, rien pour un test, coupé à 120', () => {
  expect(headSummary('a.ts', '/**\n * Le panier : lignes, total et code promo. Le reste suit.\n * @param x rien\n */\nexport const a = 1', 'service')).toBe(
    'Le panier : lignes, total et code promo.',
  )
  expect(headSummary('b.ts', '// eslint-disable-next-line\n// Formate un prix en euros, p. ex. 12,50 €.\nexport const f = 1', 'util')).toBe(
    'Formate un prix en euros, p. ex. 12,50 €.',
  )
  expect(headSummary('lib/c.dart', '/// Écran de réservation des séances.\nclass BookingScreen {}', 'page')).toBe('Écran de réservation des séances.')
  expect(headSummary('docs/d.md', '---\ntitle: x\n---\n# Guide **du** [cache](x.md)\ntexte', 'doc')).toBe('Guide du cache')
  expect(headSummary('e.spec.ts', '/** Les tests du panier. */', 'test')).toBeUndefined()
  // Pas de commentaire de tête : celui de la première déclaration publique d'un petit module.
  expect(headSummary('f.ts', "import x from 'y'\n\n/** Calcule la remise d'une offre. */\nexport function remise() {}", 'util')).toBe(
    "Calcule la remise d'une offre.",
  )
  const long = headSummary('g.ts', `/** ${'mot '.repeat(60)}fin. */`, 'util')!
  expect(long.length).toBeLessThanOrEqual(120)
  expect(long.endsWith('…')).toBe(true)
  expect(headSummary('h.ts', '/* eslint-disable */\nexport const h = 1', 'util')).toBeUndefined()
})

test('buildGraph : sum mécanique écrit pour le code, gardé tel quel quand il vient d’un modèle et que le fichier n’a pas changé', () => {
  const src = { 'services/cart.ts': '/** Le panier et son total. */\nexport const cart = 1' }
  const g = buildGraph({ cle: 'x-1', racine: 'C:/x', nom: 'x', files: files(src), ...CTX })
  expect(g.fichiers['services/cart.ts']!.sum).toBe('Le panier et son total.')
  expect(g.fichiers['services/cart.ts']!.mots).toContain('panier')
  const llm = { ...g, fichiers: { ...g.fichiers, 'services/cart.ts': { ...g.fichiers['services/cart.ts']!, sum: 'Résumé du modèle', sumLlm: true as const } } }
  const again = buildGraph({ cle: 'x-1', racine: 'C:/x', nom: 'x', files: files(src), prev: llm, ...CTX })
  expect(again.fichiers['services/cart.ts']!.sum).toBe('Résumé du modèle')
  const changed = buildGraph({ cle: 'x-1', racine: 'C:/x', nom: 'x', files: files(src, 'h2'), prev: llm, ...CTX })
  expect(changed.fichiers['services/cart.ts']!.sum).toBe('Le panier et son total.')
})

/** Un petit plugin : un cœur central (importé par tous), une relance, un panier, et du bruit (test, doc, généré). */
const PLUGIN_SRC: Record<string, string> = {
  'hooks/lib.ts': '/** Les utilitaires partagés : slug, tarifs. */\nexport const slug = 1',
  'hooks/register.tsx': "/** Le cœur du flow : plan, agents, relance des agents en attente. */\nimport { slug } from './lib'\nexport function relaunch() {}\nfunction blockedNote() {}",
  'hooks/views.tsx': "/** Le panneau et la bande. */\nimport { slug } from './lib'\nexport const View = 1",
  'hooks/art.ts': "/** Les SVG des cartes. */\nimport { slug } from './lib'\nexport const svg = 1",
  'hooks/cart.ts': "/** Le panier du démonstrateur. */\nimport { slug } from './lib'\nexport const cart = 1",
  'hooks/flow.test.ts': "/** Tests de la relance des agents en attente. */\nimport { relaunch } from './register'",
  'docs/relance.md': '# Relance des agents en attente',
  'generated/types.ts': '/** Relance générée. */\nexport type Relance = 1',
}
const plugin = () =>
  buildGraph({ cle: 'p-1', racine: 'C:/p', nom: 'p', files: files(PLUGIN_SRC), manifestes: { '.claude-plugin/plugin.json': '{}' }, ...CTX })

test('coldRank : la demande d’abord (glossaire FR → EN compris), puis la centralité ; ni tests, ni docs, ni générés', () => {
  const g = plugin()
  const ranked = coldRank(g, 'améliorer la relance des agents en attente')
  expect(ranked[0]!.p).toBe('hooks/register.tsx')
  expect(ranked[0]!.pertinent).toBe(true)
  expect(ranked.map(x => x.p)).not.toContain('hooks/flow.test.ts')
  expect(ranked.map(x => x.p)).not.toContain('docs/relance.md')
  expect(ranked.map(x => x.p)).not.toContain('generated/types.ts')
  expect(coldRank(g, 'le panier')[0]!.p).toBe('hooks/cart.ts')
  // Rien de pertinent : la centralité seule, et lib.ts, importé par tous, en tête.
  const none = coldRank(g, 'zzz')
  expect(none.every(x => !x.pertinent)).toBe(true)
  expect(none[0]!.p).toBe('hooks/lib.ts')
  const tiny = buildGraph({ cle: 't-1', racine: 'C:/t', nom: 't', files: files({ 'a.ts': 'export const a = 1' }), ...CTX })
  expect(coldRank(tiny, 'a')).toEqual([])
})

test('coldMap et briefText : carte à froid dans le budget, titre selon la pertinence, rien sans demande', () => {
  const g = plugin()
  const map = coldMap(g, 'améliorer la relance des agents en attente')
  expect(map.split('\n')[0]).toBe('## Fichiers probables pour cette demande (carte, à vérifier)')
  expect(map).toMatch(/^- hooks\/register\.tsx · service · ≈ .* · Le cœur du flow : plan, agents, relance des agents en attente\.$/m)
  expect(coldMap(g, 'zzz').split('\n')[0]).toMatch(/^## Rien ne ressort pour cette demande : fichiers les plus centraux/)
  expect(tokensOf(coldMap(g, 'relance', 40))).toBeLessThanOrEqual(40)
  const brief = briefText(g, undefined, 1200, 'améliorer la relance des agents en attente')
  expect(brief).toContain('## Fichiers probables pour cette demande')
  expect(brief.trimEnd().endsWith('apprendre (en fin de flow, ou fiche fausse).')).toBe(true)
  expect(tokensOf(brief)).toBeLessThanOrEqual(1200)
  expect(briefText(g, undefined)).not.toContain('Fichiers probables')
})
