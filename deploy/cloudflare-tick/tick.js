// Worker 的實際邏輯，獨立成一個檔案方便測試（index.js 只匯出 Workers 需要的 default）。

/** 檢查設定；缺任何一個就丟錯，而且完全不發請求。 */
export function tickSettings(env) {
  const url = typeof env?.TICK_URL === 'string' ? env.TICK_URL.trim() : '';
  const secret = typeof env?.CRON_SECRET === 'string' ? env.CRON_SECRET.trim() : '';
  const missing = [];
  if (!url) missing.push('TICK_URL');
  if (!secret) missing.push('CRON_SECRET');
  if (missing.length > 0) {
    throw new Error(`缺少設定（missing setting）：${missing.join('、')}。請用 wrangler secret put 設定；這次沒有發出請求。`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('TICK_URL 不是有效的網址；這次沒有發出請求。');
  }
  if (parsed.protocol !== 'https:') throw new Error('TICK_URL 必須是 https 網址；這次沒有發出請求。');
  return { url: parsed.toString(), secret };
}

/**
 * 打一次 tick。非 2xx、或回應寫明 ok:false（tick 內部出錯）都丟錯，
 * 讓 Cloudflare 的 cron 紀錄顯示失敗，而不是默默成功。
 */
export async function runTick(env, fetchImpl = fetch) {
  const { url, secret } = tickSettings(env);
  const res = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${secret}` } });
  const text = await res.text();
  console.log('tick', res.status, text.slice(0, 200));
  if (!res.ok) throw new Error(`tick 失敗：HTTP ${res.status} ${text.slice(0, 200)}`);
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 不是 JSON 就只看狀態碼。
  }
  if (body && body.ok === false) throw new Error(`tick 回報失敗：${String(body.error ?? '未知原因').slice(0, 200)}`);
  return { status: res.status, body };
}
