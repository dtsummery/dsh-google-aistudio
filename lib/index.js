/**
 * dsh-google-aistudio — host 侧插件。
 *
 * 把 Google AI Studio（aistudio.google.com）接进 DSH：
 * 1. 托管单文件反代内核 AIStudio2API（下载、写配置、启动、健康检查、退出时回收）；
 * 2. 用 {@link AIStudioWebAdapter} 把 `aistudio-web` 这个 provider 注册进 DSH 的 LLM 服务；
 * 3. 在设置里注册一个独立分区，用于导入账户、看状态、勾选模型、跑连通性测试。
 *
 * 账户导入、WAA 运行时与协议编解码都由内核负责；本站只做「拿现成 profile 喂进去」和运维。
 * 配置位于 `google-aistudio` settings 命名空间（设置 → 插件 → Google AI Studio），改动即时生效。
 *
 * @module dsh-google-aistudio
 */
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  KERNEL_REPO,
  KERNEL_VERSION,
  Kernel,
  downloadKernel,
  findFreePort,
  kernelExeName,
  readKeyValueFile,
  writeEnvFile
} from './kernel.js'
import { AIStudioWebAdapter, DEFAULT_MODELS, MODEL_CATALOG } from './adapter.js'

/** Cordis 插件名。 */
export const name = 'dsh-google-aistudio'

/** 需要就绪的服务：LLM 注册表与设置服务。 */
export const inject = ['llm', 'settings']

/** 注册给 DSH 的 provider 路由名。 */
const PROVIDER_ID = 'aistudio-web'

/** 插件设置命名空间。 */
const NS = settingsNamespace('google-aistudio')

/** 组合行配置（同时是设置 schema）。 */
const Config = z.object({
  /** 总开关：关闭时不启动内核、不注册 provider。 */
  enabled: z.boolean().default(true),
  /** 反代内核可执行文件路径；留空使用 ~/.dsh/aistudio/bin/ 下的自动路径。 */
  kernelPath: z.string().default(''),
  /** 内核监听端口；0 = 首次启动时自动选一个空闲端口并记住。 */
  port: z.number().default(0),
  /** 内核出口代理，留空时沿用 DSH 进程里的 HTTPS_PROXY/HTTP_PROXY。 */
  proxyUrl: z.string().default(''),
  /** 账户邮箱（仅用于界面显示，真正的账户由内核的 auth 目录管理）。 */
  accountEmail: z.string().default(''),
  /** 「从浏览器导入」用的 User Data 目录。 */
  browserRoot: z.string().default(''),
  /** 「从文件导入」用的 Playwright storage-state 文件路径。 */
  storageStatePath: z.string().default(''),
  /** 内核启动后自动拉起数据面（POST /api/control/start）。 */
  autoStartService: z.boolean().default(true),
  /** WAA 预热页是否使用临时对话：开启后 API 请求与预热页都不落 AI Studio 历史。 */
  temporaryChat: z.boolean().default(true),
  /** 常驻预热的账户数。 */
  warmWorkers: z.number().default(1),
  /** 单次请求最大执行时间（分钟）。 */
  requestTimeoutMinutes: z.number().default(5),
  /** 暴露给 DSH 的模型 id 列表：只把这些模型放进会话窗口的模型选择器。 */
  models: z.array(z.string()).default(DEFAULT_MODELS)
})

/** 状态目录：内核、账户、配置都落在这里。 */
function stateDir() {
  return join(homedir(), '.dsh', 'aistudio')
}

/**
 * 把若干配置来源合并成一份完整配置。
 *
 * settings 服务给出的 namespace 值可能是空对象（用户从没在设置界面里改过），
 * 这时必须回退到组合行配置的默认值 —— 否则 `enabled` 会变成 `undefined`，
 * 被误判成"插件已停用"，连内核都拿不到。
 * @param {...object} sources - 从低优先级到高优先级的配置来源。
 */
function normalizeConfig(...sources) {
  const merged = Object.assign({}, ...sources.filter((source) => source && typeof source === 'object'))
  const port = Number(merged.port)
  const workers = Number(merged.warmWorkers)
  const timeout = Number(merged.requestTimeoutMinutes)
  const models = Array.isArray(merged.models)
    ? merged.models.filter((id) => typeof id === 'string' && id.length > 0)
    : []
  return {
    enabled: merged.enabled !== false,
    kernelPath: typeof merged.kernelPath === 'string' ? merged.kernelPath : '',
    port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 0,
    proxyUrl: typeof merged.proxyUrl === 'string' ? merged.proxyUrl : '',
    accountEmail: typeof merged.accountEmail === 'string' ? merged.accountEmail : '',
    browserRoot: typeof merged.browserRoot === 'string' ? merged.browserRoot : '',
    storageStatePath: typeof merged.storageStatePath === 'string' ? merged.storageStatePath : '',
    autoStartService: merged.autoStartService !== false,
    temporaryChat: merged.temporaryChat !== false,
    warmWorkers: Number.isFinite(workers) ? Math.min(10, Math.max(1, Math.floor(workers))) : 1,
    requestTimeoutMinutes: Number.isFinite(timeout) ? Math.min(60, Math.max(1, Math.floor(timeout))) : 5,
    // 空列表回退默认：一个模型都不暴露会让 provider 在选择器里消失。
    models: models.length > 0 ? models : DEFAULT_MODELS
  }
}

/** 生成一次性的随机凭据。 */
function randomSecret(prefix = '') {
  return prefix + randomBytes(16).toString('hex')
}

/** 本机时区（内核按它构造 AI Studio 请求）。 */
function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

/**
 * Cordis 插件入口。
 * @param ctx - host 插件上下文。
 * @param entryConfig - 组合行配置（settings 未覆盖时的初值）。
 */
export function apply(ctx, entryConfig = {}) {
  const tag = '[dsh-google-aistudio] '
  const log = (msg) => ctx.logger?.info?.(tag + msg)
  const warn = (msg) => ctx.logger?.warn?.(tag + msg)

  const dir = stateDir()
  mkdirSync(dir, { recursive: true })

  /** 插件自己的持久状态（端口 / API key）与内核要读的 .env 分开存。 */
  const statePath = join(dir, 'plugin.env')
  const envPath = join(dir, '.env')
  const stored = readKeyValueFile(statePath)
  const apiKey = stored.API_KEY || randomSecret('sk-aistudio-')
  let kernelPort = Number(stored.PORT || 0)

  let config = normalizeConfig(entryConfig)
  let kernel = null
  let starting = null
  let disposed = false
  let lastError = ''
  let authNotice = ''
  let kernelWatchdog = null

  /** 内核可执行文件路径：设置里留空就用状态目录下的自动路径。 */
  const kernelPath = () => config.kernelPath || join(dir, 'bin', kernelExeName())

  /** 探测出口代理：内核访问 Google 必须走它，直连会超时。 */
  const proxyUrl = () =>
    config.proxyUrl ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''

  const persistState = () => writeEnvFile(statePath, { PORT: String(kernelPort), API_KEY: apiKey })

  /** 端口只在第一次启动时选一次，之后固定，避免重启后 Base URL 漂移。 */
  const ensurePort = async () => {
    if (kernelPort > 0) return kernelPort
    kernelPort = await findFreePort()
    persistState()
    log(`已分配内核端口 ${kernelPort}`)
    return kernelPort
  }

  /**
   * 生成内核要读的 .env。
   *
   * 只覆盖本站管理的键，先把文件里已有的键读回来合并 —— 这样内核管理页里改过的
   * 其他配置（以及内核自己写回的字段）不会被抹掉。
   */
  const writeKernelEnv = (port) => {
    const managed = {
      AISTUDIO_AUTH_STATES: 'auth',
      LISTEN_ADDR: `127.0.0.1:${port}`,
      PROXY_API_KEY: apiKey,
      PROXY: proxyUrl(),
      INIT_TIMEOUT: '3m',
      REQUEST_TIMEOUT: `${config.requestTimeoutMinutes}m`,
      WARM_WORKER_LIMIT: String(config.warmWorkers),
      MAX_ACTIVE_WORKERS: String(Math.max(2, config.warmWorkers)),
      WARM_STARTUP_CONCURRENCY: '1',
      PER_ACCOUNT_CONCURRENCY: '1',
      ROUTING_STRATEGY: 'round-robin',
      TEMPORARY_CHAT: config.temporaryChat ? 'true' : 'false'
    }
    writeEnvFile(envPath, { ...readKeyValueFile(envPath), ...managed })
  }

  /** 内核日志是 JSON 行；只把 WARN/ERROR 转发到 DSH 日志，其余丢掉免得刷屏。 */
  const onKernelLog = (line) => {
    if (/"level":"(ERROR|WARN|FATAL)"/.test(line) || /\b(panic|fatal)\b/i.test(line)) warn(line)
  }

  /**
   * 数据面没在跑就拉起来；没有账户时只提示，不报错。
   *
   * WAA 预热偶尔会失败一次（例如「官网 Run 按钮已禁用」），内核随后会自行重试并进入
   * RUNNING —— 所以这里不能把第一次的 502 直接当成终态错误：先复查状态，仍失败才重试一次，
   * 两次都不行才记账。成功时清掉上一次的错误，避免界面上留着已经自愈的旧报错。
   */
  const maybeStartService = async () => {
    const instance = kernel
    if (!instance || !config.autoStartService) return
    try {
      const status = await instance.status()
      if (status.running === true) {
        lastError = ''
        return
      }
      if ((status.accounts?.total ?? 0) === 0) {
        warn('还没有导入账户，先不启动数据面；请在「Google AI Studio」设置页里导入')
        return
      }
    } catch (error) {
      lastError = `读取内核状态失败：${String(error?.message ?? error)}`
      warn(lastError)
      return
    }

    let failure = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await instance.controlStart()
        lastError = ''
        log(attempt === 1 ? '数据面已启动' : '数据面已启动（重试后成功）')
        return
      } catch (error) {
        failure = error
        await new Promise((resolve) => setTimeout(resolve, 5000))
        const again = await instance.status().catch(() => null)
        if (again?.running === true) {
          lastError = ''
          log('数据面已启动（内核预热自行恢复）')
          return
        }
      }
    }
    lastError = `启动数据面失败：${String(failure?.message ?? failure)}`
    warn(lastError)
  }

  /** 确保内核在跑（幂等：并发调用共用同一次启动）。 */
  const ensureKernel = () => {
    if (starting !== null) return starting
    starting = (async () => {
      const port = await ensurePort()
      writeKernelEnv(port)
      const instance = new Kernel({
        binPath: kernelPath(),
        dir,
        port,
        apiKey,
        proxyUrl: proxyUrl(),
        onLog: onKernelLog
      })
      const result = await instance.start()
      kernel = instance
      log(result.reused ? `复用端口 ${port} 上已有的内核实例` : `内核已启动（端口 ${port}，${KERNEL_VERSION}）`)
      await maybeStartService()
      return kernel
    })()
      .catch((error) => {
        lastError = `内核启动失败：${String(error?.message ?? error)}`
        warn(lastError)
        throw error
      })
      .finally(() => {
        starting = null
      })
    return starting
  }

  /** 数据面停掉后重新拉起（设置里改完自动启动开关时用）。 */
  const refreshService = async () => {
    const instance = await ensureKernel()
    try {
      const status = await instance.status()
      if (config.autoStartService && status.running !== true) await maybeStartService()
      if (!config.autoStartService && status.running === true) {
        await instance.controlStop()
        log('数据面已停止（自动启动已关闭）')
      }
    } catch (error) {
      warn(`同步数据面状态失败：${String(error?.message ?? error)}`)
    }
    return instance
  }

  // ---- 内核与 provider 注册 ----
  const adapterDeps = {
    getBaseUrl: () => `http://127.0.0.1:${kernelPort}/v1`,
    getApiKey: () => apiKey,
    getModels: () => config.models,
    onAuthFailure: (detail) => {
      authNotice = String(detail ?? '').slice(0, 300)
      warn('内核报账户认证失败：请在「Google AI Studio」设置页重新导入账户')
    },
    log: (msg) => log(msg)
  }

  let adapterDispose = null
  const registerProvider = () => {
    if (adapterDispose !== null) return
    try {
      adapterDispose = ctx.llm.registerAdapter([PROVIDER_ID], new AIStudioWebAdapter(adapterDeps))
      log(`已注册 provider 路由：${PROVIDER_ID}`)
    } catch (error) {
      warn(`provider 注册失败：${String(error)}`)
    }
  }
  const unregisterProvider = () => {
    try {
      adapterDispose?.()
    } catch {
      // 注销失败无需处理：fiber 结束时会随插件一起回收。
    }
    adapterDispose = null
  }

  // ---- 设置变更：即时生效 ----
  /**
   * settings 服务交出来的**不是值，而是「取当前生效值」的函数**
   * （`installSection` 里调用的是 `hooks.setSource(() => scope.get())`），
   * 所以这里必须保存函数、每次重新求值，不能当成值直接合并。
   */
  let readSettings = null

  /** 重新按 settings 的实际取值计算 config。 */
  const refreshConfig = () => {
    let next
    try {
      next = typeof readSettings === 'function' ? readSettings() : undefined
    } catch (error) {
      warn(`读取设置失败，沿用上一份配置：${String(error?.message ?? error)}`)
      next = undefined
    }
    config = normalizeConfig(entryConfig, next && typeof next === 'object' ? next : {})
    return config
  }

  /** 按当前 config 应用运行时状态。 */
  const applyConfig = () => {
    const previous = config
    refreshConfig()
    const modelsChanged = previous.models.join(',') !== config.models.join(',')
    const portChanged = previous.port !== config.port && config.port > 0
    if (config.enabled) {
      registerProvider()
      void ensureKernel()
        .then(async (instance) => {
          writeKernelEnv(kernelPort)
          if (portChanged && config.port !== kernelPort) {
            await instance.shutdown()
            kernel = null
            kernelPort = config.port
            persistState()
            await ensureKernel()
          }
          await refreshService()
        })
        .catch(() => {})
      startKernelWatchdog()
      if (modelsChanged) {
        // 模型勾选变了：重注册 provider，触发 DSH 的「拓扑变更」通知，
        // 让会话窗口的模型选择器立刻按新清单刷新（不必重启 DSH）。
        unregisterProvider()
        registerProvider()
        log(`模型选择已更新：${config.models.join(', ')}`)
      }
    } else {
      unregisterProvider()
    }
  }

  /** 内核看门狗：进程被外部杀掉或崩溃后自动拉回来。 */
  const startKernelWatchdog = () => {
    if (kernelWatchdog !== null) return
    kernelWatchdog = setInterval(() => {
      if (disposed || !config.enabled) return
      const current = kernel
      if (current === null) return
      void current.health().then((alive) => {
        if (alive || disposed) return
        warn('内核无响应，正在重启')
        kernel = null
        void ensureKernel().catch(() => {})
      })
    }, 15000)
    kernelWatchdog.unref?.()
  }

  installSettingsSection(ctx, NS, Config, entryConfig, {
    setSource: (read) => {
      readSettings = typeof read === 'function' ? read : null
      applyConfig()
    },
    onChange: () => {
      applyConfig()
    }
  })

  /** 跑内核 CLI（setup / 账户导入）。 */
  const runKernelCli = (args) =>
    new Promise((resolve) => {
      const bin = kernelPath()
      if (!existsSync(bin)) {
        resolve({ ok: false, stdout: '', stderr: `内核不存在：${bin}` })
        return
      }
      execFile(bin, args, { cwd: dir, windowsHide: true, timeout: 600000 }, (error, stdout, stderr) =>
        resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? error?.message ?? '') })
      )
    })

  /** 提示：本机常见的 Chromium 系浏览器 User Data 目录，供「从浏览器导入」用。 */
  const browserRoots = () => {
    const local = process.env.LOCALAPPDATA || ''
    return [
      { id: 'edge', name: 'Microsoft Edge', path: local ? join(local, 'Microsoft', 'Edge', 'User Data') : '' },
      { id: 'chrome', name: 'Google Chrome', path: local ? join(local, 'Google', 'Chrome', 'User Data') : '' },
      { id: 'brave', name: 'Brave', path: local ? join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') : '' },
      { id: 'edge-dev', name: 'Edge Dev', path: local ? join(local, 'Microsoft', 'Edge Dev', 'User Data') : '' },
      { id: 'chromium', name: 'Chromium', path: local ? join(local, 'Chromium', 'User Data') : '' },
      { id: 'vivaldi', name: 'Vivaldi', path: local ? join(local, 'Vivaldi', 'User Data') : '' }
    ].filter((entry) => entry.path && existsSync(entry.path))
  }

  // ---- 设置页用的 HTTP 路由 ----
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on?.('data', (chunk) => chunks.push(chunk))
      req.on?.('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          resolve({})
        }
      })
    })

  /** 设置页要的状态快照。 */
  const buildStatus = async () => {
    const live = new Set()
    let kernelRow = {
      running: false,
      serviceRunning: false,
      state: '未启动',
      version: KERNEL_VERSION,
      port: kernelPort,
      path: kernelPath(),
      installed: existsSync(kernelPath()),
      accounts: { total: 0, ready: 0, busy: 0, cooldown: 0, authRequired: 0 }
    }
    let accounts = []
    if (kernel !== null) {
      try {
        const status = await kernel.status()
        kernelRow = {
          ...kernelRow,
          running: true,
          serviceRunning: status.running === true,
          state: status.state,
          version: status.version,
          accounts: {
            total: status.accounts?.total ?? 0,
            ready: status.accounts?.ready ?? 0,
            busy: status.accounts?.busy ?? 0,
            cooldown: status.accounts?.cooldown ?? 0,
            authRequired: status.accounts?.auth_required ?? 0
          }
        }
        for (const id of await kernel.models()) live.add(id)
      } catch (error) {
        kernelRow.state = '管理接口无响应'
        kernelRow.running = false
      }
      try {
        accounts = (await kernel.accounts())?.accounts ?? []
      } catch {
        accounts = []
      }
    }

    const selected = new Set(config.models)
    const seen = new Set()
    const modelOptions = []
    for (const entry of MODEL_CATALOG) {
      seen.add(entry.id)
      modelOptions.push({
        id: entry.id,
        name: entry.name,
        input: entry.input,
        selected: selected.has(entry.id),
        available: live.size === 0 ? true : live.has(entry.id)
      })
    }
    for (const id of [...live].sort()) {
      if (seen.has(id)) continue
      modelOptions.push({ id, name: id, input: ['text'], selected: selected.has(id), available: true })
    }

    return {
      kernel: kernelRow,
      accounts,
      accountEmail: config.accountEmail,
      baseUrl: `http://127.0.0.1:${kernelPort}/v1`,
      modelOptions,
      browserRoots: browserRoots(),
      upstream: { repo: KERNEL_REPO, version: KERNEL_VERSION },
      proxyUrl: proxyUrl(),
      timezone: localTimezone(),
      lastError,
      authNotice
    }
  }

  ctx.inject(['webServer'], (sub) => {
    const webServer = sub.get('webServer')
    if (!webServer) return undefined
    const disposers = []
    const reg = (route) => {
      const dispose = webServer.register(route)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    const guard = (handler) => async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    }

    reg({ kind: 'exact', path: '/plugins/google-aistudio/status', handler: guard(async (_req, res) => sendJson(res, 200, await buildStatus())) })

    reg({
      kind: 'exact',
      path: '/plugins/google-aistudio/kernel/install',
      handler: guard(async (_req, res) => {
        // Windows 下正在运行的内核会锁住 exe，不先停掉实例，覆盖必然 EPERM。
        if (kernel !== null) {
          await kernel.shutdown().catch(() => {})
          kernel = null
        } else if (kernelPort > 0) {
          const probe = new Kernel({ binPath: kernelPath(), dir, port: kernelPort, apiKey })
          await probe.killByPort().catch(() => {})
        }
        rmSync(`${kernelPath()}.part`, { force: true })
        const result = await downloadKernel(kernelPath(), { proxyUrl: proxyUrl() })
        const instance = await ensureKernel()
        sendJson(res, 200, { ok: true, bytes: result.bytes, models: await instance.models() })
      })
    })

    reg({
      kind: 'exact',
      path: '/plugins/google-aistudio/kernel/restart',
      handler: guard(async (_req, res) => {
        const instance = kernel ?? (await ensureKernel())
        await instance.restart()
        kernel = instance
        await maybeStartService()
        sendJson(res, 200, { ok: true, models: await instance.models() })
      })
    })

    reg({
      kind: 'exact',
      path: '/plugins/google-aistudio/service/start',
      handler: guard(async (_req, res) => {
        const instance = await ensureKernel()
        const result = await instance.controlStart()
        lastError = ''
        sendJson(res, 200, result)
      })
    })

    reg({
      kind: 'exact',
      path: '/plugins/google-aistudio/service/stop',
      handler: guard(async (_req, res) => {
        const instance = await ensureKernel()
        sendJson(res, 200, await instance.controlStop())
      })
    })

    reg({
      kind: 'exact',
      path: '/plugins/google-aistudio/test',
      handler: guard(async (req, res) => {
        const body = await readBody(req)
        const instance = await ensureKernel()
        const status = await instance.status()
        if (status.running !== true) throw new Error('数据面没在运行，请先点「启动服务」')
        const model = typeof body.model === 'string' && body.model ? body.model : config.models[0]
        const result = await instance.chat(body.prompt ?? '只回复两个字：你好', model)
        sendJson(res, 200, { ok: true, model, ms: result.ms, text: result.text })
      })
    })

    reg({
      kind: 'exact',
      path: '/plugins/google-aistudio/account/import',
      handler: guard(async (req, res) => {
        const body = await readBody(req)
        const common = ['--proxy', proxyUrl() || '', '--locale', 'zh-CN', '--timezone', localTimezone()]
        let args
        if (body.mode === 'login') {
          // 隔离 Camoufox 登录：会弹一个真实浏览器窗口，用户在窗口里登录 Google。
          // 这条路径的会话由内核自己的 Camoufox 持有，和生成时的 WAA 页面同一指纹，
          // 是唯一能长期存活的接法；--login 不能与 Chrome 选择参数（含 --email）同时使用。
          args = ['setup', '--login', ...common]
        } else if (body.mode === 'browser') {
          const email = String(body.email ?? config.accountEmail ?? '').trim()
          if (!email) throw new Error('请先填写要导入的 Google 邮箱')
          const root = String(body.browserRoot ?? '').trim()
          if (!root || !existsSync(root)) throw new Error('浏览器 User Data 目录不存在，请重新选择')
          args = ['setup', '-chrome-root', root, '-email', email, ...common]
        } else {
          const file = String(body.storageStatePath ?? '').trim()
          if (!file || !existsSync(file)) throw new Error('storage-state 文件不存在')
          // 内核用文件所在目录名（或文件内 aistudio2api.source.email）作为账户标识，
          // 这里把文件复制到以邮箱命名的子目录，保证账户目录可读。
          const email = String(body.email ?? config.accountEmail ?? '').trim()
          let target = file
          if (email) {
            const staged = join(dir, 'import', email)
            mkdirSync(staged, { recursive: true })
            target = join(staged, 'storage-state.json')
            writeFileSync(target, readFileSync(file, 'utf8'), 'utf8')
          }
          args = ['setup', '--storage-state', target, ...common]
        }
        const result = await runKernelCli(args)
        if (result.ok) {
          // 账户变更后必须重启内核才能重新载入 auth 目录。
          const instance = await ensureKernel()
          await instance.restart()
          kernel = instance
          await maybeStartService()
        }
        sendJson(res, result.ok ? 200 : 400, {
          ok: result.ok,
          message: (result.stdout || result.stderr || '').trim().slice(0, 1200)
        })
      })
    })

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 路由注销失败无需处理。
        }
      }
    }
  })

  // ---- 收尾：停内核 ----
  ctx.effect(() => {
    return () => {
      disposed = true
      if (kernelWatchdog !== null) {
        clearInterval(kernelWatchdog)
        kernelWatchdog = null
      }
      void kernel?.shutdown().catch(() => {})
      kernel = null
      unregisterProvider()
      log('插件已卸载：内核已停止')
    }
  }, 'google-aistudio: cleanup')

  log(`已加载（provider=${PROVIDER_ID}，状态目录 ${dir}）`)
}

/** 供设置页展示：当前使用的内核版本。 */
export const kernelVersion = KERNEL_VERSION

/** 供其它模块读取的插件状态文件路径（调试用）。 */
export function pluginStatePath() {
  return join(stateDir(), 'plugin.env')
}

/** 读取当前写入的 API key（调试用，不在 UI 暴露）。 */
export function readPluginState() {
  return readKeyValueFile(pluginStatePath())
}

/** 让外部（如 doctor 命令）可以直接读到内核二进制默认路径。 */
export function defaultKernelPath() {
  return join(stateDir(), 'bin', kernelExeName())
}

/** 读取一份文件的文本（给未来诊断用；保持导入面稳定）。 */
export function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}
