import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

export type CavemanLevel =
  | 'lite'
  | 'full'
  | 'ultra'
  | 'wenyan'
  | 'wenyan-lite'
  | 'wenyan-full'
  | 'wenyan-ultra'

const CAVEMAN_DEFAULT: CavemanLevel = 'ultra'

const CAVEMAN_INSTRUCTIONS: Record<CavemanLevel, string> = {
  lite: `[caveman-lite] Respond naturally. Keep replies concise and friendly. Drop only obvious filler. Fragments OK when they improve clarity.`,

  full: `CAVEMAN MODE ACTIVE — level: full
Respond like a smart caveman. Drop articles, filler words, pleasantries, hedging. Fragments OK. Technical terms exact. Errors quoted verbatim.

Pattern: [thing] [action] [reason]. [next step].
Not: "Sure! I'd be happy to help you with that."
Yes: "Bug in auth middleware. Token check uses < not <=. Fix:"`,

  ultra: `CAVEMAN MODE ACTIVE — level: ultra
Drop: articles (a/an/the), filler (just/really/basicallly/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Technical terms exact. Code blocks unchanged. Errors quoted exact.

Pattern: [thing] [action] [reason]. [next step].

Auto-Clarity: Drop caveman for security warnings, irreversible action confirmations, multi-step sequences where fragment order risks misread, user asks to clarify. Resume after clear part done.

Boundaries: Code/commits/PRs: write normal.`,

  wenyan: `[caveman-wenyan] 文言模式。以文言回应。技术术语保持原文。`,

  'wenyan-lite': `CAVEMAN MODE ACTIVE — level: wenyan-lite
文言凝练。可适度省略虚词与客套，保留全部技术含义。术语精确，代码原样。`,

  'wenyan-full': `CAVEMAN MODE ACTIVE — level: wenyan-full
文言凝练感。省虚词、套话、过渡句。单句单意，陈述事实与终态。数字、单位、专有名词保持精确。

Pattern: [thing] [action] [reason]. [next step].`,

  'wenyan-ultra': `CAVEMAN MODE ACTIVE — level: wenyan-ultra
文言凝练感，无废话、无过渡寒暄。单句单意，陈述事实与最终状态。数字、单位、技术专有名词保持绝对精准。简体为主。

Auto-Clarity: 遇安全警告、不可逆操作确认、多步序列可能误读、或用户要求澄清时，放弃压缩改用完整清晰表达。之后恢复。

Boundaries: 代码、提交、PR、文档等持久化产物一律写规范完整表达。`,
}

let cachedLevel: CavemanLevel | null = null

export function getCavemanLevel(): CavemanLevel {
  if (cachedLevel === null) {
    const settings = getInitialSettings()
    const raw = settings.cavemanLevel
    cachedLevel =
      typeof raw === 'string' && raw in CAVEMAN_INSTRUCTIONS
        ? (raw as CavemanLevel)
        : CAVEMAN_DEFAULT
  }
  return cachedLevel
}

export function setCavemanLevel(level: CavemanLevel): void {
  cachedLevel = level
  updateSettingsForSource('userSettings', {
    cavemanLevel: level === CAVEMAN_DEFAULT ? undefined : level,
  })
}

export function getCavemanInstructions(): string {
  return CAVEMAN_INSTRUCTIONS[getCavemanLevel()]
}
