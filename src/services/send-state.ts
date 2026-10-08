/**
 * 這個程序裡正在寄送的 campaign id。
 * 獨立成小模組讓 campaigns.ts 也能判斷「寄送中」是不是真的在寄，
 * 避免 campaigns ↔ sending 互相 import。
 */
const inFlight = new Set<string>();

export const markSending = (campaignId: string): void => {
  inFlight.add(campaignId);
};

export const clearSending = (campaignId: string): void => {
  inFlight.delete(campaignId);
};

export const isSendingNow = (campaignId: string): boolean => inFlight.has(campaignId);
