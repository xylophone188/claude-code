import { test, expect } from 'bun:test'
import { toKebab, toSnake, toCamel, toPascal, renameBatch } from '../rename'

test('toKebab handles space/underscore/dash/camel', () => {
  expect(toKebab('my var')).toBe('my-var')
  expect(toKebab('my_var')).toBe('my-var')
  expect(toKebab('myVar')).toBe('my-var')
})

test('toSnake converts camel to underscores', () => {
  expect(toSnake('myVarName')).toBe('my_var_name')
  expect(toSnake('My-Var')).toBe('my_var')
})

test('toCamel and toPascal from kebab/space', () => {
  expect(toCamel('my-var-name')).toBe('myVarName')
  expect(toPascal('my-var-name')).toBe('MyVarName')
  expect(toCamel('Hello World')).toBe('helloWorld')
})

test('renameBatch renames files and reports errors', async () => {
  const fs = await import('fs/promises')
  const os = await import('os')
  const path = await import('path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-rb-'))
  await fs.writeFile(path.join(dir, 'a.txt'), 'x')
  await fs.writeFile(path.join(dir, 'b.txt'), 'y')
  const r = await renameBatch(dir, [
    { from: 'a.txt', to: 'aa.txt' },
    { from: 'missing.txt', to: 'm2.txt' },
  ])
  expect(r.ok).toBe(false)
  expect(r.renamed).toEqual([{ from: 'a.txt', to: 'aa.txt' }])
  expect(r.errors.length).toBe(1)
  await fs.rm(dir, { recursive: true, force: true })
})
