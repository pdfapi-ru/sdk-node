# pdfapi — TypeScript / Node.js SDK

Официальная библиотека [pdfapi](https://pdfapi.ru): HTML, страница по адресу, Markdown или docx/xlsx/pptx — в PDF одним вызовом. Типы в комплекте, понятные ошибки, повторы при перегрузке. Без зависимостей: Node.js 20.3+, Bun и Deno; ESM и CommonJS.

```bash
npm install pdfapi
```

```ts
import { PdfApi } from 'pdfapi';

const client = new PdfApi(); // ключ берётся из переменной окружения PDFAPI_KEY

const pdf = await client.html('<h1>Счёт №42</h1><p>К оплате: 12 000 ₽</p>', { marginTop: '20mm' });
await pdf.save('invoice.pdf');

console.log(pdf.pages);            // 1 — сколько страниц списано
console.log(pdf.quota?.remaining); // 9857 — сколько осталось в периоде
```

CommonJS — то же самое: `const { PdfApi } = require('pdfapi');`.

Ключ выпускается в кабинете на [pdfapi.ru](https://pdfapi.ru). Держите его в переменной окружения, а не в коде:

```bash
export PDFAPI_KEY=pdf_live_...
```

## Методы

Все методы асинхронные и возвращают `Promise`.

| Метод | Что делает |
|---|---|
| `client.html(html, options?)` | HTML → PDF |
| `client.url(url, options?)` | публичная страница по адресу → PDF (тариф premium и выше). Адрес — полный, с `http://` или `https://` |
| `client.markdown(text, options?)` | Markdown → PDF (тариф premium и выше) |
| `client.office(file, { filename?, landscape? })` | docx, xlsx, pptx → PDF. `file` — путь, `Uint8Array`/`Buffer`, `ArrayBuffer`, `Blob` или `File` |
| `client.convert(body, options?)` | запрос `POST /v1/convert` с телом как есть — для всего остального |
| `client.me(options?)` | тариф, расход, остаток страниц и границы периода |

### Параметры страницы

Все необязательные:

| Параметр | Пример | По умолчанию |
|---|---|---|
| `landscape` | `true` | `false` |
| `paperWidth`, `paperHeight` | `'8.27in'`, `'297mm'` | A4 |
| `marginTop`, `marginBottom`, `marginLeft`, `marginRight` | `'20mm'` | `'0.39in'` |
| `waitDelay` | `'2s'`, `'500ms'` — подождать, пока скрипт на странице дорисует график; до 10 секунд | `'0s'` |

Размер — число и единица `pt`, `px`, `in`, `mm`, `cm` или `pc` без пробела: `'20mm'`, `'1.5cm'`, `'.5in'`. Остальное — ошибка сразу, без запроса: `20` и `'20'` — это миллиметры или дюймы? А `'20 mm'` и `'20MM'` рендер не понимает.

В тех же `options` можно передать `signal` и `timeout` — см. [Отмена и таймауты](#отмена-и-таймауты).

### Office-документы

```ts
const fromPath = await client.office('report.docx');                               // путь (Node, Bun, Deno)
const fromBytes = await client.office(buffer, { filename: 'report.docx' });        // байты — нужно имя с расширением
const fromForm = await client.office(formData.get('file') as File, { landscape: true }); // File из формы — имя берётся из него
```

Файл — не больше 3,7 МБ: после кодирования в base64 тело запроса не должно превысить 5 МБ. docx, xlsx и pptx — ZIP-архивы, поэтому старый `.doc` или PDF, переименованный в `.docx`, отклоняется сразу, не отправляя мегабайты на сервер.

## Результат

`PdfResult`:
- `content` — байты PDF (`Uint8Array`);
- `pages` — сколько страниц списано;
- `quota` — `{ limit, used, remaining }` после этой конвертации;
- `save(path)` — записать в файл и вернуть путь (атомарно, см. ниже);
- `blob()` — PDF как `Blob` с типом `application/pdf`;
- `size` — размер в байтах.

`console.log(pdf)` и `JSON.stringify(pdf)` байты не печатают — только страницы, размер и квоту.

`save` пишет атомарно: сначала во временный файл рядом, потом переименовывает поверх. Оборвётся запись или кончится место — на месте останется прежний файл, а не обрезанный PDF. Каталог не создаётся: опечатка в пути — ошибка.

## Отдать PDF из веб-приложения

PDF уже в памяти — отдавайте байты, на диск сохранять незачем. Данные пользователя в HTML — только с экранированием, иначе это HTML-инъекция в документ. Целиком, с обработкой ошибок, — [`examples/server.ts`](examples/server.ts).

```ts
// Next.js (app/invoice/route.ts), Hono — любой обработчик на Request/Response
export async function GET() {
  const pdf = await client.html('<h1>Счёт №42</h1>');
  return new Response(pdf.blob(), {
    headers: { 'Content-Disposition': 'attachment; filename="invoice.pdf"' },
  });
}

// Express
app.get('/invoice', async (req, res, next) => {
  try {
    const pdf = await client.html('<h1>Счёт №42</h1>');
    res.type('application/pdf').send(Buffer.from(pdf.content));
  } catch (e) {
    next(e);
  }
});
```

## Аккаунт и квота

```ts
const me = await client.me();
console.log(me.plan, me.pagesRemaining, 'из', me.pagesLimit);
console.log('обнулится', me.periodEnd?.toISOString());
```

`Account`: `userId`, `plan` (`free`, `premium`, `business`), `periodStart` и `periodEnd` (когда счётчик начнётся с нуля; `Date` или `null`, если сервер не сообщил), `pagesUsed`, `pagesLimit`, `pagesRemaining`, `requestsPerSecond`, `burst`. Запрос страниц не тратит. Проверка для cron — [`examples/quota.ts`](examples/quota.ts).

## Ошибки

Все ошибки API — наследники `PdfApiError`; у каждой есть `code`, `status` и `message` (по-русски).

```ts
import { PdfApiError, QuotaExceededError, RateLimitError, RenderError } from 'pdfapi';

try {
  const pdf = await client.html(html);
} catch (e) {
  if (e instanceof QuotaExceededError) console.log('Страницы кончились:', e.message);
  else if (e instanceof RateLimitError) console.log(`Слишком часто, повторите через ${e.retryAfter} с`);
  else if (e instanceof RenderError) console.log('Документ не отрендерился — проверьте разметку');
  else if (e instanceof PdfApiError) console.log(e.code, e.status, e.message);
  else throw e;
}
```

| Ошибка | Когда |
|---|---|
| `AuthenticationError` | 401: ключа нет, он неверный или отозван |
| `PermissionDeniedError` | 403: почта не подтверждена или формат недоступен на тарифе |
| `QuotaExceededError` | 402: страницы периода кончились или документ больше остатка |
| `InvalidRequestError` | 400: неверный параметр или адрес во внутреннюю сеть (`code === 'url_not_allowed'`) |
| `PayloadTooLargeError` | 413: тело больше 5 МБ (наследник `InvalidRequestError`) |
| `RateLimitError` | 429: слишком часто; `retryAfter` — через сколько секунд можно снова |
| `RenderError` | 502: документ не отрендерился |
| `RenderTimeoutError` | 504: рендер дольше 30 секунд (наследник `RenderError`) |
| `UnavailableError` | 503: рендер временно недоступен |
| `APIConnectionError` | нет связи с API |
| `APITimeoutError` | API не ответил за `timeout` (наследник `APIConnectionError`) |
| `PdfApiError` с `code === 'not_found'` | 404: неверный базовый адрес — обычно в нём забыли `/api` |

Ошибки в аргументах (пустой HTML, `'20 mm'` вместо `'20mm'`, адрес без `https://`, файл `.pdf` вместо `.docx`) — обычные `TypeError` и `RangeError`, ещё до запроса; лимит частоты на них не тратится. Как и ошибки API, они приходят отклонённым `Promise`, а не синхронно.

## Повторы

SDK сам повторяет запрос, когда это безопасно — по умолчанию до 2 раз (`maxRetries`):
- **429** — через `Retry-After` секунд (или `retry_after_sec` из ответа), но не дольше минуты;
- **503** и **соединение не установилось** (`ECONNREFUSED`, DNS) — через 0,5 и 1 с (с небольшим разбросом).

**Таймаут и обрыв посреди ответа не повторяются.** Сервер мог успеть сделать PDF и списать страницы, и повтор списал бы их второй раз. Такие ошибки приходят как `APITimeoutError` / `APIConnectionError` — решайте сами, повторять ли.

## Отмена и таймауты

```ts
const controller = new AbortController();
const pdf = await client.html(html, { signal: controller.signal, timeout: 10_000 });
```

- `timeout` — миллисекунды на одну попытку; по умолчанию — таймаут клиента (40 000).
- Отменили через `signal` — `Promise` отклоняется **вашей** причиной (`controller.abort(reason)`), а не ошибкой API.

## Настройки клиента

```ts
const client = new PdfApi({
  apiKey: 'pdf_live_...',            // иначе PDFAPI_KEY
  baseUrl: 'https://pdfapi.ru/api',  // иначе PDFAPI_BASE_URL
  timeout: 40_000,                   // мс на один запрос
  maxRetries: 2,
  fetch: myFetch,                    // свой fetch — например, через прокси
});
```

- **Неверные настройки** — `timeout` не больше нуля, `maxRetries` меньше нуля или дробное — `RangeError` сразу.
- **Один клиент на приложение.** Создайте его один раз и переиспользуйте — закрывать ничего не нужно.
- **Ключ не утекает:** он хранится в приватном поле, его нет ни в `console.log(client)`, ни в `JSON.stringify(client)`, ни в текстах ошибок.
- **Не в браузере.** Ключ API в коде страницы увидит любой посетитель, поэтому в браузере `new PdfApi()` выбрасывает ошибку. Вызывайте API со своего сервера. Если вы точно понимаете, что делаете (внутренний инструмент, ключ пользователя), — `dangerouslyAllowBrowser: true`.

## Deno и Bun

Bun — как Node: `bun add pdfapi`.

В Deno — через `npm:`:

```ts
import { PdfApi } from 'npm:pdfapi';
```

```bash
deno run --allow-net=pdfapi.ru --allow-env=PDFAPI_KEY,PDFAPI_BASE_URL app.ts
```

`--allow-env` не нужен, если `apiKey` и `baseUrl` переданы в `new PdfApi({...})` явно. Для `save()` и `office('путь')` добавьте `--allow-write` / `--allow-read`.

## Примеры

В папке [`examples/`](examples). Node.js 22.18+ запускает их без компиляции: `npm run build && PDFAPI_KEY=pdf_live_... node examples/<файл>`.

| Файл | Что показывает |
|---|---|
| `invoice.ts` | счёт из HTML-шаблона с экранированием данных |
| `from-url.ts` | страница по адресу, альбомная, с ожиданием скриптов |
| `office.ts` | docx, xlsx или pptx в PDF рядом с исходным файлом |
| `batch.ts` | пачка документов параллельно, в пределах лимита частоты |
| `quota.ts` | остаток страниц и дата обнуления — для cron, код выхода 2 при нехватке |
| `server.ts` | отдача PDF из `node:http`: клиент на всё приложение, ошибки API — в HTTP-ответы |

## Разработка

```bash
npm ci
npm test            # юнит-тесты и общие тест-кейсы SDK (../tests/cases.json)
npm run typecheck   # строгая проверка типов, включая тесты и примеры
npm run build       # dist/: ESM, CommonJS и .d.ts
```

Интеграционные тесты против настоящего API запускаются, только если заданы `PDFAPI_IT_KEY` и `PDFAPI_IT_BASE_URL`:

```bash
PDFAPI_IT_KEY=pdf_live_... PDFAPI_IT_BASE_URL=http://localhost:18080/api npx vitest run test/integration.test.ts
```

Общий контракт для SDK на всех языках — [`../SPEC.md`](../SPEC.md).
