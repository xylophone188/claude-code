import React from 'react';
import { Box, Dialog, Link, Text } from '@anthropic/ink';
import { Select } from './CustomSelect/index.js';
import { zh } from '../utils/i18n.js';

type Props = {
  onDone: () => void;
};

export function CostThresholdDialog({ onDone }: Props): React.ReactNode {
  return (
    <Dialog
      title={zh("You've spent $5 on the Anthropic API this session.", '本次会话你在 Anthropic API 上已花费 $5。')}
      onCancel={onDone}
    >
      <Box flexDirection="column">
        <Text>{zh('Learn more about how to monitor your spending:', '了解更多监控花费的方法：')}</Text>
        <Link url="https://code.claude.com/docs/en/costs" />
      </Box>
      <Select
        options={[
          {
            value: 'ok',
            label: zh('Got it, thanks!', '收到，谢谢！'),
          },
        ]}
        onChange={onDone}
      />
    </Dialog>
  );
}
