import React, { useCallback, useEffect, useState } from 'react';
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js';
import { writeToStdout } from 'src/utils/process.js';
import { Box, color, Text, useTheme, Byline, Dialog, KeyboardShortcutHint } from '@anthropic/ink';
import { addMcpConfig, getAllMcpConfigs } from '../services/mcp/config.js';
import type { ConfigScope, McpServerConfig, ScopedMcpServerConfig } from '../services/mcp/types.js';
import { plural } from '../utils/stringUtils.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { SelectMulti } from './CustomSelect/SelectMulti.js';
import { zh } from '../utils/i18n.js';

type Props = {
  servers: Record<string, McpServerConfig>;
  scope: ConfigScope;
  onDone(): void;
};

export function MCPServerDesktopImportDialog({ servers, scope, onDone }: Props): React.ReactNode {
  const serverNames = Object.keys(servers);
  const [existingServers, setExistingServers] = useState<Record<string, ScopedMcpServerConfig>>({});

  useEffect(() => {
    void getAllMcpConfigs().then(({ servers }) => setExistingServers(servers));
  }, []);

  const collisions = serverNames.filter(name => existingServers[name] !== undefined);

  async function onSubmit(selectedServers: string[]) {
    let importedCount = 0;

    for (const serverName of selectedServers) {
      const serverConfig = servers[serverName];
      if (serverConfig) {
        // If the server name already exists, find a new name with _1, _2, etc.
        let finalName = serverName;
        if (existingServers[finalName] !== undefined) {
          let counter = 1;
          while (existingServers[`${serverName}_${counter}`] !== undefined) {
            counter++;
          }
          finalName = `${serverName}_${counter}`;
        }

        await addMcpConfig(finalName, serverConfig, scope);
        importedCount++;
      }
    }

    done(importedCount);
  }

  const [theme] = useTheme();

  // Define done before using in useCallback
  const done = useCallback(
    (importedCount: number) => {
      if (importedCount > 0) {
        writeToStdout(
          `\n${color('success', theme)(zh(`Successfully imported ${importedCount} MCP ${plural(importedCount, 'server')} to ${scope} config.`, `成功导入 ${importedCount} 个 MCP 服务器到 ${scope} 配置。`))}\n`,
        );
      } else {
        writeToStdout(zh('\nNo servers were imported.', '\n没有导入任何服务器。'));
      }
      onDone();

      void gracefulShutdown();
    },
    [theme, scope, onDone],
  );

  // Handle ESC to cancel (import 0 servers)
  const handleEscCancel = useCallback(() => {
    done(0);
  }, [done]);

  return (
    <>
      <Dialog
        title={zh('Import MCP Servers from Claude Desktop', '从 Claude Desktop 导入 MCP 服务器')}
        subtitle={zh(
          `Found ${serverNames.length} MCP ${plural(serverNames.length, 'server')} in Claude Desktop.`,
          `在 Claude Desktop 中发现 ${serverNames.length} 个 MCP 服务器。`,
        )}
        color="success"
        onCancel={handleEscCancel}
        hideInputGuide
      >
        {collisions.length > 0 && (
          <Text color="warning">
            {zh(
              'Note: Some servers already exist with the same name. If selected, they will be imported with a numbered suffix.',
              '注意：部分服务器已存在同名配置。若选中，将带数字后缀导入。',
            )}
          </Text>
        )}
        <Text>{zh('Please select the servers you want to import:', '请选择要导入的服务器：')}</Text>

        <SelectMulti
          options={serverNames.map(server => ({
            label: `${server}${collisions.includes(server) ? zh(' (already exists)', '（已存在）') : ''}`,
            value: server,
          }))}
          defaultValue={serverNames.filter(name => !collisions.includes(name))} // Only preselect non-colliding servers
          onSubmit={onSubmit}
          onCancel={handleEscCancel}
          hideIndexes
        />
      </Dialog>
      <Box paddingX={1}>
        <Text dimColor italic>
          <Byline>
            <KeyboardShortcutHint shortcut="Space" action="select" />
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
          </Byline>
        </Text>
      </Box>
    </>
  );
}
