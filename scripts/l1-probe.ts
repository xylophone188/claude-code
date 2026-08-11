/**
 * L1 reasoning_effort capability probe.
 *
 * For every unique L1 provider in the `race` / `auto` pool, discover the
 * highest `reasoning_effort` value the gateway actually accepts by trying
 * `max` -> `xhigh` -> `high` (the first one that does NOT 400 wins). Flaky
 * responses (429 / 401 / 502 / 503 / timeout / network) are retried; only a
 * genuine reasoning_effort 400 means "try the next lower value".
 *
 * Results are persisted to ~/.ccb-embed/reasoningCaps.json, which
 * providerReasoningEffortCap() reads at request time — so discovered caps are
 * applied automatically on the next ccb run, no manual providers.json edits.
 *
 * Re-runnable and idempotent: existing caps are preserved and only missing /
 * inconclusive providers are (re)probed. Run in the background if you like:
 *   bun run scripts/l1-probe.ts
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDirectRoutes } from '../src/services/ccbRouter/directRouter.js'
import {
  buildOpenAIRequestBody,
  REASONING_CAPS_PATH,
  readReasoningCaps,
} from '../src/services/api/openai/requestBody.js'
import { getProvidersFilePath } from '../src/services/providerRegistry/loader.js'
import { getOpenAIClient } from '../src/services/api/openai/client.js'
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions/completions.mjs'

const MAX_TOKENS = 8
const PER_ROUTE_TIMEOUT_MS = Number(process.env.L1_PROBE_TIMEOUT_MS) || 30_000
const MAX_ROUNDS = Number(process.env.L1_PROBE_ROUNDS) || 6
const RETRIES_PER_VALUE = 3
const EFFORT_LADDER = ['max', 'xhigh', 'high'] as const
type Cap = 'max' | 'xhigh' | 'high'

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

function loadCaps(): Record<string, string> {
  try {
    if (existsSync(REASONING_CAPS_PATH)) {
      const parsed = JSON.parse(readFileSync(REASONING_CAPS_PATH, 'utf8'))
      if (parsed && typeof parsed === 'object')
        return parsed as Record<string, string>
    }
  } catch {
    /* ignore */
  }
  return {}
}

function saveCaps(caps: Record<string, string>): void {
  const dir = join(homedir(), '.ccb-embed')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(
    REASONING_CAPS_PATH,
    `${JSON.stringify(caps, null, 2)}\n`,
    'utf8',
  )
}

type ProbeOutcome =
  | { kind: 'cap'; value: Cap }
  | { kind: 'rejected' } // even 'high' 400'd -> provider likely ignores reasoning_effort
  | { kind: 'inconclusive' }

async function tryEffort(
  route: {
    baseURL: string
    apiKey: string
    headers?: Record<string, string>
    accountId?: string
  },
  model: string,
  providerId: string,
  effort: string,
): Promise<ProbeOutcome> {
  const body = buildOpenAIRequestBody({
    model,
    messages: [{ role: 'user', content: 'ping' }],
    tools: [],
    toolChoice: undefined,
    enableThinking: false,
    maxTokens: MAX_TOKENS,
    reasoningEffort: effort,
  })
  for (let attempt = 1; attempt <= RETRIES_PER_VALUE; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PER_ROUTE_TIMEOUT_MS)
    try {
      const stream = await getOpenAIClient({
        maxRetries: 0,
        baseURL: route.baseURL,
        apiKey: route.apiKey,
        defaultHeaders: route.headers,
        timeoutMs: PER_ROUTE_TIMEOUT_MS,
        providerId,
        accountId: route.accountId,
      }).chat.completions.create(body as ChatCompletionCreateParamsStreaming, {
        signal: controller.signal,
      })
      let events = 0
      for await (const _chunk of stream) {
        if (++events >= 2) break
      }
      return { kind: 'cap', value: effort as Cap }
    } catch (err) {
      const e = err as { status?: number; message?: string; name?: string }
      // A reasoning_effort 400 means this value is rejected -> try lower.
      if (e.status === 400) return { kind: 'rejected' }
      // Anything else (429/401/502/503/timeout/network) is inconclusive -> retry.
      if (attempt < RETRIES_PER_VALUE) {
        await sleep(800 * attempt)
        continue
      }
      return { kind: 'inconclusive' }
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
  return { kind: 'inconclusive' }
}

async function probeProvider(
  providerId: string,
  route: {
    baseURL: string
    apiKey: string
    model: string
    headers?: Record<string, string>
    accountId?: string
  },
): Promise<ProbeOutcome> {
  for (const effort of EFFORT_LADDER) {
    const r = await tryEffort(route, route.model, providerId, effort)
    if (r.kind === 'cap') return r
    if (r.kind === 'rejected') continue // try next lower value
    return r // inconclusive -> stop, let outer loop retry later
  }
  return { kind: 'rejected' }
}

/**
 * Mirror discovered caps into ~/.claude/providers.json as `reasoningEffortMax`
 * so the capability is solidified in provider config and the request path no
 * longer depends solely on the on-disk probe cache (reasoningCaps.json).
 *
 * Only patches entries that ALREADY exist in the file — we never append a
 * partial entry, because doing so would clobber a builtin provider's real
 * config (base URL, keys, headers) and break it. Builtins that are absent from
 * the file keep their hardcoded / default caps.
 */
function solidifyCaps(caps: Record<string, string>): string[] {
  const path = getProvidersFilePath()
  let list: Array<Record<string, unknown>> = []
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(parsed)) list = parsed as Array<Record<string, unknown>>
    } catch {
      // Corrupt file: bail rather than overwrite with a partial list.
      return []
    }
  }
  const byId = new Map(list.map((p, i) => [String(p.id ?? ''), i]))
  const updated: string[] = []
  for (const [id, cap] of Object.entries(caps)) {
    const idx = byId.get(id)
    if (idx === undefined) continue // don't add partial entries (clobbers builtins)
    const entry = list[idx] as Record<string, unknown>
    if (entry.reasoningEffortMax !== cap) {
      entry.reasoningEffortMax = cap
      updated.push(id)
    }
  }
  if (updated.length === 0) return updated
  const tmp = join(tmpdir(), `.providers-${Date.now()}.tmp`)
  writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8')
  renameSync(tmp, path)
  return updated
}

async function main(): Promise<void> {
  const routes = resolveDirectRoutes('race')
  const l1 = routes.filter(r => r.tier !== 'l2')
  // One representative route per provider (the accepted set is a gateway prop).
  const byProvider = new Map<string, (typeof l1)[number]>()
  for (const r of l1)
    if (!byProvider.has(r.providerId)) byProvider.set(r.providerId, r)

  console.log(
    `Probing ${byProvider.size} unique L1 providers for reasoning_effort caps...\n`,
  )
  let caps = loadCaps()

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const pending = [...byProvider.keys()].filter(p => !(p in caps))
    if (pending.length === 0) break
    console.log(
      `Round ${round}: ${pending.length} provider(s) still unresolved.`,
    )
    for (const providerId of pending) {
      const route = byProvider.get(providerId)!
      const outcome = await probeProvider(providerId, {
        baseURL: route.baseURL,
        apiKey: route.apiKey,
        model: route.model,
        headers: route.headers,
        accountId: route.accountId,
      })
      if (outcome.kind === 'cap') {
        caps[providerId] = outcome.value
        saveCaps(caps)
        console.log(`  ${providerId.padEnd(28)} -> ${outcome.value}  (saved)`)
      } else if (outcome.kind === 'rejected') {
        // Even 'high' was rejected: provider ignores reasoning_effort entirely.
        caps[providerId] = 'high' // default; real request will strip via 400-fallback
        saveCaps(caps)
        console.log(
          `  ${providerId.padEnd(28)} -> no reasoning_effort support (clamped to high; 400-strip handles it)`,
        )
      } else {
        console.log(
          `  ${providerId.padEnd(28)} -> inconclusive this round, will retry`,
        )
      }
      await sleep(400) // be gentle between providers to avoid 429 storms
    }
    await sleep(2000) // let rate limits cool between rounds
  }

  const resolved = Object.keys(caps).length
  const solidified = solidifyCaps(caps)
  console.log(
    `\nDone. ${resolved}/${byProvider.size} providers have a cap in ${REASONING_CAPS_PATH}`,
  )
  if (solidified.length > 0) {
    console.log(
      `Solidified reasoningEffortMax into ${getProvidersFilePath()} for: ${solidified.join(', ')}`,
    )
  } else {
    console.log(`providers.json already in sync (no changes written).`)
  }
  console.log(
    'Next ccb run applies these via providerReasoningEffortCap() (config takes precedence).',
  )
  if (resolved < byProvider.size) process.exitCode = 1
}

main().catch(err => {
  console.error('probe harness error:', err)
  process.exitCode = 2
})
