#!/usr/bin/env bun
/**
 * Mirror Job: providers.json + built-in sources -> resourcePlane PG
 * 
 * Idempotent: re-runnable, uses deterministic secretId, upsert semantics
 * Read-only on sources: never modifies providers.json or other sources
 * Credentials: encrypted via rpenc:v1, lazy resolution preserved
 */

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getPgPool } from '../src/services/pg/pool.js'
import {
  transformProvidersJson,
  importResourcePlaneBundle,
} from '../src/services/resourcePlane/importer.js'
import {
  loadProviders,
  DEFAULT_PROVIDERS,
  EMBEDDED_ROUTING_PROVIDERS,
  loadCcbEmbedProviders,
  loadHermesProviders,
  loadCodexOAuthProviders,
} from '../src/services/providerRegistry/loader.js'

async function getAllProviders(): Promise<Array<{ id: string; config: any; source: string }>> {
  const all: Array<{ id: string; config: any; source: string }> = []

  // 1. DEFAULT_PROVIDERS (4 core)
  for (const p of DEFAULT_PROVIDERS) {
    all.push({ id: p.id, config: p, source: 'DEFAULT_PROVIDERS' })
  }

  // 2. EMBEDDED_ROUTING_PROVIDERS (ccb/* namespaced)
  for (const p of EMBEDDED_ROUTING_PROVIDERS) {
    all.push({ id: p.id, config: p, source: 'EMBEDDED_ROUTING_PROVIDERS' })
  }

  // 3. CCB_EMBED_PROVIDERS
  const ccbEmbed = loadCcbEmbedProviders()
  for (const p of ccbEmbed) {
    all.push({ id: p.id, config: p, source: 'CCB_EMBED_PROVIDERS' })
  }

  // 4. HERMES_PROVIDERS
  const hermes = loadHermesProviders()
  for (const p of hermes) {
    all.push({ id: p.id, config: p, source: 'HERMES_PROVIDERS' })
  }

  // 5. CODEX_PROVIDERS
  const codex = loadCodexOAuthProviders()
  for (const p of codex) {
    all.push({ id: p.id, config: p, source: 'CODEX_PROVIDERS' })
  }

  // 6. USER_PROVIDERS from providers.json (final merged result)
  const userProviders = loadProviders()
  for (const p of userProviders) {
    all.push({ id: p.id, config: p, source: 'USER_PROVIDERS' })
  }

  return all
}

function providersToJsonEntry(providers: Array<{ id: string; config: any; source: string }>) {
  // Convert to the format expected by transformProvidersJson
  return providers.map(({ config }) => {
    // Convert ProviderConfig to ProviderJsonEntry
    const accounts = config.accounts?.map((acc: any) => ({
      id: acc.id,
      name: acc.id,
      apiKey: acc.apiKey,
      apiKeyEnv: acc.apiKeyEnv,
      model: acc.model,
      tokens: acc.accessToken ? {
        access_token: acc.accessToken,
        refresh_token: acc.refreshToken,
        id_token: acc.idToken,
      } : undefined,
    })) || []

    return {
      id: config.id,
      kind: config.kind,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      apiKeyEnv: config.apiKeyEnv,
      defaultModel: config.defaultModel,
      models: config.models,
      reasoningEffortMax: config.reasoningEffortMax,
      compatRule: config.compatRule,
      headers: config.headers,
      accounts,
    }
  })
}

async function main() {
  console.log('=== Mirror Job: All Sources -> resourcePlane PG ===\n')

  // Get all providers from all sources
  const allProviders = await getAllProviders()
  console.log(`Total providers from all sources: ${allProviders.length}`)

  // Deduplicate by id (prefer USER_PROVIDERS source, then CCB_EMBED, etc.)
  const priority = { 'USER_PROVIDERS': 0, 'CCB_EMBED_PROVIDERS': 1, 'CODEX_PROVIDERS': 2, 'HERMES_PROVIDERS': 3, 'EMBEDDED_ROUTING_PROVIDERS': 4, 'DEFAULT_PROVIDERS': 5 }
  const byId = new Map<string, { config: any; source: string }>()
  
  for (const p of allProviders.sort((a, b) => (priority[a.source] || 99) - (priority[b.source] || 99))) {
    if (!byId.has(p.id)) {
      byId.set(p.id, { config: p.config, source: p.source })
    }
  }

  console.log(`Unique providers after dedup: ${byId.size}`)
  for (const [id, { source }] of byId) {
    console.log(`  ${id} (from ${source})`)
  }

  // Convert to transformProvidersJson format
  const jsonEntries = providersToJsonEntry(Array.from(byId.entries()).map(([id, { config, source }]) => ({ id, config, source })))
  
  console.log('\n--- Transforming ---')
  const bundle = transformProvidersJson(jsonEntries, { ownerNodeId: 'node-pc' })
  console.log(`Accounts: ${bundle.accounts.length}`)
  console.log(`Credentials: ${bundle.credentials.length}`)
  console.log(`Capabilities: ${bundle.capabilities.length}`)
  console.log(`Provider IDs: ${bundle.accounts.map(a => a.providerId).join(', ')}`)

  // Import into resourcePlane
  console.log('\n--- Importing to resourcePlane PG ---')
  const pool = getPgPool()
  const client = await pool.connect()
  
  try {
    await client.query('BEGIN')
    const result = await importResourcePlaneBundle(client, bundle)
    await client.query('COMMIT')
    
    console.log('\n✅ Import successful!')
    console.log(`Accounts: ${result.accountsCount}`)
    console.log(`Credentials: ${result.credentialsCount}`)
    console.log(`Capabilities: ${result.capabilitiesCount}`)
    console.log(`Providers: ${result.providerIds.length}`)
    console.log(`Secret IDs: ${result.secretIds.length}`)
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('❌ Import failed:', err)
    throw err
  } finally {
    client.release()
  }
}

main().catch(err => {
  console.error('Mirror job failed:', err)
  process.exit(1)
})
