import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientIp, parseIp, isInternalIp, resolveTrustedProxies, MAX_TRUSTED_PROXIES, UNKNOWN_IP } from '../src/api/client-ip'

/**
 * Два способа сломать анти-абьюз, и оба тихие:
 *  — взять адрес сокета за прокси: все клиенты схлопываются в один счётчик, лимит становится общим;
 *  — поверить первому адресу в `X-Forwarded-For`: ключ лимитера пишет сам отправитель запроса.
 * Тесты держат обе границы.
 */
describe('clientIp', () => {
  it('без доверенных прокси заголовок игнорируется целиком', () => {
    // Прямое подключение: `X-Forwarded-For` мог прислать кто угодно, верить ему нечего.
    expect(clientIp({ socketIp: '203.0.113.7', forwardedFor: '9.9.9.9' })).toBe('203.0.113.7')
    expect(clientIp({ socketIp: '203.0.113.7', forwardedFor: '9.9.9.9', trustedProxies: 0 })).toBe('203.0.113.7')
  })

  it('за одним прокси берётся адрес, который дописал прокси', () => {
    expect(clientIp({ socketIp: '10.0.0.2', forwardedFor: '203.0.113.7', trustedProxies: 1 }))
      .toBe('203.0.113.7')
  })

  it('подделка гасится: клиентская часть цепочки не берётся', () => {
    // Клиент прислал `9.9.9.9`, наш nginx дописал реальный адрес справа.
    expect(clientIp({ socketIp: '10.0.0.2', forwardedFor: '9.9.9.9, 203.0.113.7', trustedProxies: 1 }))
      .toBe('203.0.113.7')
    // Сколько бы адресов он ни насыпал — берём ровно один хоп от достоверного конца.
    expect(clientIp({
      socketIp: '10.0.0.2',
      forwardedFor: '1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7',
      trustedProxies: 1
    })).toBe('203.0.113.7')
  })

  it('за двумя прокси отступ на два хопа', () => {
    expect(clientIp({
      socketIp: '10.0.0.2',
      forwardedFor: '9.9.9.9, 203.0.113.7, 10.0.0.9',
      trustedProxies: 2
    })).toBe('203.0.113.7')
  })

  it('цепочка короче ожидаемой → сокет, а не чужая строка', () => {
    // Прокси не дописал заголовок (или запрос пришёл в обход) — берём то, что достоверно.
    expect(clientIp({ socketIp: '10.0.0.2', trustedProxies: 1 })).toBe('10.0.0.2')
    expect(clientIp({ socketIp: '10.0.0.2', forwardedFor: '', trustedProxies: 2 })).toBe('10.0.0.2')
  })

  it('мусор в заголовке не становится ключом', () => {
    // Иначе `X-Forwarded-For: <строка>` давала бы отправителю свой личный счётчик.
    expect(clientIp({ socketIp: '10.0.0.2', forwardedFor: 'не-адрес', trustedProxies: 1 })).toBe('10.0.0.2')
    expect(clientIp({ socketIp: '10.0.0.2', forwardedFor: '<script>', trustedProxies: 1 })).toBe('10.0.0.2')
    expect(clientIp({ socketIp: '10.0.0.2', forwardedFor: 'a'.repeat(300), trustedProxies: 1 })).toBe('10.0.0.2')
  })

  it('повтор заголовка склеивается в одну цепочку', () => {
    // Node отдаёт повторяющийся заголовок массивом; порядок хопов при этом сохраняется.
    expect(clientIp({ socketIp: '10.0.0.2', forwardedFor: ['9.9.9.9', '203.0.113.7'], trustedProxies: 1 }))
      .toBe('203.0.113.7')
  })

  it('ключ стабилен: порт снимается, регистр приводится', () => {
    // Иначе один клиент получал бы новый счётчик на каждое соединение — лимит не работал бы вовсе.
    expect(clientIp({ socketIp: '203.0.113.7:51514' })).toBe('203.0.113.7')
    // Ключ канонический, а не «красивый»: важно, что одна и та же подсеть даёт одну строку.
    expect(clientIp({ socketIp: '[2001:DB8::1]' })).toBe('2001:db8:0:0::/64')
    expect(clientIp({ socketIp: '2001:DB8::1' })).toBe('2001:db8:0:0::/64')
    expect(clientIp({ socketIp: '  203.0.113.7  ' })).toBe('203.0.113.7')
  })

  it('нет ничего пригодного → отдельная строка, а не пустая', () => {
    // Пустой ключ склеил бы всех «неопознанных» с любым другим пустым ключом.
    expect(clientIp({})).toBe(UNKNOWN_IP)
    expect(clientIp({ socketIp: '' })).toBe(UNKNOWN_IP)
    expect(clientIp({ socketIp: 'мусор' })).toBe(UNKNOWN_IP)
  })
})

describe('resolveTrustedProxies', () => {
  it('нормальные значения', () => {
    expect(resolveTrustedProxies('1')).toBe(1)
    expect(resolveTrustedProxies('2')).toBe(2)
  })

  it('не задано, мусор, ноль и отрицательное → 0 (заголовок игнорируется)', () => {
    // Fail-safe в МЕНЬШУЮ сторону: завышенное число заставит взять адрес левее реального клиента,
    // то есть подконтрольный ему, и лимит станет обходимым. Заниженное лишь схлопнет счётчик.
    for (const raw of [undefined, '', 'два', '0', '-1', '1.5', 'NaN']) {
      expect(resolveTrustedProxies(raw), String(raw)).toBe(0)
    }
  })

  it('больше максимума ОТВЕРГАЕТСЯ, а не прижимается к границе', () => {
    // Прижать `11` к `4` значило бы молча принять опасное значение: лишний хоп уводит ключ в
    // клиентскую часть заголовка. Опечатка должна выключать доверие, а не «почти работать».
    expect(MAX_TRUSTED_PROXIES).toBe(4)
    expect(resolveTrustedProxies('4')).toBe(4)
    expect(resolveTrustedProxies('5')).toBe(0)
    expect(resolveTrustedProxies('99')).toBe(0)
  })

  it('распознаётся только десятичная запись', () => {
    // `Number()` слишком либерален: `0x2` и `1e0` — не то, что оператор написал в .env осознанно.
    for (const raw of ['0x2', '1e0', '+1', '01x', '１']) {
      expect(resolveTrustedProxies(raw), raw).toBe(0)
    }
    expect(resolveTrustedProxies(' 1 ')).toBe(1) // пробелы по краям — норма для .env-файла
  })
})

describe('clientIp — доверие адресу сокета', () => {
  it('публичный сокет = запрос пришёл мимо прокси → заголовок не читается', () => {
    // Самый неприятный путь: приложение доступно напрямую (сосед по общей docker-сети, запуск без
    // nginx на Vibecode, скопированный не туда .env). Число хопов от этого не спасает — спасает то,
    // что подключился НЕ наш прокси.
    expect(clientIp({ socketIp: '203.0.113.9', forwardedFor: '9.9.9.9', trustedProxies: 1 }))
      .toBe('203.0.113.9')
  })

  it('внутренние адреса считаются своим прокси', () => {
    for (const ip of ['127.0.0.1', '10.0.0.2', '172.18.0.5', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1']) {
      expect(isInternalIp(parseIp(ip) ?? ''), ip).toBe(true)
    }
  })

  it('публичные — нет', () => {
    for (const ip of ['203.0.113.7', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1']) {
      expect(isInternalIp(parseIp(ip) ?? ''), ip).toBe(false)
    }
  })
})

describe('clientIp — цепочка короче заявленного числа хопов', () => {
  it('НЕ дотягивается до клиентской части заголовка', () => {
    // Раньше кламп к нулю отдавал самый левый элемент — тот, что написал отправитель запроса.
    // Это ровно то, что шапка модуля называет недопустимым, и самый вероятный симптом опечатки
    // в TRUSTED_PROXIES.
    expect(clientIp({ socketIp: '10.0.0.2', forwardedFor: '9.9.9.9', trustedProxies: 2 }))
      .toBe('10.0.0.2')
    expect(clientIp({ socketIp: '10.0.0.2', forwardedFor: '9.9.9.9, 8.8.8.8', trustedProxies: 4 }))
      .toBe('10.0.0.2')
  })

  it('без адреса сокета доверять нечему', () => {
    expect(clientIp({ forwardedFor: '9.9.9.9', trustedProxies: 1 })).toBe(UNKNOWN_IP)
  })
})

describe('parseIp — один хост даёт один ключ', () => {
  it('IPv4-mapped разворачивается в обычный IPv4', () => {
    // Форма Node на dual-stack сокете. Без разворота один клиент считался бы двумя ключами,
    // а при строгой проверке — улетал в «неопознанные», то есть в общий счётчик.
    expect(parseIp('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(parseIp('[::ffff:203.0.113.7]:5555')).toBe('203.0.113.7')
    expect(parseIp('::ffff:10.0.0.2')).toBe('10.0.0.2')
  })

  it('IPv6 схлопывается до /64', () => {
    // Клиенту выдают целую подсеть: лимит «по адресу» в ней не значит ничего, а таблица ключей
    // лимитера набивается мгновенно.
    expect(parseIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(parseIp('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64')
    // Разные записи одного адреса — один ключ.
    expect(parseIp('2001:0db8:0:0:0:0:0:1')).toBe(parseIp('2001:db8::1'))
    expect(parseIp('[2001:DB8::1]')).toBe(parseIp('2001:db8::1'))
    expect(parseIp('fe80::1%eth0')).toBe(parseIp('fe80::1'))
  })

  it('hex-слово адресом не считается', () => {
    // Прежняя грубая проверка пропускала любое hex-слово: `X-Forwarded-For: dead, beef` давало ключ.
    for (const junk of ['deadbeef', 'abc', 'cafe', 'face', '999.999.999.999', '1.2.3', '', 'мусор']) {
      expect(parseIp(junk), junk).toBeNull()
    }
  })
})

/**
 * Гард: роуты обязаны брать адрес через единую точку. Иначе новый роут, написанный по старому
 * образцу, тихо вернёт поломку — а `server/**` в этом проекте юнит-тестами не покрывается.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))
function listRoutes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listRoutes(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
  )
}

describe('роуты берут адрес клиента только через requestIp', () => {
  it('ни один роут не зовёт getRequestIP напрямую', () => {
    const routes = listRoutes(join(ROOT, 'server/api'))
    expect(routes.length).toBeGreaterThan(8)
    for (const f of routes) {
      const code = readFileSync(f, 'utf8')
      expect(code.includes('getRequestIP('), `${f}: адрес сокета в обход requestIp`).toBe(false)
    }
  })
})
