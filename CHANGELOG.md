# Изменения

## 0.1.0

Первая версия.

- `PdfApi`: `html`, `url`, `markdown`, `office`, `convert`, `me`.
- Параметры страницы — `landscape`, `paperWidth`, `paperHeight`, `margin*`, `waitDelay`; проверяются до запроса.
- Результат `PdfResult`: байты PDF, число страниц, квота, `save()`, `blob()`.
- Ошибки по кодам API — наследники `PdfApiError`.
- Проверки до запроса: размеры — число с единицей `pt`, `px`, `in`, `mm`, `cm` или `pc`; `waitDelay` — до 10 секунд; адрес — с `http(s)://`; Office-файл — ZIP-архив не больше 3,7 МБ.
- Повторы при 429 (по `Retry-After` или `retry_after_sec`), 503 и ошибках соединения; таймауты не повторяются, чтобы не списать страницы дважды.
- Ответы не от API (страница 404, формат Fastify, текст от прокси) разбираются по статусу; 404 — `not_found` с подсказкой про базовый адрес.
- `save()` пишет атомарно: прерванная запись не портит прежний файл.
- `me()`: `userId`, `periodStart`, `periodEnd` — когда обнулится квота.
- Отмена через `AbortSignal` и таймаут на отдельный вызов.
- Без зависимостей: Node.js 20.3+, Bun и Deno; ESM и CommonJS, типы в комплекте.
- Примеры: `invoice`, `from-url`, `office`, `batch`, `quota` (для cron), `server` (`node:http`).
