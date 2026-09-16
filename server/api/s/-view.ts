import type { SurveyTemplate } from '../../domain/surveys/model'

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
  type: 'scale' | 'text' | 'date'
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
