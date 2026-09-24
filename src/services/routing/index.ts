// ── Core (built first) ──────────────────────────────────────────────
export * from './types'
export * from './registry.generated'
export * from './resolve'
export * from './combos'
export * from './advisor'

// ── Capacity / account fallback (ported ccb subsystems) ──────────
export * from './capacity'
export * from './accountFallback'

// ── Intent routing & classification (L1 keyword + L2 embedding) ─────
export * from './intentRouter'
export * from './classification'
export * from './embedding'

// ── Routing strategies & selection ──────────────────────────────────
export * from './stickyRoundRobin'
export * from './providerTiers'
export * from './unifiedRouter'

// ── Model selection intelligence (ccb advisor/ranking/quota) ────
export * from './advisorQuota'
export * from './modelRankings'
export * from './rerank'
export * from './fusion'
export * from './translator'

// ── Ops / introspection / bootstrap ────────────────────────────────
export * from './health'
export * from './settingsSync'
export * from './providerCatalog'
export * from './inspect'
export * from './costEstimator'
export * from './bootstrap'

// ── Shadow receipt (package 1 observability) ──────────────────────────
// Immutable multi-factor model-selection observation. Read-only w.r.t. the
// dispatch decision; must never influence which route is chosen.
export * from './shadowReceipt'
