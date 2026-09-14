/**
 * 當 library 用時的公開介面。
 * 最常見的需求是自訂 Email adapter 或換掉儲存層，兩者都從這裡匯入。
 */
export { loadConfig, loadEnvFile, type Config, type StoreDriver } from './config.js';

export type {
  AdapterContext,
  EmailAdapter,
  EmailAdapterFactory,
  EmailMessage,
  SendResult,
  VerifyResult,
} from './email/types.js';
export {
  createEmailAdapter,
  listEmailAdapters,
  registerEmailAdapter,
  sendMessages,
} from './email/registry.js';

export { createStore, InsForgeStore, JsonStore, MemoryStore, SqliteStore } from './store/index.js';
export type {
  Campaign,
  CampaignStatus,
  Delivery,
  Paged,
  Sequence,
  Store,
  Subscriber,
  SubscriberStatus,
} from './store/types.js';

export type { ServiceContext } from './services/context.js';
export * as subscribers from './services/subscribers.js';
export * as campaigns from './services/campaigns.js';
export * as sending from './services/sending.js';
export * as sequences from './services/sequences.js';
export { createScheduler, type Scheduler } from './services/scheduler.js';

export { createApp } from './http/app.js';
export { markdownToHtml, renderEmailLayout, applyVariables, htmlToText } from './core/render.js';
export { campaignContentHtml, campaignHasBody } from './core/body.js';
export { injectTracking } from './core/tracking.js';
export { createToken, createTrackingToken, verifyToken } from './core/tokens.js';
