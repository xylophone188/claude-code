#!/usr/bin/env bun
import { EdictPipeline } from './pipeline.js'
import type { EdictTaskState, PipelineContext } from './types.js'

async function main() {
  const args = process.argv.slice(2)
  const input = args.join(' ').trim()

  if (!input) {
    console.log('用法: bun run src/services/edict/cli.ts <任务指令>')
    console.log('示例: bun run src/services/edict/cli.ts "重构用户认证模块并增加单元测试"')
    process.exit(0)
  }

  console.log(`\n👑 [Edict] 启动三省六部确定性流水线...\n任务输入: "${input}"\n`)

  const pipeline = new EdictPipeline({
    onStateChange: (state: EdictTaskState, context: PipelineContext) => {
      const stateIcons: Record<EdictTaskState, string> = {
        Taizi: '🤴 [太子分流]',
        Chengxiang: '🏛️ [丞相评估]',
        Zhongshu: '📋 [中书拟旨]',
        Menxia: '🔍 [门下挑刺]',
        Zhenguo: '🛡️ [镇国裁决]',
        Assigned: '⚙️ [尚书派发]',
        Doing: '⚔️ [六部执行]',
        Review: '🧪 [尚书自查]',
        FinalReview: '⚖️ [御史终审]',
        Done: '✅ [准奏归档]',
        Blocked: '🚫 [阻断中断]',
      }
      console.log(`${stateIcons[state] ?? state} 流转至状态: ${state}`)
    },
    executor: async (subtaskId, dept, task) => {
      console.log(`   └─ ⚡ [${dept}] 正在执行: ${task?.title ?? subtaskId}`)
      // 模拟工期微延迟
      await new Promise(r => setTimeout(r, 60))
      return {
        success: true,
        output: `[${dept}] 成功完成子任务: ${task?.title ?? subtaskId}`,
      }
    },
  })

  const result = await pipeline.execute(input)

  if ('directResponse' in result) {
    console.log(`\n💬 [太子直出答复]:\n${result.directResponse}\n`)
    return
  }

  console.log('\n' + EdictPipeline.formatReport(result) + '\n')
}

if (import.meta.main) {
  main().catch(err => {
    console.error('Edict CLI 运行异常:', err)
    process.exit(1)
  })
}
