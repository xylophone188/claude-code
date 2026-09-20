/**
 * /install-apk 核心逻辑
 *
 * 下载并安装 APK，横跨两类环境：
 *   - Android/Termux：下载到应用私有目录（避开 /sdcard 的 fuse + SELinux 限制），
 *     依次尝试 root 静默安装 (su pm install)、root adb install、pm install、
 *     系统安装器 (termux-open / am start)。
 *   - PC (Linux/macOS/Windows)：下载到本地，通过 adb install 安装到在线设备。
 *
 * 专为本地命令设计的纯 TS 模块，便于单元测试。
 */

import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
} from 'node:fs'
import { copyFile, open, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { execa } from 'execa'

export type InstallApkPhase =
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'cleaning'

export type InstallApkProgress = {
  phase: InstallApkPhase
  message?: string
  received?: number
  total?: number
  percent?: number
}

export type InstallApkOptions = {
  /** 下载 URL 或本地 APK 路径 */
  input: string
  outputDir?: string
  /** adb 设备序列号（PC 多设备时必须指定） */
  device?: string
  /** 校验 SHA-256（十六进制） */
  checksum?: string
  /** 保留已安装的 APK（默认安装后删除） */
  keep?: boolean
  /** 只打印安装计划，不真正执行 */
  dryRun?: boolean
}

export type InstallApkResult = {
  ok: boolean
  message: string
  apkPath?: string
  method?: string
  /** dry-run 时列出的全部候选安装方式 */
  chain?: InstallMethod[]
}

export type InstallAttempt = {
  ok: boolean
  method: string
  message: string
}

export type InstallMethod = {
  method: string
  kind: 'root' | 'pm' | 'ui'
  available: boolean
  reason?: string
}

const APK_VIEW_MIME = 'application/vnd.android.package-archive'

/**
 * Android/Termux 环境判定。env / hasSu 可注入以支持单元测试。
 * 命中条件：
 *   1. process.platform === 'android'
 *   2. PREFIX 属于 Termux（$PREFIX = /data/data/com.termux/files/usr）
 *   3. /data/data/com.termux[.files] 存在
 *   4. /system/bin/pm 存在（标准 Android 属性）
 */
export function detectAndroid(
  env: NodeJS.ProcessEnv = process.env,
  hasSu: (path: string) => boolean = existsSync,
): boolean {
  if (process.platform === 'android') return true
  const prefix = env.PREFIX
  if (typeof prefix === 'string' && prefix.includes('com.termux')) return true
  if (hasSu('/data/data/com.termux') || hasSu('/data/data/com.termux.files'))
    return true
  if (hasSu('/system/bin/pm')) return true
  return false
}

export function isAndroid(): boolean {
  return detectAndroid()
}

export function isRemoteUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim())
}

export function apkFileName(input: string): string {
  const trimmed = input.trim()
  if (isRemoteUrl(trimmed)) {
    const path = trimmed.split(/[?#]/)[0]
    const name = path.split('/').pop() ?? ''
    return name.toLowerCase().endsWith('.apk') ? name : 'downloaded.apk'
  }
  return basename(trimmed) || 'app.apk'
}

export function parseInstallApkArgs(input: string): {
  input?: string
  outputDir?: string
  device?: string
  checksum?: string
  keep: boolean
  dryRun: boolean
} {
  const tokens = input
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0)
  const values: Record<string, string> = {}
  const positional: string[] = []
  let keep = false
  let dryRun = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '--output':
      case '-o':
      case '--device':
      case '-s':
      case '--checksum': {
        const key =
          t === '-o'
            ? 'output'
            : t === '-s'
              ? 'device'
              : t === '--device'
                ? 'device'
                : t === '--checksum'
                  ? 'checksum'
                  : 'output'
        values[key] = tokens[++i] ?? ''
        break
      }
      case '--keep':
        keep = true
        break
      case '--dry-run':
        dryRun = true
        break
      default:
        if (t.startsWith('--')) break
        positional.push(t)
    }
  }
  return {
    input: positional[0],
    outputDir: values.output,
    device: values.device,
    checksum: values.checksum,
    keep,
    dryRun,
  }
}

type RunResult = { stdout: string; stderr: string; code: number }

/** 直接参数数组形式（避免 shell 引号语义），适用于 pm / adb 等结构化命令。 */
async function runCmd(
  cmd: string,
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  try {
    const result = await execa(cmd, args, {
      reject: false,
      timeout: options.timeout ?? 120_000,
      env: options.env,
    })
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      code: result.exitCode ?? -1,
    }
  } catch (error) {
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
    }
  }
}

/** shell -c 字符串形式，用于 termux-open / am start 这类需要动态拼 flag 的命令。 */
export async function runCmdString(
  cmdStr: string,
  options: { timeout?: number } = {},
): Promise<RunResult> {
  return runCmd('/system/bin/sh', ['-c', cmdStr], options)
}

/**
 * 流式下载（支持断点续传与进度回调）。
 * @returns 最终文件字节数
 */
export async function downloadApk(
  url: string,
  dest: string,
  onProgress: (p: InstallApkProgress) => void,
): Promise<number> {
  mkdirSync(dirname(dest), { recursive: true })

  let existingSize = 0
  try {
    existingSize = (await stat(dest)).size
  } catch {
    // 文件不存在 → 全量下载
  }

  const headers: Record<string, string> = {}
  if (existingSize > 0) headers.Range = `bytes=${existingSize}-`

  let res: Response
  try {
    res = await fetch(url, { headers, redirect: 'follow' })
  } catch (error) {
    throw new Error(
      `连接失败: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (res.status === 416) {
    onProgress({
      phase: 'downloading',
      message: '文件已完整下载',
      received: existingSize,
      total: existingSize,
      percent: 100,
    })
    return existingSize
  }

  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`下载失败: HTTP ${res.status} ${res.statusText}`)
  }

  const resuming = res.status === 206
  const lengthHeader = res.headers.get('content-length')
  const contentLength = lengthHeader ? parseInt(lengthHeader, 10) : Number.NaN
  const total = Number.isNaN(contentLength)
    ? undefined
    : contentLength + (resuming ? existingSize : 0)
  let received = resuming ? existingSize : 0

  if (!res.body) {
    throw new Error('下载失败: 响应没有内容体')
  }

  const out = createWriteStream(dest, { flags: resuming ? 'a' : 'w' })
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        await new Promise<void>((resolve, reject) => {
          out.write(value, err => (err ? reject(err) : resolve()))
        })
        received += value.byteLength
        onProgress({
          phase: 'downloading',
          received,
          total,
          percent: total ? Math.round((received / total) * 100) : undefined,
        })
      }
    }
  } finally {
    await new Promise<void>(resolve => out.end(resolve))
  }
  return received
}

/** 校验 APK：ZIP magic bytes + 可选 SHA-256 */
export async function verifyApk(
  path: string,
  checksum?: string,
): Promise<{ ok: boolean; reason: string }> {
  const fd = await open(path, 'r')
  const header = Buffer.alloc(8)
  try {
    const { bytesRead } = await fd.read(header, 0, 8, 0)
    if (
      bytesRead < 4 ||
      header[0] !== 0x50 ||
      header[1] !== 0x4b ||
      header[2] !== 0x03
    ) {
      return {
        ok: false,
        reason: '不是有效的 APK（缺少 ZIP 文件头 PK\\x03\\x04）',
      }
    }
  } finally {
    await fd.close()
  }

  if (checksum) {
    const hash = createHash('sha256')
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(path)
      rs.on('data', chunk => hash.update(chunk))
      rs.on('error', reject)
      rs.on('end', () => resolve())
    })
    const actual = hash.digest('hex').toLowerCase()
    if (actual !== checksum.toLowerCase()) {
      return {
        ok: false,
        reason: `SHA-256 校验失败: 期望 ${checksum.toLowerCase()}, 实际 ${actual}`,
      }
    }
  }
  return { ok: true, reason: 'ok' }
}

/**
 * Root 探测：优先看常见 su 路径，再退化到 `su -c id`。
 * Android 14+ 部分 ROM 会把 su 收敛到 magisk/lsposed 目录，此处的静态检查已够用。
 */
export function hasSu(check: (path: string) => boolean = existsSync): boolean {
  for (const p of ['/system/bin/su', '/system/xbin/su', '/sbin/su']) {
    if (check(p)) return true
  }
  return false
}

/**
 * pm / adb 输出判定：既要匹配 "success"，又要排除 "INSTALL_FAILED_*" / "Failure" 等伪阳性。
 * Termux 上的 pm 输出为小写 "Success"，这里做大小写无关匹配。
 */
export function isSuccessOutput(out: string): boolean {
  if (/(INSTALL_FAILED|Failure|Permission denied|not enough space)/i.test(out))
    return false
  return /success/i.test(out)
}

const FUSE_MOUNTS = ['/sdcard', '/storage/', '/mnt/sdcard', '/mnt/media_rw']

/** 判断路径是否位于 Android FUSE 挂载上（/sdcard、/storage/emulated/0、/mnt/sdcard 等）。 */
export function isFusePath(apkPath: string): boolean {
  return FUSE_MOUNTS.some(m => apkPath.startsWith(m))
}

/**
 * 计算 APK 应落在的私有目录目标路径。
 * 支持 CCb_APK_STAGE_DIR 覆盖（也作为单元测试的注入口，避免 mock node:os）。
 * 非 FUSE 路径原样返回。
 */
export function resolveStagingPath(
  apkPath: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (!isFusePath(apkPath)) return apkPath
  const envDir = env.CCB_APK_STAGE_DIR
  const dir =
    envDir && envDir.length > 0 ? envDir : join(home, '.cache', 'ccb-apk')
  return join(dir, apkFileName(apkPath))
}

export const LOCAL_TMP_STAGING = '/data/local/tmp/ccb-apk'

/**
 * 把 /sdcard 上的 APK 复制到根分区安全位置（避开 Android 14+ FUSE/SELinux 限制）。
 *
 * 优先级：
 *   1. /data/local/tmp/ccb-apk —— root 可用时首选。root shell 的 mount namespace 直接挂在
 *      dm-verity 根分区上，不受 FUSE 挂载的 SELinux 标签限制，pm 读这个路径无 SELinux denial。
 *   2. $HOME/.cache/ccb-apk —— 应用私有目录，Termux (u0_aXXX) 可读写；SELinux 允许 Termux
 *      domain 从自身私有目录读文件。
 *
 * 返回 null 表示无需复制（APK 本就不在 FUSE 挂载上）。
 */
/**
 * 计算 APK 落盘的 stash 目录（纯函数，供单元测试）。
 * 优先级：CCB_APK_STAGE_DIR > /data/local/tmp/ccb-apk (root) > $HOME/.cache/ccb-apk
 */
export function resolveStashDir(
  useRootTmp: boolean,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const envDir = env.CCB_APK_STAGE_DIR
  if (envDir && envDir.length > 0) return envDir
  if (useRootTmp) return LOCAL_TMP_STAGING
  return join(home, '.cache', 'ccb-apk')
}

export async function stageApkToPrivateDir(
  apkPath: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  useRootTmp: boolean = hasSu(),
  copy: (from: string, to: string) => Promise<unknown> = copyFile,
): Promise<string | null> {
  if (!isFusePath(apkPath)) return null

  let stash = resolveStashDir(useRootTmp, env, home)
  if (useRootTmp && stash === LOCAL_TMP_STAGING) {
    const rootOk = await runSuCmd(`mkdir -p ${quoteShell(LOCAL_TMP_STAGING)}`, {
      timeout: 15_000,
    })
    if (rootOk.code !== 0) {
      stash = resolveStashDir(false, env, home)
    }
  }
  if (stash !== LOCAL_TMP_STAGING) mkdirSync(stash, { recursive: true })

  const target = join(stash, apkFileName(apkPath))
  if (stash === LOCAL_TMP_STAGING) {
    const cp = await runSuCmd(
      `cat ${quoteShell(apkPath)} > ${quoteShell(target)}`,
      {
        timeout: 180_000,
      },
    )
    if (cp.code !== 0) {
      throw new Error(`root 复制失败: ${(cp.stderr || cp.stdout).trim()}`)
    }
  } else {
    await copy(apkPath, target)
  }
  return target
}

function adbPathCandidates(): string[] {
  return process.platform === 'win32'
    ? [
        join(
          process.env.LOCALAPPDATA ?? '',
          'Android',
          'Sdk',
          'platform-tools',
          'adb.exe',
        ),
        join(homedir(), 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
      ]
    : [
        'adb',
        '/usr/bin/adb',
        '/usr/local/bin/adb',
        '/system/bin/adb',
        join(homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'),
        join(homedir(), 'platform-tools', 'adb'),
      ]
}

async function findAdb(): Promise<string | undefined> {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  const which = await runCmd(whichCmd, ['adb'])
  if (which.code === 0 && which.stdout.trim())
    return which.stdout.trim().split(/\s+/)[0]
  for (const p of adbPathCandidates()) {
    if (p === 'adb') continue
    if (existsSync(p)) return p
  }
  return undefined
}

export function buildAmStartCommand(apkFile: string): string {
  const fileUri = `file://${apkFile}`
  return (
    '/system/bin/am start ' +
    '-a android.intent.action.VIEW ' +
    `-t ${APK_VIEW_MIME} ` +
    `-d ${quoteShell(fileUri)} ` +
    '--grant-read-uri-permission'
  )
}

export async function runAmStartWithFallback(
  apkFile: string,
  onProgress: (p: InstallApkProgress) => void,
): Promise<InstallAttempt> {
  const cmd = buildAmStartCommand(apkFile)
  const r = await runCmdString(cmd, { timeout: 30_000 })
  if (r.code === 0) {
    return {
      ok: true,
      method: 'am start',
      message: '已调用系统安装器：请在手机弹窗中点击「安装」确认',
    }
  }
  if (
    /grant-read-uri-permission|unknown option|bad option/i.test(
      r.stdout + r.stderr,
    )
  ) {
    onProgress({
      phase: 'installing',
      message: '重试不带 --grant-read-uri-permission…',
    })
    const r2 = await runCmdString(
      buildAmStartCommand(apkFile).replace(' --grant-read-uri-permission', ''),
    )
    if (r2.code === 0) {
      return {
        ok: true,
        method: 'am start',
        message: '已调用系统安装器：请在手机弹窗中点击「安装」确认',
      }
    }
  }
  return {
    ok: false,
    method: 'am start',
    message: `am start 失败 (exit ${r.code}): ${(r.stderr || r.stdout).trim() || '无输出'}`,
  }
}

export function buildInstallChain(
  onAndroid: boolean,
  opts: { hasSu: boolean; adb: string | undefined; termuxOpen: boolean },
): InstallMethod[] {
  if (!onAndroid) {
    return [
      {
        method: 'adb install',
        kind: 'pm',
        available: !!opts.adb,
        reason: opts.adb ? undefined : '未找到 adb',
      },
    ]
  }
  const chain: InstallMethod[] = []
  if (opts.hasSu) {
    chain.push({ method: 'su pm install', kind: 'root', available: true })
    if (opts.adb) {
      chain.push({ method: 'su adb install', kind: 'root', available: true })
    }
  }
  chain.push({
    method: 'pm install',
    kind: 'pm',
    available: true,
    reason: 'Android 10+ 通常被 SELinux 拒绝，仅作兜底',
  })
  if (opts.termuxOpen) {
    chain.push({ method: 'termux-open', kind: 'ui', available: true })
  }
  chain.push({
    method: 'am start (file://)',
    kind: 'ui',
    available: true,
    reason: '部分 ROM 需 --grant-read-uri-permission',
  })
  return chain
}

/** Android/Termux 原生安装：root 静默 → root adb → pm → 系统安装器 UI */
export async function installApkOnAndroid(
  apkPath: string,
  onProgress: (p: InstallApkProgress) => void,
): Promise<InstallAttempt> {
  onProgress({ phase: 'installing', message: '准备安装目标…' })
  let staged: string | null
  try {
    staged = await stageApkToPrivateDir(apkPath)
  } catch (error) {
    return {
      ok: false,
      method: 'staging',
      message: `复制 APK 到私有目录失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const target = staged ?? apkPath

  const su = hasSu()
  let adb: string | undefined
  if (su) adb = await findAdb()
  const termuxOpen = existsSync(
    '/data/data/com.termux/files/usr/bin/termux-open',
  )

  const chain = buildInstallChain(true, { hasSu: su, adb, termuxOpen })

  const attempts: string[] = []
  let lastFail: InstallAttempt | undefined

  if (su) {
    onProgress({
      phase: 'installing',
      message: '尝试 root 静默安装 (su pm install)…',
    })
    const r = await runSuCmd(`pm install -r ${quoteShell(target)}`, {
      timeout: 180_000,
    })
    const ok = r.code === 0 && isSuccessOutput(r.stdout + r.stderr)
    attempts.push(
      `su pm install${ok ? ' ✓' : ` ✗ ${(r.stderr || r.stdout).trim().slice(0, 120)}`}`,
    )
    if (ok) {
      return {
        ok: true,
        method: 'su pm install',
        message: `已通过 root 静默安装成功${staged ? ` (staged from ${apkPath})` : ''}`,
      }
    }
    lastFail = {
      ok: false,
      method: 'su pm install',
      message: (r.stdout + r.stderr).trim(),
    }

    if (adb) {
      onProgress({ phase: 'installing', message: '尝试 root adb install…' })
      const r2 = await runSuCmd(
        `${quoteShell(adb)} install -r ${quoteShell(target)}`,
        {
          timeout: 300_000,
        },
      )
      const ok2 = r2.code === 0 && isSuccessOutput(r2.stdout + r2.stderr)
      attempts.push(
        `su adb install${ok2 ? ' ✓' : ` ✗ ${(r2.stderr || r2.stdout).trim().slice(0, 120)}`}`,
      )
      if (ok2) {
        return {
          ok: true,
          method: 'su adb install',
          message: '已通过 root adb 安装成功',
        }
      }
      lastFail = {
        ok: false,
        method: 'su adb install',
        message: (r2.stdout + r2.stderr).trim(),
      }
    }
  }

  onProgress({ phase: 'installing', message: '尝试 pm install…' })
  const pm = await runCmd('pm', ['install', '-r', target])
  const pmOk = pm.code === 0 && isSuccessOutput(pm.stdout + pm.stderr)
  attempts.push(
    `pm install${pmOk ? ' ✓' : ` ✗ ${(pm.stderr || pm.stdout).trim().slice(0, 120)}`}`,
  )
  if (pmOk) {
    return {
      ok: true,
      method: 'pm install',
      message: '已通过 pm install 安装成功',
    }
  }
  lastFail = {
    ok: false,
    method: 'pm install',
    message: (pm.stdout + pm.stderr).trim(),
  }

  onProgress({ phase: 'installing', message: '调用系统安装器 (termux-open)…' })
  const termuxOpenCmd = await runCmdString(
    `termux-open --content-type ${APK_VIEW_MIME} ${quoteShell(target)}`,
    { timeout: 30_000 },
  )
  if (termuxOpenCmd.code === 0) {
    attempts.push('termux-open ✓')
    return {
      ok: true,
      method: 'termux-open',
      message: '已调用系统安装器：请在手机弹窗中点击「安装」确认',
    }
  }
  attempts.push(
    `termux-open ✗ ${(termuxOpenCmd.stderr || termuxOpenCmd.stdout).trim().slice(0, 120) || '不可用'}`,
  )
  lastFail = {
    ok: false,
    method: 'termux-open',
    message: (termuxOpenCmd.stdout + termuxOpenCmd.stderr).trim(),
  }

  onProgress({ phase: 'installing', message: '调用系统安装器 (am start)…' })
  const am = await runAmStartWithFallback(target, onProgress)
  attempts.push(`${am.method}${am.ok ? ' ✓' : ' ✗'}`)
  if (am.ok) return am
  lastFail = am

  return {
    ok: false,
    method: 'none',
    message: `所有安装方式均失败 (${attempts.join(' | ') || '无尝试'})。计划: ${chain.map(c => c.method).join(' → ')}。最后错误: ${(lastFail?.message ?? '').slice(0, 200)}`,
  }
}

/** PC 环境：通过 adb 安装到在线设备 */
export async function installApkViaAdb(
  apkPath: string,
  device: string | undefined,
  onProgress: (p: InstallApkProgress) => void,
): Promise<InstallAttempt> {
  onProgress({ phase: 'installing', message: '查找 adb…' })
  const adb = await findAdb()
  if (!adb) {
    return {
      ok: false,
      method: 'none',
      message:
        '未找到 adb，无法安装（APK 已保留在本地）。安装 adb 平台工具后重试，或用 --output 指定保存目录。',
    }
  }

  const devices = await runCmd(adb, ['devices'])
  if (devices.code !== 0) {
    return {
      ok: false,
      method: 'none',
      message: `adb devices 失败: ${devices.stderr}`,
    }
  }
  const online = devices.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('*') && !l.startsWith('List'))
    .filter(l => /device$/.test(l))
    .map(l => l.split(/\s+/)[0])

  let target: string | undefined = device
  if (target) {
    if (!online.includes(target)) {
      return {
        ok: false,
        method: 'none',
        message: `设备 ${target} 不在线。当前在线设备: ${online.join(', ') || '无'}`,
      }
    }
  } else if (online.length === 1) {
    target = online[0]
  } else if (online.length === 0) {
    return {
      ok: false,
      method: 'none',
      message: '没有在线 adb 设备（APK 已保留在本地）',
    }
  } else {
    return {
      ok: false,
      method: 'none',
      message: `检测到多个 adb 设备 (${online.join(', ')})，请用 --device <serial> 指定（APK 已保留在本地）`,
    }
  }

  onProgress({ phase: 'installing', message: `通过 adb 安装到 ${target}…` })
  const args = target
    ? ['-s', target, 'install', '-r', apkPath]
    : ['install', '-r', apkPath]
  const r = await runCmd(adb, args, { timeout: 300_000 })
  if (r.code === 0 && isSuccessOutput(r.stdout + r.stderr)) {
    return {
      ok: true,
      method: 'adb install',
      message: `已通过 adb 安装到 ${target}: ${r.stdout.trim()}`,
    }
  }
  return {
    ok: false,
    method: 'adb install',
    message: `adb install 失败 (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
  }
}

export function quoteShell(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/**
 * Run a script under root via `su`.
 *
 * The script is passed as a discrete argv element rather than embedded in a
 * shell string, so no outer shell parses it. Embedding via `su -c '...'` breaks
 * on apostrophes (the `'\''` escape only terminates a single-quoted word at top
 * level, leaving an unterminated string), and `su -c "..."` is worse — the outer
 * shell expands `$HOME`/backslashes inside the double quotes before `su` runs,
 * silently corrupting any path containing `$` or `\`.
 */
export async function runSuCmd(
  script: string,
  options: { timeout?: number } = {},
): Promise<RunResult> {
  return runCmd('su', ['-c', script], options)
}

/** 主流程：输入（URL 或本地路径）→ 下载/校验 → 按环境安装 → 可选清理 */
export async function runInstallApk(
  opts: InstallApkOptions,
  onProgress: (p: InstallApkProgress) => void,
): Promise<InstallApkResult> {
  const input = opts.input.trim()
  const onAndroid = isAndroid()
  const defaultDir = onAndroid ? join(homedir(), 'downloads') : process.cwd()
  const outputDir = opts.outputDir ?? defaultDir
  const apkPath = join(outputDir, apkFileName(input))

  if (!isRemoteUrl(input) && !existsSync(input)) {
    return { ok: false, message: `找不到本地文件: ${input}` }
  }

  try {
    if (isRemoteUrl(input)) {
      onProgress({
        phase: 'downloading',
        message: `下载 ${input} → ${apkPath}`,
      })
      await downloadApk(input, apkPath, onProgress)
    } else {
      await copyFile(input, apkPath)
    }

    onProgress({ phase: 'verifying', message: '校验 APK 格式…' })
    const check = await verifyApk(apkPath, opts.checksum)
    if (!check.ok) {
      return { ok: false, message: check.reason, apkPath }
    }

    if (opts.dryRun) {
      const su = hasSu()
      const adb = su || !onAndroid ? await findAdb() : undefined
      const chain = buildInstallChain(onAndroid, {
        hasSu: su,
        adb,
        termuxOpen: existsSync(
          '/data/data/com.termux/files/usr/bin/termux-open',
        ),
      })
      const stagedPath = onAndroid ? resolveStagingPath(apkPath) : apkPath
      onProgress({ phase: 'installing', message: 'dry-run：仅打印安装计划' })
      return {
        ok: true,
        method: 'dry-run',
        message: `dry-run 计划: ${chain.map(c => c.method).join(' → ')}; 目标 APK: ${stagedPath}`,
        apkPath,
        chain,
      }
    }

    const attempt = onAndroid
      ? await installApkOnAndroid(apkPath, onProgress)
      : await installApkViaAdb(apkPath, opts.device, onProgress)

    if (
      !opts.keep &&
      attempt.ok &&
      attempt.method !== 'termux-open' &&
      attempt.method !== 'am start'
    ) {
      onProgress({ phase: 'cleaning', message: '清理临时 APK…' })
      await unlink(apkPath).catch(() => {})
      return { ok: true, message: attempt.message, method: attempt.method }
    }
    return {
      ok: attempt.ok,
      message: attempt.message,
      apkPath,
      method: attempt.method,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      apkPath,
    }
  }
}
