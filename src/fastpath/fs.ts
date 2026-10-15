// FastPath 文件操作 — Node fs/promises 封装，零外部依赖。
import { promises as fsp } from 'fs'
import { join, dirname, basename } from 'path'

export type FsResult = { ok: boolean; result?: unknown; error?: string }

async function ok(result: unknown): Promise<FsResult> {
  return { ok: true, result }
}

function fail(error: unknown): FsResult {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }
}

export async function ls(path: string): Promise<FsResult> {
  try {
    const entries = await fsp.readdir(path, { withFileTypes: true })
    return ok(
      entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file',
      })),
    )
  } catch (err) {
    return fail(err)
  }
}

export async function mkdir(path: string): Promise<FsResult> {
  try {
    await fsp.mkdir(path, { recursive: true })
    return ok({ path })
  } catch (err) {
    return fail(err)
  }
}

export async function read(path: string): Promise<FsResult> {
  try {
    const content = await fsp.readFile(path, 'utf8')
    return ok({ path, content })
  } catch (err) {
    return fail(err)
  }
}

export async function write(path: string, content: string): Promise<FsResult> {
  try {
    await fsp.mkdir(dirname(path), { recursive: true })
    await fsp.writeFile(path, content, 'utf8')
    return ok({ path, bytes: Buffer.byteLength(content) })
  } catch (err) {
    return fail(err)
  }
}

export async function copy(src: string, dst: string): Promise<FsResult> {
  try {
    await fsp.mkdir(dirname(dst), { recursive: true })
    await fsp.cp(src, dst, { recursive: true })
    return ok({ src, dst })
  } catch (err) {
    return fail(err)
  }
}

export async function mv(src: string, dst: string): Promise<FsResult> {
  try {
    await fsp.mkdir(dirname(dst), { recursive: true })
    await fsp.rename(src, dst)
    return ok({ src, dst })
  } catch (err) {
    return fail(err)
  }
}

export async function rm(path: string): Promise<FsResult> {
  try {
    await fsp.rm(path, { recursive: true, force: true })
    return ok({ removed: path })
  } catch (err) {
    return fail(err)
  }
}

export async function find(root: string, pattern: string): Promise<FsResult> {
  const re = new RegExp(pattern)
  const out: string[] = []
  try {
    const walk = async (dir: string): Promise<void> => {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (re.test(basename(full))) out.push(full)
      }
    }
    await walk(root)
    return ok({ matches: out.sort(), count: out.length })
  } catch (err) {
    return fail(err)
  }
}
