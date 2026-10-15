/**
 * Fire-and-forget Elasticsearch (IK analyzer) index for Session Memory.
 *
 * This is a minimal, additive integration of the existing ES/IK
 * `SearchEngineClient` into the SessionMemory extraction chain. It does NOT
 * introduce any new service:
 *   - `~/.claude/projects/<session>/session-memory/summary.md` remains the
 *     source of truth (PG / Redis / OpenViking are untouched).
 *   - ES is only used as a best-effort, read-your-own-writes index so the
 *     session summary is text-searchable.
 *
 * Invariants (enforced by every function in this file):
 *   1. NEVER throws — a missing/unreachable ES (connection refused, DNS
 *      failure, timeout, non-2xx, malformed JSON) degrades to a log line.
 *   2. NEVER awaits on the main conversation path — callers invoke
 *      `void indexSessionMemoryFireAndForget(...)` so no caller can block.
 *   3. NEVER prints document content — session memory may contain secrets, so
 *      logs carry only lengths, ids and error summaries.
 */

import { stat } from 'fs/promises'
import { getSessionId } from '../../bootstrap/state.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { errorMessage } from '../../utils/errors.js'
import {
  getSearchEngine,
  searchEnginePing,
  type SearchEngineClient,
} from './client.js'

export const SESSION_MEMORY_INDEX_NAME = 'session_memory'

/**
 * The IK (`ik_max_word` / `ik_max_word_pinyin`) analyzer is not installed in
 * every Elasticsearch distribution, so an IK-mapped index can 400 out on
 * cluster startup. We therefore fall back to the stock analyzer mapping.
 * This is a one-shot per process; failures are logged and never thrown.
 */
let ensureIndexPromise: Promise<boolean> | undefined

export function ensureSessionMemoryIndex(
  client: SearchEngineClient = getSearchEngine(),
): Promise<boolean> {
  ensureIndexPromise ??= (async () => {
    try {
      await client.createIndexWithIK(SESSION_MEMORY_INDEX_NAME)
      return true
    } catch (error) {
      logForDebugging(
        `session memory search: IK index unavailable (${errorMessage(error)}); falling back to default analyzer`,
        { level: 'warn' },
      )
      try {
        await client.createIndex(SESSION_MEMORY_INDEX_NAME)
        return true
      } catch (fallbackError) {
        logForDebugging(
          `session memory search: index creation failed (${errorMessage(fallbackError)})`,
          { level: 'warn' },
        )
        return false
      }
    }
  })()
  return ensureIndexPromise
}

/**
 * @internal TEST-ONLY. Drops the cached index-creation promise so a test can
 * observe fresh index behaviour. Production code never calls this.
 */
export function resetSessionMemoryIndexState(): void {
  ensureIndexPromise = undefined
}

/**
 * Reads the session memory markdown file. Returns null (never throws) when the
 * file is missing, unreadable or empty.
 */
export async function readSessionMemoryText(
  memoryPath?: string,
): Promise<string | null> {
  const fs = getFsImplementation()
  const path = memoryPath ?? getSessionMemoryPath()
  try {
    const content = await fs.readFile(path, { encoding: 'utf-8' })
    return content && content.trim() ? content : null
  } catch {
    return null
  }
}

/**
 * Sizes the markdown in bytes, capping what a single document can add to the
 * cluster. Session memory documents are small in practice; the cap is a
 * defensive guard against a runaway file.
 */
export async function getSessionMemorySizeBytes(
  memoryPath?: string,
): Promise<number> {
  try {
    const { size } = await stat(memoryPath ?? getSessionMemoryPath())
    return size
  } catch {
    return 0
  }
}

/**
 * Liveness probe for a specific client. The module-level
 * `searchEnginePing()` in client.js always probes the shared singleton, so an
 * injected client (custom host, or a test double) must be probed directly —
 * otherwise a caller could index into one cluster while the health check
 * reported on a different one.
 */
export async function pingSearchEngine(
  client: SearchEngineClient = getSearchEngine(),
): Promise<boolean> {
  try {
    return await client.ping()
  } catch {
    return false
  }
}

/**
 * Indexes the current session memory document into Elasticsearch.
 *
 * This is the "safe" entry point: it is safe to call from anywhere in the
 * extraction/write chain because it never rejects, never throws synchronously
 * and never blocks the caller.
 */
export type IndexSessionMemoryResult =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'unreachable' | 'empty' | 'error' }

export async function indexSessionMemory(
  options: {
    docId?: string
    memoryPath?: string
    client?: SearchEngineClient
    maxBytes?: number
  } = {},
): Promise<IndexSessionMemoryResult> {
  const enabled = process.env.CCB_SESSION_MEMORY_SEARCH_ENABLED
  if (enabled !== undefined && enabled !== '1' && enabled !== 'true') {
    return { ok: false, reason: 'disabled' }
  }

  const client = options.client ?? getSearchEngine()
  if (!(await pingSearchEngine(client))) {
    logForDebugging(
      'session memory search: Elasticsearch unreachable, skipping index (session memory file remains the source of truth)',
      { level: 'warn' },
    )
    return { ok: false, reason: 'unreachable' }
  }

  const text = await readSessionMemoryText(options.memoryPath)
  if (!text) {
    return { ok: false, reason: 'empty' }
  }

  const maxBytes = options.maxBytes ?? 1_048_576
  const sizeBytes = await getSessionMemorySizeBytes(options.memoryPath)
  if (sizeBytes > maxBytes) {
    logForDebugging(
      `session memory search: document is ${sizeBytes} bytes, exceeds ${maxBytes} byte cap, skipping`,
      { level: 'warn' },
    )
    return { ok: false, reason: 'empty' }
  }

  try {
    await ensureSessionMemoryIndex(client)
    const docId = options.docId ?? resolveSessionMemoryDocId()
    await client.indexDocument(SESSION_MEMORY_INDEX_NAME, docId, {
      session_id: docId,
      text,
      updated_at: new Date().toISOString(),
    })
    logForDebugging(
      `session memory search: indexed ${text.length} chars as ${SESSION_MEMORY_INDEX_NAME}/${docId}`,
    )
    return { ok: true }
  } catch (error) {
    logForDebugging(
      `session memory search: indexing failed (${errorMessage(error)})`,
      { level: 'warn' },
    )
    return { ok: false, reason: 'error' }
  }
}

/**
 * Fire-and-forget wrapper. Callers must invoke as
 * `void indexSessionMemoryFireAndForget(...)` so no rejection can ever escape
 * into the SessionMemory hook and there is nothing to await.
 */
export function indexSessionMemoryFireAndForget(
  options: Parameters<typeof indexSessionMemory>[0] = {},
): void {
  void indexSessionMemory(options).catch(error => {
    logError(error)
  })
}

/**
 * Hooks the fire-and-forget index into SessionMemory setup without touching
 * the extraction main chain: if the memory file is missing, indexing is a
 * no-op. Used by `initSessionMemory()`.
 */
async function ensureSessionMemorySearchIndexImpl(): Promise<void> {
  try {
    const client = getSearchEngine()
    if (!(await searchEnginePing())) {
      logForDebugging(
        'session memory search: Elasticsearch unreachable at init, SessionMemory search disabled for this run',
        { level: 'warn' },
      )
      return
    }
    await ensureSessionMemoryIndex(client)
  } catch (error) {
    logError(error)
  }
}

/**
 * Never-rejecting variant so `void ensureSessionMemorySearchIndex()` can never
 * produce an unhandled rejection at startup.
 */
export function ensureSessionMemorySearchIndex(): Promise<void> {
  return ensureSessionMemorySearchIndexImpl().catch(error => {
    logError(error)
  })
}

/**
 * Resolves the ES doc id: the current bootstrap session id, falling back to
 * 'session' so the helper stays usable before bootstrap state is initialized.
 */
export function resolveSessionMemoryDocId(): string {
  const sessionId = getSessionId()
  return sessionId && sessionId.length > 0 ? sessionId : 'session'
}
