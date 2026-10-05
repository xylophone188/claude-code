import React from 'react';
import { Box, Text, stringWidth } from '@anthropic/ink';
import type { NormalizedMessage } from '../types/message.js';

type Props = {
  message: NormalizedMessage;
  isTranscriptMode: boolean;
};

export function MessageTimestamp({ message, isTranscriptMode }: Props): React.ReactNode {
  const shouldShowTimestamp =
    isTranscriptMode &&
    message.timestamp &&
    message.type === 'assistant' &&
    (Array.isArray(message.message!.content)
      ? (message.message!.content as { type: string }[]).some(c => c.type === 'text')
      : false);

  if (!shouldShowTimestamp) {
    return null;
  }

  const d = new Date(message.timestamp as string | number | Date);
  const pad = (n: number) => String(n).padStart(2, '0');
  const formattedTimestamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  return (
    <Box minWidth={stringWidth(formattedTimestamp)}>
      <Text dimColor>{formattedTimestamp}</Text>
    </Box>
  );
}
