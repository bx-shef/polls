/**
 * A published survey as `/api/portal/surveys` sends it: what to choose by, without the schema.
 *
 * ⚠ Форма ответа — ОДНА на сервер и страницы, а не описание в каждом потребителе. Прежде её
 * описывали трижды — сервер, вкладка сделки и главный экран, — и переименованное на сервере поле
 * вкладка получила бы молча как `undefined` в строке «версия · разделы · вопросы». Общий тип делает
 * такое расхождение ошибкой компиляции. Нашёл `/code-review` в PR #89.
 */
export interface SurveyChoice {
  code: string
  version: number
  title: string
  /** How many sections the version has. */
  sections: number
  /** How many questions all sections have together. */
  questions: number
}
