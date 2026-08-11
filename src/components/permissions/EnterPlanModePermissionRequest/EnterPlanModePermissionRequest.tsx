import { zh } from '../../../utils/i18n.js';
import React from 'react';
import { handlePlanModeTransition } from '../../../bootstrap/state.js';
import { Box, Text } from '@anthropic/ink';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../../services/analytics/index.js';
import { useAppState } from '../../../state/AppState.js';
import { isPlanModeInterviewPhaseEnabled } from '../../../utils/planModeV2.js';
import { Select } from '../../CustomSelect/index.js';
import { PermissionDialog } from '../PermissionDialog.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';

export function EnterPlanModePermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const toolPermissionContextMode = useAppState(s => s.toolPermissionContext.mode);

  function handleResponse(value: 'yes' | 'no'): void {
    if (value === 'yes') {
      logEvent('tengu_plan_enter', {
        interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
        entryMethod: 'tool' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      handlePlanModeTransition(toolPermissionContextMode, 'plan');
      onDone();
      toolUseConfirm.onAllow({}, [{ type: 'setMode', mode: 'plan', destination: 'session' }]);
    } else {
      onDone();
      onReject();
      toolUseConfirm.onReject();
    }
  }

  return (
    <PermissionDialog color="planMode" title="Enter plan mode?" workerBadge={workerBadge}>
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Text>
          {zh(
            'Claude wants to enter plan mode to explore and design an implementation approach.',
            'Claude 想进入计划模式，探索并设计实现方案。',
          )}
        </Text>

        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{zh('In plan mode, Claude will:', '在计划模式下，Claude 将：')}</Text>
          <Text dimColor>{zh(' · Explore the codebase thoroughly', ' · 全面探索代码库')}</Text>
          <Text dimColor>{zh(' · Identify existing patterns', ' · 识别现有模式')}</Text>
          <Text dimColor>{zh(' · Design an implementation strategy', ' · 设计实现策略')}</Text>
          <Text dimColor>{zh(' · Present a plan for your approval', ' · 提交计划供你批准')}</Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            {zh('No code changes will be made until you approve the plan.', '在你批准计划之前不会进行任何代码更改。')}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Select
            options={[
              { label: 'Yes, enter plan mode', value: 'yes' as const },
              { label: 'No, start implementing now', value: 'no' as const },
            ]}
            onChange={handleResponse}
            onCancel={() => handleResponse('no')}
          />
        </Box>
      </Box>
    </PermissionDialog>
  );
}
