import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

export type RtkLevel = 'off' | 'compact' | 'ultra-compact'

const RTK_DEFAULT: RtkLevel = 'compact'

const RTK_INSTRUCTIONS: Record<RtkLevel, string> = {
  off: `[rtk-off] Output raw.`,
  compact: `[rtk-compact] Prefix all Bash commands with rtk. RTK filters output, saves 60-90% tokens.`,
  'ultra-compact': `[rtk-ultra-compact] Prefix all Bash commands with rtk --ultra-compact. Maximum output compression.`,
}

let cachedLevel: RtkLevel | null = null

export function getRtkLevel(): RtkLevel {
  if (cachedLevel === null) {
    const settings = getInitialSettings()
    const raw = settings.rtkLevel
    cachedLevel =
      typeof raw === 'string' && raw in RTK_INSTRUCTIONS
        ? (raw as RtkLevel)
        : RTK_DEFAULT
  }
  return cachedLevel
}

export function setRtkLevel(level: RtkLevel): void {
  cachedLevel = level
  updateSettingsForSource('userSettings', {
    rtkLevel: level === RTK_DEFAULT ? undefined : level,
  })
}

export function getRtkInstructions(): string {
  return RTK_INSTRUCTIONS[getRtkLevel()]
}
