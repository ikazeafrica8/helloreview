import type { AdminAction } from '@helloreview/contracts'
import { OPERATOR_ROUTES } from './navigation'

export type ConsoleRoute = (typeof OPERATOR_ROUTES)[number]
export type ConsoleTone = 'safe' | 'warning' | 'blocked'

export type ConsoleMetric = Readonly<{
  label: string
  value: string
  detail: string
  tone: ConsoleTone
}>

export type ConsoleColumn = Readonly<{ key: string; label: string; numeric?: boolean }>
export type ConsoleRow = Readonly<{
  id: string
  href?: string
  values: Readonly<Record<string, string>>
  status?: Readonly<{ label: string; tone: ConsoleTone }>
}>

interface ConsoleActionBase {
  scenarioId: string
  authorizationAction: AdminAction | null
  label: string
  description: string
  effect: 'preview' | 'mutating' | 'destructive' | 'sensitive'
  requiresReason: boolean
  confirmationPhrase: string | null
}

export type ConsoleAction =
  | Readonly<
      ConsoleActionBase & {
        permission: 'fixture_allowed'
        expectedVersion: number | null
        currentVersion: number | null
        blockedReasonCode: null
      }
    >
  | Readonly<
      ConsoleActionBase & {
        permission: 'policy_blocked'
        expectedVersion: null
        currentVersion: null
        blockedReasonCode: string
      }
    >

export type ConsoleEditorField = Readonly<{
  name: string
  label: string
  kind: 'text' | 'textarea' | 'date' | 'number' | 'select'
  defaultValue: string
  required: boolean
  minLength: number | null
  maxLength: number | null
  minimum: number | null
  maximum: number | null
  options: readonly Readonly<{ value: string; label: string }>[]
}>

export type ConsoleEditorConstraint = Readonly<{
  kind: 'date_order'
  startField: string
  endField: string
  issueCode: string
}>

export type ConsoleEditor = Readonly<{
  editorId: string
  schemaVersion: string
  title: string
  description: string
  currentVersion: number
  lifecycleState: 'draft' | 'approved' | 'scheduled' | 'active' | 'retired'
  makerCheckerState: string
  fields: readonly ConsoleEditorField[]
  constraints: readonly ConsoleEditorConstraint[]
}>

export type ConsoleScreen = Readonly<{
  route: ConsoleRoute
  eyebrow: string
  title: string
  description: string
  badge: Readonly<{ label: string; tone: ConsoleTone }>
  guidance: string
  columns: readonly ConsoleColumn[]
  rows: readonly ConsoleRow[]
  editor: ConsoleEditor | null
  actions: readonly ConsoleAction[]
}>

export type MaskedParticipant = Readonly<{
  participantId: string
  campaignId: string
  workflowId: string
  maskedName: string
  maskedPhone: string
  applicationStatus: string
  bloggerLevel: number | null
  previousDayVisitors: number | null
  bloggerRegion: string | null
  automationState: string
  ownershipState: string
}>

export const PRD_TIMELINE_CATEGORIES = [
  'website_application',
  'identity_evidence',
  'messages',
  'secret_comment_evidence',
  'selection',
  'consent',
  'business_approval',
  'shipping',
  'reservation',
  'ocr_ai',
  'validation_failure',
  'guideline',
  'human_ownership',
  'override',
  'integration_failure',
  'privacy_request',
] as const

export type TimelineCategory = (typeof PRD_TIMELINE_CATEGORIES)[number]

export type TimelineEvent = Readonly<{
  eventId: string
  category: TimelineCategory
  eventCode: string
  occurredAt: string
  version: number | null
  reasonCode: string | null
  stateCode: string | null
}>

export type TimelineCategorySupport = Readonly<{
  category: TimelineCategory
  status: 'available' | 'unsupported'
  reasonCode: string | null
}>

export type ConsolePage<T> = Readonly<{
  items: readonly T[]
  nextCursor: string | null
}>

export type ScopedParticipantSearch = Readonly<{
  campaignId: string
  query: string
  cursor?: string
}>

export type ScopedParticipantTimelineRequest = Readonly<{
  campaignId: string
  participantId: string
  cursor?: string
}>

export type ScopedParticipantTimelinePage = Readonly<{
  participant: MaskedParticipant | null
  events: ConsolePage<TimelineEvent>
  categorySupport: readonly TimelineCategorySupport[]
}>

export type ConsoleEditorPreviewResult = Readonly<{
  valid: boolean
  reasonCode: 'FIXTURE_EDITOR_PREVIEW_VALID' | 'FIXTURE_EDITOR_PREVIEW_INVALID'
  issueCodes: readonly string[]
  message: string
}>

export type GovernedActionSubmission = Readonly<{
  action: ConsoleAction
  reason: string
  confirmation: string
}>

export type GovernedActionResult = Readonly<{
  accepted: boolean
  reasonCode: string
  message: string
}>

const isCalendarDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const candidate = new Date(0)
  candidate.setUTCHours(0, 0, 0, 0)
  candidate.setUTCFullYear(year, month - 1, day)
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day
}

export const evaluateConsoleEditorDraft = (
  editor: ConsoleEditor,
  values: Readonly<Record<string, string>>,
): ConsoleEditorPreviewResult => {
  const issueCodes: string[] = []
  for (const field of editor.fields) {
    const value = values[field.name]?.trim() ?? ''
    if (field.required && value.length === 0) {
      issueCodes.push(`${field.name}:REQUIRED`)
      continue
    }
    if (value.length === 0) continue
    if (field.minLength !== null && value.length < field.minLength) issueCodes.push(`${field.name}:TOO_SHORT`)
    if (field.maxLength !== null && value.length > field.maxLength) issueCodes.push(`${field.name}:TOO_LONG`)
    if (field.kind === 'date' && !isCalendarDate(value)) issueCodes.push(`${field.name}:DATE_INVALID`)
    if (field.kind === 'select' && !field.options.some((option) => option.value === value))
      issueCodes.push(`${field.name}:OPTION_INVALID`)
    if (field.kind === 'number') {
      const numericValue = Number(value)
      if (!Number.isFinite(numericValue)) issueCodes.push(`${field.name}:NUMBER_INVALID`)
      else {
        if (field.minimum !== null && numericValue < field.minimum) issueCodes.push(`${field.name}:BELOW_MINIMUM`)
        if (field.maximum !== null && numericValue > field.maximum) issueCodes.push(`${field.name}:ABOVE_MAXIMUM`)
      }
    }
  }
  for (const constraint of editor.constraints) {
    const startValue = values[constraint.startField]?.trim() ?? ''
    const endValue = values[constraint.endField]?.trim() ?? ''
    if (!isCalendarDate(startValue) || !isCalendarDate(endValue)) continue
    if (endValue <= startValue) issueCodes.push(constraint.issueCode)
  }
  return issueCodes.length === 0
    ? {
        valid: true,
        reasonCode: 'FIXTURE_EDITOR_PREVIEW_VALID',
        issueCodes: [],
        message: `${editor.schemaVersion} 초안이 결정론 검증을 통과했습니다. 저장되거나 게시된 변경은 없습니다.`,
      }
    : {
        valid: false,
        reasonCode: 'FIXTURE_EDITOR_PREVIEW_INVALID',
        issueCodes,
        message: '초안 필드가 스키마 검증을 통과하지 못했습니다. 실제 변경은 발생하지 않았습니다.',
      }
}

export const isConsoleRoute = (value: string): value is ConsoleRoute => OPERATOR_ROUTES.some((route) => route === value)

export const evaluateGovernedAction = ({
  action,
  reason,
  confirmation,
}: GovernedActionSubmission): GovernedActionResult => {
  if (action.permission === 'policy_blocked')
    return {
      accepted: false,
      reasonCode: action.blockedReasonCode,
      message: '승인된 프로덕션 정책이 없어 요청이 차단되었습니다. 실제 변경은 발생하지 않았습니다.',
    }
  if (action.requiresReason && (reason.trim().length < 3 || reason.trim().length > 500))
    return {
      accepted: false,
      reasonCode: 'OPERATOR_REASON_REQUIRED',
      message: '사유를 3자 이상 500자 이하로 입력해 주세요.',
    }
  if (action.confirmationPhrase !== null && confirmation !== action.confirmationPhrase)
    return {
      accepted: false,
      reasonCode: 'OPERATOR_CONFIRMATION_REQUIRED',
      message: `확인 문구 “${action.confirmationPhrase}”를 정확히 입력해 주세요.`,
    }
  if (
    action.expectedVersion !== null &&
    action.currentVersion !== null &&
    action.expectedVersion !== action.currentVersion
  )
    return {
      accepted: false,
      reasonCode: 'OPERATOR_EXPECTED_VERSION_STALE',
      message: '화면을 연 뒤 대상이 변경되었습니다. 새로고침 후 현재 상태를 다시 검토해 주세요.',
    }
  return {
    accepted: true,
    reasonCode: action.effect === 'preview' ? 'FIXTURE_PREVIEW_READY' : 'FIXTURE_COMMAND_ACCEPTED',
    message:
      action.effect === 'preview'
        ? '검증 미리보기가 완료되었습니다. 저장되거나 게시된 변경은 없습니다.'
        : '로컬 검증용 명령이 승인되었습니다. 실제 데이터는 변경되지 않습니다.',
  }
}
