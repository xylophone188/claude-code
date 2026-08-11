import { registerBuiltinPlugin } from '../builtinPlugins.js'
import { buildCliLaunch } from '../../utils/cliLaunch.js'

const launch = buildCliLaunch(['qqbot', 'serve'])

export function registerQqbotBuiltinPlugin(): void {
  registerBuiltinPlugin({
    name: 'qqbot',
    description:
      'QQ Bot channel integration. Enables inbound QQ messages via channels and provides reply/send_typing MCP tools. Configure with `ccb qqbot login` and enable for a session with `--channels plugin:qqbot@builtin`.',
    version: MACRO.VERSION,
    defaultEnabled: true,
    mcpServers: {
      qqbot: {
        type: 'stdio',
        command: launch.execPath,
        args: launch.args,
      },
    },
  })
}
