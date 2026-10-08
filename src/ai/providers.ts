export interface AiService {
  id: string;
  label: string;
  protocol: 'none' | 'openai' | 'anthropic' | 'systemone';
  /** 下拉分組。關閉不進群組。 */
  group?: 'common' | 'more' | 'local';
  baseUrl?: string;
  defaultModel?: string;
  /** 本機服務，位址可以改。 */
  editableBaseUrl?: boolean;
  /** 沒有金鑰也能用，例如本機 Ollama。 */
  optionalKey?: boolean;
  /** 金鑰前綴。有填才會自動判斷，愈具體的愈能對上。 */
  keyPrefix?: string;
}

export const AI_SERVICES: readonly AiService[] = [
  { id: 'none', label: '關閉', protocol: 'none' },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    group: 'common',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyPrefix: '^sk-proj-',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    group: 'common',
    defaultModel: 'claude-3-5-haiku-latest',
    keyPrefix: '^sk-ant-',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    protocol: 'openai',
    group: 'common',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    keyPrefix: '^AIza',
  },
  {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai',
    group: 'common',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyPrefix: '^gsk_',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    protocol: 'openai',
    group: 'common',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    group: 'common',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    keyPrefix: '^sk-or-',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    group: 'common',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'xai',
    label: 'xAI',
    protocol: 'openai',
    group: 'common',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-3',
    keyPrefix: '^xai-',
  },
  {
    id: 'jev',
    label: 'Jev',
    protocol: 'systemone',
    group: 'common',
    baseUrl: 'https://api.typesafe.ai',
    defaultModel: 'jev-latest',
  },
  {
    id: 'together',
    label: 'Together',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://api.perplexity.ai',
    defaultModel: 'sonar',
    keyPrefix: '^pplx-',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://api.cohere.com/compatibility/v1',
    defaultModel: 'command-r-plus',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama-3.3-70b',
  },
  {
    id: 'sambanova',
    label: 'SambaNova',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://api.sambanova.ai/v1',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
  },
  {
    id: 'github',
    label: 'GitHub Models',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://models.inference.ai.azure.com',
    defaultModel: 'gpt-4o-mini',
    keyPrefix: '^(github_pat_|ghp_)',
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'moonshot-v1-8k',
  },
  {
    id: 'qwen',
    label: 'Qwen',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
  },
  {
    id: 'zhipu',
    label: '智譜',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.1-8b-instruct',
    keyPrefix: '^nvapi-',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M2',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    protocol: 'openai',
    group: 'more',
    baseUrl: 'https://router.huggingface.co/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    protocol: 'openai',
    group: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3.2',
    editableBaseUrl: true,
    optionalKey: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    protocol: 'openai',
    group: 'local',
    baseUrl: 'http://127.0.0.1:1234/v1',
    editableBaseUrl: true,
    optionalKey: true,
  },
];

export function getAiService(id: string): AiService | undefined {
  return AI_SERVICES.find((service) => service.id === id);
}

export function aiServiceLabel(id: string): string {
  return getAiService(id)?.label ?? id;
}

/** `compatible` 只留給舊的環境變數，設定頁不再提供。 */
export function isKnownAiProvider(id: string): boolean {
  return id === 'compatible' || Boolean(getAiService(id));
}

export function detectAiProvider(apiKey: string): string | null {
  const key = apiKey.trim();
  if (!key) return null;
  for (const service of AI_SERVICES) {
    if (service.keyPrefix && new RegExp(service.keyPrefix).test(key)) return service.id;
  }
  return null;
}

export function aiChoices() {
  return AI_SERVICES.map((service) => ({
    id: service.id,
    label: service.label,
    group: service.group ?? '',
    defaultModel: service.defaultModel ?? '',
    baseUrl: service.baseUrl ?? '',
    editableBaseUrl: Boolean(service.editableBaseUrl),
    keyPrefix: service.keyPrefix ?? '',
  }));
}
