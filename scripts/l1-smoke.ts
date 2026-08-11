/**
 * Live L1 smoke test for the `race` / `auto` pool.
 *
 * Enumerates every L1 candidate that `resolveDirectRoutes('race')` would race,
 * then sends ONE tiny Chat Completions request per unique (provider/model) to
 * confirm it does not 400 on `reasoning_effort`. We force the effort to `max`
 * so the per-provider clamp is exercised at its hardest; if the clamp is wrong
 * a gateway that rejects `max` would 400 here.
 *
 * Requests are minimal (max_tokens small, a one-word prompt) to keep cost low.
 * Run from the repo root: `bun run scripts/l1-smoke.ts`
 */
import { resolveDirectRoutes } from '../src/services/ccbRouter/directRouter.js'
import {
  buildOpenAIRequestBody,
  clampReasoningEffort,
} from '../src/services/api/openai/requestBody.js'
import { getOpenAIClient } from '../src/services/api/openai/client.js'
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions/completions.mjs'

const EFFORT_TO_TEST = 'max' // stress the clamp; real path may send less
const MAX_TOKENS = 8
const PER_ROUTE_TIMEOUT_MS = Number(process.env.L1_SMOKE_TIMEOUT_MS) || 25_000

function uniqueKey(r: { providerId: string; model: string }): string {
  return `${r.providerId}/${r.model}`
}

async function smokeOne(
  providerId: string,
  model: string,
  baseURL: string,
  apiKey: string,
  headers: Record<string, string> | undefined,
  accountId: string | undefined,
): Promise<{
  ok: boolean
  status?: number
  effort: string | undefined
  detail: string
}> {
  const effort = clampReasoningEffort(providerId, EFFORT_TO_TEST)
  const body = buildOpenAIRequestBody({
    model,
    messages: [{ role: 'user', content: 'ping' }],
    tools: [],
    toolChoice: undefined,
    enableThinking: false,
    maxTokens: MAX_TOKENS,
    reasoningEffort: effort,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PER_ROUTE_TIMEOUT_MS)
  try {
    const stream = await getOpenAIClient({
      maxRetries: 0,
      baseURL,
      apiKey,
      defaultHeaders: headers,
      timeoutMs: PER_ROUTE_TIMEOUT_MS,
      providerId,
      accountId,
    }).chat.completions.create(body as ChatCompletionCreateParamsStreaming, {
      signal: controller.signal,
    })
    let firstText = ''
    let events = 0
    for await (const chunk of stream) {
      events++
      const delta = chunk.choices?.[0]?.delta
      if (typeof delta?.content === 'string') firstText += delta.content
      if (events >= 3) break
    }
    return {
      ok: true,
      effort,
      detail: `events=${events} text=${JSON.stringify(firstText.slice(0, 40))}`,
    }
  } catch (err) {
    const e = err as { status?: number; message?: string; name?: string }
    return {
      ok: false,
      status: e.status,
      effort,
      detail: e.message ?? e.name ?? String(err),
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

async function main(): Promise<void> {
  const routes = resolveDirectRoutes('race')
  const l1 = routes.filter(r => r.tier !== 'l2')
  const seen = new Set<string>()
  const unique = l1.filter(r => {
    const k = uniqueKey(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  console.log(
    `\nResolved ${routes.length} routes (${l1.length} L1, ${routes.length - l1.length} L2).`,
  )
  console.log(
    `Smoke-testing ${unique.length} unique L1 (provider/model) with effort=${EFFORT_TO_TEST}.\n`,
  )

  let pass = 0
  let fail = 0
  for (const r of unique) {
    const res = await smokeOne(
      r.providerId,
      r.model,
      r.baseURL,
      r.apiKey,
      r.headers,
      r.accountId,
    )
    const tag = res.ok ? 'PASS' : 'FAIL'
    if (res.ok) pass++
    else fail++
    const status = res.status !== undefined ? ` [${res.status}]` : ''
    console.log(
      `${tag}  ${r.providerId}/${r.model}` +
        (r.accountId ? `#${r.accountId}` : '') +
        `  effort=${res.effort ?? 'none'}${status}  ${res.detail}`,
    )
  }

  console.log(
    `\nL1 smoke result: ${pass} pass, ${fail} fail (of ${unique.length}).`,
  )
  if (fail > 0) {
    console.log(
      'Some L1 routes failed — check the detail column (a 400 mentioning reasoning_effort means the clamp missed).',
    )
    process.exitCode = 1
  }
}

main().catch(err => {
  console.error('smoke harness error:', err)
  process.exitCode = 2
})
