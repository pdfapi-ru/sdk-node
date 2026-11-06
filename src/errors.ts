/** Ошибки pdfapi. Все ошибки API — наследники {@link PdfApiError} (см. sdk/SPEC.md). */

/** Ошибка pdfapi: код из ответа API, HTTP-статус и текст. */
export class PdfApiError extends Error {
  /** Код ошибки API: `quota_exceeded`, `render_failed`, … */
  readonly code: string;
  /** HTTP-статус; `null` — ответа не было (сеть, таймаут). */
  readonly status: number | null;

  constructor(message: string, code: string, status: number | null = null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }

  override toString(): string {
    const where = this.status !== null ? `HTTP ${this.status}, ` : '';
    return `${this.name}: ${this.message} (${where}${this.code})`;
  }
}

/** 401: ключа нет, он неверный или отозван. */
export class AuthenticationError extends PdfApiError {}
/** 403: почта не подтверждена или формат недоступен на тарифе. */
export class PermissionDeniedError extends PdfApiError {}
/** 402: страницы периода кончились или документ больше остатка. */
export class QuotaExceededError extends PdfApiError {}
/** 400: неверный запрос, параметр или адрес во внутреннюю сеть. */
export class InvalidRequestError extends PdfApiError {}
/** 413: тело запроса больше 5 МБ. */
export class PayloadTooLargeError extends InvalidRequestError {}
/** 502: документ не отрендерился — обычно дело в разметке. */
export class RenderError extends PdfApiError {}
/** 504: рендер не уложился в 30 секунд. */
export class RenderTimeoutError extends RenderError {}
/** 503: рендер временно недоступен или очередь полна. */
export class UnavailableError extends PdfApiError {}
/** Нет связи с API: сеть, DNS, обрыв соединения. */
export class APIConnectionError extends PdfApiError {}
/** API не ответил за отведённое время. */
export class APITimeoutError extends APIConnectionError {}

/** 429: слишком часто. `retryAfter` — через сколько секунд можно снова. */
export class RateLimitError extends PdfApiError {
  readonly retryAfter: number | null;

  constructor(message: string, code: string, status: number | null, retryAfter: number | null) {
    super(message, code, status);
    this.retryAfter = retryAfter;
  }
}

type ErrorClass = new (message: string, code: string, status: number | null) => PdfApiError;

const BY_CODE: Record<string, ErrorClass> = {
  missing_api_key: AuthenticationError,
  invalid_api_key: AuthenticationError,
  email_not_verified: PermissionDeniedError,
  source_not_allowed: PermissionDeniedError,
  quota_exceeded: QuotaExceededError,
  invalid_request: InvalidRequestError,
  url_not_allowed: InvalidRequestError,
  payload_too_large: PayloadTooLargeError,
  render_failed: RenderError,
  render_timeout: RenderTimeoutError,
  unavailable: UnavailableError,
};

// Ответ не от API (Caddy отдаёт 413 текстом, прокси — 502 в HTML, сайт — 404 страницей,
// Fastify — {"error": "Bad Request"}): код по статусу.
const CODE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request', 401: 'invalid_api_key', 402: 'quota_exceeded', 403: 'source_not_allowed',
  404: 'not_found', 413: 'payload_too_large', 429: 'rate_limit_exceeded', 502: 'render_failed',
  503: 'unavailable', 504: 'render_timeout',
};

/** Код API — `quota_exceeded`, а не название статуса вроде `Bad Request`. */
const API_CODE = /^[a-z][a-z0-9_]*$/;

const MESSAGES: Record<string, string> = {
  missing_api_key: 'Не передан ключ API.',
  invalid_api_key: 'Неверный или отозванный ключ API.',
  email_not_verified: 'Почта аккаунта не подтверждена.',
  source_not_allowed: 'Этот формат недоступен на вашем тарифе.',
  quota_exceeded: 'Лимит страниц исчерпан.',
  invalid_request: 'Некорректный запрос.',
  url_not_allowed: 'Адрес ведёт во внутреннюю сеть и запрещён.',
  payload_too_large: 'Тело запроса больше 5 МБ.',
  rate_limit_exceeded: 'Слишком много запросов.',
  render_failed: 'Не удалось создать PDF.',
  render_timeout: 'Рендер не уложился в 30 секунд.',
  unavailable: 'Сервис временно недоступен.',
  server_error: 'Внутренняя ошибка сервера.',
  not_found: 'Адрес не найден (HTTP 404). Проверьте базовый адрес: он ведёт на API, например https://pdfapi.ru/api.',
};

/** Retry-After в секундах; дата в HTTP-формате не поддерживается — API так не отвечает. */
export function parseRetryAfter(headers: Headers): number | null {
  const value = headers.get('retry-after')?.trim();
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function parseBody(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // не JSON — разберёмся по статусу
  }
  return {};
}

/** Через сколько секунд можно снова: заголовок Retry-After, иначе `retry_after_sec` из тела. */
export function retryAfterSeconds(headers: Headers, body: string): number | null {
  const fromHeader = parseRetryAfter(headers);
  if (fromHeader !== null) return fromHeader;
  const fromBody = parseBody(body).retry_after_sec;
  return typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0 ? fromBody : null;
}

/** Ответ API с ошибкой → исключение нужного класса (таблица — sdk/SPEC.md). */
export function errorFromResponse(status: number, headers: Headers, body: string): PdfApiError {
  const data = parseBody(body);
  const code = typeof data.error === 'string' && API_CODE.test(data.error)
    ? data.error
    : CODE_BY_STATUS[status] ?? (status >= 500 ? 'server_error' : 'unknown_error');
  const message = typeof data.message === 'string' && data.message.trim()
    ? data.message
    : MESSAGES[code] ?? `Ошибка API (HTTP ${status}).`;

  if (code === 'rate_limit_exceeded') return new RateLimitError(message, code, status, retryAfterSeconds(headers, body));
  const Cls = BY_CODE[code] ?? PdfApiError;
  return new Cls(message, code, status);
}
