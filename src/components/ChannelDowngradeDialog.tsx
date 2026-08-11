import { zh } from '../utils/i18n.js';
import React from 'react';
import { Text } from '@anthropic/ink';
import { Select } from './CustomSelect/index.js';
import { Dialog } from '@anthropic/ink';

export type ChannelDowngradeChoice = 'downgrade' | 'stay' | 'cancel';

type Props = {
  currentVersion: string;
  onChoice: (choice: ChannelDowngradeChoice) => void;
};

/**
 * Dialog shown when switching from latest to stable channel.
 * Allows user to choose whether to downgrade or stay on current version.
 */
export function ChannelDowngradeDialog({ currentVersion, onChoice }: Props): React.ReactNode {
  function handleSelect(value: ChannelDowngradeChoice): void {
    onChoice(value);
  }

  function handleCancel(): void {
    onChoice('cancel');
  }

  return (
    <Dialog
      title={zh('Switch to Stable Channel', '切换到稳定版频道')}
      onCancel={handleCancel}
      color="permission"
      hideBorder
      hideInputGuide
    >
      <Text>
        {zh(
          'The stable channel may have an older version than what you are currently running ({currentVersion}).',
          '稳定版频道可能比你当前运行的版本 ({currentVersion}) 更旧。',
        )}
      </Text>
      <Text dimColor>{zh('How would you like to handle this?', '你想怎么处理？')}</Text>
      <Select
        options={[
          {
            label: zh('Allow possible downgrade to stable version', '允许降级到稳定版'),
            value: 'downgrade' as ChannelDowngradeChoice,
          },
          {
            label: zh(
              `Stay on current version (${currentVersion}) until stable catches up`,
              `保持当前版本 (${currentVersion})，直到稳定版追上`,
            ),
            value: 'stay' as ChannelDowngradeChoice,
          },
        ]}
        onChange={handleSelect}
      />
    </Dialog>
  );
}
