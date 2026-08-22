import { DEFAULT_TOMBSTONE_DAYS, MAX_TOMBSTONE_DAYS, resolveTombstoneDays } from '../src/bitrix24/portal'
import { describe, expect, it, vi } from 'vitest'
import {
  parseInstallEvent,
  installToTokens,
  installToB24Params,
  surveyRobotParams,
  surveyPlacements,
  parsePlacementDealId,
  parsePlacementEntityId,
  handleInstall,
  integrationCalls,
  SURVEY_ROBOT_CODE,
  PLACEMENT_DEAL_ACTIVITY,
  PLACEMENT_ANALYTICS_MENU
} from '../src/bitrix24/install'
import { TRIGGER_MODES, type TriggerMode } from '../src/bitrix24/trigger-mode'
import type { OAuthTokens } from '../src/bitrix24/oauth'

const validRaw = {
  event: 'ONAPPINSTALL',
  auth: {
    access_token: 'AT-1',
    refresh_token: 'RT-1',
    expires_in: '3600',
    member_id: 'm-abc',
    domain: 'acme.bitrix24.ru',
    application_token: 'app-tok-xyz',
    client_endpoint: 'https://acme.bitrix24.ru/rest/'
  }
}

describe('parseInstallEvent — event-формат ONAPPINSTALL (#17)', () => {
  it('валидный POST → нормализованный InstallAuth', () => {
    const e = parseInstallEvent(validRaw)
    expect(e?.memberId).toBe('m-abc')
    expect(e?.expiresIn).toBe(3600)
    expect(e?.applicationToken).toBe('app-tok-xyz')
    expect(e?.accessToken).toBe('AT-1')
  })
  it('нет токена/мусор → null', () => {
    expect(parseInstallEvent({ auth: { ...validRaw.auth, access_token: '' } })).toBeNull()
    expect(parseInstallEvent({ auth: undefined })).toBeNull()
    expect(parseInstallEvent('garbage')).toBeNull()
  })
})

describe('parseInstallEvent — install-страница (плоские поля) (#17)', () => {
  it('AUTH_ID/REFRESH_ID/DOMAIN/member_id → InstallAuth (app_token опционален)', () => {
    const e = parseInstallEvent({
      DOMAIN: 'acme.bitrix24.ru',
      AUTH_ID: 'AT-page',
      REFRESH_ID: 'RT-page',
      AUTH_EXPIRES: '3600',
      member_id: 'm-page',
      status: 'L'
    })
    expect(e).toMatchObject({ accessToken: 'AT-page', refreshToken: 'RT-page', memberId: 'm-page', domain: 'acme.bitrix24.ru', expiresIn: 3600 })
    expect(e?.applicationToken).toBeUndefined() // install-страница его не шлёт
  })
  it('AUTH_EXPIRES отсутствует → дефолт 3600', () => {
    const e = parseInstallEvent({ DOMAIN: 'a.bitrix24.ru', AUTH_ID: 'x', REFRESH_ID: 'y', member_id: 'm' })
    expect(e?.expiresIn).toBe(3600)
  })
})

describe('installToTokens (#17)', () => {
  it('маппит в OAuthTokens + applicationToken; expiresAt из expires_in', () => {
    const now = new Date('2026-06-20T10:00:00.000Z')
    const t = installToTokens(parseInstallEvent(validRaw)!, now)
    expect(t).toMatchObject({
      memberId: 'm-abc',
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      domain: 'acme.bitrix24.ru',
      applicationToken: 'app-tok-xyz'
    })
    expect(t.expiresAt).toBe('2026-06-20T11:00:00.000Z') // now + 3600s
  })
})

describe('installToB24Params (#17)', () => {
  it('полный auth → B24OAuthParams', () => {
    const ev = parseInstallEvent({
      auth: { ...validRaw.auth, user_id: '1', scope: 'crm,bizproc', status: 'L', server_endpoint: 'https://oauth.bitrix.info/rest/' }
    })!
    const p = installToB24Params(ev)
    expect(p).toMatchObject({
      memberId: 'm-abc',
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      applicationToken: 'app-tok-xyz',
      userId: 1,
      scope: 'crm,bizproc',
      status: 'L'
    })
  })
  it('минимальный auth → дефолты (clientEndpoint/serverEndpoint/status/userId)', () => {
    const p = installToB24Params(parseInstallEvent(validRaw)!, new Date('2026-06-20T10:00:00.000Z'))
    expect(p.clientEndpoint).toBe('https://acme.bitrix24.ru/rest/')
    expect(p.serverEndpoint).toBe('https://oauth.bitrix.info/rest/')
    expect(p.status).toBe('L')
    expect(p.userId).toBe(0)
    expect(p.expires).toBe(Math.floor(new Date('2026-06-20T10:00:00.000Z').getTime() / 1000) + 3600)
  })
})

describe('surveyRobotParams (#17)', () => {
  it('робот на сделках с нашим HANDLER и стабильным CODE', () => {
    const p = surveyRobotParams('https://polls.bx-shef.by/api/b24/robot')
    expect(p.CODE).toBe(SURVEY_ROBOT_CODE)
    expect(p.HANDLER).toBe('https://polls.bx-shef.by/api/b24/robot')
    expect(p.DOCUMENT_TYPE).toEqual(['crm', 'CCrmDocumentDeal', 'DEAL'])
    expect(p.USE_SUBSCRIPTION).toBe('N')
  })
})

describe('surveyPlacements (#17)', () => {
  it('виджет сделки + дашборд в аналитике, HANDLER на нашем домене', () => {
    const ps = surveyPlacements('https://polls.bx-shef.by/')
    expect(ps.map((p) => p.PLACEMENT)).toEqual([PLACEMENT_DEAL_ACTIVITY, PLACEMENT_ANALYTICS_MENU])
    // хвостовой слеш baseUrl убран, HANDLER абсолютный https
    expect(ps[0]!.HANDLER).toBe('https://polls.bx-shef.by/b24/deal-widget')
    expect(ps[1]!.HANDLER).toBe('https://polls.bx-shef.by/b24/dashboard')
    expect(ps[0]!.LANG_ALL?.ru?.TITLE).toBe('Опрос по сделке')
  })
})

describe('parsePlacementEntityId (общий)', () => {
  it('перебирает ключи-кандидаты по порядку, берёт первый валидный', () => {
    expect(parsePlacementEntityId('{"LEAD_ID":"5"}', ['leadId', 'LEAD_ID', 'ID'])).toBe(5)
    expect(parsePlacementEntityId({ ID: 9 }, ['ID'])).toBe(9)
  })
  it('первый ключ невалиден (0) или undefined → fall-through к следующему валидному', () => {
    expect(parsePlacementEntityId({ leadId: 0, ID: 7 }, ['leadId', 'ID'])).toBe(7)
    expect(parsePlacementEntityId({ leadId: undefined, ID: 7 }, ['leadId', 'ID'])).toBe(7)
    expect(parsePlacementEntityId({ leadId: null, ID: 7 }, ['leadId', 'ID'])).toBe(7) // паритет с ??
  })
  it('битый JSON / не объект / нет валидных ключей → undefined', () => {
    expect(parsePlacementEntityId('{nope', ['ID'])).toBeUndefined()
    expect(parsePlacementEntityId(42, ['ID'])).toBeUndefined()
    expect(parsePlacementEntityId({ X: 1 }, ['ID'])).toBeUndefined()
  })
})

describe('parsePlacementDealId (#17)', () => {
  it('JSON-строка {"ID":"3473"} → 3473', () => {
    expect(parsePlacementDealId('{"ID":"3473"}')).toBe(3473)
  })
  it('объект {ID:5} → 5', () => {
    expect(parsePlacementDealId({ ID: 5 })).toBe(5)
  })
  it('битый JSON / нет ID / 0 / мусор → undefined', () => {
    expect(parsePlacementDealId('{not json')).toBeUndefined()
    expect(parsePlacementDealId('{"X":1}')).toBeUndefined()
    expect(parsePlacementDealId('{"ID":"0"}')).toBeUndefined()
    expect(parsePlacementDealId(null)).toBeUndefined()
  })
})

describe('integrationCalls — что регистрируем по режиму триггера (#122)', () => {
  const BASE = 'https://polls.example.com'
  const methods = (mode: TriggerMode): string[] => integrationCalls(mode, BASE).map((c) => c.method)

  it('event (дефолт) → только подписка на событие, робота нет', () => {
    expect(methods('event')).toEqual(['event.bind', 'placement.bind', 'placement.bind'])
  })

  it('robot → только робот, подписки на событие нет', () => {
    expect(methods('robot')).toEqual(['bizproc.robot.add', 'placement.bind', 'placement.bind'])
  })

  it('ГЛАВНОЕ: два пути НИКОГДА не регистрируются вместе — ни при каком режиме', () => {
    // Это и есть защита от двух приглашений на один переход — регресс здесь стоит клиенту дубля.
    // ⚠️ Перебор по ВСЕМУ списку режимов, а не по паре литералов: значение `both` снято вместе с #175
    // (оба пути сразу = два дела с разными ключами перехода), и добавленный режим обязан пройти ту же
    // проверку, иначе защита вернётся к «мы же помним».
    for (const mode of TRIGGER_MODES) {
      const m = methods(mode)
      expect(m.includes('event.bind') && m.includes('bizproc.robot.add'), mode).toBe(false)
      expect(m.includes('event.bind') || m.includes('bizproc.robot.add'), mode).toBe(true)
    }
  })

  it('плейсменты регистрируются при любом режиме (виджет и дашборд от триггера не зависят)', () => {
    for (const mode of TRIGGER_MODES) {
      expect(methods(mode).filter((m) => m === 'placement.bind')).toHaveLength(2)
    }
  })

  it('единственный путь помечен soleTrigger — его провал нельзя проглотить как пропуск встройки', () => {
    expect(integrationCalls('event', BASE).find((c) => c.method === 'event.bind')?.soleTrigger).toBe(true)
    expect(integrationCalls('robot', BASE).find((c) => c.method === 'bizproc.robot.add')?.soleTrigger).toBe(true)
    // ⚠️ `soleTrigger` у пути триггера сегодня всегда `true` (режимов два, включён ровно один), но
    // признак остаётся ВЫВОДИМЫМ: появись комбинированный режим — ответ поменяется сам, а
    // захардкоженное `true` соврало бы, и провал одной из двух регистраций логировался бы как
    // «авто-триггер мёртв».
    for (const mode of TRIGGER_MODES) {
      const trigger = integrationCalls(mode, BASE).filter((c) => c.method !== 'placement.bind')
      expect(trigger.filter((c) => c.soleTrigger), mode).toHaveLength(1)
    }
    // плейсменты — никогда не триггер
    expect(integrationCalls('event', BASE).filter((c) => c.method === 'placement.bind').every((c) => !c.soleTrigger)).toBe(true)
  })

  it('HANDLER-адреса строятся от baseUrl и переживают хвостовой слэш', () => {
    const withSlash = integrationCalls('event', `${BASE}/`)
    expect(withSlash.find((c) => c.method === 'event.bind')?.params).toMatchObject({
      handler: `${BASE}/api/b24/deal-update`
    })
    expect(JSON.stringify(withSlash)).not.toContain('//api/b24')
  })
})

describe('handleInstall — оркестрация (#17)', () => {
  it('сохраняет токены, ЗАТЕМ регистрирует встройки (порядок)', async () => {
    const order: string[] = []
    const saveTokens = vi.fn(async (_t: OAuthTokens) => {
      order.push('save')
    })
    const registerIntegrations = vi.fn(async (_t: OAuthTokens) => {
      order.push('register')
    })
    const tokens = await handleInstall(parseInstallEvent(validRaw)!, { saveTokens, registerIntegrations })
    expect(order).toEqual(['save', 'register']) // регистрация после сохранения
    expect(saveTokens).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'm-abc', applicationToken: 'app-tok-xyz' }))
    expect(registerIntegrations).toHaveBeenCalledWith(tokens)
  })
})

describe('parseInstallEvent — момент события для тумбстоун-гарда', () => {
  const eventBody = (over: Record<string, unknown> = {}) => ({
    event: 'ONAPPINSTALL',
    ts: '1700000000',
    auth: {
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
      member_id: 'm1',
      domain: 'p.bitrix24.ru',
      application_token: 'at'
    },
    ...over
  })

  it('берёт top-level ts события — он лежит РЯДОМ с auth, а не внутри', () => {
    // Без него опоздавший ONAPPINSTALL воскрешает портал, который пользователь уже удалил.
    expect(parseInstallEvent(eventBody())?.eventTs).toBe(1700000000)
  })

  it('ts из БУДУЩЕГО прижимается к нашему «сейчас»', () => {
    // Сравниваются часы разных машин. Значение из будущего и обходило бы гард, и НАВСЕГДА сносило
    // тумбстоун (`delete … where deleted_ts < eventTs`) — то есть выключало защиту одним событием.
    const nowSec = 1800000000
    expect(parseInstallEvent(eventBody({ ts: 4000000000 }), nowSec)?.eventTs).toBe(nowSec)
    expect(parseInstallEvent(eventBody({ ts: String(nowSec + 3600) }), nowSec)?.eventTs).toBe(nowSec)
  })

  it('булево и hex не считаются временем', () => {
    // Общая коэрсия zod даёт из `true` единицу, а из `'0x10'` — 16: «валидные» числа из мусора.
    // С ts=1 любой тумбстоун блокировал бы установку.
    const nowSec = 1800000000
    for (const ts of [true, '0x10', '1e9', ' 17 ']) {
      expect(parseInstallEvent(eventBody({ ts }), nowSec)?.eventTs, String(ts)).toBe(nowSec)
    }
  })

  it('нет ts, мусор или ноль → текущее время, а не пропуск гарда', () => {
    // Гард должен работать в любом случае: `undefined` выключил бы его целиком, а огромный ts снёс бы
    // тумбстоун навсегда и открыл дорогу воскрешению.
    const nowSec = 1800000000
    // Пустая строка и 0 — отдельно важны: zod-коэрсия даёт из них 0, а с ts=0 гард блокировал бы
      // ЛЮБУЮ установку (deleted_ts >= 0 истинно всегда).
    for (const ts of [undefined, 'позавчера', 9e15, -1, '', 0, '0']) {
      expect(parseInstallEvent(eventBody({ ts }), nowSec)?.eventTs, String(ts)).toBe(nowSec)
    }
  })

  it('install-СТРАНИЦА: своего ts нет → текущее время', () => {
    // Там человек нажал «Установить» сейчас. Настоящая переустановка обязана снять устаревший
    // тумбстоун, иначе он лежал бы до истечения TTL.
    const page = { AUTH_ID: 'a', REFRESH_ID: 'r', member_id: 'm1', DOMAIN: 'p.bitrix24.ru' }
    expect(parseInstallEvent(page, 1800000000)?.eventTs).toBe(1800000000)
  })

  it('БОЕВОЙ формат портала: событие приходит bracket-формой', async () => {
    // Bitrix шлёт события формой с bracket-нотацией, и h3 отдаёт ПЛОСКИЕ ключи `auth[access_token]`.
    // Без `parseBracketForm` event-формат установки не распознавался вовсе — настоящий ONAPPINSTALL
    // уходил в 400. Тест на «красивом» вложенном объекте этого не ловил.
    const { parseBracketForm } = await import('../src/bitrix24/bracket-form')
    const wire = 'event=ONAPPINSTALL&ts=1700000000&auth%5Baccess_token%5D=a&auth%5Brefresh_token%5D=r'
      + '&auth%5Bexpires_in%5D=3600&auth%5Bmember_id%5D=m1&auth%5Bdomain%5D=p.bitrix24.ru'
    const flat = Object.fromEntries(new URLSearchParams(wire))

    expect(parseInstallEvent(flat, 1800000000), 'сырое тело портала не должно распознаваться').toBeNull()
    const parsed = parseInstallEvent(parseBracketForm(flat), 1800000000)
    expect(parsed?.memberId).toBe('m1')
    expect(parsed?.eventTs).toBe(1700000000)
  })

  it('роут install разбирает bracket-форму ДО парса установки', async () => {
    // Гард по исходнику: `server/**` юнит-тестами не покрывается, а без этого шага событийная
    // установка отвечает 400 — и обнаружилось бы только на живом портале.
    const src = await routeSource()
    expect(src).toMatch(/parseInstallEvent\(parseBracketForm\(/)
  })

  it('роут install передаёт `eventTs` в save — тумбстоун-гард живёт на боевом пути', async () => {
    // Гард по исходнику: `server/**` юнит-тестами не покрывается. Сам гард (`eventTs` против
    // тумбстоуна) проверяется исполнением в `uninstall-erases-pii.test.ts`; здесь — связка «роут
    // действительно им пользуется». Опций присвоения больше НЕТ (снято, см. шапку того же файла).
    const src = await routeSource()
    expect(src).toMatch(/eventTs: verifiedAuth\.eventTs/)
    expect(src).toMatch(/tokenStore\.save\(tokens,\s*opts\)/)
    // И то, что отказ гарда ОСТАНАВЛИВАЕТ установку: иначе получается хуже, чем без гарда —
    // токенов нет, а встройки регистрируются и в лог идёт «установка завершена».
    expect(src).toMatch(/throw new InstallStale/)
  })

  it('роут сбрасывает кэш стора после clean-uninstall', async () => {
    // Без сброса инстанс остаётся с портальным id удалённой строки: каждая запись падает на FK, а
    // переустановка без рестарта не лечит (у новой строки НОВЫЙ id). И всё это тихо — `/api/health`
    // остаётся зелёным.
    const src = await routeSource()
    // Между вызовами стоит развёрнутое объяснение — сверяем порядок, а не близость.
    expect(src.indexOf('resetStoreCache()')).toBeGreaterThan(src.indexOf('store.deletePortal('))
    expect(src).toMatch(/resetStoreCache\(\)/)
  })
})

describe('resolveTombstoneDays', () => {
  it('дефолт, клэмп и деградация мусора', () => {
    // Занижение до нуля выключило бы гард целиком, завышение на годы вернуло бы вечную строку на
    // каждый навсегда удалённый портал — обе крайности гасим.
    expect(resolveTombstoneDays(undefined)).toBe(DEFAULT_TOMBSTONE_DAYS)
    expect(resolveTombstoneDays('дней сорок')).toBe(DEFAULT_TOMBSTONE_DAYS)
    expect(resolveTombstoneDays('0')).toBe(DEFAULT_TOMBSTONE_DAYS)
    expect(resolveTombstoneDays('-5')).toBe(DEFAULT_TOMBSTONE_DAYS)
    expect(resolveTombstoneDays('7')).toBe(7)
    expect(resolveTombstoneDays('7.9')).toBe(7)
    expect(resolveTombstoneDays('99999')).toBe(MAX_TOMBSTONE_DAYS)
  })
})

/** Исходник роута установки без комментариев: гард не должен удовлетворяться прозой. */
async function routeSource(): Promise<string> {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  return readFileSync(fileURLToPath(new URL('../server/api/b24/install.post.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
