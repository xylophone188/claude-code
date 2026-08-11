/**
 * ccbRouting / advisorQuota — stateful per-tier quota rotator.
 *
 * Mirrors ccb's advisor-quota logic: rotates round-robin across the models
 * of a tier, skipping any model that is over quota or marked unhealthy, and
 * tracks per-model hourly usage.
 *
 * PURE and in-memory: instance state only (no network, no DB, no globals).
 */
import {
  DEFAULT_ADVISOR_TIERS,
  QUOTA_TARGET_PER_HOUR,
  type AdvisorTier,
} from './advisor.js'

export interface AdvisorQuotaConfig {
  tiers?: AdvisorTier[]
  quotaTargetPerHour?: number
}

export class AdvisorQuota {
  private readonly tiers: AdvisorTier[]
  private readonly quotaTargetPerHour: number
  private readonly usageCount = new Map<string, number>()
  private readonly unhealthy = new Set<string>()
  private readonly cursor = new Map<string, number>()

  constructor(config?: AdvisorQuotaConfig) {
    this.tiers =
      config?.tiers && config.tiers.length > 0
        ? config.tiers
        : DEFAULT_ADVISOR_TIERS
    this.quotaTargetPerHour =
      typeof config?.quotaTargetPerHour === 'number' &&
      config.quotaTargetPerHour > 0
        ? config.quotaTargetPerHour
        : QUOTA_TARGET_PER_HOUR
    for (const tier of this.tiers) this.cursor.set(tier.name, 0)
  }

  /** Returns the next model in the tier, rotating round-robin and skipping over-quota/unhealthy models. */
  next(tierName: string): string {
    const tier = this.tiers.find(t => t.name === tierName)
    if (!tier || tier.models.length === 0) return ''

    const start = this.cursor.get(tierName) ?? 0
    for (let i = 0; i < tier.models.length; i++) {
      const idx = (start + i) % tier.models.length
      const model = tier.models[idx]
      if (this.isAvailable(model)) {
        // Advance the cursor past the selected model for the next call.
        this.cursor.set(tierName, (idx + 1) % tier.models.length)
        return model
      }
    }
    return ''
  }

  /** Records a successful use, incrementing the per-hour counter for the model. */
  markUsed(model: string): void {
    if (!model) return
    this.usageCount.set(model, (this.usageCount.get(model) ?? 0) + 1)
  }

  /** Marks a model unhealthy / over-quota so next() skips it. */
  recordFailure(model: string): void {
    if (!model) return
    this.unhealthy.add(model)
  }

  /** Clears all counters and unhealthy flags (test helper). */
  reset(): void {
    this.usageCount.clear()
    this.unhealthy.clear()
    for (const tier of this.tiers) this.cursor.set(tier.name, 0)
  }

  /** Returns current per-model hourly usage counts. */
  usage(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [model, count] of this.usageCount) out[model] = count
    return out
  }

  private isAvailable(model: string): boolean {
    if (this.unhealthy.has(model)) return false
    return (this.usageCount.get(model) ?? 0) < this.quotaTargetPerHour
  }
}
