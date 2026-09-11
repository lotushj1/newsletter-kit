/**
 * 最小 webhook 接收端範例。
 *
 * newsletter-kit 設 EMAIL_PROVIDER=webhook 後，每封信都會 POST 到這裡，
 * 由你決定實際怎麼寄（Resend、SES、SMTP、Portaly Mail、n8n…都可以）。
 *
 *   node examples/webhook-receiver.mjs
 *   # 另一個終端機
 *   EMAIL_PROVIDER=webhook WEBHOOK_URL=http://localhost:5300/send \
 *   WEBHOOK_SECRET=shared-secret npm run dev
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 5300);
const SECRET = process.env.WEBHOOK_SECRET ?? 'shared-secret';

function verifySignature(rawBody, header) {
  if (!SECRET) return true;
  const expected = `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  const a = Buffer.from(header ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/send')) {
    res.writeHead(404).end('not found');
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');

    if (!verifySignature(rawBody, req.headers['x-newsletter-signature'])) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad signature' }));
      return;
    }

    const message = JSON.parse(rawBody);
    // 這裡換成你真正的寄信呼叫。
    console.log('收到寄信要求：', {
      to: message.to,
      subject: message.subject,
      unsubscribeUrl: message.unsubscribeUrl,
    });

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `local_${Date.now().toString(36)}` }));
  });
}).listen(PORT, () => {
  console.log(`webhook 接收端啟動：http://localhost:${PORT}/send`);
});
