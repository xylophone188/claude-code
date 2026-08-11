import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

export type PonytailLevel = 'lite' | 'full' | 'ultra' | 'off'

const PONYTAIL_DEFAULT: PonytailLevel = 'ultra'

const PONYTAIL_INSTRUCTIONS: Record<PonytailLevel, string> = {
  lite: `[ponytail-lite] Prefer minimal implementations. Read affected code first. Preserve validation, error handling, security.`,

  full: `PONYTAIL MODE ACTIVE — level: full
Lazy senior developer. Lazy = efficient, not careless. Best code is the code never written.

Ladder before any code: 1) Does this need to be built? (YAGNI) 2) Already exists in codebase? 3) Standard library? 4) Native platform feature? 5) Installed dependency? 6) One line? 7) Minimum working code.

Bug fix = root cause, not symptom. Delete over addition. Boring over clever. Fewest files possible. Ship lazy version.`,

  ultra: `PONYTAIL MODE ACTIVE — level: ultra
Lazy senior developer. Lazy = efficient, not careless.

Before any code: YAGNI → reuse → stdlib → native → dependency → one-line → minimum code.

Bug fix = root cause. Grep every caller, fix shared function once. Patching only the named path leaves sibling callers broken.

Rules: No unrequested abstractions. No avoidable dependencies. No boilerplate nobody asked. Deletion over addition. Boring over clever. Fewest files. Ship lazy.

Preserve: validation at trust boundaries, error handling preventing data loss, security, accessibility basics, calibration for real hardware. Trivial one-liners need no test. Non-trivial logic leaves ONE runnable check.`,

  off: '',
}

let cachedLevel: PonytailLevel | null = null

export function getPonytailLevel(): PonytailLevel {
  if (cachedLevel === null) {
    const settings = getInitialSettings()
    const raw = settings.ponytailLevel
    cachedLevel =
      typeof raw === 'string' && raw in PONYTAIL_INSTRUCTIONS
        ? (raw as PonytailLevel)
        : PONYTAIL_DEFAULT
  }
  return cachedLevel
}

export function setPonytailLevel(level: PonytailLevel): void {
  cachedLevel = level
  updateSettingsForSource('userSettings', {
    ponytailLevel: level === PONYTAIL_DEFAULT ? undefined : level,
  })
}

export function getPonytailInstructions(): string {
  return PONYTAIL_INSTRUCTIONS[getPonytailLevel()]
}
