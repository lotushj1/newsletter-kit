import { badRequest } from '../../core/errors.js';
import type { AiAdapter, AiConfig, DecisionAnswer, DecisionQuestion } from '../types.js';

const DEFAULT_BASE = 'https://api.typesafe.ai';

function rootUrl(config: AiConfig): string {
  return (config.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

async function readError(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) return 'AI 金鑰無法使用';
  if (response.status === 429 || response.status === 529) return 'Jev 忙碌，稍後再試';
  return `AI 服務回應 ${response.status}`;
}

export function createJevAdapter(config: AiConfig): AiAdapter {
  const model = config.model || 'jev-latest';
  const headers = {
    authorization: `Bearer ${config.apiKey ?? ''}`,
    'content-type': 'application/json',
  };
  return {
    name: 'jev',
    model,
    async verify() {
      if (!config.apiKey) return { ok: false, message: '尚未設定 API 金鑰' };
      try {
        const response = await fetch(`${rootUrl(config)}/v1/models`, {
          headers: { authorization: headers.authorization },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) return { ok: false, message: await readError(response) };
        return { ok: true, message: '已接上 Jev' };
      } catch {
        return { ok: false, message: '連不上 AI 服務' };
      }
    },
    async complete() {
      throw badRequest('Jev 只做判斷，不能寫信');
    },
    async decide(state, questions) {
      if (!config.apiKey) throw badRequest('尚未接上 AI');
      if (!state.trim()) throw badRequest('沒有可判斷的內容');
      if (questions.length === 0) throw badRequest('沒有可判斷的問題');
      const bodyQuestions: Record<string, unknown> = {};
      for (const question of questions) {
        bodyQuestions[question.id] = toQuestion(question);
      }
      const response = await fetch(`${rootUrl(config)}/v1/systemone`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, state, questions: bodyQuestions }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw badRequest(await readError(response));
      const body = (await response.json()) as { answers?: Record<string, { choice?: string; noul?: number }> };
      const answers: Record<string, DecisionAnswer> = {};
      for (const question of questions) {
        const answer = body.answers?.[question.id];
        if (question.options) {
          const choice = typeof answer?.choice === 'string' ? answer.choice : null;
          answers[question.id] = { choice: choice && choice in question.options ? choice : null, yes: false };
        } else {
          answers[question.id] = { choice: null, yes: typeof answer?.noul === 'number' && answer.noul >= 0.5 };
        }
      }
      return answers;
    },
  };
}

function toQuestion(question: DecisionQuestion): Record<string, unknown> {
  if (!question.options) return { type: 'noul', instructions: question.instructions };
  return { type: 'choice', instructions: question.instructions, criteria: question.options };
}
