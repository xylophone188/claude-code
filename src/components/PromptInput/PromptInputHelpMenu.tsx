import { feature } from 'bun:bundle';
import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { getPlatform } from 'src/utils/platform.js';
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { isFastModeAvailable, isFastModeEnabled } from '../../utils/fastMode.js';
import { zh } from '../../utils/i18n.js';
import { getNewlineInstructions } from './utils.js';

/** Format a shortcut for display in the help menu (e.g., "ctrl+o" → "ctrl + o") */
function formatShortcut(shortcut: string): string {
  return shortcut.replace(/\+/g, ' + ');
}

type Props = {
  dimColor?: boolean;
  fixedWidth?: boolean;
  gap?: number;
  paddingX?: number;
};

export function PromptInputHelpMenu(props: Props): React.ReactNode {
  const { dimColor, fixedWidth, gap, paddingX } = props;

  // Get configured shortcuts from keybinding system
  const transcriptShortcut = formatShortcut(useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o'));
  const todosShortcut = formatShortcut(useShortcutDisplay('app:toggleTodos', 'Global', 'ctrl+t'));
  const undoShortcut = formatShortcut(useShortcutDisplay('chat:undo', 'Chat', 'ctrl+_'));
  const stashShortcut = formatShortcut(useShortcutDisplay('chat:stash', 'Chat', 'ctrl+s'));
  const cycleModeShortcut = formatShortcut(useShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab'));
  const modelPickerShortcut = formatShortcut(useShortcutDisplay('chat:modelPicker', 'Chat', 'alt+p'));
  const fastModeShortcut = formatShortcut(useShortcutDisplay('chat:fastMode', 'Chat', 'alt+o'));
  const externalEditorShortcut = formatShortcut(useShortcutDisplay('chat:externalEditor', 'Chat', 'ctrl+g'));
  const terminalShortcut = formatShortcut(useShortcutDisplay('app:toggleTerminal', 'Global', 'meta+j'));
  const imagePasteShortcut = formatShortcut(useShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v'));

  // Compute terminal shortcut element outside JSX to satisfy feature() constraint
  const terminalShortcutElement = feature('TERMINAL_PANEL') ? (
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_panel', false) ? (
      <Box>
        <Text dimColor={dimColor}>{zh(`${terminalShortcut} for terminal`, `${terminalShortcut} 打开终端`)}</Text>
      </Box>
    ) : null
  ) : null;

  return (
    <Box paddingX={paddingX} flexDirection="row" gap={gap}>
      <Box flexDirection="column" width={fixedWidth ? 24 : undefined}>
        <Box>
          <Text dimColor={dimColor}>{zh('! for bash mode', '! 进入终端模式')}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{zh('/ for commands', '/ 快速启动')}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{zh('@ for file paths', '@ 引用文件或行号')}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{zh('& for background', '& 后台执行')}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{zh('/btw for side question', '/btw 旁路提问')}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" width={fixedWidth ? 35 : undefined}>
        <Box>
          <Text dimColor={dimColor}>{zh('double tap esc to clear input', '按两下 esc 清除输入')}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>
            {cycleModeShortcut}{' '}
            {process.env.USER_TYPE === 'ant'
              ? zh('to cycle modes', '切换模式')
              : zh('to auto-accept edits', '自动接受编辑')}
          </Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>
            {zh(`${transcriptShortcut} for verbose output`, `${transcriptShortcut} 详细输出`)}
          </Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{zh(`${todosShortcut} to toggle tasks`, `${todosShortcut} 切换任务`)}</Text>
        </Box>
        {terminalShortcutElement}
        <Box>
          <Text dimColor={dimColor}>{getNewlineInstructions()}</Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text dimColor={dimColor}>{zh(`${undoShortcut} to undo`, `${undoShortcut} 撤销`)}</Text>
        </Box>
        {getPlatform() !== 'windows' && (
          <Box>
            <Text dimColor={dimColor}>{zh('ctrl + z to suspend', 'ctrl + z 暂停')}</Text>
          </Box>
        )}
        <Box>
          <Text dimColor={dimColor}>
            {zh(`${imagePasteShortcut} to paste images`, `${imagePasteShortcut} 粘贴图片`)}
          </Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>
            {zh(`${modelPickerShortcut} to switch model`, `${modelPickerShortcut} 切换模型`)}
          </Text>
        </Box>
        {isFastModeEnabled() && isFastModeAvailable() && (
          <Box>
            <Text dimColor={dimColor}>
              {zh(`${fastModeShortcut} to toggle fast mode`, `${fastModeShortcut} 切换快速模式`)}
            </Text>
          </Box>
        )}
        <Box>
          <Text dimColor={dimColor}>{zh(`${stashShortcut} to stash prompt`, `${stashShortcut} 暂存提示`)}</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>
            {zh(`${externalEditorShortcut} to edit in $EDITOR`, `${externalEditorShortcut} 在 $EDITOR 中编辑`)}
          </Text>
        </Box>
        {isKeybindingCustomizationEnabled() && (
          <Box>
            <Text dimColor={dimColor}>{zh('/keybindings to customize', '/keybindings 自定义快捷键')}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
