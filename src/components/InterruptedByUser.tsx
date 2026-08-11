import * as React from 'react';
import { Text } from '@anthropic/ink';
import { zh } from '../utils/i18n.js';

export function InterruptedByUser(): React.ReactNode {
  return (
    <>
      <Text dimColor>{zh('Interrupted ', '已中断 ')}</Text>
      {process.env.USER_TYPE === 'ant' ? (
        <Text dimColor>· [ANT-ONLY] /issue to report a model issue</Text>
      ) : (
        <Text dimColor>{zh('· What should Claude do instead?', '· 你希望 Claude 改做什么？')}</Text>
      )}
    </>
  );
}
