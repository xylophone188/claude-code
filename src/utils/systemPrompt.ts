import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { isEnvTruthy } from './envUtils.js'
import { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'
export { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../proactive/index.js') as typeof import('../proactive/index.js'))
    : null

/**
 * Conditionally load the mode-instruction modules behind their feature flags.
 * Static imports would force the heavy command modules into every process
 * even when the feature is off; loading lazily keeps the default path lean.
 */
function getModeInstructions(): string | undefined {
  const parts: Array<string | undefined> = []
  if (feature('CAVEMAN')) {
    const { getCavemanInstructions } =
      require('../commands/caveman/cavemanMode.js') as typeof import('../commands/caveman/cavemanMode.js')
    parts.push(getCavemanInstructions())
  }
  if (feature('PONYTAIL')) {
    const { getPonytailInstructions } =
      require('../commands/ponytail/ponytailMode.js') as typeof import('../commands/ponytail/ponytailMode.js')
    parts.push(getPonytailInstructions())
  }
  if (feature('RTK')) {
    const { getRtkInstructions } =
      require('../commands/rtk/rtkMode.js') as typeof import('../commands/rtk/rtkMode.js')
    parts.push(getRtkInstructions())
  }
  const present = parts.filter((p): p is string => Boolean(p))
  return present.length ? present.join('\n\n') : undefined
}

function isProactiveActive_SAFE_TO_CALL_ANYWHERE(): boolean {
  return proactiveModule?.isProactiveActive() ?? false
}

export function buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,
  toolUseContext,
  customSystemPrompt,
  defaultSystemPrompt,
  appendSystemPrompt,
  overrideSystemPrompt,
}: {
  mainThreadAgentDefinition: AgentDefinition | undefined
  toolUseContext?: Pick<ToolUseContext, 'options'>
  customSystemPrompt: string | undefined
  defaultSystemPrompt: string[]
  appendSystemPrompt: string | undefined
  overrideSystemPrompt?: string | null
}): SystemPrompt {
  const advisorRoutingInstructions =
    toolUseContext?.options?.mainLoopModel?.trim().toLowerCase() ===
      'advisor' || process.env.CCB_FORCE_ADVISOR_WORKFLOW === '1'
      ? `# Advisor Routing

You are the decision-maker, not the worker. For a task requiring workspace changes, tests, investigation, or implementation, start the Workflow tool with mode="advisor" and args={"task":"<the user's complete task>"}. That workflow runs in the background: advisor-model subagents create the plan, review results, and accept or request one bounded revision; auto-routed subagents do execution. Do not perform the worker task yourself. For a question that needs only judgment or explanation, answer directly.`
      : undefined

  const modeInstructions = getModeInstructions()

  if (overrideSystemPrompt) {
    return asSystemPrompt([
      overrideSystemPrompt,
      ...(advisorRoutingInstructions ? [advisorRoutingInstructions] : []),
      ...(modeInstructions ? [modeInstructions] : []),
    ])
  }

  if (
    feature('COORDINATOR_MODE') &&
    isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) &&
    !mainThreadAgentDefinition
  ) {
    const { getCoordinatorSystemPrompt } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js')
    return asSystemPrompt([
      getCoordinatorSystemPrompt(),
      ...(advisorRoutingInstructions ? [advisorRoutingInstructions] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
      ...(modeInstructions ? [modeInstructions] : []),
    ])
  }

  const agentSystemPrompt = mainThreadAgentDefinition
    ? isBuiltInAgent(mainThreadAgentDefinition)
      ? mainThreadAgentDefinition.getSystemPrompt({
          toolUseContext: { options: toolUseContext!.options },
        })
      : mainThreadAgentDefinition.getSystemPrompt()
    : undefined

  if (mainThreadAgentDefinition?.memory) {
    logEvent('tengu_agent_memory_loaded', {
      ...(process.env.USER_TYPE === 'ant' && {
        agent_type:
          mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      scope:
        mainThreadAgentDefinition.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source:
        'main-thread' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  if (
    agentSystemPrompt &&
    (feature('PROACTIVE') || feature('KAIROS')) &&
    isProactiveActive_SAFE_TO_CALL_ANYWHERE()
  ) {
    return asSystemPrompt([
      ...defaultSystemPrompt,
      `\n# Custom Agent Instructions\n${agentSystemPrompt}`,
      ...(advisorRoutingInstructions ? [advisorRoutingInstructions] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
      ...(modeInstructions ? [modeInstructions] : []),
    ])
  }

  return asSystemPrompt([
    ...(agentSystemPrompt
      ? [agentSystemPrompt]
      : customSystemPrompt
        ? [customSystemPrompt]
        : defaultSystemPrompt),
    ...(advisorRoutingInstructions ? [advisorRoutingInstructions] : []),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ...(modeInstructions ? [modeInstructions] : []),
  ])
}
