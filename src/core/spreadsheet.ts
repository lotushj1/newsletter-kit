import * as XLSX from 'xlsx';
import { AppError, badRequest } from './errors.js';

const MAX_IMPORT_BYTES = 1_500_000;
/** 匯入上限：名單通常幾千人，留足空間但擋掉異常大的檔案。 */
export const MAX_IMPORT_ROWS = 20_000;
export const MAX_IMPORT_COLUMNS = 50;
/** .xlsx 是 zip：解壓後的總大小與檔案數上限，擋掉壓縮炸彈。 */
const MAX_XLSX_UNCOMPRESSED_BYTES = 30_000_000;
const MAX_XLSX_ENTRIES = 1_000;

/**
 * 讀 zip 的中央目錄，加總每個檔案解壓後的大小。在交給 SheetJS 解析之前先擋掉壓縮炸彈。
 * 不解壓任何內容；格式不對就交給 SheetJS 回報。
 */
export function zipUncompressedSize(input: Buffer): { entries: number; bytes: number } | null {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  const minStart = Math.max(0, input.length - 0xffff - 22);
  for (let i = input.length - 22; i >= minStart; i -= 1) {
    if (input.readUInt32LE(i) !== EOCD) continue;
    const entries = input.readUInt16LE(i + 10);
    const offset = input.readUInt32LE(i + 16);
    let pos = offset;
    let bytes = 0;
    for (let n = 0; n < entries; n += 1) {
      if (pos + 46 > input.length || input.readUInt32LE(pos) !== CENTRAL) return null;
      bytes += input.readUInt32LE(pos + 24);
      pos += 46 + input.readUInt16LE(pos + 28) + input.readUInt16LE(pos + 30) + input.readUInt16LE(pos + 32);
    }
    return { entries, bytes };
  }
  return null;
}

export function decodeImportFile(fileBase64: string): Buffer {
  try {
    const buffer = Buffer.from(fileBase64, 'base64');
    if (buffer.length === 0) throw new Error('empty');
    if (buffer.length > MAX_IMPORT_BYTES) throw badRequest('檔案太大，請小於 1.5 MB');
    return buffer;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw badRequest('檔案讀取失敗');
  }
}

/** 把 CSV / Excel 轉成匯入用的 CSV 文字。Excel 只讀第一個工作表。支援：CSV（UTF-8，可含 BOM）、.xls、.xlsx。 */
export function spreadsheetToCsv(input: Buffer, fileName: string): string {
  const name = fileName.trim().toLowerCase();
  if (!/\.(csv|xls|xlsx)$/.test(name)) throw badRequest('請上傳 CSV 或 Excel（.xls、.xlsx）');

  if (name.endsWith('.csv')) {
    let text = input.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.trim() === '') throw badRequest('這個檔案是空的');
    return text;
  }

  if (name.endsWith('.xlsx')) {
    // .xlsx 一定是 zip（開頭 PK）；不是的話多半是改了副檔名的其他檔案。
    if (input.length < 4 || input.readUInt32LE(0) !== 0x04034b50) {
      throw badRequest('這不是有效的 .xlsx 檔，請用 Excel 另存新檔，或改存成 CSV 再匯入');
    }
    const zip = zipUncompressedSize(input);
    if (zip && (zip.entries > MAX_XLSX_ENTRIES || zip.bytes > MAX_XLSX_UNCOMPRESSED_BYTES)) {
      throw badRequest('這個 Excel 檔解壓後太大，請另存成 CSV 再匯入');
    }
  }
  let workbook: XLSX.WorkBook;
  try {
    // 只解析第一個工作表，最多讀到上限多一列（超過就在後面整批拒絕）。
    workbook = XLSX.read(input, { type: 'buffer', raw: false, sheets: 0, sheetRows: MAX_IMPORT_ROWS + 2 });
  } catch {
    throw badRequest('Excel 檔讀取失敗，請確認檔案沒有損壞，或另存成 CSV 再匯入');
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw badRequest('這個檔案沒有工作表');
  const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]!);
  if (csv.trim() === '') throw badRequest('這個檔案是空的');
  return csv;
}
