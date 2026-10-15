import React from 'react';
import { Box, Text, stringWidth } from '@anthropic/ink';
import type { NormalizedMessage } from '../types/message.js';
import { renderModelName } from '../utils/model/model.js';
import { getActiveCcbRoute } from '../services/omniroute/adapter.js';

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

  let rawModel = message.message!.model as string;
  if (
    rawModel === '<synthetic>' ||
    rawModel === 'synthetic' ||
    (message.type === 'assistant' && message.isApiErrorMessage) ||
    ('isApiErrorMessage' in message.message! && message.message.isApiErrorMessage === true)
  ) {
    return null;
  }
  const isAbstract =
    rawModel === 'auto' ||
    rawModel === 'v8' ||
    rawModel === 'chat-pool' ||
    rawModel === 'worker-pool' ||
    rawModel.startsWith('auto/') ||
    rawModel.includes('pool');
  if (isAbstract) {
    const activeRoute = getActiveCcbRoute();
    if (activeRoute?.model) {
      rawModel = activeRoute.model.includes('/')
        ? activeRoute.model
        : activeRoute.provider
          ? activeRoute.provider + '/' + activeRoute.model
          : activeRoute.model;
    }
  }
  const displayModel = renderModelName(rawModel);

  return (
    <Box minWidth={stringWidth(displayModel) + 8}>
      <Text dimColor>{displayModel}</Text>
    </Box>
  );
}
