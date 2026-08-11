import * as React from 'react';
import { Text } from '@anthropic/ink';
import { zh } from '../utils/i18n.js';

export function PressEnterToContinue(): React.ReactNode {
  return (
    <Text color="permission">
      {zh('Press ', '按 ')}
      <Text bold>Enter</Text>
      {zh(' to continue…', ' 继续…')}
    </Text>
  );
}
