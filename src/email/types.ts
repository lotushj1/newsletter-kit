export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text?: string | undefined;
  replyTo?: string | undefined;
  /** adapter 可以把它轉成 List-Unsubscribe header */
  unsubscribeUrl?: string | undefined;
  headers?: Record<string, string> | undefined;
}

export type SendResult =
  | { ok: true; id?: string | undefined }
  | { ok: false; error: string; retryable?: boolean | undefined };

export interface VerifyResult {
  ok: boolean;
  message: string;
}

/**
 * 這個系統自己不寄信，只呼叫 adapter。
 * 要接新的 Email 供應商就實作這個介面，然後 registerEmailAdapter 註冊。
 */
export interface EmailAdapter {
  readonly name: string;
  /** 檢查設定是否齊全／可連線，後台「檢查寄信設定」會呼叫它 */
  verify(): Promise<VerifyResult>;
  send(message: EmailMessage): Promise<SendResult>;
  /** 有批次 API 的供應商可實作，沒實作就退回逐封 send */
  sendBatch?(messages: EmailMessage[]): Promise<SendResult[]>;
}

export interface AdapterContext {
  provider: string;
  webhookUrl?: string | undefined;
  webhookSecret?: string | undefined;
  resendApiKey?: string | undefined;
  zeaburEndpoint?: string | undefined;
  zeaburToken?: string | undefined;
}

export type EmailAdapterFactory = (context: AdapterContext) => EmailAdapter;
