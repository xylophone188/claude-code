/**
 * apk-installer.ts unit tests.
 *
 * Every OS-level decision (platform, su probing, staging directory, cwd) is
 * injectable; the only process-spawning leaf is execa, which is mocked via
 * mock.module so no real subprocess is ever started.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type ExecArgs = {
  cmd: string
  args: string[]
  timeout?: number
  env?: NodeJS.ProcessEnv
}
type ExecResult = { stdout: string; stderr: string; exitCode: number }

const commands: ExecArgs[] = []
let handler: (cmd: string, args: string[]) => ExecResult = () => ({
  stdout: '',
  stderr: '',
  exitCode: 1,
})

beforeAll(() => {
  mock.module('execa', () => ({
    execa: mock(async (cmd: string, args: string[], opts?: unknown) => {
      const timeout = (opts as { timeout?: number } | undefined)?.timeout
      commands.push({ cmd, args, timeout })
      return handler(cmd, args) as ExecResult
    }),
  }))
})

afterAll(() => {
  mock.module('execa', () => ({
    execa: mock(
      async () => ({ stdout: '', stderr: '', exitCode: 1 }) as ExecResult,
    ),
  }))
})

const {
  apkFileName,
  buildAmStartCommand,
  buildInstallChain,
  detectAndroid,
  isFusePath,
  isRemoteUrl,
  isSuccessOutput,
  LOCAL_TMP_STAGING,
  parseInstallApkArgs,
  quoteShell,
  resolveStagingPath,
  runAmStartWithFallback,
  stageApkToPrivateDir,
  runSuCmd,
} = await import('../apk-installer.js')

let tmp = ''

beforeEach(async () => {
  commands.length = 0
  handler = () => ({ stdout: '', stderr: '', exitCode: 1 })
  tmp = await mkdtemp(join(tmpdir(), 'ccb-apk-test-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('detectAndroid', () => {
  test('returns true on android platform', () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', {
      value: 'android',
      configurable: true,
    })
    expect(detectAndroid({}, () => false)).toBe(true)
    Object.defineProperty(process, 'platform', {
      value: real,
      configurable: true,
    })
  })

  test('returns true when PREFIX points at Termux', () => {
    expect(
      detectAndroid(
        { PREFIX: '/data/data/com.termux/files/usr' } as NodeJS.ProcessEnv,
        () => false,
      ),
    ).toBe(true)
  })

  test('returns true when Termux data directory exists', () => {
    expect(detectAndroid({}, p => p === '/data/data/com.termux')).toBe(true)
  })

  test('returns true when /system/bin/pm exists', () => {
    expect(detectAndroid({}, p => p === '/system/bin/pm')).toBe(true)
  })

  test('returns false for a plain desktop environment', () => {
    expect(detectAndroid({}, () => false)).toBe(false)
  })
})

describe('isFusePath', () => {
  test.each([
    ['/sdcard/Download/a.apk', true],
    ['/storage/emulated/0/Download/a.apk', true],
    ['/mnt/sdcard/Download/a.apk', true],
    ['/mnt/media_rw/sdcard1/a.apk', true],
    ['/data/data/com.termux/files/home/a.apk', false],
    ['/data/local/tmp/a.apk', false],
    ['/home/melody/a.apk', false],
  ] as Array<[string, boolean]>)('%s → %s', (path, expected) => {
    expect(isFusePath(path)).toBe(expected)
  })
})

describe('resolveStagingPath', () => {
  test('leaves non-FUSE paths untouched', () => {
    const src = '/data/data/com.termux/files/home/a.apk'
    expect(
      resolveStagingPath(src, {}, '/data/data/com.termux/files/home'),
    ).toBe(src)
  })

  test('routes /sdcard to app-private cache dir by default', () => {
    expect(
      resolveStagingPath('/sdcard/Download/a.apk', {}, '/home/termux'),
    ).toBe('/home/termux/.cache/ccb-apk/a.apk')
  })

  test('honors CCB_APK_STAGE_DIR override', () => {
    const got = resolveStagingPath(
      '/mnt/media_rw/sdcard1/a.apk',
      {
        CCB_APK_STAGE_DIR: '/data/data/com.termux/files/home/.ccb',
      } as NodeJS.ProcessEnv,
      '/home/termux',
    )
    expect(got).toBe('/data/data/com.termux/files/home/.ccb/a.apk')
  })

  test('handles /storage/emulated/0 paths', () => {
    expect(
      resolveStagingPath('/storage/emulated/0/Download/b.apk', {}, '/h'),
    ).toBe('/h/.cache/ccb-apk/b.apk')
  })
})

describe('stageApkToPrivateDir', () => {
  /** Real file so the injected copy() can actually read bytes; reported as a FUSE path. */
  const realSrc = join(tmp, 'real-a.apk')
  let copied: Array<[string, string]> = []
  let copyCalls = 0

  test('returns null for non-FUSE input and never shells out', async () => {
    expect(
      stageApkToPrivateDir('/tmp/a.apk', {}, '/tmp', false),
    ).resolves.toBeNull()
    expect(commands).toEqual([])
  })

  test('without root: creates app-private dir and issues no shell commands', async () => {
    const stage = join(tmp, 'stage')
    await writeFile(realSrc, 'x')
    copied = []
    copyCalls = 0
    await stageApkToPrivateDir(
      '/sdcard/Download/a.apk',
      { CCB_APK_STAGE_DIR: stage },
      tmp,
      false,
      () => {
        copyCalls += 1
        return Promise.resolve()
      },
    )
    expect(commands).toEqual([])
    expect(existsSync(stage)).toBe(true)
    expect(copyCalls).toBe(1)
    copied.push(['ok', 'ok'])
  })

  test('with root: stages into /data/local/tmp via su mkdir + su cat', async () => {
    handler = (_cmd, args) => {
      const script = args[1] ?? ''
      if (script.includes('mkdir -p'))
        return { stdout: '', stderr: '', exitCode: 0 }
      if (script.includes('cat '))
        return { stdout: '', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 }
    }
    const src = '/sdcard/Download/a.apk'
    const target = await stageApkToPrivateDir(src, {}, tmp, true)
    expect(target).toBe(`${LOCAL_TMP_STAGING}/a.apk`)
    expect(commands.length).toBe(2)
    expect(commands.every(c => c.cmd === 'su' && c.args[0] === '-c')).toBe(true)
    expect((commands[0].args[1] as string).includes('mkdir -p')).toBe(true)
    expect((commands[1].args[1] as string).includes('cat ')).toBe(true)
    expect(commands[1].args[1] as string).toContain(quoteShell(src))
    expect(commands[1].args[1] as string).toContain(
      quoteShell(`${LOCAL_TMP_STAGING}/a.apk`),
    )
  })

  test('with root but CCB_APK_STAGE_DIR set: uses the private dir, not /data/local/tmp', async () => {
    const stage = join(tmp, 'stage')
    await writeFile(realSrc, 'x')
    copyCalls = 0
    const target = await stageApkToPrivateDir(
      '/sdcard/a.apk',
      { CCB_APK_STAGE_DIR: stage },
      tmp,
      true,
      () => {
        copyCalls += 1
        return Promise.resolve()
      },
    )
    expect(target).toBe(join(stage, 'a.apk'))
    expect(commands).toEqual([])
    expect(copyCalls).toBe(1)
  })

  test('with root but failing mkdir: falls back to app-private dir', async () => {
    let mkdirCalls = 0
    handler = (_cmd, args) => {
      const script = args[1] ?? ''
      if (script.includes('mkdir -p')) {
        mkdirCalls += 1
        return { stdout: '', stderr: 'Permission denied', exitCode: 1 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await writeFile(realSrc, 'x')
    copyCalls = 0
    const target = await stageApkToPrivateDir(
      '/sdcard/a.apk',
      {},
      tmp,
      true,
      () => {
        copyCalls += 1
        return Promise.resolve()
      },
    )
    expect(target).toBe(join(tmp, '.cache', 'ccb-apk', 'a.apk'))
    expect(mkdirCalls).toBe(1)
    expect(copyCalls).toBe(1)
  })
})

describe('quoteShell', () => {
  test('wraps in single quotes', () => {
    expect(quoteShell('/data/local/tmp/a.apk')).toBe("'/data/local/tmp/a.apk'")
  })

  test('escapes embedded single quotes', () => {
    expect(quoteShell("/tmp/a'b.apk")).toBe("'/tmp/a'\\''b.apk'")
  })

  test('is idempotent for plain paths', () => {
    expect(quoteShell('/tmp/a.apk')).toBe("'/tmp/a.apk'")
  })
})

describe('runSuCmd (root command dispatch)', () => {
  const HOSTILE = [
    'x',
    "a'b",
    'a b c',
    'a\\b',
    'a\nb',
    'a$b c$HOME',
    'a"b"c',
    "a'b'c",
    'a b \'c\' d"e" f',
    '100%',
  ]

  test.each(
    HOSTILE,
  )("%j: script is passed verbatim as su's argv", async name => {
    const script = `pm install -r ${quoteShell(name)}`
    handler = (cmd, args) => {
      expect(cmd, 'dispatches su').toBe('su')
      expect(args, 'script is argv[1], not a shell string').toEqual([
        '-c',
        script,
      ])
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await runSuCmd(script, { timeout: 5_000 })
  })

  // Proves the fix is load-bearing. The execa mock above would swallow these,
  // so a real /bin/sh is spawned to observe actual shell behavior.
  const sh = (argv: string[], env: NodeJS.ProcessEnv = process.env) =>
    new Promise<{ out: string; err: string; code: number }>(resolve => {
      const p = Bun.spawn(argv, { env, stdout: 'pipe', stderr: 'pipe' })
      Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]).then(([out, err, code]) => resolve({ out, err, code }))
    })

  test('shell-string nesting corrupts $HOME and backslash paths, argv dispatch does not', async () => {
    const script = `echo ${quoteShell('a$b c\\d')}`
    const home = (process.env.HOME ?? '/root').replace(/['\\$]/g, 'x')
    const stub = 'su() { printf %s "$2"; }'

    // Legacy path: script embedded in a shell string the outer shell parses,
    // so it expands $ and backslashes before su ever runs.
    const before = await sh(
      [
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        `${stub}; su -c ${JSON.stringify(script)}`,
      ],
      { HOME: home },
    )

    // Fixed path: the script arrives as argv[1], unparsed by any outer shell.
    handler = (_c, args) => ({
      stdout: args[1] ?? '',
      stderr: '',
      exitCode: 0,
    })
    const received = (await runSuCmd(script, { timeout: 5_000 })).stdout
    const after = await sh(
      [
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        `${stub}; printf %s "$SCRIPT"`,
      ],
      { HOME: home, SCRIPT: received },
    )

    expect(after.out, 'argv dispatch is byte-for-byte').toBe(script)
    expect(before.out, 'shell-string nesting is corrupted').not.toBe(script)
  })
})

describe('apkFileName', () => {
  test('extracts name from a remote URL', () => {
    expect(apkFileName('https://x.example/a.apk')).toBe('a.apk')
  })

  test('ignores query strings and fragments', () => {
    expect(apkFileName('https://x.example/a.apk?sig=abc#frag')).toBe('a.apk')
  })

  test('falls back to downloaded.apk when the path has no .apk', () => {
    expect(apkFileName('https://x.example/install?file=a.apk')).toBe(
      'downloaded.apk',
    )
  })

  test('takes basename for local paths', () => {
    expect(apkFileName('/sdcard/Download/foo.apk')).toBe('foo.apk')
  })
})

describe('isRemoteUrl', () => {
  test('matches http and https', () => {
    expect(isRemoteUrl('http://x/y.apk')).toBe(true)
    expect(isRemoteUrl('https://x/y.apk')).toBe(true)
  })

  test('rejects local paths', () => {
    expect(isRemoteUrl('/sdcard/a.apk')).toBe(false)
    expect(isRemoteUrl('C:\\a.apk')).toBe(false)
  })
})

describe('parseInstallApkArgs', () => {
  test('parses URL plus every flag', () => {
    const r = parseInstallApkArgs(
      '--checksum aabb --device abc --output /tmp/d --keep --dry-run https://x/a.apk',
    )
    expect(r).toEqual({
      input: 'https://x/a.apk',
      outputDir: '/tmp/d',
      device: 'abc',
      checksum: 'aabb',
      keep: true,
      dryRun: true,
    })
  })

  test('accepts short aliases', () => {
    const r = parseInstallApkArgs('-o /o -s dev x.apk')
    expect(r.outputDir).toBe('/o')
    expect(r.device).toBe('dev')
    expect(r.keep).toBe(false)
    expect(r.dryRun).toBe(false)
  })

  test('returns undefined input for a blank string', () => {
    expect(parseInstallApkArgs('   ').input).toBeUndefined()
  })

  test('ignores unknown flags but keeps positionals', () => {
    const r = parseInstallApkArgs('--bogus x.apk')
    expect(r.input).toBe('x.apk')
  })

  test('defaults keep and dryRun to false', () => {
    expect(parseInstallApkArgs('x.apk').keep).toBe(false)
    expect(parseInstallApkArgs('x.apk').dryRun).toBe(false)
  })
})

describe('isSuccessOutput', () => {
  test('accepts Success and success', () => {
    expect(isSuccessOutput('Success')).toBe(true)
    expect(isSuccessOutput('  success  ')).toBe(true)
  })

  test('rejects INSTALL_FAILED even when success also appears', () => {
    expect(isSuccessOutput('Success but INSTALL_FAILED_OLDER_SDK')).toBe(false)
  })

  test('rejects failures without the word success', () => {
    expect(isSuccessOutput('Failure [DELETE_FAILED_INTERNAL_ERROR]')).toBe(
      false,
    )
    expect(isSuccessOutput('Permission denied')).toBe(false)
    expect(isSuccessOutput('not enough space')).toBe(false)
  })

  test('rejects empty output', () => {
    expect(isSuccessOutput('')).toBe(false)
  })
})

describe('buildInstallChain', () => {
  test('pc-only environment lists adb install', () => {
    expect(
      buildInstallChain(false, {
        hasSu: false,
        adb: '/usr/bin/adb',
        termuxOpen: false,
      }),
    ).toEqual([
      { method: 'adb install', kind: 'pm', available: true, reason: undefined },
    ])
  })

  test('android without root skips su paths, pm stays as fallback', () => {
    const chain = buildInstallChain(true, {
      hasSu: false,
      adb: undefined,
      termuxOpen: true,
    })
    const methods = chain.map(c => c.method)
    expect(methods).toContain('pm install')
    expect(methods).toContain('termux-open')
    expect(methods).toContain('am start (file://)')
    expect(methods).not.toContain('su pm install')
  })

  test('android with root lists both su paths first, in order', () => {
    const chain = buildInstallChain(true, {
      hasSu: true,
      adb: '/system/bin/adb',
      termuxOpen: false,
    })
    expect(chain.map(c => c.method)).toEqual([
      'su pm install',
      'su adb install',
      'pm install',
      'am start (file://)',
    ])
  })

  test('pc without adb marks install unavailable with a reason', () => {
    const chain = buildInstallChain(false, {
      hasSu: false,
      adb: undefined,
      termuxOpen: false,
    })
    expect(chain[0].available).toBe(false)
    expect(chain[0].reason).toBe('未找到 adb')
  })

  test('without root the pm entry keeps its SELinux caveat', () => {
    const chain = buildInstallChain(true, {
      hasSu: false,
      adb: undefined,
      termuxOpen: false,
    })
    expect(chain.find(c => c.method === 'pm install')?.reason).toContain(
      'SELinux',
    )
  })
})

describe('buildAmStartCommand', () => {
  test('embeds the file:// URI and MIME type', () => {
    const cmd = buildAmStartCommand('/data/local/tmp/a.apk')
    expect(cmd).toContain('android.intent.action.VIEW')
    expect(cmd).toContain('application/vnd.android.package-archive')
    expect(cmd).toContain('file:///data/local/tmp/a.apk')
    expect(cmd).toContain('--grant-read-uri-permission')
  })

  test('single-quotes the URI for the shell', () => {
    expect(buildAmStartCommand('/tmp/a.apk')).toContain(
      "-d 'file:///tmp/a.apk'",
    )
  })
})

describe('runAmStartWithFallback', () => {
  test('succeeds when am start accepts the grant flag', async () => {
    const full = buildAmStartCommand('/tmp/a.apk')
    handler = (_cmd, args) =>
      args[1] === full
        ? { stdout: 'Starting: Intent', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 }
    const r = await runAmStartWithFallback('/tmp/a.apk', () => {})
    expect(r.ok).toBe(true)
    expect(r.method).toBe('am start')
    expect(commands.length).toBe(1)
  })

  test('retries without --grant-read-uri-permission on older ROMs', async () => {
    const full = buildAmStartCommand('/tmp/a.apk')
    const noGrant = full.replace(' --grant-read-uri-permission', '')
    handler = (_cmd, args) => {
      if (args[1] === full)
        return {
          stdout: '',
          stderr: 'bad option --grant-read-uri-permission',
          exitCode: 1,
        }
      if (args[1] === noGrant)
        return { stdout: 'Starting...', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 1 }
    }
    const r = await runAmStartWithFallback('/tmp/a.apk', () => {})
    expect(r.ok).toBe(true)
    expect(commands.length).toBe(2)
    expect(commands[1].args[1] as string).not.toContain(
      '--grant-read-uri-permission',
    )
  })

  test('fails cleanly when both attempts fail', async () => {
    const full = buildAmStartCommand('/tmp/a.apk')
    const noGrant = full.replace(' --grant-read-uri-permission', '')
    handler = (_cmd, args) => {
      if (args[1] === full)
        return { stdout: '', stderr: 'unknown flag', exitCode: 1 }
      if (args[1] === noGrant)
        return { stdout: '', stderr: 'Security exception', exitCode: 1 }
      return { stdout: '', stderr: '', exitCode: 1 }
    }
    const r = await runAmStartWithFallback('/tmp/a.apk', () => {})
    expect(r.ok).toBe(false)
    expect(r.method).toBe('am start')
    expect(r.message).toContain('am start 失败')
  })

  test('does NOT retry when the error is unrelated', async () => {
    const full = buildAmStartCommand('/tmp/a.apk')
    handler = (_cmd, args) =>
      args[1] === full
        ? { stdout: '', stderr: 'Command not found', exitCode: 127 }
        : { stdout: '', stderr: '', exitCode: 1 }
    const r = await runAmStartWithFallback('/tmp/a.apk', () => {})
    expect(r.ok).toBe(false)
    expect(commands.length).toBe(1)
  })
})
