/**
 * Сколько страниц осталось и когда квота обнулится — для cron и мониторинга.
 *
 *   PDFAPI_KEY=pdf_live_... node examples/quota.ts       # предупредить, если осталось меньше 10%
 *   PDFAPI_KEY=pdf_live_... node examples/quota.ts 25    # …меньше 25%
 *
 * Код выхода 2 — страниц меньше порога: cron пришлёт письмо, мониторинг поднимет тревогу.
 * Запрос страниц не тратит.
 */
import { PdfApi } from 'pdfapi';

const threshold = Number(process.argv[2] ?? 10);

const me = await new PdfApi().me();
const left = me.pagesLimit ? (100 * me.pagesRemaining) / me.pagesLimit : 0;
const reset = me.periodEnd
  ? me.periodEnd.toLocaleString('ru-RU', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' }) + ' UTC'
  : 'неизвестно когда';

console.log(`Тариф ${me.plan}: использовано ${me.pagesUsed} из ${me.pagesLimit}, осталось ${me.pagesRemaining} (${Math.floor(left)}%).`);
console.log(`Счётчик обнулится ${reset}.`);
if (left < threshold) {
  console.error(`Осталось меньше ${threshold}% — пора докупить страницы или сменить тариф.`);
  process.exitCode = 2;
}
