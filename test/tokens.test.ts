import { describe, expect, it } from 'vitest';
import { createToken, verifyToken } from '../src/core/tokens.js';

const SECRET = 'secret-a';

describe('簽章 token', () => {
  it('簽出來的 token 可以驗回同一個 email', () => {
    const token = createToken(SECRET, 'confirm', 'Someone@Example.com');
    const verified = verifyToken(SECRET, token, 'confirm');
    expect(verified?.email).toBe('someone@example.com');
  });

  it('用途不同就驗不過', () => {
    const token = createToken(SECRET, 'confirm', 'a@example.com');
    expect(verifyToken(SECRET, token, 'unsubscribe')).toBeNull();
  });

  it('換 secret 後舊 token 失效', () => {
    const token = createToken(SECRET, 'unsubscribe', 'a@example.com');
    expect(verifyToken('secret-b', token, 'unsubscribe')).toBeNull();
  });

  it('內容被竄改就驗不過', () => {
    const token = createToken(SECRET, 'confirm', 'a@example.com');
    const [body, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ e: 'attacker@example.com', p: 'confirm', t: 1 }),
      'utf8',
    ).toString('base64url');
    expect(body).toBeTruthy();
    expect(verifyToken(SECRET, `${forged}.${signature}`, 'confirm')).toBeNull();
  });

  it('超過有效期限就失效', () => {
    const token = createToken(SECRET, 'confirm', 'a@example.com');
    expect(verifyToken(SECRET, token, 'confirm', -1)).toBeNull();
  });

  it('退訂連結不設期限就永久有效', () => {
    const token = createToken(SECRET, 'unsubscribe', 'a@example.com');
    expect(verifyToken(SECRET, token, 'unsubscribe')).not.toBeNull();
  });
});
