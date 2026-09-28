# Resource Plane Phase 2 Closeout Evidence Snapshot

- **Phase**: Phase 2 (`providers.json` -> PG Resource Plane Import & Gate)
- **Status**: CLOSED
- **Verdict**: PASS
- **Commit SHA**: `be07336da837c24f4bd4878b3555b4ddaab55725`
- **Branch**: `snapshot/dirty-tree-prefix-20260924`
- **Timestamp**: `2026-09-28T00:00:00.000Z`

---

## 1. Migration Evidence

- **Migration Version**: `1`
- **Migration Name**: `001_resource_plane_init`
- **Target Schema**: `resource_plane`
- **Execution Function**: `runResourcePlaneMigrations(pool)`
- **Behavior**:
  - Initial run: Applied 1, skipped 0.
  - Re-run: Applied 0, skipped 1 (idempotent, schema hash unchanged).

---

## 2. Database Object List

### Schema
`CREATE SCHEMA IF NOT EXISTS resource_plane;`

### Tables (11)
1. `resource_plane.migrations`
2. `resource_plane.provider_accounts`
3. `resource_plane.model_capabilities`
4. `resource_plane.provider_health`
5. `resource_plane.quota_state`
6. `resource_plane.routing_resources`
7. `resource_plane.device_resources`
8. `resource_plane.credential_secrets`
9. `resource_plane.outbox_events`
10. `resource_plane.inbox_events`
11. `resource_plane.lease_state`

### Primary Key Constraints
- `resource_plane.provider_accounts`: `PRIMARY KEY (provider_id, account_id)`
- `resource_plane.credential_secrets`: `PRIMARY KEY (provider_id, account_id, secret_type, secret_id)`
- `resource_plane.model_capabilities`: `PRIMARY KEY (provider_id, model_id)`
- `resource_plane.migrations`: `PRIMARY KEY (version)`

### Indexes Verified
- `idx_rp_provider_accounts_auth`
- `idx_rp_provider_accounts_revision`
- `idx_rp_credential_secrets_refreshable`
- `idx_rp_credential_secrets_owner`
- `idx_rp_credential_secrets_expiry`

---

## 3. Fixture Import & Idempotency Evidence

### Fixture Scope
Multi-provider fixture containing:
- Single-account API Key (`gitee`)
- Multi-account cascading API Keys (`nvidia`, accounts `nv-1` and `nv-2`)
- Multi-token OAuth bundle (`codex`, `accessToken` + `refreshToken` + `idToken`)

### Row Counts Before / After
| Table | Initial | After Import #1 | After Import #2 (Re-run) | Net Delta on Re-run |
|---|---|---|---|---|
| `provider_accounts` | 0 | 4 | 4 | 0 |
| `credential_secrets` | 0 | 5 | 5 | 0 |
| `model_capabilities` | 0 | 2 | 2 | 0 |

### SecretId Stability & OAuth Preservation
- `secretId` generated via `deterministicSecretId(namespace, providerId, accountId, secretType)` using SHA-256 (RFC 4122 v5).
- Zero calls to `randomUUID()`.
- OAuth secrets retained as `authType: 'oauth'`, `secretType: 'accessToken'` / `secretType: 'refreshToken'`.
- Strict validation rejects converting OAuth tokens to `apiKey`.

---

## 4. Encryption Boundary & Zero Plaintext Leak Evidence

- Encryption envelope format verified in PostgreSQL rows:
  `rpenc:v1:1:aes-256-gcm:[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}`
- Plaintext leak detection:
  `assertNoPlaintextLeak()` scanned all `accounts.metadata`, `model_capabilities`, and unencrypted query parameters. 0 plaintext matches.
- Decryption verification:
  `decryptTypedCredential()` recovers 100% exact plaintext across all credentials using `CCB_RESOURCE_PLANE_KEY`.

---

## 5. Test Command & Regression Results

**Command**:
```bash
cd /home/melody/cloud/source-code/github/ai/claude-code && bun test src/services/resourcePlane
```

**Results**:
- Total suites: 4 test files
- Tests passed: 55
- Tests failed: 0
- Assertions: 197 expect() calls

---

## 6. Phase 3 Gate Status

- **Phase 2 Status**: CLOSED (All 8 constraints & acceptance gates verified).
- **Phase 3 Status**: READY (NOT STARTED).
- **Boundary**: CCB runtime remains untouched; production credentials remain in place; zero premature runtime migration.
