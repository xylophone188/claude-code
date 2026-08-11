import { zh } from '../utils/i18n.js';
import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { logEvent } from 'src/services/analytics/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { Box, Text, Dialog } from '@anthropic/ink';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { getPlansDirectory } from '../utils/plans.js';
import { setCwd } from '../utils/Shell.js';
import { cleanupWorktree, getCurrentWorktreeSession, keepWorktree, killTmuxSession } from '../utils/worktree.js';
import { Select } from './CustomSelect/select.js';
import { Spinner } from './Spinner.js';

// Inline require breaks the cycle this file would otherwise close:
// sessionStorage → commands → exit → ExitFlow → here. All call sites
// are inside callbacks, so the lazy require never sees an undefined import.
function recordWorktreeExit(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  (require('../utils/sessionStorage.js') as typeof import('../utils/sessionStorage.js')).saveWorktreeState(null);
  /* eslint-enable @typescript-eslint/no-require-imports */
}

type Props = {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  onCancel?: () => void;
};

export function WorktreeExitDialog({ onDone, onCancel }: Props): React.ReactNode {
  const [status, setStatus] = useState<'loading' | 'asking' | 'keeping' | 'removing' | 'done'>('loading');
  const [changes, setChanges] = useState<string[]>([]);
  const [commitCount, setCommitCount] = useState<number>(0);
  const [resultMessage, setResultMessage] = useState<string | undefined>();
  const worktreeSession = getCurrentWorktreeSession();

  useEffect(() => {
    async function loadChanges() {
      let changeLines: string[] = [];
      const gitStatus = await execFileNoThrow('git', ['status', '--porcelain']);
      if (gitStatus.stdout) {
        changeLines = gitStatus.stdout.split('\n').filter(_ => _.trim() !== '');
        setChanges(changeLines);
      }

      // Check for commits to eject
      if (worktreeSession) {
        // Get commits in worktree that are not in original branch
        const { stdout: commitsStr } = await execFileNoThrow('git', [
          'rev-list',
          '--count',
          `${worktreeSession.originalHeadCommit}..HEAD`,
        ]);
        const count = parseInt(commitsStr.trim(), 10) || 0;
        setCommitCount(count);

        // If no changes and no commits, clean up silently
        if (changeLines.length === 0 && count === 0) {
          setStatus('removing');
          void cleanupWorktree()
            .then(() => {
              process.chdir(worktreeSession.originalCwd);
              setCwd(worktreeSession.originalCwd);
              recordWorktreeExit();
              getPlansDirectory.cache.clear?.();
              setResultMessage('Worktree removed (no changes)');
            })
            .catch(error => {
              logForDebugging(`Failed to clean up worktree: ${error}`, {
                level: 'error',
              });
              setResultMessage(zh('Worktree cleanup failed, exiting anyway', '清理 worktree 失败，仍将退出'));
            })
            .then(() => {
              setStatus('done');
            });
          return;
        } else {
          setStatus('asking');
        }
      }
    }
    void loadChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeSession]);

  useEffect(() => {
    if (status === 'done') {
      onDone(resultMessage);
    }
  }, [status, onDone, resultMessage]);

  if (!worktreeSession) {
    onDone('No active worktree session found', { display: 'system' });
    return null;
  }

  if (status === 'loading' || status === 'done') {
    return null;
  }

  async function handleSelect(value: string) {
    if (!worktreeSession) return;

    const hasTmux = Boolean(worktreeSession.tmuxSessionName);

    if (value === 'keep' || value === 'keep-with-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length,
      });
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      if (hasTmux) {
        setResultMessage(
          `Worktree kept. Your work is saved at ${worktreeSession.worktreePath} on branch ${worktreeSession.worktreeBranch}. Reattach to tmux session with: tmux attach -t ${worktreeSession.tmuxSessionName}`,
        );
      } else {
        setResultMessage(
          `Worktree kept. Your work is saved at ${worktreeSession.worktreePath} on branch ${worktreeSession.worktreeBranch}`,
        );
      }
      setStatus('done');
    } else if (value === 'keep-kill-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length,
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      setResultMessage(
        `Worktree kept at ${worktreeSession.worktreePath} on branch ${worktreeSession.worktreeBranch}. Tmux session terminated.`,
      );
      setStatus('done');
    } else if (value === 'remove' || value === 'remove-with-tmux') {
      setStatus('removing');
      logEvent('tengu_worktree_removed', {
        commits: commitCount,
        changed_files: changes.length,
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      try {
        await cleanupWorktree();
        process.chdir(worktreeSession.originalCwd);
        setCwd(worktreeSession.originalCwd);
        recordWorktreeExit();
        getPlansDirectory.cache.clear?.();
      } catch (error) {
        logForDebugging(`Failed to clean up worktree: ${error}`, {
          level: 'error',
        });
        setResultMessage(zh('Worktree cleanup failed, exiting anyway', '清理 worktree 失败，仍将退出'));
        setStatus('done');
        return;
      }
      const tmuxNote = hasTmux ? zh(' Tmux session terminated.', ' Tmux 会话已终止。') : '';
      if (commitCount > 0 && changes.length > 0) {
        setResultMessage(
          zh(
            `Worktree removed. ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} and uncommitted changes were discarded.${tmuxNote}`,
            `已移除 worktree。${commitCount} 个${commitCount === 1 ? '提交' : '提交'}及未提交更改已丢弃。${tmuxNote}`,
          ),
        );
      } else if (commitCount > 0) {
        setResultMessage(
          zh(
            `Worktree removed. ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} on ${worktreeSession.worktreeBranch} ${commitCount === 1 ? 'was' : 'were'} discarded.${tmuxNote}`,
            `已移除 worktree。${worktreeSession.worktreeBranch} 上的 ${commitCount} 个提交已丢弃。${tmuxNote}`,
          ),
        );
      } else if (changes.length > 0) {
        setResultMessage(
          zh(
            `Worktree removed. Uncommitted changes were discarded.${tmuxNote}`,
            `已移除 worktree。未提交更改已丢弃。${tmuxNote}`,
          ),
        );
      } else {
        setResultMessage(zh(`Worktree removed.${tmuxNote}`, `已移除 worktree。${tmuxNote}`));
      }
      setStatus('done');
    }
  }

  if (status === 'keeping') {
    return (
      <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>{zh('Keeping worktree…', '正在保留 worktree…')}</Text>
      </Box>
    );
  }

  if (status === 'removing') {
    return (
      <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>{zh('Removing worktree…', '正在移除 worktree…')}</Text>
      </Box>
    );
  }

  const branchName = worktreeSession.worktreeBranch;
  const hasUncommitted = changes.length > 0;
  const hasCommits = commitCount > 0;

  let subtitle = '';
  if (hasUncommitted && hasCommits) {
    subtitle = zh(
      `You have ${changes.length} uncommitted ${changes.length === 1 ? 'file' : 'files'} and ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} on ${branchName}. All will be lost if you remove.`,
      `${branchName} 上有 ${changes.length} 个未提交${changes.length === 1 ? '文件' : '文件'}和 ${commitCount} 个提交。移除将全部丢失。`,
    );
  } else if (hasUncommitted) {
    subtitle = zh(
      `You have ${changes.length} uncommitted ${changes.length === 1 ? 'file' : 'files'}. These will be lost if you remove the worktree.`,
      `有 ${changes.length} 个未提交${changes.length === 1 ? '文件' : '文件'}。移除 worktree 将丢失这些更改。`,
    );
  } else if (hasCommits) {
    subtitle = zh(
      `You have ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} on ${branchName}. The branch will be deleted if you remove the worktree.`,
      `${branchName} 上有 ${commitCount} 个提交。移除 worktree 将删除该分支。`,
    );
  } else {
    subtitle = zh(
      'You are working in a worktree. Keep it to continue working there, or remove it to clean up.',
      '你正在 worktree 中工作。保留可继续在此工作，或移除进行清理。',
    );
  }

  function handleCancel() {
    if (onCancel) {
      // Abort exit and return to the session
      onCancel();
      return;
    }
    // Fallback: treat Escape as "keep" if no onCancel provided
    void handleSelect('keep');
  }

  const removeDescription =
    hasUncommitted || hasCommits
      ? zh('All changes and commits will be lost.', '所有更改和提交都将丢失。')
      : zh('Clean up the worktree directory.', '清理 worktree 目录。');

  const hasTmuxSession = Boolean(worktreeSession.tmuxSessionName);

  const options = hasTmuxSession
    ? [
        {
          label: zh('Keep worktree and tmux session', '保留 worktree 和 tmux 会话'),
          value: 'keep-with-tmux',
          description: zh(
            `Stays at ${worktreeSession.worktreePath}. Reattach with: tmux attach -t ${worktreeSession.tmuxSessionName}`,
            `停留在 ${worktreeSession.worktreePath}。重新连接：tmux attach -t ${worktreeSession.tmuxSessionName}`,
          ),
        },
        {
          label: zh('Keep worktree, kill tmux session', '保留 worktree，终止 tmux 会话'),
          value: 'keep-kill-tmux',
          description: zh(
            `Keeps worktree at ${worktreeSession.worktreePath}, terminates tmux session.`,
            `保留 ${worktreeSession.worktreePath} 的 worktree，终止 tmux 会话。`,
          ),
        },
        {
          label: zh('Remove worktree and tmux session', '移除 worktree 和 tmux 会话'),
          value: 'remove-with-tmux',
          description: removeDescription,
        },
      ]
    : [
        {
          label: zh('Keep worktree', '保留 worktree'),
          value: 'keep',
          description: zh(`Stays at ${worktreeSession.worktreePath}`, `停留在 ${worktreeSession.worktreePath}`),
        },
        {
          label: zh('Remove worktree', '移除 worktree'),
          value: 'remove',
          description: removeDescription,
        },
      ];

  const defaultValue = hasTmuxSession ? 'keep-with-tmux' : 'keep';

  return (
    <Dialog title={zh('Exiting worktree session', '退出 worktree 会话')} subtitle={subtitle} onCancel={handleCancel}>
      <Select defaultFocusValue={defaultValue} options={options} onChange={handleSelect} />
    </Dialog>
  );
}
