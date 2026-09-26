import { BITRIX24_ZONES } from '../domain/portals/zones'

/**
 * Content-Security-Policy for the three kinds of response this app produces.
 *
 * Раньше эти заголовки ставил свой nginx. На общем хосте перед нами стоит один
 * `nginx-proxy` на все проекты — он занимается только TLS и маршрутизацией и ничего
 * не знает про Битрикс24. Поэтому политика переехала в приложение: это единственное
 * место, которое знает, какая страница кому показывается.
 *
 * Проставляет их `server/plugins/security-headers.ts`, а не `routeRules` — почему
 * именно так, объяснено там.
 */

const bitrix24Origins = BITRIX24_ZONES.map(zone => `https://*.bitrix24.${zone}`).join(' ')

/**
 * Policy for the app running inside a Bitrix24 portal iframe.
 *
 * `unsafe-inline` и `unsafe-eval` здесь нужны самому Битрикс24; сузить их можно только
 * своей проверкой в живом портале, а не заодно с чем-то другим.
 */
export const portalCsp = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: https:`,
  `connect-src 'self' ${bitrix24Origins}`,
  `frame-ancestors ${bitrix24Origins}`,
  `object-src 'none'`,
  `frame-src 'none'`,
  `base-uri 'none'`,
  // `form-action` не наследуется от `default-src`, как и `base-uri`. Без неё
  // инъекция внутри портального контекста отправит форму куда угодно.
  `form-action 'self'`,
].join('; ')

/**
 * Policy for the public survey page.
 *
 * Её открывает посторонний респондент, встраивать её в чужие страницы незачем —
 * отсюда `frame-ancestors 'none'`.
 *
 * ⚠ В `script-src` БОЛЬШЕ НЕТ `unsafe-inline`, и это главное здесь (issue #2). Это
 * единственная страница, где текст, введённый сотрудником портала, читает посторонний
 * человек. Первый рубеж — то, что разметки там не бывает вовсе: всё через `{{ }}`,
 * без `v-html`. CSP — второй, страхующий первый; с `unsafe-inline` его просто не было.
 *
 * ⚠ БЕЗ NONCE ПОЛИТИКА СТРОЖЕ, А НЕ СЛАБЕЕ. Не отрендерив разметку, мы не знаем, какие
 * инлайновые скрипты в ней окажутся, — и тогда не разрешаем ни одного. Обратный порядок
 * («нет nonce — вернём `unsafe-inline`») означал бы, что любая ошибка в протягивании nonce
 * тихо возвращает дыру, ради закрытия которой всё и делалось.
 *
 * ⚠ `style-src 'unsafe-inline'` ОСТАЁТСЯ, и это осознанно, а не забыто. Vue проставляет
 * стили атрибутом `style` при обычном рендере, и без этого разрешения страница поедет
 * вёрсткой. Вектор здесь несопоставим: через CSS вытаскивают данные по одному селектору
 * за загрузку, через `<script>` выполняют что угодно сразу. Сузить его — отдельная работа
 * со своей проверкой, а не заодно.
 */
export function buildPublicPageCsp(nonce?: string, frameAncestors = `'none'`): string {
  return [
    `default-src 'self'`,
    `script-src 'self'${nonce === undefined ? '' : ` 'nonce-${nonce}'`}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `frame-src 'none'`,
    `frame-ancestors ${frameAncestors}`,
    `base-uri 'none'`,
    `form-action 'self'`,
  ].join('; ')
}

/**
 * Policy for the help page: the public one, but the portal may frame it.
 *
 * ⚠ Встраивание порталом разрешено, и это не ослабление ради удобства. В слайдере справка
 * открывается переходом внутри нашего `/app`, но при ПОЛНОЙ перезагрузке фрейма — после выката
 * Nuxt перезагружает страницу, у которой не догрузился кусок, — адресом документа становится
 * уже `/help`. С `frame-ancestors 'none'` браузер отказывался бы его рисовать, и человек видел бы
 * пустой слайдер. Секретов в справке нет: это тот же текст, что лежит в открытом `/llms.txt`.
 * Остальное — как у публичной страницы: без `unsafe-inline` и `unsafe-eval`. Нашли `/review`
 * и `/code-review` в PR #82.
 */
export function buildHelpPageCsp(nonce?: string): string {
  return buildPublicPageCsp(nonce, bitrix24Origins)
}

/**
 * Policy for JSON endpoints.
 *
 * JSON не рендерится, поэтому политика максимально узкая. Она нужна на случай, если
 * ответ всё же попробуют показать как страницу; портальная политика с `unsafe-eval`
 * и списком доменов здесь была бы не только лишней, но и вводящей в заблуждение.
 */
export const apiCsp = [
  `default-src 'none'`,
  `frame-ancestors 'none'`,
  `base-uri 'none'`,
].join('; ')

/**
 * Security headers for a given request path.
 *
 * Чистая функция, чтобы выбор политики можно было проверить тестом, не поднимая сервер.
 * Проставляет их `server/plugins/security-headers.ts`.
 */
export function securityHeadersFor(path: string, nonce?: string): Record<string, string> {
  const common = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // HSTS ставим сами, а не полагаемся на общий прокси: его настройки — не наша зона,
    // а без `includeSubDomains` заголовок слабее того, что был в своём nginx.
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  }

  if (path.startsWith('/api/')) {
    return { ...common, 'Content-Security-Policy': apiCsp }
  }
  if (path.startsWith('/s/')) {
    return { ...common, 'Content-Security-Policy': buildPublicPageCsp(nonce), 'X-Robots-Tag': 'noindex, nofollow' }
  }

  // Лендинг, справка и её текст для ИИ-помощника — страницы, которым в выдаче место. Политика
  // у них публичная, как у анкеты: без `unsafe-inline` и `unsafe-eval`. Справку вдобавок может
  // встроить портал — почему, разобрано у `buildHelpPageCsp`.
  if (isHelp(path)) {
    return { ...common, 'Content-Security-Policy': buildHelpPageCsp(nonce) }
  }
  if (isLanding(path) || isLlmsText(path)) {
    return { ...common, 'Content-Security-Policy': buildPublicPageCsp(nonce) }
  }

  // Всё остальное — страницы внутри портала: `/app`, `/install`, `/portal/**`.
  //
  // ⚠ `noindex` здесь обязателен, и это не перестраховка. У соседнего проекта служебная
  // страница без него ушла в индекс С МЕТА-ДАННЫМИ ЛЕНДИНГА — то есть по запросу про продукт
  // выдача показывала пустую панель, которая снаружи портала не работает в принципе.
  // Закрываем заголовком, а не `Disallow` в robots.txt: краулер, послушавший `Disallow`,
  // страницу не скачает, не увидит `noindex` и вполне может показать голый адрес
  // по внешней ссылке.
  return { ...common, 'Content-Security-Policy': portalCsp, 'X-Robots-Tag': 'noindex, nofollow' }
}

/**
 * Нужен ли этой странице nonce.
 *
 * ⚠ Ровно те же пути, что получают публичную политику, и ни одним больше. Портальные
 * страницы остаются на `unsafe-inline`, потому что он нужен самому Битрикс24, — а в CSP
 * эти две вещи ВЗАИМОИСКЛЮЧАЮЩИЕ: браузер игнорирует `unsafe-inline`, как только в политике
 * появился хоть один nonce. Добавив nonce «заодно и туда», мы бы молча погасили портальные
 * скрипты. Сужать портальную политику надо своей проверкой в живом портале (issue #2
 * говорит это прямым текстом).
 */
export function needsNonce(path: string): boolean {
  if (path.startsWith('/api/')) return false
  return path.startsWith('/s/') || isLanding(path) || isHelp(path)
}

/**
 * Путь без строки запроса, без хвостовой косой черты и в нижнем регистре.
 *
 * ⚠ Роутер Nuxt отдаёт одну и ту же страницу и по `/help/`, и по `/HELP`. Сравнивая путь как есть,
 * мы отдавали бы справку по `/help/` под ПОРТАЛЬНОЙ политикой — с `unsafe-inline` и `noindex`.
 * Нашёл `/review` в PR #82 — запросом к собранному приложению.
 */
function normalized(path: string): string {
  return (path.split('?')[0] ?? '').replace(/\/+$/, '').toLowerCase()
}

/**
 * Справка. Сравнение точное после нормализации: префиксом под «справку» попало бы что угодно,
 * что начинается с тех же букв.
 */
function isHelp(path: string): boolean {
  return normalized(path) === '/help'
}

/** Текст справки для ИИ-помощника. */
function isLlmsText(path: string): boolean {
  return normalized(path) === '/llms.txt'
}

/**
 * Лендинг — это корень и ничего больше.
 *
 * Сравнение точное, а не `startsWith`: с префиксом под лендинг попало бы всё приложение,
 * потому что с `/` начинается любой путь.
 */
function isLanding(path: string): boolean {
  const withoutQuery = path.split('?')[0] ?? ''
  return withoutQuery === '/' || withoutQuery === ''
}
