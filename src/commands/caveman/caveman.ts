import type { LocalCommandCall } from '../../types/command.js'
import { getCavemanLevel, setCavemanLevel } from './cavemanMode.js'

const VALID_LEVELS = ['lite', 'full', 'ultra', 'wenyan']

export const call: LocalCommandCall = async args => {
  const requested = args.trim().toLowerCase()
  if (VALID_LEVELS.includes(requested)) {
    setCavemanLevel(requested as 'lite' | 'full' | 'ultra' | 'wenyan')
    return { type: 'text', value: `Caveman set to ${requested}` }
  }
  const current = getCavemanLevel()
  return {
    type: 'text',
    value: `Caveman: ${current}. Levels: ${VALID_LEVELS.join(' | ')}`,
  }
}
