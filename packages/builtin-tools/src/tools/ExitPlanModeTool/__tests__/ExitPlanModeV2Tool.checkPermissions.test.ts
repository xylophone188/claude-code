import { describe, expect, test } from 'bun:test'
import { ExitPlanModeV2Tool } from '../ExitPlanModeV2Tool.js'

function makeContext(prePlanMode?: string) {
  return {
    getAppState() {
      return {
        toolPermissionContext: { prePlanMode },
      }
    },
  } as any
}

describe('ExitPlanModeV2Tool.checkPermissions', () => {
  test('returns allow when session started in bypassPermissions', async () => {
    const result = await ExitPlanModeV2Tool.checkPermissions(
      {},
      makeContext('bypassPermissions'),
    )
    expect(result.behavior).toBe('allow')
  })

  test('returns ask when prePlanMode is default', async () => {
    const result = await ExitPlanModeV2Tool.checkPermissions(
      {},
      makeContext('default'),
    )
    expect(result.behavior).toBe('ask')
  })

  test('returns ask when prePlanMode is undefined', async () => {
    const result = await ExitPlanModeV2Tool.checkPermissions({}, makeContext())
    expect(result.behavior).toBe('ask')
  })
})
