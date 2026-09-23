import type { SurveyHeader } from '../../domain/invitations/portal-calls'
import type { SurveyQuestionType, SurveyTemplate } from '../../domain/surveys/model'

/**
 * The survey as the respondent is allowed to see it.
 *
 * Отдельный тип, а не доменная модель целиком, и это не про удобство. Респонденту незачем
 * знать, КАК считается балл: веса вопросов, признак «идёт в оценку» и диапазоны
 * интерпретации — внутренняя кухня клиента. Отдав их, мы бы, во-первых, показали
 * постороннему человеку настройки чужой компании, а во-вторых, подсказали бы, на какие
 * вопросы отвечать «правильно», чтобы вытянуть балл.
 *
 * Заодно это разводит формат провода и доменную модель: анкета на портале может обрасти
 * полями, и страница не обязана меняться следом.
 *
 * Имя файла с дефиса — соглашение Nitro: такой файл не становится роутом.
 */

export interface PublicQuestion {
  key: string
  title: string
  /** Тот же набор, что в модели: расхождение здесь тайпчек ловит на маппинге, но лучше не заводить. */
  type: SurveyQuestionType
  /** Границы шкалы — только у балльных вопросов. */
  scale?: { min: number, max: number }
}

export interface PublicSection {
  key: string
  title: string
  questions: PublicQuestion[]
}

export interface PublicSurvey {
  title: string
  sections: PublicSection[]
}

/**
 * Шапка страницы: кто спрашивает, кого и по какому проекту.
 *
 * ⚠ Всё это СНИМОК, сделанный при выпуске ссылки, а не текущее состояние портала. Публичная
 * страница в портал не ходит по инварианту, и это не ограничение, с которым мирятся, а то,
 * что делает шапку честной: через месяц сделку переименуют, а человек отвечал вот на это.
 *
 * ⚠ Пустые строки НЕ выбрасываются здесь: решение «не рисовать строку» принимает страница,
 * и держать это знание в двух местах незачем.
 */
export interface PublicHeader {
  company: string
  project: string
  respondent: string
  manager: string
  /** Момент выпуска, ISO. Формат для человека выбирает страница, а не сервер. */
  issuedAt: string
}

/**
 * Отдать шапку наружу.
 *
 * ⚠ Ссылка без шапки — законный случай, а не поломка: её выпустили до появления снимка,
 * либо портал не отдал ни одной из трёх сущностей, либо ссылку уже закрыли и шапку стёрли.
 * Во всех трёх страница просто показывает название анкеты и вопросы.
 */
export function toPublicHeader(header: SurveyHeader | null, issuedAt: Date): PublicHeader | null {
  if (header === null) return null
  return {
    company: header.company,
    project: header.project,
    respondent: header.respondent,
    manager: header.manager,
    issuedAt: issuedAt.toISOString(),
  }
}

/** Отдать анкету наружу, оставив внутреннее внутри. */
export function toPublicSurvey(template: SurveyTemplate): PublicSurvey {
  return {
    title: template.title,
    sections: template.sections.map(section => ({
      key: section.key,
      title: section.title,
      questions: section.questions.map(question => ({
        key: question.key,
        title: question.title,
        type: question.type,
        ...(question.scale === undefined ? {} : { scale: question.scale }),
      })),
    })),
  }
}
