import { clearAccount, type AccountData } from './accounts.js'
import { startLogin } from './login.js'
import { confirmPairing } from './pairing.js'
import { runQqbotMcpServer } from './server.js'
import type { QqbotServerDeps } from './server.js'

function printUsage(): void {
  process.stdout.write(
    [
      'Usage:',
      '  ccb qqbot serve',
      '  ccb qqbot login <app_id> <client_secret>',
      '  ccb qqbot login clear',
      '  ccb qqbot access pair <code>',
      '',
      'Session enablement:',
      '  ccb --channels plugin:qqbot@builtin',
    ].join('\n') + '\n',
  )
}

async function runLogin(appId?: string, clientSecret?: string): Promise<void> {
  if (!appId || !clientSecret) {
    printUsage()
    process.exit(1)
  }

  const account: AccountData = {
    appId,
    clientSecret,
    savedAt: new Date().toISOString(),
  }

  const result = await startLogin(account)
  if (!result.connected) {
    process.stderr.write(`Login failed: ${result.message}\n`)
    process.exit(1)
  }

  process.stdout.write(
    [
      'Connected successfully!',
      '',
      'Restart Claude Code with:',
      '  ccb --channels plugin:qqbot@builtin',
    ].join('\n') + '\n',
  )
}

function runAccess(args: string[]): void {
  if (args[0] !== 'pair' || !args[1]) {
    printUsage()
    process.exit(1)
  }

  const userId = confirmPairing(args[1])
  if (!userId) {
    process.stderr.write('Invalid or expired pairing code.\n')
    process.exit(1)
  }

  process.stdout.write(`Paired successfully: ${userId}\n`)
}

export async function handleQqbotCli(
  args: string[],
  serverDeps?: QqbotServerDeps,
  version?: string,
): Promise<void> {
  const [subcommand, ...rest] = args

  switch (subcommand) {
    case 'serve':
      if (!serverDeps) {
        process.stderr.write(
          '[qqbot] serve handler not available in this context.\n',
        )
        process.exit(1)
      }
      await runQqbotMcpServer(version ?? '0.0.0', serverDeps)
      return
    case 'login':
      if (rest[0] === 'clear') {
        clearAccount()
        process.stdout.write('QQ account cleared.\n')
        return
      }
      await runLogin(rest[0], rest[1])
      return
    case 'access':
      runAccess(rest)
      return
    default:
      printUsage()
  }
}
