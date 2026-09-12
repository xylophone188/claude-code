import { beforeEach, describe, expect, it } from 'bun:test'
import {
  isAccountAdmitted,
  isModel404Pending,
  isModelAdmitted,
  isProviderAdmitted,
  lastModelNotAdmittedStatus,
  recordAccountNotAdmitted,
  recordModelNotAdmitted,
  recordProviderNotAdmitted,
  resetAdmissions,
} from '../admission.js'

describe('admission gate', () => {
  beforeEach(() => {
    resetAdmissions()
  })

  it('admits by default when nothing was recorded', () => {
    expect(isProviderAdmitted('sensenova')).toBe(true)
    expect(isModelAdmitted('sensenova', 'glm-5.2')).toBe(true)
    expect(isAccountAdmitted('sensenova', 'sn-key')).toBe(true)
  })

  it('excludes a provider after a 404 and re-admits after the window', () => {
    const now = 1_000_000
    recordProviderNotAdmitted('sensenova', 404, now)
    expect(isProviderAdmitted('sensenova', now)).toBe(false)
    expect(isProviderAdmitted('sensenova', now + 9 * 60 * 1000)).toBe(false)
    // window has elapsed → re-admitted and entry is cleaned up
    expect(isProviderAdmitted('sensenova', now + 11 * 60 * 1000)).toBe(true)
  })

  it('does not exclude a different provider sharing the id prefix', () => {
    recordProviderNotAdmitted('sensenova', 404, 100)
    expect(isProviderAdmitted('sensenova-other', 100)).toBe(true)
  })

  it('excludes a single model, leaving sibling models admitted', () => {
    recordModelNotAdmitted('sensenova', 'glm-5.2', 404, 100)
    expect(isModelAdmitted('sensenova', 'glm-5.2', 100)).toBe(false)
    expect(isModelAdmitted('sensenova', 'deepseek-v4-flash', 100)).toBe(true)
  })

  it('tracks the 404 status so callers can invalidate the catalog once', () => {
    recordModelNotAdmitted('opencode', 'mimo-v2.5-free', 404, 100)
    expect(lastModelNotAdmittedStatus('opencode', 'mimo-v2.5-free', 100)).toBe(
      404,
    )
    expect(isModel404Pending('opencode', 'mimo-v2.5-free', 100)).toBe(true)
    // other statuses never flag 404 invalidation
    recordModelNotAdmitted('opencode', 'mimo-v2.5-free', 400, 200)
    expect(isModel404Pending('opencode', 'mimo-v2.5-free', 200)).toBe(false)
  })

  it('expires model exclusions after the model window', () => {
    const now = 1_000_000
    recordModelNotAdmitted('opencode', 'mimo-v2.5-free', 404, now)
    expect(
      isModelAdmitted('opencode', 'mimo-v2.5-free', now, {
        modelWindowMs: 30 * 60 * 1000,
      }),
    ).toBe(false)
    expect(
      isModelAdmitted('opencode', 'mimo-v2.5-free', now + 31 * 60 * 1000, {
        modelWindowMs: 30 * 60 * 1000,
      }),
    ).toBe(true)
  })

  it('excludes an account (api key) after 401/403, not after 404', () => {
    recordAccountNotAdmitted('sensenova', 'sn-key', 401, 100)
    expect(isAccountAdmitted('sensenova', 'sn-key', 100)).toBe(false)
    expect(isAccountAdmitted('sensenova', 'other-key', 100)).toBe(true)
  })

  it('accepts a non-default status for the not-found family', () => {
    recordProviderNotAdmitted('nvidia', 403, 100)
    expect(isProviderAdmitted('nvidia', 100)).toBe(false)
  })
})
