import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
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

describe('оба пути триггера доставляют приглашение делом в таймлайне (#126/#175)', () => {
  it.each(['server/api/b24/deal-update.post.ts', 'server/api/b24/robot.post.ts'])(
    '%s отдаёт ядру выписку через дело, а не фолбэк «только токен»',
    (path) => {
      // ⚠️ Без `issue` `handleDealTrigger` уходит в `issueWithoutDedup`: приглашение появляется в
      // базе, дела нет, сотрудник ссылку не видит. Ровно это и было дефектом робота (#175), и
      // снаружи оно неотличимо от «робот не сработал» — ни ошибки, ни пустого ответа.
      const src = stripComments(read(path))
      expect(src, `${path}: доставка не подключена`).toMatch(/issue:\s*\(ctx\)\s*=>\s*makeInviteIssue\(ctx/)
      // Выписка обязана писать в ТОТ ЖЕ портал, что и триггер: два независимых резолва разъехались
      // бы молча.
      expect(src, `${path}: выписка резолвит тенанта не тем же ключом`)
        .toMatch(/tenant:\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,300}tenantFor\(ctx\.memberId\)/)
    }
  )
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
