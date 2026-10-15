import { randomUUID } from 'crypto'
import { queryModelWithStreaming } from '../services/api/claude.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'
import { getRemoteCompressionUrl } from '../services/context/runtime.js'
import { remoteCompress } from '../services/context/remote.js'
import type { CompressionDecisionInput } from '../services/context/decision.js'

// -- deps

// I/O dependencies for query(). Passing a `deps` override into QueryParams
// lets tests inject fakes directly instead of spyOn-per-module — the most
// common mocks (callModel, autocompact) are each spied in 6-8 test files
// today with module-import-and-spy boilerplate.
//
// Using `typeof fn` keeps signatures in sync with the real implementations
// automatically. This file imports the real functions for both typing and
// the production factory — tests that import this file for typing are
// already importing query.ts (which imports everything), so there's no
// new module-graph cost.
//
// Scope is intentionally narrow (4 deps) to prove the pattern. Followup
// PRs can add runTools, handleStopHooks, logEvent, queue ops, etc.
export type QueryDeps = {
  // -- model
  callModel: typeof queryModelWithStreaming

  // -- compaction
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded

  // -- platform
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: async (...args: Parameters<typeof microcompactMessages>) => {
      const url = getRemoteCompressionUrl()
      const [messages, ...rest] = args
      if (!url) return microcompactMessages(messages, ...rest)
      let base = messages
      try {
        base = (await remoteCompress(url, messages)) as typeof messages
      } catch {
        // A dead bridge must never break a query — local microcompact gets the
        // original messages and the query continues.
      }
      try {
        return await microcompactMessages(base, ...rest)
      } catch {
        return { messages: base }
      }
    },
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
