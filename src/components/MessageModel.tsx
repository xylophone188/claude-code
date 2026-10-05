import React from 'react';
import { Box, Text, stringWidth } from '@anthropic/ink';
import type { NormalizedMessage } from '../types/message.js';
import { renderModelName } from '../utils/model/model.js';

type Props = {
  message: NormalizedMessage;
  isTranscriptMode: boolean;
};

export function MessageModel({ message, isTranscriptMode }: Props): React.ReactNode {
  const content = message.message?.content;
  const contentArray = Array.isArray(content) ? content : [];
  const shouldShowModel =
    isTranscriptMode &&
    message.type === 'assistant' &&
    message.message?.model &&
    contentArray.some((c: any) => c?.type === 'text');

  if (!shouldShowModel) {
    return null;
  }

  const rawModel = message.message!.model as string;
  const displayModel = renderModelName(rawModel);

  return (
    <Box minWidth={stringWidth(displayModel) + 8}>
      <Text dimColor>{displayModel}</Text>
    </Box>
  );
}
