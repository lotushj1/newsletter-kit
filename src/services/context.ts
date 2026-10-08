import type { Config } from '../config.js';
import type { AiAdapter } from '../ai/types.js';
import type { EmailAdapter } from '../email/types.js';
import type { Store } from '../store/types.js';

export interface ServiceContext {
  config: Config;
  store: Store;
  adapter: EmailAdapter;
  /** 未接上 AI 時為 null。任務端點應回「尚未接上 AI」。 */
  ai: AiAdapter | null;
}
