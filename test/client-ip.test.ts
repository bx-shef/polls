import { describe, it, expect } from 'vitest'
import { clientIp, resolveTrustedProxies, MAX_TRUSTED_PROXIES, UNKNOWN_IP } from '../src/api/client-ip'

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
    expect(clientIp({ socketIp: '[2001:DB8::1]' })).toBe('2001:db8::1')
    expect(clientIp({ socketIp: '2001:DB8::1' })).toBe('2001:db8::1')
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

  it('абсурдно большое клампится', () => {
    expect(resolveTrustedProxies('99')).toBe(MAX_TRUSTED_PROXIES)
  })
})
