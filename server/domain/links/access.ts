/**
 * Decides what a visitor arriving with a link token is allowed to do.
 *
 * Отдельной чистой функцией, а не условиями внутри роута, по той же причине, что и разбор
 * установки: статусную машину ссылки надо проверять вызовом функции, а не подъёмом сервера
 * с базой. Здесь же собрано всё, что видно посетителю, — а посетитель этот посторонний
 * человек, не сотрудник портала.
 */

/** Состояния ссылки. Порядок жизненный: выпущена → отправлена → открыта → пройдена. */
export type LinkStatus = 'created' | 'sent' | 'opened' | 'completed' | 'revoked' | 'expired'

/** То, что лежит у нас в кэш-индексе. Самого токена здесь нет и быть не может. */
export interface LinkRecord {
  status: LinkStatus
  expiresAt: Date
}

/**
 * Почему анкета не открылась.
 *
 * Причина нужна, чтобы показать человеку осмысленный текст: «ссылка устарела» и «вы уже
 * ответили» — разные новости, и обе лучше, чем страница об ошибке. Наружу уходит именно
 * причина, а не то, нашлась ли запись: иначе перебор различал бы существующие токены
 * от несуществующих по тексту ответа.
 */
export type LinkDenial = 'unknown' | 'expired' | 'completed' | 'revoked' | 'not-sent'

export type LinkAccess
  = | { allow: true, status: LinkStatus, answered: false }
    | { allow: false, reason: LinkDenial }

/**
 * Можно ли по этой ссылке открыть анкету и ответить.
 *
 * ⚠ Ответы принимаются ТОЛЬКО в состояниях `sent` и `opened`. Выпущенная, но не отправленная
 * ссылка ещё не у клиента: если по ней кто-то пришёл, значит токен утёк или угадан, и открывать
 * анкету нельзя, даже когда срок в порядке.
 *
 * Срок проверяется раньше статуса намеренно: истёкшая ссылка истекла, в каком бы состоянии
 * её ни застали, и объяснение про срок для человека полезнее, чем любое другое.
 */
export function decideLinkAccess(link: LinkRecord | null, now: Date): LinkAccess {
  if (link === null) return { allow: false, reason: 'unknown' }
  if (link.status === 'revoked') return { allow: false, reason: 'revoked' }
  if (link.status === 'completed') return { allow: false, reason: 'completed' }
  if (link.expiresAt.getTime() <= now.getTime()) return { allow: false, reason: 'expired' }
  if (link.status === 'expired') return { allow: false, reason: 'expired' }
  if (link.status !== 'sent' && link.status !== 'opened') return { allow: false, reason: 'not-sent' }
  return { allow: true, status: link.status, answered: false }
}

/**
 * Состояние, в которое переходит ссылка, когда её открыли.
 *
 * `sent → opened` и больше ничего: повторное открытие уже открытой ссылки состояние не меняет,
 * иначе в отчёте «открыта» превратилась бы в счётчик перезагрузок страницы.
 */
export function statusAfterOpen(status: LinkStatus): LinkStatus {
  return status === 'sent' ? 'opened' : status
}

/**
 * Тексты для посетителя.
 *
 * Лежат в домене, а не в разметке, потому что это часть поведения: что именно узнаёт человек,
 * пришедший по нерабочей ссылке, — решение продуктовое, и проверяется оно тестом.
 * Никаких подробностей про портал, сделку и клиента: страницу видит посторонний.
 */
export const DENIAL_MESSAGES: Record<LinkDenial, { title: string, detail: string }> = {
  'unknown': {
    title: 'Ссылка не найдена',
    detail: 'Проверьте, что адрес скопирован целиком. Если ссылку прислали недавно, '
      + 'попросите отправить её ещё раз.',
  },
  'expired': {
    title: 'Срок ссылки истёк',
    detail: 'Анкета была доступна ограниченное время. Попросите прислать новую ссылку — '
      + 'ваши ответы по-прежнему важны.',
  },
  'completed': {
    title: 'Анкета уже заполнена',
    detail: 'Мы получили ваши ответы, спасибо. Повторно заполнить эту анкету нельзя.',
  },
  'revoked': {
    title: 'Ссылка отозвана',
    detail: 'Эта ссылка больше не действует. Если анкету всё ещё ждут от вас, '
      + 'вам пришлют новую.',
  },
  'not-sent': {
    title: 'Ссылка ещё не действует',
    detail: 'Эта анкета пока не отправлена. Дождитесь письма со ссылкой.',
  },
}
