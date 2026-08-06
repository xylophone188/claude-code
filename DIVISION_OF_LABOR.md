# 多端分工（责任归属）

本仓库（ccb-source，claude-code-best/claude-code）及 ccb 相关脚本（wrapper、ccb-pipeline 等）的**源码改动默认在 PC（Ubuntu）完成**：编译、测试、网络环境都优于手机 Termux。Termux（Android 手机）侧充当**分发枢纽**：把不适合手机侧完成的任务经可用通道交到 PC，整体派发、脱手、事件驱动监控；只在 Termux 真正只能/只适合本地完成时才亲自动手。

## 归属判断（三层）

1. **PC 环境更适合**（改代码 / 构建 / 测试 / 需要稳定网络）→ 交给 PC 完成。
   派发方式：dropzone 传任务文本（`CCB_DROP_TAG=ccb-drop-r ccb-pub <task>.txt`，避免 ssh 引号嵌套），再 `ssh pc 'ccb-grab; nohup ccb-pipeline "$TASK" > log 2>&1 &'` 整体派发（ssh 返回后远端 nohup 存活），之后只做短探测 `ssh pc 'tail <log>'`。
2. **必须 Termux 本地** → 先判 PC 回连处理是否反而更好（PC 可 `ssh -p 22024` 回连手机，或经 adb / lan / ov-tunnel）→ 是则交 PC 远程处理。
3. **真正只能/只适合 Termux 本地** → Termux 本地完成（手机端常驻、手机特有资源、本地代理等）。

## 通道

cft（cloudflared）/ vps / tg / gitee / github / qq / weixin / feishu / ccb-pub dropzone / ssh（`pc` 别名 = melody@49.51.228.166:22023）。

## 分工要点

- 源码与脚本修改、重构建、需要完整工具链/稳定网络的工作 → PC。
- 任务派发、跨机文件搬运、事件驱动接收与监控 → 优先整体派发让 PC 自推，Termux 不逐步骤编排。
- 同一工作目录禁止 Termux 与 PC 并发修改。
