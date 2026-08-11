import React, { useCallback } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Link, Newline, Text } from '@anthropic/ink';
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from '@anthropic/ink';
import { zh } from '../utils/i18n.js';

type Props = {
  onAccept(): void;
};

export function BypassPermissionsModeDialog({ onAccept }: Props): React.ReactNode {
  const [pendingExitCode, setPendingExitCode] = React.useState<number | null>(null);

  // Clear screen before shutdown so residual dialog content doesn't leak
  // to the terminal. Deferred to next tick so Ink flushes the null render.
  React.useEffect(() => {
    if (pendingExitCode !== null) {
      const code = pendingExitCode;
      const timer = setTimeout(() => gracefulShutdownSync(code));
      return () => clearTimeout(timer);
    }
  }, [pendingExitCode]);

  React.useEffect(() => {
    logEvent('tengu_bypass_permissions_mode_dialog_shown', {});
  }, []);

  function onChange(value: 'accept' | 'decline') {
    switch (value) {
      case 'accept': {
        logEvent('tengu_bypass_permissions_mode_dialog_accept', {});

        updateSettingsForSource('userSettings', {
          skipDangerousModePermissionPrompt: true,
        });
        onAccept();
        break;
      }
      case 'decline': {
        setPendingExitCode(1);
        break;
      }
    }
  }

  const handleEscape = useCallback(() => {
    setPendingExitCode(0);
  }, []);

  if (pendingExitCode !== null) {
    return null;
  }

  return (
    <Dialog
      title={zh('WARNING: Claude Code running in Bypass Permissions mode', '警告：Claude Code 正在以绕过权限模式运行')}
      color="error"
      onCancel={handleEscape}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          {zh(
            'In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.',
            '在绕过权限模式下，Claude Code 执行潜在危险命令前不会征求你的批准。',
          )}
          <Newline />
          {zh(
            'This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.',
            '此模式仅应在网络受限且损坏后易于恢复的沙箱容器/VM 中使用。',
          )}
        </Text>
        <Text>
          {zh(
            'By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
            '继续即表示你接受以绕过权限模式运行期间所有操作的责任。',
          )}
        </Text>

        <Link url="https://code.claude.com/docs/en/security" />
      </Box>

      <Select
        options={[
          { label: zh('No, exit', '不，退出'), value: 'decline' },
          { label: zh('Yes, I accept', '好，我接受'), value: 'accept' },
        ]}
        onChange={value => onChange(value as 'accept' | 'decline')}
      />
    </Dialog>
  );
}
