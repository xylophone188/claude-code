import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { type NetworkHostPattern, shouldAllowManagedSandboxDomainsOnly } from 'src/utils/sandbox/sandbox-adapter.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js';
import { Select } from '../CustomSelect/select.js';
import { PermissionDialog } from './PermissionDialog.js';
import { zh } from '../../utils/i18n.js';

export type SandboxPermissionRequestProps = {
  hostPattern: NetworkHostPattern;
  onUserResponse: (response: { allow: boolean; persistToSettings: boolean }) => void;
};

export function SandboxPermissionRequest({
  hostPattern: { host },
  onUserResponse,
}: SandboxPermissionRequestProps): React.ReactNode {
  function onSelect(value: string) {
    // We may want to better unify this dialog with other permission dialogs
    // and use their logging, but this is slightly different and we don't have
    // the tool context here. For now, just use basic logging for basic data.
    if (process.env.USER_TYPE === 'ant') {
      logEvent('tengu_sandbox_network_dialog_result', {
        host: host as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        result: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
    }

    switch (value) {
      case 'yes':
        onUserResponse({ allow: true, persistToSettings: false });
        break;
      case 'yes-dont-ask-again':
        onUserResponse({ allow: true, persistToSettings: true });
        break;
      case 'no':
        onUserResponse({ allow: false, persistToSettings: false });
        break;
    }
  }

  const managedDomainsOnly = shouldAllowManagedSandboxDomainsOnly();

  const options = [
    { label: zh('Yes', '允许'), value: 'yes' },
    ...(!managedDomainsOnly
      ? [
          {
            label: (
              <Text>
                {zh('Yes, and don\u0027t ask again for', '可以，不再询问')} <Text bold>{host}</Text>
              </Text>
            ),
            value: 'yes-dont-ask-again',
          },
        ]
      : []),
    {
      label: (
        <Text>
          {zh('No, and tell Claude what to do differently', '拒绝，并告诉 Claude 应该怎么做')} <Text bold>(esc)</Text>
        </Text>
      ),
      value: 'no',
    },
  ];

  return (
    <PermissionDialog title={zh('Network request outside of sandbox', '沙箱外的网络请求')}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box>
          <Text dimColor>{zh('Host:', '主机：')}</Text>
          <Text> {host}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>{zh('Do you want to allow this connection?', '是否允许此连接？')}</Text>
        </Box>
        <Box>
          <Select
            options={options}
            onChange={onSelect}
            onCancel={() => {
              if (process.env.USER_TYPE === 'ant') {
                logEvent('tengu_sandbox_network_dialog_result', {
                  host: host as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  result: 'cancel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                });
              }
              onUserResponse({ allow: false, persistToSettings: false });
            }}
          />
        </Box>
      </Box>
    </PermissionDialog>
  );
}
