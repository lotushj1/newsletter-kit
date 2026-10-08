import type { Config } from '../config.js';

export interface AiCompleteInput {
  system: string;
  user: string;
  /** 給模型看的 JSON 形狀說明，不是執行期驗證。 */
  schema: Record<string, unknown>;
}

export interface DecisionQuestion {
  id: string;
  instructions: string;
  /** 有選項就是選擇題，沒有就是是否題。 */
  options?: Record<string, string>;
}

export interface DecisionAnswer {
  choice: string | null;
  yes: boolean;
}

export interface AiAdapter {
  readonly name: string;
  readonly model: string;
  verify(): Promise<{ ok: boolean; message: string }>;
  complete(input: AiCompleteInput): Promise<unknown>;
  decide?(state: string, questions: DecisionQuestion[]): Promise<Record<string, DecisionAnswer>>;
}

export type AiConfig = Config['ai'];
