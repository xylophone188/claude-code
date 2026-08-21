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
import { getActiveCcbRoute, getLastOmniRouteReceipt, readFileTail } from '../services/omniroute/adapter.js';
import { formatTokens, truncateToWidth } from '../utils/format.js';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Section = 'pool' | 'stream' | 'warnings';
type Tier = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';
type TierKey = Lowercase<Tier>;

const TIER_ORDER: readonly Tier[] = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];

const ROUTE_METRICS_PATH =
  process.env.CCB_ROUTE_METRICS_FILE ??
  process.env.CCB_RACE_METRICS_FILE ??
  join(process.env.HOME ?? '', '.ccb-embed', 'route-metrics.jsonl');
const ROUTE_POLL_MS = 3_000;
const WARNINGS_POLL_MS = 5_000;
const LOG_TAIL_BYTES = 64 * 1024;
const WARNINGS_MAX = 10;
const LOG_LINE_MAX = 48;
const MAX_PROVIDER_LABEL = 18;
const MAX_MODEL_LABEL = 16;
const MAX_POOL_LABEL = 38;
const SEPARATOR = '\u2501'.repeat(14);
const AUTO_CANDIDATES_FILE =
  process.env.CCB_AUTO_CANDIDATES_FILE ?? join(process.env.HOME ?? '', '.ccb-embed', 'auto-candidates.json');
const ADVISOR_CANDIDATES_FILE =
  process.env.CCB_ADVISOR_CANDIDATES_FILE ?? join(process.env.HOME ?? '', '.ccb-embed', 'advisor-candidates.json');
const CONVERSATION_TIERS_FILE =
  process.env.CCB_ROUTING_CONFIG ?? join(process.env.HOME ?? '', '.ccb-embed', 'providers.json');

const WARN_LOGS: string[] = process.env.CCB_WARN_LOGS?.split(':')
  .map(p => p.trim())
  .filter(Boolean) ?? [
  process.env.CCB_REAL_LOG ?? join(homedir(), '.ccb-embed', 'ccb-real.log'),
  process.env.CCB_ROUTER_LOG ?? join(homedir(), '.ccb-embed', 'router.log'),
  process.env.CCB_PROXY_LOG ?? join(homedir(), '.ccb-embed', 'proxy.log'),
];

const TEST_PROVIDERS = new Set(['race-test', 'race-delay']);

interface RouteMetricRow {
  provider: string;
  model: string;
  outcome: string;
  routeId?: string;
}

interface ModelStats {
  model: string;
  won: number;
  picked: number;
  failed: number;
}

interface ProviderStats {
  provider: string;
  won: number;
  failed: number;
  models: ModelStats[];
}

interface TierStats {
  tier: Tier;
  providers: ProviderStats[];
}

interface PoolStats {
  pool: string;
  tiers: TierStats[];
}

interface RoutePanelMeta {
  stats: PoolStats[];
  active: { provider: string; model: string } | null;
  receipt: ReturnType<typeof getLastOmniRouteReceipt>;
}

interface WarningItem {
  level: 'error' | 'warn';
  text: string;
}

function pct(won: number, total: number): number {
  return total === 0 ? 0 : Math.round((won * 100) / total);
}

function pctStr(won: number, total: number): string {
  return `${pct(won, total)}%`;
}

function parseRouteMetrics(): RouteMetricRow[] {
  try {
    if (!existsSync(ROUTE_METRICS_PATH)) return [];
    const content = readFileTail(ROUTE_METRICS_PATH);
    const rows: RouteMetricRow[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as Record<string, unknown>;
        const provider = String(m.provider ?? '');
        const model = String(m.model ?? '');
        const outcome = String(m.outcome ?? '');
        if (provider && model && outcome && !TEST_PROVIDERS.has(provider)) {
          rows.push({
            provider,
            model,
            outcome,
            routeId: typeof m.routeId === 'string' ? m.routeId : typeof m.raceId === 'string' ? m.raceId : undefined,
          });
        }
      } catch {
        /* skip corrupt lines */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function emptyCandidates(): Record<TierKey, string[]> {
  return { l1: [], l2: [], l3: [], l4: [], l5: [], l6: [] };
}

function parseAutoCandidates(): Record<TierKey, string[]> {
  try {
    if (!existsSync(AUTO_CANDIDATES_FILE)) return emptyCandidates();
    const raw = JSON.parse(readFileSync(AUTO_CANDIDATES_FILE, 'utf8')) as Partial<Record<TierKey, unknown>>;
    const candidates = emptyCandidates();
    for (const tier of TIER_ORDER) {
      const key = tier.toLowerCase() as TierKey;
      const values = raw[key];
      candidates[key] = Array.isArray(values)
        ? values.map(String).filter(candidate => !TEST_PROVIDERS.has(candidate.split('/')[0]))
        : [];
    }
    return candidates;
  } catch {
    return emptyCandidates();
  }
}

function parseAdvisorCandidates(): string[] {
  try {
    if (!existsSync(ADVISOR_CANDIDATES_FILE)) return [];
    const raw = JSON.parse(readFileSync(ADVISOR_CANDIDATES_FILE, 'utf8')) as unknown;
    if (Array.isArray(raw)) return raw.map(c => String(c)).filter(c => c && !TEST_PROVIDERS.has(c.split('/')[0]));
    return [];
  } catch {
    return [];
  }
}

function parseConversationTiers(): Record<TierKey, string[]> {
  try {
    if (!existsSync(CONVERSATION_TIERS_FILE)) return emptyCandidates();
    const raw = JSON.parse(readFileSync(CONVERSATION_TIERS_FILE, 'utf8')) as Record<string, unknown>;
    const tiers = raw.tiers;
    if (!tiers || typeof tiers !== 'object') return emptyCandidates();
    const providers = new Map<string, { autoModel?: string; defaultModel?: string }>();
    const provList = raw.providers;
    if (Array.isArray(provList)) {
      for (const p of provList) {
        if (typeof p === 'object' && p !== null && 'id' in p) {
          const id = String((p as { id?: unknown }).id ?? '');
          if (id) providers.set(id, p as { autoModel?: string; defaultModel?: string });
        }
      }
    }
    const candidates = emptyCandidates();
    for (const tier of TIER_ORDER) {
      const key = tier.toLowerCase() as TierKey;
      const values = (tiers as Record<string, unknown>)[tier];
      if (!Array.isArray(values)) {
        candidates[key] = [];
        continue;
      }
      candidates[key] = values
        .map(providerId => {
          const id = String(providerId ?? '');
          if (!id) return '';
          const prov = providers.get(id);
          let model = prov?.autoModel ?? prov?.defaultModel ?? id;
          if (!model.startsWith(`${id}/`)) model = `${id}/${model}`;
          return !TEST_PROVIDERS.has(id) ? model : '';
        })
        .filter(Boolean);
    }
    return candidates;
  } catch {
    return emptyCandidates();
  }
}

function buildWindowStats(rows: RouteMetricRow[]): PoolStats {
  const tierKeys = new Map<string, Tier>();
  const candidates = parseAutoCandidates();
  for (const tier of TIER_ORDER) {
    const key = tier.toLowerCase() as TierKey;
    for (const candidate of candidates[key]) {
      const provider = candidate.split('/')[0];
      if (!tierKeys.has(provider)) tierKeys.set(provider, tier);
    }
  }
  const defaultTier = (provider: string): Tier => tierKeys.get(provider) ?? 'L2';

  const provMap = new Map<string, { won: number; failed: number; models: ModelStats[]; tier: Tier }>();
  const modelMap = new Map<string, ModelStats>();

  for (const r of rows) {
    let entry = provMap.get(r.provider);
    if (!entry) {
      entry = { won: 0, failed: 0, models: [], tier: defaultTier(r.provider) };
      provMap.set(r.provider, entry);
    }
    if (r.outcome === 'won') entry.won++;
    if (r.outcome === 'failed') entry.failed++;

    const mk = `${r.provider}::${r.model}`;
    let ms = modelMap.get(mk);
    if (!ms) {
      ms = { model: r.model, won: 0, picked: 0, failed: 0 };
      modelMap.set(mk, ms);
    }
    if (r.outcome === 'won') ms.won++;
    if (r.outcome === 'selected') ms.picked++;
    if (r.outcome === 'failed') {
      ms.failed++;
      ms.picked++;
    }
  }

  for (const [mk, ms] of modelMap) {
    const [mp] = mk.split('::');
    const entry = provMap.get(mp);
    if (entry) entry.models.push(ms);
  }

  const tierMap = new Map<Tier, ProviderStats[]>();
  for (const tier of TIER_ORDER) tierMap.set(tier, []);

  for (const [provider, entry] of provMap) {
    const ps: ProviderStats = {
      provider,
      won: entry.won,
      failed: entry.failed,
      models: entry.models.sort((a, b) => b.picked - a.picked),
    };
    tierMap.get(entry.tier)?.push(ps);
  }

  const tiers: TierStats[] = [];
  for (const t of TIER_ORDER) {
    const providers = tierMap.get(t) ?? [];
    if (providers.length > 0) {
      tiers.push({ tier: t, providers: providers.sort((a, b) => b.won + b.failed - (a.won + a.failed)) });
    }
  }
  return { pool: 'window', tiers };
}

function useRouteStats(): RoutePanelMeta {
  const [meta, setMeta] = useState<RoutePanelMeta>({ stats: [], active: null, receipt: null });

  useEffect(() => {
    const load = () => {
      const rows = parseRouteMetrics();
      const windowStats = buildWindowStats(rows);
      const stats: PoolStats[] = [windowStats];
      let active = getActiveCcbRoute();
      if (!active) {
        for (let i = rows.length - 1; i >= 0; i--) {
          const row = rows[i];
          if (row.outcome === 'selected' || row.outcome === 'won') {
            active = { provider: row.provider, model: row.model };
            break;
          }
        }
      }
      setMeta({ stats, active, receipt: getLastOmniRouteReceipt() });
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

function usePoolConfig() {
  const [config, setConfig] = useState<{ conversation: Record<TierKey, string>; advisor: string }>({
    conversation: { l1: '', l2: '', l3: '', l4: '', l5: '', l6: '' },
    advisor: '',
  });

  useEffect(() => {
    const load = () => {
      const candidates = parseConversationTiers();
      const conversation = Object.fromEntries(
        Object.entries(candidates).map(([tier, values]) => [tier, values.join(', ') || '—']),
      ) as Record<TierKey, string>;
      const adv = parseAdvisorCandidates();
      setConfig({
        conversation,
        advisor: adv.join(', ') || process.env.CCB_ADVISOR_MODEL || '—',
      });
    };
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  return config;
}

function PoolPanel({ collapsed, meta }: { collapsed: boolean; meta: RoutePanelMeta }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [poolOpen, setPoolOpen] = useState<Set<string>>(new Set(['window', 'conversation', 'advisor']));
  const config = usePoolConfig();

  if (collapsed) return null;

  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const togglePool = (id: string) =>
    setPoolOpen(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const windowStats = meta.stats.find(s => s.pool === 'window');
  const advisorLines = config.advisor
    .split(',')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 3);

  return (
    <Box flexDirection="column" maxHeight={34}>
      <Box flexDirection="column">
        <Box onClick={() => togglePool('window')}>
          <Text dimColor>{poolOpen.has('window') ? '  ' : '→'}</Text>
          <Text>{` 窗口路由池（OmniRoute）`}</Text>
          <Box flexGrow={1} />
        </Box>
        {poolOpen.has('window') && windowStats && (
          <Box flexDirection="column">
            {windowStats.tiers.map(tier => (
              <Box key={tier.tier} flexDirection="column">
                <Box>
                  <Text dimColor>{`   ${tier.tier} `}</Text>
                  <Text bold>{tier.providers.length}</Text>
                </Box>
                {tier.providers.slice(0, 3).map(pv => {
                  const isOpen = expanded.has(pv.provider);
                  return (
                    <Box key={pv.provider} flexDirection="column">
                      <Box onClick={() => toggle(pv.provider)}>
                        <Text dimColor>{isOpen ? '   · ' : '   →'}</Text>
                        <Text>{pv.provider.toUpperCase()}</Text>
                        <Box flexGrow={1} />
                        <Text color={pv.won > 0 ? 'ansi:green' : undefined} dimColor={pv.won === 0}>
                          {pctStr(pv.won, pv.won + pv.failed)}
                        </Text>
                      </Box>
                      {isOpen &&
                        pv.models.slice(0, 3).map(m => (
                          <Box key={m.model}>
                            <Text dimColor>{'     · '}</Text>
                            <Text>{truncateToWidth(m.model, MAX_MODEL_LABEL)}</Text>
                            <Box flexGrow={1} />
                            <Text color={m.won > 0 ? 'ansi:green' : undefined} dimColor={m.won === 0}>
                              {pctStr(m.won, m.picked)}
                            </Text>
                            <Text dimColor>{` ×${m.picked}`}</Text>
                          </Box>
                        ))}
                    </Box>
                  );
                })}
              </Box>
            ))}
          </Box>
        )}
      </Box>
      <Box flexDirection="column">
        <Box onClick={() => togglePool('conversation')}>
          <Text dimColor>{poolOpen.has('conversation') ? '  ' : '→'}</Text>
          <Text>{` 对话路由池`}</Text>
          <Box flexGrow={1} />
        </Box>
        {poolOpen.has('conversation') && (
          <Box flexDirection="column">
            {TIER_ORDER.map(tier => {
              const key = tier.toLowerCase() as TierKey;
              return (
                <Box key={tier}>
                  <Text dimColor>{`   · ${tier} `}</Text>
                  <Text>{truncateToWidth(config.conversation[key], MAX_POOL_LABEL)}</Text>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
      <Box flexDirection="column">
        <Box onClick={() => togglePool('advisor')}>
          <Text dimColor>{poolOpen.has('advisor') ? '  ' : '→'}</Text>
          <Text>{` 顾问路由池`}</Text>
          <Box flexGrow={1} />
        </Box>
        {poolOpen.has('advisor') && advisorLines.length > 0 && (
          <Box flexDirection="column">
            {advisorLines.map((m, i) => (
              <Box key={i}>
                <Text dimColor>{'   · '}</Text>
                <Text>{truncateToWidth(m, MAX_POOL_LABEL)}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function RouteReceipt({ receipt }: { receipt: RoutePanelMeta['receipt'] }) {
  if (!receipt) return null;
  return (
    <Box flexDirection="column">
      {receipt.decision && <Text dimColor>{`决策 ${truncateToWidth(receipt.decision, MAX_POOL_LABEL)}`}</Text>}
      {receipt.provider && receipt.model && (
        <Text dimColor>{`路由 ${truncateToWidth(`${receipt.provider}/${receipt.model}`, MAX_POOL_LABEL)}`}</Text>
      )}
      {receipt.latencyMs != null && <Text dimColor>{`延迟 ${formatMs(receipt.latencyMs)}`}</Text>}
      {receipt.fallbackAttempts != null && <Text dimColor>{`回退 ×${receipt.fallbackAttempts}`}</Text>}
      {receipt.compression && <Text dimColor>{`压缩 ${receipt.compression}`}</Text>}
    </Box>
  );
}

function AgentTaskStats() {
  const tasks = useAppState(s => Object.values(s.tasks).filter(isLocalWorkflowTask));
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
      <PanelHeader title="路由池" toggle={() => toggle('pool')} collapsed={collapsed.pool} />
      {!collapsed.pool && <PoolPanel collapsed={false} meta={meta} />}
      <RouteReceipt receipt={meta.receipt} />
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
