import type { Command } from '../../commands.js'

const rtk = {
  type: 'local',
  name: 'rtk',
  description:
    'Toggle rtk output compression: /rtk [off|compact|ultra-compact]',
  supportsNonInteractive: false,
  load: () => import('./rtk.js'),
} satisfies Command

export default rtk
