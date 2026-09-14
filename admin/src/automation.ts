export type TriggerKind = 'subscribe' | 'tag' | 'folder' | 'event' | 'unsubscribe' | 'open' | 'click';
export type FlowKind = 'trigger' | 'wait' | 'send' | 'exit';

export interface FlowNode {
  id: string;
  kind: FlowKind;
  trigger?: TriggerKind;
  triggerValue?: string;
  days?: number;
  campaignId?: string;
}

export interface SequenceLike {
  trigger: TriggerKind;
  triggerValue?: string;
  steps: { id?: string; delayDays: number; campaignId: string }[];
}

export interface SequencePayload {
  trigger: TriggerKind;
  triggerValue?: string;
  steps: { delayDays: number; campaignId: string }[];
}

export const TRIGGER_META: Record<TriggerKind, { label: string; hint: string; needsValue: boolean; valueLabel: string }> =
  {
    subscribe: { label: '新訂閱', hint: '有人確認訂閱時開始', needsValue: false, valueLabel: '' },
    unsubscribe: { label: '退訂', hint: '有人退訂時開始', needsValue: false, valueLabel: '' },
    folder: { label: '加入資料夾', hint: '有人被放進指定資料夾時開始', needsValue: true, valueLabel: '資料夾' },
    tag: { label: '帶上標籤', hint: '有人被加上指定標籤時開始', needsValue: true, valueLabel: '標籤名稱' },
    open: { label: '開信', hint: '有人打開一封電子報時開始', needsValue: false, valueLabel: '電子報' },
    click: { label: '點擊連結', hint: '有人點信裡的連結時開始', needsValue: false, valueLabel: '電子報' },
    event: { label: 'Webhook', hint: '收到指定 webhook 時開始', needsValue: true, valueLabel: 'Webhook 名稱' },
  };

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  trigger: TriggerKind;
  nodes: FlowNode[];
}

function node(kind: FlowKind, extra: Partial<FlowNode> = {}): FlowNode {
  return { id: extra.id ?? newNodeId(), kind, ...extra };
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'welcome',
    name: '歡迎信',
    description: '新訂閱後立刻寄一封，隔兩天再跟進一封。',
    trigger: 'subscribe',
    nodes: [
      node('trigger', { id: 'trigger', trigger: 'subscribe' }),
      node('send', { campaignId: '' }),
      node('wait', { days: 2 }),
      node('send', { campaignId: '' }),
      node('exit', { id: 'exit' }),
    ],
  },
  {
    id: 'drip',
    name: '三封跟進',
    description: '新訂閱後分三封寄：當天、第 3 天、第 7 天。',
    trigger: 'subscribe',
    nodes: [
      node('trigger', { id: 'trigger', trigger: 'subscribe' }),
      node('send', { campaignId: '' }),
      node('wait', { days: 3 }),
      node('send', { campaignId: '' }),
      node('wait', { days: 4 }),
      node('send', { campaignId: '' }),
      node('exit', { id: 'exit' }),
    ],
  },
  {
    id: 'folder',
    name: '加入資料夾',
    description: '有人被放進指定資料夾時，寄出對應內容。',
    trigger: 'folder',
    nodes: [
      node('trigger', { id: 'trigger', trigger: 'folder' }),
      node('send', { campaignId: '' }),
      node('exit', { id: 'exit' }),
    ],
  },
  {
    id: 'tag',
    name: '帶上標籤',
    description: '有人被加上指定標籤時，寄出對應內容。',
    trigger: 'tag',
    nodes: [
      node('trigger', { id: 'trigger', trigger: 'tag' }),
      node('send', { campaignId: '' }),
      node('exit', { id: 'exit' }),
    ],
  },
  {
    id: 'event',
    name: 'Webhook',
    description: '收到指定 webhook 後，依時間軸寄信。',
    trigger: 'event',
    nodes: [
      node('trigger', { id: 'trigger', trigger: 'event' }),
      node('send', { campaignId: '' }),
      node('exit', { id: 'exit' }),
    ],
  },
  {
    id: 'open',
    name: '開信後跟進',
    description: '有人打開指定電子報後，再寄一封跟進。',
    trigger: 'open',
    nodes: [
      node('trigger', { id: 'trigger', trigger: 'open' }),
      node('send', { campaignId: '' }),
      node('exit', { id: 'exit' }),
    ],
  },
  {
    id: 'click',
    name: '點擊後跟進',
    description: '有人點信裡的連結後，再寄一封跟進。',
    trigger: 'click',
    nodes: [
      node('trigger', { id: 'trigger', trigger: 'click' }),
      node('send', { campaignId: '' }),
      node('exit', { id: 'exit' }),
    ],
  },
  {
    id: 'unsubscribe',
    name: '退訂',
    description: '有人退訂時開始。',
    trigger: 'unsubscribe',
    nodes: [
      node('trigger', { id: 'trigger', trigger: 'unsubscribe' }),
      node('send', { campaignId: '' }),
      node('exit', { id: 'exit' }),
    ],
  },
  {
    id: 'blank',
    name: '空白自動化',
    description: '從空白時間軸開始，自己拖拉觸發與步驟。',
    trigger: 'subscribe',
    nodes: [node('trigger', { id: 'trigger', trigger: 'subscribe' }), node('exit', { id: 'exit' })],
  },
];

export function newNodeId(): string {
  return `nd_${Math.random().toString(36).slice(2, 10)}`;
}

export function cloneTemplateNodes(template: AutomationTemplate, triggerValue = ''): FlowNode[] {
  return template.nodes.map((item) => ({
    ...item,
    id: item.kind === 'trigger' ? 'trigger' : item.kind === 'exit' ? 'exit' : newNodeId(),
    triggerValue: item.kind === 'trigger' ? triggerValue : item.triggerValue,
  }));
}

export function nodesFromSequence(sequence: SequenceLike): FlowNode[] {
  const nodes: FlowNode[] = [
    {
      id: 'trigger',
      kind: 'trigger',
      trigger: sequence.trigger,
      triggerValue: sequence.triggerValue ?? '',
    },
  ];
  let previous = 0;
  for (const step of sequence.steps) {
    const wait = Math.max(0, step.delayDays - previous);
    if (wait > 0) nodes.push({ id: newNodeId(), kind: 'wait', days: wait });
    nodes.push({ id: step.id ?? newNodeId(), kind: 'send', campaignId: step.campaignId });
    previous = step.delayDays;
  }
  nodes.push({ id: 'exit', kind: 'exit' });
  return nodes;
}

export function sequencePayloadFromNodes(nodes: FlowNode[]): SequencePayload {
  const triggerNode = nodes.find((item) => item.kind === 'trigger');
  const trigger = triggerNode?.trigger ?? 'subscribe';
  let accumulated = 0;
  const steps: SequencePayload['steps'] = [];
  for (const item of nodes) {
    if (item.kind === 'wait') accumulated += Math.max(0, Math.floor(item.days ?? 0));
    if (item.kind === 'send') {
      steps.push({ delayDays: accumulated, campaignId: item.campaignId?.trim() ?? '' });
    }
  }
  return {
    trigger,
    triggerValue:
      trigger === 'subscribe' || trigger === 'unsubscribe'
        ? undefined
        : triggerNode?.triggerValue?.trim() || undefined,
    steps,
  };
}

export function hasSendableStep(nodes: FlowNode[]): boolean {
  const sends = nodes.filter((item) => item.kind === 'send');
  return sends.length > 0 && sends.every((item) => Boolean(item.campaignId?.trim()));
}

export function nodeLabel(node: FlowNode): string {
  if (node.kind === 'trigger') return TRIGGER_META[node.trigger ?? 'subscribe'].label;
  if (node.kind === 'wait') return `等待 ${node.days ?? 1} 天`;
  if (node.kind === 'send') return '寄出電子報';
  return '結束';
}

export function cloneFlowNode(node: FlowNode): FlowNode {
  return { ...node, id: node.kind === 'exit' ? 'exit' : newNodeId() };
}
