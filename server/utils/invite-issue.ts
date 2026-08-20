// Сборка «как выписывать приглашение» для событийного пути (#126 + #138) — отдельным модулем, а не
// замыканием внутри роута.
//
// Причина техническая: пока эта работа жила в `defineEventHandler`, её нельзя было исполнить в тесте
// вовсе — а именно здесь сходятся правило, портал и наш стор. «Гроздь событий даёт одно дело»,
// «упало создание дела — живого токена не остаётся», «маркер не виден поиску» проверялись только
// глазами по диффу. Теперь это обычная функция с внедрёнными зависимостями.
import {
  activityConfigurableAdd, activityListByMarker, buildSurveyInviteActivity, ensureActivityMarker
} from '~core/bitrix24/activity'
import type { PortalClient } from '~core/bitrix24/client'
import { deliverInvite } from '~core/bitrix24/invite-delivery'
import type { KeySerializer } from '~core/api/serial-by-key'
import type { InvitationStore } from '~core/api/invitation'
import type { IssueInvitation } from '~core/bitrix24/trigger'
import type { IStore } from '~core/store/types'
import { surveyPath } from '~core/client/invitation-link'

/** Что нужно выписке, кроме самого события. Всё внедряется — модуль ничего не резолвит сам. */
export interface InviteIssueDeps {
  /** Клиент нужного портала по `member_id` (из проверенной части события). */
  portalClient: (memberId: string) => Promise<PortalClient>
  invitations: InvitationStore
  /** Из стора нужен один вопрос: отвечал ли клиент по сделке после перехода. */
  store: Pick<IStore, 'hasResponseSince'>
  /** Очередь «поиск → создание» — ОДНА на процесс, иначе она ничего не значит. */
  serializer: KeySerializer
  /** База абсолютной ссылки (`APP_DOMAIN`/`DOMAIN`); пустая — ссылка выйдет относительной. */
  baseUrl: string
  log: {
    info: (event: string, fields: Record<string, unknown>) => void
    warn: (event: string, fields: Record<string, unknown>) => void
  }
}

/**
 * Построить выписку приглашения для ОДНОГО подтверждённого перехода.
 *
 * ⚠️ Без ключа перехода, момента перехода или сделки в контексте приглашение НЕ выписывается.
 * Раньше здесь работал фолбэк «выписать как раньше» — но доставка теперь и есть дело в таймлайне, а
 * создаётся оно только на пути с маркером. Тот токен был живой ссылкой со снимком CRM (там ПДн),
 * которую никто никогда не увидит, и появлялся он на КАЖДОЕ событие грозди. Молчание с явной
 * строкой в логе честнее.
 */
export function makeInviteIssue(
  ctx: { transition: { id?: string; at?: Date }; memberId: string },
  deps: InviteIssueDeps
): IssueInvitation {
  const { transition, memberId } = ctx
  return async (args) => {
    const dealId = args.context.dealId
    const undeliverable =
      transition.id === undefined ? 'нет ID перехода'
      : transition.at === undefined ? 'нет момента перехода'
      : dealId === undefined ? 'нет сделки в контексте'
      : undefined
    if (transition.id === undefined || transition.at === undefined || dealId === undefined) {
      deps.log.warn('b24_invite_undelivered', { surveyKey: args.surveyKey, reason: undeliverable })
      return undefined
    }
    const transitionAt = transition.at

    const client = await deps.portalClient(memberId)
    let issued: { token: string } | undefined
    const out = await deliverInvite(transition.id, args.surveyKey, {
      serializer: deps.serializer,
      // ⚠️ Ключ очереди префиксуется порталом. ID записей истории стадий у каждого портала свои и
      // мелкие, так что совпадение ключей двух порталов — штатное дело: без префикса медленный REST
      // одного портала держал бы очередь другого.
      serialKeyPrefix: memberId,
      findByMarker: (marker) => activityListByMarker(client, marker, dealId),
      // Точка отсчёта — момент ЭТОГО перехода: прошлогодний ответ не должен закрывать новый повод
      // спросить, если сделка прошла стадию второй раз.
      answeredAfterTransition: () => deps.store.hasResponseSince(args.surveyKey, dealId, transitionAt),
      createInvite: async (marker) => {
        const inv = await deps.invitations.create(
          { surveyKey: args.surveyKey, versionNo: args.versionNo, context: args.context, ttlMs: args.ttlMs },
          args.now
        )
        try {
          const activityId = await activityConfigurableAdd(client, buildSurveyInviteActivity({
            dealId,
            surveyTitle: args.title,
            surveyKey: args.surveyKey,
            token: inv.token,
            surveyUrl: `${deps.baseUrl}${surveyPath(args.surveyKey, inv.token)}`,
            ...(args.context.responsibleId != null ? { responsibleId: args.context.responsibleId } : {}),
            marker
          }))
          // Токен объявляем выписанным ТОЛЬКО когда дело создано: наружу он идёт как «приглашение
          // отправлено», а отправляет его именно дело.
          issued = { token: inv.token }
          return activityId
        } catch (e) {
          // ⚠️ Порядок вынужденный: ссылка в деле строится из токена, значит токен рождается первым.
          // Не создалось дело — приглашение осталось бы живым, но недостижимым: ссылка со снимком CRM
          // (там ПДн), которую никто никогда не увидит, и по одной на КАЖДОЕ событие грозди. Гасим
          // сразу: `consume` помечает токен использованным, ссылка мертва. Ошибку гашения глотаем —
          // исходную важнее не потерять.
          await deps.invitations
            .consume(inv.token, { surveyKey: args.surveyKey, versionNo: args.versionNo }, args.now)
            .catch(() => undefined)
          deps.log.warn('b24_invite_activity_fail', {
            surveyKey: args.surveyKey, dealId, detail: (e as Error).message
          })
          throw e
        }
      },
      ensureMarker: (activityId, marker) => ensureActivityMarker(client, activityId, marker)
    })

    if (out.kind === 'skipped') {
      deps.log.info('b24_invite_dedup', {
        surveyKey: args.surveyKey, dealId, reason: out.reason, marker: out.marker.originId
      })
      return undefined
    }
    // Две строки-ответа на два вопроса, которые вебхуком не проверить, и обе читаются на первом прогоне:
    //  `markerFix`     — принял ли `configurable.add` поля маркера (`already`), пришлось ли дописывать
    //                    (`repaired`) или дописать НЕ вышло (`failed`);
    //  `markerVisible` — видит ли поиск по маркеру только что созданное дело. `no` означает, что защита
    //                    от дублей не работает вовсе, и без этой строки она выглядела бы работающей.
    const level = out.markerFix === 'failed' || out.markerVisible === 'no' ? 'warn' : 'info'
    deps.log[level]('b24_invite_activity', {
      surveyKey: args.surveyKey,
      dealId,
      activityId: out.activityId,
      markerFix: out.markerFix,
      markerVisible: out.markerVisible
    })
    return issued ? { surveyKey: args.surveyKey, versionNo: args.versionNo, token: issued.token } : undefined
  }
}
