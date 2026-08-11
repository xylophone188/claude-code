import { afterEach, expect, test } from 'bun:test'
import { routeError } from '../stageLog.js'

const originalWrite = process.stderr.write.bind(process.stderr)

afterEach(() => {
  process.stderr.write = originalWrite
})

test('writes a routing message once', () => {
  let output = ''
  process.stderr.write = (chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  }

  routeError('model failed', { model: 'test' })

  expect(output).toMatch(
    /^\d{4}-\d{2}-\d{2} .* \[routing\] \[error\] model failed {"model":"test"}\n$/,
  )
  expect(output.match(/model failed/g)).toHaveLength(1)
})
