// Context reduction stays inside CCB. No sidecar, port, child process, or
// runtime dependency is needed; pure strategies below are the implementation.

// ── Embedded context subsystems (pure strategies + orchestration) ────
export { alignCacheBlocks, stablePrefixHash } from './cacheAlign'
export * from './compress'
export * from './decision'
export * from './mcp'
export * from './pipeline'
export * from './runtime'
