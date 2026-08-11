import { MAX_MESSAGE_LENGTH } from './accounts.js'
import { sendMessage } from './api.js'

function stripCodeBlocks(text: string): string {
  // Non-regex linear scan to avoid ReDoS on pathological ``` inputs.
  let result = ''
  let i = 0
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      let j = i + 3
      while (j < text.length && text[j] !== '\n') j++
      if (j < text.length) j++
      const contentStart = j
      while (j < text.length) {
        if (text.startsWith('```', j)) {
          result += text.slice(contentStart, j)
          j += 3
          while (j < text.length && text[j] !== '\n') j++
          if (j < text.length) j++
          break
        }
        j++
      }
      if (j >= text.length && !text.startsWith('```', j - 3)) {
        result += text.slice(i)
      }
      i = j
    } else {
      result += text[i]
      i++
    }
  }
  return result
}

export function markdownToPlainText(text: string): string {
  return stripCodeBlocks(text)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/___(.+?)___/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '[$1]')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*_]{3,}$/gm, '---')
    .replace(/^[\s]*[-*+]\s+/gm, '- ')
    .replace(/^[\s]*(\d+)\.\s+/gm, '$1. ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function sendText(params: {
  to: string
  text: string
  baseUrl: string
  token: string
  replyToMessageId?: number
  signal?: AbortSignal
}): Promise<{ messageId: number }> {
  const plain = markdownToPlainText(params.text).slice(0, MAX_MESSAGE_LENGTH)

  const chatId = params.to.startsWith('@') ? params.to : Number(params.to)
  if (!Number.isFinite(chatId) && !params.to.startsWith('@')) {
    throw new Error(`Invalid chat id: ${params.to}`)
  }

  const resp = await sendMessage(
    params.baseUrl,
    params.token,
    {
      chat_id: chatId,
      text: plain,
      reply_to_message_id: params.replyToMessageId,
    },
    params.signal,
  )
  return { messageId: resp.message_id }
}
