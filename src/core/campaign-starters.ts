import { emailHero, emailImageSlot } from './email-image.js';

export interface CampaignStarterDraft {
  id: string;
  name: string;
  description: string;
  title: string;
  preheader: string;
  bodyHtml: string;
}

const button = (href: string, label: string) =>
  `<div data-email-btn data-href="${href}" data-label="${label}" data-bg="#1c1917" data-border="0" data-border-color="#1c1917" data-radius="8">${label}</div>`;

const withSignature = (html: string): string => `${html}{{signature}}`;

export const BUILTIN_CAMPAIGN_STARTERS: CampaignStarterDraft[] = [
  {
    id: 'weekly',
    name: '每週精選',
    description: '週報用：一件觀察、一件推薦、一件近況。',
    title: '這週想告訴你的三件事',
    preheader: '一件觀察、一件推薦、一件我正在做的事',
    bodyHtml: withSignature(
      [
        emailHero(
          'https://images.unsplash.com/photo-1481627834876-b7833e8f5570?auto=format&fit=crop&w=1400&q=80',
          '攤開的書，作為這週封面',
        ),
        '<p>嗨 {{name}}，</p>',
        '<p>這週想寄三件事給你。</p>',
        '<h2>這週的觀察</h2>',
        '<p>創作最容易被忽略的，往往不是靈感，而是願意把同一件事看第二次的耐心。</p>',
        '<h2>想推薦你的</h2>',
        emailImageSlot('建議置入這件作品的圖片'),
        '<p>這週重看了一篇文字／一本書／一部作品。它沒有急著給答案，卻把問題寫得很乾淨。如果你最近也卡在表達上，值得坐下來看完。</p>',
        '<h2>我正在做的</h2>',
        '<p>我這週把時間留給下一件作品。還沒到能公開的程度，不過方向比上週清楚。</p>',
        '<p>下週見。</p>',
      ].join(''),
    ),
  },
  {
    id: 'welcome',
    name: '歡迎信',
    description: '剛訂閱時的第一封信，說明之後會收到什麼。',
    title: '先從這封信開始',
    preheader: '之後的信會寄到這個信箱',
    bodyHtml: withSignature(
      [
        emailHero(
          'https://images.unsplash.com/photo-1501004318641-b39e6451bec6?auto=format&fit=crop&w=1400&q=80',
          '窗邊的綠葉，作為歡迎信封面',
        ),
        '<p>嗨 {{name}}，</p>',
        '<p>謝謝你留下信箱。之後有新的文字、作品或活動，我會寫信到這裡。</p>',
        emailImageSlot('建議置入一張你的照片或工作室'),
        '<p>這封信之後，你大概會收到：</p>',
        '<ul>',
        '<li>我正在想、正在做的事</li>',
        '<li>偶爾的推薦，或值得參加的活動</li>',
        '<li>新作品公開時，第一手通知</li>',
        '</ul>',
        '<p>想先認識我的話，可以從這篇開始。</p>',
        button('https://example.com', '從這篇開始'),
        '<p>有話想說，直接回這封信就好。我會自己看。</p>',
      ].join(''),
    ),
  },
  {
    id: 'announcement',
    name: '活動邀請',
    description: '講座、工作坊、展覽或直播，把時間與怎麼參加寫清楚。',
    title: '想邀請你來參加',
    preheader: '時間、地點，以及怎麼報名',
    bodyHtml: withSignature(
      [
        emailHero(
          'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1400&q=80',
          '活動現場的座位與燈光',
        ),
        '<p>嗨 {{name}}，</p>',
        '<p>我想邀請你來參加一場活動。</p>',
        '<h2>活動名稱</h2>',
        emailImageSlot('建議置入活動主視覺'),
        '<p>這是一場給創作者的工作坊，談怎麼把一件作品講清楚，並讓它被看見。</p>',
        '<ul>',
        '<li>時間：日期與時段</li>',
        '<li>地點：線上連結，或實體地址</li>',
        '<li>適合：正在寫、拍、畫，或剛開始公開作品的人</li>',
        '</ul>',
        '<p>你不需要準備作品集。帶著最近卡關的問題來就好。</p>',
        button('https://example.com', '查看詳情並報名'),
        '<p>名額有限，報名截止前都還來得及。</p>',
      ].join(''),
    ),
  },
  {
    id: 'work',
    name: '新作品',
    description: '文章、影片、刊物或作品集剛公開時寄出。',
    title: '新作品公開了',
    preheader: '想先讓你看到這一件',
    bodyHtml: withSignature(
      [
        emailHero(
          'https://images.unsplash.com/photo-1460661419201-f4e0ebd93d78?auto=format&fit=crop&w=1400&q=80',
          '工作室裡尚未完成的作品',
        ),
        '<p>嗨 {{name}}，</p>',
        '<p>我剛公開一件新作品，想先寄給你。</p>',
        '<h2>作品名稱</h2>',
        emailImageSlot('建議置入作品圖片'),
        '<p>這次想處理的，是一個我最近一直繞不開的問題。作品不長，但希望你看完會留下一句自己的話。</p>',
        '<ul>',
        '<li>形式：文章、影片、刊物或作品集</li>',
        '<li>大約需要：幾分鐘</li>',
        '</ul>',
        '<p>如果你只有一點時間，先看開頭那一段就夠了。</p>',
        button('https://example.com', '打開作品'),
        '<p>看完有想法，回這封信告訴我。</p>',
      ].join(''),
    ),
  },
  {
    id: 'letter',
    name: '一封信',
    description: '像寫給一個人的長信，只把一件事說完。',
    title: '只想跟你說一件事',
    preheader: '這封信沒有清單',
    bodyHtml: withSignature(
      [
        emailHero(
          'https://images.unsplash.com/photo-1455390582262-044cdead277a?auto=format&fit=crop&w=1400&q=80',
          '正在寫字的桌面',
        ),
        '<p>嗨 {{name}}，</p>',
        '<p>這封信沒有清單，只想把一件事說完。</p>',
        emailImageSlot('建議置入一張跟這件事有關的圖，沒有也可以刪掉'),
        '<p>我最近一直在想：創作者對外說話時，最難的不是找到題目，而是承認自己其實只想把一件事講清楚。</p>',
        '<p>如果你也有過這種感覺，希望這封信能讓你慢下來一點。</p>',
        '<p>想繼續聊的話，回信給我就好。</p>',
      ].join(''),
    ),
  },
];

export const EMPTY_STARTER_BODY = [
  emailImageSlot('建議置入封面'),
  '<p>嗨 {{name}}，</p>',
  '<p>在這裡寫這封信的內容。</p>',
  '{{signature}}',
].join('');

export function isBuiltinStarterId(id: string): boolean {
  return BUILTIN_CAMPAIGN_STARTERS.some((item) => item.id === id);
}
