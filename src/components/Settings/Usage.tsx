import * as React from 'react';
import { useEffect, useState } from 'react';
import { extraUsage as extraUsageCommand } from 'src/commands/extra-usage/index.js';
import { formatCost } from 'src/cost-tracker.js';
import { getSubscriptionType } from 'src/utils/auth.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { type ExtraUsage, fetchUtilization, type RateLimit, type Utilization } from '../../services/api/usage.js';
import { formatResetText } from '../../utils/format.js';
import { logError } from '../../utils/log.js';
import { jsonStringify } from '../../utils/slowOperations.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Byline, ProgressBar } from '@anthropic/ink';
import { isEligibleForOverageCreditGrant, OverageCreditUpsell } from '../LogoV2/OverageCreditUpsell.js';
import { zh } from '../../utils/i18n.js';

type LimitBarProps = {
  title: string;
  limit: RateLimit;
  maxWidth: number;
  showTimeInReset?: boolean;
  extraSubtext?: string;
};

function LimitBar({ title, limit, maxWidth, showTimeInReset = true, extraSubtext }: LimitBarProps): React.ReactNode {
  const { utilization, resets_at } = limit;
  if (utilization === null) {
    return null;
  }

  // Calculate usage percentage
  const usedText = zh(`${Math.floor(utilization)}% used`, `${Math.floor(utilization)}% 已用`);

  let subtext: string | undefined;
  if (resets_at) {
    const resetText = formatResetText(resets_at, true, showTimeInReset);
    subtext = zh(`Resets ${resetText}`, `重置时间 ${resetText}`);
  }

  if (extraSubtext) {
    if (subtext) {
      subtext = `${extraSubtext} · ${subtext}`;
    } else {
      subtext = extraSubtext;
    }
  }

  const maxBarWidth = 50;
  const usedLabelSpace = 12;
  if (maxWidth >= maxBarWidth + usedLabelSpace) {
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Box flexDirection="row" gap={1}>
          <ProgressBar
            ratio={utilization / 100}
            width={maxBarWidth}
            fillColor="rate_limit_fill"
            emptyColor="rate_limit_empty"
          />
          <Text>{usedText}</Text>
        </Box>
        {subtext && <Text dimColor>{subtext}</Text>}
      </Box>
    );
  } else {
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{title}</Text>
          {subtext && (
            <>
              <Text> </Text>
              <Text dimColor>· {subtext}</Text>
            </>
          )}
        </Text>
        <ProgressBar
          ratio={utilization / 100}
          width={maxWidth}
          fillColor="rate_limit_fill"
          emptyColor="rate_limit_empty"
        />
        <Text>{usedText}</Text>
      </Box>
    );
  }
}

export function Usage(): React.ReactNode {
  const [utilization, setUtilization] = useState<Utilization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { columns } = useTerminalSize();

  const availableWidth = columns - 2; // 2 for screen padding
  const maxWidth = Math.min(availableWidth, 80);

  const loadUtilization = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchUtilization();
      setUtilization(data);
    } catch (err) {
      logError(err as Error);
      const axiosError = err as { response?: { data?: unknown } };
      const responseBody = axiosError.response?.data ? jsonStringify(axiosError.response.data) : undefined;
      setError(
        responseBody
          ? zh(`Failed to load usage data: ${responseBody}`, `加载用量数据失败：${responseBody}`)
          : zh('Failed to load usage data', '加载用量数据失败'),
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUtilization();
  }, [loadUtilization]);

  useKeybinding(
    'settings:retry',
    () => {
      void loadUtilization();
    },
    { context: 'Settings', isActive: !!error && !isLoading },
  );

  if (error) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">
          {zh('Error: ', '错误：')}
          {error}
        </Text>
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint
              action="settings:retry"
              context="Settings"
              fallback="r"
              description={zh('retry', '重试')}
            />
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Settings"
              fallback="Esc"
              description={zh('cancel', '取消')}
            />
          </Byline>
        </Text>
      </Box>
    );
  }

  if (!utilization) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{zh('Loading usage data…', '加载用量…')}</Text>
        <Text dimColor>
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Settings"
            fallback="Esc"
            description={zh('cancel', '取消')}
          />
        </Text>
      </Box>
    );
  }

  // Only Max and Team plans have a Sonnet limit that differs from the weekly
  // limit (see rateLimitMessages.ts). For other plans the bar is redundant.
  // Show for null (unknown plan) to stay consistent with rateLimitMessages.ts,
  // which labels it "Sonnet limit" in that case.
  const subscriptionType = getSubscriptionType();
  const showSonnetBar = subscriptionType === 'max' || subscriptionType === 'team' || subscriptionType === null;

  const limits = [
    {
      title: zh('Current session', '当前会话'),
      limit: utilization.five_hour,
    },
    {
      title: zh('Current week (all models)', '本周（所有模型）'),
      limit: utilization.seven_day,
    },
    ...(showSonnetBar
      ? [
          {
            title: zh('Current week (Sonnet only)', '本周（仅 Sonnet）'),
            limit: utilization.seven_day_sonnet,
          },
        ]
      : []),
  ];

  return (
    <Box flexDirection="column" gap={1} width="100%">
      {limits.some(({ limit }) => limit) || (
        <Text dimColor>{zh('/usage is only available for subscription plans.', '/usage 仅限订阅方案使用。')}</Text>
      )}

      {limits.map(
        ({ title, limit }) => limit && <LimitBar key={title} title={title} limit={limit} maxWidth={maxWidth} />,
      )}

      {utilization.extra_usage && <ExtraUsageSection extraUsage={utilization.extra_usage} maxWidth={maxWidth} />}

      {isEligibleForOverageCreditGrant() && <OverageCreditUpsell maxWidth={maxWidth} />}

      <Text dimColor>
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Settings"
          fallback="Esc"
          description={zh('cancel', '取消')}
        />
      </Text>
    </Box>
  );
}

type ExtraUsageSectionProps = {
  extraUsage: ExtraUsage;
  maxWidth: number;
};

const EXTRA_USAGE_SECTION_TITLE = zh('Extra usage', '额外用量');

function ExtraUsageSection({ extraUsage, maxWidth }: ExtraUsageSectionProps): React.ReactNode {
  const subscriptionType = getSubscriptionType();
  const isProOrMax = subscriptionType === 'pro' || subscriptionType === 'max';
  if (!isProOrMax) {
    // Only show to Pro and Max, consistent with claude.ai non-admin usage settings
    return false;
  }

  if (!extraUsage.is_enabled) {
    if (extraUsageCommand.isEnabled()) {
      return (
        <Box flexDirection="column">
          <Text bold>{EXTRA_USAGE_SECTION_TITLE}</Text>
          <Text dimColor>
            {zh('Extra usage not enabled · /extra-usage to enable', '额外用量未启用 • /extra-usage 启用')}
          </Text>
        </Box>
      );
    }

    return null;
  }

  if (extraUsage.monthly_limit === null) {
    return (
      <Box flexDirection="column">
        <Text bold>{EXTRA_USAGE_SECTION_TITLE}</Text>
        <Text dimColor>{zh('Unlimited', '无限制')}</Text>
      </Box>
    );
  }

  if (typeof extraUsage.used_credits !== 'number' || typeof extraUsage.utilization !== 'number') {
    return null;
  }

  const formattedUsedCredits = formatCost(extraUsage.used_credits / 100, 2);
  const formattedMonthlyLimit = formatCost(extraUsage.monthly_limit / 100, 2);
  const now = new Date();
  const oneMonthReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  return (
    <LimitBar
      title={EXTRA_USAGE_SECTION_TITLE}
      limit={{
        utilization: extraUsage.utilization,
        // Not applicable for enterprises, but for now we don't render this for them
        resets_at: oneMonthReset.toISOString(),
      }}
      showTimeInReset={false}
      extraSubtext={zh(
        `${formattedUsedCredits} / ${formattedMonthlyLimit} spent`,
        `${formattedUsedCredits} / ${formattedMonthlyLimit} 已用`,
      )}
      maxWidth={maxWidth}
    />
  );
}
