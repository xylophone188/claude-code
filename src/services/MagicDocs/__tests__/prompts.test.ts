import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMagicDocsUpdatePrompt } from '../prompts.js'

let configDirectory: string
let previousConfigDirectory: string | undefined

function modelContext(model: string, effort: string) {
  return { getModel: () => model, getEffort: () => effort }
}

beforeEach(async () => {
  configDirectory = await mkdtemp(join(tmpdir(), 'magic-docs-prompt-'))
  previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDirectory
})

afterEach(async () => {
  if (previousConfigDirectory === undefined)
    delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory
  await rm(configDirectory, { recursive: true, force: true })
})

async function buildWithTemplate(
  template: string,
  ...args: Parameters<typeof buildMagicDocsUpdatePrompt>
): Promise<string> {
  await mkdir(join(configDirectory, 'magic-docs'), { recursive: true })
  await writeFile(join(configDirectory, 'magic-docs', 'prompt.md'), template)
  return buildMagicDocsUpdatePrompt(...args)
}

describe('buildMagicDocsUpdatePrompt – dynamic variable substitution', () => {
  test('substitutes {{CLAUDE_MODEL}} with the provided model', async () => {
    const result = await buildWithTemplate(
      'Model: {{CLAUDE_MODEL}}',
      'contents',
      '/doc.md',
      'Title',
      undefined,
      modelContext('claude-opus-4-7', 'high'),
    )
    expect(result).toContain('Model: claude-opus-4-7')
    expect(result).not.toContain('{{CLAUDE_MODEL}}')
  })

  test('substitutes {{CLAUDE_EFFORT}} with the provided effort level', async () => {
    const result = await buildWithTemplate(
      'Effort: {{CLAUDE_EFFORT}}',
      'contents',
      '/doc.md',
      'Title',
      undefined,
      modelContext('claude-opus-4-7', 'high'),
    )
    expect(result).toContain('Effort: high')
    expect(result).not.toContain('{{CLAUDE_EFFORT}}')
  })

  test('substitutes {{CLAUDE_CWD}} with process.cwd()', async () => {
    const result = await buildWithTemplate(
      'CWD: {{CLAUDE_CWD}}',
      'contents',
      '/doc.md',
      'Title',
      undefined,
      modelContext('claude-opus-4-7', 'high'),
    )
    expect(result).toContain(`CWD: ${process.cwd()}`)
    expect(result).not.toContain('{{CLAUDE_CWD}}')
  })

  test('substitutes all three dynamic variables in one template', async () => {
    const result = await buildWithTemplate(
      'effort={{CLAUDE_EFFORT}} model={{CLAUDE_MODEL}} cwd={{CLAUDE_CWD}}',
      'contents',
      '/doc.md',
      'Title',
      undefined,
      modelContext('claude-sonnet-4-6', 'medium'),
    )
    expect(result).toContain('effort=medium')
    expect(result).toContain('model=claude-sonnet-4-6')
    expect(result).toContain(`cwd=${process.cwd()}`)
  })

  test('leaves unknown template variables unchanged', async () => {
    const result = await buildWithTemplate(
      '{{UNKNOWN_VAR}} {{CLAUDE_MODEL}}',
      'contents',
      '/doc.md',
      'Title',
      undefined,
      modelContext('claude-opus-4-7', 'high'),
    )
    expect(result).toContain('{{UNKNOWN_VAR}}')
    expect(result).toContain('claude-opus-4-7')
  })

  test('existing substitution variables still work alongside new ones', async () => {
    const result = await buildWithTemplate(
      '{{docTitle}} effort={{CLAUDE_EFFORT}} model={{CLAUDE_MODEL}}',
      'contents',
      '/doc.md',
      'My Doc',
      undefined,
      modelContext('claude-haiku', 'low'),
    )
    expect(result).toContain('My Doc')
    expect(result).toContain('effort=low')
    expect(result).toContain('model=claude-haiku')
  })
})
