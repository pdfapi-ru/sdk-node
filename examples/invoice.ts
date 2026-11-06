/**
 * Счёт из HTML-шаблона.
 *
 *   npm run build && PDFAPI_KEY=pdf_live_... node examples/invoice.ts   # Node 22.18+ запускает .ts сам
 */
import { PdfApi, PdfApiError } from 'pdfapi';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const rub = (amount: number) => amount.toLocaleString('ru-RU') + ' ₽'; // 12 000 ₽

const items: [name: string, qty: number, price: number][] = [
  ['Подписка Premium, октябрь', 1, 1990],
  ['Дополнительные страницы', 2, 500],
];
const rows = items
  .map(([name, qty, price]) => `<tr><td>${escape(name)}</td><td>${qty}</td><td>${rub(price * qty)}</td></tr>`)
  .join('');
const total = items.reduce((sum, [, qty, price]) => sum + qty * price, 0);

const html = `
<style>
  body { font-family: sans-serif; }
  table { width: 100%; border-collapse: collapse; }
  td, th { border-bottom: 1px solid #ddd; padding: 8px; text-align: left; }
</style>
<h1>Счёт №42</h1>
<table><tr><th>Услуга</th><th>Кол-во</th><th>Сумма</th></tr>${rows}</table>
<h2>Итого: ${rub(total)}</h2>`;

const client = new PdfApi();
try {
  const pdf = await client.html(html, { marginTop: '20mm', marginBottom: '20mm' });
  await pdf.save('invoice.pdf');
  console.log(`invoice.pdf: ${pdf.pages} стр., осталось ${pdf.quota?.remaining ?? '?'}`);
} catch (e) {
  if (!(e instanceof PdfApiError)) throw e;
  console.error(`Не получилось: ${e.message}`);
  process.exitCode = 1;
}
