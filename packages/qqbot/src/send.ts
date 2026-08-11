import { sendC2CMessage } from './api.js'
import { DEFAULT_API_BASE } from './accounts.js'

function stripCodeBlocks(text: string): string {
  // Non-regex approach to avoid ReDoS on inputs with many ``` sequences.
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

const QQ_MAX_MESSAGE_LENGTH = 4000

export async function sendText(params: {
  to: string
  text: string
  baseUrl: string
  token: string
  messageId?: string
  seq?: number
  signal?: AbortSignal
}): Promise<{ messageId: string }> {
  const plain = markdownToPlainText(params.text).slice(0, QQ_MAX_MESSAGE_LENGTH)

  const resp = await sendC2CMessage(
    {
      to: params.to,
      text: plain,
      baseUrl: params.baseUrl || DEFAULT_API_BASE,
      token: params.token,
      messageId: params.messageId,
      seq: params.seq,
    },
    params.signal,
  )

  return { messageId: resp.id ?? params.messageId ?? '' }
}
