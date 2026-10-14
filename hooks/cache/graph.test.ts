import { expect, test } from 'claude-code/testing'

import {
  autoFiche,
  briefText,
  buildGraph,
  candidatesFromLog,
  candidatesText,
  completeFiche,
  computeStats,
  detectStack,
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
  projectKey,
  recordUsage,
  search,
  searchText,
  servedFiles,
  tokensOf,
  updateFiles,
  MECA_FORMAT,
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

  const g2 = updateFiles(g1, [{ p: 'utils/c.ts', h: 'c2', text: 'c'.repeat(1600) }], [], [], CTX)
  const fr2 = freshness(g2, g2.features.f!)
  expect(fr2.niveau).toBe('perimee')
  expect(fr2.ratio).toBe(0.83)
  const txt = featureText(g2, g2.features.f!)
  expect(txt).not.toContain('Flux :')
  expect(txt).not.toContain('étape un')
  expect(txt).toContain('très périmée')

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
  expect(rejected).toEqual(['nope/x.ts', '/inexistante', 'ailleurs.ts'])
  const f = graph.features['double-session']!
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
  expect(f.fichiers).toEqual([{ p: 'pages/booking/offer.vue', role: 'entree', h: 'h-pages/booking/offer.vue' }])
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