/**
 * Vercel serverless 會在進到我們的程式之前拒絕超過 4.5 MB 的 request body
 *（FUNCTION_PAYLOAD_TOO_LARGE）。圖片目前是 JSON 裡的 base64，體積約是原檔的 4/3，
 * 再加上 `{"fileName","fileBase64"}` 包裝，解碼後大約 3 MB 才進得去。
 */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_UPLOAD_JSON_BYTES = Math.floor(3.8 * 1024 * 1024);
export const IMAGE_TOO_LARGE_MESSAGE =
  '圖片太大。寄到 Vercel 的 JSON 不能超過約 4.5 MB（base64 會變大），請改用較小的圖，或讓瀏覽器自動縮小後再傳。';
export const GIF_TOO_LARGE_MESSAGE =
  '這張 GIF 太大，動畫圖不能自動壓縮。請換成較小的 GIF（約 3 MB 以內），或改用 JPG／PNG。';
export const UNREADABLE_IMAGE_MESSAGE =
  '瀏覽器解不開這張圖。若是 iPhone 的 HEIC，請先在照片 App 匯出成 JPG 再上傳。';
