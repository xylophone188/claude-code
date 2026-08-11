import { clearAccount } from './accounts.js'
import { loginFromStdin, loginWithToken } from './login.js'
import { confirmPairing } from './pairing.js'
import { runTelegramMcpServer } from './server.js'
import type { TelegramServerDeps } from './server.js'

function printUsage(): void {
  process.stdout.write(
    [
      'Usage:',
      '  ccb telegram serve',
      '  ccb telegram login            (reads token from stdin)',
      '  ccb telegram login --token=... (token via flag; prefer stdin)',
      '  ccb telegram login clear',
      '  ccb telegram access pair <code>',
      '',
      'Session enablement:',
      '  ccb --channels plugin:telegram@builtin',
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

export async function handleTelegramCli(
  args: string[],
  serverDeps?: TelegramServerDeps,
  version?: string,
): Promise<void> {
  const [subcommand, ...rest] = args

  switch (subcommand) {
    case 'serve':
      if (!serverDeps) {
        process.stderr.write(
          '[telegram] serve handler not available in this context.\n',
        )
        process.exit(1)
      }
      await runTelegramMcpServer(version ?? '0.0.0', serverDeps)
      return
    case 'login':
      if (rest[0] === 'clear') {
        clearAccount()
        process.stdout.write('Telegram bot cleared.\n')
        return
      }
      // Optional --token=<token> for non-interactive flows. Prefer stdin.
      const flagToken = rest
        .find(arg => arg.startsWith('--token='))
        ?.slice('--token='.length)
      const result = flagToken
        ? await loginWithToken(flagToken)
        : await loginFromStdin()
      if (!result.connected) {
        process.stderr.write(`Login failed: ${result.message}\n`)
        process.exit(1)
      }
      process.stdout.write(
        [
          `${result.message}`,
          '',
          'Restart Claude Code with:',
          '  ccb --channels plugin:telegram@builtin',
        ].join('\n') + '\n',
      )
      return
    case 'access':
      runAccess(rest)
      return
    default:
      printUsage()
  }
}
