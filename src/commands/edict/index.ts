import type { Command, LocalCommandCall } from '../../types/command.js'
import { EdictPipeline } from '../../services/edict/pipeline.js'

const call: LocalCommandCall = async args => {
  const input = args.trim()
  if (!input || input === 'help' || input === '-h') {
    return {
      type: 'text',
      value:
        '📜 【Edict 三省六部确定性流水线】\n' +
        '用法: /edict <任务描述>\n' +
        '示例: /edict 构建并测试三省六部流水线\n' +
        '流程: 太子分流 -> 丞相可行性评估 -> 中书拟旨 -> 门下审议挑刺 -> 镇国公终局裁决 -> 尚书派发 -> 六部执行 -> 尚书自查 -> 御史台终审 -> 准奏归档。',
    }
  }

  const pipeline = new EdictPipeline()
  const result = await pipeline.execute(input)

  if ('directResponse' in result) {
    return {
      type: 'text',
      value: result.directResponse,
    }
  }

  return {
    type: 'text',
    value: EdictPipeline.formatReport(result),
  }
}

const edict = {
  type: 'local',
  name: 'edict',
  description: 'Run task through Edict (三省六部) deterministic pipeline',
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default edict
