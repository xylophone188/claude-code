import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import {
  listProviders,
  resolveModel,
  pickComboModel,
  CCB_ROUTING_COMBOS,
  CCB_ROUTING_ALIASES,
} from '../services/routing/index.js'

/** Build a `/v1`-normalized base URL for display (mirrors switcher.ts). */
function normalizeBaseUrl(baseUrl: string): string {
  return /\/v1\/?$/.test(baseUrl)
    ? baseUrl
    : `${baseUrl.replace(/\/+$/, '')}/v1`
}

/** Resolve a `<spec>` (provider/model, bare provider, combo, or alias) and
 *  print the resulting OPENAI_BASE_URL + OPENAI_MODEL, mirroring routes the
 *  switcher would set for `/provider use ccb/<id>`. */
function describeResolved(spec: string): string {
  const resolved = resolveModel(spec)
  if (!resolved) {
    return `No ccbRouting provider, combo, or alias matches "${spec}".`
  }

  if ('combo' in resolved) {
    const c = resolved.combo
    return [
      `combo: ${c.name} (strategy=${c.strategy})`,
      `models: ${c.models.join(', ')}`,
      `first pick (attempt 0): ${pickComboModel(c, 0) ?? '<none>'}`,
    ].join('\n')
  }

  const p = resolved.provider
  return [
    `provider: ${p.id}`,
    `OPENAI_BASE_URL=${normalizeBaseUrl(p.baseUrl)}`,
    `OPENAI_MODEL=${resolved.model || '<none>'}`,
    `apiKeyEnv=${p.apiKeyEnv ?? 'OPENAI_API_KEY'}`,
  ].join('\n')
}

const call: LocalCommandCall = async (args, _context) => {
  const arg = args.trim()

  if (arg === '-p' || arg.startsWith('-p ')) {
    const task = arg.slice(2).trim()
    if (!task) {
      return { type: 'text', value: '用法：/ccb -p <任务>' }
    }
    if (!_context.canUseTool) {
      return { type: 'text', value: '当前会话不能启动后台 Workflow。' }
    }
    const { getWorkflowService } = await import('../workflow/service.js')
    const { runId } = await getWorkflowService().launch(
      {
        mode: 'advisor',
        args: { task },
        title: 'advisor',
        description: '顾问流水线',
      },
      _context,
      _context.canUseTool,
    )
    return {
      type: 'text',
      value: `顾问流水线已后台启动：${runId}\n用 /workflows 查看方案、执行、复核与验收。`,
    }
  }

  if (!arg) {
    _context.setAppState(state => ({
      ...state,
      mainLoopModel: 'advisor',
      mainLoopModelForSession: null,
    }))
    return {
      type: 'text',
      value: '顾问模式已启用。使用 CCB 本地 Codex 账号池。',
    }
  }

  if (arg === '--list') {
    const ids = listProviders().map(p => p.id)
    const combos = CCB_ROUTING_COMBOS.map(c => `${c.name} (${c.strategy})`)
    const aliases = CCB_ROUTING_ALIASES.map(a => `${a.alias} -> ${a.target}`)
    const lines = [
      `ccbRouting providers (${ids.length}):`,
      ...ids.map(id => `  - ${id}`),
      ``,
      `combos (${combos.length}):`,
      ...combos.map(c => `  - ${c}`),
      ``,
      `aliases (${aliases.length}):`,
      ...aliases.map(a => `  - ${a}`),
    ]
    return { type: 'text', value: lines.join('\n') }
  }

  return { type: 'text', value: describeResolved(arg) }
}

const router = {
  type: 'local',
  name: 'router',
  description:
    'Inspect CCB routes, or run /ccb -p <task> through advisor plan/review + auto execution',
  aliases: ['ccb'],
  argumentHint: '[-p <task>|--list|<provider/model|combo|alias>]',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default router
