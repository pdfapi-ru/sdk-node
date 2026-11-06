import { PdfApi, type ClientOptions } from '../src/index.js';

export const KEY = 'pdf_live_secret_test_key_123';
export const BASE_URL = 'https://pdfapi.test/api';

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export type Step = Response | Error | (() => Response | Promise<Response>);

/** Подменный fetch: отвечает по очереди (ответ, исключение или функция) и запоминает запросы. */
export function scripted(steps: Step[]) {
  const requests: Recorded[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      method: init?.method ?? 'GET',
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: (init?.body as string | null | undefined) ?? null,
    });
    const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step();
    return step.clone(); // один и тот же ответ может понадобиться несколько раз
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

export function client(fetch: typeof globalThis.fetch, extra: Partial<ClientOptions> = {}) {
  const sleeps: number[] = [];
  const c = new PdfApi({ apiKey: KEY, baseUrl: BASE_URL + '/', fetch, sleep: async (ms) => void sleeps.push(ms), ...extra });
  return { client: c, sleeps };
}

export const pdf = (body = '%PDF-1.4', pages: number | null = 1) =>
  new Response(body, { status: 200, headers: pages === null ? {} : { 'X-Pages-Rendered': String(pages) } });

export const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** Ошибка fetch в Node: TypeError('fetch failed') с причиной-кодом. */
export const netError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
