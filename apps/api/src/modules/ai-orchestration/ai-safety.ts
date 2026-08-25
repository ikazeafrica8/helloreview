import { createHash } from 'node:crypto'

export const AI_CONTENT_BOUNDARY = Object.freeze({
  start: 'BEGIN_UNTRUSTED_PARTICIPANT_TEXT_JSON_V1',
  end: 'END_UNTRUSTED_PARTICIPANT_TEXT_JSON_V1',
})

export type InjectionSignal =
  'IGNORE_POLICY' | 'ROLE_OVERRIDE' | 'HIDDEN_POLICY_REQUEST' | 'TOOL_OR_DATABASE_REQUEST' | 'PROTECTED_STATE_FIELD'

export type TextRedaction = 'EMAIL' | 'PHONE' | 'URL'
export type DeterministicPriority = 'none' | 'human_takeover' | 'opt_out'

export type PreprocessedParticipantText = Readonly<{
  inputHash: string
  modelText: string
  normalizedText: string
  priority: DeterministicPriority
  injectionSignals: readonly InjectionSignal[]
  redactions: readonly TextRedaction[]
}>

const injectionPatterns: readonly Readonly<{ signal: InjectionSignal; pattern: RegExp }>[] = [
  {
    signal: 'IGNORE_POLICY',
    pattern: /(ignore|disregard).{0,24}(previous|prior|system)|이전.{0,12}(지시|규칙).{0,8}(무시|삭제)/iu,
  },
  {
    signal: 'ROLE_OVERRIDE',
    pattern: /(you are now|act as).{0,24}(admin|system)|너는.{0,20}(관리자|시스템)|역할.{0,8}(변경|바꿔)/iu,
  },
  {
    signal: 'HIDDEN_POLICY_REQUEST',
    pattern: /(system prompt|developer message|hidden policy|시스템 프롬프트|숨겨진 지침)/iu,
  },
  {
    signal: 'TOOL_OR_DATABASE_REQUEST',
    pattern: /(execute|run).{0,16}(tool|sql)|도구.{0,8}실행|데이터베이스.{0,12}(조회|수정|삭제)|drop\s+table/iu,
  },
  {
    signal: 'PROTECTED_STATE_FIELD',
    pattern: /(selectionState|consentState|reservationState|businessApprovalState|guidelineState)/u,
  },
]

const optOutPattern =
  /(수신\s*거부|메시지\s*(그만|중지)|연락(을)?\s*(그만|하지\s*마)|구독\s*취소|차단해|unsubscribe|stop\s+messaging)/iu
const humanTakeoverPattern =
  /(상담원|담당자|직원|사람).{0,12}(연결|상담|바꿔|통화)|사람과\s*(대화|상담)|human\s*(agent|support)|불만|항의|신고|사기|분쟁|개인정보.{0,12}(삭제|열람|수정|정정)|내\s*정보.{0,12}(삭제|열람|수정|정정)/iu

const redact = (text: string): Readonly<{ text: string; kinds: readonly TextRedaction[] }> => {
  const kinds = new Set<TextRedaction>()
  let redacted = text.replace(/https?:\/\/[^\s]+/giu, () => {
    kinds.add('URL')
    return '[URL]'
  })
  redacted = redacted.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, () => {
    kinds.add('EMAIL')
    return '[EMAIL]'
  })
  redacted = redacted.replace(/(?:\+82[-\s]?10|010)[-\s]?\d{3,4}[-\s]?\d{4}/gu, () => {
    kinds.add('PHONE')
    return '[PHONE]'
  })
  return { text: redacted, kinds: [...kinds].sort() }
}

export const preprocessParticipantText = (rawText: string): PreprocessedParticipantText => {
  const unicode = rawText.normalize('NFKC').replace(/\p{Cc}/gu, ' ')
  const injectionSignals = injectionPatterns.filter(({ pattern }) => pattern.test(unicode)).map(({ signal }) => signal)
  const withoutMarkup = unicode.replace(/<[^>]*>/gu, ' ').replace(/[<>]/gu, ' ')
  const normalizedText = withoutMarkup.replace(/\s+/gu, ' ').trim()
  const redacted = redact(normalizedText)
  const priority: DeterministicPriority = optOutPattern.test(normalizedText)
    ? 'opt_out'
    : humanTakeoverPattern.test(normalizedText)
      ? 'human_takeover'
      : 'none'
  const modelText = [AI_CONTENT_BOUNDARY.start, JSON.stringify({ text: redacted.text }), AI_CONTENT_BOUNDARY.end].join(
    '\n',
  )

  return Object.freeze({
    inputHash: createHash('sha256').update(unicode).digest('hex'),
    modelText,
    normalizedText,
    priority,
    injectionSignals: Object.freeze(injectionSignals),
    redactions: Object.freeze(redacted.kinds),
  })
}
