import type { Command } from '../../commands.js'

const caveman = {
  type: 'local',
  name: 'caveman',
  description:
    'Toggle caveman compression mode: /caveman [lite|full|ultra|wenyan]',
  supportsNonInteractive: false,
  load: () => import('./caveman.js'),
} satisfies Command

export default caveman
