import { describe, expect, it, vi } from 'vitest'
import { resolveFeedbackConfig, postFeedbackIssue, type FetchLike } from '../src/api/feedback'

const CONFIG = { token: 'ghp_fake_token_value_0000000000', repo: 'owner/private-inbox' }
const PAYLOAD = { title: 'заголовок', body: 'тело', labels: ['user-feedback'] }

describe('resolveFeedbackConfig — fail-closed', () => {
  it('токен + валидный репозиторий → канал включён', () => {
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: 't', GITHUB_FEEDBACK_REPO: 'owner/repo' })).toEqual({
      token: 't',
      repo: 'owner/repo'
    })
  })

  it('нет токена → выключен', () => {
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_REPO: 'owner/repo' })).toBeNull()
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: '   ', GITHUB_FEEDBACK_REPO: 'owner/repo' })).toBeNull()
  })

  it('ГЛАВНОЕ: репозиторий не дефолтится — не задан или битый → выключен', () => {
    // Иначе свободный текст сотрудника уехал бы в репозиторий, который никто не выбирал.
    for (const repo of [undefined, '', '  ', 'owner', 'owner/repo/extra', 'own er/repo', 'owner/repo;rm']) {
      expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: 't', GITHUB_FEEDBACK_REPO: repo }), String(repo)).toBeNull()
    }
  })

  it('пробелы по краям обрезаются', () => {
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: ' t ', GITHUB_FEEDBACK_REPO: ' owner/repo ' })).toEqual({
      token: 't',
      repo: 'owner/repo'
    })
  })
})

describe('postFeedbackIssue — отправка', () => {
  it('201 → успех с номером issue', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => ({ status: 201, json: async () => ({ number: 42 }) }))
    await expect(postFeedbackIssue(CONFIG, PAYLOAD, fetchFn)).resolves.toEqual({ ok: true, status: 201, retryable: false, number: 42 })
  })

  it('201 без номера в ответе → всё равно успех', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => ({ status: 201, json: async () => ({}) }))
    await expect(postFeedbackIssue(CONFIG, PAYLOAD, fetchFn)).resolves.toEqual({ ok: true, status: 201, retryable: false })
  })

  it('битый JSON в успешном ответе не роняет отправку', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => ({ status: 201, json: async () => { throw new Error('не JSON') } }))
    await expect(postFeedbackIssue(CONFIG, PAYLOAD, fetchFn)).resolves.toMatchObject({ ok: true })
  })

  it('ошибки настройки/прав — повтор не поможет', async () => {
    for (const status of [401, 403, 404, 422]) {
      const fetchFn = vi.fn<FetchLike>(async () => ({ status, json: async () => ({}) }))
      await expect(postFeedbackIssue(CONFIG, PAYLOAD, fetchFn)).resolves.toMatchObject({ ok: false, status, retryable: false })
    }
  })

  it('временные сбои помечены как повторяемые', async () => {
    for (const status of [429, 500, 502, 503]) {
      const fetchFn = vi.fn<FetchLike>(async () => ({ status, json: async () => ({}) }))
      await expect(postFeedbackIssue(CONFIG, PAYLOAD, fetchFn)).resolves.toMatchObject({ ok: false, retryable: true })
    }
  })

  it('сбой сети → status 0, повторяемо; текст ошибки НАРУЖУ не отдаётся', async () => {
    // Ошибка undici содержит полный URL, а в нём — путь к приватному репозиторию.
    const fetchFn = vi.fn<FetchLike>(async () => {
      throw new Error('connect ECONNREFUSED https://api.github.com/repos/owner/private-inbox/issues')
    })
    const res = await postFeedbackIssue(CONFIG, PAYLOAD, fetchFn)
    expect(res).toEqual({ ok: false, status: 0, retryable: true })
    expect(JSON.stringify(res)).not.toContain('private-inbox')
  })

  it('токен уходит в заголовке, а не в адресе', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => ({ status: 201, json: async () => ({ number: 1 }) }))
    await postFeedbackIssue(CONFIG, PAYLOAD, fetchFn)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://api.github.com/repos/owner/private-inbox/issues')
    expect(url).not.toContain(CONFIG.token)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CONFIG.token}`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(PAYLOAD)
  })
})
