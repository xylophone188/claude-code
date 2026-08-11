import type { Command } from '../../commands.js'

const ponytail = {
  type: 'local',
  name: 'ponytail',
  description: 'Toggle ponytail lazy mode: /ponytail [lite|full|ultra|off]',
  supportsNonInteractive: false,
  load: () => import('./ponytail.js'),
} satisfies Command

export default ponytail
