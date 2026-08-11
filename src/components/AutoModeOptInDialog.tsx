import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Dialog, Link, Text } from '@anthropic/ink';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import { Select } from './CustomSelect/index.js';
import { zh } from '../utils/i18n.js';

// NOTE: This copy is legally reviewed — do not modify without Legal team approval.
export const AUTO_MODE_DESCRIPTION = zh(
  "Auto mode lets Claude handle permission prompts automatically — Claude checks each tool call for risky actions and prompt injection before executing. Safe choices are executed, while risky choices are blocked and Claude may try a different approach. Ideal for long-running tasks. Sessions are slightly more expensive. Claude can make mistakes that allow harmful commands to run, it's recommended to only use in isolated environments. Shift+Tab to change mode.",
  '自动模式让 Claude 自动处理权限提示——Claude 会在执行前检查每个工具调用的危险操作和提示注入。识别为安全的操作会直接执行，识别为危险的会被阻止，Claude 可能会尝试其他方法。适合长时间运行的任务，但会话成本略高。Claude 也可能犯错导致危险命令被执行，建议仅在隔离环境中使用。按 Shift+Tab 切换模式。',
);

type Props = {
  onAccept(): void;
  onDecline(): void;
  // Startup gate: decline exits the process, so relabel accordingly.
  declineExits?: boolean;
};

export function AutoModeOptInDialog({ onAccept, onDecline, declineExits }: Props): React.ReactNode {
  React.useEffect(() => {
    logEvent('tengu_auto_mode_opt_in_dialog_shown', {});
  }, []);

  function onChange(value: 'accept' | 'accept-default' | 'decline') {
    switch (value) {
      case 'accept': {
        logEvent('tengu_auto_mode_opt_in_dialog_accept', {});
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: true,
        });
        onAccept();
        break;
      }
      case 'accept-default': {
        logEvent('tengu_auto_mode_opt_in_dialog_accept_default', {});
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: true,
          permissions: { defaultMode: 'auto' },
        });
        onAccept();
        break;
      }
      case 'decline': {
        logEvent('tengu_auto_mode_opt_in_dialog_decline', {});
        onDecline();
        break;
      }
    }
  }

  return (
    <Dialog title={zh('Enable auto mode?', '启用自动模式？')} color="warning" onCancel={onDecline}>
      <Box flexDirection="column" gap={1}>
        <Text>{AUTO_MODE_DESCRIPTION}</Text>

        <Link url="https://code.claude.com/docs/en/security" />
      </Box>

      <Select
        options={[
          ...((process.env.USER_TYPE as string) !== 'ant'
            ? [
                {
                  label: zh('Yes, and make it my default mode', '好，并设为我的默认模式'),
                  value: 'accept-default' as const,
                },
              ]
            : []),
          { label: zh('Yes, enable auto mode', '好，启用自动模式'), value: 'accept' as const },
          {
            label: declineExits ? zh('No, exit', '不，退出') : zh('No, go back', '不，返回'),
            value: 'decline' as const,
          },
        ]}
        onChange={value => onChange(value as 'accept' | 'accept-default' | 'decline')}
        onCancel={onDecline}
      />
    </Dialog>
  );
}
