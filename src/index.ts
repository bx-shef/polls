export * from './domain/schema'
export * from './domain/compile'
export * from './domain/aggregate'
// metrics/answers: наружу — только публичное API. round1/round2 и coerceExclusive
// остаются внутренними (импортируются из своих модулей напрямую, в т.ч. тестами).
export { nps, csat, ces, distribution } from './domain/metrics'
export type { NpsSummary, CsatSummary, CesSummary } from './domain/metrics'
export { validateAnswer, normalizeAnswer, buildResponseAnswers } from './domain/answers'
export type { BuiltAnswers } from './domain/answers'
export { MemoryStore } from './store/memory'
export { PgStore } from './store/pg'
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './store/types'
export type { IStore, ResponsePage, ResponsePageOptions } from './store/types'
export type { Queryable, PgStoreOptions } from './store/pg'
