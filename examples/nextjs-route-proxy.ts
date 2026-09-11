/**
 * Next.js（App Router）代理範例：app/api/subscribe/route.ts
 *
 * 適合不想讓瀏覽器直接打 newsletter-kit 的情況：
 * 服務可以放在內網、不必開 CORS，也方便在自家後端加驗證碼或額外驗證。
 */
import { NextResponse } from 'next/server';

const NEWSLETTER_API = process.env.NEWSLETTER_API_URL ?? 'http://localhost:4400';

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { email?: string; name?: string };

  if (!body.email) {
    return NextResponse.json({ error: '請填寫 Email' }, { status: 400 });
  }

  // 這裡可以加自家的防濫用檢查（Turnstile、hCaptcha、rate limit…）

  const response = await fetch(`${NEWSLETTER_API}/api/public/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: body.email,
      name: body.name,
      source: 'nextjs',
    }),
  });

  const data = (await response.json()) as { message?: string; error?: string };
  return NextResponse.json(data, { status: response.status });
}

/**
 * 封存頁範例：app/newsletter/page.tsx
 *
 *   const res = await fetch(`${NEWSLETTER_API}/api/public/campaigns`, {
 *     next: { revalidate: 300 },
 *   });
 *   const { items } = await res.json();
 *   // items: { slug, title, subject, preheader, sentAt }[]
 *
 * 單篇內容：GET /api/public/campaigns/<slug> 會回 { title, subject, sentAt, html }
 */
