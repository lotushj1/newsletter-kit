import {
  card,
  kicker,
  lead,
  meta,
  note,
  ornament,
  panel,
  pull,
  recap,
  stepHeading,
  steps,
  tip,
} from './email-block-snippets.js';
import { emailImageSlot } from './email-image.js';

export interface CampaignStarterDraft {
  id: string;
  name: string;
  description: string;
  title: string;
  preheader: string;
  bodyHtml: string;
}

/*
 * 每種模板各有自己的版面骨架與點綴色，區塊都是編輯器存得回去的節點加屬性
 * （見 src/core/email-blocks.ts）。〔〕裡是要換成實際內容的地方。
 * 這是開源專案，範例文字不寫任何特定的人、品牌或領域。
 * 圖片一律用空位標出位置與建議尺寸，不外連圖庫。
 */

const button = (
  href: string,
  label: string,
  look: { bg: string; border?: number; borderColor?: string } = { bg: '#1c1917' },
) =>
  `<div data-email-btn data-href="${href}" data-label="${label}" data-bg="${look.bg}" data-border="${look.border ?? 0}" data-border-color="${look.borderColor ?? look.bg}" data-radius="8">${label}</div>`;

const withSignature = (parts: string[]): string => `${parts.join('')}{{signature}}`;

export const BUILTIN_CAMPAIGN_STARTERS: CampaignStarterDraft[] = [
  {
    id: 'weekly',
    name: '每週精選',
    description: '週報用：一個觀察、一個推薦、一則近況，分段編號、快速讀完。',
    title: '這週想告訴你的三件事',
    preheader: '一個觀察、一個推薦，和我最近在做的事',
    bodyHtml: withSignature([
      kicker('每週精選　第〔N〕期', 'sage'),
      '<h1>這週的主題，寫成一句話</h1>',
      '<p>嗨 {{name}}，這週整理了三件事：一個觀察、一個值得花時間的推薦，還有我手上正在做的事。大約三分鐘可以讀完。</p>',
      '<hr>',
      kicker('01　觀察', 'sage'),
      '<h2>觀察的標題</h2>',
      emailImageSlot('觀察配圖｜建議 1040×585'),
      '<p>寫下這週注意到的一件事，可以是一個現象、一次經驗或一個數字背後的原因。先描述你看到什麼，再說你怎麼想。</p>',
      '<p>如果只想讓讀者記住一句話，把那句<strong>加粗</strong>。</p>',
      '<hr>',
      kicker('02　推薦', 'sage'),
      '<h2>這週值得花時間看的</h2>',
      card(
        [
          emailImageSlot('推薦縮圖｜建議 600×600'),
          '<h3>書、文章、工具或作品名稱</h3>',
          '<p>用兩三句話說它好在哪裡、適合誰。</p>',
          '<p><a href="https://example.com">前往查看 →</a></p>',
        ],
        'sage',
      ),
      '<hr>',
      kicker('03　近況', 'sage'),
      '<h2>我最近在做的事</h2>',
      '<p>簡短交代手上的進度：正在做什麼、卡在哪裡、下一步是什麼。不用寫成成果報告。</p>',
      note('下週同一時間見。這三件裡如果有哪一件讓你有想法，直接回信告訴我。'),
    ]),
  },
  {
    id: 'welcome',
    name: '歡迎信',
    description: '剛訂閱時的第一封信：自我介紹、之後會收到什麼、從哪裡開始。',
    title: '歡迎你，先從這封信開始',
    preheader: '之後會收到什麼，以及可以從哪裡開始讀',
    bodyHtml: withSignature([
      emailImageSlot('封面：個人照、團隊或品牌照片｜建議 1200×600'),
      kicker('歡迎加入', 'clay'),
      '<h1>嗨 {{name}}，歡迎你來</h1>',
      lead('我是〔你的名字〕，〔一句話介紹你是誰、在做什麼〕。這份電子報會寫〔這份電子報關心的主題〕。'),
      '<p>謝謝你留下信箱。先花一分鐘，說說之後會在這裡收到什麼。</p>',
      '<h2>你會收到的三種信</h2>',
      steps(
        [
          ['〔第一種信〕', '〔一句話說明這類信會寫什麼、讀完能得到什麼〕'],
          ['〔第二種信〕', '〔一句話說明這類信會寫什麼、讀完能得到什麼〕'],
          ['〔第三種信〕', '〔一句話說明這類信會寫什麼、讀完能得到什麼〕'],
        ],
        'clay',
      ),
      note('大約〔每週／每兩週〕寄一封。不想收了，每封信最下方都能退訂。'),
      '<h2>想先讀一篇的話</h2>',
      '<p>推薦從〔文章名稱〕開始，它最能代表這份電子報在意的事。</p>',
      button('https://example.com', '從這篇開始', { bg: '#ffffff', border: 1, borderColor: '#171614' }),
      '<p>想聊聊的話，直接回覆這封信就好。</p>',
    ]),
  },
  {
    id: 'announcement',
    name: '活動邀請',
    description: '講座、工作坊、展覽或直播：主視覺、資訊面板、一個報名按鈕。',
    title: '邀請你來：〔活動名稱〕',
    preheader: '日期、地點、怎麼報名，都在這封信裡',
    bodyHtml: withSignature([
      emailImageSlot('封面：活動主視覺｜建議 1200×630'),
      kicker('活動邀請　〔講座／工作坊／直播〕', 'vermilion'),
      '<h1>活動名稱：一句話說清楚主題</h1>',
      lead('嗨 {{name}}，想邀請你來參加這場〔講座／工作坊〕。用一句話說明參加之後能帶走什麼。'),
      panel(
        [
          ['日期', '〔年／月／日（星期）〕'],
          ['時間', '〔開始時間－結束時間〕'],
          ['地點', '〔實體地址，或「線上，報名後寄送連結」〕'],
          ['對象', '〔誰最適合來〕'],
          ['費用', '〔免費，或票價〕'],
        ],
        'vermilion',
      ),
      '<h2>這場會談什麼</h2>',
      '<ul><li><p>〔第一個主題：一句話說明〕</p></li><li><p>〔第二個主題：一句話說明〕</p></li><li><p>〔第三個主題：一句話說明〕</p></li></ul>',
      '<p>不需要事先準備作品集，帶著最近卡關的問題來就好。</p>',
      button('https://example.com', '立即報名', { bg: '#ad4329' }),
      note('報名截止：〔日期〕。名額〔人數〕位，額滿即停止報名。'),
    ]),
  },
  {
    id: 'work',
    name: '新作品',
    description: '文章、影片、刊物或作品集剛公開：標題、大圖、作品在處理什麼。',
    title: '新作品：〔作品名稱〕',
    preheader: '剛公開，想先讓你看到這一件',
    bodyHtml: withSignature([
      kicker('新作品　〔文章／影片／刊物／作品集〕', 'indigo'),
      '<h1>作品名稱</h1>',
      lead('用一句話介紹這件作品：它是什麼、寫給誰看。'),
      emailImageSlot('滿版：作品主圖｜建議 1200×750'),
      '<p>嗨 {{name}}，這件作品剛公開，想先寄給你。</p>',
      '<h2>這件作品在處理什麼</h2>',
      '<p>寫下它想解決的問題，以及你為什麼想做它。兩三段就好，留一點讓讀者自己打開看。</p>',
      meta('形式　〔文章〕　　長度　〔約 N 分鐘〕　　適合　〔誰〕', 'indigo'),
      button('https://example.com', '打開作品', { bg: '#34507a' }),
      note('時間不多的話，先看〔開頭那一段／第一章〕就好。看完有想法，回信告訴我。'),
    ]),
  },
  {
    id: 'letter',
    name: '一封信',
    description: '像寫給一個人的長信：沒有圖、沒有清單，只把一件事說完。',
    title: '只想跟你說一件事',
    preheader: '這封信沒有清單，只想把一件事說完',
    bodyHtml: withSignature([
      kicker('一封信　寫於〔地點〕', 'ink'),
      '<h1>只想跟你說一件事</h1>',
      '<p>嗨 {{name}}，</p>',
      '<p>這封信沒有清單，也沒有要你點的連結，只想把一件事說完。</p>',
      '<p>從一個具體的場景開始寫：你在哪裡、看到了什麼、為什麼它讓你停下來。讀者會因為細節相信你，而不是因為結論。</p>',
      pull('把整封信最想留下的那句話，放在這裡。', 'ink'),
      '<p>接著寫你怎麼想。不用急著給答案，把想的過程攤開，常常比結論更有用。</p>',
      '<p>最後回到讀者身上：這件事跟他有什麼關係，或你希望他下次遇到時，會想起什麼。</p>',
      ornament('ink'),
      '<p>想繼續聊的話，直接回信給我。</p>',
    ]),
  },
  {
    id: 'tutorial',
    name: '教學步驟',
    description: '帶讀者一步一步完成一件事：每步一張圖、容易出錯的地方加提示，最後整理重點。',
    title: '一步一步做出〔成果〕',
    preheader: '照著做，大約〔N〕分鐘完成',
    bodyHtml: withSignature([
      kicker('教學　〔主題〕', 'teal'),
      '<h1>一步一步做出〔成果〕</h1>',
      lead('嗨 {{name}}，這篇會帶你從頭做一次〔要完成的事〕。做完之後，你會有〔具體成果〕。'),
      meta('需要準備　〔工具、檔案或帳號〕　　所需時間　〔約 N 分鐘〕', 'teal'),
      stepHeading('〔第一步：先做什麼〕', 'teal'),
      '<p>用兩三句話說明這一步要做什麼、在哪裡操作。按鈕或選單名稱可以<strong>加粗</strong>，讀者比較好對照畫面。</p>',
      emailImageSlot('步驟 1 截圖｜建議 1040×650'),
      tip('提示：〔這一步最容易出錯的地方，或可以省時間的做法〕', 'teal'),
      stepHeading('〔第二步：接著做什麼〕', 'teal'),
      '<p>說明這一步的操作，以及做完之後畫面應該長什麼樣子，讓讀者知道自己做對了。</p>',
      emailImageSlot('步驟 2 截圖｜建議 1040×650'),
      stepHeading('〔第三步：最後完成〕', 'teal'),
      '<p>說明最後一步，以及完成後可以怎麼確認結果。</p>',
      emailImageSlot('步驟 3 截圖｜建議 1040×650'),
      tip('提示：〔做完之後可以再調整的地方〕', 'teal'),
      recap('重點整理', ['〔第一步的重點〕', '〔第二步的重點〕', '〔第三步的重點〕'], 'teal'),
      '<p>想看包含更多細節的完整版，可以從這裡打開。</p>',
      button('https://example.com', '看完整教學', { bg: '#2c6670' }),
      note('照著做卻卡住的話，回信告訴我卡在哪一步。'),
    ]),
  },
  {
    id: 'promo',
    name: '課程／產品推廣',
    description: '介紹一堂課或一件產品：主視覺、適合誰、能帶走什麼、資訊面板與一個主要按鈕。',
    title: '〔課程／產品名稱〕開放了',
    preheader: '適合誰、能帶走什麼，以及怎麼參加',
    bodyHtml: withSignature([
      emailImageSlot('封面：課程或產品主視覺｜建議 1200×630'),
      kicker('新推出　〔課程／產品〕', 'plum'),
      '<h1>〔名稱〕：一句話說清楚它幫你解決什麼</h1>',
      lead('嗨 {{name}}，用一兩句話說明為什麼做這個〔課程／產品〕，以及它想解決的問題。'),
      recap('適合誰', ['〔第一種人：他現在遇到的狀況〕', '〔第二種人：他想做到的事〕', '〔第三種人：他卡住的地方〕'], 'plum'),
      '<h2>你能帶走的三件事</h2>',
      steps(
        [
          ['〔第一件〕', '〔一句話說明用了之後能做到什麼〕'],
          ['〔第二件〕', '〔一句話說明用了之後能做到什麼〕'],
          ['〔第三件〕', '〔一句話說明用了之後能做到什麼〕'],
        ],
        'plum',
      ),
      panel(
        [
          ['形式', '〔線上課程／實體工作坊／商品〕'],
          ['時間', '〔開課日期或出貨時間〕'],
          ['地點', '〔平台名稱或地址〕'],
          ['費用', '〔價格與方案〕'],
        ],
        'plum',
      ),
      button('https://example.com', '了解詳情', { bg: '#7d3b5f' }),
      '<h3>常見問題</h3>',
      '<p><strong>〔讀者最常問的問題〕</strong><br>〔簡短回答〕</p>',
      '<p><strong>〔第二個常見問題〕</strong><br>〔簡短回答〕</p>',
      note('還有其他問題，直接回覆這封信就好。'),
    ]),
  },
];

export const EMPTY_STARTER_BODY = [
  emailImageSlot('封面圖（不需要可刪除）｜建議 1200×600'),
  '<p>嗨 {{name}}，</p>',
  '<p>在這裡寫這封信的內容。</p>',
  '{{signature}}',
].join('');

export function isBuiltinStarterId(id: string): boolean {
  return BUILTIN_CAMPAIGN_STARTERS.some((item) => item.id === id);
}
