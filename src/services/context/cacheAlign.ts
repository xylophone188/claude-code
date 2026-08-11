// cacheAlign.ts — pure helpers that keep the provider prompt-cache prefix
// boundary stable for provider prompt caching.
//
// CCB forwards the original message list to the provider so
// the provider's prefix-cache (prompt-cache) keeps hitting. The cache boundary
// is anchored at the front of the conversation (system block + first user turn),
// so the leading messages must never be reordered or mutated — otherwise every
// request breaks the cached prefix and the hit rate collapses to zero.
//
// These helpers are PURE: they never mutate the input array, and they only ever
// copy/move message references. They contain no provider ids.

export interface ChatMessage {
  role: string
  content: string
}

/**
 * Reorder/normalize messages so the provider prompt-cache prefix boundary stays
 * stable.
 *
 * Guarantees (all safe for cache mode):
 *  - The first `system` message is always at index 0 (the cache prefix anchor).
 *  - The system block content is never changed.
 *  - No different contents are merged — each message keeps its own identity.
 *  - Returns a NEW array; the input is never mutated.
 *
 * Behavior is intentionally simple/safe: the system message is pinned to the
 * front, and the remaining messages keep their original relative order. This
 * avoids any risky role-flipping that could move content across the cache
 * boundary. The key invariant for cache mode is "system stays first and
 * unchanged" — everything else is preserved verbatim.
 */
export function alignCacheBlocks(
  messages: Array<ChatMessage>,
): Array<ChatMessage> {
  if (messages.length === 0) return []

  const result: Array<ChatMessage> = []
  let systemIndex = -1

  // Find the first system message to pin at index 0.
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'system') {
      systemIndex = i
      break
    }
  }

  if (systemIndex !== -1) {
    // Copy (not reference-move mutation of input) the system message to front.
    result.push({
      role: messages[systemIndex].role,
      content: messages[systemIndex].content,
    })
  }

  // Append every other message in original order, copying each.
  for (let i = 0; i < messages.length; i++) {
    if (i === systemIndex) continue
    result.push({ role: messages[i].role, content: messages[i].content })
  }

  return result
}

/**
 * Cheap, stable hash of the leading cache prefix (system block + first user
 * turn). Callers use this to detect when the cache boundary changed and a
 * previously-cached prefix is now invalid.
 *
 * Returns a short hex string. Same prefix -> same hash. Different prefix ->
 * different hash (with very high probability for this cheap digest).
 */
export function stablePrefixHash(messages: Array<ChatMessage>): string {
  const prefixParts: string[] = []

  // Leading system block(s): every consecutive system message from the front.
  let i = 0
  while (i < messages.length && messages[i].role === 'system') {
    prefixParts.push(`system:${messages[i].content}`)
    i++
  }

  // First user turn: the first non-system message OR the first explicit 'user'.
  let firstUser: ChatMessage | undefined
  if (i < messages.length) {
    firstUser = messages[i]
  } else {
    firstUser = messages.find(m => m.role === 'user')
  }
  if (firstUser) {
    prefixParts.push(`user:${firstUser.role}:${firstUser.content}`)
  }

  const serialized = prefixParts.join('\u0000')
  return fnv1a(serialized)
}

/**
 * FNV-1a 32-bit hash -> 8-char hex. Fast, dependency-free, deterministic.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    // hash *= 16777619 (FNV prime) with 32-bit overflow
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
