import { getResolvedLanguage } from './language.js'

/**
 * Returns the localized text for the currently resolved language.
 * When resolved language is 'zh', returns the Chinese variant;
 * otherwise returns the English original.
 *
 * Usage:
 *   zh('Cancel', '取消')
 *   <Text>{zh('Cancel', '取消')}</Text>
 */
export function zh(en: string, zhText: string): string {
  return getResolvedLanguage() === 'zh' ? zhText : en
}
