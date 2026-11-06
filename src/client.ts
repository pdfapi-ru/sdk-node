import { APIConnectionError, APITimeoutError, errorFromResponse, retryAfterSeconds } from './errors.js';
import { accountFromJson, resultFromResponse, type Account, type PdfResult } from './models.js';
import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://pdfapi.ru/api';
/** Рендер — до 30 с, плюс запас на сеть и очередь. */
export const DEFAULT_TIMEOUT_MS = 40_000;
export const DEFAULT_MAX_RETRIES = 2;
/** Тело запроса ограничено 5 МБ, а base64 раздувает файл на треть. */
export const OFFICE_MAX_BYTES = 3_700_000;
const MAX_RETRY_AFTER_S = 60;
const OFFICE_EXTENSIONS = ['.docx', '.xlsx', '.pptx'];
/** docx, xlsx и pptx — ZIP-архивы, начинаются с «PK\x03\x04». */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** Число и единица, как понимает рендер. Без единицы сервер считает дюймами, но "20" почти всегда задумано как мм. */
const SIZE = /^(\d+(\.\d*)?|\.\d+)(pt|px|in|mm|cm|pc)$/;
/** waitDelay — как на сервере: число и s или ms, не больше 10 секунд. */
const WAIT_DELAY = /^(\d+(?:\.\d+)?)(ms|s)$/;
const MAX_WAIT_DELAY_MS = 10_000;

/** Параметры страницы. Не заданные не отправляются. Размеры — строками с единицами, как в CSS. */
export interface PageOptions {
  landscape?: boolean;
  /** Например `"8.27in"`. Размеры — число и единица `pt`, `px`, `in`, `mm`, `cm` или `pc`. */
  paperWidth?: string;
  /** Например `"297mm"`. */
  paperHeight?: string;
  /** Например `"20mm"`. */
  marginTop?: string;
  marginBottom?: string;
  marginLeft?: string;
  marginRight?: string;
  /** Подождать перед печатью, например `"2s"` или `"500ms"`, до 10 секунд: страница дорисовывается скриптом. */
  waitDelay?: string;
}

/** Настройки одного вызова. */
export interface RequestOptions {
  /** Отмена вызова. Отменили — придёт исходная ошибка AbortSignal, а не ошибка API. */
  signal?: AbortSignal;
  /** Таймаут этого вызова, мс (иначе — таймаут клиента). */
  timeout?: number;
}

export interface OfficeOptions extends RequestOptions {
  /** Имя с расширением — нужно, если передаются байты, а не путь. */
  filename?: string;
  landscape?: boolean;
}

export interface ClientOptions {
  /** Ключ API; по умолчанию — переменная окружения `PDFAPI_KEY`. */
  apiKey?: string;
  /** Адрес API; по умолчанию `PDFAPI_BASE_URL` или `https://pdfapi.ru/api`. */
  baseUrl?: string;
  /** Таймаут одного запроса, мс. По умолчанию 40 000. */
  timeout?: number;
  /** Сколько раз повторять 429, 503 и ошибки соединения. По умолчанию 2. */
  maxRetries?: number;
  /** Свой fetch — прокси, тесты. По умолчанию глобальный. */
  fetch?: typeof globalThis.fetch;
  /**
   * Разрешить работу в браузере. Ключ API в браузере виден любому посетителю —
   * включайте, только если понимаете, зачем.
   */
  dangerouslyAllowBrowser?: boolean;
  /** @internal Пауза между повторами — для тестов. */
  sleep?: (ms: number) => Promise<void>;
}

const OPTION_NAMES = ['paperWidth', 'paperHeight', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'waitDelay'] as const;

// Ошибки соединения, при которых запрос точно не ушёл — их безопасно повторить.
// ECONNRESET и обрыв посреди ответа сюда не входят: сервер мог успеть
// отрендерить и списать страницы, повтор списал бы их второй раз.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

type Env = Record<string, string | undefined>;
const env = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

function runtimeName(): string {
  const g = globalThis as { process?: { versions?: { node?: string } }; Deno?: { version?: { deno?: string } }; Bun?: { version?: string } };
  if (g.Bun?.version) return `bun ${g.Bun.version}`;
  if (g.Deno?.version?.deno) return `deno ${g.Deno.version.deno}`;
  if (g.process?.versions?.node) return `node ${g.process.versions.node}`;
  return 'js';
}

function pageOptions(options: PageOptions | undefined): Record<string, boolean | string> {
  const out: Record<string, boolean | string> = {};
  if (!options) return out;
  if (options.landscape !== undefined) {
    if (typeof options.landscape !== 'boolean') throw new TypeError('landscape: ожидается true или false');
    out.landscape = options.landscape;
  }
  for (const name of OPTION_NAMES) {
    const value = options[name];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      // Число тут почти наверняка ошибка: 20 — это мм? пиксели? Лучше сказать сразу.
      throw new TypeError(`${name}: ожидается строка с единицами, например "20mm" или "2s"`);
    }
    if (name === 'waitDelay') {
      const m = WAIT_DELAY.exec(value);
      if (!m || Number(m[1]) * (m[2] === 's' ? 1000 : 1) > MAX_WAIT_DELAY_MS) {
        throw new RangeError(`waitDelay: "${value}" — нужно от 0 до 10 секунд в s или ms, например "2s" или "500ms"`);
      }
    } else if (!SIZE.test(value)) {
      // Иначе рендер падает с 502, и опечатка выглядит как сбой сервиса.
      throw new TypeError(`${name}: "${value}" — нужно число с единицами pt, px, in, mm, cm или pc без пробела, например "20mm"`);
    }
    out[name] = value;
  }
  return out;
}

function textBody(source: 'html' | 'url' | 'markdown', value: string, options: PageOptions | undefined) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${source}: пустое содержимое`);
  if (source === 'url') {
    value = value.trim(); // пробелы по краям рендер не прощает
    if (!/^https?:\/\/\S/i.test(value)) {
      throw new TypeError(`url: "${value}" — нужен полный адрес с http:// или https://, например https://example.com`);
    }
  }
  const body: Record<string, unknown> = { source, [source]: value };
  const o = pageOptions(options);
  if (Object.keys(o).length) body.options = o;
  return body;
}

function toBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: 'base64'): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const backoff = (attempt: number) => 500 * 2 ** attempt * (0.75 + Math.random() * 0.5);

/** Через сколько повторить ответ, мс; `null` — не повторять. Только 429 и 503: сервер ничего не сделал. */
function retryDelay(attempt: number, status: number, headers: Headers, body: string): number | null {
  if (status === 429) {
    const after = retryAfterSeconds(headers, body);
    return after !== null ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : Math.min(backoff(attempt), MAX_RETRY_AFTER_S * 1000);
  }
  return status === 503 ? backoff(attempt) : null;
}

function checkTimeout(name: string, ms: number): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) throw new RangeError(`${name}: таймаут в миллисекундах больше нуля, например 40_000`);
  return ms;
}

function notSent(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_SENT.has(code)) return true;
    // Deno кодов не даёт, но помечает этап: (Connect) — соединение не открылось (отказ, DNS),
    // а (SendRequest) — запрос мог уйти, его не повторяем.
    if (String((e as { message?: unknown }).message).includes('client error (Connect)')) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Клиент pdfapi. Создайте один и переиспользуйте.
 *
 * ```ts
 * const client = new PdfApi();                 // ключ из PDFAPI_KEY
 * const pdf = await client.html('<h1>Счёт №42</h1>', { marginTop: '20mm' });
 * await pdf.save('invoice.pdf');
 * ```
 */
export class PdfApi {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  // Настоящее приватное поле: его не видно ни в console.log, ни в JSON.stringify.
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #userAgent = `pdfapi-node/${VERSION} (${runtimeName()})`;

  constructor(options: ClientOptions = {}) {
    const g = globalThis as { window?: unknown; document?: unknown };
    if (typeof g.window !== 'undefined' && typeof g.document !== 'undefined' && !options.dangerouslyAllowBrowser) {
      throw new Error(
        'pdfapi: похоже, это браузер. Ключ API в браузере увидит любой посетитель — вызывайте API с сервера. ' +
          'Если всё-таки нужно — dangerouslyAllowBrowser: true.',
      );
    }
    const key = (options.apiKey ?? env().PDFAPI_KEY ?? '').trim();
    if (!key) throw new TypeError('Не задан ключ API: передайте apiKey или задайте переменную окружения PDFAPI_KEY.');
    this.#apiKey = key;
    this.baseUrl = (options.baseUrl || env().PDFAPI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = checkTimeout('timeout', options.timeout ?? DEFAULT_TIMEOUT_MS);
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) throw new RangeError('maxRetries: целое число от 0');
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw new TypeError('fetch недоступен: нужен Node 20+ или свой fetch в настройках.');
    this.#fetch = f;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** HTML → PDF. */
  async html(html: string, options?: PageOptions & RequestOptions): Promise<PdfResult> {
    return this.convert(textBody('html', html, options), options);
  }

  /** Страница по публичному адресу → PDF (тариф premium и выше). */
  async url(url: string, options?: PageOptions & RequestOptions): Promise<PdfResult> {
    return this.convert(textBody('url', url, options), options);
  }

  /** Markdown → PDF (тариф premium и выше). */
  async markdown(markdown: string, options?: PageOptions & RequestOptions): Promise<PdfResult> {
    return this.convert(textBody('markdown', markdown, options), options);
  }

  /**
   * docx, xlsx или pptx → PDF. `file` — путь (Node, Bun, Deno), байты или Blob.
   * Для байтов нужно `filename` с расширением — по нему сервер понимает формат.
   */
  async office(file: string | Uint8Array | ArrayBuffer | Blob, options: OfficeOptions = {}): Promise<PdfResult> {
    let data: Uint8Array;
    let filename = options.filename;
    if (typeof file === 'string') {
      const [{ readFile }, { basename }] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      data = new Uint8Array(await readFile(file));
      filename ??= basename(file);
    } else if (ArrayBuffer.isView(file)) {
      // Buffer, Uint8Array из другого контекста (vm, воркер) — любой вид на байты.
      data = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    } else if (file instanceof ArrayBuffer || Object.prototype.toString.call(file) === '[object ArrayBuffer]') {
      data = new Uint8Array(file as ArrayBuffer);
    } else if (typeof Blob !== 'undefined' && file instanceof Blob) {
      data = new Uint8Array(await file.arrayBuffer());
      filename ??= (file as { name?: string }).name;
    } else {
      throw new TypeError('file: путь, Uint8Array, ArrayBuffer или Blob');
    }
    if (!filename) throw new TypeError("filename: укажите имя файла с расширением, например { filename: 'report.docx' }");
    const lower = filename.toLowerCase();
    if (!OFFICE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      throw new TypeError(`${filename}: поддерживаются только .docx, .xlsx и .pptx`);
    }
    if (data.byteLength === 0) throw new TypeError(`${filename}: файл пустой`);
    if (!ZIP_MAGIC.every((b, i) => data[i] === b)) {
      // Старый .doc, PDF или картинка с чужим расширением: сервер всё равно отклонит.
      throw new TypeError(`${filename}: не похож на docx, xlsx или pptx — это не ZIP-архив`);
    }
    if (data.byteLength > OFFICE_MAX_BYTES) {
      const mb = (data.byteLength / 1e6).toFixed(1).replace('.', ',');
      throw new RangeError(`${filename}: ${mb} МБ — больше предела 3,7 МБ (после base64 тело запроса превысило бы 5 МБ)`);
    }
    const body: Record<string, unknown> = { source: 'office', filename: filename.split(/[\\/]/).pop(), fileBase64: toBase64(data) };
    const o = pageOptions(options.landscape === undefined ? undefined : { landscape: options.landscape });
    if (Object.keys(o).length) body.options = o;
    return this.convert(body, options);
  }

  /** Низкоуровневый `POST /v1/convert` с телом как есть. */
  async convert(body: Record<string, unknown>, options: RequestOptions = {}): Promise<PdfResult> {
    // JSON.stringify не экранирует кириллицу и < > — тело не раздувается.
    const response = await this.#send('POST', '/v1/convert', JSON.stringify(body), options);
    return resultFromResponse(response.headers, new Uint8Array(await response.arrayBuffer()));
  }

  /** Тариф, расход и остаток страниц в текущем периоде. */
  async me(options: RequestOptions = {}): Promise<Account> {
    const response = await this.#send('GET', '/v1/me', null, options);
    return accountFromJson(await response.json());
  }

  async #send(method: string, path: string, body: string | null, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      'User-Agent': this.#userAgent,
      Accept: 'application/pdf, application/json',
    };
    if (body !== null) headers['Content-Type'] = 'application/json; charset=utf-8';
    const timeout = options.timeout === undefined ? this.timeout : checkTimeout('timeout', options.timeout);

    for (let attempt = 0; ; attempt++) {
      const timer = AbortSignal.timeout(timeout);
      const signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;
      let response: Response;
      try {
        response = await this.#fetch(this.baseUrl + path, { method, headers, body, signal });
        if (response.ok) {
          // Тело читаем здесь же, пока действует таймаут, — чтобы обрыв посреди
          // ответа тоже стал понятной ошибкой.
          const bytes = await response.arrayBuffer();
          return new Response(bytes, { status: response.status, headers: response.headers });
        }
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error; // отменили вы — не ошибка API
        if (timer.aborted) {
          throw new APITimeoutError(
            `API не ответил за ${timeout / 1000} с. Запрос мог быть выполнен — повторять его ` +
              'автоматически небезопасно: страницы списались бы дважды.',
            'timeout',
            null,
            { cause: error },
          );
        }
        if (notSent(error) && attempt < this.maxRetries) {
          await this.#sleep(backoff(attempt));
          continue;
        }
        const reason = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
        throw new APIConnectionError(`Нет связи с ${this.baseUrl}: ${reason}`, 'connection_error', null, { cause: error });
      }

      const text = await response.text().catch(() => '');
      const delay = retryDelay(attempt, response.status, response.headers, text);
      if (delay !== null && attempt < this.maxRetries) {
        await this.#sleep(delay);
        continue;
      }
      throw errorFromResponse(response.status, response.headers, text);
    }
  }

  /** Ключ не показывается. */
  toJSON(): { baseUrl: string; timeout: number; maxRetries: number } {
    return { baseUrl: this.baseUrl, timeout: this.timeout, maxRetries: this.maxRetries };
  }
}
