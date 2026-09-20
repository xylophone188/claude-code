import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export type AndroidPrivilegedEnvironment = {
  hasSu: boolean
  suVersion?: string
  rootType?: 'KernelSU' | 'Magisk' | 'APatch' | 'Unknown'
  hasLSPosed: boolean
  hasZigisk: boolean
}

export function isAndroidEnvironment(): boolean {
  return (
    process.platform === 'android' ||
    Boolean(process.env.PREFIX?.toLowerCase().includes('termux'))
  )
}

export function detectAndroidPrivilegedEnvironment(): AndroidPrivilegedEnvironment {
  if (!isAndroidEnvironment()) {
    return {
      hasSu: false,
      hasLSPosed: false,
      hasZigisk: false,
    }
  }

  let hasSu = false
  let suVersion: string | undefined
  let rootType: 'KernelSU' | 'Magisk' | 'APatch' | 'Unknown' | undefined
  let hasLSPosed = false
  let hasZigisk = false

  const suPaths = [
    '/system/bin/su',
    '/system/xbin/su',
    '/sbin/su',
    '/data/data/com.termux/files/usr/bin/su',
  ]
  const hasStaticSu = suPaths.some(p => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  })

  try {
    const v = execSync('su -v', {
      timeout: 1000,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    if (v) {
      hasSu = true
      suVersion = v
      if (/KernelSU/i.test(v)) rootType = 'KernelSU'
      else if (/Magisk/i.test(v)) rootType = 'Magisk'
      else if (/APatch/i.test(v)) rootType = 'APatch'
    }
  } catch {
    if (hasStaticSu) {
      hasSu = true
    }
  }

  if (hasSu) {
    try {
      const probe = execSync(
        "su -c 'test -d /data/adb/lspd && echo lspd; test -d /data/adb/zygisksu && echo zygisk; test -d /data/adb/modules/zygisk && echo zygisk; test -d /data/adb/ksu && echo ksu; test -d /data/adb/magisk && echo magisk; true'",
        {
          timeout: 1500,
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      )
        .toString()
        .trim()
      if (probe.includes('lspd')) hasLSPosed = true
      if (probe.includes('zygisk')) hasZigisk = true
      if (probe.includes('ksu')) rootType = 'KernelSU'
      else if (probe.includes('magisk') && !rootType) rootType = 'Magisk'
    } catch {
      // su execution timeout or permission denial
    }
    if (!rootType) rootType = 'Unknown'
  }

  return { hasSu, suVersion, rootType, hasLSPosed, hasZigisk }
}

let cachedPrompt: string | null | undefined

export function getAndroidPrivilegedEnvPrompt(): string | null {
  if (cachedPrompt !== undefined) return cachedPrompt
  if (!isAndroidEnvironment()) {
    cachedPrompt = null
    return null
  }

  const env = detectAndroidPrivilegedEnvironment()
  const rootLabel = env.rootType
    ? env.suVersion
      ? `${env.rootType} (${env.suVersion})`
      : env.rootType
    : '未检测到 root 管理器'

  const capabilities = [
    '宿主特权环境：' + rootLabel,
    'su：' + (env.hasSu ? '可用' : '未检测到'),
    'LSPosed：' + (env.hasLSPosed ? '可用' : '未检测到'),
    'Zygisk：' + (env.hasZigisk ? '可用' : '未检测到'),
  ].join('；')

  const suInstruction = env.hasSu
    ? '宿主具备 Root 特权，可以通过 su -c 执行静默命令，包括系统包管理、应用启动与控制、静默安装与卸载 APK。'
    : '当前未检测到可用的 su，不要假设可以执行 root 命令。'

  cachedPrompt =
    'Android 特权环境提示：' +
    capabilities +
    '。' +
    suInstruction +
    ' 在需要安装 APK 或管理系统包时，若 su 可用，必须优先使用 su -c 的静默方式（如 pm install-create / pm install）；严禁让用户手动使用前台安装器或弹窗交互。'

  return cachedPrompt
}

export function resetCachedPrompt(): void {
  cachedPrompt = undefined
}
