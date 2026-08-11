import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectLogAuditEvents,
  emptyLogAuditState,
  redactLogLine,
} from '../logAudit.js'

const now = Date.parse('2026-08-10T12:00:00.000Z')
let dir: string | undefined

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('CCB log audit', () => {
  test('reads fresh warn/error once and redacts secrets', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ccb-log-audit-'))
    const file = join(dir, 'ccb.log')
    await writeFile(
      file,
      [
        '2026-08-10 11:59:00.000 [routing] [error] failed: Bearer secret-token nvapi-secret',
        '2026-08-10 10:00:00.000 [routing] [error] stale failure',
        '2026-08-10 11:59:01.000 [routing] [error] failed: Bearer secret-token nvapi-secret',
      ].join('\n'),
    )
    const state = emptyLogAuditState()

    const events = await collectLogAuditEvents(file, state, now)

    expect(events).toHaveLength(1)
    expect(events[0]?.level).toBe('error')
    expect(events[0]?.text).toContain('<redacted>')
    expect(events[0]?.text).not.toContain('secret-token')
    expect(await collectLogAuditEvents(file, state, now + 1)).toEqual([])
  })

  test('keeps benign CJK output and redacts common credential forms', () => {
    expect(redactLogLine('模型回复中文和日本語')).toContain('日本語')
    expect(redactLogLine('token=secret-value')).toContain('token=<redacted>')
    const redacted = redactLogLine(
      'account=person@example.com chatgpt_account_id: worker-123 email="person@example.com"',
    )
    expect(redacted).not.toContain('person@example.com')
    expect(redacted).not.toContain('worker-123')
  })

  test('uses byte offsets when appended logs contain Unicode', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ccb-log-audit-'))
    const file = join(dir, 'ccb.log')
    const state = emptyLogAuditState()
    await writeFile(file, '2026-08-10 11:59:00.000 [warn] 中文\n')
    expect(await collectLogAuditEvents(file, state, now)).toHaveLength(1)

    await writeFile(file, '2026-08-10 11:59:01.000 [error] second\n', {
      flag: 'a',
    })
    expect(await collectLogAuditEvents(file, state, now)).toMatchObject([
      { level: 'error', text: expect.stringContaining('second') },
    ])
  })
})
