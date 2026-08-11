import React from 'react';
import { Link, Text } from '@anthropic/ink';
import { zh } from '../utils/i18n.js';

export function MCPServerDialogCopy(): React.ReactNode {
  return (
    <Text>
      {zh(
        'MCP servers may execute code or access system resources. All tool calls require approval.',
        'MCP 服务器可能执行代码或访问系统资源。所有工具调用都需要批准。',
      )}{' '}
      {zh('Learn more in the', '了解更多请参阅')}{' '}
      <Link url="https://code.claude.com/docs/en/mcp">{zh('MCP documentation', 'MCP 文档')}</Link>.
    </Text>
  );
}
