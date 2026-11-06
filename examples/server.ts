/**
 * Отдавать PDF из веб-приложения: обычный node:http, без фреймворков.
 * В Express, Fastify, Hono или Next.js — то же самое, см. README.
 *
 *   npm run build && PDFAPI_KEY=pdf_live_... node examples/server.ts
 *   curl -o invoice.pdf 'http://127.0.0.1:3000/invoice/42?customer=ООО%20Ромашка'
 */
import { createServer } from 'node:http';
import { PdfApi, PdfApiError, RateLimitError } from 'pdfapi';

const client = new PdfApi(); // один на приложение
const port = Number(process.env.PORT ?? 3000);

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const number = /^\/invoice\/(\d+)$/.exec(url.pathname)?.[1];
  if (req.method !== 'GET' || !number) {
    res.writeHead(404).end();
    return;
  }
  // Всё, что пришло от пользователя, — только через escape: иначе это HTML-инъекция в документ.
  const customer = escape(url.searchParams.get('customer') ?? 'Покупатель');
  try {
    const pdf = await client.html(`<h1>Счёт №${number}</h1><p>Покупатель: ${customer}</p><p>К оплате: 12 000 ₽</p>`, {
      marginTop: '20mm',
    });
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="invoice-${number}.pdf"` });
    res.end(pdf.content);
  } catch (e) {
    const text = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (e instanceof RateLimitError) {
      res.writeHead(429, { ...text, 'Retry-After': String(Math.ceil(e.retryAfter ?? 1)) }).end('Слишком часто, повторите позже');
    } else if (e instanceof PdfApiError) {
      res.writeHead(502, text).end(`PDF не получился: ${e.message}`);
    } else {
      console.error(e);
      res.writeHead(500, text).end('Внутренняя ошибка');
    }
  }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/invoice/42`));
