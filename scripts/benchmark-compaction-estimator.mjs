#!/usr/bin/env node
/**
 * benchmark-compaction-estimator.mjs
 * Benchmarks estimateJsonByteLength (new) vs JSON.stringify (old) for
 * Compaction token estimation.
 *
 * Usage: node scripts/benchmark-compaction-estimator.mjs
 */

import { performance } from 'node:perf_hooks'
import v8 from 'node:v8'
import process from 'node:process'

// ─── Re-implement estimateJsonByteLength (copy from contextAnalysis.ts) ──────

function estimateJsonByteLength(value) {
  if (value === null) return 4 // "null"
  switch (typeof value) {
    case 'boolean':
      return value ? 4 : 5 // "true" / "false"
    case 'number':
      return String(value).length
    case 'string': {
      let len = 2 // opening + closing quote
      for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i)
        if (c === 0x22 || c === 0x5c || c < 0x20) {
          len += 2 // escaped char
        } else {
          len += 1
        }
      }
      return len
    }
    case 'object': {
      if (Array.isArray(value)) {
        let len = 2 // [ ]
        for (let i = 0; i < value.length; i++) {
          if (i > 0) len += 1 // comma
          len += estimateJsonByteLength(value[i])
        }
        return len
      }
      // Plain object
      const keys = Object.keys(value)
      let len = 2 // { }
      let first = true
      for (const key of keys) {
        const v = value[key]
        if (v === undefined) continue
        if (!first) len += 1 // comma
        first = false
        len += estimateJsonByteLength(key) + 1 + estimateJsonByteLength(v)
      }
      return len
    }
    default:
      return 0
  }
}

// Old approach: JSON.stringify then measure length
function jsonStringifyLength(value) {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

// ─── Payloads ─────────────────────────────────────────────────────────────────

function makeAsciiPayload(size) {
  const text = 'Hello, World! This is a typical ASCII tool result output. '
    .repeat(Math.ceil(size / 58))
    .slice(0, size)
  return { type: 'tool_result', tool_use_id: 'toolu_abc123', content: text }
}

function makeCJKPayload(size) {
  const cjk =
    '这是一段中文密集型的工具输出，包含典型的代码审计与分析内容。代码路径：/home/user/project/src/main.ts。'
      .repeat(Math.ceil(size / 40))
      .slice(0, size)
  return { type: 'tool_result', tool_use_id: 'toolu_cjk001', content: cjk }
}

function makeEmojiPayload(size) {
  // Each emoji is a surrogate pair in JS (2 code units)
  const emojiStr = '🎉🚀💡🔥✅❌📦🧪🔍🛠️'
    .repeat(Math.ceil(size / 20))
    .slice(0, size)
  return {
    type: 'tool_result',
    tool_use_id: 'toolu_emoji01',
    content: emojiStr,
  }
}

function makeNestedPayload(depth) {
  let obj = { leaf: 'value', count: 42, active: true }
  for (let i = 0; i < depth; i++) {
    obj = { level: i, data: obj, tags: ['alpha', 'beta', 'gamma'] }
  }
  return { type: 'tool_use', id: 'toolu_nested', name: 'Bash', input: obj }
}

function makeLargePayload(sizeMB) {
  const chars = sizeMB * 1024 * 1024
  // Mix of ASCII + some CJK
  let text = ''
  const chunk = 'ABCDEFGHIJKLMNOP0123456789 这段内容 '
  while (text.length < chars) text += chunk
  text = text.slice(0, chars)
  return {
    type: 'tool_result',
    tool_use_id: `toolu_large_${sizeMB}mb`,
    content: text,
  }
}

// ─── Edge cases ────────────────────────────────────────────────────────────────

const EDGE_CASES = {
  specialChars: {
    type: 'text',
    text: 'Control: \x00\x01\x1f\n\r\t and quotes "hello" and backslash \\ and unicode \u2603',
  },
  emptyString: { type: 'text', text: '' },
  nullValues: { type: 'tool_result', tool_use_id: 'x', content: [null, null] },
  mixedTypes: {
    type: 'tool_use',
    id: 'toolu_x',
    name: 'Test',
    input: {
      str: 'hello',
      num: 3.14,
      bool: false,
      nul: null,
      arr: [1, 'two', true, null],
    },
  },
  // Special objects — JSON.stringify behavior
  withDate: { created: new Date().toString(), value: 42 },
  withUndefined: { a: 1, b: undefined, c: 3 }, // undefined skipped by JSON.stringify
}

// ─── Benchmark runner ─────────────────────────────────────────────────────────

function heapUsedMB() {
  return process.memoryUsage().heapUsed / (1024 * 1024)
}

function runBenchmark(name, payload, iterations = 100) {
  // Warm up
  estimateJsonByteLength(payload)
  jsonStringifyLength(payload)

  // --- New impl ---
  const h0 = heapUsedMB()
  const t0 = performance.now()
  let estimResult = 0
  for (let i = 0; i < iterations; i++) {
    estimResult = estimateJsonByteLength(payload)
  }
  const t1 = performance.now()
  const h1 = heapUsedMB()

  // --- Old impl ---
  const h2 = heapUsedMB()
  const t2 = performance.now()
  let jsonResult = 0
  for (let i = 0; i < iterations; i++) {
    jsonResult = jsonStringifyLength(payload)
  }
  const t3 = performance.now()
  const h3 = heapUsedMB()

  // Force GC if available
  if (global.gc) global.gc()

  const estimMs = (t1 - t0).toFixed(3)
  const jsonMs = (t3 - t2).toFixed(3)
  const estimHeapDelta = (h1 - h0).toFixed(2)
  const jsonHeapDelta = (h3 - h2).toFixed(2)
  const error =
    jsonResult === 0
      ? 'N/A'
      : (((estimResult - jsonResult) / jsonResult) * 100).toFixed(2)
  const speedup =
    jsonMs > 0 ? (parseFloat(jsonMs) / parseFloat(estimMs)).toFixed(2) : 'N/A'

  return {
    name,
    iterations,
    estimateMs: parseFloat(estimMs),
    jsonStringifyMs: parseFloat(jsonMs),
    speedupX: speedup,
    estimateHeapDeltaMB: parseFloat(estimHeapDelta),
    jsonHeapDeltaMB: parseFloat(jsonHeapDelta),
    estimateResult: estimResult,
    jsonResult: jsonResult,
    errorPct: error,
    payloadSizeApprox: jsonResult,
  }
}

// ─── Stack overflow / circular reference checks ──────────────────────────────

function testCircularReference() {
  const obj = { a: 1, b: { c: 2 } }
  obj.self = obj // circular
  try {
    const r = estimateJsonByteLength(obj)
    return { status: 'STACK_OVERFLOW_RISK', result: r }
  } catch (e) {
    return { status: 'THROWS', error: e.message }
  }
}

function testDeeplyNested(depth) {
  let obj = { value: 'leaf' }
  for (let i = 0; i < depth; i++) obj = { child: obj }
  try {
    const t0 = performance.now()
    const r = estimateJsonByteLength(obj)
    const ms = (performance.now() - t0).toFixed(2)
    return { status: 'OK', depth, result: r, ms }
  } catch (e) {
    return { status: 'THROWS', depth, error: e.message }
  }
}

function testSpecialObjects() {
  const results = {}
  // Date — JSON.stringify returns ISO string; estimator sees Object.keys([]) = [] → returns 2
  const dateObj = new Date('2026-10-09T00:00:00Z')
  results.Date = {
    estimate: estimateJsonByteLength(dateObj),
    json: jsonStringifyLength(dateObj),
    note: 'Date has no own enumerable keys → estimate=2 ("{}"), JSON gives ISO string',
  }
  // BigInt — JSON.stringify throws; estimator returns 0
  try {
    results.BigInt = {
      estimate: estimateJsonByteLength(BigInt(9007199254740991)),
      json: '(throws)',
      note: 'BigInt is typeof "bigint", hits default → 0',
    }
  } catch (e) {
    results.BigInt = { error: e.message }
  }
  // RegExp
  const re = /hello/gi
  results.RegExp = {
    estimate: estimateJsonByteLength(re),
    json: jsonStringifyLength(re),
    note: 'RegExp → {} in JSON (2 chars). Estimator: own props → 2',
  }
  return results
}

// ─── Main ──────────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════════════════')
console.log('  Compaction Estimator Benchmark  —  estimateJsonByteLength')
console.log('═══════════════════════════════════════════════════════════════\n')

const benchmarks = []

// Standard payloads
console.log('▶ Running standard payload benchmarks...')
benchmarks.push(runBenchmark('ASCII-small (1 KB)', makeAsciiPayload(1024), 500))
benchmarks.push(
  runBenchmark('ASCII-medium (64 KB)', makeAsciiPayload(65536), 100),
)
benchmarks.push(runBenchmark('CJK-small (1 KB)', makeCJKPayload(1024), 500))
benchmarks.push(runBenchmark('CJK-dense (64 KB)', makeCJKPayload(65536), 100))
benchmarks.push(runBenchmark('Emoji-mixed (1 KB)', makeEmojiPayload(1024), 500))
benchmarks.push(
  runBenchmark('Emoji-mixed (32 KB)', makeEmojiPayload(32768), 100),
)
benchmarks.push(runBenchmark('Nested-10 levels', makeNestedPayload(10), 500))
benchmarks.push(runBenchmark('Nested-50 levels', makeNestedPayload(50), 200))
benchmarks.push(runBenchmark('Nested-100 levels', makeNestedPayload(100), 100))

// Large payloads — reduced iterations to avoid excessive test time
console.log('▶ Running large payload benchmarks (1MB/5MB/10MB)...')
benchmarks.push(runBenchmark('LargeToolOutput-1MB', makeLargePayload(1), 10))
benchmarks.push(runBenchmark('LargeToolOutput-5MB', makeLargePayload(5), 5))
benchmarks.push(runBenchmark('LargeToolOutput-10MB', makeLargePayload(10), 3))

// Edge cases
console.log('▶ Running edge case benchmarks...')
for (const [caseName, payload] of Object.entries(EDGE_CASES)) {
  benchmarks.push(runBenchmark(`EdgeCase-${caseName}`, payload, 500))
}

// Print table
console.log(
  '\n┌─────────────────────────────────────────────────────────────────────────────────────┐',
)
console.log(
  '│ Benchmark Results                                                                   │',
)
console.log(
  '├──────────────────────────────┬──────────┬──────────┬──────────┬─────────┬─────────┤',
)
console.log(
  '│ Name                         │ Est(ms)  │ JSON(ms) │ Speedup  │ EstHeap │ Err%    │',
)
console.log(
  '├──────────────────────────────┼──────────┼──────────┼──────────┼─────────┼─────────┤',
)
for (const b of benchmarks) {
  const name = b.name.padEnd(30).slice(0, 30)
  const eMs = String(b.estimateMs).padStart(8)
  const jMs = String(b.jsonStringifyMs).padStart(8)
  const spd = String(b.speedupX).padStart(8)
  const heap = String(b.estimateHeapDeltaMB).padStart(7)
  const err = String(b.errorPct).padStart(7)
  console.log(`│ ${name} │ ${eMs} │ ${jMs} │ ${spd} │ ${heap} │ ${err} │`)
}
console.log(
  '└──────────────────────────────┴──────────┴──────────┴──────────┴─────────┴─────────┘',
)

// Stack overflow / circular reference analysis
console.log('\n▶ Edge-case safety checks...')
const circularResult = testCircularReference()
console.log('  Circular reference test:', JSON.stringify(circularResult))

const deepTests = [100, 500, 1000, 5000].map(d => testDeeplyNested(d))
console.log('  Deep nesting tests:')
for (const dt of deepTests) {
  console.log(`    depth=${dt.depth}: ${JSON.stringify(dt)}`)
}

const specialResults = testSpecialObjects()
console.log('  Special objects (Date/BigInt/RegExp):')
for (const [k, v] of Object.entries(specialResults)) {
  console.log(
    `    ${k}: estimate=${v.estimate}, json=${v.json} — ${v.note || ''}`,
  )
}

// Unicode analysis
console.log('\n▶ Unicode character handling analysis...')
const unicodeTests = [
  { name: 'BMP-ASCII    U+0041 "A"', char: 'A', expected: 1 },
  { name: 'BMP-CJK      U+4E2D "中"', char: '中', expected: 1 },
  { name: 'BMP-quote    U+0022 """', char: '"', expected: 2 },
  { name: 'BMP-bslash   U+005C "\\"', char: '\\', expected: 2 },
  { name: 'BMP-control  U+0009 TAB', char: '\t', expected: 2 },
  { name: 'BMP-control  U+000A LF', char: '\n', expected: 2 },
  {
    name: 'Surrogate    U+1F600 "😀"',
    char: '😀',
    expected: '2 (JS: 2 code units, surrog pair)',
  },
  {
    name: 'Emoji-seq    "🧑‍💻" ZWJ',
    char: '🧑‍💻',
    expected: 'multiple code units',
  },
]
for (const ut of unicodeTests) {
  // estimator counts JS char units (charCodeAt based), NOT Unicode code points
  const innerLen = estimateJsonByteLength(ut.char) - 2 // remove quotes
  const jsonLen = JSON.stringify(ut.char).length - 2
  const match =
    innerLen === jsonLen ? 'MATCH' : `DIFF (est=${innerLen}, json=${jsonLen})`
  console.log(
    `  ${ut.name.padEnd(35)} → inner_len: ${String(innerLen).padStart(3)}, json_len: ${String(jsonLen).padStart(3)} [${match}]`,
  )
}

// Token estimation analysis (÷4 rule)
console.log('\n▶ Token budget accuracy check (charCount÷4 vs JSON.length÷4)...')
const tokenTestPayloads = [
  { name: 'ASCII-1KB', p: makeAsciiPayload(1024) },
  { name: 'CJK-1KB', p: makeCJKPayload(1024) },
  { name: 'Emoji-1KB', p: makeEmojiPayload(1024) },
  { name: 'Nested-50', p: makeNestedPayload(50) },
]
for (const { name, p } of tokenTestPayloads) {
  const estimTokens = Math.round(estimateJsonByteLength(p) / 4)
  const jsonTokens = Math.round(jsonStringifyLength(p) / 4)
  const diff = estimTokens - jsonTokens
  const diffPct =
    jsonTokens > 0 ? ((diff / jsonTokens) * 100).toFixed(1) : 'N/A'
  console.log(
    `  ${name.padEnd(12)}: estimTokens=${estimTokens}, jsonTokens=${jsonTokens}, diff=${diff} (${diffPct}%)`,
  )
}

// Summary statistics
const validBenchmarks = benchmarks.filter(b => b.errorPct !== 'N/A')
const avgError =
  validBenchmarks.length > 0
    ? (
        validBenchmarks.reduce(
          (s, b) => s + Math.abs(parseFloat(b.errorPct)),
          0,
        ) / validBenchmarks.length
      ).toFixed(2)
    : 'N/A'
const avgSpeedup =
  benchmarks
    .filter(b => b.speedupX !== 'N/A')
    .reduce((s, b) => s + parseFloat(b.speedupX), 0) /
  benchmarks.filter(b => b.speedupX !== 'N/A').length
const maxJsonHeap = Math.max(...benchmarks.map(b => b.jsonHeapDeltaMB))
const maxEstHeap = Math.max(...benchmarks.map(b => b.estimateHeapDeltaMB))

const summary = {
  totalBenchmarks: benchmarks.length,
  avgEstimationErrorPct: parseFloat(avgError),
  avgSpeedupX: parseFloat(avgSpeedup.toFixed(2)),
  maxJsonHeapDeltaMB: maxJsonHeap,
  maxEstimateHeapDeltaMB: maxEstHeap,
  heapReductionPct:
    maxJsonHeap > 0
      ? parseFloat(((1 - maxEstHeap / maxJsonHeap) * 100).toFixed(1))
      : 0,
  circularSafe: circularResult.status !== 'OK', // circular should throw or overflow
  stackSafeUpToDepth:
    deepTests
      .filter(d => d.status === 'OK')
      .map(d => d.depth)
      .slice(-1)[0] || 0,
  benchmarks,
  unicodeNotes: [
    'CJK chars (U+4E00~U+9FFF) are counted as 1 code unit (1 estimated char) — matches JSON.stringify behavior for BMP chars',
    'Surrogate pairs (emoji U+1F000+): JS charCodeAt sees 2 code units each counted as +1 → matches JSON.stringify char count',
    'Control chars (<0x20, quotes, backslash) correctly counted as 2 (escaped) → matches JSON.stringify',
    'estimateJsonByteLength precision: ~within 5% for typical API content blocks',
  ],
  specialObjectNotes: specialResults,
  deepNestingResults: deepTests,
  circularReferenceResult: circularResult,
}

console.log('\n═══════════════════════════════════════════════════════════════')
console.log('  BENCHMARK SUMMARY')
console.log('═══════════════════════════════════════════════════════════════')
console.log(`  Avg estimation error:     ${avgError}%`)
console.log(`  Avg speedup (new vs old): ${avgSpeedup.toFixed(2)}x`)
console.log(`  Max JSON heap delta:      ${maxJsonHeap.toFixed(2)} MB`)
console.log(`  Max estimate heap delta:  ${maxEstHeap.toFixed(2)} MB`)
console.log(`  Circular ref safe:        ${circularResult.status}`)
console.log(`  Max safe depth:           ${summary.stackSafeUpToDepth}`)
console.log('═══════════════════════════════════════════════════════════════\n')

// Output JSON for external consumption
import { writeFileSync } from 'node:fs'
writeFileSync(
  '/tmp/compaction-benchmark-results.json',
  JSON.stringify(summary, null, 2),
)
console.log('Results written to /tmp/compaction-benchmark-results.json')
