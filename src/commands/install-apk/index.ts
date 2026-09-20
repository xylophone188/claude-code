import type { Command } from '../../commands.js'

const installApk = {
  type: 'local-jsx',
  name: 'install-apk',
  aliases: ['iapk'],
  description:
    'Download an APK and install it (Termux/Android natively, adb on PC)',
  description_zh:
    '下载 APK 并安装：Termux/Android 原生安装（root su→root adb→pm→termux-open→am start 多级自愈），PC 上通过 adb 安装',
  argumentHint:
    '<url|local-path> [--device <serial>] [--output <dir>] [--checksum <sha256>] [--keep] [--dry-run]',
  whenToUse:
    '需要下载并安装 APK 到本机（Termux/Android，自动识别 Android 环境并规避 /sdcard 的 FUSE/SELinux 限制，APK 自动流转至 /data/local/tmp 或应用私有缓存目录执行 pm install），或在 PC 上通过 adb 安装到已连接设备时使用。用 --dry-run 仅打印安装计划。',
  version: '1.0.0',
  load: () => import('./install-apk.js'),
} satisfies Command

export default installApk
