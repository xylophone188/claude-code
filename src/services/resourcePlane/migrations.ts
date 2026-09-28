import { getPgPool } from '../pg/pool.js'
import type { Pool, PoolClient } from 'pg'
import { ResourcePlaneValidationError } from './types.js'

export const RESOURCE_PLANE_SCHEMA = 'resource_plane'

export interface ResourcePlaneMigration {
  version: number
  name: string
  up: string
  down?: string
}

const V1 = `
CREATE TABLE IF NOT EXISTS resource_plane.migrations (
  version bigint PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resource_plane.provider_accounts (
  provider_id text NOT NULL,
  account_id text NOT NULL,
  name text NULL,
  auth_type text NOT NULL,
  transport text NULL,
  base_url text NULL,
  owner_node_id text NULL,
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL,
  updated_by_node_id text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, account_id)
);

CREATE TABLE IF NOT EXISTS resource_plane.model_capabilities (
  provider_id text NOT NULL,
  model_id text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS resource_plane.provider_health (
  provider_id text NOT NULL,
  account_id text NOT NULL DEFAULT '',
  model_id text NOT NULL DEFAULT '',
  health jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, account_id, model_id)
);

CREATE TABLE IF NOT EXISTS resource_plane.quota_state (
  provider_id text NOT NULL,
  account_id text NULL,
  quota jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, account_id)
);

CREATE TABLE IF NOT EXISTS resource_plane.routing_resources (
  resource_key text NOT NULL,
  resource jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL,
  owner_node_id text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_key)
);

CREATE TABLE IF NOT EXISTS resource_plane.device_resources (
  node_id text NOT NULL,
  device jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id)
);

CREATE TABLE IF NOT EXISTS resource_plane.sync_metadata (
  node_id text NOT NULL,
  last_applied_revision bigint NOT NULL,
  last_synced_at timestamptz NOT NULL,
  fencing_epoch bigint NOT NULL,
  PRIMARY KEY (node_id)
);

CREATE TABLE IF NOT EXISTS resource_plane.credential_secrets (
  provider_id text NOT NULL,
  account_id text NOT NULL,
  secret_type text NOT NULL,
  auth_type text NOT NULL,
  secret_id uuid NOT NULL,
  key_version integer NOT NULL,
  encrypted_secret text NOT NULL,
  expires_at timestamptz NULL,
  refreshable boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL,
  owner_node_id text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, account_id, secret_type, secret_id)
);

CREATE TABLE IF NOT EXISTS resource_plane.outbox_events (
  event_id uuid PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL,
  source_node_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz NULL,
  delivery_attempts integer NOT NULL DEFAULT 0,
  last_error text NULL
);

CREATE TABLE IF NOT EXISTS resource_plane.inbox_events (
  event_id uuid PRIMARY KEY,
  source_node_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz NULL,
  apply_error text NULL
);

CREATE TABLE IF NOT EXISTS resource_plane.lease_state (
  resource_name text NOT NULL,
  owner_node_id text NOT NULL,
  fencing_epoch bigint NOT NULL,
  lease_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_name)
);

CREATE TABLE IF NOT EXISTS resource_plane.audit_events (
  id uuid PRIMARY KEY,
  actor_node_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rp_provider_accounts_auth
  ON resource_plane.provider_accounts (auth_type, enabled);
CREATE INDEX IF NOT EXISTS idx_rp_provider_accounts_revision
  ON resource_plane.provider_accounts (revision DESC);
CREATE INDEX IF NOT EXISTS idx_rp_credential_secrets_refreshable
  ON resource_plane.credential_secrets (refreshable, updated_at);
CREATE INDEX IF NOT EXISTS idx_rp_credential_secrets_owner
  ON resource_plane.credential_secrets (owner_node_id);
CREATE INDEX IF NOT EXISTS idx_rp_outbox_pending
  ON resource_plane.outbox_events (created_at) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rp_inbox_unapplied
  ON resource_plane.inbox_events (received_at) WHERE applied_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rp_lease_expiry
  ON resource_plane.lease_state (lease_until);
CREATE INDEX IF NOT EXISTS idx_rp_audit_created
  ON resource_plane.audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rp_sync_revision
  ON resource_plane.sync_metadata (last_applied_revision DESC);
`

const V2_UP = `
-- The runner writes expiry metadata and must never lose an existing expiry when
-- a refresh omits it (see repository.ts COALESCE). Defend in depth at the DB
-- level too: NULL expiry means "does not expire" and is allowed, but every
-- non-null expiry must be in the future. NOT VALID so this cannot fail on an
-- existing historical row; runtime checks reject serving expired credentials.
ALTER TABLE resource_plane.credential_secrets
  ADD CONSTRAINT rp_credential_secrets_expiry_valid CHECK (
    expires_at IS NULL OR expires_at > now()
  ) NOT VALID;

-- Expired credentials must never be returned to a caller that asked for live
-- ones. Default ordering (NULLS LAST) means an expired row can outrank an
-- unexpired one, so sort the other way for the primary lookup.
DROP INDEX IF EXISTS resource_plane.idx_rp_credential_secrets_expiry;
CREATE INDEX idx_rp_credential_secrets_expiry
  ON resource_plane.credential_secrets (expires_at NULLS FIRST)
  WHERE expires_at IS NOT NULL;
`

const V2_DOWN = `
DROP INDEX IF EXISTS resource_plane.idx_rp_credential_secrets_expiry;
CREATE INDEX idx_rp_credential_secrets_expiry
  ON resource_plane.credential_secrets (expires_at)
  WHERE expires_at IS NOT NULL;
ALTER TABLE resource_plane.credential_secrets
  DROP CONSTRAINT IF EXISTS rp_credential_secrets_expiry_valid;
`

const V3_UP = `
-- Phase 3.5: Cross-service sync tables
CREATE TABLE IF NOT EXISTS resource_plane.sync_nodes (
  node_id text NOT NULL,
  last_revision bigint NOT NULL,
  last_synced_at timestamptz NOT NULL,
  fencing_epoch bigint NOT NULL,
  status text NOT NULL DEFAULT 'healthy',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id)
);

-- Phase 3.5: Credential audit trail
CREATE TABLE IF NOT EXISTS resource_plane.credential_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL,
  account_id text NOT NULL,
  secret_type text NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'rotate', 'expire', 'delete')),
  key_version integer NOT NULL,
  performed_by text NOT NULL,
  performed_at timestamptz NOT NULL DEFAULT now(),
  reason text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Phase 3.5: Metrics collection
CREATE TABLE IF NOT EXISTS resource_plane.metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp timestamptz NOT NULL DEFAULT now(),
  total_providers integer NOT NULL DEFAULT 0,
  total_accounts integer NOT NULL DEFAULT 0,
  total_credentials integer NOT NULL DEFAULT 0,
  total_capabilities integer NOT NULL DEFAULT 0,
  sync_latency_ms integer NOT NULL DEFAULT 0,
  last_sync_revision bigint NOT NULL DEFAULT 0,
  credential_expiring_soon integer NOT NULL DEFAULT 0,
  credential_expired integer NOT NULL DEFAULT 0,
  node_count integer NOT NULL DEFAULT 0,
  sync_errors integer NOT NULL DEFAULT 0
);

-- Indexes for Phase 3.5 tables
CREATE INDEX IF NOT EXISTS idx_rp_sync_nodes_status
  ON resource_plane.sync_nodes (status);
CREATE INDEX IF NOT EXISTS idx_rp_credential_audit_provider
  ON resource_plane.credential_audit (provider_id, account_id, secret_type);
CREATE INDEX IF NOT EXISTS idx_rp_credential_audit_action
  ON resource_plane.credential_audit (action);
CREATE INDEX IF NOT EXISTS idx_rp_credential_audit_performed_at
  ON resource_plane.credential_audit (performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_rp_metrics_timestamp
  ON resource_plane.metrics (timestamp DESC);
`

const V3_DOWN = `
DROP TABLE IF EXISTS resource_plane.credential_audit;
DROP TABLE IF EXISTS resource_plane.metrics;
DROP TABLE IF EXISTS resource_plane.sync_nodes;
`

const V4_UP = `
-- Phase 4.0: Multi-region replication
-- Add region and global fencing epoch to sync_nodes for cross-region coordination.
ALTER TABLE resource_plane.sync_nodes
  ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS global_fencing_epoch bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_rp_sync_nodes_region
  ON resource_plane.sync_nodes (region, status);
`

const V4_DOWN = `
DROP INDEX IF EXISTS resource_plane.idx_rp_sync_nodes_region;
ALTER TABLE resource_plane.sync_nodes DROP COLUMN IF EXISTS region;
ALTER TABLE resource_plane.sync_nodes DROP COLUMN IF EXISTS global_fencing_epoch;
`

export const RESOURCE_PLANE_MIGRATIONS: ResourcePlaneMigration[] = [
  {
    version: 1,
    name: 'resource_plane_v1_schema',
    up: V1,
  },
  {
    version: 2,
    name: 'credential_secrets_expiry_guard',
    up: V2_UP,
    down: V2_DOWN,
  },
  {
    version: 3,
    name: 'phase3_5_extensions',
    up: V3_UP,
    down: V3_DOWN,
  },
  {
    version: 4,
    name: 'phase4_0_multi_region',
    up: V4_UP,
    down: V4_DOWN,
  },
]

export interface MigrationResult {
  applied: number[]
  skipped: number[]
}

interface MigrationRow {
  version: number | string
}

async function appliedVersions(client: PoolClient): Promise<Set<number>> {
  const { rows } = await client.query<MigrationRow>(
    'SELECT version FROM resource_plane.migrations ORDER BY version',
  )
  return new Set(rows.map((row: MigrationRow) => Number(row.version)))
}

async function withClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

/**
 * Apply Resource Plane migrations in order inside one transaction.
 * Idempotent: already-applied versions are skipped, not re-run.
 */
export async function runResourcePlaneMigrations(
  pool: Pool = getPgPool(),
): Promise<MigrationResult> {
  const applied: number[] = []
  const skipped: number[] = []

  await withClient(pool, async client => {
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS resource_plane`)
      await client.query(`CREATE TABLE IF NOT EXISTS resource_plane.migrations (
        version bigint PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`)

      const done = await appliedVersions(client)
      await client.query('BEGIN')
      for (const migration of RESOURCE_PLANE_MIGRATIONS) {
        if (done.has(migration.version)) {
          skipped.push(migration.version)
          continue
        }
        await client.query(migration.up)
        await client.query(
          'INSERT INTO resource_plane.migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name],
        )
        applied.push(migration.version)
      }
      await client.query('COMMIT')
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // connection already broken; original error wins
      }
      throw err
    }
  })

  return { applied, skipped }
}

export async function listAppliedMigrations(
  pool: Pool = getPgPool(),
): Promise<Array<{ version: number; name: string }>> {
  try {
    const { rows } = await pool.query<{ version: number; name: string }>(
      `SELECT version, name FROM resource_plane.migrations ORDER BY version`,
    )
    return rows
  } catch (err) {
    if (err instanceof ResourcePlaneValidationError) throw err
    if (
      err instanceof Error &&
      /does not exist|relation .* does not exist/i.test(err.message)
    ) {
      return []
    }
    throw err
  }
}

/**
 * Explicit rollback of the highest applied migration. Never used by the runner;
 * dropping the whole resource_plane schema stays a separate operator action.
 */
export async function rollbackLatestResourcePlaneMigration(
  pool: Pool = getPgPool(),
): Promise<number | null> {
  return withClient(pool, async client => {
    await client.query('BEGIN')
    try {
      const { rows } = await client.query<{ version: number }>(
        'SELECT version FROM resource_plane.migrations ORDER BY version DESC LIMIT 1',
      )
      const version = rows[0] ? Number(rows[0].version) : null
      if (version === null) return null
      await rollbackVersion(client, version)
      await client.query('COMMIT')
      return version
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // connection already broken
      }
      throw err
    }
  })
}

async function rollbackVersion(
  client: PoolClient,
  version: number,
): Promise<void> {
  const migration = RESOURCE_PLANE_MIGRATIONS.find(m => m.version === version)
  if (!migration?.down) {
    throw new ResourcePlaneValidationError(
      `no safe rollback defined for migration ${version}`,
    )
  }
  await client.query(migration.down)
  await client.query(
    'DELETE FROM resource_plane.migrations WHERE version = $1',
    [version],
  )
}
