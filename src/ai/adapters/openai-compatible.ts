import { badRequest } from '../../core/errors.js';
import { parseModelJson } from '../json.js';
import { aiServiceLabel, getAiService } from '../providers.js';
import type { AiAdapter, AiCompleteInput, AiConfig } from '../types.js';

function rootUrl(config: AiConfig): string {
  const base = config.baseUrl || getAiService(config.provider)?.baseUrl;
  if (!base) throw badRequest('要填 API 網址');
  return base.replace(/\/+$/, '');
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function readError(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) return 'AI 金鑰無法使用';
  return `AI 服務回應 ${response.status}`;
}

export function createOpenAiCompatibleAdapter(config: AiConfig): AiAdapter {
  const model = config.model ?? '';
  const optionalKey = Boolean(getAiService(config.provider)?.optionalKey);
  const label = aiServiceLabel(config.provider);
  return {
    name: config.provider,
    model,
    async verify() {
      if (!config.apiKey && !optionalKey) return { ok: false, message: '尚未設定 API 金鑰' };
      if (!model) return { ok: false, message: '請設定模型' };
      let url: string;
      try {
        url = `${rootUrl(config)}/models`;
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
      try {
        const response = await fetch(url, {
          headers: authHeaders(config.apiKey),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) return { ok: false, message: await readError(response) };
        return { ok: true, message: `已接上 ${label}` };
      } catch {
        return { ok: false, message: '連不上 AI 服務' };
      }
    },
    async complete(input: AiCompleteInput) {
      if (!config.apiKey && !optionalKey) throw badRequest('尚未接上 AI');
      if (!model) throw badRequest('請設定模型');
      const url = `${rootUrl(config)}/chat/completions`;
      const payload = {
        model,
        temperature: 0.4,
        messages: [
          { role: 'system', content: input.system },
          {
            role: 'user',
            content: `${input.user}\n\n只回傳符合這個 JSON 形狀的物件：\n${JSON.stringify(input.schema)}`,
          },
        ],
      };
      const post = (body: Record<string, unknown>) =>
        fetch(url, {
          method: 'POST',
          headers: { ...authHeaders(config.apiKey), 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45_000),
        });
      let response = await post({ ...payload, response_format: { type: 'json_object' } });
      if (response.status === 400 || response.status === 422) response = await post(payload);
      if (!response.ok) throw badRequest(await readError(response));
      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw badRequest('AI 沒有回傳內容');
      return parseModelJson(content);
    },
  };
}
