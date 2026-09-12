import { describe, expect, test } from 'bun:test'
import { EnterPlanModeTool } from '../EnterPlanModeTool.js'

// EnterPlanMode relies on the buildTool default checkPermissions (allow) —
// plan entry never prompts in ANY mode, so unattended flows can't get stuck
// at an entry dialog. The real approval gate is ExitPlanMode.
describe('EnterPlanModeTool permission contract', () => {
  test('returns allow in bypassPermissions mode (no entry dialog)', async () => {
    const context = {
      getAppState: () => ({
        toolPermissionContext: { mode: 'bypassPermissions' },
      }),
    } as any
    const result = await EnterPlanModeTool.checkPermissions({}, context)
    expect(result.behavior).toBe('allow')
  })

  test('returns allow in default mode (no entry dialog)', async () => {
    const context = {
      getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    } as any
    const result = await EnterPlanModeTool.checkPermissions({}, context)
    expect(result.behavior).toBe('allow')
  })

  test('returns allow in plan mode', async () => {
    const context = {
      getAppState: () => ({ toolPermissionContext: { mode: 'plan' } }),
    } as any
    const result = await EnterPlanModeTool.checkPermissions({}, context)
    expect(result.behavior).toBe('allow')
  })
})
