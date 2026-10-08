import { badRequest } from '../../core/errors.js';
import { parseModelJson } from '../json.js';
import type { AiAdapter, AiCompleteInput, AiConfig } from '../types.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com';

export function createAnthropicAdapter(config: AiConfig): AiAdapter {
  const model = config.model ?? '';
  const root = (config.baseUrl ?? ANTHROPIC_BASE).replace(/\/+$/, '');
  return {
    name: 'anthropic',
    model,
    async verify() {
      if (!config.apiKey) return { ok: false, message: '尚未設定 AI_API_KEY' };
      if (!model) return { ok: false, message: '請設定 AI_MODEL' };
      try {
        const response = await fetch(`${root}/v1/models`, {
          headers: {
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) return { ok: false, message: 'AI 金鑰無法使用' };
          return { ok: false, message: `AI 服務回應 ${response.status}` };
        }
        return { ok: true, message: `已接上 anthropic（${model}）` };
      } catch {
        return { ok: false, message: '連不上 AI 服務' };
      }
    },
    async complete(input: AiCompleteInput) {
      if (!config.apiKey) throw badRequest('尚未接上 AI');
      if (!model) throw badRequest('請設定 AI_MODEL');
      const response = await fetch(`${root}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature: 0.4,
          system: input.system,
          messages: [
            {
              role: 'user',
              content: `${input.user}\n\n只回傳符合這個 JSON 形狀的物件，不要加說明：\n${JSON.stringify(input.schema)}`,
            },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw badRequest('AI 金鑰無法使用');
        throw badRequest(`AI 服務回應 ${response.status}`);
      }
      const body = (await response.json()) as { content?: { type?: string; text?: string }[] };
      const text = body.content?.find((block) => block.type === 'text')?.text;
      if (typeof text !== 'string' || !text.trim()) throw badRequest('AI 沒有回傳內容');
      return parseModelJson(text);
    },
  };
}
