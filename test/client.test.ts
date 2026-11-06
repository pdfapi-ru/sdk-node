import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as pdfapi from '../src/index.js';
import { BASE_URL, KEY, client, json, netError, pdf, scripted } from './helpers.js';

/** Начало ZIP-архива — так начинается любой docx, xlsx и pptx. */
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const ZIP_B64 = Buffer.from(ZIP).toString('base64');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('настройки', () => {
  it('без ключа — ошибка при создании, а не 401 при первом запросе', () => {
    vi.stubEnv('PDFAPI_KEY', '');
    expect(() => new pdfapi.PdfApi()).toThrow(/PDFAPI_KEY/);
  });

  it('ключ и адрес из окружения, слэш на конце срезается', async () => {
    vi.stubEnv('PDFAPI_KEY', 'pdf_live_env');
    vi.stubEnv('PDFAPI_BASE_URL', 'http://localhost:18080/api/');
    const { fetch, requests } = scripted([pdf()]);
    const c = new pdfapi.PdfApi({ fetch });
    await c.html('<p>x</p>');
    expect(c.baseUrl).toBe('http://localhost:18080/api');
    expect(requests[0]!.headers.Authorization).toBe('Bearer pdf_live_env');
    vi.stubEnv('PDFAPI_BASE_URL', '');
    expect(new pdfapi.PdfApi({ apiKey: 'x', fetch }).baseUrl).toBe(pdfapi.DEFAULT_BASE_URL);
  });

  it('таймаут и повторы проверяются сразу', async () => {
    for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new pdfapi.PdfApi({ apiKey: KEY, timeout })).toThrow(RangeError);
    }
    for (const maxRetries of [-1, 1.5]) expect(() => new pdfapi.PdfApi({ apiKey: KEY, maxRetries })).toThrow(RangeError);
    const { fetch, requests } = scripted([pdf()]);
    await expect(client(fetch).client.html('<p>x</p>', { timeout: 0 })).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(0);
  });

  it('в браузере без явного разрешения не создаётся', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    expect(() => new pdfapi.PdfApi({ apiKey: KEY })).toThrow(/браузер/);
    expect(() => new pdfapi.PdfApi({ apiKey: KEY, dangerouslyAllowBrowser: true })).not.toThrow();
  });
});

describe('запрос', () => {
  it('заголовки и UTF-8 JSON без экранирования', async () => {
    const { fetch, requests } = scripted([pdf()]);
    await client(fetch).client.html('<h1>Счёт</h1>');
    const r = requests[0]!;
    expect(r.url).toBe(`${BASE_URL}/v1/convert`);
    expect(r.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(r.headers['User-Agent']).toMatch(new RegExp(`^pdfapi-node/${pdfapi.VERSION} \\(node `));
    expect(r.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(r.body).toContain('"html":"<h1>Счёт</h1>"');
  });

  it('GET /v1/me — без тела и Content-Type', async () => {
    const { fetch, requests } = scripted([json(200, { plan: 'free', usage: {}, limits: {} })]);
    expect((await client(fetch).client.me()).plan).toBe('free');
    expect(requests[0]!.body).toBeNull();
    expect(requests[0]!.headers['Content-Type']).toBeUndefined();
  });

  it('ключ не утекает: ни в console.log, ни в JSON, ни в ошибки', async () => {
    const { fetch } = scripted([json(401, { error: 'invalid_api_key' })]);
    const { client: c } = client(fetch);
    expect(inspect(c, { depth: 5, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(c)).not.toContain(KEY);
    const e = await c.html('<p>x</p>').catch((err: unknown) => err as pdfapi.PdfApiError);
    expect(e).toBeInstanceOf(pdfapi.AuthenticationError);
    expect(String(e) + inspect(e) + (e as Error).stack).not.toContain(KEY);
  });

  it('иерархия ошибок', () => {
    expect(new pdfapi.PayloadTooLargeError('x', 'payload_too_large')).toBeInstanceOf(pdfapi.InvalidRequestError);
    expect(new pdfapi.RenderTimeoutError('x', 'render_timeout')).toBeInstanceOf(pdfapi.RenderError);
    expect(new pdfapi.APITimeoutError('x', 'timeout')).toBeInstanceOf(pdfapi.APIConnectionError);
    expect(new pdfapi.QuotaExceededError('x', 'quota_exceeded').name).toBe('QuotaExceededError');
  });
});

describe('аргументы', () => {
  it('неверные — ошибка до запроса', async () => {
    const { fetch, requests } = scripted([pdf()]);
    const { client: c } = client(fetch);
    await expect(c.html('<p>x</p>', { marginTop: 20 as unknown as string })).rejects.toThrow(TypeError);
    await expect(c.html('<p>x</p>', { landscape: 'yes' as unknown as boolean })).rejects.toThrow(TypeError);
    await expect(c.markdown('  ')).rejects.toThrow(/пустое/);
    await expect(c.office(new Uint8Array([1]))).rejects.toThrow(/filename/);
    await expect(c.office(new Uint8Array([1]), { filename: 'scan.pdf' })).rejects.toThrow(/docx/);
    const big = new Uint8Array(pdfapi.OFFICE_MAX_BYTES + 1);
    big.set([0x50, 0x4b, 0x03, 0x04]);
    await expect(c.office(big, { filename: 'big.pptx' })).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(0);
  });

  it('все параметры страницы — как есть, только заданные', async () => {
    const { fetch, requests } = scripted([pdf()]);
    await client(fetch).client.html('<p>x</p>', { landscape: false, marginTop: '20mm', waitDelay: '1s', timeout: 5000 });
    expect(JSON.parse(requests[0]!.body!).options).toEqual({ landscape: false, marginTop: '20mm', waitDelay: '1s' });
  });
});

describe('office', () => {
  it('путь, байты, ArrayBuffer и Blob', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfapi-'));
    const path = join(dir, 'Отчёт.docx');
    writeFileSync(path, Buffer.from('PK\x03\x04docx'));
    const { fetch, requests } = scripted([pdf()]);
    const { client: c } = client(fetch);
    await c.office(path, { landscape: true });
    await c.office(new Uint8Array(ZIP), { filename: 'a.xlsx' });
    await c.office(new Uint8Array(ZIP).buffer, { filename: 'b.pptx' });
    await c.office(new File([new Uint8Array(ZIP)], 'c.docx'));
    const bodies = requests.map((r) => JSON.parse(r.body!));
    expect(bodies[0]).toEqual({ source: 'office', filename: 'Отчёт.docx', fileBase64: Buffer.from('PK\x03\x04docx').toString('base64'), options: { landscape: true } });
    expect(bodies.map((b) => b.filename)).toEqual(['Отчёт.docx', 'a.xlsx', 'b.pptx', 'c.docx']);
    expect(bodies[3].fileBase64).toBe(ZIP_B64);
  });

  it('Buffer и байты из другого контекста (vm)', async () => {
    const { fetch, requests } = scripted([pdf()]);
    const { client: c } = client(fetch);
    const big = Buffer.from([0x78, 0x78, ...ZIP, 0x79]);
    await c.office(big.subarray(2, 6), { filename: 'a.docx' }); // вид на часть буфера — только эти байты
    await c.office(runInNewContext('new Uint8Array([80, 75, 3, 4])'), { filename: 'b.docx' });
    await c.office(runInNewContext('new Uint8Array([80, 75, 3, 4]).buffer'), { filename: 'c.docx' });
    expect(requests.map((r) => JSON.parse(r.body!).fileBase64)).toEqual([ZIP_B64, ZIP_B64, ZIP_B64]);
  });

  it('base64 без Buffer (Deno, Workers) — те же байты', async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    bytes.set(ZIP);
    const { fetch, requests } = scripted([pdf()]);
    // Base64 считается до запроса; Buffer возвращаем, как только дошли до fetch, — он нужен самому Node.
    const restoring = ((...args: Parameters<typeof fetch>) => (vi.unstubAllGlobals(), fetch(...args))) as typeof fetch;
    vi.stubGlobal('Buffer', undefined);
    await client(restoring).client.office(bytes, { filename: 'a.docx' });
    expect(JSON.parse(requests[0]!.body!).fileBase64).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('save', () => {
  const result = () => new pdfapi.PdfResult(new TextEncoder().encode('%PDF-new'), 1, null);

  it('заменяет файл целиком и не оставляет временных', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfapi-'));
    const path = join(dir, 'out.pdf');
    writeFileSync(path, 'старое содержимое, которое длиннее нового');
    await result().save(path);
    expect(readFileSync(path, 'utf8')).toBe('%PDF-new');
    expect(readdirSync(dir)).toEqual(['out.pdf']);
  });

  it('сбой посреди записи — прежний файл цел, временный удалён', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfapi-'));
    const path = join(dir, 'out.pdf');
    writeFileSync(path, '%PDF-old');
    // FileHandle не экспортируется — берём прототип у открытого файла.
    const probe = await open(path, 'r');
    const FileHandle = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
    await probe.close();
    const sync = vi.spyOn(FileHandle, 'sync').mockRejectedValueOnce(new Error('диск отвалился'));
    try {
      await expect(result().save(path)).rejects.toThrow('диск отвалился');
    } finally {
      sync.mockRestore();
    }
    expect(readFileSync(path, 'utf8')).toBe('%PDF-old');
    expect(readdirSync(dir)).toEqual(['out.pdf']);
  });

  it('права как у обычного нового файла', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pdfapi-')), 'out.pdf');
    await result().save(path);
    expect(statSync(path).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it('сбой при переименовании — цель не тронута, временный удалён', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfapi-'));
    const target = join(dir, 'out.pdf');
    mkdirSync(target); // на месте файла — непустой каталог: rename не пройдёт
    writeFileSync(join(target, 'keep'), 'x');
    await expect(result().save(target)).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['out.pdf']);
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('x');
  });

  it('каталога нет — ошибка, ничего не создано', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfapi-'));
    await expect(result().save(join(dir, 'нет', 'out.pdf'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('результат', () => {
  it('save, blob, toJSON без байтов', async () => {
    const { fetch } = scripted([pdf()]);
    const res = await client(fetch).client.html('<p>x</p>');
    const path = join(mkdtempSync(join(tmpdir(), 'pdfapi-')), 'out.pdf');
    expect(await res.save(path)).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('%PDF-1.4');
    expect(res.blob().type).toBe('application/pdf');
    expect(res.size).toBe(8);
    expect(JSON.stringify(res)).toBe('{"pages":1,"size":8,"quota":null}');
  });
});

describe('сеть и повторы', () => {
  it('соединение не установилось — повтор, потом успех', async () => {
    const { fetch, requests } = scripted([netError('ECONNREFUSED'), pdf()]);
    const { client: c, sleeps } = client(fetch);
    expect((await c.html('<p>x</p>')).pages).toBe(1);
    expect(requests).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(375);
    expect(sleeps[0]).toBeLessThanOrEqual(625);
  });

  it('Deno: отказ соединения повторяется, обрыв после отправки — нет', async () => {
    const deno = (stage: string) => new TypeError('fetch failed', { cause: new Error(`error sending request for url (x): client error (${stage}): ...`) });
    const refused = scripted([deno('Connect'), pdf()]);
    expect((await client(refused.fetch).client.html('<p>x</p>')).pages).toBe(1);
    expect(refused.requests).toHaveLength(2);
    const reset = scripted([deno('SendRequest'), pdf()]);
    await expect(client(reset.fetch).client.html('<p>x</p>')).rejects.toBeInstanceOf(pdfapi.APIConnectionError);
    expect(reset.requests).toHaveLength(1);
  });

  it('после всех повторов — APIConnectionError', async () => {
    const { fetch, requests } = scripted([netError('ENOTFOUND')]);
    const e = await client(fetch).client.html('<p>x</p>').catch((err: unknown) => err);
    expect(e).toBeInstanceOf(pdfapi.APIConnectionError);
    expect((e as pdfapi.PdfApiError).code).toBe('connection_error');
    expect(requests).toHaveLength(3);
  });

  it('обрыв соединения не повторяется — страницы могли списаться', async () => {
    const { fetch, requests } = scripted([netError('ECONNRESET'), pdf()]);
    const { client: c, sleeps } = client(fetch);
    const e = await c.html('<p>x</p>').catch((err: unknown) => err);
    expect(e).toBeInstanceOf(pdfapi.APIConnectionError);
    expect(e).not.toBeInstanceOf(pdfapi.APITimeoutError);
    expect(requests).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  const hanging = (async (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof globalThis.fetch;

  it('таймаут не повторяется', async () => {
    let calls = 0;
    const counting = ((url: RequestInfo | URL, init?: RequestInit) => (calls++, hanging(url, init))) as typeof globalThis.fetch;
    const e = await new pdfapi.PdfApi({ apiKey: KEY, fetch: counting, timeout: 50 }).html('<p>x</p>').catch((err: unknown) => err);
    expect(e).toBeInstanceOf(pdfapi.APITimeoutError);
    expect((e as pdfapi.PdfApiError).code).toBe('timeout');
    expect(calls).toBe(1);
  });

  it('отмена вызывающим — исходная причина, а не ошибка API', async () => {
    const ac = new AbortController();
    const p = new pdfapi.PdfApi({ apiKey: KEY, fetch: hanging }).html('<p>x</p>', { signal: ac.signal });
    ac.abort(new Error('пользователь передумал'));
    await expect(p).rejects.toThrow('пользователь передумал');
  });

  it('maxRetries: 0 — без повторов', async () => {
    const { fetch, requests } = scripted([json(503, { error: 'unavailable' }), pdf()]);
    await expect(client(fetch, { maxRetries: 0 }).client.html('<p>x</p>')).rejects.toBeInstanceOf(pdfapi.UnavailableError);
    expect(requests).toHaveLength(1);
  });
});
