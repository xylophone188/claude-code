export {
  SearchEngineClient,
  getSearchEngine,
  searchEnginePing,
} from './client.js'
export {
  SESSION_MEMORY_INDEX_NAME,
  ensureSessionMemoryIndex,
  ensureSessionMemorySearchIndex,
  indexSessionMemory,
  indexSessionMemoryFireAndForget,
  resolveSessionMemoryDocId,
  type IndexSessionMemoryResult,
} from './sessionMemoryIndex.js'
