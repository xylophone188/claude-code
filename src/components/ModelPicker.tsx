import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { has1mContext } from '../utils/context.js';
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import {
  FAST_MODE_MODEL_DISPLAY,
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
} from 'src/utils/fastMode.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import {
  convertEffortValueToLevel,
  type EffortLevel,
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
  resolvePickerEffortPersistence,
  toPersistableEffort,
} from '../utils/effort.js';
import { zh } from '../utils/i18n.js';
import {
  getDefaultMainLoopModel,
  type ModelSetting,
  modelDisplayString,
  parseUserSpecifiedModel,
} from '../utils/model/model.js';
import { getModelOptions, type ModelOption } from '../utils/model/modelOptions.js';
import {
  getProviderCatalog,
  getProviderContent,
  getProviderList,
  PROVIDER_ADD,
  PROVIDER_ADVISOR,
  PROVIDER_AUTO,
  PROVIDER_CCB,
  PROVIDER_DEFAULT,
  PROVIDER_DELETE,
  PROVIDER_SWITCH,
} from '../utils/model/opencodeFree.js';
import {
  addRegisteredProvider,
  getLocalGatewayName,
  removeRegisteredProvider,
  setLocalGatewayName,
} from '../utils/model/providerRegistry.js';
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/index.js';
import { Byline, KeyboardShortcutHint, Pane } from '@anthropic/ink';
import { effortLevelToSymbol } from './EffortIndicator.js';
import TextInput from './TextInput.js';

export type Props = {
  initial: string | null;
  sessionModel?: ModelSetting;
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void;
  onCancel?: () => void;
  isStandaloneCommand?: boolean;
  showFastModeNotice?: boolean;
  /** Overrides the dim header line below "Select model". */
  headerText?: string;
  /**
   * When true, skip writing effortLevel to userSettings on selection.
   * Used by the assistant installer wizard where the model choice is
   * project-scoped (written to the assistant's .claude/settings.json via
   * install.ts) and should not leak to the user's global ~/.claude/settings.
   */
  skipSettingsWrite?: boolean;
};

const NO_PREFERENCE = '__NO_PREFERENCE__';

/**
 * Multi-phase /model picker state machine (standalone command only):
 * 'provider'     → level-1 list: free first, registered providers, "添加供应商" last
 * 'catalog'      → provider catalog (from "添加供应商"), pick one to name & register
 * 'naming'       → TextInput for the display name, Enter registers / renames
 * 'subprovider'  → CCB sub-provider list
 * 'content'      → final model/combo list (phase 2, effort + 1M controls)
 */
type Phase = 'provider' | 'content' | 'subprovider' | 'catalog' | 'naming' | 'delete';

type NamingTarget =
  | { kind: 'ccb' } // rename CCB
  | { kind: 'provider'; providerId: string; defaultName: string };

type SelectOption = Omit<ModelOption, 'value'> & { value: string };

function toSelectOptions(options: ModelOption[]): SelectOption[] {
  return options.flatMap(option => (option.value === null ? [] : [{ ...option, value: option.value }]));
}

export function ModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand,
  showFastModeNotice,
  headerText,
  skipSettingsWrite,
}: Props): React.ReactNode {
  const setAppState = useSetAppState();
  const exitState = useExitOnCtrlCDWithKeybindings();
  const maxVisible = 10;

  const initialValue = initial === null ? NO_PREFERENCE : initial;
  const [focusedValue, setFocusedValue] = useState<string | undefined>(initialValue);

  const isFastMode = useAppState(s => (isFastModeEnabled() ? s.fastMode : false));

  const [marked1MValues, setMarked1MValues] = useState<Set<string>>(
    () => new Set(has1mContext(initialValue) ? [initialValue.replace(/\[1m\]/i, '')] : []),
  );

  // Phase machine state. `provider` is the id whose content is shown in the
  // 'content'/'subprovider' phases.
  const [phase, setPhase] = useState<Phase>('provider');
  const [provider, setProvider] = useState<string | null>(null);
  const [providerOptions, setProviderOptions] = useState<ModelOption[]>([]);
  const [contentOptions, setContentOptions] = useState<ModelOption[] | null>(null);
  const [infoLines, setInfoLines] = useState<string[]>([]);
  const [subproviderOptions, setSubproviderOptions] = useState<ModelOption[] | null>(null);
  const [catalogOptions, setCatalogOptions] = useState<ModelOption[] | null>(null);
  const [namingTarget, setNamingTarget] = useState<NamingTarget | null>(null);
  const [namingValue, setNamingValue] = useState('');
  const [namingCursor, setNamingCursor] = useState(0);
  // Bump to re-fetch the provider list after registering/renaming a provider.
  const [refreshKey, setRefreshKey] = useState(0);

  React.useEffect(() => {
    if (!isStandaloneCommand) return;
    let cancelled = false;
    void getProviderList()
      .then(opts => {
        if (!cancelled) setProviderOptions(opts);
      })
      .catch(() => {
        if (!cancelled) setProviderOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isStandaloneCommand, refreshKey]);

  async function openProvider(id: string): Promise<void> {
    if (id === PROVIDER_ADD) {
      setPhase('catalog');
      setCatalogOptions(null);
      try {
        setCatalogOptions(await getProviderCatalog());
      } catch {
        setCatalogOptions([]);
      }
      return;
    }
    setProvider(id);
    setContentOptions(null);
    setInfoLines([]);
    setPhase('content');
    try {
      const content = await getProviderContent(id);
      if (content.kind === 'info') {
        // Read-only explainer (auto routing): show the pool + scoring policy,
        // no selection. Esc returns to the provider list. contentOptions is
        // set to [] so the render order (loading → info → empty → select)
        // reaches the info panel instead of hanging on the loading pane.
        setContentOptions([]);
        setInfoLines(content.lines ?? []);
      } else if (content.kind === 'subproviders') {
        setSubproviderOptions(content.options);
        setPhase('subprovider');
      } else if (content.kind === 'delete') {
        setSubproviderOptions(content.options);
        setPhase('delete');
      } else {
        // 'models' and 'combos' both render in the content phase; combos are
        // directly selectable and the data layer
        // reports effort as unsupported for them.
        setContentOptions(content.options);
      }
    } catch {
      setContentOptions([]);
    }
  }

  function openSubprovider(value: string): void {
    setProvider(value);
    setContentOptions(null);
    setInfoLines([]);
    setPhase('content');
    void getProviderContent(value)
      .then(res => setContentOptions(res.options))
      .catch(() => setContentOptions([]));
  }

  function handleCatalogSelect(value: string): void {
    const option = catalogOptions?.find(o => o.value === value);
    setNamingTarget(
      value === PROVIDER_CCB
        ? { kind: 'ccb' }
        : {
            kind: 'provider',
            providerId: value,
            defaultName: option?.label ?? value,
          },
    );
    setNamingValue('');
    setPhase('naming');
  }

  const backToProvider = useCallback(() => {
    setNamingTarget(null);
    setNamingValue('');
    setPhase('provider');
  }, []);

  function submitNaming(): void {
    if (!namingTarget) return;
    const name = namingValue.trim();
    const finalName = name || (namingTarget.kind === 'ccb' ? getLocalGatewayName() : namingTarget.defaultName);
    if (namingTarget.kind === 'ccb') {
      setLocalGatewayName(finalName);
    } else {
      addRegisteredProvider({
        providerId: namingTarget.providerId,
        name: finalName,
      });
    }
    setNamingTarget(null);
    setNamingValue('');
    setRefreshKey(k => k + 1);
    setPhase('provider');
  }

  // Esc inside the naming input aborts back to the provider list.
  useKeybinding('confirm:no', backToProvider, {
    context: 'Settings',
    isActive: isStandaloneCommand === true && phase === 'naming',
  });

  const routingPanelActive =
    isStandaloneCommand === true &&
    phase === 'content' &&
    infoLines.length > 0 &&
    (provider === PROVIDER_AUTO || provider === PROVIDER_ADVISOR);

  // Esc returns to providers; Enter selects the routing mode shown.
  useKeybindings(
    {
      'select:cancel': backToProvider,
      'select:accept': () => handleSelect(provider ?? PROVIDER_AUTO),
    },
    {
      context: 'Select',
      isActive: routingPanelActive,
    },
  );

  const handleToggle1M = useCallback(() => {
    if (!focusedValue || focusedValue === NO_PREFERENCE) return;
    // Key on the base value so lookups in handleSelect / is1MMarked match the
    // initializer — predefined 1M options arrive with a `[1m]` suffix in
    // `focusedValue`, which would diverge from the base-value key set.
    const baseKey = focusedValue.replace(/\[1m\]/i, '');
    setMarked1MValues(prev => {
      const next = new Set(prev);
      if (next.has(baseKey)) {
        next.delete(baseKey);
      } else {
        next.add(baseKey);
      }
      return next;
    });
  }, [focusedValue]);

  const [hasToggledEffort, setHasToggledEffort] = useState(false);
  const effortValue = useAppState(s => s.effortValue);
  const [effort, setEffort] = useState<EffortLevel | undefined>(
    effortValue !== undefined ? convertEffortValueToLevel(effortValue) : undefined,
  );

  // Memoize all derived values to prevent re-renders. In the content phase the
  // list is the provider's models (or combos); otherwise the base options.
  const modelOptions = useMemo(() => {
    if (isStandaloneCommand && contentOptions !== null) {
      return contentOptions;
    }
    return getModelOptions(isFastMode ?? false);
  }, [isFastMode, isStandaloneCommand, contentOptions]);

  // Phase 1 default provider is the first option (free).
  const providerSelectOptions = useMemo(() => toSelectOptions(providerOptions), [providerOptions]);
  const catalogSelectOptions = useMemo(() => toSelectOptions(catalogOptions ?? []), [catalogOptions]);
  const subproviderSelectOptions = useMemo(() => toSelectOptions(subproviderOptions ?? []), [subproviderOptions]);
  const providerFocusValue = providerSelectOptions[0]?.value;

  // Ensure the initial value is in the options list
  // This handles edge cases where the user's current model (e.g., 'haiku' for 3P users)
  // is not in the base options but should still be selectable and shown as selected
  const optionsWithInitial = useMemo(() => {
    if (initial !== null && !modelOptions.some(opt => opt.value === initial)) {
      return [
        ...modelOptions,
        {
          value: initial,
          label: modelDisplayString(initial),
          description: zh('Current model', '当前模型'),
        },
      ];
    }
    return modelOptions;
  }, [modelOptions, initial]);

  const selectOptions = useMemo(
    () =>
      optionsWithInitial.map(opt => ({
        ...opt,
        value: opt.value === null ? NO_PREFERENCE : opt.value,
      })),
    [optionsWithInitial],
  );
  const initialFocusValue = useMemo(
    () => (selectOptions.some(_ => _.value === initialValue) ? initialValue : (selectOptions[0]?.value ?? undefined)),
    [selectOptions, initialValue],
  );
  const visibleCount = Math.min(maxVisible, selectOptions.length);
  const hiddenCount = Math.max(0, selectOptions.length - visibleCount);

  const focusedModelName = selectOptions.find(opt => opt.value === focusedValue)?.label;
  const focusedModel = resolveOptionModel(focusedValue);
  const is1MMarked =
    focusedValue !== undefined &&
    focusedValue !== NO_PREFERENCE &&
    marked1MValues.has(focusedValue.replace(/\[1m\]/i, ''));
  const focusedSupportsEffort = focusedModel ? modelSupportsEffort(focusedModel) : false;
  const focusedSupportsXhigh = focusedModel ? modelSupportsXhighEffort(focusedModel) : false;
  const focusedSupportsMax = focusedModel ? modelSupportsMaxEffort(focusedModel) : false;
  const focusedDefaultEffort = getDefaultEffortLevelForOption(focusedValue);
  // Clamp display when selected effort isn't supported by the focused model.
  // resolveAppliedEffort() does the same downgrade at API-send time.
  const displayEffort =
    effort === 'max' && !focusedSupportsMax
      ? focusedSupportsXhigh
        ? 'xhigh'
        : 'high'
      : effort === 'xhigh' && !focusedSupportsXhigh
        ? 'high'
        : effort;

  const handleFocus = useCallback(
    (value: string) => {
      setFocusedValue(value);
      if (!hasToggledEffort && effortValue === undefined) {
        setEffort(getDefaultEffortLevelForOption(value));
      }
    },
    [hasToggledEffort, effortValue],
  );

  // Effort level cycling keybindings
  const handleCycleEffort = useCallback(
    (direction: 'left' | 'right') => {
      if (!focusedSupportsEffort) return;
      setEffort(prev =>
        cycleEffortLevel(prev ?? focusedDefaultEffort, direction, focusedSupportsXhigh, focusedSupportsMax),
      );
      setHasToggledEffort(true);
    },
    [focusedSupportsEffort, focusedSupportsXhigh, focusedSupportsMax, focusedDefaultEffort],
  );

  useKeybindings(
    {
      'modelPicker:decreaseEffort': () => handleCycleEffort('left'),
      'modelPicker:increaseEffort': () => handleCycleEffort('right'),
      'modelPicker:toggle1M': () => handleToggle1M(),
    },
    { context: 'ModelPicker' },
  );

  function handleSelect(value: string): void {
    logEvent('tengu_model_command_menu_effort', {
      effort: effort as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    if (!skipSettingsWrite) {
      // Prior comes from userSettings on disk — NOT merged settings (which
      // includes project/policy layers that must not leak into the user's
      // global ~/.claude/settings.json), and NOT AppState.effortValue (which
      // includes session-ephemeral sources like --effort CLI flag).
      // See resolvePickerEffortPersistence JSDoc.
      const effortLevel = resolvePickerEffortPersistence(
        effort,
        getDefaultEffortLevelForOption(value),
        getSettingsForSource('userSettings')?.effortLevel,
        hasToggledEffort,
      );
      const persistable = toPersistableEffort(effortLevel);
      if (persistable !== undefined) {
        updateSettingsForSource('userSettings', { effortLevel: persistable });
      }
      setAppState(prev => ({ ...prev, effortValue: effortLevel }));
    }

    const selectedModel = resolveOptionModel(value);
    const selectedEffort = hasToggledEffort && selectedModel && modelSupportsEffort(selectedModel) ? effort : undefined;
    if (value === NO_PREFERENCE) {
      onSelect(null, selectedEffort);
      return;
    }
    // Apply or strip [1m] suffix based on user toggle. marked1MValues is keyed
    // on the base value (see initializer + handleToggle1M), so look up with the
    // base form — not `value`, which may carry a `[1m]` suffix from predefined
    // 1M options and would never match.
    const baseValue = value.replace(/\[1m\]/i, '');
    const wants1M = marked1MValues.has(baseValue);
    const finalValue = wants1M ? `${baseValue}[1m]` : baseValue;
    onSelect(finalValue, selectedEffort);
  }

  const content = (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color="remember" bold>
            {zh('Select model', '选择模型')}
          </Text>
          <Text dimColor>
            {headerText ??
              zh(
                'Choose a model for this and future sessions. Use ← → to adjust effort, Space to toggle 1M context.',
                '为当前及后续会话选择模型。← → 调整思考等级，Space 切换 1M 上下文。',
              )}
          </Text>
          {sessionModel && (
            <Text dimColor>
              Currently using {modelDisplayString(sessionModel)} for this session (set by plan mode). Selecting a model
              will undo this.
            </Text>
          )}
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="column">
            <Select
              defaultValue={initialValue}
              defaultFocusValue={initialFocusValue}
              options={selectOptions}
              onChange={handleSelect}
              onFocus={handleFocus}
              onCancel={onCancel ?? (() => {})}
              visibleOptionCount={visibleCount}
            />
          </Box>
          {hiddenCount > 0 && (
            <Box paddingLeft={3}>
              <Text dimColor>{zh(`and ${hiddenCount} more…`, `还有 ${hiddenCount} 个…`)}</Text>
            </Box>
          )}
        </Box>

        <Box marginBottom={1} flexDirection="column">
          {focusedSupportsEffort ? (
            <Text dimColor>
              <EffortLevelIndicator effort={displayEffort} /> {capitalize(displayEffort)} effort
              {displayEffort === focusedDefaultEffort ? ` ${zh('(default)', '（默认）')}` : ``}{' '}
              <Text color="subtle">{zh('← → to adjust', '← → 调整')}</Text>
            </Text>
          ) : (
            <Text color="subtle">
              <EffortLevelIndicator effort={undefined} /> {zh('Effort not supported', '不支持')}
              {focusedModelName ? ` for ${focusedModelName}` : ''}
            </Text>
          )}
          {is1MMarked ? (
            <Text dimColor>
              <EffortLevelIndicator effort={'high'} /> {zh('1M context on', '1M 上下文开启')}
              <Text color="subtle">{zh(' · Space to toggle', ' · Space 切换')}</Text>
            </Text>
          ) : (
            <Text color="subtle">
              <EffortLevelIndicator effort={undefined} /> {zh('1M context off', '1M 上下文关闭')}
              {focusedModelName ? ` for ${focusedModelName}` : ''}
              <Text color="subtle">{zh(' · Space to toggle', ' · Space 切换')}</Text>
            </Text>
          )}
        </Box>

        {isFastModeEnabled() ? (
          showFastModeNotice ? (
            <Box marginBottom={1}>
              <Text dimColor>
                Fast mode is <Text bold>ON</Text> and available with {FAST_MODE_MODEL_DISPLAY} only (/fast). Switching
                to other models turn off fast mode.
              </Text>
            </Box>
          ) : isFastModeAvailable() && !isFastModeCooldown() ? (
            <Box marginBottom={1}>
              <Text dimColor>
                Use <Text bold>/fast</Text> to turn on Fast mode ({FAST_MODE_MODEL_DISPLAY} only).
              </Text>
            </Box>
          ) : null
        ) : null}

        <Text dimColor italic>
          {exitState.pending ? (
            <>Press {exitState.keyName} again to exit</>
          ) : (
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint action="select:cancel" context="Select" fallback="Esc" description="exit" />
            </Byline>
          )}
        </Text>
      </Box>
    </Box>
  );

  function paneHeader(title: string, hint?: string): React.ReactNode {
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text color="remember" bold>
          {title}
        </Text>
        {hint !== undefined && <Text dimColor>{hint}</Text>}
      </Box>
    );
  }

  function byline(): React.ReactNode {
    return (
      <Text dimColor italic>
        {exitState.pending ? (
          <>Press {exitState.keyName} again to exit</>
        ) : (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <ConfigurableShortcutHint action="select:cancel" context="Select" fallback="Esc" description="exit" />
          </Byline>
        )}
      </Text>
    );
  }

  // Quick-switch keybinding path (not standalone /model): single model list.
  if (!isStandaloneCommand) {
    return <Pane color="permission">{content}</Pane>;
  }

  // Phase: provider list — free first, registered providers, "添加供应商" last.
  if (phase === 'provider') {
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          {paneHeader(zh('Select a provider', '选择供应商'))}
          <Box flexDirection="column" marginBottom={1}>
            {providerOptions.length === 0 ? (
              <Text dimColor>{zh('Loading providers…', '加载供应商…')}</Text>
            ) : (
              <Select
                defaultValue={providerFocusValue}
                defaultFocusValue={providerFocusValue}
                options={providerSelectOptions}
                onChange={value => void openProvider(value)}
                onCancel={onCancel ?? (() => {})}
                visibleOptionCount={Math.min(maxVisible, providerSelectOptions.length)}
              />
            )}
          </Box>
          {byline()}
        </Box>
      </Pane>
    );
  }

  // Phase: provider catalog (from "添加供应商").
  if (phase === 'catalog') {
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          {paneHeader(
            zh('Add a provider from the catalog', '从目录添加供应商'),
            zh('Pick a provider, then name it on the next screen', '选择一个供应商，输入显示名后回车确认'),
          )}
          <Box flexDirection="column" marginBottom={1}>
            {catalogOptions === null ? (
              <Text dimColor>{zh('Loading catalog…', '加载目录…')}</Text>
            ) : catalogOptions.length === 0 ? (
              <Text dimColor>{zh('The catalog is empty.', '目录为空')}</Text>
            ) : (
              <Select
                defaultValue={catalogSelectOptions[0]?.value}
                defaultFocusValue={catalogSelectOptions[0]?.value}
                options={catalogSelectOptions}
                onChange={handleCatalogSelect}
                onCancel={backToProvider}
                visibleOptionCount={Math.min(maxVisible, catalogSelectOptions.length)}
              />
            )}
          </Box>
          {byline()}
        </Box>
      </Pane>
    );
  }

  // Phase: naming — display name for a new provider or CCB.
  if (phase === 'naming') {
    const placeholder = namingTarget?.kind === 'ccb' ? getLocalGatewayName() : (namingTarget?.defaultName ?? '');
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          {paneHeader(
            zh('Name the provider', '为供应商命名'),
            zh('Type a display name, Enter to confirm, Esc to go back', '输入显示名称，回车确认，Esc 返回'),
          )}
          <Box flexDirection="row" marginBottom={1} gap={1}>
            <Text>›</Text>
            <TextInput
              value={namingValue}
              onChange={setNamingValue}
              onSubmit={submitNaming}
              focus={true}
              showCursor={true}
              placeholder={placeholder}
              columns={60}
              cursorOffset={namingCursor}
              onChangeCursorOffset={setNamingCursor}
            />
          </Box>
          {byline()}
        </Box>
      </Pane>
    );
  }

  // Phase: CCB provider list.
  if (phase === 'subprovider') {
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          {paneHeader(zh('Choose a sub-provider', '选择一个子供应商'))}
          <Box flexDirection="column" marginBottom={1}>
            {subproviderOptions === null ? (
              <Text dimColor>{zh('Loading sub-providers…', '加载子供应商…')}</Text>
            ) : subproviderOptions.length === 0 ? (
              <Text dimColor>{zh('No sub-providers available.', '该供应商暂无可用子供应商')}</Text>
            ) : (
              <Select
                defaultValue={subproviderSelectOptions[0]?.value}
                defaultFocusValue={subproviderSelectOptions[0]?.value}
                options={subproviderSelectOptions}
                onChange={openSubprovider}
                onCancel={backToProvider}
                visibleOptionCount={Math.min(maxVisible, subproviderSelectOptions.length)}
              />
            )}
          </Box>
          {byline()}
        </Box>
      </Pane>
    );
  }

  // Phase: content — models (or directly selectable combos).
  if (contentOptions === null) {
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Text dimColor>{zh('Loading models…', '加载模型…')}</Text>
        </Box>
      </Pane>
    );
  }
  if (infoLines.length > 0) {
    // Routing policy panel. Enter confirms.
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          {paneHeader(
            provider === PROVIDER_ADVISOR ? zh('Advisor routing', '顾问路由') : zh('Auto routing', '自动路由'),
            zh('Enter to confirm · Esc to go back', 'Enter 确认 · Esc 返回'),
          )}
          <Box flexDirection="column" marginBottom={1}>
            {infoLines.map((line, i) => (
              <Text key={i} dimColor>
                {line}
              </Text>
            ))}
          </Box>
          {byline()}
        </Box>
      </Pane>
    );
  }
  if (contentOptions.length === 0) {
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Text dimColor>{zh('No models available for this provider.', '该供应商暂无可用模型')}</Text>
        </Box>
      </Pane>
    );
  }
  return <Pane color="permission">{content}</Pane>;
}

function resolveOptionModel(value: string | undefined): string | null {
  if (!value || value === NO_PREFERENCE) return null;
  return parseUserSpecifiedModel(value);
}

function getDefaultEffortLevelForOption(value: string | undefined): EffortLevel {
  const model = resolveOptionModel(value);
  const source =
    (model ? getDefaultEffortForModel(model) : undefined) ?? getDefaultEffortForModel(getDefaultMainLoopModel());
  return source === undefined ? 'medium' : convertEffortValueToLevel(source);
}

function EffortLevelIndicator({ effort }: { effort?: EffortLevel }): React.ReactNode {
  return <Text color={effort ? 'claude' : 'subtle'}>{effortLevelToSymbol(effort ?? 'low')}</Text>;
}

function cycleEffortLevel(
  current: EffortLevel,
  direction: 'left' | 'right',
  supportsXhigh: boolean,
  supportsMax: boolean,
): EffortLevel {
  const levels: EffortLevel[] = [
    'low',
    'medium',
    'high',
    ...(supportsXhigh ? (['xhigh'] as EffortLevel[]) : []),
    ...(supportsMax ? (['max'] as EffortLevel[]) : []),
  ];
  const index = levels.indexOf(current);
  if (index === -1) {
    return levels.includes('high') ? 'high' : 'low';
  }
  return levels[(index + (direction === 'left' ? -1 : 1) + levels.length) % levels.length]!;
}
