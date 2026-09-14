import * as XLSX from 'xlsx';
import { AppError, badRequest } from './errors.js';

const MAX_IMPORT_BYTES = 1_500_000;

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

/** 把 CSV / Excel 轉成匯入用的 CSV 文字。Excel 只讀第一個工作表。 */
export function spreadsheetToCsv(input: Buffer, fileName: string): string {
  const name = fileName.trim().toLowerCase();
  if (!/\.(csv|xls|xlsx)$/.test(name)) throw badRequest('請上傳 CSV 或 Excel（.xls、.xlsx）');

  if (name.endsWith('.csv')) {
    let text = input.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.trim() === '') throw badRequest('這個檔案是空的');
    return text;
  }

  const workbook = XLSX.read(input, { type: 'buffer', raw: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw badRequest('這個檔案沒有工作表');
  const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]!);
  if (csv.trim() === '') throw badRequest('這個檔案是空的');
  return csv;
}
