export type EmailKind = 'dry_run' | 'webhook' | 'resend' | 'portaly' | 'zeabur' | 'insforge' | 'http' | 'ses';

export interface EmailPlatform {
  id: string;
  label: string;
  group?: 'common' | 'more';
  kind: EmailKind;
  note: string;
  keyLabel?: string;
  extraLabel?: string;
  extraPlaceholder?: string;
  /** extra 是網址時要檢查格式。 */
  extraUrl?: boolean;
}

export const EMAIL_PLATFORMS: readonly EmailPlatform[] = [
  { id: 'dry_run', label: '測試用', kind: 'dry_run', note: '測試信只寫入紀錄，不寄出。' },
  {
    id: 'webhook',
    label: 'Webhook',
    kind: 'webhook',
    note: '每封信 POST 到你的網址，由你那邊寄出。',
    keyLabel: '簽章金鑰',
    extraLabel: '網址',
    extraPlaceholder: 'https://example.com/send',
  },
  {
    id: 'resend',
    label: 'Resend',
    group: 'common',
    kind: 'resend',
    note: '用 Resend 的 API 金鑰寄出。',
    keyLabel: 'API 金鑰',
  },
  {
    id: 'portaly',
    label: 'Portaly Email',
    group: 'common',
    kind: 'portaly',
    note: '用 Portaly Email 的 API 金鑰（pem_…）寄出。邀請制 beta，寄信額度與網域在 Portaly 後台管理。',
    keyLabel: 'API 金鑰',
  },
  {
    id: 'postmark',
    label: 'Postmark',
    group: 'common',
    kind: 'http',
    note: '用 Server Token 打 Postmark。',
    keyLabel: 'Server Token',
  },
  {
    id: 'sendgrid',
    label: 'SendGrid',
    group: 'common',
    kind: 'http',
    note: '用 SendGrid 的 API 金鑰寄出。',
    keyLabel: 'API 金鑰',
  },
  {
    id: 'mailgun',
    label: 'Mailgun',
    group: 'common',
    kind: 'http',
    note: '用 Mailgun 的 API 金鑰，並填寄信網域。',
    keyLabel: 'API 金鑰',
    extraLabel: '寄信網域',
    extraPlaceholder: 'mg.example.com',
  },
  {
    id: 'brevo',
    label: 'Brevo',
    group: 'common',
    kind: 'http',
    note: '用 Brevo 的 API 金鑰寄出。',
    keyLabel: 'API 金鑰',
  },
  {
    id: 'mailchimp',
    label: 'Mailchimp',
    group: 'common',
    kind: 'http',
    note: '走 Mailchimp Transactional（Mandrill）的 API 金鑰。',
    keyLabel: 'API 金鑰',
  },
  {
    id: 'ses',
    label: 'Amazon SES',
    group: 'common',
    kind: 'ses',
    note: '這版不代簽 AWS。要寄出請改用 Webhook，把信交給你的 SES 端點。',
  },
  {
    id: 'sparkpost',
    label: 'SparkPost',
    group: 'more',
    kind: 'http',
    note: '用 SparkPost 的 API 金鑰寄出。',
    keyLabel: 'API 金鑰',
  },
  {
    id: 'mailersend',
    label: 'MailerSend',
    group: 'more',
    kind: 'http',
    note: '用 MailerSend 的 API 金鑰寄出。',
    keyLabel: 'API 金鑰',
  },
  {
    id: 'plunk',
    label: 'Plunk',
    group: 'more',
    kind: 'http',
    note: '用 Plunk 的 API 金鑰寄出。',
    keyLabel: 'API 金鑰',
  },
  {
    id: 'smtp2go',
    label: 'SMTP2GO',
    group: 'more',
    kind: 'http',
    note: '用 SMTP2GO 的 API 金鑰寄出。',
    keyLabel: 'API 金鑰',
  },
  {
    id: 'elasticemail',
    label: 'Elastic Email',
    group: 'more',
    kind: 'http',
    note: '用 Elastic Email 的 API 金鑰寄出。',
    keyLabel: 'API 金鑰',
  },
  {
    id: 'postal',
    label: 'Postal',
    group: 'more',
    kind: 'http',
    note: '打你自架的 Postal。端點不要加路徑。',
    keyLabel: 'Server API Key',
    extraLabel: '端點',
    extraPlaceholder: 'https://postal.example.com',
    extraUrl: true,
  },
  {
    id: 'scaleway',
    label: 'Scaleway',
    group: 'more',
    kind: 'http',
    note: '用 Scaleway Transactional Email。區域固定為 fr-par。',
    keyLabel: 'API 金鑰',
    extraLabel: 'Project ID',
    extraPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  },
  {
    id: 'zeabur',
    label: 'Zeabur',
    group: 'more',
    kind: 'zeabur',
    note: '把信 POST 到你在 Zeabur 上的寄信端點。',
    keyLabel: 'Token',
    extraLabel: '端點',
    extraPlaceholder: 'https://example.com/send',
  },
  {
    id: 'insforge',
    label: 'InsForge',
    group: 'more',
    kind: 'insforge',
    note: '透過你自己的 InsForge 專案寄出。免費專案通常不能寄。',
    keyLabel: 'API 金鑰',
    extraLabel: '網址',
    extraPlaceholder: 'https://your-project.insforge.app',
  },
];

export function getEmailPlatform(id: string): EmailPlatform | undefined {
  return EMAIL_PLATFORMS.find((platform) => platform.id === id);
}

export function isEmailPlatform(id: string): boolean {
  return EMAIL_PLATFORMS.some((platform) => platform.id === id);
}
