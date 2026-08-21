import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Гард ПРИВЯЗКИ ПОРТАЛА К ЗАПРОСУ (#47/#49) — по образцу `admin-gate.test.ts`.
 *
 * Зачем текстовый гард. Резолверы (`src/store/tenant.ts`, `portalIdByMemberId`, ETag) закрыты
 * исполняемыми тестами, но слой, где портал реально прикрепляется к запросу, — это `server/api/**`,
 * а он в проекте не покрывается вовсе (`vitest.config.ts` меряет `src/**`). Значит центральный
 * инвариант PR переживал собственный набор: замена `useApiFor(tenant.portalId)` на `useApi()` в
 * публичном роуте возвращает ровно тот cross-tenant дефект, ради которого всё делалось, и не роняет
 * ни одного теста. Проверка грубая — зато ловит именно эту правку.
 *
 * ⚠️ Ранних выходов «не нашли — нечего проверять» здесь нет НАМЕРЕННО: соседний гард
 * (`admin-gate`) один раз выродился именно так — искал `useStore(`, роуты переехали на `storeFor(`,
 * и три проверки стали `return`. Отсутствие ожидаемого вызова — ошибка.
 */

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')

/** Код без комментариев: иначе гард удовлетворяется упоминанием имени в прозе. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Публичные роуты: портал выводится из токена приглашения либо из ключа опроса. */
const PUBLIC_ROUTES = [
  'server/api/submit.post.ts',
  'server/api/survey/[key]/current.get.ts',
  'server/api/survey/[key]/invitation.get.ts'
]

describe('публичные роуты берут Api ПО ПОРТАЛУ запроса', () => {
  it.each(PUBLIC_ROUTES)('%s резолвит портал и тратит на это свой бюджет', (path) => {
    const src = stripComments(read(path))
    expect(src, `${path}: нет резолва портала`).toContain('resolvePublicPortal(')
    // Бюджет резолва — не украшение: лимитер ядра отрабатывает ПОЗЖЕ, и без 429 на этой ветке
    // анонимный запрос покупал бы себе обращение к базе до всякой защиты.
    expect(src, `${path}: отказ по частоте не обработан`).toMatch(/tenant\.reason === 'rate'/)
    expect(src, `${path}: отказ по частоте отвечает не 429`).toMatch(/'rate'[\s\S]{0,120}429/)
  })

  // ⚠️ Роут ПРОВЕРКИ ССЫЛКИ сюда не входит НАМЕРЕННО: он требует токен, поэтому `ok:false` там значит
  // «такого токена нет ни у кого», и отвечать своим текстом нельзя (см. комментарий в самом роуте).
  it.each(['server/api/submit.post.ts', 'server/api/survey/[key]/current.get.ts'])(
    '%s отказывает на неоднозначном ключе',
    (path) => {
      const src = stripComments(read(path))
      expect(src, `${path}: неоднозначный ключ обслуживается`).toMatch(/if\s*\(\s*!tenant\.ok[\s\S]{0,60}\)\s*\{[\s\S]{0,200}AMBIGUOUS_/)
    }
  )

  it.each(PUBLIC_ROUTES)('%s не берёт общий Api на процесс', (path) => {
    const src = stripComments(read(path))
    expect(src, `${path}: Api берётся мимо портала запроса`).toMatch(/useApiFor\(\s*tenant\./)
    expect(src, `${path}: остался общий Api на процесс`).not.toMatch(/\buseApi\(\)/)
  })

  it.each(PUBLIC_ROUTES)('%s резолвит портал ДО обращения к Api', (path) => {
    const src = stripComments(read(path))
    expect(src.indexOf('resolvePublicPortal(')).toBeLessThan(src.indexOf('useApiFor('))
  })
})

describe('кэш публичной версии опроса скоуплен порталом', () => {
  const path = 'server/api/survey/[key]/current.get.ts'

  it('ETag считается С ПОРТАЛОМ', () => {
    // Без портала один ETag обозначал бы разные анкеты: адрес у порталов общий, значит и запись в
    // кэше браузера одна — второй респондент получил бы 304 и увидел анкету первого.
    expect(stripComments(read(path))).toMatch(/cacheDecision\([\s\S]{0,200}tenant\.portalId\s*\)/)
  })

  it('ответ помечен private — общий кэш его хранить не вправе', () => {
    expect(stripComments(read(path)), 'снято `private`: CDN/корп-прокси отдаст анкету чужого арендатора')
      .toContain("'private, no-cache'")
  })
})

describe('страница опроса передаёт токен как ключ арендатора', () => {
  const path = 'app/pages/s/[key].vue'

  it('запрос текущей версии несёт токен', () => {
    // Без него анкету по ключу, который завели два заказчика, выбрать нечем — и приглашённые ОБОИХ
    // получат «опрос доступен только по личной ссылке», пока соседний запрос отвечает «ссылка годна».
    const src = stripComments(read(path))
    expect(src).toMatch(/current`[\s\S]{0,300}INVITATION_TOKEN_PARAM/)
  })

  it('ключи useAsyncData включают токен', () => {
    // Общий ключ на два портала = один кэш Nuxt на две разные анкеты.
    const src = stripComments(read(path))
    expect(src).toContain('`survey:${surveyKey.value}:${invitationToken.value ?? \'\'}`')
    expect(src).toContain('`invitation:${surveyKey.value}:${invitationToken.value ?? \'\'}`')
  })
})

describe('роуты Bitrix24 берут тенанта по подтверждённому member_id', () => {
  it('виджет карточки сделки — по порталу, подтверждённому verifyFrameAuth', () => {
    const src = stripComments(read('server/api/b24/deal-invite.post.ts'))
    expect(src).toMatch(/tenantByMemberId\(\s*portal\.portalId\s*\)/)
    expect(src, 'остался общий стор на процесс').not.toMatch(/\buseStore\(\)/)
    expect(src, 'остались общие приглашения на процесс').not.toMatch(/\buseInvitations\(\)/)
    // Портал подтверждён, а строки нет — отказ, а не «запишем куда-нибудь».
    expect(src).toMatch(/if\s*\(\s*!tenant\s*\)/)
  })

  it.each(['server/api/b24/deal-update.post.ts', 'server/api/b24/robot.post.ts'])(
    '%s отдаёт ядру РЕЗОЛВЕР, а не готовый стор',
    (path) => {
      const src = stripComments(read(path))
      expect(src, `${path}: тенант не передан резолвером`).toMatch(/tenant:\s*tenant(For|ByMemberId)/)
      expect(src, `${path}: остался общий стор на процесс`).not.toMatch(/\buseStore\(\)/)
      expect(src, `${path}: остались общие приглашения на процесс`).not.toMatch(/\buseInvitations\(\)/)
    }
  )

  it('выписка приглашения резолвит тенанта ТЕМ ЖЕ member_id, что и триггер', () => {
    // Разойдясь, триггер и выписка ушли бы в разные порталы: дело создалось бы в одной CRM, а
    // приглашение записалось бы в данные другой.
    const src = stripComments(read('server/api/b24/deal-update.post.ts'))
    expect(src).toMatch(/tenant:\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,300}tenantFor\(ctx\.memberId\)/)
  })
})

/**
 * Триггер-роуты, обязанные доставлять приглашение делом. Список строится ИЗ ФАЙЛОВОЙ СИСТЕМЫ, а не
 * перечислением: `src/bitrix24/trigger.ts` прямо предупреждает, что новый вход (лид, смарт-процесс)
 * молча унаследует фолбэк `issueWithoutDedup` и оставит тесты зелёными. Захардкоженный список этого
 * не заметил бы — а так новый раннер роняет гард в момент появления.
 */
const B24_ROUTES_DIR = 'server/api/b24'
const CORE_DIR = 'src/bitrix24'

/**
 * Ядровые раннеры триггера — те, кто зовёт `handleDealTrigger`. Имена не перечисляем: они разные
 * (`runDealUpdate`, `runRobotTrigger`) и следующий будет третьим.
 */
const TRIGGER_RUNNERS = readdirSync(resolve(process.cwd(), CORE_DIR))
  .filter((f) => f.endsWith('.ts') && f !== 'trigger.ts')
  .flatMap((f) => {
    const src = stripComments(read(`${CORE_DIR}/${f}`))
    if (!/\bhandleDealTrigger\s*\(/.test(src)) return []
    return [...src.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g)].map((m) => m[1] as string)
  })

const TRIGGER_ROUTES = readdirSync(resolve(process.cwd(), B24_ROUTES_DIR))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => `${B24_ROUTES_DIR}/${f}`)
  .filter((routePath) => {
    const src = stripComments(read(routePath))
    return TRIGGER_RUNNERS.some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(src))
  })
  .sort()

describe('оба пути триггера доставляют приглашение делом в таймлайне (#126/#175)', () => {
  it('список охраняемых роутов — ровно те, что зовут раннер триггера', () => {
    // ⚠️ Assert-«перепись», а не документация: он падает, когда появляется третий вход, и заставляет
    // осознанно решить, доставляет тот дело или нет. Пустой список означал бы гард, охраняющий ничто.
    expect(TRIGGER_RUNNERS.sort()).toEqual(['runDealUpdate', 'runRobotTrigger'])
    expect(TRIGGER_ROUTES).toEqual([
      'server/api/b24/deal-update.post.ts',
      'server/api/b24/robot.post.ts'
    ])
  })

  it.each(TRIGGER_ROUTES)(
    '%s отдаёт ядру выписку через дело, а не фолбэк «только токен»',
    (path) => {
      // ⚠️ Без `issue` `handleDealTrigger` уходит в `issueWithoutDedup`: приглашение появляется в
      // базе, дела нет, сотрудник ссылку не видит. Ровно это и было дефектом робота (#175), и
      // снаружи оно неотличимо от «робот не сработал» — ни ошибки, ни пустого ответа.
      //
      // ⚠️ Имя параметра берётся ЗАХВАТОМ (`\1`), а не литералом `ctx`. Первая редакция гарда
      // требовала буквального `(ctx) =>` и краснела на четырёх безобидных правках — `c` вместо `ctx`,
      // стрелка без скобок (`stylistic`-пресет в проекте выключен намеренно, значит это легальная
      // форма), тело блоком, вынос в переменную. Сообщение при этом врало о причине и учило
      // следующего ослаблять регулярку, а не чинить код.
      const src = stripComments(read(path))
      expect(src, `${path}: issue не строится из makeInviteIssue с тем же ctx`)
        .toMatch(/issue:\s*\(?(\w+)\)?\s*=>\s*\{?\s*(?:return\s+)?makeInviteIssue\(\1\b/)
      // ⚠️ Проверяем ПРОИСХОЖДЕНИЕ имени. Локальная заглушка `const makeInviteIssue = …`, возвращающая
      // `undefined`, типобезопасна, линт-чиста и проходила прежний гард — а дела в таймлайне нет.
      expect(src, `${path}: makeInviteIssue не из общего модуля выписки`)
        .toMatch(/import\s*\{[^}]*\bmakeInviteIssue\b[^}]*\}\s*from\s*'[^']*utils\/invite-issue'/)
      // Выписка обязана писать в ТОТ ЖЕ портал, что и триггер: два независимых резолва разъехались
      // бы молча.
      expect(src, `${path}: выписка резолвит тенанта не тем же ключом`)
        .toMatch(/tenant:\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,300}tenantFor\(ctx\.memberId\)/)
      // ⚠️ И клиента портала — тоже мемоизированной функцией по `member_id`. Именно `portalClient`
      // решает, в ЧЬЮ CRM ляжет дело со снимком сделки: подмена его на фиксированное замыкание
      // прежний гард проходила, а покрытия у `server/**` нет вовсе.
      expect(src, `${path}: клиент портала не берётся по member_id запроса`)
        .toMatch(/makeInviteIssue\(\w+,\s*\{[\s\S]{0,200}\bportalClient,/)
      // ⚠️ Очередь «поиск → создание» ОДНА на процесс. Заведи её внутри обработчика — у каждого
      // события будет своя, и она перестанет что-либо значить; оба роута несут об этом абзац, но
      // держалось это исключительно на внимательности ревьюера.
      expect(src, `${path}: сериализатор выписки не на уровне модуля`)
        .toMatch(/^const \w+ = createKeySerializer\(\)$/m)
      expect(src, `${path}: сериализатор создаётся внутри обработчика`)
        .not.toMatch(/defineEventHandler[\s\S]*createKeySerializer\(/)
    }
  )
})

describe('ручной путь виджета не обходит защиту от дублей (#176)', () => {
  const PATH = 'server/api/b24/deal-invite.post.ts'

  it('роут выписывает через `manualInvite`, а не голым `createSurveyInvitation`', () => {
    // ⚠️ Именно голый `createSurveyInvitation` и был дефектом #176: он не смотрит, не висит ли уже
    // открытое дело-приглашение по этой сделке, и дела не создаёт — вторая ссылка появлялась молча и
    // в дедупе не участвовала вовсе. Снаружи это неотличимо от нормальной работы: ответ 200 со
    // ссылкой в обоих случаях. Покрытия у `server/**` нет, поэтому проверка структурная.
    const src = stripComments(read(PATH))
    expect(src, 'выписка не идёт через manualInvite').toMatch(/\bmanualInvite\(/)
    expect(src, 'manualInvite не из общего модуля выписки')
      .toMatch(/import\s*\{[^}]*\bmanualInvite\b[^}]*\}\s*from\s*'[^']*utils\/manual-invite'/)
    expect(src, 'вернулась прямая выписка мимо проверки «уже приглашали»')
      .not.toMatch(/\bcreateSurveyInvitation\(/)
  })

  it('«всё равно создать новую» приходит ОТ КЛИЕНТА и только явным true', () => {
    // ⚠️ Сервер не решает за человека. Но и доверять произвольному значению нельзя: `force` из тела
    // сравнивается с `true`, иначе строка «false» из form-urlencoded включила бы обход дедупа.
    const src = stripComments(read(PATH))
    expect(src).toMatch(/force[\s\S]{0,160}===\s*true/)
  })

  it('выписка пишет в стор и приглашения ПОДТВЕРЖДЁННОГО портала', () => {
    // ⚠️ Здесь стояла ещё проверка `manualInvite(… client,` под именем «тот же клиент, которым
    // читается сделка». Она ложна в ОБЕ стороны: доказывала лишь то, что переменная называется
    // `client` (подстановка второго клиента с чужим доменом её проходила), и краснела на безобидном
    // переименовании и на выносе deps в переменную. Гард, который врёт о причине, учит следующего
    // ослаблять регулярку — поэтому утверждение снято, а не «подкручено».
    const src = stripComments(read(PATH))
    expect(src).toMatch(/store:\s*tenant\.store/)
    expect(src).toMatch(/invitations:\s*tenant\.invitations/)
    expect(src).toMatch(/portalId:\s*portal\.portalId/)
  })

  it('контракт роут↔виджет держится с ОБЕИХ сторон', () => {
    // ⚠️ Обе половины снимались незаметно. `force` вычислялся, но не доезжал до `manualInvite`
    // (typecheck молчит — поле необязательное), и кнопка «Всё равно создать новую» становилась
    // мёртвой: сколько ни жми, ответ один. А переименуй сервер `alreadyInvited` — виджет ветку не
    // узнает и покажет ошибку вместо честного «уже приглашали». Ровно тот класс дефекта, про который
    // предупреждает JSDoc `inviteActionParams`: расхождение имён молча даёт второе приглашение.
    const route = stripComments(read(PATH))
    const widget = stripComments(read('app/pages/b24/deal-widget.vue'))
    expect(route, 'force не доезжает до выписки').toMatch(/manualInvite\([\s\S]{0,300}\bforce\b/)
    for (const [name, field] of [['alreadyInvited', 'alreadyInvited'], ['activityMissing', 'activityMissing']] as const) {
      expect(route, `сервер не отдаёт ${name}`).toMatch(new RegExp(`\\b${field}\\b`))
      expect(widget, `виджет не читает ${name}`).toMatch(new RegExp(`\\b${field}\\b`))
    }
    // «Уже приглашали» — это 200, а не 4xx: человек всё сделал правильно.
    expect(route).not.toMatch(/alreadyInvited[\s\S]{0,200}setResponseStatus/)
  })
})

describe('страница результата читает данные ПОДТВЕРЖДЁННОГО портала (#18)', () => {
  const PATH = 'server/api/b24/result.post.ts'

  it('портал подтверждается фрейм-токеном, запись ищется в его сторе', () => {
    // ⚠️ `responseId` НЕ секрет: он лежит в `actionParams` кнопки, то есть виден всем, кто видит
    // сделку, а в PgStore это bigint — перебор тривиален. Пустить по нему одному значило бы отдать
    // свободный текст клиента и снимок сделки любому менеджеру любого портала.
    const src = stripComments(read(PATH))
    expect(src, 'портал не подтверждается').toMatch(/verifyFrameAuth\(/)
    expect(src, 'тенант берётся не по подтверждённому порталу')
      .toMatch(/tenantByMemberId\(\s*portal\.portalId\s*\)/)
    expect(src, 'чтение мимо тенанта').toMatch(/tenant\.store\.getResponse\(/)
    expect(src, 'остался общий стор на процесс').not.toMatch(/\buseStore\(\)/)
  })

  it('«не найдено» и «чужой портал» отвечают ОДИНАКОВО', () => {
    // ⚠️ Разница между ними — это ответ на вопрос «а есть ли такой ответ у кого-то ещё», который
    // спрашивающему задавать не положено. Отдельная ветка «есть, но не ваш» была бы оракулом.
    const src = stripComments(read(PATH))
    expect(src).toMatch(/if\s*\(\s*!record\s*\)/)
    expect(src, 'появилась отдельная ветка про чужой портал').not.toMatch(/portalId\s*!==|foreign|чужой портал/i)
  })

  it('версия берётся ТА, по которой отвечал клиент', () => {
    // Опрос могли переиздать между выпиской ссылки и ответом. Собери мы экран из текущей версии —
    // менеджер увидел бы правдоподобную, но неверную страницу: формулировки одной редакции против
    // ответов другой. Несовпадение ловит `buildResultView`, здесь — что ему дают нужную версию.
    const src = stripComments(read(PATH))
    expect(src).toMatch(/getVersion\(\s*record\.surveyKey\s*,\s*record\.versionNo\s*\)/)
    expect(src).toMatch(/buildResultView\(/)
  })
})

describe('удаление приложения сбрасывает оба кэша', () => {
  it('uninstall чистит и стор, и клиентов порталов', () => {
    // Клиент портала живёт до минуты своим кэшем: без сброса удалённый портал ещё это время получал
    // бы вызовы по уже отозванному гранту.
    const src = stripComments(read('server/api/b24/install.post.ts'))
    expect(src).toContain('resetStoreCache()')
    expect(src).toContain('dropCachedPortalClients()')
  })
})

describe('анти-абьюз и закрытие дела скоуплены правильно', () => {
  it('лимитер и nonce — ОБЩИЕ на все порталы', () => {
    // Раздельные счётчики означали бы обход лимита чередованием порталов; а свой nonce-стор у
    // каждого `Api` рвал бы поток «/api/session минтит → /api/submit расходует».
    const src = stripComments(read('server/utils/api.ts'))
    expect(src).toMatch(/limiter:\s*sharedLimiter\(\)[\s\S]{0,120}nonces:\s*sharedNonces\(\)/)
  })

  it('хук закрытия дела получает портал ответа', () => {
    const src = stripComments(read('server/utils/api.ts'))
    expect(src).toMatch(/onAnswered:\s*onAnsweredHookFor\(portalId\)/)
  })

  it('клиент портала и очередь рефреша ключуются порталом', () => {
    const src = stripComments(read('server/utils/portal-deps.ts'))
    expect(src, 'кэш клиента снова один на процесс').toContain('cachedByPortal')
    expect(src, 'очередь рефреша общая — медленный портал держит остальных')
      .toMatch(/portalQueue\.run\(`portal-client:\$\{forPortalId \?\? 'default'\}`/)
  })
})
