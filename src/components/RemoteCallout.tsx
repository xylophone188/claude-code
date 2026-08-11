import { zh } from '../utils/i18n.js';
import React, { useCallback, useEffect, useRef } from 'react';
import { isBridgeEnabled } from '../bridge/bridgeEnabled.js';
import { Box, Text } from '@anthropic/ink';
import { getClaudeAIOAuthTokens } from '../utils/auth.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import type { OptionWithDescription } from './CustomSelect/select.js';
import { Select } from './CustomSelect/select.js';
import { PermissionDialog } from './permissions/PermissionDialog.js';

type RemoteCalloutSelection = 'enable' | 'dismiss';

type Props = {
  onDone: (selection: RemoteCalloutSelection) => void;
};

export function RemoteCallout({ onDone }: Props): React.ReactNode {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const handleCancel = useCallback((): void => {
    onDoneRef.current('dismiss');
  }, []);

  // Permanently mark as seen on mount so it only shows once
  useEffect(() => {
    saveGlobalConfig(current => {
      if (current.remoteDialogSeen) return current;
      return { ...current, remoteDialogSeen: true };
    });
  }, []);

  const handleSelect = useCallback((value: RemoteCalloutSelection): void => {
    onDoneRef.current(value);
  }, []);

  const options: OptionWithDescription<RemoteCalloutSelection>[] = [
    {
      label: zh('Enable Remote Control for this session', '为本会话启用远程控制'),
      description: zh('Opens a secure connection to claude.ai.', '打开到 claude.ai 的安全连接。'),
      value: 'enable',
    },
    {
      label: zh('Never mind', '算了'),
      description: zh('You can always enable it later with /remote-control.', '以后随时可用 /remote-control 启用。'),
      value: 'dismiss',
    },
  ];

  return (
    <PermissionDialog title={zh('Remote Control', '远程控制')}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1} flexDirection="column">
          <Text>
            {zh(
              'Remote Control lets you access this CLI session from the web (claude.ai/code) or the Claude app, so you can pick up where you left off on any device.',
              '远程控制可让你从网页端 (claude.ai/code) 或 Claude 应用访问此 CLI 会话，随时在任何设备上接着干。',
            )}
          </Text>
          <Text> </Text>
          <Text>
            {zh(
              'You can disconnect remote access anytime by running /remote-control again.',
              '随时可再次运行 /remote-control 断开远程访问。',
            )}
          </Text>
        </Box>
        <Box>
          <Select options={options} onChange={handleSelect} onCancel={handleCancel} />
        </Box>
      </Box>
    </PermissionDialog>
  );
}

/**
 * Check whether to show the remote callout (first-time dialog).
 */
export function shouldShowRemoteCallout(): boolean {
  const config = getGlobalConfig();
  if (config.remoteDialogSeen) return false;
  if (!isBridgeEnabled()) return false;
  const tokens = getClaudeAIOAuthTokens();
  if (!tokens?.accessToken) return false;
  return true;
}
