/**
 * AIStudio2API 内核托管层。
 *
 * 职责：定位（必要时从 GitHub Release 下载并解压）单文件内核，生成它要读的 `.env`，
 * 启动 / 守护进程，并封装它的管理 REST（状态、账户、服务启停）与数据面调用。
 *
 * 本模块不依赖 DSH 的任何接口，可以独立测试。
 */
import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { inflateRawSync } from 'node:zlib'

/** 内核默认固定在这个版本；升级只改这一处。 */
export const KERNEL_VERSION = 'v0.1.1'

/** 上游发布仓库（MIT）。 */
export const KERNEL_REPO = 'Mag1cFall/AIStudio2API'

/** 平台对应的 release 资产名。 */
export function kernelAssetName(version = KERNEL_VERSION) {
  const plat = process.platform
  const osName = plat === 'win32' ? 'windows' : plat === 'darwin' ? 'darwin' : 'linux'
  const archName = process.arch === 'arm64' ? 'arm64' : 'amd64'
  return `aistudio2api-${version}-${osName}-${archName}${plat === 'win32' ? '.zip' : '.tar.gz'}`
}

/** 内核可执行文件名。 */
export function kernelExeName() {
  return process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api'
}

export function kernelDownloadUrl(version = KERNEL_VERSION, asset = kernelAssetName(version)) {
  return `https://github.com/${KERNEL_REPO}/releases/download/${version}/${asset}`
}

/** 选一个空闲的本地端口（避免与手工起的实例或其他软件撞车）。 */
export function findFreePort(preferred) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => {
      const srv2 = createServer()
      srv2.once('error', () => resolve(0))
      srv2.listen(0, '127.0.0.1', () => {
        const p = srv2.address().port
        srv2.close(() => resolve(p))
      })
    })
    srv.once('listening', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
    srv.listen(preferred ?? 0, '127.0.0.1')
  })
}

/** 下载用的 UA。 */
const UA = 'dsh-google-aistudio (+https://github.com/dtsummery/dsh-google-aistudio)'

/**
 * 经 HTTP 代理建 CONNECT 隧道，返回裸 socket。
 *
 * 这里刻意不用 undici：插件运行目录未必装了它，走 Node 内置模块可以在任何环境里工作。
 */
function connectThroughProxy(proxyUrl, target) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl)
    const req = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: { Host: `${target.hostname}:${target.port || 443}`, 'Proxy-Connection': 'keep-alive' },
      timeout: 30000
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理 CONNECT 返回 ${res.statusCode}`))
        return
      }
      resolve(socket)
    })
    req.on('timeout', () => req.destroy(new Error('代理连接超时')))
    req.on('error', reject)
    req.end()
  })
}

/** GET 一个 https URL 并返回响应流，自动跟随重定向；proxyUrl 非空时走 CONNECT 隧道。 */
async function httpsGet(url, proxyUrl, redirects = 0) {
  const target = new URL(url)
  const options = {
    host: target.hostname,
    port: Number(target.port || 443),
    path: `${target.pathname}${target.search}`,
    method: 'GET',
    headers: { 'User-Agent': UA, Accept: '*/*' }
  }
  if (proxyUrl) {
    const socket = await connectThroughProxy(proxyUrl, target)
    options.createConnection = () => tlsConnect({ socket, servername: target.hostname })
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest(options, (res) => {
      const location = res.headers.location
      if (res.statusCode >= 300 && res.statusCode < 400 && location && redirects < 5) {
        res.resume()
        resolve(httpsGet(new URL(location, url).toString(), proxyUrl, redirects + 1))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}（${url}）`))
        return
      }
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new Error('下载超时')))
    req.on('error', reject)
    req.end()
  })
}

/**
 * 从 zip 缓冲区里取出指定后缀的文件。
 *
 * 手写解析是为了不引入 zip 依赖，也不去 spawn 系统解压工具 —— 压缩方式只处理
 * stored(0) 与 deflate(8)，这两种覆盖了 GitHub Release 的打包产物。
 * @param {Buffer} buf - 整个 zip 文件。
 * @param {(name: string) => boolean} match - 命中要提取的条目。
 * @returns {Buffer}
 */
export function extractFromZip(buf, match) {
  const eocd = (() => {
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i
    }
    return -1
  })()
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录结尾记录')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip 中央目录条目损坏')
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    if (match(name)) {
      const lhNameLen = buf.readUInt16LE(localOffset + 26)
      const lhExtraLen = buf.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + lhNameLen + lhExtraLen
      const raw = buf.subarray(start, start + compSize)
      if (method === 0) return Buffer.from(raw)
      if (method === 8) return inflateRawSync(raw)
      throw new Error(`zip 条目压缩方式不支持：method=${method}`)
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  throw new Error('zip 里没有找到目标可执行文件')
}

/** 用系统 tar 解出 tar.gz 里的目标文件（非 Windows 平台）。 */
async function extractFromTarGz(archive, destExe) {
  const stage = mkdtempSync(join(tmpdir(), 'aistudio-kernel-'))
  await new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', archive, '-C', stage], { windowsHide: true, timeout: 120000 }, (error) =>
      error ? reject(new Error(`解压内核失败：${error.message}`)) : resolve(undefined)
    )
  })
  const found = join(stage, kernelExeName())
  if (!existsSync(found)) throw new Error('tar 包里没有找到 aistudio2api 可执行文件')
  renameSync(found, destExe)
  rmSync(stage, { recursive: true, force: true })
}

/**
 * 下载内核并释放到目标路径（先落临时文件再改名，避免半成品被当成可用内核）。
 * @returns {Promise<{path: string, bytes: number, archiveBytes: number}>}
 */
export async function downloadKernel(destExe, { version = KERNEL_VERSION, proxyUrl = '' } = {}) {
  const url = kernelDownloadUrl(version)
  const dir = join(destExe, '..')
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, `${kernelAssetName(version)}.part`)

  const res = await httpsGet(url, proxyUrl)
  const out = createWriteStream(archive)
  let archiveBytes = 0
  for await (const chunk of res) {
    archiveBytes += chunk.length
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))

  const staging = `${destExe}.part`
  try {
    if (process.platform === 'win32') {
      const exe = extractFromZip(readFileSync(archive), (name) => /aistudio2api\.exe$/i.test(name))
      writeFileSync(staging, exe)
    } else {
      await extractFromTarGz(archive, staging)
    }
    rmSync(destExe, { force: true })
    renameSync(staging, destExe)
  } catch (error) {
    rmSync(staging, { force: true })
    throw new Error(`释放内核失败：${error?.message ?? error}`)
  } finally {
    rmSync(archive, { force: true })
  }
  return { path: destExe, bytes: readFileSync(destExe).length, archiveBytes }
}

/** 写入 `.env` 风格的键值文件。 */
export function writeEnvFile(path, kv) {
  mkdirSync(join(path, '..'), { recursive: true })
  const body = Object.entries(kv).map(([k, v]) => `${k}=${v ?? ''}`).join('\n') + '\n'
  writeFileSync(path, body, 'utf8')
}

/** 读取 `.env` 风格的键值文件。 */
export function readKeyValueFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** 内核进程 + 管理/数据面 REST 客户端。 */
export class Kernel {
  /**
   * @param {{binPath: string, dir: string, port: number, apiKey: string, proxyUrl?: string, onLog?: (line: string) => void}} opts
   */
  constructor(opts) {
    this.opts = opts
    this.child = null
    /** 端口上是别人（如上次退出后残留）起的实例：本对象不持有子进程，但内核确实可用。 */
    this.adopted = false
  }

  get base() {
    return `http://127.0.0.1:${this.opts.port}`
  }

  get apiBaseUrl() {
    return `${this.base}/v1`
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null) || this.adopted === true
  }

  async request(path, { method = 'GET', body, timeout = 30000, auth = false } = {}) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout)
    })
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = { raw: text }
    }
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 300)}`)
    return json
  }

  /** 管理进程存活探测。 */
  async health() {
    try {
      const res = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return undefined
      return await res.json()
    } catch {
      return undefined
    }
  }

  status() {
    return this.request('/api/status')
  }

  accounts() {
    return this.request('/api/accounts')
  }

  controlStart() {
    return this.request('/api/control/start', { method: 'POST', timeout: 900000 })
  }

  controlStop() {
    return this.request('/api/control/stop', { method: 'POST', timeout: 120000 })
  }

  /** 启动管理进程；若端口上已经有健康实例则直接复用，不重复起进程。 */
  async start() {
    const alive = await this.health()
    if (alive) {
      this.adopted = true
      return { reused: true }
    }
    this.adopted = false

    const { binPath, dir, port, onLog } = this.opts
    if (!binPath || !existsSync(binPath)) throw new Error(`内核不存在：${binPath}`)
    mkdirSync(dir, { recursive: true })

    // 内核从「当前工作目录」读 .env，auth 等相对路径也按它解析，所以 cwd 必须是数据目录。
    this.child = spawn(binPath, ['-open-ui=false'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const pipe = (stream, tag) => {
      let buf = ''
      stream?.on('data', (d) => {
        buf += d.toString()
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) onLog?.(`[${tag}] ${line}`)
      })
    }
    pipe(this.child.stdout, 'kernel')
    pipe(this.child.stderr, 'kernel:err')
    this.child.on('exit', (code) => {
      onLog?.(`[kernel] exited code=${code}`)
      if (this.child && this.child.exitCode !== null) this.child = null
    })

    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await this.health()) return { reused: false }
      await new Promise((r) => setTimeout(r, 400))
    }
    throw new Error('内核启动超时（30s 内 /health 未就绪）')
  }

  /**
   * 结束实例：托管实例直接结束子进程；复用来的残留实例按监听端口反查 PID 再结束。
   *
   * 更新内核二进制之前必须先调它 —— Windows 下正在运行的 exe 被进程占用，
   * 覆盖或删除都会 EPERM。
   */
  async shutdown() {
    if (this.child) {
      try {
        this.child.kill()
      } catch {
        // 进程可能已经退出
      }
      const deadline = Date.now() + 6000
      while (Date.now() < deadline && this.child && this.child.exitCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      this.child = null
    } else if (this.adopted) {
      await this.killByPort()
    }
    this.adopted = false
    return true
  }

  /** 先结束实例，再重新拉起。 */
  async restart() {
    await this.shutdown()
    return this.start()
  }

  /** 按监听端口反查 PID 并结束进程（只用于接管残留内核）。 */
  async killByPort() {
    if (process.platform !== 'win32') return false
    const stdout = await new Promise((resolve) => {
      execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 15000 }, (_error, out) => resolve(String(out ?? '')))
    })
    const pattern = new RegExp(`[:.]${this.opts.port}\\s`)
    const line = stdout.split(/\r?\n/).find((row) => /LISTENING/i.test(row) && pattern.test(row))
    const pid = line?.trim().split(/\s+/).pop()
    if (!pid || !/^\d+$/.test(pid)) return false
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true, timeout: 15000 }, () => resolve(undefined))
    })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return true
  }

  /** 数据面模型清单。 */
  async models() {
    try {
      const json = await this.request('/v1/models', { timeout: 10000, auth: true })
      return (json.data ?? []).map((m) => m.id).filter((id) => typeof id === 'string')
    } catch {
      return []
    }
  }

  /** 一次性文本生成（设置页的「测试」按钮用）。 */
  async chat(prompt, model) {
    const started = Date.now()
    const json = await this.request('/v1/chat/completions', {
      method: 'POST',
      auth: true,
      timeout: 180000,
      body: { model, messages: [{ role: 'user', content: prompt }], stream: false }
    })
    return { ms: Date.now() - started, text: json?.choices?.[0]?.message?.content ?? '' }
  }
}
