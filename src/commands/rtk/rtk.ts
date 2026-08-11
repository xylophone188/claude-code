import type { LocalCommandCall } from '../../types/command.js'
import { getRtkLevel, setRtkLevel } from './rtkMode.js'

const VALID_LEVELS = ['off', 'compact', 'ultra-compact']

export const call: LocalCommandCall = async args => {
  const requested = args.trim().toLowerCase()
  if (VALID_LEVELS.includes(requested)) {
    setRtkLevel(requested as 'off' | 'compact' | 'ultra-compact')
    return { type: 'text', value: `RTK set to ${requested}` }
  }
  const current = getRtkLevel()
  return {
    type: 'text',
    value: `RTK: ${current}. Levels: ${VALID_LEVELS.join(' | ')}`,
  }
}
