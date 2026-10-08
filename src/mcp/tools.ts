import {
  applyAutomation,
  draftAutomation,
  draftCampaign,
  interpretFilter,
  organizeCampaigns,
  organizeSubscribers,
  rewriteSelection,
  suggestSubjects,
} from '../ai/tasks.js';
import { badRequest } from '../core/errors.js';
import { PREVIEW_RECIPIENT } from '../core/preview-email.js';
import { decodeImportFile, spreadsheetToCsv } from '../core/spreadsheet.js';
import { saveCampaignImage } from '../core/uploads.js';
import { normalizeEmail, normalizeTags } from '../core/validate.js';
import { listEmailAdapters } from '../email/registry.js';
import { getBrand, updateBrand } from '../services/brand.js';
import {
  bulkDeleteCampaigns,
  bulkSetCampaignFolder,
  cancelSchedule,
  copyCampaign,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  overviewRates,
  renderCampaign,
  scheduleCampaign,
  updateCampaign,
} from '../services/campaigns.js';
import type { ServiceContext } from '../services/context.js';
import { createFolder, deleteFolder, listFolders, updateFolder } from '../services/folders.js';
import {
  integrationView,
  updateAiIntegration,
  updateEmailIntegration,
} from '../services/integrations.js';
import { cancelSending, sendTestEmail, startCampaign } from '../services/sending.js';
import {
  copySequence,
  createSequence,
  deleteSequence,
  getSequenceWithSteps,
  listSequencesWithSteps,
  updateSequence,
} from '../services/sequences.js';
import { publicSession } from '../services/session.js';
import {
  copyCampaignStarter,
  createCampaignStarter,
  createCampaignStarterFromCampaign,
  deleteCampaignStarter,
  getCampaignStarter,
  listCampaignStarters,
  updateCampaignStarter,
} from '../services/starters.js';
import {
  createSubscriber,
  deleteSubscriber,
  exportSubscribersCsv,
  importSubscribersCsv,
  listSubscriberTags,
  listSubscribers,
  subscribe,
  updateSubscriber,
} from '../services/subscribers.js';
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate,
} from '../services/templates.js';
import type { Campaign, CampaignStatus, FolderKind } from '../store/types.js';
import { audienceFromCampaign } from '../store/types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const FOLDER_KINDS = ['subscribers', 'campaigns'] as const;

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_session',
    description: '目前站台設定與 Agent 連線位址（MCP／Admin API）。不含 token。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_overview',
    description: '訂閱人數、最近電子報、標籤、資料夾與開信／點擊概況。from、to 為 ISO 時間，用來限縮成效區間。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
      },
    },
  },
  {
    name: 'get_brand',
    description: '讀取品牌簽名與退訂文字',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_brand',
    description: '更新品牌簽名或退訂文案。只傳要改的欄位。',
    inputSchema: {
      type: 'object',
      properties: {
        writerName: { type: 'string' },
        organization: { type: 'string' },
        title: { type: 'string' },
        tagline: { type: 'string' },
        voice: { type: 'string' },
        websiteUrl: { type: 'string' },
        signatureLayout: { type: 'string', enum: ['avatar-left', 'avatar-center', 'text-only'] },
        signatureLinks: { type: 'array' },
        unsubscribePrompt: { type: 'string' },
        unsubscribeLabel: { type: 'string' },
      },
    },
  },
  {
    name: 'list_campaigns',
    description: '列出電子報，可依狀態或關鍵字篩選',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        search: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        folderId: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: 'get_campaign',
    description: '讀取單篇電子報（含開信／點擊）',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'create_campaign',
    description: '建立草稿。內文可用 bodyHtml 或 bodyMarkdown',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subject: { type: 'string' },
        preheader: { type: 'string' },
        bodyHtml: { type: 'string' },
        bodyMarkdown: { type: 'string' },
        audienceTags: { type: 'array', items: { type: 'string' } },
        audienceFolderId: { type: 'string' },
        folderId: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_campaign',
    description: '更新尚未寄出的電子報',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        subject: { type: 'string' },
        preheader: { type: 'string' },
        bodyHtml: { type: 'string' },
        bodyMarkdown: { type: 'string' },
        audienceTags: { type: 'array', items: { type: 'string' } },
        audienceFolderId: { type: 'string' },
        folderId: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'schedule_campaign',
    description: '排程寄送，scheduledAt 為 ISO 時間',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, scheduledAt: { type: 'string' } },
      required: ['id', 'scheduledAt'],
    },
  },
  {
    name: 'send_campaign',
    description: '立刻開始寄送（背景執行）',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'copy_campaign',
    description: '把一封電子報複製成新草稿。狀態、排程與追蹤不會帶過去。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_subscribers',
    description: '查詢名單',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        status: { type: 'string' },
        tag: { type: 'string' },
        folderId: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: 'list_folders',
    description: '列出分類資料夾。kind 為 subscribers 或 campaigns',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: [...FOLDER_KINDS] } },
    },
  },
  {
    name: 'create_folder',
    description: '新增分類資料夾',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: [...FOLDER_KINDS] },
      },
      required: ['name'],
    },
  },
  {
    name: 'subscribe',
    description: '新增或重新訂閱一位讀者',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        name: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        source: { type: 'string' },
      },
      required: ['email'],
    },
  },
  {
    name: 'import_subscribers',
    description: '匯入名單。傳 csv 文字，或 fileBase64 加上 fileName（CSV 或 Excel）。folderId 是沒指定資料夾時的預設分類。',
    inputSchema: {
      type: 'object',
      properties: {
        csv: { type: 'string' },
        fileBase64: { type: 'string' },
        fileName: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        folderId: { type: 'string' },
      },
    },
  },
  {
    name: 'update_subscriber',
    description: '更新一位讀者的 Email、名稱、狀態、標籤或資料夾',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
        name: { type: 'string' },
        status: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        folderId: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_subscriber',
    description: '從名單刪除一位讀者',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_sequences',
    description: '列出自動化序列（含步驟）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_sequence',
    description: '讀取一條自動化序列',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'get_integrations',
    description: '讀取寄信與 AI 設定。只回有沒有填金鑰，不會回傳金鑰本身。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_email_integration',
    description: '更新寄信管道。空白的金鑰欄位會保留原值。',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        from: { type: 'string' },
        replyTo: { type: 'string' },
        apiKey: { type: 'string' },
        apiExtra: { type: 'string' },
        webhookUrl: { type: 'string' },
        webhookSecret: { type: 'string' },
        resendApiKey: { type: 'string' },
        zeaburEndpoint: { type: 'string' },
        zeaburToken: { type: 'string' },
        insforgeUrl: { type: 'string' },
        insforgeApiKey: { type: 'string' },
      },
      required: ['provider', 'from'],
    },
  },
  {
    name: 'update_ai_integration',
    description: '更新 AI 服務。空白的金鑰欄位會保留原值。',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        apiKey: { type: 'string' },
        model: { type: 'string' },
        baseUrl: { type: 'string' },
      },
      required: ['provider'],
    },
  },
  {
    name: 'verify_email',
    description: '檢查目前寄信 adapter 是否可用',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'verify_ai',
    description: '檢查目前 AI 是否已接上',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'upload_image',
    description: '上傳電子報圖片。fileBase64 可含 data URL 前綴。',
    inputSchema: {
      type: 'object',
      properties: { fileBase64: { type: 'string' } },
      required: ['fileBase64'],
    },
  },
  {
    name: 'draft_campaign',
    description: '請 AI 依 brief 產出電子報草稿建議。不會建立或寄出。',
    inputSchema: {
      type: 'object',
      properties: { brief: { type: 'string' } },
    },
  },
  {
    name: 'rewrite_selection',
    description: '請 AI 改寫一段 HTML。只回建議，不會寫進電子報。',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string' },
        instruction: { type: 'string' },
      },
      required: ['html', 'instruction'],
    },
  },
  {
    name: 'suggest_subjects',
    description: '請 AI 依正文給主旨與前導文字建議。不會寫進電子報。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        bodyHtml: { type: 'string' },
      },
      required: ['bodyHtml'],
    },
  },
  {
    name: 'organize_subscribers',
    description: '請 AI 建議這些讀者的標籤與資料夾。不會直接改名單。',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
      required: ['ids'],
    },
  },
  {
    name: 'organize_campaigns',
    description: '請 AI 建議這些電子報的資料夾。不會直接改分類。',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
      required: ['ids'],
    },
  },
  {
    name: 'filter_list',
    description: '請 AI 把一句話轉成名單、電子報或受眾篩選。scope 為 subscribers、campaigns 或 audience。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['subscribers', 'campaigns', 'audience'] },
        prompt: { type: 'string' },
      },
      required: ['scope', 'prompt'],
    },
  },
  {
    name: 'draft_automation',
    description: '請 AI 依 goal 草擬自動化。不會建立序列，也不會啟用。',
    inputSchema: {
      type: 'object',
      properties: { goal: { type: 'string' } },
    },
  },
  {
    name: 'apply_automation',
    description: '套用自動化建議：建立草稿與一條停用的序列。不會寄信，也不會啟用。輸入用 draft_automation 的回傳。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        trigger: { type: 'string' },
        triggerValue: { type: 'string' },
        steps: { type: 'array' },
      },
      required: ['name', 'trigger', 'steps'],
    },
  },
  {
    name: 'export_subscribers',
    description: '匯出名單 CSV',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_subscriber_tags',
    description: '列出名單裡出現過的標籤',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_subscriber',
    description: '後台手動新增讀者。預設已訂閱，並會加入目前已啟用的自動化。',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        name: { type: 'string' },
        status: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        folderId: { type: 'string' },
        source: { type: 'string' },
      },
      required: ['email'],
    },
  },
  {
    name: 'update_folder',
    description: '重新命名資料夾。kind 為 subscribers 或 campaigns，要和資料夾種類一致。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string', enum: [...FOLDER_KINDS] },
      },
      required: ['id', 'name'],
    },
  },
  {
    name: 'delete_folder',
    description: '刪除資料夾。kind 為 subscribers 或 campaigns，要和資料夾種類一致。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string', enum: [...FOLDER_KINDS] },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_campaign',
    description: '刪除一封電子報',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'preview_campaign',
    description: '預覽一封電子報。可帶尚未存檔的 subject、preheader、bodyHtml、bodyMarkdown 或受眾。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        subject: { type: 'string' },
        preheader: { type: 'string' },
        bodyHtml: { type: 'string' },
        bodyMarkdown: { type: 'string' },
        audienceTags: { type: 'array', items: { type: 'string' } },
        audienceFolderId: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'send_test_email',
    description: '寄測試信到指定地址，不寫入寄送紀錄、也不改名單。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['id', 'email'],
    },
  },
  {
    name: 'unschedule_campaign',
    description: '取消已排程的電子報，回到草稿',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'cancel_campaign',
    description: '中止寄送中的電子報',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'get_campaign_stats',
    description: '讀取一封電子報的寄送與開信／點擊數字',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_deliveries',
    description: '列出一封電子報的寄送紀錄',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'bulk_campaigns',
    description: '一次處理多封電子報。action 為 delete 或 folder，最多 100 封。folder 時用 folderId，空字串代表未分類。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        action: { type: 'string', enum: ['delete', 'folder'] },
        folderId: { type: 'string' },
      },
      required: ['ids', 'action'],
    },
  },
  {
    name: 'save_campaign_template',
    description: '把一封電子報存成自訂建立模板',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        title: { type: 'string' },
        preheader: { type: 'string' },
        bodyHtml: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_sequence',
    description: '新增自動化。enabled 省略時為啟用；要停用請明確傳 false。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        trigger: { type: 'string' },
        triggerValue: { type: 'string' },
        enabled: { type: 'boolean' },
        steps: { type: 'array' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_sequence',
    description: '更新自動化的名稱、觸發、步驟或啟用狀態',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        trigger: { type: 'string' },
        triggerValue: { type: 'string' },
        enabled: { type: 'boolean' },
        steps: { type: 'array' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_sequence',
    description: '刪除一條自動化',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'copy_sequence',
    description: '複製自動化。副本預設停用，不帶走進行中的人，也不會重新啟用來源。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_enrollments',
    description: '列出一條自動化裡進行中的人',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_campaign_templates',
    description: '列出建立電子報時可用的模板（內建與自訂）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_campaign_template',
    description: '讀取一份電子報建立模板',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'create_campaign_template',
    description: '新增自訂的電子報建立模板',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        title: { type: 'string' },
        preheader: { type: 'string' },
        bodyHtml: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_campaign_template',
    description: '更新自訂電子報模板。內建模板要先複製。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        title: { type: 'string' },
        preheader: { type: 'string' },
        bodyHtml: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_campaign_template',
    description: '刪除自訂電子報模板。內建模板不能刪。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'copy_campaign_template',
    description: '複製內建或自訂電子報模板成一份新的自訂模板',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_templates',
    description: '列出可重用內容區塊。名稱可用 / 分組。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_template',
    description: '新增可重用內容區塊',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        html: { type: 'string' },
      },
      required: ['name', 'html'],
    },
  },
  {
    name: 'update_template',
    description: '更新可重用內容區塊',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        html: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_template',
    description: '刪除可重用內容區塊',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
];

function folderKind(value: unknown): FolderKind {
  return value === 'campaigns' ? 'campaigns' : 'subscribers';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function campaignIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function folderOfKind(ctx: ServiceContext, id: string, kind: FolderKind) {
  const folder = await ctx.store.getFolder(id);
  if (!folder || folder.kind !== kind) throw badRequest('找不到這個資料夾');
  return folder;
}

async function previewDraft(ctx: ServiceContext, id: string, body: Record<string, unknown>) {
  const saved = await getCampaign(ctx, id);
  const draft: Campaign = {
    ...saved,
    subject: typeof body.subject === 'string' && body.subject ? body.subject : saved.subject,
    preheader: typeof body.preheader === 'string' ? body.preheader : saved.preheader,
    bodyMarkdown: typeof body.bodyMarkdown === 'string' ? body.bodyMarkdown : saved.bodyMarkdown,
    bodyHtml: typeof body.bodyHtml === 'string' ? body.bodyHtml : saved.bodyHtml,
    audienceTags: body.audienceTags === undefined ? saved.audienceTags : normalizeTags(body.audienceTags),
    audienceFolderId:
      body.audienceFolderId === undefined
        ? saved.audienceFolderId
        : typeof body.audienceFolderId === 'string' && body.audienceFolderId
          ? body.audienceFolderId
          : undefined,
  };
  const rendered = await renderCampaign(ctx, draft, PREVIEW_RECIPIENT);
  const audience = await ctx.store.listAudience(audienceFromCampaign(draft));
  return { ...rendered, audienceCount: audience.length };
}

async function importFromArgs(ctx: ServiceContext, args: Record<string, unknown>) {
  let csv = typeof args.csv === 'string' ? args.csv : '';
  const fileName = typeof args.fileName === 'string' ? args.fileName : '';
  const fileBase64 = typeof args.fileBase64 === 'string' ? args.fileBase64 : '';
  if (fileBase64) csv = spreadsheetToCsv(decodeImportFile(fileBase64), fileName || 'import.csv');
  if (csv.trim() === '') throw badRequest('請選擇 CSV 或 Excel 檔案');
  return importSubscribersCsv(
    ctx,
    csv,
    normalizeTags(args.tags),
    typeof args.folderId === 'string' ? args.folderId : undefined,
  );
}

export async function callTool(
  ctx: ServiceContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'get_session':
      return publicSession(ctx);
    case 'get_overview': {
      const from = text(args.from);
      const to = text(args.to);
      const counts = await ctx.store.countSubscribersByStatus();
      const recent = await listCampaigns(ctx, { limit: 10 });
      const sample = await ctx.store.listSubscribers({ limit: 500 });
      const tags = [...new Set(sample.items.flatMap((person) => person.tags))].sort().slice(0, 50);
      const folders = await listFolders(ctx);
      const rates = await overviewRates(ctx, { from, to });
      return { counts, campaigns: recent.items, provider: ctx.adapter.name, tags, folders, rates };
    }
    case 'get_brand':
      return getBrand(ctx);
    case 'update_brand':
      return updateBrand(ctx, args);
    case 'list_campaigns':
      return listCampaigns(ctx, {
        status: typeof args.status === 'string' ? (args.status as CampaignStatus) : undefined,
        search: typeof args.search === 'string' ? args.search : undefined,
        from: text(args.from),
        to: text(args.to),
        folderId: typeof args.folderId === 'string' ? args.folderId : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 20,
        offset: typeof args.offset === 'number' ? args.offset : undefined,
      });
    case 'get_campaign':
      return getCampaign(ctx, String(args.id ?? ''));
    case 'create_campaign':
      return createCampaign(ctx, args);
    case 'update_campaign': {
      const { id, ...rest } = args;
      return updateCampaign(ctx, String(id ?? ''), rest);
    }
    case 'schedule_campaign':
      return scheduleCampaign(ctx, String(args.id ?? ''), args.scheduledAt);
    case 'send_campaign':
      return startCampaign(ctx, String(args.id ?? ''), { background: true });
    case 'copy_campaign':
      return copyCampaign(ctx, String(args.id ?? ''));
    case 'list_subscribers':
      return listSubscribers(ctx, {
        search: typeof args.search === 'string' ? args.search : undefined,
        status: typeof args.status === 'string' ? (args.status as never) : undefined,
        tag: typeof args.tag === 'string' ? args.tag : undefined,
        folderId: typeof args.folderId === 'string' ? args.folderId : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 50,
        offset: typeof args.offset === 'number' ? args.offset : undefined,
      });
    case 'list_folders': {
      const kind = folderKind(args.kind);
      const [items, counts] = await Promise.all([
        listFolders(ctx, kind),
        kind === 'campaigns' ? ctx.store.countCampaignsByFolder() : ctx.store.countSubscribersByFolder(),
      ]);
      return {
        items: items.map((folder) => ({ ...folder, count: counts[folder.id] ?? 0 })),
        unfiled: counts[''] ?? 0,
        total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      };
    }
    case 'create_folder':
      return createFolder(ctx, { name: args.name }, folderKind(args.kind));
    case 'subscribe':
      return subscribe(ctx, { email: args.email, name: args.name, tags: args.tags, source: args.source });
    case 'import_subscribers':
      return importFromArgs(ctx, args);
    case 'update_subscriber': {
      const { id, ...rest } = args;
      return updateSubscriber(ctx, String(id ?? ''), rest);
    }
    case 'delete_subscriber':
      await deleteSubscriber(ctx, String(args.id ?? ''));
      return { ok: true };
    case 'list_sequences':
      return { items: await listSequencesWithSteps(ctx) };
    case 'get_sequence':
      return getSequenceWithSteps(ctx, String(args.id ?? ''));
    case 'get_integrations':
      return integrationView(ctx);
    case 'update_email_integration':
      return updateEmailIntegration(ctx, args);
    case 'update_ai_integration':
      return updateAiIntegration(ctx, args);
    case 'verify_email': {
      const result = await ctx.adapter.verify();
      return { ...result, provider: ctx.adapter.name, available: listEmailAdapters() };
    }
    case 'verify_ai': {
      if (!ctx.ai) {
        return { ok: false, message: '尚未接上 AI', provider: ctx.config.ai.provider, model: null };
      }
      const result = await ctx.ai.verify();
      return { ...result, provider: ctx.ai.name, model: ctx.ai.model };
    }
    case 'upload_image': {
      const fileBase64 = typeof args.fileBase64 === 'string' ? args.fileBase64 : '';
      if (!fileBase64.trim()) throw badRequest('請選擇圖片');
      return saveCampaignImage(
        { driver: ctx.config.store.driver, uploadsPath: ctx.config.uploadsPath },
        fileBase64,
      );
    }
    case 'draft_campaign':
      return draftCampaign(ctx, args);
    case 'rewrite_selection':
      return rewriteSelection(ctx, args);
    case 'suggest_subjects':
      return suggestSubjects(ctx, args);
    case 'organize_subscribers':
      return organizeSubscribers(ctx, args);
    case 'organize_campaigns':
      return organizeCampaigns(ctx, args);
    case 'filter_list':
      return interpretFilter(ctx, args);
    case 'draft_automation':
      return draftAutomation(ctx, args);
    case 'apply_automation':
      return applyAutomation(ctx, args);
    case 'export_subscribers':
      return { csv: await exportSubscribersCsv(ctx) };
    case 'list_subscriber_tags':
      return { items: await listSubscriberTags(ctx) };
    case 'create_subscriber':
      return createSubscriber(ctx, {
        email: args.email,
        name: args.name,
        status: args.status,
        tags: args.tags,
        folderId: args.folderId,
        source: args.source,
      });
    case 'update_folder': {
      const folder = await folderOfKind(ctx, String(args.id ?? ''), folderKind(args.kind));
      return updateFolder(ctx, folder.id, { name: args.name });
    }
    case 'delete_folder': {
      const folder = await folderOfKind(ctx, String(args.id ?? ''), folderKind(args.kind));
      await deleteFolder(ctx, folder.id);
      return { ok: true };
    }
    case 'delete_campaign':
      await deleteCampaign(ctx, String(args.id ?? ''));
      return { ok: true };
    case 'preview_campaign':
      return previewDraft(ctx, String(args.id ?? ''), args);
    case 'send_test_email': {
      const email = normalizeEmail(args.email);
      const result = await sendTestEmail(ctx, String(args.id ?? ''), email);
      if (!result.ok) throw badRequest(result.message);
      return result;
    }
    case 'unschedule_campaign':
      return cancelSchedule(ctx, String(args.id ?? ''));
    case 'cancel_campaign':
      return cancelSending(ctx, String(args.id ?? ''));
    case 'get_campaign_stats': {
      const campaign = await getCampaign(ctx, String(args.id ?? ''));
      return { stats: campaign.stats, tracking: campaign.tracking };
    }
    case 'list_deliveries': {
      const id = String(args.id ?? '');
      const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 2000) : 200;
      return {
        items: await ctx.store.listDeliveries(id, { limit }),
        stats: await ctx.store.deliveryStats(id),
      };
    }
    case 'bulk_campaigns': {
      const ids = campaignIds(args.ids);
      if (ids.length === 0) throw badRequest('請先選電子報');
      if (ids.length > 100) throw badRequest('一次最多處理 100 封');
      if (args.action === 'delete') return bulkDeleteCampaigns(ctx, ids);
      if (args.action === 'folder') {
        return { items: await bulkSetCampaignFolder(ctx, ids, args.folderId ?? '') };
      }
      throw badRequest('不支援這個動作');
    }
    case 'save_campaign_template': {
      const { id, ...rest } = args;
      return createCampaignStarterFromCampaign(ctx, String(id ?? ''), rest);
    }
    case 'create_sequence':
      return createSequence(ctx, args);
    case 'update_sequence': {
      const { id, ...rest } = args;
      return updateSequence(ctx, String(id ?? ''), rest);
    }
    case 'delete_sequence':
      await deleteSequence(ctx, String(args.id ?? ''));
      return { ok: true };
    case 'copy_sequence':
      return copySequence(ctx, String(args.id ?? ''));
    case 'list_enrollments':
      return { items: await ctx.store.listEnrollments(String(args.id ?? '')) };
    case 'list_campaign_templates':
      return { items: await listCampaignStarters(ctx) };
    case 'get_campaign_template':
      return getCampaignStarter(ctx, String(args.id ?? ''));
    case 'create_campaign_template':
      return createCampaignStarter(ctx, args);
    case 'update_campaign_template': {
      const { id, ...rest } = args;
      return updateCampaignStarter(ctx, String(id ?? ''), rest);
    }
    case 'delete_campaign_template':
      await deleteCampaignStarter(ctx, String(args.id ?? ''));
      return { ok: true };
    case 'copy_campaign_template':
      return copyCampaignStarter(ctx, String(args.id ?? ''));
    case 'list_templates':
      return { items: await listTemplates(ctx) };
    case 'create_template':
      return createTemplate(ctx, args);
    case 'update_template': {
      const { id, ...rest } = args;
      return updateTemplate(ctx, String(id ?? ''), rest);
    }
    case 'delete_template':
      await deleteTemplate(ctx, String(args.id ?? ''));
      return { ok: true };
    default:
      throw Object.assign(new Error(`未知的工具：${name}`), { rpcCode: -32601 });
  }
}
