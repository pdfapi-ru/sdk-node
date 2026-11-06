/**
 * Пачка документов параллельно, с ограничением одновременных запросов.
 *
 * Тариф ограничивает частоту (Free — 1 запрос в секунду и до 3 подряд,
 * Premium — 10 и 30). SDK сам подождёт и повторит при 429, но ровнее —
 * не отправлять больше, чем позволяет тариф.
 *
 *   PDFAPI_KEY=pdf_live_... node examples/batch.ts
 */
import { PdfApi, PdfApiError } from 'pdfapi';

const PARALLEL = 3;

const client = new PdfApi();
const queue = Array.from({ length: 10 }, (_, i) => ({ name: `invoice-${i + 1}.pdf`, html: `<h1>Счёт №${i + 1}</h1>` }));

async function worker(): Promise<void> {
  for (let job = queue.shift(); job; job = queue.shift()) {
    try {
      const pdf = await client.html(job.html);
      await pdf.save(job.name);
      console.log(`${job.name}: ${pdf.pages} стр.`);
    } catch (e) {
      if (!(e instanceof PdfApiError)) throw e;
      console.error(`${job.name}: ошибка ${e.code} — ${e.message}`);
    }
  }
}

await Promise.all(Array.from({ length: PARALLEL }, worker));
