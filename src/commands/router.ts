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

  const importCodex = arg.match(/^import-codex(?:\s+(.*))?$/)
  if (importCodex) {
    const paths = importCodex[1]?.trim().split(/\s+/).filter(Boolean) ?? []
    if (paths.length === 0) {
      return { type: 'text', value: '用法：/ccb import-codex <auth.json...>' }
    }
    try {
      const { importChatGPTAuthFiles } = await import(
        '../services/api/openai/chatgptAuth.js'
      )
      const imported = await importChatGPTAuthFiles(paths)
      return { type: 'text', value: `已导入 ${imported} 个 Codex 账号。` }
    } catch (e) {
      return {
        type: 'text',
        value: `导入 Codex 账号失败：${(e as Error).message}`,
      }
    }
  }

  const importOmniRoute = arg.match(/^import-omniroute\s+(.+)$/)
  if (importOmniRoute) {
    const databasePath = importOmniRoute[1]!.trim()
    try {
      const { importChatGPTAuthFromOmniRoute } = await import(
        '../services/api/openai/chatgptAuth.js'
      )
      const imported = await importChatGPTAuthFromOmniRoute(databasePath)
      return {
        type: 'text',
        value: `已从 OmniRoute 导入 ${imported} 个 Codex 账号。`,
      }
    } catch (e) {
      return {
        type: 'text',
        value: `导入 OmniRoute Codex 账号失败：${(e as Error).message}`,
      }
    }
  }
  if (arg === 'import-omniroute') {
    return {
      type: 'text',
      value: '用法：/ccb import-omniroute <storage.sqlite>',
    }
  }

  const import9Router = arg.match(/^import-9router\s+(.+)$/)
  if (import9Router) {
    const databasePath = import9Router[1]!.trim()
    try {
      const { importCodeBuddyCnFrom9Router } = await import(
        '../services/api/openai/codebuddyCnAuth.js'
      )
      const imported = await importCodeBuddyCnFrom9Router(databasePath)
      return {
        type: 'text',
        value: `已从 9router 导入 ${imported} 个 CodeBuddy CN 账号（ADD-only，不改动上游）。`,
      }
    } catch (e) {
      return {
        type: 'text',
        value: `导入 9router CodeBuddy CN 账号失败：${(e as Error).message}`,
      }
    }
  }
  if (arg === 'import-9router') {
    return {
      type: 'text',
      value: '用法：/ccb import-9router <storage.sqlite>',
    }
  }

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
    'Inspect CCB routes, import Codex/OmniRoute/9router auth, or run /ccb -p <task> through advisor plan/review + auto execution',
  aliases: ['ccb'],
  argumentHint:
    '[import-codex <auth.json...>|import-omniroute <storage.sqlite>|import-9router <storage.sqlite>|-p <task>|--list|<provider/model|combo|alias>]',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default router
