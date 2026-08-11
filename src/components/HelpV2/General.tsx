import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { PromptInputHelpMenu } from '../PromptInput/PromptInputHelpMenu.js';
import { zh } from '../../utils/i18n.js';

export function General(): React.ReactNode {
  return (
    <Box flexDirection="column" paddingY={1} gap={1}>
      <Box flexDirection="column" gap={1}>
        <Text bold>{zh('Getting started', '快速上手')}</Text>
        <Box flexDirection="column">
          <Text>
            <Text bold>1. </Text>
            <Text>
              {zh(
                'Ask a question or describe a task — Claude will explore your code and respond.',
                '提一个问题或描述一个任务——Claude 会探索你的代码并做出回应。',
              )}
            </Text>
          </Text>
          <Text>
            <Text bold>2. </Text>
            <Text>
              {zh(
                'When Claude wants to edit files or run commands, you review and approve each action.',
                '当 Claude 想修改文件或运行命令时，你逐个审查并批准每个操作。',
              )}
            </Text>
          </Text>
          <Text>
            <Text bold>3. </Text>
            <Text>{zh('Type ', '输入 ')}</Text>
            <Text bold>/commit</Text>
            <Text>{zh(' to commit changes, ', ' 提交更改，')}</Text>
            <Text bold>/help</Text>
            <Text>{zh(' for commands, or ', ' 查看命令，或输入 ')}</Text>
            <Text bold>?</Text>
            <Text>{zh(' for shortcuts.', ' 查看快捷键。')}</Text>
          </Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text bold>{zh('Shortcuts', '快捷键')}</Text>
        </Box>
        <PromptInputHelpMenu gap={2} fixedWidth={true} />
      </Box>
    </Box>
  );
}
