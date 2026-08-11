/**
 * Provider universe — static catalog of known inference providers.
 *
 * Mirrors hermes-agent's PROVIDER_REGISTRY
 * (hermes-agent/hermes_cli/auth.py, "Provider Registry" section): same
 * ids, names, inference base URLs and env vars. Used by the /model
 * add-provider flow so a provider can be registered even when CCB
 * has no model for it yet.
 *
 * `authType`:
 * - "api_key" — needs an API key (env var listed in `envKeys`), user enters it
 * - "oauth_device_code" / "oauth_external" / "oauth_minimax" — needs a login
 *   flow, not a plain key; no env key applies
 */

export type ProviderAuthType =
  | 'api_key'
  | 'oauth_device_code'
  | 'oauth_external'
  | 'oauth_minimax'
  | 'external_process'

export interface ProviderUniverseEntry {
  id: string
  name: string
  authType: ProviderAuthType
  baseUrl: string
  envKeys: readonly string[]
  baseUrlEnvVar?: string
}

export const PROVIDER_UNIVERSE: readonly ProviderUniverseEntry[] = [
  {
    id: 'nous',
    name: 'Nous Portal',
    authType: 'oauth_device_code',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    envKeys: [],
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    authType: 'oauth_external',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    envKeys: [],
  },
  {
    id: 'openai-api',
    name: 'OpenAI API',
    authType: 'api_key',
    baseUrl: 'https://api.openai.com/v1',
    envKeys: ['OPENAI_API_KEY'],
    baseUrlEnvVar: 'OPENAI_BASE_URL',
  },
  {
    id: 'xai-oauth',
    name: 'xAI Grok OAuth (SuperGrok / Premium+)',
    authType: 'oauth_external',
    baseUrl: 'https://api.x.ai/v1',
    envKeys: [],
  },
  {
    id: 'qwen-oauth',
    name: 'Qwen OAuth',
    authType: 'oauth_external',
    baseUrl: 'https://portal.qwen.ai/v1',
    envKeys: [],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    authType: 'api_key',
    baseUrl: 'http://127.0.0.1:1234/v1',
    envKeys: ['LM_API_KEY'],
    baseUrlEnvVar: 'LM_BASE_URL',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    authType: 'api_key',
    baseUrl: 'https://api.githubcopilot.com',
    envKeys: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    baseUrlEnvVar: 'COPILOT_API_BASE_URL',
  },
  {
    id: 'copilot-acp',
    name: 'GitHub Copilot ACP',
    authType: 'external_process',
    baseUrl: 'acp://copilot',
    envKeys: [],
    baseUrlEnvVar: 'COPILOT_ACP_BASE_URL',
  },
  {
    id: 'gemini',
    name: 'Google AI Studio',
    authType: 'api_key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    envKeys: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    baseUrlEnvVar: 'GEMINI_BASE_URL',
  },
  {
    id: 'zai',
    name: 'Z.AI / GLM',
    authType: 'api_key',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    envKeys: ['GLM_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY'],
    baseUrlEnvVar: 'GLM_BASE_URL',
  },
  {
    id: 'kimi-coding',
    name: 'Kimi / Moonshot',
    authType: 'api_key',
    baseUrl: 'https://api.moonshot.ai/v1',
    envKeys: ['KIMI_API_KEY', 'KIMI_CODING_API_KEY'],
    baseUrlEnvVar: 'KIMI_BASE_URL',
  },
  {
    id: 'kimi-coding-cn',
    name: 'Kimi / Moonshot (China)',
    authType: 'api_key',
    baseUrl: 'https://api.moonshot.cn/v1',
    envKeys: ['KIMI_CN_API_KEY'],
  },
  {
    id: 'stepfun',
    name: 'StepFun Step Plan',
    authType: 'api_key',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
    envKeys: ['STEPFUN_API_KEY'],
    baseUrlEnvVar: 'STEPFUN_BASE_URL',
  },
  {
    id: 'arcee',
    name: 'Arcee AI',
    authType: 'api_key',
    baseUrl: 'https://api.arcee.ai/api/v1',
    envKeys: ['ARCEEAI_API_KEY'],
    baseUrlEnvVar: 'ARCEE_BASE_URL',
  },
  {
    id: 'gmi',
    name: 'GMI Cloud',
    authType: 'api_key',
    baseUrl: 'https://api.gmi-serving.com/v1',
    envKeys: ['GMI_API_KEY'],
    baseUrlEnvVar: 'GMI_BASE_URL',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    authType: 'api_key',
    baseUrl: 'https://api.minimax.io/anthropic',
    envKeys: ['MINIMAX_API_KEY'],
    baseUrlEnvVar: 'MINIMAX_BASE_URL',
  },
  {
    id: 'minimax-oauth',
    name: 'MiniMax (OAuth · minimax.io)',
    authType: 'oauth_minimax',
    baseUrl: 'https://api.minimax.io/anthropic',
    envKeys: [],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    authType: 'api_key',
    baseUrl: 'https://api.anthropic.com',
    envKeys: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ],
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
  },
  {
    id: 'alibaba',
    name: 'Qwen Cloud',
    authType: 'api_key',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    envKeys: ['DASHSCOPE_API_KEY'],
    baseUrlEnvVar: 'DASHSCOPE_BASE_URL',
  },
  {
    id: 'alibaba-coding-plan',
    name: 'Alibaba Cloud (Coding Plan)',
    authType: 'api_key',
    baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
    envKeys: ['ALIBABA_CODING_PLAN_API_KEY', 'DASHSCOPE_API_KEY'],
    baseUrlEnvVar: 'ALIBABA_CODING_PLAN_BASE_URL',
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax (China)',
    authType: 'api_key',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    envKeys: ['MINIMAX_CN_API_KEY'],
    baseUrlEnvVar: 'MINIMAX_CN_BASE_URL',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    authType: 'api_key',
    baseUrl: 'https://api.deepseek.com/v1',
    envKeys: ['DEEPSEEK_API_KEY'],
    baseUrlEnvVar: 'DEEPSEEK_BASE_URL',
  },
  {
    id: 'xai',
    name: 'xAI',
    authType: 'api_key',
    baseUrl: 'https://api.x.ai/v1',
    envKeys: ['XAI_API_KEY'],
    baseUrlEnvVar: 'XAI_BASE_URL',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    authType: 'api_key',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envKeys: ['NVIDIA_API_KEY'],
    baseUrlEnvVar: 'NVIDIA_BASE_URL',
  },
  {
    id: 'ai-gateway',
    name: 'Vercel AI Gateway',
    authType: 'api_key',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    envKeys: ['AI_GATEWAY_API_KEY'],
    baseUrlEnvVar: 'AI_GATEWAY_BASE_URL',
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    authType: 'api_key',
    baseUrl: 'https://opencode.ai/zen/v1',
    envKeys: ['OPENCODE_ZEN_API_KEY'],
    baseUrlEnvVar: 'OPENCODE_ZEN_BASE_URL',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    authType: 'api_key',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    envKeys: ['OPENCODE_GO_API_KEY'],
    baseUrlEnvVar: 'OPENCODE_GO_BASE_URL',
  },
  {
    id: 'kilocode',
    name: 'Kilo Code',
    authType: 'api_key',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    envKeys: ['KILOCODE_API_KEY'],
    baseUrlEnvVar: 'KILOCODE_BASE_URL',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    authType: 'api_key',
    baseUrl: 'https://router.huggingface.co/v1',
    envKeys: ['HF_TOKEN'],
    baseUrlEnvVar: 'HF_BASE_URL',
  },
  {
    id: 'xiaomi',
    name: 'Xiaomi MiMo',
    authType: 'api_key',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    envKeys: ['XIAOMI_API_KEY'],
    baseUrlEnvVar: 'XIAOMI_BASE_URL',
  },
]

export function getUniverseEntry(
  id: string,
): ProviderUniverseEntry | undefined {
  return PROVIDER_UNIVERSE.find(p => p.id === id)
}
