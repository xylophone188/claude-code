import { useCallback, useEffect, useState } from 'react';
import { useAppState } from '../state/AppState.js';
import { isLocalWorkflowTask } from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js';
import { Box, Text } from '@anthropic/ink';
import stripAnsi from 'strip-ansi';

import {
  getCurrentTurnTokenBudget,
  getTurnClassifierCount,
  getTurnClassifierDurationMs,
  getTurnHookCount,
  getTurnHookDurationMs,
  getTurnOutputTokens,
  getTurnToolCount,
  getTurnToolDurationMs,
  getTotalCacheReadInputTokens,
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../bootstrap/state.js';
import {
  getActiveCcbRoute,
  getLastOmniRouteError,
  getLastOmniRouteReceipt,
  readFileTail,
} from '../services/omniroute/adapter.js';
import { formatTokens, truncateToWidth } from '../utils/format.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Section = 'pool' | 'stream' | 'warnings';

const ROUTE_POLL_MS = 3_000;
const WARNINGS_POLL_MS = 5_000;
const LOG_TAIL_BYTES = 64 * 1024;
const WARNINGS_MAX = 10;
const LOG_LINE_MAX = 48;
const MAX_PROVIDER_LABEL = 18;
const MAX_POOL_LABEL = 38;
const SEPARATOR = '\u2501'.repeat(14);

const WARN_LOGS: string[] = process.env.CCB_WARN_LOGS?.split(':')
  .map(p => p.trim())
  .filter(Boolean) ?? [
  process.env.CCB_REAL_LOG ?? join(homedir(), '.ccb-embed', 'ccb-real.log'),
  process.env.CCB_ROUTER_LOG ?? join(homedir(), '.ccb-embed', 'router.log'),
  process.env.CCB_PROXY_LOG ?? join(homedir(), '.ccb-embed', 'proxy.log'),
];

interface RoutePanelMeta {
  active: { provider: string; model: string } | null;
  receipt: ReturnType<typeof getLastOmniRouteReceipt>;
}

interface WarningItem {
  level: 'error' | 'warn';
  text: string;
}

function useRouteStats(): RoutePanelMeta {
  const [meta, setMeta] = useState<RoutePanelMeta>({ active: null, receipt: null });

  useEffect(() => {
    const load = () => {
      let active = getActiveCcbRoute();
      const receipt = getLastOmniRouteReceipt();
      if (!active && receipt?.provider && receipt.model) active = { provider: receipt.provider, model: receipt.model };
      setMeta({ active, receipt });
    };
    load();
    const t = setInterval(load, ROUTE_POLL_MS);
    return () => clearInterval(t);
  }, []);

  return meta;
}

function warnLevel(line: string): 'error' | 'warn' | null {
  const reErr = /\b(?!at\b)\berror\b|\bfatal\b|\bunhandled/i;
  if (reErr.test(line)) return 'error';
  if (/\b(?!at\b)\bwarn\w*\b|429|50[0-9]|503|504|quota\b|throttl\w*\b|rate\.lim|ccb-embed|ccb-router/i.test(line))
    return 'warn';
  return null;
}

function getWarningItems(): WarningItem[] {
  const items: WarningItem[] = [];
  const seen = new Set<string>();
  const routeError = getLastOmniRouteError();
  if (routeError) {
    items.push({ level: 'error', text: routeError.slice(0, LOG_LINE_MAX) });
    seen.add(routeError.slice(0, LOG_LINE_MAX));
  }

  for (const path of WARN_LOGS) {
    try {
      const lines = readFileTail(path, LOG_TAIL_BYTES).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        const level = warnLevel(line);
        if (!level) continue;
        const text = stripAnsi(line)
          .replace(/#1?\d+/g, '#N')
          .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '/<uuid>')
          .trim()
          .slice(0, LOG_LINE_MAX);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        items.push({ level, text });
        if (items.length >= WARNINGS_MAX) return items;
      }
    } catch {}
  }

  return items;
}

function useWarningItems(): WarningItem[] {
  const [items, setItems] = useState<WarningItem[]>([]);

  const load = useCallback(() => {
    const next = getWarningItems();
    setItems(previous => (next.length === 0 && previous.length > 0 ? previous : next));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, WARNINGS_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return items;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function RouteReceipt({ receipt }: { receipt: RoutePanelMeta['receipt'] }) {
  if (!receipt) return <Text dimColor>{'等待 OmniRoute 路由回执'}</Text>;
  return (
    <Box flexDirection="column">
      {(receipt.cognitivePool || receipt.cognitiveTask) && (
        <Text>{`路由池 ${receipt.cognitivePool ?? '—'}${receipt.cognitiveTask ? ` · ${receipt.cognitiveTask}` : ''}`}</Text>
      )}
      {receipt.provider && receipt.model && (
        <Text dimColor>{`执行 ${truncateToWidth(`${receipt.provider}/${receipt.model}`, MAX_POOL_LABEL)}`}</Text>
      )}
      {receipt.contextProject && (
        <Text dimColor>{`项目 ${truncateToWidth(receipt.contextProject, MAX_POOL_LABEL)}`}</Text>
      )}
      {receipt.contextSources && (
        <Text dimColor>{`上下文 ${truncateToWidth(receipt.contextSources, MAX_POOL_LABEL)}`}</Text>
      )}
      {receipt.contextCache && <Text dimColor>{`缓存 ${truncateToWidth(receipt.contextCache, MAX_POOL_LABEL)}`}</Text>}
      {receipt.cognitiveContext && (
        <Text dimColor>{`上下文决策 ${truncateToWidth(receipt.cognitiveContext, MAX_POOL_LABEL)}`}</Text>
      )}
      {receipt.cognitiveEffort && (
        <Text dimColor>{`推理 ${truncateToWidth(receipt.cognitiveEffort, MAX_POOL_LABEL)}`}</Text>
      )}
      {receipt.decision && <Text dimColor>{`模型决策 ${truncateToWidth(receipt.decision, MAX_POOL_LABEL)}`}</Text>}
      {receipt.latencyMs != null && <Text dimColor>{`延迟 ${formatMs(receipt.latencyMs)}`}</Text>}
      {receipt.fallbackAttempts != null && <Text dimColor>{`回退 ×${receipt.fallbackAttempts}`}</Text>}
      {receipt.compression && <Text dimColor>{`压缩 ${receipt.compression}`}</Text>}
    </Box>
  );
}

function AgentTaskStats() {
  const taskMap = useAppState(s => s.tasks);
  const tasks = Object.values(taskMap).filter(isLocalWorkflowTask);
  const running = tasks.filter(task => task.status === 'running');
  if (tasks.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text dimColor>{`Agent任务 ${running.length}运行 / ${tasks.length}总计`}</Text>
      {running.slice(0, 3).map(task => (
        <Text key={task.id} dimColor>
          {`· ${task.workflowName}${task.agentCount != null ? ` ×${task.agentCount}` : ''}`}
        </Text>
      ))}
    </Box>
  );
}

function StreamStats() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1500);
    return () => clearInterval(t);
  }, []);

  const inTokens = getTotalInputTokens();
  const cacheRead = getTotalCacheReadInputTokens();
  const outTokens = getTotalOutputTokens();
  const turnOut = getTurnOutputTokens();
  const budget = getCurrentTurnTokenBudget();
  const hookDur = getTurnHookDurationMs();
  const hookCnt = getTurnHookCount();
  const toolDur = getTurnToolDurationMs();
  const toolCnt = getTurnToolCount();
  const clsDur = getTurnClassifierDurationMs();
  const clsCnt = getTurnClassifierCount();

  void tick;

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{'消耗token'}</Text>
        <Text color="ansi:yellow">{`（OmniRoute 计量）`}</Text>
      </Box>
      <Box>
        <Text dimColor>{'输入 '}</Text>
        <Text>{formatTokens(inTokens)}</Text>
        <Text dimColor>{'  命中 '}</Text>
        <Text>{formatTokens(cacheRead)}</Text>
      </Box>
      <Box>
        <Text dimColor>{'输出 '}</Text>
        <Text>{formatTokens(outTokens)}</Text>
        {turnOut > 0 && <Text dimColor>{` (${formatTokens(turnOut)})`}</Text>}
        {budget != null && <Text dimColor>{` [${formatTokens(budget)}]`}</Text>}
      </Box>
      <Text dimColor>{'  ──'}</Text>
      {hookCnt > 0 && <Text dimColor>{`钩子 ${formatMs(hookDur)} ×${hookCnt}`}</Text>}
      {toolCnt > 0 && <Text dimColor>{`工具 ${formatMs(toolDur)} ×${toolCnt}`}</Text>}
      {clsCnt > 0 && <Text dimColor>{`分类 ${formatMs(clsDur)} ×${clsCnt}`}</Text>}
    </Box>
  );
}

function WarningsPanel({ items }: { items: WarningItem[] }) {
  return (
    <Box flexDirection="column">
      {items.length === 0 ? (
        <Box>
          <Text dimColor>{'  · '}无告警</Text>
        </Box>
      ) : (
        items.map(item => (
          <Box key={`${item.level}:${item.text}`}>
            <Text color={item.level === 'error' ? 'ansi:red' : 'ansi:yellow'}>
              {'  · '}
              {item.text}
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}

export function CcbSidePanel() {
  const [collapsed, setCollapsed] = useState<Record<Section, boolean>>({
    pool: false,
    stream: false,
    warnings: false,
  });

  const toggle = (key: Section) => setCollapsed(p => ({ ...p, [key]: !p[key] }));
  const warnings = useWarningItems();
  const meta = useRouteStats();

  return (
    <Box flexDirection="column" width="100%" height="100%" paddingX={1} paddingY={1} overflow="hidden" flexShrink={0}>
      <PanelHeader title="OmniRoute 回执" toggle={() => toggle('pool')} collapsed={collapsed.pool} />
      {!collapsed.pool && <RouteReceipt receipt={meta.receipt} />}
      <AgentTaskStats />
      <PanelHeader title="实时流" toggle={() => toggle('stream')} collapsed={collapsed.stream} />
      {!collapsed.stream && <StreamStats />}
      <PanelHeader
        title="告警"
        toggle={() => toggle('warnings')}
        collapsed={collapsed.warnings}
        count={warnings.length}
      />
      {!collapsed.warnings && <WarningsPanel items={warnings} />}
      <Box flexGrow={1} />
      <Footer active={meta.active} />
    </Box>
  );
}

function PanelHeader({
  title,
  toggle,
  collapsed,
  count,
}: {
  title: string;
  toggle: () => void;
  collapsed: boolean;
  count?: number;
}) {
  return (
    <Box flexDirection="row" width="100%" onClick={toggle}>
      <Text dimColor>{collapsed ? '  ' : '→'}</Text>
      <Text bold>{` ${title}`}</Text>
      <Box flexGrow={1} />
      {count != null && count > 0 && <Text color="ansi:yellow">{`×${count}`}</Text>}
    </Box>
  );
}

function Footer({ active }: { active: { provider: string; model: string } | null }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{SEPARATOR}</Text>
      <Box>
        <Text dimColor>{'模型 '}</Text>
        {active ? (
          <>
            <Text>{active.provider}</Text>
            <Text dimColor>{'/'}</Text>
            <Text>{truncateToWidth(active.model, MAX_PROVIDER_LABEL)}</Text>
          </>
        ) : (
          <Text>—</Text>
        )}
      </Box>
    </Box>
  );
}
