import { getGlobalConfig } from '../../utils/config.js'

export function isTermuxRuntime(): boolean {
  return (
    process.platform === 'android' ||
    Boolean(process.env.PREFIX?.includes('/com.termux'))
  )
}

export function getRemoteCompressionUrl(): string | undefined {
  const config = getGlobalConfig() as Record<string, unknown>
  const value =
    config.contextCompressionRemoteUrl ??
    process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function termuxCompressionNotice(): string | undefined {
  return isTermuxRuntime() && !getRemoteCompressionUrl()
    ? '当前为 Termux，可在配置文件中设置远程压缩地址。'
    : undefined
}
