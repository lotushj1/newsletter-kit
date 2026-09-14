import { createInsForgeBackend } from '../../core/insforge.js';
import type { EmailAdapter, EmailAdapterFactory } from '../types.js';

/**
 * 可選 adapter：透過 InsForge 的 emails.send 投遞。
 * 需要付費方案；免費專案只能走 dry_run 或其他供應商。
 */
export const createInsForgeAdapter: EmailAdapterFactory = (context): EmailAdapter => ({
  name: 'insforge',

  async verify() {
    if (!context.insforgeUrl || !context.insforgeApiKey) {
      return { ok: false, message: '缺少 INSFORGE_URL 或 INSFORGE_API_KEY。' };
    }
    return { ok: true, message: '已設定 InsForge。實際能否寄出仍取決於專案方案與寄件網域。' };
  },

  async send(message) {
    if (!context.insforgeUrl || !context.insforgeApiKey) {
      return { ok: false, error: '缺少 INSFORGE_URL 或 INSFORGE_API_KEY', retryable: false };
    }
    try {
      const sent = await createInsForgeBackend().sendEmail({
        to: message.to,
        subject: message.subject,
        html: message.html,
        from: message.from,
        replyTo: message.replyTo,
      });
      return { ok: true, id: sent.id };
    } catch (error) {
      const text = (error as Error).message;
      return {
        ok: false,
        error: text,
        retryable: /429|5\d\d|timeout|network/i.test(text),
      };
    }
  },
});
