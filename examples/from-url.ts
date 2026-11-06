/**
 * Страница по адресу в PDF (тариф premium и выше).
 *
 *   PDFAPI_KEY=pdf_live_... node examples/from-url.ts https://example.com
 */
import { InvalidRequestError, PdfApi, PermissionDeniedError } from 'pdfapi';

const url = process.argv[2] ?? 'https://example.com';

try {
  // waitDelay — подождать, пока скрипты на странице дорисуют содержимое.
  const pdf = await new PdfApi().url(url, { landscape: true, waitDelay: '1s' });
  console.log(`${await pdf.save('page.pdf')}: ${pdf.pages} стр.`);
} catch (e) {
  if (e instanceof PermissionDeniedError) console.error(`${e.message} — нужен тариф premium`);
  else if (e instanceof InvalidRequestError) console.error(e.message); // например, url_not_allowed: адрес во внутреннюю сеть
  else throw e;
  process.exitCode = 1;
}
