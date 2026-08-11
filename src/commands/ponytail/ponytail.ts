import type { LocalCommandCall } from '../../types/command.js'
import { getPonytailLevel, setPonytailLevel } from './ponytailMode.js'

const VALID_LEVELS = ['lite', 'full', 'ultra', 'off']

export const call: LocalCommandCall = async args => {
  const requested = args.trim().toLowerCase()
  if (VALID_LEVELS.includes(requested)) {
    setPonytailLevel(requested as 'lite' | 'full' | 'ultra' | 'off')
    return { type: 'text', value: `Ponytail set to ${requested}` }
  }
  const current = getPonytailLevel()
  return {
    type: 'text',
    value: `Ponytail: ${current}. Levels: ${VALID_LEVELS.join(' | ')}`,
  }
}
