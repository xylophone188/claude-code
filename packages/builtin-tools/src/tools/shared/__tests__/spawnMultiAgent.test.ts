import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnTeammate } from '../spawnMultiAgent'

let tempHome: string
let previousConfigDir: string | undefined

beforeEach(() => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  tempHome = join(
    tmpdir(),
    `spawn-multi-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

describe('spawnTeammate', () => {
  test('fails before spawn side effects when the team file is missing', async () => {
    let setAppStateCalled = false
    const context = {
      getAppState: () => ({
        teamContext: undefined,
      }),
      setAppState: () => {
        setAppStateCalled = true
      },
      options: {
        agentDefinitions: {
          activeAgents: [],
        },
      },
    }

    await expect(
      spawnTeammate(
        {
          name: 'worker',
          prompt: 'do work',
          team_name: 'missing-team',
        },
        context as any,
      ),
    ).rejects.toThrow('Team "missing-team" does not exist')
    expect(setAppStateCalled).toBe(false)
  })

  test('bootstraps default team config when ~/.claude/teams/default exists without config.json', async () => {
    const defaultTeamDir = join(tempHome, 'teams', 'default')
    mkdirSync(defaultTeamDir, { recursive: true })
    const configPath = join(defaultTeamDir, 'config.json')
    expect(existsSync(configPath)).toBe(false)

    let currentAppState: any = {
      teamContext: undefined,
      tasks: {},
      inbox: { messages: [] },
      mainLoopModel: 'claude-3-5-sonnet',
    }
    const context = {
      getAppState: () => currentAppState,
      setAppState: (updater: any) => {
        currentAppState = updater(currentAppState)
      },
      options: {
        agentDefinitions: {
          activeAgents: [],
        },
      },
    }

    const res = await spawnTeammate(
      {
        name: 'worker',
        prompt: 'run tests',
        team_name: 'default',
      },
      context as any,
    )

    expect(res.data.agent_id).toBe('worker@default')
    expect(existsSync(configPath)).toBe(true)
    expect(currentAppState?.teamContext?.teamName).toBe('default')
  })
})
