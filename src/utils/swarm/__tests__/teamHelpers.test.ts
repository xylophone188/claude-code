import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDefaultTeamFile,
  ensureDefaultTeamFile,
  ensureDefaultTeamFileAsync,
  getTeamDir,
  getTeamFilePath,
  isValidTeamFile,
  readTeamFile,
  readTeamFileAsync,
  writeTeamFileAsync,
  type TeamFile,
} from '../teamHelpers.js'

let tempHome: string
let previousConfigDir: string | undefined

beforeEach(() => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  tempHome = join(
    tmpdir(),
    `team-helpers-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  process.env.CLAUDE_CONFIG_DIR = tempHome
})

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('teamHelpers team validation and default bootstrap', () => {
  test('validates team file schema strictly', () => {
    const valid = createDefaultTeamFile('default', tempHome)
    expect(isValidTeamFile(valid)).toBe(true)

    expect(isValidTeamFile(null)).toBe(false)
    expect(isValidTeamFile({})).toBe(false)
    expect(isValidTeamFile({ name: 'default', members: 'not-an-array' })).toBe(
      false,
    )
    expect(
      isValidTeamFile({
        ...valid,
        members: [{ agentId: 'lead@default' }], // missing required fields
      }),
    ).toBe(false)
  })

  test('bootstraps default team when directory exists but config.json is missing', async () => {
    const defaultDir = getTeamDir('default')
    mkdirSync(defaultDir, { recursive: true })
    expect(existsSync(defaultDir)).toBe(true)
    expect(existsSync(getTeamFilePath('default'))).toBe(false)

    const bootstrapped = await ensureDefaultTeamFileAsync('default', tempHome)
    expect(bootstrapped.name).toBe('default')
    expect(bootstrapped.members).toHaveLength(1)
    expect(bootstrapped.members[0]!.name).toBe('team-lead')
    expect(existsSync(getTeamFilePath('default'))).toBe(true)

    const readBack = await readTeamFileAsync('default')
    expect(readBack).toEqual(bootstrapped)
  })

  test('recovers corrupt config.json for default team without throwing', async () => {
    const defaultDir = getTeamDir('default')
    mkdirSync(defaultDir, { recursive: true })
    writeFileSync(getTeamFilePath('default'), '{ corrupt json')

    expect(readTeamFile('default')).toBeNull()
    expect(await readTeamFileAsync('default')).toBeNull()

    const recovered = ensureDefaultTeamFile('default', tempHome)
    expect(recovered.name).toBe('default')
    expect(recovered.members).toHaveLength(1)

    const syncRead = readTeamFile('default')
    expect(syncRead).toEqual(recovered)
  })

  test('never overwrites a valid existing team', async () => {
    const customTeam: TeamFile = {
      name: 'default',
      description: 'Preserved user team',
      createdAt: 12345,
      leadAgentId: 'custom-lead@default',
      members: [
        {
          agentId: 'custom-lead@default',
          name: 'team-lead',
          agentType: 'architect',
          joinedAt: 12345,
          tmuxPaneId: '',
          cwd: tempHome,
          subscriptions: ['tasks'],
        },
      ],
    }

    await writeTeamFileAsync('default', customTeam)

    const ensured = await ensureDefaultTeamFileAsync(
      'default',
      '/different/path',
    )
    expect(ensured.description).toBe('Preserved user team')
    expect(ensured.createdAt).toBe(12345)
    expect(ensured.members[0]!.agentType).toBe('architect')

    const fileContent = JSON.parse(
      readFileSync(getTeamFilePath('default'), 'utf-8'),
    )
    expect(fileContent.description).toBe('Preserved user team')
  })

  test('performs atomic writes without lingering temporary files', async () => {
    const team = createDefaultTeamFile('prod', tempHome)
    await writeTeamFileAsync('prod', team)

    const teamDir = getTeamDir('prod')
    const files = readdirSyncSafe(teamDir)
    expect(files).toEqual(['config.json'])
  })
})

function readdirSyncSafe(dirPath: string): string[] {
  try {
    const { readdirSync } = require('node:fs')
    return readdirSync(dirPath)
  } catch {
    return []
  }
}
