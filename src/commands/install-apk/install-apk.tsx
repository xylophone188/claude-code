/**
 * /install-apk 命令 UI
 *
 * 用法:
 *   /install-apk <url> [--device <serial>] [--output <dir>] [--checksum <sha256>] [--keep]
 *   /install-apk <本地路径>   # 跳过下载，直接安装本机已有 APK
 *
 * Android/Termux 原生安装；PC 上通过 adb 安装到设备。
 */

import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import {
  parseInstallApkArgs,
  runInstallApk,
  type InstallApkOptions,
  type InstallApkProgress,
  type InstallApkResult,
} from './apk-installer.js';

const PHASE_LABEL: Record<InstallApkProgress['phase'], string> = {
  downloading: '下载',
  verifying: '校验',
  installing: '安装',
  cleaning: '清理',
};

function formatBytes(bytes?: number): string {
  if (bytes === undefined || Number.isNaN(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

function ProgressBar({ percent }: { percent?: number }): React.ReactNode {
  if (percent === undefined) {
    return <Text dimColor>…</Text>;
  }
  const width = Math.max(10, (process.stdout.columns ?? 60) - 34);
  const filled = Math.round((percent / 100) * width);
  return (
    <Text color="claude">
      [{'\u2500'.repeat(Math.max(0, filled))}
      {'\u00b7'.repeat(Math.max(0, width - filled))}] {percent}%
    </Text>
  );
}

type InstallApkProps = {
  onDone: LocalJSXCommandOnDone;
  options: InstallApkOptions;
};

function InstallApk({ onDone, options }: InstallApkProps): React.ReactNode {
  const [progress, setProgress] = useState<InstallApkProgress>({
    phase: 'downloading',
    message: '准备中…',
  });
  const [result, setResult] = useState<InstallApkResult | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const res = await runInstallApk(options, setProgress);
      setResult(res);
      onDone(res.message);
    })();
  }, [onDone, options]);

  const phase = progress.phase;
  const downloadLine =
    phase === 'downloading'
      ? progress.percent !== undefined
        ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
        : `${formatBytes(progress.received)}`
      : undefined;

  return (
    <Box flexDirection="column" gap={1} marginBottom={1}>
      <Text bold color="claude">
        /install-apk
      </Text>

      <Box gap={1}>
        <Text dimColor>{PHASE_LABEL[phase]}:</Text>
        {phase === 'downloading' ? (
          <Box gap={1}>
            <ProgressBar percent={progress.percent} />
            {downloadLine && <Text dimColor>{downloadLine}</Text>}
          </Box>
        ) : (
          <Text dimColor>{progress.message ?? '…'}</Text>
        )}
      </Box>

      {result && (
        <Text color={result.ok ? 'ansi:green' : 'ansi:red'} bold={result.ok}>
          {result.ok ? '✓ ' : '✗ '}
          {result.message}
        </Text>
      )}
    </Box>
  );
}

export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args: string): Promise<React.ReactNode> {
  const parsed = parseInstallApkArgs(args);

  if (!parsed.input) {
    onDone('用法: /install-apk <url|本地路径> [--device <serial>] [--output <dir>] [--checksum <sha256>] [--keep]', {
      display: 'system',
    });
    return null;
  }

  const input = parsed.input.trim();
  if (/^https?:\/\//i.test(input)) {
    try {
      // eslint-disable-next-line no-new
      new URL(input);
    } catch {
      onDone(`无效的 URL: ${input}`, { display: 'system' });
      return null;
    }
  }

  return (
    <InstallApk
      onDone={onDone}
      options={{
        input,
        outputDir: parsed.outputDir,
        device: parsed.device,
        checksum: parsed.checksum,
        keep: parsed.keep,
      }}
    />
  );
}
