import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as pdfapi from '../src/index.js';

/**
 * Против настоящего API:
 *   PDFAPI_IT_KEY=pdf_live_... PDFAPI_IT_BASE_URL=http://localhost:18080/api npx vitest run test/integration.test.ts
 */
const key = process.env.PDFAPI_IT_KEY;
const baseUrl = process.env.PDFAPI_IT_BASE_URL;

describe.skipIf(!key || !baseUrl)('живой API', () => {
  const client = () => new pdfapi.PdfApi({ apiKey: key!, baseUrl: baseUrl! });

  it('HTML в PDF', async () => {
    const pdf = await client().html("<h1>TypeScript SDK</h1><div style='page-break-before:always'>2</div>");
    expect(new TextDecoder().decode(pdf.content.subarray(0, 4))).toBe('%PDF');
    expect(pdf.pages).toBe(2);
    expect(pdf.quota).not.toBeNull();
  });

  it('все форматы и save', async () => {
    const c = client();
    const fixture = (name: string) => fileURLToPath(new URL(`../../tests/fixtures/${name}`, import.meta.url));
    const results = [
      await c.markdown('# Отчёт\n\n- пункт один\n- пункт два'),
      await c.url('https://example.com', { waitDelay: '500ms' }),
      await c.office(fixture('report.docx')),
      await c.office(fixture('table.xlsx'), { landscape: true }),
      await c.office(readFileSync(fixture('slides.pptx')), { filename: 'slides.pptx' }),
    ];
    for (const pdf of results) {
      expect(new TextDecoder().decode(pdf.content.subarray(0, 4))).toBe('%PDF');
      expect(pdf.pages).toBeGreaterThanOrEqual(1);
    }
    const path = await results[0]!.save(join(mkdtempSync(join(tmpdir(), 'pdfapi-it-')), 'out.pdf'));
    expect(new Uint8Array(readFileSync(path))).toEqual(results[0]!.content);
  });

  it('me, неверный ключ и параметр, отклонённый сервером', async () => {
    const c = client();
    const me = await c.me();
    expect(me.userId).not.toBe('');
    expect(me.pagesUsed + me.pagesRemaining).toBe(me.pagesLimit);
    expect(me.periodEnd!.getTime()).toBeGreaterThan(me.periodStart!.getTime());
    await expect(new pdfapi.PdfApi({ apiKey: 'pdf_live_wrong', baseUrl: c.baseUrl }).html('<p>x</p>')).rejects.toBeInstanceOf(pdfapi.AuthenticationError);
    const e = await c.convert({ source: 'html', html: '<p>x</p>', options: { foo: 'bar' } }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(pdfapi.InvalidRequestError);
    expect((e as Error).message).toContain('foo');
  });
});
