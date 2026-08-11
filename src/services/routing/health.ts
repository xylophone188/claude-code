/**
 * ccbRouting / health — provider health-checking.
 *
 * PURE by default: checkProviderHealth / checkAll take an injectable Probe so
 * tests (and callers) can avoid real network I/O. defaultTcpProbe is the
 * built-in real probe; it parses host:port out of provider.baseUrl and measures
 * a TCP connect latency.
 */
import net from 'node:net'
import type { CCBRoutingProvider } from './types.js'
import { listProviders } from './resolve.js'

/** Result of probing a single provider. */
export interface HealthResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

/** A probe checks one provider and returns a HealthResult. */
export type Probe = (provider: CCBRoutingProvider) => Promise<HealthResult>

/** Parse host + port from a base URL. Defaults to port 80 / 443 by scheme. */
function parseHostPort(baseUrl: string): { host: string; port: number } {
  let rest = baseUrl
  const protoSlash = rest.indexOf('://')
  let scheme = 'http'
  if (protoSlash !== -1) {
    scheme = rest.slice(0, protoSlash).toLowerCase()
    rest = rest.slice(protoSlash + 3)
  }
  const slash = rest.indexOf('/')
  const authority = slash === -1 ? rest : rest.slice(0, slash)
  const at = authority.indexOf('@')
  const hostport = at === -1 ? authority : authority.slice(at + 1)
  const colon = hostport.lastIndexOf(':')
  let host: string
  let port: number
  if (colon !== -1 && hostport[colon + 1] !== '/') {
    host = hostport.slice(0, colon)
    port = Number.parseInt(hostport.slice(colon + 1), 10)
  } else {
    host = hostport
    port = scheme === 'https' ? 443 : 80
  }
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'))
  if (!Number.isFinite(port)) port = scheme === 'https' ? 443 : 80
  return { host, port }
}

/**
 * Built-in TCP probe. Connects to the provider's host:port, measures latency,
 * and closes. Rejects/handles errors as a failed HealthResult.
 */
export function defaultTcpProbe(
  provider: CCBRoutingProvider,
): Promise<HealthResult> {
  const { host, port } = parseHostPort(provider.baseUrl)
  const start = Date.now()
  return new Promise<HealthResult>(resolve => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const finish = (result: HealthResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    socket.on('connect', () => {
      finish({ ok: true, latencyMs: Date.now() - start })
      socket.destroy()
    })
    socket.on('error', err => {
      finish({
        ok: false,
        latencyMs: Date.now() - start,
        error: (err as Error).message,
      })
    })
    socket.on('timeout', () => {
      finish({ ok: false, latencyMs: Date.now() - start, error: 'timeout' })
      socket.destroy()
    })
  })
}

/**
 * Check a single provider's health. Uses the injected probe, or the built-in
 * defaultTcpProbe when none is provided.
 */
export async function checkProviderHealth(
  provider: CCBRoutingProvider,
  probe?: Probe,
): Promise<HealthResult> {
  const use = probe ?? defaultTcpProbe
  return use(provider)
}

/**
 * Check health of all providers. Accepts an explicit list, or falls back to
 * resolve.listProviders(). Returns a map keyed by provider id.
 */
export async function checkAll(
  probe?: Probe,
  providers?: CCBRoutingProvider[],
): Promise<Record<string, HealthResult>> {
  const list = providers ?? listProviders()
  const entries = await Promise.all(
    list.map(
      async (p): Promise<[string, HealthResult]> => [
        p.id,
        await checkProviderHealth(p, probe),
      ],
    ),
  )
  return Object.fromEntries(entries)
}
