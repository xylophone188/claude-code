#!/usr/bin/env bun
/**
 * Shadow Diff for Phase 3.2 validation.
 *
 * Compares providers.json (current loader source) vs resourcePlane PG (readAdapter).
 *
 * Outputs four counts:
 *   identityMismatchCount: provider IDs in providers.json missing from resourcePlane
 *   semanticDiffCount: differences in baseUrl, compatRule, models lists for common providers
 *   credentialDiffCount: differences in credential representation (plain vs env) - not a hard failure
 *   securityViolationCount: violations of lazy resolution (plaintext in metadata) or missing encryption
 *
 * Acceptance criteria: identityMismatchCount == 0 && securityViolationCount == 0
 */

import { loadProviders } from '../src/services/providerRegistry/loader.js'
import { loadProvidersFromResourcePlane } from '../src/services/resourcePlane/readAdapter.js'
import { getPgPool } from '../src/services/pg/pool.js'
import type { ProviderConfig } from '../src/services/providerRegistry/types.js'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

async function loadProvidersJson(): Promise<ProviderConfig[]> {
  const filePath = join(homedir(), '.claude', 'providers.json')
  if (!existsSync(filePath)) return []
  const content = readFileSync(filePath, 'utf-8')
  try {
    return JSON.parse(content)
  } catch {
    return []
  }
}

function normalizeId(id: string): string {
  return String(id).trim()
}

function compareModels(
  a: string[] | undefined,
  b: string[] | undefined,
): { onlyInA: string[]; onlyInB: string[] } {
  const setA = new Set(a || [])
  const setB = new Set(b || [])
  return {
    onlyInA: [...setA].filter(x => !setB.has(x)),
    onlyInB: [...setB].filter(x => !setA.has(x)),
  }
}

function compareStringArrays(
  a: string[] | undefined,
  b: string[] | undefined,
): boolean {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false
  }
  return true
}

async function main() {
  console.log('=== Phase 3.2 Shadow Diff (Revised Contract) ===\n')

  // Load both sources
  const [providersA, providersB] = await Promise.all([
    loadProvidersJson(),
    loadProvidersFromResourcePlane({ decryptCredentials: false }), // metadata only
  ])

  console.log(`providers.json count: ${providersA.length}`)
  console.log(`resourcePlane PG count: ${providersB.length}`)

  // Build maps by normalized ID
  const mapA = new Map<string, ProviderConfig>()
  for (const p of providersA) {
    mapA.set(normalizeId(p.id), p)
  }
  const mapB = new Map<string, ProviderConfig>()
  for (const p of providersB) {
    mapB.set(normalizeId(p.id), p)
  }

  // Identity mismatch: IDs in A not in B (we care about missing in resourcePlane)
  const identityMismatch: string[] = []
  for (const [id, p] of mapA) {
    if (!mapB.has(id)) {
      identityMismatch.push(id)
    }
  }
  // Optionally also report IDs in B not in A (extra in resourcePlane) for info
  const extraInB: string[] = []
  for (const [id, p] of mapB) {
    if (!mapA.has(id)) {
      extraInB.push(id)
    }
  }

  // Semantic differences for common providers
  let semanticDiffCount = 0
  const semanticDetails: Array<{ id: string; field: string; a: any; b: any }> =
    []
  const commonIds = [...mapA.keys()].filter(id => mapB.has(id))
  for (const id of commonIds) {
    const a = mapA.get(id)!
    const b = mapB.get(id)!
    // baseUrl
    if (a.baseUrl !== b.baseUrl) {
      semanticDiffCount++
      semanticDetails.push({ id, field: 'baseUrl', a: a.baseUrl, b: b.baseUrl })
    }
    // compatRule
    if (a.compatRule !== b.compatRule) {
      semanticDiffCount++
      semanticDetails.push({
        id,
        field: 'compatRule',
        a: a.compatRule,
        b: b.compatRule,
      })
    }
    // models
    if (!compareStringArrays(a.models, b.models)) {
      semanticDiffCount++
      semanticDetails.push({ id, field: 'models', a: a.models, b: b.models })
    }
    // defaultModel
    if (a.defaultModel !== b.defaultModel) {
      semanticDiffCount++
      semanticDetails.push({
        id,
        field: 'defaultModel',
        a: a.defaultModel,
        b: b.defaultModel,
      })
    }
    // reasoningEffortMax
    if (a.reasoningEffortMax !== b.reasoningEffortMax) {
      semanticDiffCount++
      semanticDetails.push({
        id,
        field: 'reasoningEffortMax',
        a: a.reasoningEffortMax,
        b: b.reasoningEffortMax,
      })
    }
    // headers (simple stringify compare)
    const aHeaders = a.headers ? JSON.stringify(a.headers) : '{}'
    const bHeaders = b.headers ? JSON.stringify(b.headers) : '{}'
    if (aHeaders !== bHeaders) {
      semanticDiffCount++
      semanticDetails.push({ id, field: 'headers', a: a.headers, b: b.headers })
    }
    // accounts count (we'll check credential representation separately)
    // We could compare account IDs and model per account, but for simplicity skip
  }

  // Credential representation differences (not hard failure)
  let credentialDiffCount = 0
  const credentialDetails: Array<{
    id: string
    aHasPlain: boolean
    bHasPlain: boolean
    aEnvs: string[]
    bEnvs: string[]
  }> = []
  for (const id of commonIds) {
    const a = mapA.get(id)!
    const b = mapB.get(id)!
    const aAccounts = a.accounts || []
    const bAccounts = b.accounts || []
    const aHasPlain = aAccounts.some(
      acc =>
        'apiKey' in acc &&
        typeof acc.apiKey === 'string' &&
        acc.apiKey.length > 0,
    )
    const bHasPlain = bAccounts.some(
      acc =>
        'apiKey' in acc &&
        typeof acc.apiKey === 'string' &&
        acc.apiKey.length > 0,
    )
    const aEnvs = aAccounts
      .map(acc => acc.apiKeyEnv)
      .filter((x): x is string => typeof x === 'string')
    const bEnvs = bAccounts
      .map(acc => acc.apiKeyEnv)
      .filter((x): x is string => typeof x === 'string')
    if (
      aHasPlain !== bHasPlain ||
      JSON.stringify(aEnvs.sort()) !== JSON.stringify(bEnvs.sort())
    ) {
      credentialDiffCount++
      credentialDetails.push({ id, aHasPlain, bHasPlain, aEnvs, bEnvs })
    }
  }

  // Security violations: check lazy resolution and encryption
  let securityViolationCount = 0
  const securityDetails: Array<{ id: string; reason: string }> = []

  // 1. Ensure loadProvidersFromResourcePlane({ decryptCredentials: false }) returns no plain apiKey
  for (const p of providersB) {
    if (p.accounts) {
      for (const acc of p.accounts) {
        if (
          'apiKey' in acc &&
          typeof acc.apiKey === 'string' &&
          acc.apiKey.length > 0
        ) {
          securityViolationCount++
          securityDetails.push({
            id: p.id,
            reason: 'plain apiKey in metadata (decryptCredentials=false)',
          })
          break // count once per provider
        }
      }
    }
  }

  // 2. Ensure that credentials in DB are encrypted (rpenc:v1 envelope)
  try {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query({
        text: `SELECT provider_id, account_id, secret_type, encrypted_secret FROM resource_plane.credential_secrets LIMIT 100`,
      })
      for (const row of res.rows) {
        const enc = row.encrypted_secret as string
        // Check for rpenc:v1 prefix
        if (!enc.startsWith('rpenc:v1:1:aes-256-gcm:')) {
          securityViolationCount++
          securityDetails.push({
            id: `${row.provider_id}:${row.account_id}:${row.secret_type}`,
            reason: 'credential not encrypted with rpenc:v1 envelope',
          })
        }
      }
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('Failed to check credential encryption:', err)
    // We'll still count as violation? For safety, assume violation if we cannot verify.
    securityViolationCount++
    securityDetails.push({
      id: 'DB_CHECK_FAILED',
      reason: 'Could not verify credential encryption',
    })
  }

  // Output
  console.log('\n--- COUNTS ---')
  console.log(`identityMismatchCount (A not in B): ${identityMismatch.length}`)
  console.log(`semanticDiffCount: ${semanticDiffCount}`)
  console.log(`credentialDiffCount: ${credentialDiffCount}`)
  console.log(`securityViolationCount: ${securityViolationCount}`)

  console.log('\n--- DETAILS IF ANY ---')
  if (identityMismatch.length > 0) {
    console.log(
      'Identity mismatch (providers.json IDs missing in resourcePlane):',
    )
    for (const id of identityMismatch) console.log(`  - ${id}`)
  }
  if (extraInB.length > 0) {
    console.log('Extra IDs in resourcePlane (not in providers.json):')
    for (const id of extraInB.slice(0, 10)) console.log(`  - ${id}`)
    if (extraInB.length > 10)
      console.log(`  ... and ${extraInB.length - 10} more`)
  }
  if (semanticDiffCount > 0) {
    console.log('Semantic differences (first 5):')
    for (const d of semanticDetails.slice(0, 5)) {
      console.log(
        `  ${d.id}.${d.field}: A="${JSON.stringify(d.a)}"  B="${JSON.stringify(d.b)}"`,
      )
    }
    if (semanticDetails.length > 5)
      console.log(`  ... and ${semanticDetails.length - 5} more`)
  }
  if (credentialDiffCount > 0) {
    console.log('Credential representation differences (first 5):')
    for (const d of credentialDetails.slice(0, 5)) {
      console.log(
        `  ${d.id}: plainKey A=${d.aHasPlain} B=${d.bHasPlain}; envs A=[${d.aEnvs.join(', ')}] B=[${d.bEnvs.join(', ')}]`,
      )
    }
    if (credentialDetails.length > 5)
      console.log(`  ... and ${credentialDetails.length - 5} more`)
  }
  if (securityViolationCount > 0) {
    console.log('Security violations:')
    for (const d of securityDetails) console.log(`  ${d.id}: ${d.reason}`)
  }

  // Acceptance
  const accept = identityMismatch.length === 0 && securityViolationCount === 0
  console.log('\n--- VERDICT ---')
  if (accept) {
    console.log('✅ identityMismatchCount == 0 && securityViolationCount == 0')
    console.log(
      '   Safe to consider Phase 3.2 validation passed (per revised contract).',
    )
    process.exit(0)
  } else {
    console.log('❌ Validation failed')
    if (identityMismatch.length > 0)
      console.log(
        `   identityMismatchCount = ${identityMismatch.length} (must be 0)`,
      )
    if (securityViolationCount > 0)
      console.log(
        `   securityViolationCount = ${securityViolationCount} (must be 0)`,
      )
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Shadow diff failed:', err)
  process.exit(1)
})
