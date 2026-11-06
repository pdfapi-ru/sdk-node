/**
 * Официальный TypeScript SDK pdfapi: HTML, URL, Markdown и Office в PDF одним вызовом.
 *
 * ```ts
 * import { PdfApi } from 'pdfapi';
 *
 * const client = new PdfApi();                 // ключ из PDFAPI_KEY
 * const pdf = await client.html('<h1>Счёт №42</h1>', { marginTop: '20mm' });
 * await pdf.save('invoice.pdf');
 * ```
 *
 * Документация: https://pdfapi.ru/docs
 */
export {
  PdfApi,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  OFFICE_MAX_BYTES,
  type ClientOptions,
  type PageOptions,
  type RequestOptions,
  type OfficeOptions,
} from './client.js';
export { PdfResult, type Quota, type Account } from './models.js';
export {
  PdfApiError,
  AuthenticationError,
  PermissionDeniedError,
  QuotaExceededError,
  InvalidRequestError,
  PayloadTooLargeError,
  RateLimitError,
  RenderError,
  RenderTimeoutError,
  UnavailableError,
  APIConnectionError,
  APITimeoutError,
} from './errors.js';
export { VERSION } from './version.js';
