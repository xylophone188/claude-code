/**
 * Phase 5.0: Credential Schema Registry
 *
 * Versioned JSON-Schema definitions for credential structures. Lets the
 * resource plane validate new credentials against a registered shape before
 * storing them, and detect breaking shape changes across rotations.
 */

import { getPgPool } from '../pg/pool.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CredentialSchema {
  schemaId: string
  providerId: string
  authType: string
  secretType: string
  schemaJson: Record<string, unknown>
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface RegisterSchemaOptions {
  providerId: string
  authType: string
  secretType: string
  schemaJson: Record<string, unknown>
  version?: number
}

export interface ValidateOptions {
  providerId: string
  authType: string
  secretType: string
  credentialData: Record<string, unknown>
  version?: number
}

const rowToSchema = (row: Record<string, unknown>): CredentialSchema => ({
  schemaId: String(row.schema_id),
  providerId: String(row.provider_id),
  authType: String(row.auth_type),
  secretType: String(row.secret_type),
  schemaJson: row.schema_json as Record<string, unknown>,
  version: Number(row.version),
  createdAt: new Date(row.created_at as string),
  updatedAt: new Date(row.updated_at as string),
})

// ── Schema Registry ───────────────────────────────────────────────────────────

export class CredentialSchemaRegistry {
  /** Register or update a schema (same key bumps the shape, version stays). */
  static async registerSchema(
    opts: RegisterSchemaOptions,
  ): Promise<CredentialSchema> {
    const { providerId, authType, secretType, schemaJson, version = 1 } = opts
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `INSERT INTO resource_plane.credential_schemas
           (provider_id, auth_type, secret_type, schema_json, version)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider_id, auth_type, secret_type, version) DO UPDATE SET
           schema_json = EXCLUDED.schema_json,
           updated_at = now()
         RETURNING schema_id, provider_id, auth_type, secret_type, schema_json, version, created_at, updated_at`,
        [providerId, authType, secretType, JSON.stringify(schemaJson), version],
      )
      return rowToSchema(res.rows[0])
    } finally {
      client.release()
    }
  }

  /** Fetch an exact schema version; null if not registered. */
  static async getSchema(
    providerId: string,
    authType: string,
    secretType: string,
    version: number = 1,
  ): Promise<CredentialSchema | null> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `SELECT schema_id, provider_id, auth_type, secret_type, schema_json, version, created_at, updated_at
         FROM resource_plane.credential_schemas
         WHERE provider_id = $1 AND auth_type = $2 AND secret_type = $3 AND version = $4`,
        [providerId, authType, secretType, version],
      )
      return res.rows.length ? rowToSchema(res.rows[0]) : null
    } finally {
      client.release()
    }
  }

  /** Fetch the highest registered version. */
  static async getLatestSchema(
    providerId: string,
    authType: string,
    secretType: string,
  ): Promise<CredentialSchema | null> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `SELECT schema_id, provider_id, auth_type, secret_type, schema_json, version, created_at, updated_at
         FROM resource_plane.credential_schemas
         WHERE provider_id = $1 AND auth_type = $2 AND secret_type = $3
         ORDER BY version DESC LIMIT 1`,
        [providerId, authType, secretType],
      )
      return res.rows.length ? rowToSchema(res.rows[0]) : null
    } finally {
      client.release()
    }
  }

  /**
   * Validate credential data against the registered schema.
   * Returns list of violation strings; empty = valid. Unregistered shapes pass
   * (backward compatible) but report via a `registered: false` marker.
   */
  static async validate(
    opts: ValidateOptions,
  ): Promise<{ valid: boolean; violations: string[]; registered: boolean }> {
    const {
      providerId,
      authType,
      secretType,
      credentialData,
      version = 1,
    } = opts
    const schema = await CredentialSchemaRegistry.getSchema(
      providerId,
      authType,
      secretType,
      version,
    )
    if (!schema) return { valid: true, violations: [], registered: false }

    const violations = CredentialSchemaRegistry._validateAgainstSchema(
      schema.schemaJson,
      credentialData,
      '$',
    )
    return { valid: violations.length === 0, violations, registered: true }
  }

  private static _validateAgainstSchema(
    schema: Record<string, unknown>,
    data: unknown,
    path: string,
  ): string[] {
    const violations: string[] = []
    const type = schema.type as string | undefined

    if (
      type === 'object' ||
      (schema.properties && typeof schema.properties === 'object')
    ) {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        violations.push(`${path}: expected object, got ${typeof data}`)
        return violations
      }
      const record = data as Record<string, unknown>
      const props = (schema.properties as Record<string, unknown>) ?? {}
      for (const [key, propSchema] of Object.entries(props)) {
        const value = record[key]
        if (value === undefined) {
          const required = schema.required
          if (Array.isArray(required) && required.includes(key)) {
            violations.push(`${path}.${key}: required field missing`)
          }
          continue
        }
        if (propSchema && typeof propSchema === 'object') {
          violations.push(
            ...CredentialSchemaRegistry._validateAgainstSchema(
              propSchema as Record<string, unknown>,
              value,
              `${path}.${key}`,
            ),
          )
        }
      }
      return violations
    }

    if (type === 'string') {
      if (typeof data !== 'string') {
        violations.push(`${path}: expected string, got ${typeof data}`)
      } else if (typeof schema.pattern === 'string') {
        const re = new RegExp(schema.pattern)
        if (!re.test(data))
          violations.push(`${path}: does not match pattern ${schema.pattern}`)
      }
      return violations
    }

    if (type === 'number' || type === 'integer') {
      if (typeof data !== 'number') {
        violations.push(`${path}: expected ${type}, got ${typeof data}`)
      } else if (type === 'integer' && !Number.isInteger(data)) {
        violations.push(`${path}: expected integer`)
      }
      return violations
    }

    if (type === 'boolean') {
      if (typeof data !== 'boolean')
        violations.push(`${path}: expected boolean, got ${typeof data}`)
      return violations
    }

    return violations
  }

  /** List all registered schemas ordered by key. */
  static async listSchemas(): Promise<CredentialSchema[]> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `SELECT schema_id, provider_id, auth_type, secret_type, schema_json, version, created_at, updated_at
         FROM resource_plane.credential_schemas
         ORDER BY provider_id, auth_type, secret_type, version`,
      )
      return res.rows.map(rowToSchema)
    } finally {
      client.release()
    }
  }

  static async deleteSchema(
    providerId: string,
    authType: string,
    secretType: string,
    version: number,
  ): Promise<boolean> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `DELETE FROM resource_plane.credential_schemas
         WHERE provider_id = $1 AND auth_type = $2 AND secret_type = $3 AND version = $4`,
        [providerId, authType, secretType, version],
      )
      return (res.rowCount ?? 0) > 0
    } finally {
      client.release()
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _schemaRegistry: CredentialSchemaRegistry | null = null

export function getSchemaRegistry(): CredentialSchemaRegistry {
  if (!_schemaRegistry) _schemaRegistry = new CredentialSchemaRegistry()
  return _schemaRegistry
}

export function resetSchemaRegistryForTest(): void {
  _schemaRegistry = null
}
