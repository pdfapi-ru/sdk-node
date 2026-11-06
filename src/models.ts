/** Квота периода после конвертации — из заголовков X-Quota-*. */
export interface Quota {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
}

/** Тариф и расход — ответ `GET /v1/me`. */
export interface Account {
  readonly userId: string;
  /** `free`, `premium` или `business`. */
  readonly plan: string;
  /** Начало периода; `null` — сервер не сообщил. */
  readonly periodStart: Date | null;
  /** Когда счётчик страниц начнётся с нуля; `null` — сервер не сообщил. */
  readonly periodEnd: Date | null;
  readonly pagesUsed: number;
  readonly pagesLimit: number;
  readonly pagesRemaining: number;
  readonly requestsPerSecond: number;
  readonly burst: number;
}

/**
 * Готовый PDF: `content` — байты файла, `pages` — сколько страниц списано,
 * `quota` — остаток квоты. Нет заголовков — `null`.
 */
export class PdfResult {
  constructor(
    readonly content: Uint8Array,
    readonly pages: number | null,
    readonly quota: Quota | null,
  ) {}

  /**
   * Записать PDF в файл (Node, Bun, Deno) и вернуть путь. Атомарно: сначала во
   * временный файл рядом, затем переименование поверх — оборвётся запись, на
   * месте останется прежний файл, а не обрезанный PDF. Каталог не создаётся.
   *
   * `node:fs` подключается только здесь, поэтому сам SDK работает и там, где
   * файловой системы нет.
   */
  async save(path: string): Promise<string> {
    const [fs, { basename, dirname, join }] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    const tmp = join(dirname(path), `.${basename(path)}.${globalThis.crypto.randomUUID().slice(0, 8)}.tmp`);
    const file = await fs.open(tmp, 'wx'); // права как у обычного нового файла, с учётом umask
    try {
      try {
        await file.writeFile(this.content);
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(tmp, path);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    return path;
  }

  /** PDF как Blob — например, для `new Response(pdf.blob())`. */
  blob(): Blob {
    // Байты всегда из ArrayBuffer ответа; уточнение типа не попадает в публичные .d.ts.
    return new Blob([this.content as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
  }

  get size(): number {
    return this.content.byteLength;
  }

  toJSON(): { pages: number | null; size: number; quota: Quota | null } {
    return { pages: this.pages, size: this.size, quota: this.quota }; // байты в логи не нужны
  }
}

function intHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value);
}

export function resultFromResponse(headers: Headers, content: Uint8Array): PdfResult {
  const limit = intHeader(headers, 'x-quota-limit');
  const used = intHeader(headers, 'x-quota-used');
  const remaining = intHeader(headers, 'x-quota-remaining');
  const quota = limit !== null && used !== null && remaining !== null ? { limit, used, remaining } : null;
  return new PdfResult(content, intHeader(headers, 'x-pages-rendered'), quota);
}

function date(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function accountFromJson(data: unknown): Account {
  const d = (data ?? {}) as Record<string, unknown>;
  const usage = (typeof d.usage === 'object' && d.usage ? d.usage : {}) as Record<string, unknown>;
  const limits = (typeof d.limits === 'object' && d.limits ? d.limits : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  // Старый API присылал только дату начала — "2026-10-01", это полночь UTC.
  const legacyStart = typeof d.period === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.period) ? `${d.period}T00:00:00Z` : null;
  return {
    userId: String(d.user_id ?? ''),
    plan: String(d.plan ?? ''),
    periodStart: date(d.period_start) ?? date(legacyStart),
    periodEnd: date(d.period_end),
    pagesUsed: num(usage.pages_used),
    pagesLimit: num(usage.pages_limit),
    pagesRemaining: num(usage.pages_remaining),
    requestsPerSecond: num(limits.requests_per_second),
    burst: num(limits.burst),
  };
}
