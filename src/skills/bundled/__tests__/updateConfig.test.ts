import { afterEach, describe, expect, test } from 'bun:test'
import type { PromptCommand } from '../../../types/command.js'
import { clearBundledSkills, getBundledSkills } from '../../bundledSkills.js'
import { registerUpdateConfigSkill } from '../updateConfig.js'

function asPrompt(command: { type: string }): PromptCommand {
  return command as unknown as PromptCommand
}

afterEach(() => {
  clearBundledSkills()
})

describe('registerUpdateConfigSkill', () => {
  test('generates robust JSON Schema without throwing on undefined unions', async () => {
    clearBundledSkills()
    registerUpdateConfigSkill()

    const skill = getBundledSkills().find(s => s.name === 'update-config')
    expect(skill).toBeDefined()

    const promptBlocks = await asPrompt(skill!).getPromptForCommand(
      '',
      {} as never,
    )
    expect(promptBlocks).toHaveLength(1)
    expect(promptBlocks[0]!.type).toBe('text')

    const text = (promptBlocks[0] as { type: 'text'; text: string }).text
    expect(text).toContain('## Full Settings JSON Schema')

    const match = text.match(
      /## Full Settings JSON Schema\n\n```json\n([\s\S]*?)\n```/,
    )
    expect(match).toBeTruthy()

    const parsedSchema = JSON.parse(match![1]!)
    expect(parsedSchema.type).toBe('object')
    expect(parsedSchema.properties).toBeDefined()
    expect(parsedSchema.properties.enabledPlugins).toBeDefined()
    expect(parsedSchema.properties.model).toBeDefined()
    expect(parsedSchema.properties.permissions).toBeDefined()

    // Ensure undefined is not leaked as an empty schema branch
    const enabledPlugins = parsedSchema.properties.enabledPlugins
    expect(enabledPlugins.additionalProperties).toBeDefined()
    expect(enabledPlugins.additionalProperties.anyOf).toEqual([
      {
        type: 'array',
        items: {
          type: 'string',
        },
      },
      {
        type: 'boolean',
      },
    ])
  })

  test('preserves [hooks-only] optimization path', async () => {
    clearBundledSkills()
    registerUpdateConfigSkill()

    const skill = getBundledSkills().find(s => s.name === 'update-config')
    const promptBlocks = await asPrompt(skill!).getPromptForCommand(
      '[hooks-only] test hook task',
      {} as never,
    )
    const text = (promptBlocks[0] as { type: 'text'; text: string }).text
    expect(text).toContain('## Hooks Configuration')
    expect(text).toContain('## Task')
    expect(text).toContain('test hook task')
    expect(text).not.toContain('## Full Settings JSON Schema')
  })
})
