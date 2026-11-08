export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text?: string | undefined;
  replyTo?: string | undefined;
  /** adapter 可以把它轉成 List-Unsubscribe header */
  unsubscribeUrl?: string | undefined;
  unsubscribeMailto?: string | undefined;
  headers?: Record<string, string> | undefined;
  /**
   * 安全重試用的冪等鍵（例如 delivery id）。支援的供應商（如 Portaly）
   * 會帶給 API，同一個鍵重試不會寄出第二封；其他 adapter 可忽略。
   */
  idempotencyKey?: string | undefined;
}

export type SendResult =
  | { ok: true; id?: string | undefined }
  | {
      ok: false;
      error: string;
      retryable?: boolean | undefined;
      /**
       * true = 供應商可能已經收下這封（逾時、斷線、5xx）。
       * 這種結果不能直接重寄，寄送紀錄會停在 sending，等對帳確認。
       */
      outcomeUnknown?: boolean | undefined;
    };

/** 供應商端查到的寄送紀錄（用 ref／冪等鍵對帳）。 */
export interface ProviderSentRecord {
  ref: string;
  providerMessageId?: string | undefined;
  acceptedAt?: string | undefined;
  /** 供應商回報的收件人狀態，例如 delivered、bounced；accepted ≠ delivered。 */
  recipientStatus?: string | undefined;
}

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
  /**
   * 用 ref（= delivery id）查供應商是否已收下這些信，結果不明的寄送紀錄靠它對帳。
   * 沒實作的供應商就無法自動對帳，只能人工確認。
   */
  findSentByRefs?(refs: string[], sinceIso: string): Promise<Map<string, ProviderSentRecord>>;
}

export interface AdapterContext {
  provider: string;
  webhookUrl?: string | undefined;
  webhookSecret?: string | undefined;
  resendApiKey?: string | undefined;
  zeaburEndpoint?: string | undefined;
  zeaburToken?: string | undefined;
  insforgeUrl?: string | undefined;
  insforgeApiKey?: string | undefined;
  /** Portaly Email 的 API 金鑰（pem_…）。 */
  portalyApiKey?: string | undefined;
  /** 覆寫 Portaly API 位址，預設 https://portaly.ai。 */
  portalyApiHost?: string | undefined;
  /** HTTP 平台的金鑰，例如 Postmark、SendGrid。 */
  apiKey?: string | undefined;
  /** 網域、端點或 Project ID。 */
  apiExtra?: string | undefined;
}

export type EmailAdapterFactory = (context: AdapterContext) => EmailAdapter;
