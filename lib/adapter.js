/**
 * Google AI Studio 网页端 LLM 适配器。
 *
 * 把 DSH 的模型调用转发到本机 AIStudio2API 内核的 OpenAI 兼容端点
 * （/v1/chat/completions），再把它的 SSE 流翻译成 DSH 的 StreamChunk 协议。
 *
 * 只实现 DSH 需要的部分：文本、思考链（reasoning_content）、工具调用与用量。
 * 内核自己会按 `model` 字段路由到对应的 AI Studio 模型，并处理账户调度，
 * 所以这里不做任何模型级分支。
 */
import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'

/** 上下文硬墙：内核单请求约 13 万 UTF-8 字节，折算成保守 token 数（中文约 3 字节/字）。 */
const DEFAULT_CONTEXT_WINDOW = 40000
/** 输出上限：网页端没有这个旋钮，值只用于 DSH 侧预算。 */
const DEFAULT_MAX_TOKENS = 32768

/**
 * 内核能提供的模型目录（与 AIStudio2API v0.1.1 的 `/v1/models` 对齐）。
 *
 * 这里只定义「可选清单 + 展示名 + 输入能力」；**实际暴露哪些给 DSH 由设置页勾选**
 * （配置项 `models`），没勾选的不进入会话窗口的模型选择器。
 * 出图 / 视频 / 音乐 / 语音模型都需要有效登录态，内核在账户失效时会直接报错，
 * 不会静默降级成别的模型。
 *
 * 目录会随 AI Studio 更新，这里列的是稳定常用的一部分；设置页会把内核实时返回的
 * 全量清单也列出来，供直接勾选。
 */
export const MODEL_CATALOG = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', input: ['text', 'image'] },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', input: ['text', 'image'] },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', input: ['text', 'image'] },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', input: ['text', 'image'] },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', input: ['text', 'image'] },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', input: ['text', 'image'] },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', input: ['text', 'image'] },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', input: ['text', 'image'] },
  { id: 'gemini-pro-latest', name: 'Gemini Pro（latest）', input: ['text', 'image'] },
  { id: 'gemini-flash-latest', name: 'Gemini Flash（latest）', input: ['text', 'image'] },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', input: ['text', 'image'] },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', input: ['text', 'image'] },
  { id: 'gemini-3-pro-image', name: 'Nano Banana Pro（生图）', input: ['text', 'image'] },
  { id: 'gemini-3.1-flash-image', name: 'Nano Banana 2（生图）', input: ['text', 'image'] },
  { id: 'gemini-3.1-flash-lite-image', name: 'Nano Banana 2 Lite（生图）', input: ['text', 'image'] },
  { id: 'gemini-2.5-flash-image', name: 'Nano Banana（生图）', input: ['text', 'image'] },
  { id: 'gemini-3.1-flash-tts-preview', name: 'Gemini 3.1 Flash TTS（语音）', input: ['text'] },
  { id: 'gemini-2.5-pro-preview-tts', name: 'Gemini 2.5 Pro TTS（语音）', input: ['text'] },
  { id: 'lyria-3.5', name: 'Lyria 3.5（音乐）', input: ['text'] },
  { id: 'lyria-3-pro-preview', name: 'Lyria 3 Pro（音乐）', input: ['text'] },
  { id: 'veo-3.1-fast-generate-preview', name: 'Veo 3.1 fast（视频）', input: ['text'] },
  { id: 'veo-3.1-generate-preview', name: 'Veo 3.1（视频）', input: ['text'] },
  { id: 'veo-3.1-lite-generate-preview', name: 'Veo 3.1 lite（视频）', input: ['text'] },
  { id: 'gemma-4-31b-it', name: 'Gemma 4 31B IT', input: ['text'] },
  { id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B IT', input: ['text'] },
  { id: 'gemini-3.5-transcribe', name: 'Gemini 3.5 Transcribe', input: ['text'] }
]

/** 默认暴露给 DSH 的模型（设置页可改，改完保存即写回配置）。 */
export const DEFAULT_MODELS = ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3-pro-image']

/** 取消息里的文本块。 */
function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** 把 tool-result 的内容块压成纯文本（内核只吃字符串）。 */
function stringifyToolResult(block) {
  const parts = []
  if (Array.isArray(block.content)) {
    for (const inner of block.content) {
      if (inner && inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
      else if (inner && inner.type === 'image') parts.push('[图片]')
      else if (inner && inner.type === 'file') parts.push('[文件]')
      else if (inner) parts.push(`[${inner.type ?? '内容'}]`)
    }
  }
  if (parts.length === 0 && typeof block.content === 'string') parts.push(block.content)
  const body = parts.join('\n')
  return block.isError === true ? `工具执行失败：\n${body}` : body
}

/** 把图片块转成 OpenAI 的 image_url 片段；没有内联数据时退化成占位文本。 */
function imagePartOf(block) {
  const data = block?.data ?? block?.base64
  const mime = block?.mimeType ?? block?.mime ?? 'image/png'
  if (typeof data === 'string' && data.length > 0) {
    const url = data.startsWith('data:') ? data : `data:${mime};base64,${data}`
    return { type: 'image_url', image_url: { url } }
  }
  return { type: 'text', text: '[图片]' }
}

/**
 * DSH 消息序列 → OpenAI chat messages。
 * @param {ReadonlyArray<any>} messages - 请求携带的消息（已深度冻结）。
 * @returns {Array<any>} OpenAI 兼容的 messages 数组。
 */
export function buildOpenAIMessages(messages) {
  const out = []
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role
    const blocks = Array.isArray(message.content) ? message.content : []

    if (role === 'system') {
      const text = typeof message.content === 'string' ? message.content : textOfBlocks(blocks)
      if (text.length > 0) out.push({ role: 'system', content: text })
      continue
    }

    if (role === 'assistant') {
      const toolCalls = blocks
        .filter((b) => b && b.type === 'tool-call')
        .map((b) => ({
          id: b.id ?? randomUUID(),
          type: 'function',
          function: {
            name: b.name ?? 'unknown',
            arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {})
          }
        }))
      const text = textOfBlocks(blocks)
      if (toolCalls.length > 0) {
        out.push({ role: 'assistant', content: text.length > 0 ? text : null, tool_calls: toolCalls })
      } else if (text.length > 0) {
        out.push({ role: 'assistant', content: text })
      }
      continue
    }

    // user 角色：文本/图片进 user message，tool-result 拆成独立的 tool message。
    const parts = []
    const toolMessages = []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text') parts.push({ type: 'text', text: block.text ?? '' })
      else if (block.type === 'tool-result') {
        toolMessages.push({
          role: 'tool',
          tool_call_id: block.toolCallId ?? 'unknown',
          content: stringifyToolResult(block)
        })
      } else if (block.type === 'image') parts.push(imagePartOf(block))
      else if (block.type === 'file') parts.push({ type: 'text', text: '[文件内容见附件]' })
    }
    const visible = parts.filter((p) => p.type !== 'text' || p.text.length > 0)
    if (visible.length > 0) {
      const onlyText = visible.every((p) => p.type === 'text')
      out.push({ role: 'user', content: onlyText ? visible.map((p) => p.text).join('') : visible })
    }
    out.push(...toolMessages)
  }
  return out
}

/** DSH 工具声明 → OpenAI tools 数组。 */
function buildOpenAITools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} }
    }
  }))
}

/** 按模型 id 给一个合适的上下文预算。 */
function contextWindowOf(model) {
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * AI Studio 网页端内核适配器。
 */
export class AIStudioWebAdapter extends LlmAdapter {
  /**
   * @param {{ getBaseUrl: () => string, getApiKey: () => string, getModels?: () => string[], log?: (msg: string) => void, onAuthFailure?: (detail: string) => void }} deps
   */
  constructor(deps) {
    super()
    this.deps = deps
  }

  providerInfo(provider) {
    return { id: provider, name: 'Google AI Studio' }
  }

  /**
   * 暴露给 DSH 的模型清单：**只看设置页勾选了哪些**（配置项 `models`）。
   * 未勾选的模型不会出现在会话窗口的选择器里；同时把内核真实提供的集合记进日志，
   * 便于排查 cookie 是否生效。
   */
  async listModels(provider) {
    try {
      const res = await fetch(`${this.deps.getBaseUrl()}/models`, {
        headers: { ...attributionHeaders(), Authorization: `Bearer ${this.deps.getApiKey()}` },
        signal: AbortSignal.timeout(5000)
      })
      if (res.ok) {
        const json = await res.json()
        const ids = (json.data ?? []).map((m) => m.id).filter((id) => typeof id === 'string')
        this.deps.log?.(`内核当前提供 ${ids.length} 个模型：${ids.join(', ')}`)
      }
    } catch (error) {
      this.deps.log?.(`模型清单读取失败（不影响已选模型的展示）：${String(error)}`)
    }
    return this.selectedIds().map((id) => {
      const known = MODEL_CATALOG.find((m) => m.id === id)
      return this.describe(provider, id, known?.name, known?.input)
    })
  }

  /** 设置页勾选的模型 id；为空或非法时回退默认两个。 */
  selectedIds() {
    const picked = this.deps.getModels?.()
    const list = Array.isArray(picked) ? picked.filter((id) => typeof id === 'string' && id.length > 0) : []
    return list.length > 0 ? list : DEFAULT_MODELS
  }

  /** 组装一条模型描述（DSH 侧展示与预算用）。 */
  describe(provider, id, name, input) {
    return {
      provider,
      id,
      name: name ?? id,
      contextWindow: contextWindowOf(id),
      maxTokens: DEFAULT_MAX_TOKENS,
      input: input ?? ['text']
    }
  }

  async resolveModel(provider, model, _signal) {
    const known = MODEL_CATALOG.find((m) => m.id === model)
    return this.describe(provider, model, known?.name, known?.input)
  }

  /**
   * 流式发起一次调用，把内核的 OpenAI SSE 翻译成 DSH chunk。
   * @param {any} options - DSH 生成选项（messages/model/tools/signal/...）。
   */
  async *stream(options) {
    const baseUrl = this.deps.getBaseUrl()
    const apiKey = this.deps.getApiKey()
    const messages = buildOpenAIMessages(options.messages)
    const tools = buildOpenAITools(options.tools)
    const body = {
      model: options.model,
      messages,
      stream: true,
      // 让内核在流末尾补一个 usage 帧，否则 DSH 侧的 token 统计恒为 0。
      stream_options: { include_usage: true },
      ...(tools ? { tools } : {}),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens })
    }

    // 转换状态：open 是当前未关闭的块，closed 记录已关闭的块序号。
    let nextIndex = -1
    let open = null
    const textBuf = new Map()
    const reasoningBuf = new Map()
    const callBySlot = new Map()
    const closed = new Set()
    let sawVisible = false
    let usage = { inputTokens: 0, outputTokens: 0 }
    let finishReason = { kind: 'stop' }

    const blockFor = (type, index) => {
      if (type === 'reasoning') return { type: 'reasoning', text: reasoningBuf.get(index) ?? '' }
      if (type === 'tool-call') {
        for (const rec of callBySlot.values()) {
          if (rec.index === index) {
            return { type: 'tool-call', id: rec.id, name: rec.name, arguments: rec.arguments.length > 0 ? rec.arguments : '{}' }
          }
        }
        return { type: 'tool-call', id: '', name: '', arguments: '{}' }
      }
      return { type: 'text', text: textBuf.get(index) ?? '' }
    }

    /** 关闭当前块（若有）。 */
    const closeOpen = function* () {
      if (open === null) return
      const current = open
      open = null
      closed.add(current.index)
      yield { type: 'block-end', index: current.index, block: blockFor(current.type, current.index) }
    }

    /**
     * 打开一个新块。
     * @param {'text'|'reasoning'|'tool-call'} type
     * @param {boolean} force - true 时即使同类型也另开一块（不同工具调用各占一块）。
     */
    const openBlock = function* (type, force = false) {
      if (!force && open !== null && open.type === type) return
      yield* closeOpen()
      nextIndex += 1
      open = { index: nextIndex, type }
      yield { type: 'block-start', index: nextIndex, blockType: type }
    }

    let res
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...attributionHeaders(),
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: options.signal
      })
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('请求已被取消', 'ABORTED')
      throw new LlmError(`连接本地 AI Studio 内核失败（内核没在跑？）：${String(error)}`, 'SERVER')
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      // 内核报账户级认证失败时，通知 host 侧把状态刷成「需要重新导入账户」，
      // 免得用户对着 403 反复重试。
      const authBroken = res.status === 401 || res.status === 403 ||
        /auth_required|account_required|does not have permission|Access restricted|invalid authentication/i.test(text)
      if (authBroken) this.deps.onAuthFailure?.(text)
      const code = authBroken
        ? 'AUTH'
        : res.status === 429 ? 'RATE_LIMIT' : res.status >= 500 ? 'SERVER' : 'INVALID_REQUEST'
      throw new LlmError(
        `AI Studio 内核返回 HTTP ${res.status}：${text.slice(0, 500)}${authBroken ? '（账户登录态可能已失效，请在设置里重新导入账户）' : ''}`,
        code
      )
    }

    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    let buffer = ''

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode()
        } else {
          buffer += decoder.decode(value, { stream: true })
        }

        // 逐行取 SSE：只认 data: 行，空行与 event: 行直接忽略。
        const payloads = []
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
          buffer = buffer.slice(newlineIndex + 1)
          newlineIndex = buffer.indexOf('\n')
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload.length > 0 && payload !== '[DONE]') payloads.push(payload)
        }
        if (done && buffer.trim().length > 0) {
          const trimmed = buffer.trim()
          buffer = ''
          if (trimmed.startsWith('data:')) {
            const payload = trimmed.slice(5).trim()
            if (payload.length > 0 && payload !== '[DONE]') payloads.push(payload)
          }
        }

        for (const payload of payloads) {
          let event
          try {
            event = JSON.parse(payload)
          } catch {
            continue
          }
          if (event.usage) {
            const input = event.usage.prompt_tokens ?? 0
            const output = event.usage.completion_tokens ?? 0
            usage = { inputTokens: input, outputTokens: output, totalTokens: input + output }
          }
          const choice = event.choices?.[0]
          if (!choice) continue
          const delta = choice.delta ?? {}

          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            yield* openBlock('reasoning')
            reasoningBuf.set(open.index, (reasoningBuf.get(open.index) ?? '') + delta.reasoning_content)
            yield { type: 'reasoning-delta', index: open.index, text: delta.reasoning_content }
          }
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield* openBlock('text')
            sawVisible = true
            textBuf.set(open.index, (textBuf.get(open.index) ?? '') + delta.content)
            yield { type: 'text-delta', index: open.index, text: delta.content }
          }
          for (const call of delta.tool_calls ?? []) {
            const slot = call.index ?? 0
            let record = callBySlot.get(slot)
            if (record === undefined) {
              yield* openBlock('tool-call', true)
              record = { index: open.index, id: call.id ?? '', name: call.function?.name ?? '', arguments: '' }
              callBySlot.set(slot, record)
            } else if (open === null || open.index !== record.index) {
              // 回到先前打开过的工具块：块本身已被关闭，这里不再重复 block-start。
              closed.delete(record.index)
            }
            if (call.id) record.id = call.id
            if (call.function?.name) record.name = call.function.name
            const argsDelta = call.function?.arguments ?? ''
            if (argsDelta.length > 0) record.arguments += argsDelta
            yield {
              type: 'tool-call-delta',
              index: record.index,
              id: record.id,
              ...(record.name.length > 0 ? { name: record.name } : {}),
              argumentsDelta: argsDelta
            }
          }
          if (choice.finish_reason) {
            if (choice.finish_reason === 'length') finishReason = { kind: 'max-tokens' }
            else if (choice.finish_reason === 'tool_calls') finishReason = { kind: 'tool-calls' }
            else finishReason = { kind: 'stop' }
          }
        }

        if (done) break
      }
    } catch (error) {
      if (options.signal?.aborted) {
        yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已被取消', code: 'ABORTED' } } }
        return
      }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: String(error), code: 'SERVER' } } }
      return
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // 释放失败无需处理：流已经结束。
      }
    }

    yield* closeOpen()
    // 交错的工具调用可能留下未关闭的块，补上 block-end。
    for (const record of callBySlot.values()) {
      if (closed.has(record.index)) continue
      closed.add(record.index)
      yield { type: 'block-end', index: record.index, block: blockFor('tool-call', record.index) }
    }

    if (!sawVisible && callBySlot.size === 0) {
      yield { type: 'usage', usage }
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: `模型 ${options.model} 返回了空响应`, code: 'EMPTY_RESPONSE' } }
      }
      return
    }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: finishReason }
  }
}
