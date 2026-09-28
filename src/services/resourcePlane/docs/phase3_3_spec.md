# Phase 3.3 Specification: Feature Flag Integration

**Baseline**: Commit `92fccae` (Phase 3.2 closed)
**Goal**: Wire resourcePlane read path into loader behind feature flag
**Security Invariant**: Keep existing behavior as default; opt-in only

---

## 1. Requirements

### 1.1 Feature Flag
- Add `CCB_RESOURCE_PLANE=1` check in `loader.ts` → `loadProviders()`
- When enabled: use `loadProvidersFromResourcePlane({ decryptCredentials: false })` as metadata source
- When disabled (default): unchanged behavior using current `providers.json` + built-ins

### 1.2 Credential Resolution
- Must remain **lazy**: metadata read returns no plaintext credentials
- At transport boundary, use `resolveTransportCredential()` to decrypt exactly one credential per request
- Never bulk-decrypt all credentials unless explicitly opted in with `decryptCredentials: true`

### 1.3 Cache Integration
- Reuse existing `_cachedProviders` memoization pattern
- When `CCB_RESOURCE_PLANE=1`, also invalidate via `invalidateResourcePlaneCache()` when providers change
- Keep same stale-on-invalidate semantics

### 1.4 Constraints (HARD)
- ❌ Do NOT modify `~/.claude/providers.json`
- ❌ Do NOT change credential migration logic
- ❌ Do NOT alter OAuth/API key storage format
- ❌ Do NOT modify APISIX/OmniRoute/Hermes paths
- ❌ Do NOT switch default runtime provider
- ✅ MUST preserve rollback: `unset CCB_RESOURCE_PLANE` or set to `0`

---

## 2. Implementation

### 2.1 Changes to `loader.ts`

```typescript
import { loadProvidersFromResourcePlane } from '../resourcePlane/readAdapter.js'

export function loadProviders(): ProviderConfig[] {
  // Phase 3.3: resourcePlane feature flag — opt-in only, falls back to legacy path
  if (process.env.CCB_RESOURCE_PLANE === '1') {
    const rpProviders = loadProvidersFromResourcePlane({ decryptCredentials: false })
    if (rpProviders.length > 0) {
      return injectCodeBuddyCnAccounts(rpProviders)
    }
    // resourcePlane empty or unavailable: fall through to legacy path
  }

  // Existing behavior unchanged...
  // J1: return cached result if available
  if (_cachedProviders !== null) return _cachedProviders
  // ... rest of existing logic
}
```

### 2.2 Changes to `readAdapter.ts`

Add export for `invalidateResourcePlaneCache`:
```typescript
export { invalidateResourcePlaneCache } from './readAdapter.js'
// OR re-export in loader.ts
```

Actually, `invalidateResourcePlaneCache` is already exported from `readAdapter.ts`.

---

## 3. Acceptance Criteria

### 3.1 Functional
- [ ] `CCB_RESOURCE_PLANE=0` (default): loader behavior identical to pre-Phase 3.3
- [ ] `CCB_RESOURCE_PLANE=1`: loader uses resourcePlane PG as source when populated
- [ ] `CCB_RESOURCE_PLANE=1` + empty resourcePlane: fallback to legacy path
- [ ] `CCB_RESOURCE_PLANE=1` + unavailable PG: graceful degradation (empty array → fallback)

### 3.2 Security
- [ ] Metadata read (`decryptCredentials: false`) returns ZERO plaintext credentials
- [ ] All 90 credential secrets use `rpenc:v1:1:aes-256-gcm:` envelope
- [ ] `resolveTransportCredential()` decrypts single credential only at request time
- [ ] No plaintext leak in logs, caches, or return values

### 3.3 Shadow Diff
- [ ] Run `bun run scripts/shadow-diff.ts` with `CCB_RESOURCE_PLANE=1`
- [ ] `identityMismatchCount == 0`
- [ ] `securityViolationCount == 0`

### 3.4 Tests
- [ ] All existing tests pass (64 resourcePlane + existing providerRegistry tests)
- [ ] New tests cover:
  - `CCB_RESOURCE_PLANE=0` → legacy path unchanged
  - `CCB_RESOURCE_PLANE=1` → resourcePlane path used
  - `CCB_RESOURCE_PLANE=1` + empty DB → fallback works
  - `CCB_RESOURCE_PLANE=1` + PG error → graceful degradation

### 3.5 Rollback
- [ ] `unset CCB_RESOURCE_PLANE` restores original behavior
- [ ] `export CCB_RESOURCE_PLANE=0` restores original behavior
- [ ] No persistent state changes (only PG reads, no writes)

---

## 4. Out of Scope (Do NOT Do)
- ❌ Do NOT migrate production credentials
- ❌ Do NOT delete `~/.claude/providers.json`
- ❌ Do NOT enable by default
- ❌ Do NOT enter Phase 3.4
- ❌ Do NOT modify other services (poolRegistry, routing, etc.)

---

## 5. Evidence to Produce
1. `phase3_3_validation.md` with test results, shadow diff, rollback verification
2. Git commit with clear message
3. Diff summary showing only Phase 3.3 scope changes
