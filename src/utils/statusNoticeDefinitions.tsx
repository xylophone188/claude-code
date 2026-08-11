// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { Box, Text } from '@anthropic/ink';
import { zh } from './i18n.js';
import * as React from 'react';
import { getLargeMemoryFiles, MAX_MEMORY_CHARACTER_COUNT, type MemoryFileInfo } from './claudemd.js';
import figures from 'figures';
import { getCwd } from './cwd.js';
import { relative } from 'path';
import { formatNumber } from './format.js';
import type { getGlobalConfig } from './config.js';
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromConfigOrMacOSKeychain,
  getAuthTokenSource,
  isClaudeAISubscriber,
} from './auth.js';
import type { AgentDefinitionsResult } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js';
import { getAgentDescriptionsTotalTokens, AGENT_DESCRIPTIONS_THRESHOLD } from './statusNoticeHelpers.js';
import { isSupportedJetBrainsTerminal, toIDEDisplayName, getTerminalIdeType } from './ide.js';
import { isJetBrainsPluginInstalledCachedSync } from './jetbrains.js';
import { isTermuxRuntime, getRemoteCompressionUrl } from '../services/context/runtime.js';

// Types
export type StatusNoticeType = 'warning' | 'info';

export type StatusNoticeContext = {
  config: ReturnType<typeof getGlobalConfig>;
  agentDefinitions?: AgentDefinitionsResult;
  memoryFiles: MemoryFileInfo[];
};

export type StatusNoticeDefinition = {
  id: string;
  type: StatusNoticeType;
  isActive: (context: StatusNoticeContext) => boolean;
  render: (context: StatusNoticeContext) => React.ReactNode;
};

// Individual notice definitions
const largeMemoryFilesNotice: StatusNoticeDefinition = {
  id: 'large-memory-files',
  type: 'warning',
  isActive: ctx => getLargeMemoryFiles(ctx.memoryFiles).length > 0,
  render: ctx => {
    const largeMemoryFiles = getLargeMemoryFiles(ctx.memoryFiles);
    return (
      <>
        {largeMemoryFiles.map(file => {
          const displayPath = file.path.startsWith(getCwd()) ? relative(getCwd(), file.path) : file.path;

          return (
            <Box key={file.path} flexDirection="row">
              <Text color="warning">{figures.warning}</Text>
              <Text color="warning">
                {zh('Large', '大文件')} <Text bold>{displayPath}</Text> {zh('will impact performance', '将影响性能')} (
                {formatNumber(file.content.length)} chars &gt; {formatNumber(MAX_MEMORY_CHARACTER_COUNT)})
                <Text dimColor> · /memory {zh('to edit', '编辑')}</Text>
              </Text>
            </Box>
          );
        })}
      </>
    );
  },
};

const claudeAiSubscriberExternalTokenNotice: StatusNoticeDefinition = {
  id: 'claude-ai-external-token',
  type: 'warning',
  isActive: () => {
    const authTokenInfo = getAuthTokenSource();
    return (
      isClaudeAISubscriber() &&
      (authTokenInfo.source === 'ANTHROPIC_AUTH_TOKEN' || authTokenInfo.source === 'apiKeyHelper')
    );
  },
  render: () => {
    const authTokenInfo = getAuthTokenSource();
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color="warning">{figures.warning}</Text>
        <Text color="warning">
          Auth conflict: Using {authTokenInfo.source} instead of Claude account subscription token. Either unset{' '}
          {authTokenInfo.source}, or run `claude /logout`.
        </Text>
      </Box>
    );
  },
};

const apiKeyConflictNotice: StatusNoticeDefinition = {
  id: 'api-key-conflict',
  type: 'warning',
  isActive: () => {
    const { source: apiKeySource } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    });
    return (
      !!getApiKeyFromConfigOrMacOSKeychain() &&
      (apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'apiKeyHelper')
    );
  },
  render: () => {
    const { source: apiKeySource } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    });
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color="warning">{figures.warning}</Text>
        <Text color="warning">
          Auth conflict: Using {apiKeySource} instead of Anthropic Console key. Either unset {apiKeySource}, or run
          `claude /logout`.
        </Text>
      </Box>
    );
  },
};

const bothAuthMethodsNotice: StatusNoticeDefinition = {
  id: 'both-auth-methods',
  type: 'warning',
  isActive: () => {
    const { source: apiKeySource } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    });
    const authTokenInfo = getAuthTokenSource();
    return (
      apiKeySource !== 'none' &&
      authTokenInfo.source !== 'none' &&
      !(apiKeySource === 'apiKeyHelper' && authTokenInfo.source === 'apiKeyHelper')
    );
  },
  render: () => {
    const { source: apiKeySource } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    });
    const authTokenInfo = getAuthTokenSource();
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color="warning">{figures.warning}</Text>
          <Text color="warning">
            {zh(
              'Auth conflict: Both a token ({authTokenInfo.source}) and an API key ({apiKeySource}) are set. This may lead to unexpected behavior.',
              '认证冲突：同时设置了令牌 ({authTokenInfo.source}) 和 API 密钥 ({apiKeySource})，可能导致意外行为。',
            )}
          </Text>
        </Box>
        <Box flexDirection="column" marginLeft={3}>
          <Text color="warning">
            · {zh('Trying to use', '想使用')}{' '}
            {authTokenInfo.source === 'claude.ai' ? 'claude.ai' : authTokenInfo.source}?{' '}
            {apiKeySource === 'ANTHROPIC_API_KEY'
              ? zh(
                  'Unset the ANTHROPIC_API_KEY environment variable, or claude /logout then say "No" to the API key approval before login.',
                  '请取消 ANTHROPIC_API_KEY 环境变量，或运行 claude /logout，并在登录前对 API 密钥确认选择“否”。',
                )
              : apiKeySource === 'apiKeyHelper'
                ? zh('Unset the apiKeyHelper setting.', '请取消 apiKeyHelper 设置。')
                : 'claude /logout'}
          </Text>
          <Text color="warning">
            · {zh('Trying to use', '想使用')} {apiKeySource}?{' '}
            {authTokenInfo.source === 'claude.ai'
              ? zh('claude /logout to sign out of claude.ai.', '运行 claude /logout 退出 claude.ai 登录。')
              : zh(
                  `Unset the ${authTokenInfo.source} environment variable.`,
                  `请取消环境变量 ${authTokenInfo.source}。`,
                )}
          </Text>
        </Box>
      </Box>
    );
  },
};

const largeAgentDescriptionsNotice: StatusNoticeDefinition = {
  id: 'large-agent-descriptions',
  type: 'warning',
  isActive: context => {
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions);
    return totalTokens > AGENT_DESCRIPTIONS_THRESHOLD;
  },
  render: context => {
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions);
    return (
      <Box flexDirection="row">
        <Text color="warning">{figures.warning}</Text>
        <Text color="warning">
          {zh('Large cumulative agent descriptions will impact performance', '累计的 agent 描述过大将影响性能')} (~
          {formatNumber(totalTokens)} tokens &gt; {formatNumber(AGENT_DESCRIPTIONS_THRESHOLD)})
          <Text dimColor> · /agents {zh('to manage', '管理')}</Text>
        </Text>
      </Box>
    );
  },
};

const jetbrainsPluginNotice: StatusNoticeDefinition = {
  id: 'jetbrains-plugin-install',
  type: 'info',
  isActive: context => {
    // Only show if running in JetBrains built-in terminal
    if (!isSupportedJetBrainsTerminal()) {
      return false;
    }
    // Don't show if auto-install is disabled
    const shouldAutoInstall = context.config.autoInstallIdeExtension ?? true;
    if (!shouldAutoInstall) {
      return false;
    }
    // Check if plugin is already installed (cached to avoid repeated filesystem checks)
    const ideType = getTerminalIdeType();
    return ideType !== null && !isJetBrainsPluginInstalledCachedSync(ideType);
  },
  render: () => {
    const ideType = getTerminalIdeType();
    const ideName = toIDEDisplayName(ideType);
    return (
      <Box flexDirection="row" gap={1} marginLeft={1}>
        <Text color="ide">{figures.arrowUp}</Text>
        <Text>
          {zh('Install the', '从 JetBrains Marketplace 安装')} <Text color="ide">{ideName}</Text>{' '}
          {zh('plugin from the JetBrains Marketplace:', '插件：')}{' '}
          <Text bold>https://docs.claude.com/s/claude-code-jetbrains</Text>
        </Text>
      </Box>
    );
  },
};

const termuxCompressionNotice: StatusNoticeDefinition = {
  id: 'termux-compression',
  type: 'info',
  isActive: () => isTermuxRuntime() && !getRemoteCompressionUrl(),
  render: () => (
    <Box flexDirection="row" marginTop={1}>
      <Text color="suggestion">{figures.info}</Text>
      <Text>
        {zh(
          'Termux uses local context compression. Set contextCompressionRemoteUrl in config.json for a remote compressor.',
          '当前为 Termux，默认使用本地上下文压缩；可在 config.json 设置 contextCompressionRemoteUrl 使用远程压缩。',
        )}
      </Text>
    </Box>
  ),
};

// All notice definitions
export const statusNoticeDefinitions: StatusNoticeDefinition[] = [
  largeMemoryFilesNotice,
  largeAgentDescriptionsNotice,
  claudeAiSubscriberExternalTokenNotice,
  apiKeyConflictNotice,
  bothAuthMethodsNotice,
  jetbrainsPluginNotice,
  termuxCompressionNotice,
];

// Helper functions for external use
export function getActiveNotices(context: StatusNoticeContext): StatusNoticeDefinition[] {
  return statusNoticeDefinitions.filter(notice => notice.isActive(context));
}
