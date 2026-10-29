// 灵犀 · 模型调用小工具：判断心情、提炼记忆都借用宿主自己的模型。
import { randomUUID } from 'node:crypto'

import { PATHS } from './config.js'
import { appendLog } from './util.js'

/** 跟着当前会话的模型走；拿不到就退到宿主默认模型。 */
export function resolveModel(ctx, agent) {
  try {
    const header = agent?.session?.requestHeader?.()
    const cfg = header?.config
    if (cfg?.provider && cfg?.model) return { provider: cfg.provider, model: cfg.model }
  } catch { /* ignore */ }
  try {
    const options = agent?.options
    if (options?.provider && options?.model) return { provider: options.provider, model: options.model }
  } catch { /* ignore */ }
  try {
    const selection = ctx?.agentDefaultModel?.currentSelection?.()
      ?? ctx?.get?.('agentDefaultModel')?.currentSelection?.()
    if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
  } catch { /* ignore */ }
  return null
}

export function buildUserMessage(textValue) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(textValue) }],
    source: { kind: 'plugin', plugin: 'dsh-lingxi-agent-bot' },
  }
}

/**
 * 一次性取完一段文本。返回 { text, error }，不抛。
 * 兼容宿主不同版本的 chunk 形态：text-delta / text / finish(reason=error)。
 */
export async function completeText(ctx, { provider, model, system, user, maxTokens = 800, temperature = 0.2, label = 'llm' }) {
  if (!ctx?.llm?.stream) return { text: '', error: '宿主没有提供 llm 服务' }
  if (!provider || !model) return { text: '', error: '没有可用的模型' }
  let out = ''
  let finishError = ''
  try {
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      system,
      messages: [buildUserMessage(user)],
      maxTokens,
      temperature,
    })) {
      if (!chunk) continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      else if (chunk.type === 'text' && typeof chunk.text === 'string') out += chunk.text
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        finishError = chunk.reason.failure?.message || chunk.reason.error?.message || '模型返回错误'
      }
    }
  } catch (error) {
    finishError = String(error?.message ?? error)
  }
  if (finishError) appendLog(PATHS.diag, `${label} 调用失败：${finishError}`)
  return { text: out, error: finishError }
}

/** 设置页的下拉：列出 provider 与 model。 */
export async function listModels(ctx) {
  const providers = []
  try {
    for (const provider of ctx?.llm?.listProviders?.() ?? []) {
      const id = provider.id ?? provider.name ?? String(provider)
      const item = { id, name: provider.name ?? id, models: [] }
      try {
        for (const model of (await ctx.llm.listModels?.(id)) ?? []) {
          item.models.push({ id: model.id ?? model.name, name: model.name ?? model.id })
        }
      } catch { /* ignore */ }
      providers.push(item)
    }
  } catch { /* ignore */ }
  return providers
}
