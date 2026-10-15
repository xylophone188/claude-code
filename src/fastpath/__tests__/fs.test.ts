import { test, expect, beforeAll, afterAll } from 'bun:test'
import * as fs from '../fs'

const TMP = '/tmp/fp-fs-test-' + process.pid

beforeAll(async () => {
  await fs.mkdir(TMP)
  await fs.write(TMP + '/a.txt', 'hello')
  await fs.write(TMP + '/sub/b.txt', 'world')
})

afterAll(async () => {
  await fs.rm(TMP)
})

test('fs.write + fs.read roundtrip', async () => {
  const r = await fs.read(TMP + '/a.txt')
  expect(r.ok).toBe(true)
  expect((r.result as any).content).toBe('hello')
})

test('fs.mkdir + fs.ls lists entries', async () => {
  const r = await fs.ls(TMP)
  expect(r.ok).toBe(true)
  const names = (r.result as any).map((e: any) => e.name)
  expect(names).toContain('a.txt')
  expect(names).toContain('sub')
})

test('fs.copy + fs.mv + fs.rm lifecycle', async () => {
  await fs.copy(TMP + '/a.txt', TMP + '/copy.txt')
  const ex1 = await fs.read(TMP + '/copy.txt')
  expect(ex1.ok).toBe(true)
  await fs.mv(TMP + '/copy.txt', TMP + '/moved.txt')
  const ex2 = await fs.read(TMP + '/moved.txt')
  expect(ex2.ok).toBe(true)
  await fs.rm(TMP + '/moved.txt')
  const ex3 = await fs.read(TMP + '/moved.txt')
  expect(ex3.ok).toBe(false)
})

test('fs.find recursively matches glob-ish regex', async () => {
  const r = await fs.find(TMP, /\.txt$/.source)
  expect(r.ok).toBe(true)
  const matches = (r.result as any).matches as string[]
  expect(matches.length).toBeGreaterThanOrEqual(2)
})
