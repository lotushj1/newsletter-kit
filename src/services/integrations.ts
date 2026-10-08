import { createAiAdapter } from '../ai/registry.js';
import {
  aiChoices,
  detectAiProvider,
  getAiService,
  isKnownAiProvider,
} from '../ai/providers.js';
import { badRequest } from '../core/errors.js';
import type { Config } from '../config.js';
import { createEmailAdapter, listEmailAdapters } from '../email/registry.js';
import { EMAIL_PLATFORMS, getEmailPlatform } from '../email/providers.js';
import type { AdapterContext } from '../email/types.js';
import { optionalString, requireString } from '../core/validate.js';
import type { ServiceContext } from './context.js';
import type { Store } from '../store/types.js';

const KEY = 'integrations';

interface SavedEmail {
  provider: string;
  from: string;
  replyTo: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  resendApiKey: string | null;
  zeaburEndpoint: string | null;
  zeaburToken: string | null;
  insforgeUrl: string | null;
  insforgeApiKey: string | null;
  portalyApiKey: string | null;
  portalyApiHost: string | null;
  apiKey: string | null;
  apiExtra: string | null;
  platformSecrets: Record<string, { key: string | null; extra: string | null }>;
}

interface SavedAi {
  provider: string;
  apiKey: string | null;
  model: string | null;
  baseUrl: string | null;
}

interface SavedIntegrations {
  email?: Partial<SavedEmail>;
  ai?: Partial<SavedAi>;
}

function emptyToNull(value: string | undefined): string | null {
  return value && value.trim() ? value : null;
}

function nullToUndef(value: string | null | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

function serializeEmail(email: Config['email']): SavedEmail {
  return {
    provider: email.provider,
    from: email.from,
    replyTo: emptyToNull(email.replyTo),
    webhookUrl: emptyToNull(email.webhookUrl),
    webhookSecret: emptyToNull(email.webhookSecret),
    resendApiKey: emptyToNull(email.resendApiKey),
    zeaburEndpoint: emptyToNull(email.zeaburEndpoint),
    zeaburToken: emptyToNull(email.zeaburToken),
    insforgeUrl: emptyToNull(email.insforgeUrl),
    insforgeApiKey: emptyToNull(email.insforgeApiKey),
    portalyApiKey: emptyToNull(email.portalyApiKey),
    portalyApiHost: emptyToNull(email.portalyApiHost),
    apiKey: emptyToNull(email.apiKey),
    apiExtra: emptyToNull(email.apiExtra),
    platformSecrets: Object.fromEntries(
      Object.entries(email.platformSecrets ?? {}).map(([id, value]) => [
        id,
        { key: emptyToNull(value.key), extra: emptyToNull(value.extra) },
      ]),
    ),
  };
}

function emailFromSaved(saved: SavedEmail): Config['email'] {
  return {
    provider: saved.provider,
    from: saved.from,
    replyTo: nullToUndef(saved.replyTo),
    webhookUrl: nullToUndef(saved.webhookUrl),
    webhookSecret: nullToUndef(saved.webhookSecret),
    resendApiKey: nullToUndef(saved.resendApiKey),
    zeaburEndpoint: nullToUndef(saved.zeaburEndpoint),
    zeaburToken: nullToUndef(saved.zeaburToken),
    insforgeUrl: nullToUndef(saved.insforgeUrl),
    insforgeApiKey: nullToUndef(saved.insforgeApiKey),
    portalyApiKey: nullToUndef(saved.portalyApiKey),
    portalyApiHost: nullToUndef(saved.portalyApiHost),
    apiKey: nullToUndef(saved.apiKey),
    apiExtra: nullToUndef(saved.apiExtra),
    platformSecrets: Object.fromEntries(
      Object.entries(saved.platformSecrets ?? {}).map(([id, value]) => [
        id,
        { key: nullToUndef(value?.key), extra: nullToUndef(value?.extra) },
      ]),
    ),
  };
}

function resolvedModel(provider: string, model: string | null | undefined): string | undefined {
  return nullToUndef(model ?? undefined) ?? getAiService(provider)?.defaultModel;
}

function serializeAi(ai: Config['ai']): SavedAi {
  const provider = isKnownAiProvider(ai.provider) ? ai.provider : 'none';
  return {
    provider,
    apiKey: emptyToNull(ai.apiKey),
    model: emptyToNull(resolvedModel(provider, ai.model)),
    baseUrl: emptyToNull(ai.baseUrl ?? getAiService(provider)?.baseUrl),
  };
}

function aiFromSaved(saved: SavedAi): Config['ai'] {
  return {
    provider: saved.provider,
    apiKey: nullToUndef(saved.apiKey),
    model: resolvedModel(saved.provider, saved.model),
    baseUrl: nullToUndef(saved.baseUrl) ?? getAiService(saved.provider)?.baseUrl,
  };
}

async function readSaved(store: Store): Promise<SavedIntegrations> {
  const raw = await store.getSetting(KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SavedIntegrations;
  } catch {
    return {};
  }
}

async function writeSaved(store: Store, patch: SavedIntegrations): Promise<void> {
  const current = await readSaved(store);
  await store.setSetting(KEY, JSON.stringify({ ...current, ...patch }));
}

export function emailAdapterContext(config: Config): AdapterContext {
  return {
    provider: config.email.provider,
    webhookUrl: config.email.webhookUrl,
    webhookSecret: config.email.webhookSecret,
    resendApiKey: config.email.resendApiKey,
    zeaburEndpoint: config.email.zeaburEndpoint,
    zeaburToken: config.email.zeaburToken,
    insforgeUrl: config.email.insforgeUrl,
    insforgeApiKey: config.email.insforgeApiKey,
    portalyApiKey: config.email.portalyApiKey,
    portalyApiHost: config.email.portalyApiHost,
    apiKey: config.email.apiKey,
    apiExtra: config.email.apiExtra,
  };
}

/** 後台存過的寄信／AI 設定蓋過環境變數。壞掉的 JSON 直接略過。 */
export async function applyStoredIntegrations(config: Config, store: Store): Promise<void> {
  const saved = await readSaved(store);
  if (saved.email && typeof saved.email.provider === 'string' && typeof saved.email.from === 'string') {
    const merged = { ...serializeEmail(config.email), ...saved.email };
    if (listEmailAdapters().includes(merged.provider)) config.email = emailFromSaved(merged);
  }
  if (saved.ai && typeof saved.ai.provider === 'string' && isKnownAiProvider(saved.ai.provider)) {
    config.ai = aiFromSaved({ ...serializeAi(config.ai), ...saved.ai });
  }
}

function bindAdapters(ctx: ServiceContext): void {
  ctx.adapter = createEmailAdapter(emailAdapterContext(ctx.config));
  ctx.ai = createAiAdapter(ctx.config.ai);
}

function platformState(email: Config['email'], id: string): { keySet: boolean; extra: string } {
  const platform = getEmailPlatform(id);
  const saved = email.platformSecrets?.[id];
  if (platform?.kind === 'resend') return { keySet: Boolean(email.resendApiKey), extra: '' };
  if (platform?.kind === 'portaly') return { keySet: Boolean(email.portalyApiKey), extra: '' };
  if (platform?.kind === 'webhook') return { keySet: Boolean(email.webhookSecret), extra: email.webhookUrl ?? '' };
  if (platform?.kind === 'zeabur') return { keySet: Boolean(email.zeaburToken), extra: email.zeaburEndpoint ?? '' };
  if (platform?.kind === 'insforge') return { keySet: Boolean(email.insforgeApiKey), extra: email.insforgeUrl ?? '' };
  const active = email.provider === id;
  return {
    keySet: Boolean(saved?.key ?? (active ? email.apiKey : undefined)),
    extra: saved?.extra ?? (active ? email.apiExtra ?? '' : ''),
  };
}

export function integrationView(ctx: ServiceContext) {
  const email = ctx.config.email;
  const ai = ctx.config.ai;
  return {
    email: {
      provider: email.provider,
      from: email.from,
      replyTo: email.replyTo ?? '',
      webhookUrl: email.webhookUrl ?? '',
      webhookSecretSet: Boolean(email.webhookSecret),
      resendApiKeySet: Boolean(email.resendApiKey),
      zeaburEndpoint: email.zeaburEndpoint ?? '',
      zeaburTokenSet: Boolean(email.zeaburToken),
      insforgeUrl: email.insforgeUrl ?? '',
      insforgeApiKeySet: Boolean(email.insforgeApiKey),
      choices: EMAIL_PLATFORMS.map((platform) => {
        const state = platformState(email, platform.id);
        return {
          id: platform.id,
          label: platform.label,
          group: platform.group ?? '',
          kind: platform.kind,
          note: platform.note,
          keyLabel: platform.keyLabel ?? '',
          extraLabel: platform.extraLabel ?? '',
          extraPlaceholder: platform.extraPlaceholder ?? '',
          keySet: state.keySet,
          extra: state.extra,
        };
      }),
    },
    ai: {
      provider: ai.provider,
      model: ai.model ?? '',
      baseUrl: ai.baseUrl ?? '',
      apiKeySet: Boolean(ai.apiKey),
      configured: Boolean(ctx.ai),
      choices: aiChoices(),
    },
  };
}

function keepSecret(value: unknown, current: string | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return current;
  if (typeof value !== 'string') throw badRequest('金鑰格式不對');
  const text = value.trim();
  return text || current;
}

function assignUrl(value: unknown, field: string, current: string | undefined): string | undefined {
  if (value === undefined) return current;
  if (value === null || value === '') return undefined;
  const text = requireString(value, field, 500);
  if (!/^https?:\/\//i.test(text)) throw badRequest(`${field} 要以 http:// 或 https:// 開頭`);
  return text;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('格式不對');
  return value as Record<string, unknown>;
}

export async function updateEmailIntegration(ctx: ServiceContext, input: unknown) {
  const body = asRecord(input);
  const provider = requireString(body.provider, '寄信管道', 40);
  if (!listEmailAdapters().includes(provider)) throw badRequest('沒有這個寄信管道');
  const from = requireString(body.from, '寄件人', 200);
  const replyTo = optionalString(body.replyTo, '回信地址', 200);

  const email: Config['email'] = {
    ...ctx.config.email,
    provider,
    from,
    replyTo,
  };
  if (provider === 'resend') email.resendApiKey = keepSecret(body.resendApiKey, email.resendApiKey);
  if (provider === 'portaly') email.portalyApiKey = keepSecret(body.portalyApiKey, email.portalyApiKey);
  if (provider === 'webhook') {
    email.webhookUrl = assignUrl(body.webhookUrl, 'Webhook 網址', email.webhookUrl);
    email.webhookSecret = keepSecret(body.webhookSecret, email.webhookSecret);
  }
  if (provider === 'zeabur') {
    email.zeaburEndpoint = assignUrl(body.zeaburEndpoint, 'Zeabur 端點', email.zeaburEndpoint);
    email.zeaburToken = keepSecret(body.zeaburToken, email.zeaburToken);
  }
  if (provider === 'insforge') {
    email.insforgeUrl = assignUrl(body.insforgeUrl, 'InsForge 網址', email.insforgeUrl);
    email.insforgeApiKey = keepSecret(body.insforgeApiKey, email.insforgeApiKey);
  }
  const platform = getEmailPlatform(provider);
  if (platform?.kind === 'http') {
    const current = email.platformSecrets?.[provider] ?? {};
    const key = keepSecret(body.apiKey, current.key ?? (ctx.config.email.provider === provider ? email.apiKey : undefined));
    const extra = body.apiExtra === undefined
      ? current.extra
      : optionalString(body.apiExtra, platform.extraLabel || '額外欄位', 500);
    if (platform.extraUrl && extra && !/^https?:\/\//i.test(extra)) {
      throw badRequest(`${platform.extraLabel || '端點'} 要以 http:// 或 https:// 開頭`);
    }
    email.platformSecrets = { ...(email.platformSecrets ?? {}), [provider]: { key, extra } };
    email.apiKey = key;
    email.apiExtra = extra;
  }

  ctx.config.email = email;
  bindAdapters(ctx);
  await writeSaved(ctx.store, { email: serializeEmail(email) });
  return integrationView(ctx);
}

export async function updateAiIntegration(ctx: ServiceContext, input: unknown) {
  const body = asRecord(input);
  const requested = requireString(body.provider, 'AI', 40);
  if (!isKnownAiProvider(requested)) throw badRequest('沒有這個 AI 服務');
  const incomingKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const detected = incomingKey ? detectAiProvider(incomingKey) : null;
  const providerName = detected ?? requested;
  const service = getAiService(providerName);
  let model = body.model === undefined ? ctx.config.ai.model : optionalString(body.model, '模型', 120);
  if (detected && detected !== requested) {
    const requestedDefault = getAiService(requested)?.defaultModel;
    if (!model || model === requestedDefault) model = service?.defaultModel;
  }
  const apiKey = keepSecret(body.apiKey, ctx.config.ai.apiKey);
  let baseUrl: string | undefined;
  if (providerName === 'compatible') {
    baseUrl = assignUrl(body.baseUrl, 'API 網址', ctx.config.ai.baseUrl);
    if (!baseUrl) throw badRequest('要填 API 網址');
    if (!model) throw badRequest('要填模型');
  } else if (service?.editableBaseUrl) {
    baseUrl = assignUrl(body.baseUrl, '位址', ctx.config.ai.baseUrl) ?? service.baseUrl;
  } else {
    baseUrl = service?.baseUrl;
  }

  const ai: Config['ai'] = {
    provider: providerName,
    apiKey,
    model: model || service?.defaultModel,
    baseUrl,
  };
  ctx.config.ai = ai;
  bindAdapters(ctx);
  await writeSaved(ctx.store, { ai: serializeAi(ai) });
  return integrationView(ctx);
}
