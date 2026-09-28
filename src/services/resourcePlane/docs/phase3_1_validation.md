# Phase 3.1 Validation: CCB Runtime → PG Resource Plane Read-Only Access

**Status**: COMPLETE  
**Date**: 2026-09-28  
**Commit**: HEAD (be07336da + Phase 3.1 changes)  
**Rollback Point**: `git stash` or `git reset --hard be07336da837c24f4bd4878b3555b4ddaab55725`

---

## 1. CCB Current Read Path (Pre-Phase 3.1)

### Source: `src/services/providerRegistry/loader.ts` → `loadProviders()`

| Step | Source | Function | Notes |
|------|--------|----------|-------|
| 1 | `BUILTIN_PROVIDERS` | `DEFAULT_PROVIDERS` + `EMBEDDED_PROVIDERS` + `EMBEDDED_ROUTING_PROVIDERS` | 4 core + ccb-routing (namespaced `ccb/*`) |
| 2 | `loadCcbEmbedProviders()` | `~/.ccb-embed/providers.json` | CCB credential store (keys/oauth) |
| 3 | `loadHermesProviders()` | `~/.hermes/config.yaml` | Legacy agent config |
| 4 | `loadCodexOAuthProviders()` | `~/.claude/openai-chatgpt-auth.json` / `~/.codex/auth.json` | Dynamic Codex OAuth |
| 5 | `~/.claude/providers.json` | User overrides | Merged on top, replaces by `id` |
| 6 | **CCB_INTERNAL_ROUTER=1** | `getLoadedProviders()` (poolRegistry) | PG-backed via `omniroute` schema |

### Key Constraint
- **Default path** (`CCB_INTERNAL_ROUTER !== '1'`): File-based providers.json + embedded defaults
- **Router path** (`CCB_INTERNAL_ROUTER === '1'`): PG `omniroute.*` tables via `pgLoader.ts`

---

## 2. New PG Read Path (Phase 3.1 — Read-Only)

### Source: `src/services/resourcePlane/readAdapter.ts`

| Function | Purpose | Security Posture |
|----------|---------|------------------|
| `loadProvidersFromResourcePlane(options)` | Read provider accounts + model capabilities from `resource_plane.*` | **Default: metadata only** — NO credential decryption. Returns `ProviderConfig[]` with `accounts[].apiKey === undefined` |
| `resolveTransportCredential(providerId, accountId, secretType?)` | Single-credential resolution at network boundary | **Opt-in only** — Called by transport layer, decrypts exactly one credential |

### Tables Read
| Table | Columns Used |
|-------|--------------|
| `resource_plane.provider_accounts` | provider_id, account_id, name, auth_type, transport, base_url, owner_node_id, enabled, metadata, revision |
| `resource_plane.model_capabilities` | provider_id, model_id, capabilities, limits |
| `resource_plane.credential_secrets` | **Only when** `decryptCredentials: true` or `resolveTransportCredential()` called |

### Data Flow
```
resource_plane.provider_accounts (enabled=true)
    + resource_plane.model_capabilities
    → ProviderConfig[] (metadata only, zero plaintext credentials)
    
resolveTransportCredential(providerId, accountId) 
    → resource_plane.credential_secrets (single row)
    → decryptTypedCredential() 
    → plain apiKey / accessToken (transient, never cached)
```

---

## 3. Diff Summary

### Files Added (Phase 3.1 Scope)
| File | Lines | Purpose |
|------|-------|---------|
| `src/services/resourcePlane/readAdapter.ts` | 266 | Read-only bridge: PG → CCB ProviderConfig |
| `src/services/resourcePlane/__tests__/readAdapter.test.ts` | 205 | 4 tests: metadata-only, opt-in decrypt, transport boundary, graceful degradation |

### Files Modified (Zero — Contract Preserved)
| File | Change |
|------|--------|
| *(none)* | Phase 0/1 contracts (`types.ts`, `secretKey.ts`, `credentials.ts`, `repository.ts`, `migrations.ts`) remain **100% untouched** |

### Integration Points (Not Yet Connected)
- `loader.ts` — No modification. `loadProviders()` still uses file-based + `pgLoader.ts` (omniroute schema).
- `pgLoader.ts` — Reads `omniroute.*` schema, NOT `resource_plane.*`. Separate contract.
- **Phase 3.2** will wire `loadProvidersFromResourcePlane()` into provider registry behind feature flag.

---

## 4. Regression Result

```bash
cd /home/melody/cloud/source-code/github/ai/claude-code
bun test src/services/resourcePlane
```

```
Test Suites: 6 passed
Tests:       64 passed, 0 failed
Assertions:  290
Duration:    ~1.2s
```

### Test Breakdown
| Suite | Tests | Focus |
|-------|-------|-------|
| `types.test.ts` | 15 | Type guards, validation, UUID v5 determinism |
| `credentials.test.ts` | 14 | encrypt/decrypt roundtrip, AAD binding, cross-type rejection |
| `migrations.test.ts` | 15 | Schema creation, idempotency, version tracking |
| `importer.test.ts` | 11 | JSON import → PG, deduplication, OAuth preservation |
| `pgGate.test.ts` | 6 | Live PG schema verification (127.0.0.1:5432/omniroute) |
| `readAdapter.test.ts` | 4 | **NEW** — Metadata read, opt-in decrypt, transport boundary, error degradation |

### PG Gate Verification (Live Database)
- Schema: `resource_plane` (provider_accounts, model_capabilities, credential_secrets, migrations)
- Tables: ✅ All 4 present with correct columns, PKs, indexes
- Idempotent Import: ✅ Re-run yields 0 duplicate rows
- Envelope: ✅ `rpenc:v1:1:aes-256-gcm:` prefix enforced
- Zero Plaintext Leak: ✅ Default path returns `apiKey: undefined`

---

## 5. Rollback Point

```bash
# Hard reset to Phase 2 closeout (all Phase 3.1 artifacts removed)
git reset --hard be07336da837c24f4bd4878b3555b4ddaab55725

# Or soft: stash Phase 3.1 changes
git stash

# Files to remove on rollback:
# - src/services/resourcePlane/readAdapter.ts
# - src/services/resourcePlane/__tests__/readAdapter.test.ts
# - src/services/resourcePlane/docs/phase3_1_validation.md (this file)
```

### What Rollback Preserves
- Phase 2: Complete (import, encryption, migrations, pgGate)
- `~/.claude/providers.json`: **Untouched** (not migrated, not deleted)
- Production credentials: **Not migrated**
- Default runtime provider: **Not switched** (still file-based + pgLoader)
- CCB_INTERNAL_ROUTER behavior: **Unchanged**

---

## 6. Next Step: Phase 3.2 (Not Started)

**Goal**: Wire `loadProvidersFromResourcePlane()` into `loader.ts` behind feature flag  
**Constraint**: Must NOT become default — operator opts in via `CCB_RESOURCE_PLANE=1`  
**Rollback**: Feature flag off = zero behavior change
