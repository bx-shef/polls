import { describe, expect, it } from 'vitest'
import {
  surveyKeyForEntity,
  surveyRoutingFromEnv,
  DEFAULT_SURVEY_KEY
} from '../src/bitrix24/survey-routing'

describe('surveyKeyForEntity', () => {
  it('берёт ключ из routing для заданной сущности', () => {
    expect(surveyKeyForEntity('task', { task: 'task_csat', deal: 'deal_nps' })).toBe('task_csat')
    expect(surveyKeyForEntity('deal', { task: 'task_csat', deal: 'deal_nps' })).toBe('deal_nps')
  })
  it('падает на дефолт, если сущности нет в routing', () => {
    expect(surveyKeyForEntity('lead', { task: 'task_csat' })).toBe(DEFAULT_SURVEY_KEY)
    expect(surveyKeyForEntity('deal')).toBe(DEFAULT_SURVEY_KEY)
  })
  it('пустое/пробельное значение трактуется как незаданное', () => {
    expect(surveyKeyForEntity('task', { task: '   ' })).toBe(DEFAULT_SURVEY_KEY)
    expect(surveyKeyForEntity('task', { task: '' })).toBe(DEFAULT_SURVEY_KEY)
  })
  it('кастомный fallback', () => {
    expect(surveyKeyForEntity('lead', {}, 'my_default')).toBe('my_default')
  })
  it('пробельный fallback → системный дефолт (страховка прямого вызова)', () => {
    expect(surveyKeyForEntity('lead', {}, '   ')).toBe(DEFAULT_SURVEY_KEY)
  })
  it('неизвестный entityType (cast) → fallback', () => {
    expect(surveyKeyForEntity('totally_unknown' as never, { deal: 'x' })).toBe(DEFAULT_SURVEY_KEY)
  })
  it('обрезает пробелы у ключа', () => {
    expect(surveyKeyForEntity('task', { task: '  task_csat  ' })).toBe('task_csat')
  })
})

describe('surveyRoutingFromEnv', () => {
  it('собирает SURVEY_KEY_<ENTITY> для всех сущностей', () => {
    const { routing } = surveyRoutingFromEnv({
      SURVEY_KEY_DEAL: 'd',
      SURVEY_KEY_LEAD: 'l',
      SURVEY_KEY_SPA: 's',
      SURVEY_KEY_CONTACT: 'c',
      SURVEY_KEY_COMPANY: 'co',
      SURVEY_KEY_TASK: 't'
    })
    expect(routing).toEqual({ deal: 'd', lead: 'l', spa: 's', contact: 'c', company: 'co', task: 't' })
  })
  it('имя env строго UPPERCASE — строчное не подхватывается', () => {
    expect(surveyRoutingFromEnv({ SURVEY_KEY_deal: 'x' }).routing).toEqual({})
  })
  it('SURVEY_KEY_DEFAULT переопределяет дефолт (с trim)', () => {
    expect(surveyRoutingFromEnv({ SURVEY_KEY_DEFAULT: '  global  ' }).fallback).toBe('global')
  })
  it('пустой SURVEY_KEY_DEFAULT → системный дефолт', () => {
    expect(surveyRoutingFromEnv({ SURVEY_KEY_DEFAULT: '' }).fallback).toBe(DEFAULT_SURVEY_KEY)
  })
  it('пустые/пробельные/отсутствующие — пропускаются', () => {
    const { routing } = surveyRoutingFromEnv({ SURVEY_KEY_DEAL: '  ', SURVEY_KEY_LEAD: '' })
    expect(routing).toEqual({})
  })
  it('end-to-end: env → routing → ключ для задачи', () => {
    const { routing, fallback } = surveyRoutingFromEnv({ SURVEY_KEY_TASK: 'task_done' })
    expect(surveyKeyForEntity('task', routing, fallback)).toBe('task_done')
    expect(surveyKeyForEntity('deal', routing, fallback)).toBe(DEFAULT_SURVEY_KEY)
  })
})
