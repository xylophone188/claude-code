import { expect, test } from 'bun:test'
import {
  _resetCacheWarningStateForTest,
  shouldShowCacheWarning,
} from '../cacheWarning.js'

const lowCacheUsage = {
  input_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 50,
}

test('warns once while a source remains below its cache threshold', () => {
  _resetCacheWarningStateForTest()

  // First call initializes state and returns null (no warning on first hit)
  expect(shouldShowCacheWarning(lowCacheUsage, 'session-1', 70)).toBeNull()
  // Second call: hitRate (50) < threshold (70), should warn
  expect(shouldShowCacheWarning(lowCacheUsage, 'session-1', 70)).toMatchObject({
    hitRate: 50,
    threshold: 70,
    shouldWarn: true,
  })
})
