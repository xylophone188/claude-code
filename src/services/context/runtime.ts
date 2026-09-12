import { getGlobalConfig } from '../../utils/config.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'

const DEFAULT_BUDGET_TOKENS = 24_000
const MAX_REMOTE_RESPONSE_BYTES = 4 * 1024 * 1024
<<<<<<< Updated upstream

type ContextMessage = {
  type: 'user' | 'assistant'
  message: { content: unknown }
}

const REMOTE_COMPRESSION_TIMEOUT_MS = 15_000
const MAX_REMOTE_COMPRESSION_RESPONSE_BYTES = 4 * 1024 * 1024
=======
>>>>>>> Stashed changes

export function isTermuxRuntime(): boolean {
  return (
    process.platform === 'android' ||
    Boolean(process.env.PREFIX?.includes('/com.termux'))
  )
}

<<<<<<< Updated upstream
<<<<<<< Updated upstream
function configValue(name: string): unknown {
  try {
    const config = getGlobalConfig() as Record<string, unknown>
    return config[name]
  } catch {
    return undefined
  }
}

function envOrConfig(name: string, envName: string): unknown {
  return process.env[envName] ?? configValue(name)
}

export function getRemoteCompressionUrl(): string | undefined {
  const value = envOrConfig(
    'contextCompressionRemoteUrl',
    'CCB_CONTEXT_COMPRESSION_REMOTE_URL',
  )
=======
function getRuntimeConfig(): Record<string, unknown> {
  try {
    return getGlobalConfig() as Record<string, unknown>
  } catch {
    return {}
  }
}

export function getRemoteCompressionUrl(): string | undefined {
  const envValue = process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL
  const value = envValue ?? getRuntimeConfig().contextCompressionRemoteUrl
>>>>>>> Stashed changes
=======
function getRuntimeConfig(): Record<string, unknown> {
  try {
    return getGlobalConfig() as Record<string, unknown>
  } catch {
    return {}
  }
}

export function getRemoteCompressionUrl(): string | undefined {
  const envValue = process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL
  const value = envValue ?? getRuntimeConfig().contextCompressionRemoteUrl
>>>>>>> Stashed changes
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

export function isContextCompressionEnabled(): boolean {
<<<<<<< Updated upstream
<<<<<<< Updated upstream
  const value = envOrConfig(
    'contextCompressionEnabled',
    'CCB_CONTEXT_COMPRESSION_ENABLED',
  )
  return (
    value === undefined ||
    !['0', 'false', 'off'].includes(String(value).toLowerCase())
  )
}

export function getContextCompressionBudgetTokens(): number {
  const value = envOrConfig(
    'contextCompressionBudgetTokens',
    'CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS',
  )
  if (value === undefined || value === '') return 24000
  const budget = Number(value)
  return Number.isFinite(budget) && budget >= 0 ? Math.floor(budget) : 0
}

export function isContextCompressionSkippedWhenOmniRoute(): boolean {
  const value = envOrConfig(
    'contextCompressionSkipWhenOmniRoute',
    'CCB_CONTEXT_COMPRESSION_SKIP_WHEN_OMNIROUTE',
  )
  return (
    value === undefined ||
    !['0', 'false', 'off'].includes(String(value).toLowerCase())
  )
}

function isOmniRouteProvider(provider: string): boolean {
  return /omniroute/i.test(provider)
}

function estimateTokens(message: ContextMessage): number {
  return Math.ceil(JSON.stringify(message).length / 4)
}

function toolUseIds(message: ContextMessage): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(message.message.content)) return ids
  for (const item of message.message.content) {
    if (typeof item !== 'object' || item === null) continue
    const block = item as { type?: unknown; id?: unknown }
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      ids.add(block.id)
    }
  }
  return ids
}

function toolResultIds(message: ContextMessage): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(message.message.content)) return ids
  for (const item of message.message.content) {
    if (typeof item !== 'object' || item === null) continue
    const block = item as { type?: unknown; tool_use_id?: unknown }
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      ids.add(block.tool_use_id)
    }
  }
  return ids
}

function isValidContextMessage(value: unknown): value is ContextMessage {
  if (typeof value !== 'object' || value === null) return false
  const msg = value as Record<string, unknown>
  if (msg.type !== 'user' && msg.type !== 'assistant') return false
  const message = msg.message
  if (typeof message !== 'object' || message === null) return false
  if (!('content' in message)) return false
  return true
}

function hasOnlyPairwiseToolBlocks(messages: ContextMessage[]): boolean {
  const defined = new Set<string>()
  for (const message of messages) {
    for (const id of toolUseIds(message)) defined.add(id)
    for (const id of toolResultIds(message)) {
      if (!defined.has(id)) return false
    }
  }
  return true
}

async function compressMessagesForProviderCore<T extends ContextMessage>(
  messages: T[],
  providers: string[],
): Promise<{
  messages: T[]
  source: 'disabled' | 'omniroute' | 'unchanged' | 'local' | 'remote'
  remoteError?: Error
}> {
  if (!isContextCompressionEnabled()) return { messages, source: 'disabled' }
  if (
    isContextCompressionSkippedWhenOmniRoute() &&
    providers.some(isOmniRouteProvider)
  ) {
    return { messages, source: 'omniroute' }
  }
  const budget = getContextCompressionBudgetTokens()

  let remoteError: Error | undefined
  const remoteUrl = getRemoteCompressionUrl()
  if (remoteUrl) {
    try {
      const response = await fetch(remoteUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, budgetTokens: budget, providers }),
        signal: AbortSignal.timeout(REMOTE_COMPRESSION_TIMEOUT_MS),
      })
      if (!response.ok)
        throw new Error(`Remote compression failed: ${response.status}`)
      const contentLength = response.headers.get('content-length')
      if (
        contentLength !== null &&
        Number.isFinite(Number(contentLength)) &&
        Number(contentLength) > MAX_REMOTE_COMPRESSION_RESPONSE_BYTES
      ) {
        throw new Error('Remote compression response is too large')
      }
      const body = await response.text()
      if (
        new TextEncoder().encode(body).byteLength >
        MAX_REMOTE_COMPRESSION_RESPONSE_BYTES
      ) {
        throw new Error('Remote compression response is too large')
      }
      const payload: unknown = JSON.parse(body)
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !Array.isArray((payload as { messages?: unknown }).messages) ||
        !(payload as { messages: unknown[] }).messages.every(
          isValidContextMessage,
        )
      ) {
        throw new Error('Remote compression returned invalid messages')
      }
      const remoteMessages = (payload as { messages: ContextMessage[] })
        .messages
      if (!hasOnlyPairwiseToolBlocks(remoteMessages)) {
        throw new Error('Remote compression returned unpaired tool messages')
      }
      return { messages: remoteMessages as unknown as T[], source: 'remote' }
    } catch (error) {
      remoteError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (
    budget <= 0 ||
    messages.reduce((sum, message) => sum + estimateTokens(message), 0) <=
      budget
  ) {
    return {
      messages,
      source: 'unchanged',
      ...(remoteError && { remoteError }),
    }
  }

  // Group tool_use/tool_result messages into atomic transactions (union-find)
  // so trimming never splits a tool transaction or leaves an orphaned half.
  const parent = messages.map((_, index) => index)
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]
      index = parent[index]!
    }
    return index
  }
  const union = (a: number, b: number): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[rootA] = rootB
  }
  const useByToolId = new Map<string, number>()
  for (let index = 0; index < messages.length; index++) {
    for (const id of toolUseIds(messages[index]!)) {
      useByToolId.set(id, index)
    }
  }
  for (let index = 0; index < messages.length; index++) {
    for (const id of toolResultIds(messages[index]!)) {
      const useIndex = useByToolId.get(id)
      if (useIndex !== undefined) union(useIndex, index)
    }
  }
  const components = new Map<number, number[]>()
  for (let index = 0; index < messages.length; index++) {
    const root = find(index)
    const list = components.get(root)
    if (list) list.push(index)
    else components.set(root, [index])
  }
  const ordered = [...components.values()].sort((a, b) => {
    const aLast = a[a.length - 1]!
    const bLast = b[b.length - 1]!
    return bLast - aLast
  })
  const kept: T[] = []
  let used = 0
  for (
    let componentIndex = 0;
    componentIndex < ordered.length;
    componentIndex++
  ) {
    const component = ordered[componentIndex]!
    const cost = component.reduce(
      (sum, index) => sum + estimateTokens(messages[index]!),
      0,
    )
    if (used + cost > budget && kept.length > 0) continue
    for (const index of component) {
      kept.push(messages[index]!)
    }
    used += cost
  }
  return {
    messages: kept,
    source: 'local',
    ...(remoteError && { remoteError }),
  }
}

export async function compressMessagesForProvider<T extends ContextMessage>(
  messages: T[],
  providers: string[],
): Promise<{
  messages: T[]
  source: 'disabled' | 'omniroute' | 'unchanged' | 'local' | 'remote'
  remoteError?: Error
}> {
  return compressMessagesForProviderCore(messages, providers)
=======
=======
>>>>>>> Stashed changes
  const envValue = process.env.CCB_CONTEXT_COMPRESSION_ENABLED
  if (envValue !== undefined) {
    if (isEnvDefinedFalsy(envValue)) return false
    if (isEnvTruthy(envValue)) return true
  }
  const value = getRuntimeConfig().contextCompressionEnabled
  return typeof value === 'boolean' ? value : true
}

export function getContextCompressionBudgetTokens(): number {
  const raw =
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS ??
    getRuntimeConfig().contextCompressionBudgetTokens
  if (raw === undefined || raw === null) return DEFAULT_BUDGET_TOKENS
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  }
  const normalized = String(raw).trim()
  if (!/^\d+$/.test(normalized)) return 0
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

export function isContextCompressionSkippedWhenOmniRoute(): boolean {
  const envValue = process.env.CCB_CONTEXT_COMPRESSION_SKIP_WHEN_OMNIROUTE
  if (envValue !== undefined) {
    if (isEnvDefinedFalsy(envValue)) return false
    if (isEnvTruthy(envValue)) return true
  }
  const value = getRuntimeConfig().contextCompressionSkipWhenOmniRoute
  return typeof value === 'boolean' ? value : true
}

export type ProviderMessage = {
  type: 'user' | 'assistant'
  message: { content?: unknown }
}

export type ProviderCompressionResult<T extends ProviderMessage> = {
  messages: T[]
  source: 'disabled' | 'omniroute' | 'remote' | 'local' | 'unchanged'
  remoteError?: Error
}

type ToolBlock = Record<string, unknown> & { type?: unknown }

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  try {
    const serialized = JSON.stringify(content ?? '')
    return typeof serialized === 'string'
      ? serialized
      : '[unserializable content]'
  } catch {
    return '[unserializable content]'
  }
}

function estimateMessageTokens(message: ProviderMessage): number {
  return Math.ceil(stringifyContent(message.message.content).length / 4)
}

function getContentBlocks(message: ProviderMessage): ToolBlock[] {
  return Array.isArray(message.message.content)
    ? message.message.content.filter(
        (block): block is ToolBlock =>
          block !== null && typeof block === 'object',
      )
    : []
}

function getToolUseIds(message: ProviderMessage): string[] {
  return getContentBlocks(message)
    .filter(block => block.type === 'tool_use' && typeof block.id === 'string')
    .map(block => block.id as string)
}

function getToolResultIds(message: ProviderMessage): string[] {
  return getContentBlocks(message)
    .filter(
      block =>
        block.type === 'tool_result' && typeof block.tool_use_id === 'string',
    )
    .map(block => block.tool_use_id as string)
}

function retainCompleteToolTransactions<T extends ProviderMessage>(
  messages: T[],
  retainedIndexes: Set<number>,
): Set<number> {
  const toolUses = new Map<string, number>()
  const toolResults = new Map<string, number>()
  messages.forEach((message, index) => {
    for (const id of getToolUseIds(message)) toolUses.set(id, index)
    for (const id of getToolResultIds(message)) toolResults.set(id, index)
  })
  let changed = true
  while (changed) {
    changed = false
    for (const index of [...retainedIndexes]) {
      for (const id of getToolUseIds(messages[index]!)) {
        const resultIndex = toolResults.get(id)
        if (resultIndex !== undefined && !retainedIndexes.has(resultIndex)) {
          retainedIndexes.add(resultIndex)
          changed = true
        }
      }
      for (const id of getToolResultIds(messages[index]!)) {
        const useIndex = toolUses.get(id)
        if (useIndex !== undefined && !retainedIndexes.has(useIndex)) {
          retainedIndexes.add(useIndex)
          changed = true
        }
      }
    }
  }
  return retainedIndexes
}

function trimProviderMessagesToBudget<T extends ProviderMessage>(
  messages: T[],
  budgetTokens: number,
): T[] {
  const retainedIndexes = new Set<number>()
  for (let index = messages.length - 1; index >= 0; index--) {
    const candidateIndexes = retainCompleteToolTransactions(
      messages,
      new Set([...retainedIndexes, index]),
    )
    const candidateCost = [...candidateIndexes].reduce(
      (total, candidateIndex) =>
        total + estimateMessageTokens(messages[candidateIndex]!),
      0,
    )
    if (retainedIndexes.size > 0 && candidateCost > budgetTokens) break
    retainedIndexes.clear()
    for (const candidateIndex of candidateIndexes) {
      retainedIndexes.add(candidateIndex)
    }
  }
  return messages.filter((_message, index) => retainedIndexes.has(index))
}

function hasOmniRouteProvider(providerIds: readonly string[]): boolean {
  return providerIds.some(
    providerId =>
      providerId === 'omniroute' || providerId === 'omniroute-9router',
  )
}

function hasCompleteToolTransactions(messages: ProviderMessage[]): boolean {
  const toolUses = new Set<string>()
  const toolResults = new Set<string>()
  for (const message of messages) {
    for (const id of getToolUseIds(message)) {
      if (toolUses.has(id)) return false
      toolUses.add(id)
    }
    for (const id of getToolResultIds(message)) {
      if (toolResults.has(id)) return false
      toolResults.add(id)
    }
  }
  return (
    toolUses.size === toolResults.size &&
    [...toolUses].every(id => toolResults.has(id))
  )
}

function isProviderMessage(value: unknown): value is ProviderMessage {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const nested = record.message
  if (
    (record.type !== 'user' && record.type !== 'assistant') ||
    nested === null ||
    typeof nested !== 'object' ||
    !('content' in nested)
  ) {
    return false
  }
  const content = (nested as Record<string, unknown>).content
  return (
    typeof content === 'string' ||
    (Array.isArray(content) &&
      content.every(block => block !== null && typeof block === 'object'))
  )
}

function isProviderMessageList(value: unknown): value is ProviderMessage[] {
  return (
    Array.isArray(value) &&
    value.every(isProviderMessage) &&
    hasCompleteToolTransactions(value)
  )
}

async function readRemoteResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const length = Number(contentLength)
    if (!Number.isSafeInteger(length) || length > MAX_REMOTE_RESPONSE_BYTES) {
      throw new Error('Remote context compression response is too large')
    }
  }
  if (!response.body) return response.json()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_REMOTE_RESPONSE_BYTES) {
        throw new Error('Remote context compression response is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function messageKey(message: ProviderMessage): string {
  try {
    return JSON.stringify(message)
  } catch {
    return ''
  }
}

function restoreOriginalMessages<T extends ProviderMessage>(
  original: T[],
  compressed: ProviderMessage[],
): T[] | undefined {
  const byKey = new Map<string, T>()
  for (const message of original) {
    const key = messageKey(message)
    if (key) byKey.set(key, message)
  }
  const restored = compressed.map(message => byKey.get(messageKey(message)))
  return restored.every((message): message is T => message !== undefined)
    ? restored
    : undefined
}

async function requestRemoteCompression<T extends ProviderMessage>(
  url: string,
  messages: T[],
  budgetTokens: number,
): Promise<T[]> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, budgetTokens }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(
      `Remote context compression failed with HTTP ${response.status}`,
    )
  }
  const payload = await readRemoteResponse(response)
  const compressed =
    payload && typeof payload === 'object' && 'messages' in payload
      ? payload.messages
      : undefined
  if (!isProviderMessageList(compressed)) {
    throw new Error(
      'Remote context compression returned an invalid message list',
    )
  }
  const restored = restoreOriginalMessages(messages, compressed)
  if (!restored) {
    throw new Error(
      'Remote context compression changed message semantics unexpectedly',
    )
  }
  return restored
}

export async function compressMessagesForProvider<T extends ProviderMessage>(
  messages: T[],
  providerIds: readonly string[],
): Promise<ProviderCompressionResult<T>> {
  if (!isContextCompressionEnabled()) {
    return { messages, source: 'disabled' }
  }
  if (
    isContextCompressionSkippedWhenOmniRoute() &&
    hasOmniRouteProvider(providerIds)
  ) {
    return { messages, source: 'omniroute' }
  }
  const budgetTokens = getContextCompressionBudgetTokens()
  const remoteUrl = getRemoteCompressionUrl()
  if (remoteUrl) {
    try {
      return {
        messages: await requestRemoteCompression(
          remoteUrl,
          messages,
          budgetTokens,
        ),
        source: 'remote',
      }
    } catch (error) {
      const remoteError =
        error instanceof Error
          ? error
          : new Error('Remote context compression failed', { cause: error })
      return {
        messages:
          budgetTokens > 0
            ? trimProviderMessagesToBudget(messages, budgetTokens)
            : messages,
        source: budgetTokens > 0 ? 'local' : 'unchanged',
        remoteError,
      }
    }
  }
  if (budgetTokens <= 0) return { messages, source: 'unchanged' }
  return {
    messages: trimProviderMessagesToBudget(messages, budgetTokens),
    source: 'local',
  }
<<<<<<< Updated upstream
>>>>>>> Stashed changes
=======
>>>>>>> Stashed changes
}

export function termuxCompressionNotice(): string | undefined {
  return isTermuxRuntime() && !getRemoteCompressionUrl()
    ? '当前为 Termux，可在配置文件中设置远程压缩地址。'
    : undefined
}
