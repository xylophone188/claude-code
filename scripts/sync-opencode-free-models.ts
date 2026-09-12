#!/usr/bin/env bun
/**
 * sync-opencode-free-models — refresh the shared OpenCode free-model cache
 * with liveness-verified entries only.
 *
 * Listing alone is not truth: /models currently advertises models whose
 * upstream is dead (e.g. deepseek-v4-flash-free returns 400 "Model is
 * unavailable"). This script filters the -free list through a minimal chat
 * completion probe per candidate, so the cache matches what the opencode
 * model picker can actually serve:
 *   - HTTP 200        → usable
 *   - HTTP 429        → usable (model alive, momentarily rate-limited)
 *   - 4xx unavailable → dead, dropped
 *
 * Writes ~/.ccb-embed/opencode-free-models.json atomically (0600, model
 * names only). Run manually or from the 8h sync timer:
 *   bun scripts/sync-opencode-free-models.ts
 */
import { loadProviders } from '../src/services/providerRegistry/loader.js'
import {
  selectFreeOpenCodeModels,
  writeOpenCodeModelsCache,
} from '../src/services/routing/autoScoring.js'

const MODELS_URL =
  process.env.OPENCODE_ZEN_BASE_URL ?? 'https://opencode.ai/zen/v1'

const list = await fetch(`${MODELS_URL}/models`, {
  headers: { 'x-opencode-client': 'desktop', Accept: 'application/json' },
})
if (!list.ok) {
  console.error(`models list failed: HTTP ${list.status}`)
  process.exit(1)
}
const candidates = selectFreeOpenCodeModels(await list.json())
console.log(`listed -free candidates: ${candidates.length}`)

const key =
  loadProviders().find(provider => provider.id === 'opencode')?.accounts?.[0]
    ?.apiKey ?? ''

const usable: string[] = []
const dead: string[] = []
const PROBE_ATTEMPTS = 2
const PROBE_RETRY_DELAY_MS = 2500
for (const model of candidates) {
  let alive = false
  let lastStatus = ''
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS && !alive; attempt++) {
    try {
      const response = await fetch(`${MODELS_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-opencode-client': 'desktop',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ok' }],
          max_tokens: 1,
        }),
      })
      // 429 = model exists but is rate-limited right now; still a valid pick.
      lastStatus = `HTTP ${response.status}`
      if (response.ok || response.status === 429) {
        alive = true
      } else {
        await response.text().catch(() => {})
      }
    } catch (error) {
      // Connection-level failures are transient by nature — retry.
      lastStatus = String(error).slice(0, 80)
    }
    console.log(
      `  ${alive ? 'ok  ' : 'miss'} ${model} (attempt ${attempt}: ${lastStatus})`,
    )
    if (!alive && attempt < PROBE_ATTEMPTS)
      await new Promise(resolve => setTimeout(resolve, PROBE_RETRY_DELAY_MS))
  }
  if (alive) usable.push(model)
  else dead.push(model)
  await new Promise(resolve => setTimeout(resolve, 1500))
}

if (usable.length === 0) {
  // Keep the previous cache rather than emptying it: an empty probe pass is
  // more likely a network/key problem than a truly empty free tier.
  console.error('no usable free models — keeping existing cache untouched')
  process.exit(1)
}
writeOpenCodeModelsCache({
  updatedAt: new Date().toISOString(),
  models: usable,
})
console.log(
  `cache updated: ${usable.length} usable, ${dead.length} dropped${
    dead.length ? ` (${dead.join(', ')})` : ''
  }`,
)
