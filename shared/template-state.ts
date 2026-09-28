/**
 * Whether a template version must not change: published, or published once and retired since.
 *
 * ⚠ Снятая с публикации — тоже неизменяема: по ней уже выпускали ссылки и собирали ответы.
 * «Снял с публикации, поправил, вернул» склеило бы две разные анкеты под одним номером.
 *
 * ⚠ ЛЕЖИТ В `shared/`, потому что правило одно на две стороны: сервер отказывает в правке
 * (`template-save.post.ts`, `template-publish.post.ts`), а вкладка конструктора прячет кнопки.
 * Две копии разошлись бы при первом новом неизменяемом состоянии: вкладка показала бы версию
 * правимой, а сервер отказал бы в сохранении. Нашёл `/review` в третьем круге панели PR #93.
 */
export function isFrozen(state: string | undefined): boolean {
  return state === 'published' || state === 'retired'
}
