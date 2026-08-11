// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle';
import { type KeyboardEvent, Box, Text, useTheme, useThemeSetting, useTerminalFocus } from '@anthropic/ink';
import * as React from 'react';
import { useState, useCallback } from 'react';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import figures from 'figures';
import { type GlobalConfig, saveGlobalConfig, getCurrentProjectConfig, type OutputStyle } from '../../utils/config.js';
import { normalizeApiKeyForConfig } from '../../utils/authPortable.js';
import {
  getGlobalConfig,
  getAutoUpdaterDisabledReason,
  formatAutoUpdaterDisabledReason,
  getRemoteControlAtStartup,
} from '../../utils/config.js';
import chalk from 'chalk';
import {
  permissionModeShortTitle,
  permissionModeFromString,
  toExternalPermissionMode,
  isExternalPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js';
import {
  getAutoModeEnabledState,
  hasAutoModeOptInAnySource,
  transitionPlanAutoMode,
} from '../../utils/permissions/permissionSetup.js';
import { logError } from '../../utils/log.js';
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js';
import { isBridgeEnabled } from '../../bridge/bridgeEnabled.js';
import { ThemePicker } from '../ThemePicker.js';
import { useAppState, useSetAppState, useAppStateStore } from '../../state/AppState.js';
import { ModelPicker } from '../ModelPicker.js';
import { modelDisplayString, isOpus1mMergeEnabled } from '../../utils/model/model.js';
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js';
import { ClaudeMdExternalIncludesDialog } from '../ClaudeMdExternalIncludesDialog.js';
import { ChannelDowngradeDialog, type ChannelDowngradeChoice } from '../ChannelDowngradeDialog.js';
import { Dialog } from '@anthropic/ink';
import { Select } from '../CustomSelect/index.js';
import { OutputStylePicker } from '../OutputStylePicker.js';
import { LanguagePicker } from '../LanguagePicker.js';
import {
  type MemoryFileInfo,
  getExternalClaudeMdIncludes,
  getMemoryFiles,
  hasExternalClaudeMdIncludes,
} from 'src/utils/claudemd.js';
import { Byline, KeyboardShortcutHint, useTabHeaderFocus } from '@anthropic/ink';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { SearchBox } from '../SearchBox.js';
import { isSupportedTerminal, hasAccessToIDEExtensionDiffFeature } from '../../utils/ide.js';
import { getInitialSettings, getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import { getUserMsgOptIn, setUserMsgOptIn } from '../../bootstrap/state.js';
import { DEFAULT_OUTPUT_STYLE_NAME } from 'src/constants/outputStyles.js';
import { isEnvTruthy, isRunningOnHomespace } from 'src/utils/envUtils.js';
import type { LocalJSXCommandContext, CommandResultDisplay } from '../../commands.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import {
  getCliTeammateModeOverride,
  clearCliTeammateModeOverride,
} from '../../utils/swarm/backends/teammateModeSnapshot.js';
import { getHardcodedTeammateModelFallback } from '../../utils/swarm/teammateModel.js';
import { useSearchInput } from '../../hooks/useSearchInput.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import {
  clearFastModeCooldown,
  FAST_MODE_MODEL_DISPLAY,
  isFastModeAvailable,
  isFastModeEnabled,
  getFastModeModel,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { getPlatform } from '../../utils/platform.js';
import { zh } from '../../utils/i18n.js';

type Props = {
  onClose: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  context: LocalJSXCommandContext;
  setTabsHidden: (hidden: boolean) => void;
  onIsSearchModeChange?: (inSearchMode: boolean) => void;
  contentHeight?: number;
};

type SettingBase =
  | {
      id: string;
      label: string;
    }
  | {
      id: string;
      label: React.ReactNode;
      searchText: string;
    };

type Setting =
  | (SettingBase & {
      value: boolean;
      onChange(value: boolean): void;
      type: 'boolean';
    })
  | (SettingBase & {
      value: string;
      options: string[];
      onChange(value: string): void;
      type: 'enum';
    })
  | (SettingBase & {
      // For enums that are set by a custom component, we don't need to pass options,
      // but we still need a value to display in the top-level config menu
      value: string;
      onChange(value: string): void;
      type: 'managedEnum';
    });

type SubMenu =
  | 'Theme'
  | 'Model'
  | 'TeammateModel'
  | 'ExternalIncludes'
  | 'OutputStyle'
  | 'ChannelDowngrade'
  | 'Language'
  | 'EnableAutoUpdates';
export function Config({
  onClose,
  context,
  setTabsHidden,
  onIsSearchModeChange,
  contentHeight,
}: Props): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus();
  const insideModal = useIsInsideModal();
  const [, setTheme] = useTheme();
  const themeSetting = useThemeSetting();
  const [globalConfig, setGlobalConfig] = useState(getGlobalConfig());
  const initialConfig = React.useRef(getGlobalConfig());
  const [settingsData, setSettingsData] = useState(getInitialSettings());
  const initialSettingsData = React.useRef(getInitialSettings());
  const [currentOutputStyle, setCurrentOutputStyle] = useState<OutputStyle>(
    settingsData?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME,
  );
  const initialOutputStyle = React.useRef(currentOutputStyle);
  const [currentLanguage, setCurrentLanguage] = useState<string | undefined>(settingsData?.language);
  const initialLanguage = React.useRef(currentLanguage);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const isTerminalFocused = useTerminalFocus();
  const { rows } = useTerminalSize();
  // contentHeight is set by Settings.tsx (same value passed to Tabs to fix
  // pane height across all tabs — prevents layout jank when switching).
  // Reserve ~10 rows for chrome (search box, gaps, footer, scroll hints).
  // Fallback calc for standalone rendering (tests).
  const paneCap = contentHeight ?? Math.min(Math.floor(rows * 0.8), 30);
  const maxVisible = Math.max(5, paneCap - 10);
  const mainLoopModel = useAppState(s => s.mainLoopModel);
  const verbose = useAppState(s => s.verbose);
  const thinkingEnabled = useAppState(s => s.thinkingEnabled);
  const isFastMode = useAppState(s => (isFastModeEnabled() ? s.fastMode : false));
  const promptSuggestionEnabled = useAppState(s => s.promptSuggestionEnabled);
  const currentDefaultPermissionMode = permissionModeFromString(settingsData?.permissions?.defaultMode ?? 'default');
  // Show auto in the default-mode dropdown when the user has opted in OR the
  // config is fully 'enabled' — even if currently circuit-broken ('disabled'),
  // an opted-in user should still see it in settings (it's a temporary state).
  const showAutoInDefaultModePicker = feature('TRANSCRIPT_CLASSIFIER')
    ? hasAutoModeOptInAnySource() || getAutoModeEnabledState() === 'enabled'
    : false;
  // Chat/Transcript view picker is visible to entitled users (pass the GB
  // gate) even if they haven't opted in this session — it IS the persistent
  // opt-in. 'chat' written here is read at next startup by main.tsx which
  // sets userMsgOptIn if still entitled.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const showDefaultViewPicker =
    feature('KAIROS') || feature('KAIROS_BRIEF')
      ? (
          require('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js')
        ).isBriefEntitled()
      : false;
  /* eslint-enable @typescript-eslint/no-require-imports */
  const setAppState = useSetAppState();
  const [changes, setChanges] = useState<{ [key: string]: unknown }>({});
  const initialThinkingEnabled = React.useRef(thinkingEnabled);
  // Per-source settings snapshots for revert-on-escape. getInitialSettings()
  // returns merged-across-sources which can't tell us what to delete vs
  // restore; per-source snapshots + updateSettingsForSource's
  // undefined-deletes-key semantics can. Lazy-init via useState (no setter) to
  // avoid reading settings files on every render — useRef evaluates its arg
  // eagerly even though only the first result is kept.
  const [initialLocalSettings] = useState(() => getSettingsForSource('localSettings'));
  const [initialUserSettings] = useState(() => getSettingsForSource('userSettings'));
  const initialThemeSetting = React.useRef(themeSetting);
  // AppState fields Config may modify — snapshot once at mount.
  const store = useAppStateStore();
  const [initialAppState] = useState(() => {
    const s = store.getState();
    return {
      mainLoopModel: s.mainLoopModel,
      mainLoopModelForSession: s.mainLoopModelForSession,
      verbose: s.verbose,
      thinkingEnabled: s.thinkingEnabled,
      fastMode: s.fastMode,
      promptSuggestionEnabled: s.promptSuggestionEnabled,
      isBriefOnly: s.isBriefOnly,
      replBridgeEnabled: s.replBridgeEnabled,
      replBridgeOutboundOnly: s.replBridgeOutboundOnly,
      settings: s.settings,
    };
  });
  // Bootstrap state snapshot — userMsgOptIn is outside AppState, so
  // revertChanges needs to restore it separately. Without this, cycling
  // defaultView to 'chat' then Escape leaves the tool active while the
  // display filter reverts — the exact ambient-activation behavior this
  // PR's entitlement/opt-in split is meant to prevent.
  const [initialUserMsgOptIn] = useState(() => getUserMsgOptIn());
  // Set on first user-visible change; gates revertChanges() on Escape so
  // opening-then-closing doesn't trigger redundant disk writes.
  const isDirty = React.useRef(false);
  const [showThinkingWarning, setShowThinkingWarning] = useState(false);
  const [showSubmenu, setShowSubmenu] = useState<SubMenu | null>(null);
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset,
  } = useSearchInput({
    isActive: isSearchMode && showSubmenu === null && !headerFocused,
    onExit: () => setIsSearchMode(false),
    onExitUp: focusHeader,
    // Ctrl+C/D must reach Settings' useExitOnCtrlCD; 'd' also avoids
    // double-action (delete-char + exit-pending).
    passthroughCtrlKeys: ['c', 'd'],
  });

  // Tell the parent when Config's own Esc handler is active so Settings cedes
  // confirm:no. Only true when search mode owns the keyboard — not when the
  // tab header is focused (then Settings must handle Esc-to-close).
  const ownsEsc = isSearchMode && !headerFocused;
  React.useEffect(() => {
    onIsSearchModeChange?.(ownsEsc);
  }, [ownsEsc, onIsSearchModeChange]);

  const isConnectedToIde = hasAccessToIDEExtensionDiffFeature(context.options.mcpClients);

  const isFileCheckpointingAvailable = !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING);

  const memoryFiles = React.use(getMemoryFiles(true)) as MemoryFileInfo[];
  const shouldShowExternalIncludesToggle = hasExternalClaudeMdIncludes(memoryFiles);

  const autoUpdaterDisabledReason = getAutoUpdaterDisabledReason();

  function onChangeMainModelConfig(value: string | null): void {
    const previousModel = mainLoopModel;
    logEvent('tengu_config_model_changed', {
      from_model: previousModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    setAppState(prev => ({
      ...prev,
      mainLoopModel: value,
      mainLoopModelForSession: null,
    }));
    setChanges(prev => {
      const valStr =
        modelDisplayString(value) +
        (isBilledAsExtraUsage(value, false, isOpus1mMergeEnabled()) ? ' · Billed as extra usage' : '');
      if ('model' in prev) {
        const { model, ...rest } = prev;
        return { ...rest, model: valStr };
      }
      return { ...prev, model: valStr };
    });
  }

  function onChangeVerbose(value: boolean): void {
    // Update the global config to persist the setting
    saveGlobalConfig(current => ({ ...current, verbose: value }));
    setGlobalConfig({ ...getGlobalConfig(), verbose: value });

    // Update the app state for immediate UI feedback
    setAppState(prev => ({
      ...prev,
      verbose: value,
    }));
    setChanges(prev => {
      if ('verbose' in prev) {
        const { verbose, ...rest } = prev;
        return rest;
      }
      return { ...prev, verbose: value };
    });
  }

  // TODO: Add MCP servers
  const settingsItems: Setting[] = [
    // Global settings
    {
      id: 'autoCompactEnabled',
      label: zh('Auto-compact', '自动压缩'),
      value: globalConfig.autoCompactEnabled,
      type: 'boolean' as const,
      onChange(autoCompactEnabled: boolean) {
        saveGlobalConfig(current => ({ ...current, autoCompactEnabled }));
        setGlobalConfig({ ...getGlobalConfig(), autoCompactEnabled });
        logEvent('tengu_auto_compact_setting_changed', {
          enabled: autoCompactEnabled,
        });
      },
    },
    {
      id: 'spinnerTipsEnabled',
      label: zh('Show tips', '显示提示'),
      value: settingsData?.spinnerTipsEnabled ?? true,
      type: 'boolean' as const,
      onChange(spinnerTipsEnabled: boolean) {
        updateSettingsForSource('localSettings', {
          spinnerTipsEnabled,
        });
        // Update local state to reflect the change immediately
        setSettingsData(prev => ({
          ...prev,
          spinnerTipsEnabled,
        }));
        logEvent('tengu_tips_setting_changed', {
          enabled: spinnerTipsEnabled,
        });
      },
    },
    {
      id: 'cacheWarningEnabled',
      label: zh('Cache warnings', '缓存警告'),
      value: settingsData?.cacheWarningEnabled ?? true,
      type: 'boolean' as const,
      onChange(cacheWarningEnabled: boolean) {
        updateSettingsForSource('localSettings', {
          cacheWarningEnabled,
        });
        setSettingsData(prev => ({
          ...prev,
          cacheWarningEnabled,
        }));
        logEvent('tengu_cache_warning_setting_changed', {
          enabled: cacheWarningEnabled,
        });
      },
    },
    {
      id: 'prefersReducedMotion',
      label: zh('Reduce motion', '减少动态效果'),
      value: settingsData?.prefersReducedMotion ?? false,
      type: 'boolean' as const,
      onChange(prefersReducedMotion: boolean) {
        updateSettingsForSource('localSettings', {
          prefersReducedMotion,
        });
        setSettingsData(prev => ({
          ...prev,
          prefersReducedMotion,
        }));
        // Sync to AppState so components react immediately
        setAppState(prev => ({
          ...prev,
          settings: { ...prev.settings, prefersReducedMotion },
        }));
        logEvent('tengu_reduce_motion_setting_changed', {
          enabled: prefersReducedMotion,
        });
      },
    },
    {
      id: 'thinkingEnabled',
      label: zh('Thinking mode', '思考模式'),
      value: thinkingEnabled ?? true,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        setAppState(prev => ({ ...prev, thinkingEnabled: enabled }));
        updateSettingsForSource('userSettings', {
          alwaysThinkingEnabled: enabled ? undefined : false,
        });
        logEvent('tengu_thinking_toggled', { enabled });
      },
    },
    // Fast mode toggle (ant-only, eliminated from external builds)
    ...(isFastModeEnabled() && isFastModeAvailable()
      ? [
          {
            id: 'fastMode',
            label: zh(`Fast mode (${FAST_MODE_MODEL_DISPLAY} only)`, `快速模式（仅 ${FAST_MODE_MODEL_DISPLAY}）`),
            value: !!isFastMode,
            type: 'boolean' as const,
            onChange(enabled: boolean) {
              clearFastModeCooldown();
              updateSettingsForSource('userSettings', {
                fastMode: enabled ? true : undefined,
              });
              if (enabled) {
                setAppState(prev => ({
                  ...prev,
                  mainLoopModel: getFastModeModel(),
                  mainLoopModelForSession: null,
                  fastMode: true,
                }));
                setChanges(prev => ({
                  ...prev,
                  model: getFastModeModel(),
                  'Fast mode': 'ON',
                }));
              } else {
                setAppState(prev => ({
                  ...prev,
                  fastMode: false,
                }));
                setChanges(prev => ({ ...prev, 'Fast mode': 'OFF' }));
              }
            },
          },
        ]
      : []),
    ...(getFeatureValue_CACHED_MAY_BE_STALE('tengu_chomp_inflection', false)
      ? [
          {
            id: 'promptSuggestionEnabled',
            label: zh('Prompt suggestions', '提示建议'),
            value: promptSuggestionEnabled,
            type: 'boolean' as const,
            onChange(enabled: boolean) {
              setAppState(prev => ({
                ...prev,
                promptSuggestionEnabled: enabled,
              }));
              updateSettingsForSource('userSettings', {
                promptSuggestionEnabled: enabled ? undefined : false,
              });
            },
          },
        ]
      : []),
    ...(feature('POOR')
      ? [
          {
            id: 'poorMode',
            label: zh('Poor mode (save tokens)', '省电模式（节省 token）'),
            value: (() => {
              const PoorMode =
                require('../../commands/poor/poorMode.js') as typeof import('../../commands/poor/poorMode.js');
              return PoorMode.isPoorModeActive();
            })(),
            type: 'boolean' as const,
            onChange(enabled: boolean) {
              const PoorMode =
                require('../../commands/poor/poorMode.js') as typeof import('../../commands/poor/poorMode.js');
              PoorMode.setPoorMode(enabled);
              setAppState(prev => ({
                ...prev,
                promptSuggestionEnabled: !enabled,
              }));
            },
          },
        ]
      : []),
    // Speculation toggle (ant-only)
    ...(process.env.USER_TYPE === 'ant'
      ? [
          {
            id: 'speculationEnabled',
            label: zh('Speculative execution', '推测执行'),
            value: globalConfig.speculationEnabled ?? true,
            type: 'boolean' as const,
            onChange(enabled: boolean) {
              saveGlobalConfig(current => {
                if (current.speculationEnabled === enabled) return current;
                return {
                  ...current,
                  speculationEnabled: enabled,
                };
              });
              setGlobalConfig({
                ...getGlobalConfig(),
                speculationEnabled: enabled,
              });
              logEvent('tengu_speculation_setting_changed', {
                enabled,
              });
            },
          },
        ]
      : []),
    ...(isFileCheckpointingAvailable
      ? [
          {
            id: 'fileCheckpointingEnabled',
            label: zh('Rewind code (checkpoints)', '回退代码（checkpoint）'),
            value: globalConfig.fileCheckpointingEnabled,
            type: 'boolean' as const,
            onChange(enabled: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                fileCheckpointingEnabled: enabled,
              }));
              setGlobalConfig({
                ...getGlobalConfig(),
                fileCheckpointingEnabled: enabled,
              });
              logEvent('tengu_file_history_snapshots_setting_changed', {
                enabled: enabled,
              });
            },
          },
        ]
      : []),
    {
      id: 'verbose',
      label: zh('Verbose output', '详细输出'),
      value: verbose,
      type: 'boolean',
      onChange: onChangeVerbose,
    },
    {
      id: 'terminalProgressBarEnabled',
      label: zh('Terminal progress bar', '终端进度条'),
      value: globalConfig.terminalProgressBarEnabled,
      type: 'boolean' as const,
      onChange(terminalProgressBarEnabled: boolean) {
        saveGlobalConfig(current => ({
          ...current,
          terminalProgressBarEnabled,
        }));
        setGlobalConfig({ ...getGlobalConfig(), terminalProgressBarEnabled });
        logEvent('tengu_terminal_progress_bar_setting_changed', {
          enabled: terminalProgressBarEnabled,
        });
      },
    },
    ...(getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_sidebar', false)
      ? [
          {
            id: 'showStatusInTerminalTab',
            label: zh('Show status in terminal tab', '在终端标签页显示状态'),
            value: globalConfig.showStatusInTerminalTab ?? false,
            type: 'boolean' as const,
            onChange(showStatusInTerminalTab: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                showStatusInTerminalTab,
              }));
              setGlobalConfig({
                ...getGlobalConfig(),
                showStatusInTerminalTab,
              });
              logEvent('tengu_terminal_tab_status_setting_changed', {
                enabled: showStatusInTerminalTab,
              });
            },
          },
        ]
      : []),
    {
      id: 'showTurnDuration',
      label: zh('Show turn duration', '显示回合时长'),
      value: globalConfig.showTurnDuration,
      type: 'boolean' as const,
      onChange(showTurnDuration: boolean) {
        saveGlobalConfig(current => ({ ...current, showTurnDuration }));
        setGlobalConfig({ ...getGlobalConfig(), showTurnDuration });
        logEvent('tengu_show_turn_duration_setting_changed', {
          enabled: showTurnDuration,
        });
      },
    },
    {
      id: 'defaultPermissionMode',
      label: zh('Default permission mode', '默认权限模式'),
      value: currentDefaultPermissionMode,
      options: (() => {
        const priorityOrder: PermissionMode[] = ['default', 'plan'];
        return [...priorityOrder, ...PERMISSION_MODES.filter(m => !priorityOrder.includes(m))];
      })(),
      type: 'enum' as const,
      onChange(mode: string) {
        const parsedMode = permissionModeFromString(mode);
        // auto is an internal-only mode — store it directly, don't convert
        // to its external mapping ('default') which would make it invisible.
        const validatedMode =
          parsedMode === 'auto'
            ? parsedMode
            : isExternalPermissionMode(parsedMode)
              ? toExternalPermissionMode(parsedMode)
              : parsedMode;
        const result = updateSettingsForSource('userSettings', {
          permissions: {
            ...settingsData?.permissions,
            defaultMode: validatedMode as (typeof PERMISSION_MODES)[number],
          },
        });

        if (result.error) {
          logError(result.error);
          return;
        }

        // Update local state to reflect the change immediately.
        // validatedMode is typed as the wide PermissionMode union but at
        // runtime is always a PERMISSION_MODES member (the options dropdown
        // is built from that array above), so this narrowing is sound.
        setSettingsData(prev => ({
          ...prev,
          permissions: {
            ...prev?.permissions,
            defaultMode: validatedMode as (typeof PERMISSION_MODES)[number],
          },
        }));
        // Track changes
        setChanges(prev => ({ ...prev, defaultPermissionMode: mode }));
        logEvent('tengu_config_changed', {
          setting: 'defaultPermissionMode' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          value: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      },
    },
    ...(feature('TRANSCRIPT_CLASSIFIER') && showAutoInDefaultModePicker
      ? [
          {
            id: 'useAutoModeDuringPlan',
            label: zh('Use auto mode during plan', '计划期间使用自动模式'),
            value: (settingsData as { useAutoModeDuringPlan?: boolean } | undefined)?.useAutoModeDuringPlan ?? true,
            type: 'boolean' as const,
            onChange(useAutoModeDuringPlan: boolean) {
              updateSettingsForSource('userSettings', {
                useAutoModeDuringPlan,
              });
              setSettingsData(prev => ({
                ...prev,
                useAutoModeDuringPlan,
              }));
              // Internal writes suppress the file watcher, so
              // applySettingsChange won't fire. Reconcile directly so
              // mid-plan toggles take effect immediately.
              setAppState(prev => {
                const next = transitionPlanAutoMode(prev.toolPermissionContext);
                if (next === prev.toolPermissionContext) return prev;
                return { ...prev, toolPermissionContext: next };
              });
              setChanges(prev => ({
                ...prev,
                'Use auto mode during plan': useAutoModeDuringPlan,
              }));
            },
          },
        ]
      : []),
    {
      id: 'respectGitignore',
      label: zh('Respect .gitignore in file picker', '在文件选择器中遵循 .gitignore'),
      value: globalConfig.respectGitignore,
      type: 'boolean' as const,
      onChange(respectGitignore: boolean) {
        saveGlobalConfig(current => ({ ...current, respectGitignore }));
        setGlobalConfig({ ...getGlobalConfig(), respectGitignore });
        logEvent('tengu_respect_gitignore_setting_changed', {
          enabled: respectGitignore,
        });
      },
    },
    {
      id: 'copyFullResponse',
      label: zh('Always copy full response (skip /copy picker)', '始终复制完整回复（跳过 /copy 选择器）'),
      value: globalConfig.copyFullResponse,
      type: 'boolean' as const,
      onChange(copyFullResponse: boolean) {
        saveGlobalConfig(current => ({ ...current, copyFullResponse }));
        setGlobalConfig({ ...getGlobalConfig(), copyFullResponse });
        logEvent('tengu_config_changed', {
          setting: 'copyFullResponse' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          value: String(copyFullResponse) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      },
    },
    // Copy-on-select is only meaningful with in-app selection (fullscreen
    // alt-screen mode). In inline mode the terminal emulator owns selection.
    ...(isFullscreenEnvEnabled()
      ? [
          {
            id: 'copyOnSelect',
            label: zh('Copy on select', '选中即复制'),
            value: globalConfig.copyOnSelect ?? true,
            type: 'boolean' as const,
            onChange(copyOnSelect: boolean) {
              saveGlobalConfig(current => ({ ...current, copyOnSelect }));
              setGlobalConfig({ ...getGlobalConfig(), copyOnSelect });
              logEvent('tengu_config_changed', {
                setting: 'copyOnSelect' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                value: String(copyOnSelect) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            },
          },
        ]
      : []),
    // autoUpdates setting is hidden - use DISABLE_AUTOUPDATER env var to control
    autoUpdaterDisabledReason
      ? {
          id: 'autoUpdatesChannel',
          label: zh('Auto-update channel', '自动更新频道'),
          value: 'disabled',
          type: 'managedEnum' as const,
          onChange() {},
        }
      : {
          id: 'autoUpdatesChannel',
          label: zh('Auto-update channel', '自动更新频道'),
          value: settingsData?.autoUpdatesChannel ?? 'latest',
          type: 'managedEnum' as const,
          onChange() {
            // Handled via toggleSetting -> 'ChannelDowngrade'
          },
        },
    {
      id: 'theme',
      label: zh('Theme', '主题'),
      value: themeSetting,
      type: 'managedEnum',
      onChange: setTheme,
    },
    {
      id: 'notifChannel',
      label:
        feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
          ? zh('Local notifications', '本地通知')
          : zh('Notifications', '通知'),
      value: globalConfig.preferredNotifChannel,
      options: ['auto', 'iterm2', 'terminal_bell', 'iterm2_with_bell', 'kitty', 'ghostty', 'notifications_disabled'],
      type: 'enum',
      onChange(notifChannel: GlobalConfig['preferredNotifChannel']) {
        saveGlobalConfig(current => ({
          ...current,
          preferredNotifChannel: notifChannel,
        }));
        setGlobalConfig({
          ...getGlobalConfig(),
          preferredNotifChannel: notifChannel,
        });
      },
    },
    ...(feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
      ? [
          {
            id: 'taskCompleteNotifEnabled',
            label: zh('Push when idle', '空闲时推送'),
            value: globalConfig.taskCompleteNotifEnabled ?? false,
            type: 'boolean' as const,
            onChange(taskCompleteNotifEnabled: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                taskCompleteNotifEnabled,
              }));
              setGlobalConfig({
                ...getGlobalConfig(),
                taskCompleteNotifEnabled,
              });
            },
          },
          {
            id: 'inputNeededNotifEnabled',
            label: zh('Push when input needed', '需要输入时推送'),
            value: globalConfig.inputNeededNotifEnabled ?? false,
            type: 'boolean' as const,
            onChange(inputNeededNotifEnabled: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                inputNeededNotifEnabled,
              }));
              setGlobalConfig({
                ...getGlobalConfig(),
                inputNeededNotifEnabled,
              });
            },
          },
          {
            id: 'agentPushNotifEnabled',
            label: zh('Push when Claude decides', 'Claude 决定时推送'),
            value: globalConfig.agentPushNotifEnabled ?? false,
            type: 'boolean' as const,
            onChange(agentPushNotifEnabled: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                agentPushNotifEnabled,
              }));
              setGlobalConfig({
                ...getGlobalConfig(),
                agentPushNotifEnabled,
              });
            },
          },
        ]
      : []),
    {
      id: 'outputStyle',
      label: zh('Output style', '输出样式'),
      value: currentOutputStyle,
      type: 'managedEnum' as const,
      onChange: () => {}, // handled by OutputStylePicker submenu
    },
    ...(showDefaultViewPicker
      ? [
          {
            id: 'defaultView',
            label: zh('What you see by default', '默认显示内容'),
            // 'default' means the setting is unset — currently resolves to
            // transcript (main.tsx falls through when defaultView !== 'chat').
            // String() narrows the conditional-schema-spread union to string.
            value: settingsData?.defaultView === undefined ? 'default' : String(settingsData.defaultView),
            options: ['transcript', 'chat', 'default'],
            type: 'enum' as const,
            onChange(selected: string) {
              const defaultView = selected === 'default' ? undefined : (selected as 'chat' | 'transcript');
              updateSettingsForSource('localSettings', { defaultView });
              setSettingsData(prev => ({ ...prev, defaultView }));
              const nextBrief = defaultView === 'chat';
              setAppState(prev => {
                if (prev.isBriefOnly === nextBrief) return prev;
                return { ...prev, isBriefOnly: nextBrief };
              });
              // Keep userMsgOptIn in sync so the tool list follows the view.
              // Two-way now (same as /brief) — accepting a cache invalidation
              // is better than leaving the tool on after switching away.
              // Reverted on Escape via initialUserMsgOptIn snapshot.
              setUserMsgOptIn(nextBrief);
              setChanges(prev => ({ ...prev, 'Default view': selected }));
              logEvent('tengu_default_view_setting_changed', {
                value: (defaultView ?? 'unset') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            },
          },
        ]
      : []),
    {
      id: 'language',
      label: zh('Language', '语言'),
      value: currentLanguage ?? zh('Default (English)', '默认（英语）'),
      type: 'managedEnum' as const,
      onChange: () => {}, // handled by LanguagePicker submenu
    },
    {
      id: 'editorMode',
      label: zh('Editor mode', '编辑器模式'),
      // Convert 'emacs' to 'normal' for backward compatibility
      value: globalConfig.editorMode === 'emacs' ? 'normal' : globalConfig.editorMode || 'normal',
      options: ['normal', 'vim'],
      type: 'enum',
      onChange(value: string) {
        saveGlobalConfig(current => ({
          ...current,
          editorMode: value as GlobalConfig['editorMode'],
        }));
        setGlobalConfig({
          ...getGlobalConfig(),
          editorMode: value as GlobalConfig['editorMode'],
        });

        logEvent('tengu_editor_mode_changed', {
          mode: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          source: 'config_panel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      },
    },
    {
      id: 'prStatusFooterEnabled',
      label: zh('Show PR status footer', '显示 PR 状态页脚'),
      value: globalConfig.prStatusFooterEnabled ?? true,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        saveGlobalConfig(current => {
          if (current.prStatusFooterEnabled === enabled) return current;
          return {
            ...current,
            prStatusFooterEnabled: enabled,
          };
        });
        setGlobalConfig({
          ...getGlobalConfig(),
          prStatusFooterEnabled: enabled,
        });
        logEvent('tengu_pr_status_footer_setting_changed', {
          enabled,
        });
      },
    },
    {
      id: 'model',
      label: zh('Model', '模型'),
      value: mainLoopModel === null ? 'Default (recommended)' : mainLoopModel,
      type: 'managedEnum' as const,
      onChange: onChangeMainModelConfig,
    },
    ...(isConnectedToIde
      ? [
          {
            id: 'diffTool',
            label: zh('Diff tool', 'Diff 工具'),
            value: globalConfig.diffTool ?? 'auto',
            options: ['terminal', 'auto'],
            type: 'enum' as const,
            onChange(diffTool: string) {
              saveGlobalConfig(current => ({
                ...current,
                diffTool: diffTool as GlobalConfig['diffTool'],
              }));
              setGlobalConfig({
                ...getGlobalConfig(),
                diffTool: diffTool as GlobalConfig['diffTool'],
              });

              logEvent('tengu_diff_tool_changed', {
                tool: diffTool as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                source: 'config_panel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            },
          },
        ]
      : []),
    ...(!isSupportedTerminal()
      ? [
          {
            id: 'autoConnectIde',
            label: zh('Auto-connect to IDE (external terminal)', '自动连接到 IDE（外部终端）'),
            value: globalConfig.autoConnectIde ?? false,
            type: 'boolean' as const,
            onChange(autoConnectIde: boolean) {
              saveGlobalConfig(current => ({ ...current, autoConnectIde }));
              setGlobalConfig({ ...getGlobalConfig(), autoConnectIde });

              logEvent('tengu_auto_connect_ide_changed', {
                enabled: autoConnectIde,
                source: 'config_panel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            },
          },
        ]
      : []),
    ...(isSupportedTerminal()
      ? [
          {
            id: 'autoInstallIdeExtension',
            label: zh('Auto-install IDE extension', '自动安装 IDE 扩展'),
            value: globalConfig.autoInstallIdeExtension ?? true,
            type: 'boolean' as const,
            onChange(autoInstallIdeExtension: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                autoInstallIdeExtension,
              }));
              setGlobalConfig({ ...getGlobalConfig(), autoInstallIdeExtension });

              logEvent('tengu_auto_install_ide_extension_changed', {
                enabled: autoInstallIdeExtension,
                source: 'config_panel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            },
          },
        ]
      : []),
    {
      id: 'claudeInChromeDefaultEnabled',
      label: zh('Claude in Chrome enabled by default', '默认启用 Claude in Chrome'),
      value: globalConfig.claudeInChromeDefaultEnabled ?? true,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        saveGlobalConfig(current => ({
          ...current,
          claudeInChromeDefaultEnabled: enabled,
        }));
        setGlobalConfig({
          ...getGlobalConfig(),
          claudeInChromeDefaultEnabled: enabled,
        });
        logEvent('tengu_claude_in_chrome_setting_changed', {
          enabled,
        });
      },
    },
    // Teammate mode (only shown when agent swarms are enabled)
    ...(isAgentSwarmsEnabled()
      ? (() => {
          const cliOverride = getCliTeammateModeOverride();
          const label = cliOverride
            ? zh(`Teammate mode [overridden: ${cliOverride}]`, `队友模式[已覆盖：${cliOverride}]`)
            : zh('Teammate mode', '队友模式');
          const isWindows = getPlatform() === 'windows';
          const teammateModeOptions = isWindows
            ? ['auto', 'tmux', 'windows-terminal', 'in-process']
            : ['auto', 'tmux', 'in-process'];
          return [
            {
              id: 'teammateMode',
              label,
              value: globalConfig.teammateMode ?? 'auto',
              options: teammateModeOptions,
              type: 'enum' as const,
              onChange(mode: string) {
                if (mode !== 'auto' && mode !== 'tmux' && mode !== 'windows-terminal' && mode !== 'in-process') {
                  return;
                }
                if (mode === 'windows-terminal' && !isWindows) {
                  return;
                }
                // Clear CLI override and set new mode (pass mode to avoid race condition)
                clearCliTeammateModeOverride(mode);
                saveGlobalConfig(current => ({
                  ...current,
                  teammateMode: mode,
                }));
                setGlobalConfig({
                  ...getGlobalConfig(),
                  teammateMode: mode,
                });
                logEvent('tengu_teammate_mode_changed', {
                  mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                });
              },
            },
            {
              id: 'teammateDefaultModel',
              label: zh('Default teammate model', '默认队友模型'),
              value: teammateModelDisplayString(globalConfig.teammateDefaultModel),
              type: 'managedEnum' as const,
              onChange() {},
            },
          ];
        })()
      : []),
    // Remote at startup toggle — gated on build flag + GrowthBook + policy
    ...(feature('BRIDGE_MODE') && isBridgeEnabled()
      ? [
          {
            id: 'remoteControlAtStartup',
            label: zh('Enable Remote Control for all sessions', '为所有会话启用远程控制'),
            value:
              globalConfig.remoteControlAtStartup === undefined
                ? 'default'
                : String(globalConfig.remoteControlAtStartup),
            options: ['true', 'false', 'default'],
            type: 'enum' as const,
            onChange(selected: string) {
              if (selected === 'default') {
                // Unset the config key so it falls back to the platform default
                saveGlobalConfig(current => {
                  if (current.remoteControlAtStartup === undefined) return current;
                  const next = { ...current };
                  delete next.remoteControlAtStartup;
                  return next;
                });
                setGlobalConfig({
                  ...getGlobalConfig(),
                  remoteControlAtStartup: undefined,
                });
              } else {
                const enabled = selected === 'true';
                saveGlobalConfig(current => {
                  if (current.remoteControlAtStartup === enabled) return current;
                  return { ...current, remoteControlAtStartup: enabled };
                });
                setGlobalConfig({
                  ...getGlobalConfig(),
                  remoteControlAtStartup: enabled,
                });
              }
              // Sync to AppState so useReplBridge reacts immediately
              const resolved = getRemoteControlAtStartup();
              setAppState(prev => {
                if (prev.replBridgeEnabled === resolved && !prev.replBridgeOutboundOnly) return prev;
                return {
                  ...prev,
                  replBridgeEnabled: resolved,
                  replBridgeOutboundOnly: false,
                };
              });
            },
          },
        ]
      : []),
    ...(shouldShowExternalIncludesToggle
      ? [
          {
            id: 'showExternalIncludesDialog',
            label: zh('External CLAUDE.md includes', '外部 CLAUDE.md 包含'),
            value: (() => {
              const projectConfig = getCurrentProjectConfig();
              if (projectConfig.hasClaudeMdExternalIncludesApproved) {
                return 'true';
              } else {
                return 'false';
              }
            })(),
            type: 'managedEnum' as const,
            onChange() {
              // Will be handled by toggleSetting function
            },
          },
        ]
      : []),
    ...(process.env.ANTHROPIC_API_KEY && !isRunningOnHomespace()
      ? [
          {
            id: 'apiKey',
            label: (
              <Text>
                {zh('Use custom API key: ', '使用自定义 API key：')}
                <Text bold>{normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY)}</Text>
              </Text>
            ),
            searchText: zh('Use custom API key', '使用自定义 API key'),
            value: Boolean(
              process.env.ANTHROPIC_API_KEY &&
                globalConfig.customApiKeyResponses?.approved?.includes(
                  normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY),
                ),
            ),
            type: 'boolean' as const,
            onChange(useCustomKey: boolean) {
              saveGlobalConfig(current => {
                const updated = { ...current };
                if (!updated.customApiKeyResponses) {
                  updated.customApiKeyResponses = {
                    approved: [],
                    rejected: [],
                  };
                }
                if (!updated.customApiKeyResponses.approved) {
                  updated.customApiKeyResponses = {
                    ...updated.customApiKeyResponses,
                    approved: [],
                  };
                }
                if (!updated.customApiKeyResponses.rejected) {
                  updated.customApiKeyResponses = {
                    ...updated.customApiKeyResponses,
                    rejected: [],
                  };
                }
                if (process.env.ANTHROPIC_API_KEY) {
                  const truncatedKey = normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY);
                  if (useCustomKey) {
                    updated.customApiKeyResponses = {
                      ...updated.customApiKeyResponses,
                      approved: [
                        ...(updated.customApiKeyResponses.approved ?? []).filter(k => k !== truncatedKey),
                        truncatedKey,
                      ],
                      rejected: (updated.customApiKeyResponses.rejected ?? []).filter(k => k !== truncatedKey),
                    };
                  } else {
                    updated.customApiKeyResponses = {
                      ...updated.customApiKeyResponses,
                      approved: (updated.customApiKeyResponses.approved ?? []).filter(k => k !== truncatedKey),
                      rejected: [
                        ...(updated.customApiKeyResponses.rejected ?? []).filter(k => k !== truncatedKey),
                        truncatedKey,
                      ],
                    };
                  }
                }
                return updated;
              });
              setGlobalConfig(getGlobalConfig());
            },
          },
        ]
      : []),
  ];

  // Filter settings based on search query
  const filteredSettingsItems = React.useMemo(() => {
    if (!searchQuery) return settingsItems;
    const lowerQuery = searchQuery.toLowerCase();
    return settingsItems.filter(setting => {
      if (setting.id.toLowerCase().includes(lowerQuery)) return true;
      const searchableText = 'searchText' in setting ? setting.searchText : setting.label;
      return searchableText.toLowerCase().includes(lowerQuery);
    });
  }, [settingsItems, searchQuery]);

  // Adjust selected index when filtered list shrinks, and keep the selected
  // item visible when maxVisible changes (e.g., terminal resize).
  React.useEffect(() => {
    if (selectedIndex >= filteredSettingsItems.length) {
      const newIndex = Math.max(0, filteredSettingsItems.length - 1);
      setSelectedIndex(newIndex);
      setScrollOffset(Math.max(0, newIndex - maxVisible + 1));
      return;
    }
    setScrollOffset(prev => {
      if (selectedIndex < prev) return selectedIndex;
      if (selectedIndex >= prev + maxVisible) return selectedIndex - maxVisible + 1;
      return prev;
    });
  }, [filteredSettingsItems.length, selectedIndex, maxVisible]);

  // Keep the selected item visible within the scroll window.
  // Called synchronously from navigation handlers to avoid a render frame
  // where the selected item falls outside the visible window.
  const adjustScrollOffset = useCallback(
    (newIndex: number) => {
      setScrollOffset(prev => {
        if (newIndex < prev) return newIndex;
        if (newIndex >= prev + maxVisible) return newIndex - maxVisible + 1;
        return prev;
      });
    },
    [maxVisible],
  );

  // Enter: keep all changes (already persisted by onChange handlers), close
  // with a summary of what changed.
  const handleSaveAndClose = useCallback(() => {
    // Submenu handling: each submenu has its own Enter/Esc — don't close
    // the whole panel while one is open.
    if (showSubmenu !== null) {
      return;
    }
    // Log any changes that were made
    // TODO: Make these proper messages
    const formattedChanges: string[] = Object.entries(changes).map(([key, value]) => {
      logEvent('tengu_config_changed', {
        key: key as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        value: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      return zh(`Set ${key} to ${chalk.bold(value)}`, `已将 ${key} 设置为 ${chalk.bold(value)}`);
    });
    // Check for API key changes
    // On homespace, ANTHROPIC_API_KEY is preserved in process.env for child
    // processes but ignored by Claude Code itself (see auth.ts).
    const effectiveApiKey = isRunningOnHomespace() ? undefined : process.env.ANTHROPIC_API_KEY;
    const initialUsingCustomKey = Boolean(
      effectiveApiKey &&
        initialConfig.current.customApiKeyResponses?.approved?.includes(normalizeApiKeyForConfig(effectiveApiKey)),
    );
    const currentUsingCustomKey = Boolean(
      effectiveApiKey &&
        globalConfig.customApiKeyResponses?.approved?.includes(normalizeApiKeyForConfig(effectiveApiKey)),
    );
    if (initialUsingCustomKey !== currentUsingCustomKey) {
      formattedChanges.push(
        `${currentUsingCustomKey ? zh('Enabled', '已启用') : zh('Disabled', '已禁用')} ${zh('custom API key', '自定义 API key')}`,
      );
      logEvent('tengu_config_changed', {
        key: 'env.ANTHROPIC_API_KEY' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        value: currentUsingCustomKey as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
    }
    if (globalConfig.theme !== initialConfig.current.theme) {
      formattedChanges.push(
        zh(`Set theme to ${chalk.bold(globalConfig.theme)}`, `已将主题设置为 ${chalk.bold(globalConfig.theme)}`),
      );
    }
    if (globalConfig.preferredNotifChannel !== initialConfig.current.preferredNotifChannel) {
      formattedChanges.push(
        zh(
          `Set notifications to ${chalk.bold(globalConfig.preferredNotifChannel)}`,
          `已将通知渠道设置为 ${chalk.bold(globalConfig.preferredNotifChannel)}`,
        ),
      );
    }
    if (currentOutputStyle !== initialOutputStyle.current) {
      formattedChanges.push(
        zh(
          `Set output style to ${chalk.bold(currentOutputStyle)}`,
          `已将输出样式设置为 ${chalk.bold(currentOutputStyle)}`,
        ),
      );
    }
    if (currentLanguage !== initialLanguage.current) {
      formattedChanges.push(
        zh(
          `Set response language to ${chalk.bold(currentLanguage ?? 'Default (English)')}`,
          `已将回复语言设置为 ${chalk.bold(currentLanguage ?? 'Default (English)')}`,
        ),
      );
    }
    if (globalConfig.editorMode !== initialConfig.current.editorMode) {
      formattedChanges.push(
        zh(
          `Set editor mode to ${chalk.bold(globalConfig.editorMode || 'emacs')}`,
          `已将编辑器模式设置为 ${chalk.bold(globalConfig.editorMode || 'emacs')}`,
        ),
      );
    }
    if (globalConfig.diffTool !== initialConfig.current.diffTool) {
      formattedChanges.push(
        zh(
          `Set diff tool to ${chalk.bold(globalConfig.diffTool)}`,
          `已将 Diff 工具设置为 ${chalk.bold(globalConfig.diffTool)}`,
        ),
      );
    }
    if (globalConfig.autoConnectIde !== initialConfig.current.autoConnectIde) {
      formattedChanges.push(
        `${globalConfig.autoConnectIde ? zh('Enabled', '已启用') : zh('Disabled', '已禁用')} ${zh('auto-connect to IDE', '自动连接到 IDE')}`,
      );
    }
    if (globalConfig.autoInstallIdeExtension !== initialConfig.current.autoInstallIdeExtension) {
      formattedChanges.push(
        `${globalConfig.autoInstallIdeExtension ? zh('Enabled', '已启用') : zh('Disabled', '已禁用')} ${zh('auto-install IDE extension', '自动安装 IDE 扩展')}`,
      );
    }
    if (globalConfig.autoCompactEnabled !== initialConfig.current.autoCompactEnabled) {
      formattedChanges.push(
        `${globalConfig.autoCompactEnabled ? zh('Enabled', '已启用') : zh('Disabled', '已禁用')} ${zh('auto-compact', '自动压缩')}`,
      );
    }
    if (globalConfig.respectGitignore !== initialConfig.current.respectGitignore) {
      formattedChanges.push(
        `${globalConfig.respectGitignore ? zh('Enabled', '已启用') : zh('Disabled', '已禁用')} ${zh('respect .gitignore in file picker', '在文件选择器中遵循 .gitignore')}`,
      );
    }
    if (globalConfig.copyFullResponse !== initialConfig.current.copyFullResponse) {
      formattedChanges.push(
        `${globalConfig.copyFullResponse ? zh('Enabled', '已启用') : zh('Disabled', '已禁用')} ${zh('always copy full response', '始终复制完整回复')}`,
      );
    }
    if (globalConfig.copyOnSelect !== initialConfig.current.copyOnSelect) {
      formattedChanges.push(
        `${globalConfig.copyOnSelect ? zh('Enabled', '已启用') : zh('Disabled', '已禁用')} ${zh('copy on select', '选中即复制')}`,
      );
    }
    if (globalConfig.terminalProgressBarEnabled !== initialConfig.current.terminalProgressBarEnabled) {
      formattedChanges.push(
        `${globalConfig.terminalProgressBarEnabled ? zh('Enabled', '已启用') : zh('Disabled', '已禁用')} ${zh('terminal progress bar', '终端进度条')}`,
      );
    }
    if (globalConfig.showStatusInTerminalTab !== initialConfig.current.showStatusInTerminalTab) {
      formattedChanges.push(
        `${globalConfig.showStatusInTerminalTab ? zh('Enabled', '已启用') : zh('Disabled', '已禁用')} ${zh('terminal tab status', '终端标签页状态')}`,
      );
    }
    if (globalConfig.showTurnDuration !== initialConfig.current.showTurnDuration) {
      formattedChanges.push(
        `${globalConfig.showTurnDuration ? zh('Enabled', '已启用') : zh('Disabled', '已禁用')} ${zh('turn duration', '回合时长')}`,
      );
    }
    if (globalConfig.remoteControlAtStartup !== initialConfig.current.remoteControlAtStartup) {
      const remoteLabel =
        globalConfig.remoteControlAtStartup === undefined
          ? zh('Reset Remote Control to default', '重置远程控制为默认')
          : `${globalConfig.remoteControlAtStartup ? zh('Enabled', '已启用') : zh('Disabled', '已禁用')} ${zh('Remote Control for all sessions', '所有会话的远程控制')}`;
      formattedChanges.push(remoteLabel);
    }
    if (settingsData?.autoUpdatesChannel !== initialSettingsData.current?.autoUpdatesChannel) {
      formattedChanges.push(
        zh(
          `Set auto-update channel to ${chalk.bold(settingsData?.autoUpdatesChannel ?? 'latest')}`,
          `已将自动更新频道设置为 ${chalk.bold(settingsData?.autoUpdatesChannel ?? 'latest')}`,
        ),
      );
    }
    if (formattedChanges.length > 0) {
      onClose(formattedChanges.join('\n'));
    } else {
      onClose(zh('Config dialog dismissed', '配置对话框已关闭'), { display: 'system' });
    }
  }, [
    showSubmenu,
    changes,
    globalConfig,
    mainLoopModel,
    currentOutputStyle,
    currentLanguage,
    settingsData?.autoUpdatesChannel,
    isFastModeEnabled() ? (settingsData as Record<string, unknown> | undefined)?.fastMode : undefined,
    onClose,
  ]);

  // Restore all state stores to their mount-time snapshots. Changes are
  // applied to disk/AppState immediately on toggle, so "cancel" means
  // actively writing the old values back.
  const revertChanges = useCallback(() => {
    // Theme: restores ThemeProvider React state. Must run before the global
    // config overwrite since setTheme internally calls saveGlobalConfig with
    // a partial update — we want the full snapshot to be the last write.
    if (themeSetting !== initialThemeSetting.current) {
      setTheme(initialThemeSetting.current);
    }
    // Global config: full overwrite from snapshot. saveGlobalConfig skips if
    // the returned ref equals current (test mode checks ref; prod writes to
    // disk but content is identical).
    saveGlobalConfig(() => initialConfig.current);
    // Settings files: restore each key Config may have touched. undefined
    // deletes the key (updateSettingsForSource customizer at settings.ts:368).
    const il = initialLocalSettings;
    updateSettingsForSource('localSettings', {
      spinnerTipsEnabled: il?.spinnerTipsEnabled,
      prefersReducedMotion: il?.prefersReducedMotion,
      defaultView: il?.defaultView,
      outputStyle: il?.outputStyle,
    });
    const iu = initialUserSettings;
    updateSettingsForSource('userSettings', {
      alwaysThinkingEnabled: iu?.alwaysThinkingEnabled,
      fastMode: iu?.fastMode,
      promptSuggestionEnabled: iu?.promptSuggestionEnabled,
      autoUpdatesChannel: iu?.autoUpdatesChannel,
      minimumVersion: iu?.minimumVersion,
      language: iu?.language,
      ...(feature('TRANSCRIPT_CLASSIFIER')
        ? {
            useAutoModeDuringPlan: (iu as { useAutoModeDuringPlan?: boolean } | undefined)?.useAutoModeDuringPlan,
          }
        : {}),
      // ThemePicker's Ctrl+T writes this key directly — include it so the
      // disk state reverts along with the in-memory AppState.settings restore.
      syntaxHighlightingDisabled: iu?.syntaxHighlightingDisabled,
      // permissions: the defaultMode onChange (above) spreads the MERGED
      // settingsData.permissions into userSettings — project/policy allow/deny
      // arrays can leak to disk. Spread the full initial snapshot so the
      // mergeWith array-customizer (settings.ts:375) replaces leaked arrays.
      // Explicitly include defaultMode so undefined triggers the customizer's
      // delete path even when iu.permissions lacks that key.
      permissions:
        iu?.permissions === undefined ? undefined : { ...iu.permissions, defaultMode: iu.permissions.defaultMode },
    });
    // AppState: batch-restore all possibly-touched fields.
    const ia = initialAppState;
    setAppState(prev => ({
      ...prev,
      mainLoopModel: ia.mainLoopModel,
      mainLoopModelForSession: ia.mainLoopModelForSession,
      verbose: ia.verbose,
      thinkingEnabled: ia.thinkingEnabled,
      fastMode: ia.fastMode,
      promptSuggestionEnabled: ia.promptSuggestionEnabled,
      isBriefOnly: ia.isBriefOnly,
      replBridgeEnabled: ia.replBridgeEnabled,
      replBridgeOutboundOnly: ia.replBridgeOutboundOnly,
      settings: ia.settings,
      // Reconcile auto-mode state after useAutoModeDuringPlan revert above —
      // the onChange handler may have activated/deactivated auto mid-plan.
      toolPermissionContext: transitionPlanAutoMode(prev.toolPermissionContext),
    }));
    // Bootstrap state: restore userMsgOptIn. Only touched by the defaultView
    // onChange above, so no feature() guard needed here (that path only
    // exists when showDefaultViewPicker is true).
    if (getUserMsgOptIn() !== initialUserMsgOptIn) {
      setUserMsgOptIn(initialUserMsgOptIn);
    }
  }, [
    themeSetting,
    setTheme,
    initialLocalSettings,
    initialUserSettings,
    initialAppState,
    initialUserMsgOptIn,
    setAppState,
  ]);

  // Escape: revert all changes (if any) and close.
  const handleEscape = useCallback(() => {
    if (showSubmenu !== null) {
      return;
    }
    if (isDirty.current) {
      revertChanges();
    }
    onClose(zh('Config dialog dismissed', '配置对话框已关闭'), { display: 'system' });
  }, [showSubmenu, revertChanges, onClose]);

  // Disable when submenu is open so the submenu's Dialog handles ESC, and in
  // search mode so the onKeyDown handler (which clears-then-exits search)
  // wins — otherwise Escape in search would jump straight to revert+close.
  useKeybinding('confirm:no', handleEscape, {
    context: 'Settings',
    isActive: showSubmenu === null && !isSearchMode && !headerFocused,
  });
  // Save-and-close fires on Enter only when not in search mode (Enter there
  // exits search to the list — see the isSearchMode branch in handleKeyDown).
  useKeybinding('settings:close', handleSaveAndClose, {
    context: 'Settings',
    isActive: showSubmenu === null && !isSearchMode && !headerFocused,
  });

  // Settings navigation and toggle actions via configurable keybindings.
  // Only active when not in search mode and no submenu is open.
  const toggleSetting = useCallback(() => {
    const setting = filteredSettingsItems[selectedIndex];
    if (!setting || !setting.onChange) {
      return;
    }

    if (setting.type === 'boolean') {
      isDirty.current = true;
      setting.onChange(!setting.value);
      if (setting.id === 'thinkingEnabled') {
        const newValue = !setting.value;
        const backToInitial = newValue === initialThinkingEnabled.current;
        if (backToInitial) {
          setShowThinkingWarning(false);
        } else if (context.messages.some(m => m.type === 'assistant')) {
          setShowThinkingWarning(true);
        }
      }
      return;
    }

    if (
      setting.id === 'theme' ||
      setting.id === 'model' ||
      setting.id === 'teammateDefaultModel' ||
      setting.id === 'showExternalIncludesDialog' ||
      setting.id === 'outputStyle' ||
      setting.id === 'language'
    ) {
      // managedEnum items open a submenu — isDirty is set by the submenu's
      // completion callback, not here (submenu may be cancelled).
      switch (setting.id) {
        case 'theme':
          setShowSubmenu('Theme');
          setTabsHidden(true);
          return;
        case 'model':
          setShowSubmenu('Model');
          setTabsHidden(true);
          return;
        case 'teammateDefaultModel':
          setShowSubmenu('TeammateModel');
          setTabsHidden(true);
          return;
        case 'showExternalIncludesDialog':
          setShowSubmenu('ExternalIncludes');
          setTabsHidden(true);
          return;
        case 'outputStyle':
          setShowSubmenu('OutputStyle');
          setTabsHidden(true);
          return;
        case 'language':
          setShowSubmenu('Language');
          setTabsHidden(true);
          return;
      }
    }

    if (setting.id === 'autoUpdatesChannel') {
      if (autoUpdaterDisabledReason) {
        // Auto-updates are disabled - show enable dialog instead
        setShowSubmenu('EnableAutoUpdates');
        setTabsHidden(true);
        return;
      }
      const currentChannel = settingsData?.autoUpdatesChannel ?? 'latest';
      if (currentChannel === 'latest') {
        // Switching to stable - show downgrade dialog
        setShowSubmenu('ChannelDowngrade');
        setTabsHidden(true);
      } else {
        // Switching to latest - just do it and clear minimumVersion
        isDirty.current = true;
        updateSettingsForSource('userSettings', {
          autoUpdatesChannel: 'latest',
          minimumVersion: undefined,
        });
        setSettingsData(prev => ({
          ...prev,
          autoUpdatesChannel: 'latest',
          minimumVersion: undefined,
        }));
        logEvent('tengu_autoupdate_channel_changed', {
          channel: 'latest' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      }
      return;
    }

    if (setting.type === 'enum') {
      isDirty.current = true;
      const currentIndex = setting.options.indexOf(setting.value);
      const nextIndex = (currentIndex + 1) % setting.options.length;
      setting.onChange(setting.options[nextIndex]!);
      return;
    }
  }, [
    autoUpdaterDisabledReason,
    filteredSettingsItems,
    selectedIndex,
    settingsData?.autoUpdatesChannel,
    setTabsHidden,
  ]);

  const moveSelection = (delta: -1 | 1): void => {
    setShowThinkingWarning(false);
    const newIndex = Math.max(0, Math.min(filteredSettingsItems.length - 1, selectedIndex + delta));
    setSelectedIndex(newIndex);
    adjustScrollOffset(newIndex);
  };

  useKeybindings(
    {
      'select:previous': () => {
        if (selectedIndex === 0) {
          // ↑ at top enters search mode so users can type-to-filter after
          // reaching the list boundary. Wheel-up (scroll:lineUp) clamps
          // instead — overshoot shouldn't move focus away from the list.
          setShowThinkingWarning(false);
          setIsSearchMode(true);
          setScrollOffset(0);
        } else {
          moveSelection(-1);
        }
      },
      'select:next': () => moveSelection(1),
      // Wheel. ScrollKeybindingHandler's scroll:line* returns false (not
      // consumed) when the ScrollBox content fits — which it always does
      // here because the list is paginated (slice). The event falls through
      // to this handler which navigates the list, clamping at boundaries.
      'scroll:lineUp': () => moveSelection(-1),
      'scroll:lineDown': () => moveSelection(1),
      'select:accept': toggleSetting,
      'select:previousValue': () => toggleSetting(),
      'select:nextValue': () => toggleSetting(),
      'settings:search': () => {
        setIsSearchMode(true);
        setSearchQuery('');
      },
    },
    {
      context: 'Settings',
      isActive: showSubmenu === null && !isSearchMode && !headerFocused,
    },
  );

  // Combined key handling across search/list modes. Branch order mirrors
  // the original useInput gate priority: submenu and header short-circuit
  // first (their own handlers own input), then search vs. list.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (showSubmenu !== null) return;
      if (headerFocused) return;
      // Search mode: Esc clears then exits, Enter/↓ moves to the list.
      if (isSearchMode) {
        if (e.key === 'escape') {
          e.preventDefault();
          if (searchQuery.length > 0) {
            setSearchQuery('');
          } else {
            setIsSearchMode(false);
          }
          return;
        }
        if (e.key === 'return' || e.key === 'down' || e.key === 'wheeldown') {
          e.preventDefault();
          setIsSearchMode(false);
          setSelectedIndex(0);
          setScrollOffset(0);
        }
        return;
      }
      // List mode: left/right/tab cycle the selected option's value. These
      // keys used to switch tabs; now they only do so when the tab row is
      // explicitly focused (see headerFocused in Settings.tsx).
      if (e.key === 'left' || e.key === 'right' || e.key === 'tab') {
        e.preventDefault();
        toggleSetting();
        return;
      }
      // Fallback: printable characters (other than those bound to actions)
      // enter search mode. Carve out j/k// — useKeybindings (still on the
      // useInput path) consumes these via stopImmediatePropagation, but
      // onKeyDown dispatches independently so we must skip them explicitly.
      if (e.ctrl || e.meta) return;
      if (e.key === 'j' || e.key === 'k' || e.key === '/') return;
      if (e.key.length === 1 && e.key !== ' ') {
        e.preventDefault();
        setIsSearchMode(true);
        setSearchQuery(e.key);
      }
    },
    [showSubmenu, headerFocused, isSearchMode, searchQuery, setSearchQuery, toggleSetting],
  );

  return (
    <Box flexDirection="column" width="100%" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      {showSubmenu === 'Theme' ? (
        <>
          <ThemePicker
            onThemeSelect={setting => {
              isDirty.current = true;
              setTheme(setting);
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
            onCancel={() => {
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
            hideEscToCancel
            skipExitHandling={true} // Skip exit handling as Config already handles it
          />
          <Box>
            <Text dimColor italic>
              <Byline>
                <KeyboardShortcutHint shortcut="Enter" action="select" />
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Confirmation"
                  fallback="Esc"
                  description={zh('cancel', '取消')}
                />
              </Byline>
            </Text>
          </Box>
        </>
      ) : showSubmenu === 'Model' ? (
        <>
          <ModelPicker
            initial={mainLoopModel}
            onSelect={(model, _effort) => {
              isDirty.current = true;
              onChangeMainModelConfig(model);
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
            onCancel={() => {
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
            showFastModeNotice={
              isFastModeEnabled()
                ? isFastMode && isFastModeSupportedByModel(mainLoopModel) && isFastModeAvailable()
                : false
            }
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description={zh('cancel', '取消')}
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'TeammateModel' ? (
        <>
          <ModelPicker
            initial={globalConfig.teammateDefaultModel ?? null}
            skipSettingsWrite
            headerText="Default model for newly spawned teammates. The leader can override via the tool call's model parameter."
            onSelect={(model, _effort) => {
              setShowSubmenu(null);
              setTabsHidden(false);
              // First-open-then-Enter from unset: picker highlights "Default"
              // (initial=null) and confirming would write null, silently
              // switching Opus-fallback → follow-leader. Treat as no-op.
              if (globalConfig.teammateDefaultModel === undefined && model === null) {
                return;
              }
              isDirty.current = true;
              saveGlobalConfig(current =>
                current.teammateDefaultModel === model ? current : { ...current, teammateDefaultModel: model },
              );
              setGlobalConfig({
                ...getGlobalConfig(),
                teammateDefaultModel: model,
              });
              setChanges(prev => ({
                ...prev,
                teammateDefaultModel: teammateModelDisplayString(model),
              }));
              logEvent('tengu_teammate_default_model_changed', {
                model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            }}
            onCancel={() => {
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description={zh('cancel', '取消')}
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'ExternalIncludes' ? (
        <>
          <ClaudeMdExternalIncludesDialog
            onDone={() => {
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
            externalIncludes={getExternalClaudeMdIncludes(memoryFiles as MemoryFileInfo[])}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description={zh('disable external includes', '禁用外部包含')}
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'OutputStyle' ? (
        <>
          <OutputStylePicker
            initialStyle={currentOutputStyle}
            onComplete={style => {
              isDirty.current = true;
              setCurrentOutputStyle(style ?? DEFAULT_OUTPUT_STYLE_NAME);
              setShowSubmenu(null);
              setTabsHidden(false);

              // Save to local settings
              updateSettingsForSource('localSettings', {
                outputStyle: style,
              });

              void logEvent('tengu_output_style_changed', {
                style: (style ??
                  DEFAULT_OUTPUT_STYLE_NAME) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                source: 'config_panel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                settings_source: 'localSettings' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            }}
            onCancel={() => {
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description={zh('cancel', '取消')}
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'Language' ? (
        <>
          <LanguagePicker
            initialLanguage={currentLanguage}
            onComplete={language => {
              isDirty.current = true;
              setCurrentLanguage(language);
              setShowSubmenu(null);
              setTabsHidden(false);

              // Save to user settings
              updateSettingsForSource('userSettings', {
                language,
              });

              void logEvent('tengu_language_changed', {
                language: (language ?? 'default') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                source: 'config_panel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            }}
            onCancel={() => {
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Settings"
                fallback="Esc"
                description={zh('cancel', '取消')}
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'EnableAutoUpdates' ? (
        <Dialog
          title={zh('Enable Auto-Updates', '启用自动更新')}
          onCancel={() => {
            setShowSubmenu(null);
            setTabsHidden(false);
          }}
          hideBorder
          hideInputGuide
        >
          {autoUpdaterDisabledReason?.type !== 'config' ? (
            <>
              <Text>
                {autoUpdaterDisabledReason?.type === 'env'
                  ? zh(
                      'Auto-updates are controlled by an environment variable and cannot be changed here.',
                      '自动更新由环境变量控制，无法在此处更改。',
                    )
                  : zh('Auto-updates are disabled in development builds.', '自动更新已在开发构建中禁用。')}
              </Text>
              {autoUpdaterDisabledReason?.type === 'env' && (
                <Text dimColor>
                  {zh(
                    `Unset ${autoUpdaterDisabledReason.envVar} to re-enable auto-updates.`,
                    `取消设置 ${autoUpdaterDisabledReason.envVar} 以重新启用自动更新。`,
                  )}
                </Text>
              )}
            </>
          ) : (
            <Select
              options={[
                {
                  label: zh('Enable with latest channel', '使用最新频道启用'),
                  value: 'latest',
                },
                {
                  label: zh('Enable with stable channel', '使用稳定频道启用'),
                  value: 'stable',
                },
              ]}
              onChange={(channel: string) => {
                isDirty.current = true;
                setShowSubmenu(null);
                setTabsHidden(false);

                saveGlobalConfig(current => ({
                  ...current,
                  autoUpdates: true,
                }));
                setGlobalConfig({ ...getGlobalConfig(), autoUpdates: true });

                updateSettingsForSource('userSettings', {
                  autoUpdatesChannel: channel as 'latest' | 'stable',
                  minimumVersion: undefined,
                });
                setSettingsData(prev => ({
                  ...prev,
                  autoUpdatesChannel: channel as 'latest' | 'stable',
                  minimumVersion: undefined,
                }));
                logEvent('tengu_autoupdate_enabled', {
                  channel: channel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                });
              }}
            />
          )}
        </Dialog>
      ) : showSubmenu === 'ChannelDowngrade' ? (
        <ChannelDowngradeDialog
          currentVersion={MACRO.VERSION}
          onChoice={(choice: ChannelDowngradeChoice) => {
            setShowSubmenu(null);
            setTabsHidden(false);

            if (choice === 'cancel') {
              // User cancelled - don't change anything
              return;
            }

            isDirty.current = true;
            // Switch to stable channel
            const newSettings: {
              autoUpdatesChannel: 'stable';
              minimumVersion?: string;
            } = {
              autoUpdatesChannel: 'stable',
            };

            if (choice === 'stay') {
              // User wants to stay on current version until stable catches up
              newSettings.minimumVersion = MACRO.VERSION;
            }

            updateSettingsForSource('userSettings', newSettings);
            setSettingsData(prev => ({
              ...prev,
              ...newSettings,
            }));
            logEvent('tengu_autoupdate_channel_changed', {
              channel: 'stable' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              minimum_version_set: choice === 'stay',
            });
          }}
        />
      ) : (
        <Box flexDirection="column" gap={1} marginY={insideModal ? undefined : 1}>
          <SearchBox
            query={searchQuery}
            isFocused={isSearchMode && !headerFocused}
            isTerminalFocused={isTerminalFocused}
            cursorOffset={searchCursorOffset}
            placeholder={zh('Search settings…', '搜索设置…')}
          />
          <Box flexDirection="column">
            {filteredSettingsItems.length === 0 ? (
              <Text dimColor italic>
                {zh(`No settings match ${searchQuery}`, `没有与“${searchQuery}”匹配的设置`)}
              </Text>
            ) : (
              <>
                {scrollOffset > 0 && (
                  <Text dimColor>
                    {figures.arrowUp} {zh(`${scrollOffset} more above`, `${scrollOffset} 项在上方`)}
                  </Text>
                )}
                {filteredSettingsItems.slice(scrollOffset, scrollOffset + maxVisible).map((setting, i) => {
                  const actualIndex = scrollOffset + i;
                  const isSelected = actualIndex === selectedIndex && !headerFocused && !isSearchMode;

                  return (
                    <React.Fragment key={setting.id}>
                      <Box width="100%">
                        <Box width={44}>
                          <Text color={isSelected ? 'suggestion' : undefined}>
                            {isSelected ? figures.pointer : ' '} {setting.label}
                          </Text>
                        </Box>
                        <Box flexGrow={1}>
                          {setting.type === 'boolean' ? (
                            <>
                              <Text color={isSelected ? 'suggestion' : undefined}>{setting.value.toString()}</Text>
                              {showThinkingWarning && setting.id === 'thinkingEnabled' && (
                                <Text color="warning">
                                  {' '}
                                  {zh(
                                    'Changing thinking mode mid-conversation will increase latency and may reduce quality.',
                                    '对话中途切换思考模式会增加延迟，并可能降低质量。',
                                  )}
                                </Text>
                              )}
                            </>
                          ) : setting.id === 'theme' ? (
                            <Text color={isSelected ? 'suggestion' : undefined}>
                              {THEME_LABELS[setting.value.toString()] ?? setting.value.toString()}
                            </Text>
                          ) : setting.id === 'notifChannel' ? (
                            <Text color={isSelected ? 'suggestion' : undefined}>
                              <NotifChannelLabel value={setting.value.toString()} />
                            </Text>
                          ) : setting.id === 'defaultPermissionMode' ? (
                            <Text color={isSelected ? 'suggestion' : undefined}>
                              {permissionModeShortTitle(setting.value as PermissionMode)}
                            </Text>
                          ) : setting.id === 'autoUpdatesChannel' && autoUpdaterDisabledReason ? (
                            <Box flexDirection="column">
                              <Text color={isSelected ? 'suggestion' : undefined}>disabled</Text>
                              <Text dimColor>({formatAutoUpdaterDisabledReason(autoUpdaterDisabledReason)})</Text>
                            </Box>
                          ) : (
                            <Text color={isSelected ? 'suggestion' : undefined}>{setting.value.toString()}</Text>
                          )}
                        </Box>
                      </Box>
                    </React.Fragment>
                  );
                })}
                {scrollOffset + maxVisible < filteredSettingsItems.length && (
                  <Text dimColor>
                    {figures.arrowDown}{' '}
                    {zh(
                      `${filteredSettingsItems.length - scrollOffset - maxVisible} more below`,
                      `${filteredSettingsItems.length - scrollOffset - maxVisible} 项在下方`,
                    )}
                  </Text>
                )}
              </>
            )}
          </Box>
          {headerFocused ? (
            <Text dimColor>
              <Byline>
                <KeyboardShortcutHint shortcut="←/→ tab" action="switch" />
                <KeyboardShortcutHint shortcut="↓" action="return" />
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Settings"
                  fallback="Esc"
                  description={zh('close', '关闭')}
                />
              </Byline>
            </Text>
          ) : isSearchMode ? (
            <Text dimColor>
              <Byline>
                <Text>{zh('Type to filter', '输入以筛选')}</Text>
                <KeyboardShortcutHint shortcut="Enter/↓" action="select" />
                <KeyboardShortcutHint shortcut="↑" action="tabs" />
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Settings"
                  fallback="Esc"
                  description={zh('clear', '清除')}
                />
              </Byline>
            </Text>
          ) : (
            <Text dimColor>
              <Byline>
                <ConfigurableShortcutHint
                  action="select:accept"
                  context="Settings"
                  fallback="Space"
                  description={zh('change', '更改')}
                />
                <ConfigurableShortcutHint
                  action="settings:close"
                  context="Settings"
                  fallback="Enter"
                  description={zh('save', '保存')}
                />
                <ConfigurableShortcutHint
                  action="settings:search"
                  context="Settings"
                  fallback="/"
                  description={zh('search', '搜索')}
                />
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Settings"
                  fallback="Esc"
                  description={zh('cancel', '取消')}
                />
              </Byline>
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function teammateModelDisplayString(value: string | null | undefined): string {
  if (value === undefined) {
    return modelDisplayString(getHardcodedTeammateModelFallback());
  }
  if (value === null) return zh("Default (leader's model)", '默认（队友模型）');
  return modelDisplayString(value);
}

const THEME_LABELS: Record<string, string> = {
  auto: zh('Auto (match terminal)', '自动（匹配终端）'),
  dark: zh('Dark mode', '深色模式'),
  light: zh('Light mode', '浅色模式'),
  'dark-daltonized': zh('Dark mode (colorblind-friendly)', '深色模式（色盲友好）'),
  'light-daltonized': zh('Light mode (colorblind-friendly)', '浅色模式（色盲友好）'),
  'dark-ansi': zh('Dark mode (ANSI colors only)', '深色模式（仅 ANSI 颜色）'),
  'light-ansi': zh('Light mode (ANSI colors only)', '浅色模式（仅 ANSI 颜色）'),
};

function NotifChannelLabel({ value }: { value: string }): React.ReactNode {
  switch (value) {
    case 'auto':
      return zh('Auto', '自动');
    case 'iterm2':
      return (
        <Text>
          iTerm2 <Text dimColor>(OSC 9)</Text>
        </Text>
      );
    case 'terminal_bell':
      return (
        <Text>
          {zh('Terminal Bell ', '终端铃声 ')}
          <Text dimColor>(\a)</Text>
        </Text>
      );
    case 'kitty':
      return (
        <Text>
          Kitty <Text dimColor>(OSC 99)</Text>
        </Text>
      );
    case 'ghostty':
      return (
        <Text>
          Ghostty <Text dimColor>(OSC 777)</Text>
        </Text>
      );
    case 'iterm2_with_bell':
      return zh('iTerm2 w/ Bell', 'iTerm2 + 铃声');
    case 'notifications_disabled':
      return zh('Disabled', '已禁用');
    default:
      return value;
  }
}
