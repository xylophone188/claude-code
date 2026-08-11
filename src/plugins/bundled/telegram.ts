import { registerBuiltinPlugin } from '../builtinPlugins.js'
import { buildCliLaunch } from '../../utils/cliLaunch.js'

const launch = buildCliLaunch(['telegram', 'serve'])

export function registerTelegramBuiltinPlugin(): void {
  registerBuiltinPlugin({
    name: 'telegram',
    description:
      'Telegram Bot channel integration. Enables inbound Telegram messages via channels and provides reply/send_typing MCP tools. Configure with `ccb telegram login` and enable for a session with `--channels plugin:telegram@builtin`.',
    version: MACRO.VERSION,
    defaultEnabled: true,
    mcpServers: {
      telegram: {
        type: 'stdio',
        command: launch.execPath,
        args: launch.args,
      },
    },
  })
}
