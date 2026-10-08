import { logger } from '../../core/logger.js';
import type { EmailAdapter, EmailAdapterFactory } from '../types.js';

/** 預設 adapter：什麼都不寄，只寫 log。用來把流程跑通。 */
export const createDryRunAdapter: EmailAdapterFactory = (): EmailAdapter => ({
  name: 'dry_run',

  async verify() {
    return { ok: true, message: '測試信只寫入紀錄。' };
  },

  async send(message) {
    logger.info('dry_run 寄信', {
      to: message.to,
      subject: message.subject,
      bytes: message.html.length,
    });
    return { ok: true, id: `dryrun_${Date.now().toString(36)}` };
  },
});
