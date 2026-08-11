import React from 'react';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { getSettings_DEPRECATED, updateSettingsForSource } from '../utils/settings/settings.js';
import { zh } from '../utils/i18n.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from '@anthropic/ink';
import { MCPServerDialogCopy } from './MCPServerDialogCopy.js';

type Props = {
  serverName: string;
  onDone(): void;
};

export function MCPServerApprovalDialog({ serverName, onDone }: Props): React.ReactNode {
  function onChange(value: 'yes' | 'yes_all' | 'no') {
    logEvent('tengu_mcp_dialog_choice', {
      choice: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });

    switch (value) {
      case 'yes':
      case 'yes_all': {
        // Get current enabled servers from settings
        const currentSettings = getSettings_DEPRECATED() || {};
        const enabledServers = currentSettings.enabledMcpjsonServers || [];

        // Add server if not already enabled
        if (!enabledServers.includes(serverName)) {
          updateSettingsForSource('localSettings', {
            enabledMcpjsonServers: [...enabledServers, serverName],
          });
        }

        if (value === 'yes_all') {
          updateSettingsForSource('localSettings', {
            enableAllProjectMcpServers: true,
          });
        }
        onDone();
        break;
      }
      case 'no': {
        // Get current disabled servers from settings
        const currentSettings = getSettings_DEPRECATED() || {};
        const disabledServers = currentSettings.disabledMcpjsonServers || [];

        // Add server if not already disabled
        if (!disabledServers.includes(serverName)) {
          updateSettingsForSource('localSettings', {
            disabledMcpjsonServers: [...disabledServers, serverName],
          });
        }
        onDone();
        break;
      }
    }
  }

  return (
    <Dialog
      title={zh(`New MCP server found in .mcp.json: ${serverName}`, `在 .mcp.json 中发现新 MCP 服务器：${serverName}`)}
      color="warning"
      onCancel={() => onChange('no')}
    >
      <MCPServerDialogCopy />

      <Select
        options={[
          {
            label: zh(`Use this and all future MCP servers in this project`, `使用这个及以后项目中的所有 MCP 服务器`),
            value: 'yes_all',
          },
          {
            label: zh(`Use this MCP server`, `使用这个 MCP 服务器`),
            value: 'yes',
          },
          {
            label: zh(`Continue without using this MCP server`, `不使用这个 MCP 服务器继续`),
            value: 'no',
          },
        ]}
        onChange={value => onChange(value as 'yes_all' | 'yes' | 'no')}
        onCancel={() => onChange('no')}
      />
    </Dialog>
  );
}
