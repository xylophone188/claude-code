import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { formatTokens } from '../utils/format.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from '@anthropic/ink';
import { zh } from '../utils/i18n.js';

type IdleReturnAction = 'continue' | 'clear' | 'dismiss' | 'never';

type Props = {
  idleMinutes: number;
  totalInputTokens: number;
  onDone: (action: IdleReturnAction) => void;
};

export function IdleReturnDialog({ idleMinutes, totalInputTokens, onDone }: Props): React.ReactNode {
  const formattedIdle = formatIdleDuration(idleMinutes);
  const formattedTokens = formatTokens(totalInputTokens);

  return (
    <Dialog
      title={zh(
        `You've been away ${formattedIdle} and this conversation is ${formattedTokens} tokens.`,
        `你已离开 ${formattedIdle}，当前对话占用 ${formattedTokens} tokens。`,
      )}
      onCancel={() => onDone('dismiss')}
    >
      <Box flexDirection="column">
        <Text>
          {zh(
            'If this is a new task, clearing context will save usage and be faster.',
            '如果是新任务，清空上下文可节省用量并更快。',
          )}
        </Text>
      </Box>
      <Select
        options={[
          {
            value: 'continue' as const,
            label: zh('Continue this conversation', '继续此对话'),
          },
          {
            value: 'clear' as const,
            label: zh('Send message as a new conversation', '作为新对话发送消息'),
          },
          {
            value: 'never' as const,
            label: zh("Don't ask me again", '不再次询问'),
          },
        ]}
        onChange={(value: IdleReturnAction) => onDone(value)}
      />
    </Dialog>
  );
}

function formatIdleDuration(minutes: number): string {
  if (minutes < 1) {
    return '< 1m';
  }
  if (minutes < 60) {
    return `${Math.floor(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.floor(minutes % 60);
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remainingMinutes}m`;
}
