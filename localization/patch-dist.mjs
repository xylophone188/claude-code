#!/usr/bin/env node
// Patch all built dist/*.js with Chinese translations (safe mode).
// Safe: patch-cli.cjs syntax-checks before writing; failures are skipped.
import { readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const outdir = process.argv[2] ?? 'dist'
const translations = join(here, 'cli-translations.json')
const patcher = join(here, 'patch-cli.cjs')

let files = 0
let replaced = 0
for (const f of await readdir(outdir)) {
  if (!f.endsWith('.js')) continue
  const r = spawnSync('node', [patcher, join(outdir, f), translations], {
    encoding: 'utf-8',
    timeout: 60_000,
  })
  files++
  const n = parseInt(String(r.stdout ?? '').trim(), 10)
  if (!Number.isNaN(n)) replaced += n
}

console.log(`Localized ${files} dist files (${replaced} strings replaced)`)
