import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as pdfapi from '../src/index.js';
import { client, scripted, type Step } from './helpers.js';

/** Общие тест-кейсы SDK (sdk/tests/cases.json): что ответил сервер → что сделал SDK. */
interface Spec { status: number; headers?: Record<string, string>; json?: unknown; text?: string; body_base64?: string }
interface Case {
  name: string;
  call: { method: 'html' | 'url' | 'markdown' | 'office' | 'me'; args: Record<string, string>; options?: Record<string, unknown> };
  responses: Spec[];
  expect: {
    request?: { method: string; path: string; json?: unknown; raw_contains?: string };
    result?: { content_base64: string; pages: number | null; quota: { limit: number; used: number; remaining: number } | null };
    me?: Record<string, string | number | null>;
    argument_error?: { mentions: string };
    error?: { class: string; code: string; status: number; message_contains?: string; retry_after?: number };
    attempts: number;
    sleeps?: number[];
    sleeps_between?: [number, number];
  };
}

const file = fileURLToPath(new URL('../../tests/cases.json', import.meta.url));
const cases: Case[] = JSON.parse(readFileSync(file, 'utf8')).cases;

const response = (s: Spec): Response => {
  const body = s.json !== undefined ? JSON.stringify(s.json) : s.text ?? Buffer.from(s.body_base64 ?? '', 'base64');
  return new Response(body, { status: s.status, headers: s.headers ?? {} });
};

const ME_FIELDS: Record<string, keyof pdfapi.Account> = {
  user_id: 'userId', plan: 'plan', period_start: 'periodStart', period_end: 'periodEnd', pages_used: 'pagesUsed',
  pages_limit: 'pagesLimit', pages_remaining: 'pagesRemaining', requests_per_second: 'requestsPerSecond', burst: 'burst',
};

describe('общие кейсы SDK', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const { fetch, requests } = scripted(c.responses.map((s) => () => response(s)) as Step[]);
    const { client: api, sleeps } = client(fetch);

    let outcome: unknown;
    try {
      const { method, args, options } = c.call;
      if (method === 'me') outcome = await api.me();
      else if (method === 'office') {
        const file = new Uint8Array(Buffer.from(args.file_base64!, 'base64'));
        outcome = await api.office(file, { filename: args.filename!, ...(options as { landscape?: boolean }) });
      } else outcome = await api[method](Object.values(args)[0]!, options as pdfapi.PageOptions);
    } catch (e) {
      outcome = e;
    }

    const ex = c.expect;
    expect(requests).toHaveLength(ex.attempts);
    if (ex.request) {
      const r = requests[0]!;
      expect(r.method).toBe(ex.request.method);
      expect(new URL(r.url).pathname.endsWith(ex.request.path)).toBe(true);
      if (ex.request.json !== undefined) expect(JSON.parse(r.body!)).toEqual(ex.request.json);
      if (ex.request.raw_contains) expect(r.body).toContain(ex.request.raw_contains);
    }
    if (ex.result) {
      expect(outcome).toBeInstanceOf(pdfapi.PdfResult);
      const res = outcome as pdfapi.PdfResult;
      expect(Buffer.from(res.content).toString('base64')).toBe(Buffer.from(ex.result.content_base64, 'base64').toString('base64'));
      expect(res.pages).toBe(ex.result.pages);
      expect(res.quota).toEqual(ex.result.quota);
    }
    if (ex.me) {
      const a = outcome as pdfapi.Account;
      for (const [k, v] of Object.entries(ex.me)) {
        const actual = a[ME_FIELDS[k]!];
        if (k.startsWith('period_')) expect(actual === null ? null : (actual as Date).getTime(), k).toBe(v === null ? null : Date.parse(v as string));
        else expect(actual, k).toBe(v);
      }
    }
    if (ex.argument_error) {
      // Ошибка языка, а не API: запрос не ушёл.
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toBeInstanceOf(pdfapi.PdfApiError);
      expect((outcome as Error).message.toLowerCase()).toContain(ex.argument_error.mentions.toLowerCase());
    }
    if (ex.error) {
      expect(outcome).toBeInstanceOf(pdfapi.PdfApiError);
      const e = outcome as pdfapi.PdfApiError;
      expect(e.constructor.name).toBe(ex.error.class);
      expect(e.code).toBe(ex.error.code);
      expect(e.status).toBe(ex.error.status);
      if (ex.error.message_contains) expect(e.message).toContain(ex.error.message_contains);
      if (ex.error.retry_after !== undefined) expect((e as pdfapi.RateLimitError).retryAfter).toBe(ex.error.retry_after);
    }
    if (ex.sleeps) expect(sleeps.map((ms) => ms / 1000)).toEqual(ex.sleeps);
    if (ex.sleeps_between) {
      expect(sleeps.length).toBeGreaterThan(0);
      for (const ms of sleeps) {
        expect(ms / 1000).toBeGreaterThanOrEqual(ex.sleeps_between[0]);
        expect(ms / 1000).toBeLessThanOrEqual(ex.sleeps_between[1]);
      }
    }
  });
});
