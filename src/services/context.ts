import type { Config } from '../config.js';
import type { EmailAdapter } from '../email/types.js';
import type { Store } from '../store/types.js';

export interface ServiceContext {
  config: Config;
  store: Store;
  adapter: EmailAdapter;
}
