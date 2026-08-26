import 'server-only'
import type { AdminAction } from '@helloreview/contracts'
import { PRD_TIMELINE_CATEGORIES } from './console-contract'
import type {
  ConsoleAction,
  ConsoleEditor,
  ConsoleEditorField,
  ConsoleMetric,
  ConsolePage,
  ConsoleRoute,
  ConsoleScreen,
  MaskedParticipant,
  ScopedParticipantSearch,
  ScopedParticipantTimelinePage,
  ScopedParticipantTimelineRequest,
  TimelineEvent,
} from './console-contract'
import { readAdminConsoleEnvironment } from './env-source'
import { FIXTURE_CAMPAIGN_ID, FIXTURE_PARTICIPANT_ID } from './fixture-identifiers'

export { FIXTURE_CAMPAIGN_ID, FIXTURE_PARTICIPANT_ID }

type AllowedActionOptions = Readonly<{
  scenarioId?: string
  effect?: 'preview' | 'mutating' | 'destructive'
  expectedVersion?: number | null
  currentVersion?: number | null
  requiresReason?: boolean
  confirmationPhrase?: string | null
}>

const allowedAction = (
  authorizationAction: AdminAction | null,
  label: string,
  description: string,
  options: AllowedActionOptions = {},
): ConsoleAction => ({
  scenarioId: options.scenarioId ?? authorizationAction ?? 'fixture.preview.unmapped',
  authorizationAction,
  label,
  description,
  effect: options.effect ?? 'mutating',
  permission: 'fixture_allowed',
  expectedVersion: options.expectedVersion ?? 7,
  currentVersion: options.currentVersion ?? 7,
  requiresReason: options.requiresReason ?? true,
  confirmationPhrase: options.confirmationPhrase === undefined ? '실행 확인' : options.confirmationPhrase,
  blockedReasonCode: null,
})

const blockedAction = (
  authorizationAction: AdminAction | null,
  scenarioId: string,
  label: string,
  description: string,
  reasonCode: string,
): ConsoleAction => ({
  scenarioId,
  authorizationAction,
  label,
  description,
  requiresReason: false,
  confirmationPhrase: null,
  permission: 'policy_blocked',
  expectedVersion: null,
  currentVersion: null,
  blockedReasonCode: reasonCode,
  effect: 'sensitive',
})

type FieldOptions = Readonly<{
  required?: boolean
  minLength?: number | null
  maxLength?: number | null
  minimum?: number | null
  maximum?: number | null
  options?: readonly Readonly<{ value: string; label: string }>[]
}>

const editorField = (
  name: string,
  label: string,
  kind: ConsoleEditorField['kind'],
  defaultValue: string,
  options: FieldOptions = {},
): ConsoleEditorField => ({
  name,
  label,
  kind,
  defaultValue,
  required: options.required ?? true,
  minLength: options.minLength ?? null,
  maxLength: options.maxLength ?? null,
  minimum: options.minimum ?? null,
  maximum: options.maximum ?? null,
  options: options.options ?? [],
})

type ConsoleScreenDefinition = Omit<ConsoleScreen, 'editor'> & { editor?: ConsoleEditor }

const screenDefinitions: Readonly<
  Record<Exclude<ConsoleRoute, '/overview' | '/participants'>, ConsoleScreenDefinition>
> = {
  '/human-review': {
    route: '/human-review',
    eyebrow: 'T113 · HUMAN OWNERSHIP',
    title: '인간 검토',
    description: '자동화가 멈춘 이유, 현재 담당자, SLA와 재개 준비 상태를 함께 확인합니다.',
    badge: { label: '사람 소유권 우선', tone: 'warning' },
    guidance: '할당과 해결은 현재 워크플로 버전을 다시 확인하며, 해결 후 재개는 별도 권한과 준비 검증이 필요합니다.',
    columns: [
      { key: 'task', label: '작업' },
      { key: 'reason', label: '검토 사유' },
      { key: 'owner', label: '담당' },
      { key: 'sla', label: 'SLA' },
    ],
    rows: [
      {
        id: 'task:fixture:001',
        values: { task: 'HR-2401', reason: 'IDENTITY_AMBIGUOUS', owner: '미할당', sla: '정책 대기' },
        status: { label: '열림', tone: 'warning' },
      },
      {
        id: 'task:fixture:002',
        values: { task: 'HR-2400', reason: 'RESERVATION_REVIEW_REQUIRED', owner: '운영자-02', sla: '38분 남음' },
        status: { label: '처리 중', tone: 'safe' },
      },
    ],
    actions: [
      allowedAction('human_tasks.assign', '작업 할당 검토', '현재 버전으로 작업을 본인에게 할당합니다.'),
      allowedAction(
        'human_tasks.resume_automation',
        '해결 및 자동화 재개 검토',
        '필수 근거와 현재 준비 상태를 다시 검증합니다.',
        {
          effect: 'destructive',
        },
      ),
    ],
  },
  '/business-approvals': {
    route: '/business-approvals',
    eyebrow: 'T113 · MAKER CHECKER',
    title: '사업 승인',
    description: 'Visit C 승인 요청과 근거 버전을 확인하고 승인자 책임을 명확히 남깁니다.',
    badge: { label: '승인 전 발송 금지', tone: 'warning' },
    guidance: '승인 근거와 보호된 감사 행위는 같은 트랜잭션에 기록되어야 합니다.',
    columns: [
      { key: 'workflow', label: '워크플로' },
      { key: 'campaign', label: '캠페인' },
      { key: 'evidence', label: '근거 버전' },
      { key: 'requested', label: '요청 시각' },
    ],
    rows: [
      {
        id: 'approval:fixture:001',
        values: { workflow: 'WF-7301', campaign: '지역 방문 캠페인', evidence: 'v7', requested: '18:20 KST' },
        status: { label: '승인 대기', tone: 'warning' },
      },
    ],
    actions: [
      allowedAction('business_approvals.record', '승인 명령 검토', '현재 근거와 워크플로 버전을 고정해 승인합니다.'),
    ],
  },
  '/failed-jobs': {
    route: '/failed-jobs',
    eyebrow: 'T113 · SAFE RETRY',
    title: '실패 작업',
    description: '원문 페이로드 없이 실패 코드, 시도 횟수, 현재 상태만 확인합니다.',
    badge: { label: '멱등 재시도', tone: 'safe' },
    guidance: '재시도는 실패 또는 데드레터 상태만 허용하며 동일 작업 참조는 같은 영수증을 재사용합니다.',
    columns: [
      { key: 'job', label: '작업' },
      { key: 'kind', label: '유형' },
      { key: 'failure', label: '실패 코드' },
      { key: 'attempts', label: '시도', numeric: true },
    ],
    rows: [
      {
        id: 'job:fixture:001',
        values: { job: 'IN-8841', kind: '수신 이벤트', failure: 'SOURCE_TEMPORARILY_UNAVAILABLE', attempts: '3' },
        status: { label: '실패', tone: 'blocked' },
      },
    ],
    actions: [
      allowedAction('failed_jobs.retry', '안전한 재시도', '불변 작업 참조와 현재 실패 상태로 다시 큐잉합니다.'),
      allowedAction('failed_jobs.retry', '오래된 화면 검증', '버전이 달라진 경우 재시도를 거부하는 예시입니다.', {
        scenarioId: 'failed_jobs.retry.stale',
        expectedVersion: 4,
        currentVersion: 5,
      }),
    ],
  },
  '/notifications': {
    route: '/notifications',
    eyebrow: 'T113 · DELIVERY HISTORY',
    title: '알림 이력',
    description: '렌더링된 메시지 내용 없이 목적, 템플릿 버전, 전달 결과를 추적합니다.',
    badge: { label: '콘텐츠 비노출', tone: 'safe' },
    guidance: '개인 연락처와 메시지 본문은 이 화면의 표현 계약에 포함되지 않습니다.',
    columns: [
      { key: 'notification', label: '알림' },
      { key: 'purpose', label: '목적' },
      { key: 'template', label: '템플릿' },
      { key: 'result', label: '결과' },
    ],
    rows: [
      {
        id: 'notification:fixture:001',
        values: { notification: 'NT-4402', purpose: 'GUIDELINE_DELIVERY', template: 'v3', result: 'DELIVERED' },
        status: { label: '전달됨', tone: 'safe' },
      },
    ],
    actions: [],
  },
  '/deduplication': {
    route: '/deduplication',
    eyebrow: 'T113 · SUPPRESSION',
    title: '중복 방지 이력',
    description: '어떤 멱등 키가 중복 발송이나 중복 처리를 막았는지 코드로 확인합니다.',
    badge: { label: '중복 억제 활성', tone: 'safe' },
    guidance: '원본 메시지나 제공자 페이로드 대신 해시와 사유 코드만 표시합니다.',
    columns: [
      { key: 'receipt', label: '영수증' },
      { key: 'purpose', label: '목적' },
      { key: 'reason', label: '억제 사유' },
      { key: 'observed', label: '확인 시각' },
    ],
    rows: [
      {
        id: 'dedupe:fixture:001',
        values: {
          receipt: 'DD-2110',
          purpose: 'HOLDING_MESSAGE',
          reason: 'IDEMPOTENCY_KEY_REUSED',
          observed: '18:11 KST',
        },
        status: { label: '중복 차단', tone: 'safe' },
      },
    ],
    actions: [],
  },
  '/campaigns': {
    route: '/campaigns',
    eyebrow: 'T114 · VERSIONED CONFIGURATION',
    title: '캠페인',
    description: '캠페인 일정과 상태를 낙관적 버전으로 검토하고 변경합니다.',
    badge: { label: '현재 버전 v7', tone: 'safe' },
    guidance: '저장 시 화면을 열었을 때의 예상 버전과 현재 버전이 다르면 변경을 거부합니다.',
    columns: [
      { key: 'campaign', label: '캠페인' },
      { key: 'type', label: '유형' },
      { key: 'period', label: '기간' },
      { key: 'version', label: '버전' },
    ],
    rows: [
      {
        id: FIXTURE_CAMPAIGN_ID,
        href: `/campaigns/${FIXTURE_CAMPAIGN_ID}`,
        values: { campaign: '지역 방문 캠페인', type: 'VISIT', period: '2026-08-01 — 2026-09-30', version: 'v7' },
        status: { label: '활성', tone: 'safe' },
      },
    ],
    editor: {
      editorId: 'campaign-editor:fixture:001',
      schemaVersion: 'campaign-editor-v1',
      title: '캠페인 변경 초안',
      description: '현재 v7을 기준으로 새 초안을 검증합니다. 활성 버전은 직접 수정하지 않습니다.',
      currentVersion: 7,
      lifecycleState: 'draft',
      makerCheckerState: 'maker_draft_checker_pending',
      fields: [
        editorField('campaignName', '캠페인 이름', 'text', '지역 방문 캠페인', {
          minLength: 3,
          maxLength: 80,
        }),
        editorField('startsOn', '시작일', 'date', '2026-08-01'),
        editorField('endsOn', '종료일', 'date', '2026-09-30'),
        editorField('campaignStatus', '요청 상태', 'select', 'active', {
          options: [
            { value: 'draft', label: '초안' },
            { value: 'active', label: '활성' },
            { value: 'paused', label: '일시 중지' },
            { value: 'closed', label: '종료' },
          ],
        }),
      ],
      constraints: [
        {
          kind: 'date_order',
          startField: 'startsOn',
          endField: 'endsOn',
          issueCode: 'campaignPeriod:END_NOT_AFTER_START',
        },
      ],
    },
    actions: [allowedAction('campaigns.configure', '변경 검토', '일정과 상태 변경을 현재 캠페인 버전에 적용합니다.')],
  },
  '/selection-rules': {
    route: '/selection-rules',
    eyebrow: 'T114 · SHADOW MODE',
    title: '선정 규칙',
    description: '블로거 증거를 검토하되 최종 선정은 운영자의 수동 승인으로 남깁니다.',
    badge: { label: '자동 선정 금지', tone: 'warning' },
    guidance: '회원 등급, 전일 방문자 수, 지역은 각각 근거로만 표시되며 신청 상태와 혼합하지 않습니다.',
    columns: [
      { key: 'rule', label: '규칙' },
      { key: 'mode', label: '모드' },
      { key: 'version', label: '버전' },
      { key: 'effective', label: '효력' },
    ],
    rows: [
      {
        id: 'rule:selection:fixture',
        values: { rule: '선정 근거 권고', mode: 'SHADOW', version: 'v4', effective: '게시 전' },
        status: { label: '초안', tone: 'warning' },
      },
    ],
    editor: {
      editorId: 'selection-rule-editor:fixture:001',
      schemaVersion: 'selection-rule-editor-v1',
      title: '선정 근거 규칙 초안',
      description: '회원 등급과 방문자 근거를 입력해도 결과는 shadow 권고이며 수동 승인을 대체하지 않습니다.',
      currentVersion: 4,
      lifecycleState: 'draft',
      makerCheckerState: 'maker_draft_checker_pending',
      fields: [
        editorField('generalMinimumVisitors', '일반 전일 방문자 최소값', 'number', '1000', {
          minimum: 0,
          maximum: 10000000,
        }),
        editorField('regionalMinimumVisitors', '지역 전일 방문자 최소값', 'number', '300', {
          minimum: 0,
          maximum: 10000000,
        }),
        editorField('preferredLevels', '선호 등급 근거', 'text', '1,2,3', { minLength: 1, maxLength: 40 }),
        editorField('decisionMode', '결정 모드', 'select', 'shadow_manual_approval', {
          options: [{ value: 'shadow_manual_approval', label: 'Shadow 권고 + 운영자 수동 승인' }],
        }),
      ],
      constraints: [],
    },
    actions: [
      allowedAction(null, '검증 미리보기', '저장 없이 스키마와 정책 문제 코드를 확인합니다.', {
        scenarioId: 'selection_rules.preview',
        effect: 'preview',
        requiresReason: false,
        confirmationPhrase: null,
        expectedVersion: 4,
        currentVersion: 4,
      }),
      allowedAction('selection_rules.publish', '규칙 게시 검토', '잠긴 초안을 다시 검증한 뒤 게시합니다.', {
        effect: 'destructive',
        expectedVersion: 4,
        currentVersion: 4,
      }),
    ],
  },
  '/reservation-rules': {
    route: '/reservation-rules',
    eyebrow: 'T114 · DETERMINISTIC RULES',
    title: '예약 규칙',
    description: '예약 파싱과 유효성 규칙의 초안, 버전, 게시 상태를 검토합니다.',
    badge: { label: '결정론 검증', tone: 'safe' },
    guidance: '미리보기는 비변경 작업이며 게시 시 잠긴 초안을 다시 읽고 검증합니다.',
    columns: [
      { key: 'rule', label: '규칙' },
      { key: 'schema', label: '스키마' },
      { key: 'version', label: '버전' },
      { key: 'issues', label: '문제 코드' },
    ],
    rows: [
      {
        id: 'rule:reservation:fixture',
        values: { rule: '예약 수집 규칙', schema: 'reservation-rule-v2', version: 'v2', issues: '없음' },
        status: { label: '초안', tone: 'warning' },
      },
    ],
    editor: {
      editorId: 'reservation-rule-editor:fixture:001',
      schemaVersion: 'reservation-rule-editor-v1',
      title: '예약 검증 규칙 초안',
      description: '결정론 파싱과 운영 검증 조건을 새 버전으로 미리 확인합니다.',
      currentVersion: 2,
      lifecycleState: 'draft',
      makerCheckerState: 'maker_draft_checker_pending',
      fields: [
        editorField('timezone', '기준 시간대', 'select', 'Asia/Seoul', {
          options: [{ value: 'Asia/Seoul', label: 'Asia/Seoul' }],
        }),
        editorField('minimumNoticeHours', '최소 사전 시간', 'number', '24', { minimum: 0, maximum: 720 }),
        editorField('requiresBusinessApproval', '사업 승인 필요', 'select', 'true', {
          options: [
            { value: 'true', label: '필요' },
            { value: 'false', label: '불필요' },
          ],
        }),
      ],
      constraints: [],
    },
    actions: [
      allowedAction(
        'reservation_rules.publish',
        '예약 규칙 게시 검토',
        '현재 초안을 재검증하고 새 버전을 게시합니다.',
        { effect: 'destructive' },
      ),
    ],
  },
  '/message-templates': {
    route: '/message-templates',
    eyebrow: 'T114 · MAKER CHECKER',
    title: '메시지 템플릿',
    description: '승인, 활성화, 폐기 전환을 분리하고 렌더링 콘텐츠를 이 목록에 노출하지 않습니다.',
    badge: { label: '승인 워크플로', tone: 'warning' },
    guidance: '템플릿 전환은 현재 버전과 역할을 검증하며 브라우저가 역할을 선언할 수 없습니다.',
    columns: [
      { key: 'template', label: '템플릿' },
      { key: 'purpose', label: '목적' },
      { key: 'locale', label: '언어' },
      { key: 'version', label: '버전' },
    ],
    rows: [
      {
        id: 'template:fixture:001',
        values: { template: 'TPL-3002', purpose: 'GUIDELINE_DELIVERY', locale: 'ko-KR', version: 'v3' },
        status: { label: '승인됨', tone: 'safe' },
      },
      {
        id: 'template:fixture:002',
        values: { template: 'TPL-3003', purpose: 'RESERVATION_REMINDER', locale: 'ko-KR', version: 'v4' },
        status: { label: '예약됨', tone: 'warning' },
      },
      {
        id: 'template:fixture:003',
        values: { template: 'TPL-2998', purpose: 'LEGACY_NOTICE', locale: 'ko-KR', version: 'v2' },
        status: { label: '폐기됨', tone: 'blocked' },
      },
    ],
    editor: {
      editorId: 'message-template-editor:fixture:001',
      schemaVersion: 'message-template-editor-v1',
      title: '메시지 템플릿 새 버전',
      description: '본문은 이 로컬 편집기에서만 검증되며 목록, 로그, 외부 제공자에는 전송되지 않습니다.',
      currentVersion: 3,
      lifecycleState: 'draft',
      makerCheckerState: 'maker_draft_checker_pending',
      fields: [
        editorField('purpose', '메시지 목적', 'select', 'GUIDELINE_DELIVERY', {
          options: [
            { value: 'GUIDELINE_DELIVERY', label: '가이드라인 전달' },
            { value: 'RESERVATION_REMINDER', label: '예약 알림' },
          ],
        }),
        editorField('locale', '언어', 'select', 'ko-KR', {
          options: [{ value: 'ko-KR', label: '한국어 (ko-KR)' }],
        }),
        editorField('body', '템플릿 본문', 'textarea', '안녕하세요. 승인된 가이드라인을 확인해 주세요.', {
          minLength: 10,
          maxLength: 1000,
        }),
      ],
      constraints: [],
    },
    actions: [
      allowedAction('message_templates.publish', '활성화 전환 검토', '승인된 현재 버전을 활성 상태로 전환합니다.'),
    ],
  },
  '/guidelines': {
    route: '/guidelines',
    eyebrow: 'T114 · IMMUTABLE CONTENT',
    title: '가이드라인',
    description: '게시된 버전은 수정하지 않고 새 초안을 만들어 효력 기간을 전환합니다.',
    badge: { label: '불변 버전', tone: 'safe' },
    guidance: '게시 명령은 초안 상태와 예상 버전을 다시 검증합니다.',
    columns: [
      { key: 'guideline', label: '가이드라인' },
      { key: 'campaign', label: '캠페인' },
      { key: 'version', label: '버전' },
      { key: 'effective', label: '효력 시작' },
    ],
    rows: [
      {
        id: 'guideline:fixture:001',
        values: { guideline: 'GL-901', campaign: '지역 방문 캠페인', version: 'v5', effective: '게시 전' },
        status: { label: '초안', tone: 'warning' },
      },
      {
        id: 'guideline:fixture:002',
        values: { guideline: 'GL-900', campaign: '지역 방문 캠페인', version: 'v4', effective: '2026-08-01' },
        status: { label: '활성', tone: 'safe' },
      },
    ],
    editor: {
      editorId: 'guideline-editor:fixture:001',
      schemaVersion: 'guideline-editor-v1',
      title: '가이드라인 새 버전',
      description: '게시된 v4는 불변으로 유지하고 검토 가능한 v5 초안을 작성합니다.',
      currentVersion: 5,
      lifecycleState: 'draft',
      makerCheckerState: 'maker_draft_checker_pending',
      fields: [
        editorField('effectiveOn', '효력 시작일', 'date', '2026-09-01'),
        editorField(
          'content',
          '가이드라인 내용',
          'textarea',
          '방문 후 승인된 일정과 표시 기준에 맞춰 리뷰를 작성해 주세요.',
          {
            minLength: 20,
            maxLength: 2000,
          },
        ),
      ],
      constraints: [],
    },
    actions: [
      allowedAction('guidelines.publish', '가이드라인 게시 검토', '현재 초안을 불변 게시 버전으로 전환합니다.', {
        effect: 'destructive',
      }),
    ],
  },
  '/integrations': {
    route: '/integrations',
    eyebrow: 'T115 · HEALTH',
    title: '연동 상태',
    description: '수동 CSV 수집, 이벤트 처리, 발송 어댑터의 최신 상태를 코드로 확인합니다.',
    badge: { label: '수동 CSV 파일럿', tone: 'warning' },
    guidance: '웹사이트 API나 데이터베이스 연결을 추정하지 않으며 현재 파일럿 입력은 운영자 CSV 업로드입니다.',
    columns: [
      { key: 'integration', label: '연동' },
      { key: 'mode', label: '모드' },
      { key: 'freshness', label: '최신 확인' },
      { key: 'failures', label: '연속 실패', numeric: true },
    ],
    rows: [
      {
        id: 'integration:website-export',
        values: {
          integration: '웹사이트 신청 목록',
          mode: 'MANUAL_CSV',
          freshness: '운영자 업로드 필요',
          failures: '0',
        },
        status: { label: '제한 운영', tone: 'warning' },
      },
      {
        id: 'integration:ai',
        values: { integration: 'AI 제공자', mode: 'SAFE_FALLBACK', freshness: '실제 연결 없음', failures: '0' },
        status: { label: '안전 대체', tone: 'safe' },
      },
    ],
    actions: [],
  },
  '/audit': {
    route: '/audit',
    eyebrow: 'T115 · PROTECTED HISTORY',
    title: '감사 로그',
    description: '행위 코드, 가명화된 주체, 이유, 상관관계 식별자로 보호된 기록을 추적합니다.',
    badge: { label: '수정·삭제 금지', tone: 'safe' },
    guidance: '원시 요청과 개인정보는 감사 목록의 표현 계약에서 제외됩니다.',
    columns: [
      { key: 'action', label: '행위' },
      { key: 'actor', label: '주체 참조' },
      { key: 'reason', label: '사유 코드' },
      { key: 'correlation', label: '상관관계' },
    ],
    rows: [
      {
        id: 'audit:fixture:001',
        values: {
          action: 'HUMAN_TASK_ASSIGNED',
          actor: 'operator:fixture:02',
          reason: 'QUEUE_TRIAGE',
          correlation: 'cor:fixture:41',
        },
        status: { label: '보호됨', tone: 'safe' },
      },
    ],
    actions: [],
  },
  '/privacy': {
    route: '/privacy',
    eyebrow: 'T115 · PRIVACY REQUESTS',
    title: '개인정보 요청',
    description: '동의 집계와 개인정보 요청 상태를 최소 정보로 확인합니다.',
    badge: { label: '삭제 정책 승인 대기', tone: 'warning' },
    guidance: 'T100–T102 보존 기간 결정 전에는 삭제를 실행하지 않으며 법적 보존 여부를 먼저 확인합니다.',
    columns: [
      { key: 'request', label: '요청' },
      { key: 'kind', label: '유형' },
      { key: 'received', label: '접수' },
      { key: 'hold', label: '법적 보존' },
    ],
    rows: [
      {
        id: 'privacy:fixture:001',
        values: { request: 'PR-122', kind: 'ACCESS', received: '2026-08-25', hold: '확인 완료' },
        status: { label: '검토 중', tone: 'warning' },
      },
    ],
    actions: [
      blockedAction(
        null,
        'privacy.delete',
        '삭제 실행 검토',
        '승인된 보존 기간과 삭제 정책이 필요합니다.',
        'RETENTION_POLICY_MISSING',
      ),
    ],
  },
  '/users-roles': {
    route: '/users-roles',
    eyebrow: 'T115 · DENY BY DEFAULT',
    title: '사용자 및 역할',
    description: '현재 테스트 역할 매트릭스와 캠페인 범위 원칙을 읽기 전용으로 확인합니다.',
    badge: { label: '실제 RBAC 승인 대기', tone: 'blocked' },
    guidance: '브라우저 입력으로 역할이나 범위를 만들 수 없습니다. 실제 사용자는 승인된 인증 어댑터가 발급해야 합니다.',
    columns: [
      { key: 'role', label: '역할' },
      { key: 'scope', label: '범위' },
      { key: 'assurance', label: '최소 인증' },
      { key: 'policy', label: '정책' },
    ],
    rows: [
      {
        id: 'role:fixture:privacy-reviewer',
        values: { role: 'privacy_reviewer', scope: 'GLOBAL', assurance: 'PHISHING_RESISTANT', policy: 'TEST_ONLY' },
        status: { label: '프로덕션 금지', tone: 'blocked' },
      },
    ],
    actions: [],
  },
  '/automation-pauses': {
    route: '/automation-pauses',
    eyebrow: 'T115 · KILL SWITCH',
    title: '자동화 일시중지',
    description: '전역, 캠페인, 워크플로 유형, 참여자 범위의 활성 중지를 한곳에서 확인합니다.',
    badge: { label: '중지 우선', tone: 'warning' },
    guidance: '재개는 현재 중지 상태와 사유를 다시 확인하며 중지 중인 흐름을 우회하지 않습니다.',
    columns: [
      { key: 'pause', label: '중지' },
      { key: 'scope', label: '범위' },
      { key: 'kind', label: '종류' },
      { key: 'reason', label: '사유' },
    ],
    rows: [
      {
        id: 'pause:fixture:001',
        values: { pause: 'PA-82', scope: 'CAMPAIGN', kind: 'EMERGENCY', reason: 'EMERGENCY_OPERATOR_STOP' },
        status: { label: '활성', tone: 'warning' },
      },
    ],
    actions: [
      allowedAction('automation_pauses.activate', '긴급 중지 검토', '선택한 범위의 새 자동화 진행을 중단합니다.', {
        effect: 'destructive',
      }),
      allowedAction('automation_pauses.resume', '중지 해제 검토', '현재 상태를 다시 읽은 뒤 자동화를 재개합니다.', {
        effect: 'destructive',
      }),
    ],
  },
  '/ai-cost': {
    route: '/ai-cost',
    eyebrow: 'T115 · SAFE FALLBACK',
    title: 'AI 및 비용',
    description: '실제 AI 제공자 연결 여부, 평가 상태, 추정 비용을 과장 없이 표시합니다.',
    badge: { label: '실제 제공자 없음', tone: 'safe' },
    guidance: '현재 제공자 모드는 unavailable_safe_fallback이며 청구 가능한 호출은 0건입니다.',
    columns: [
      { key: 'metric', label: '항목' },
      { key: 'value', label: '값' },
      { key: 'source', label: '근거' },
      { key: 'evaluated', label: '평가' },
    ],
    rows: [
      {
        id: 'ai:provider-mode',
        values: { metric: 'provider_mode', value: 'unavailable_safe_fallback', source: 'T63', evaluated: '현재 세션' },
        status: { label: '비용 0', tone: 'safe' },
      },
    ],
    actions: [],
  },
  '/sensitive-access': {
    route: '/sensitive-access',
    eyebrow: 'T115 · SENSITIVE ACCESS',
    title: '민감정보 접근',
    description: '마스킹을 기본으로 유지하고 모든 보기·내보내기 시도를 감사 대상으로 취급합니다.',
    badge: { label: '프로덕션 차단', tone: 'blocked' },
    guidance: '정책, 목적지, 보존 결정이 승인되기 전에는 실제 주소 보기나 개인정보 파일 생성을 허용하지 않습니다.',
    columns: [
      { key: 'subject', label: '대상' },
      { key: 'field', label: '필드' },
      { key: 'masked', label: '기본 표시' },
      { key: 'lastAttempt', label: '최근 시도' },
    ],
    rows: [
      {
        id: 'sensitive:fixture:001',
        values: {
          subject: 'participant:fixture:01',
          field: '배송 주소',
          masked: '서울 **구 · 상세 비공개',
          lastAttempt: '없음',
        },
        status: { label: '마스킹됨', tone: 'safe' },
      },
    ],
    actions: [
      blockedAction(
        'sensitive_values.reveal',
        'shipping_address.reveal',
        '주소 보기 요청',
        '피싱 방지 인증과 승인된 보기 정책이 필요합니다.',
        'SENSITIVE_ACCESS_POLICY_NOT_APPROVED',
      ),
      blockedAction(
        'sensitive_data.export',
        'participant_data.export',
        '내보내기 요청',
        '승인된 내보내기 목적지와 보존 정책이 필요합니다.',
        'SENSITIVE_EXPORT_UNAVAILABLE',
      ),
    ],
  },
  '/system': {
    route: '/system',
    eyebrow: 'T115 · RELEASE STATE',
    title: '시스템 정보',
    description: '배포 버전, 데이터 모드, 운영 경계를 한눈에 확인합니다.',
    badge: { label: '로컬 검증 모드', tone: 'warning' },
    guidance: '이 화면은 비밀 키, 연결 문자열, 원시 환경 변수를 표시하지 않습니다.',
    columns: [
      { key: 'component', label: '구성 요소' },
      { key: 'version', label: '버전' },
      { key: 'mode', label: '모드' },
      { key: 'boundary', label: '경계' },
    ],
    rows: [
      {
        id: 'system:console',
        values: {
          component: 'operator-console',
          version: 'console-contract-v1',
          mode: 'DETERMINISTIC_FIXTURE',
          boundary: 'PRODUCTION_LOCKED',
        },
        status: { label: '검증 가능', tone: 'safe' },
      },
    ],
    actions: [],
  },
}

const consoleScreen = (route: Exclude<ConsoleRoute, '/overview' | '/participants'>): ConsoleScreen => {
  const definition = screenDefinitions[route]
  return { ...definition, editor: definition.editor ?? null }
}

const participants: readonly MaskedParticipant[] = [
  {
    participantId: FIXTURE_PARTICIPANT_ID,
    campaignId: FIXTURE_CAMPAIGN_ID,
    workflowId: '30000000-0000-4000-8000-000000000001',
    maskedName: '블로거 A**',
    maskedPhone: '***-****-0042',
    applicationStatus: 'received',
    bloggerLevel: 2,
    previousDayVisitors: 1460,
    bloggerRegion: '서울',
    automationState: 'HUMAN_REVIEW',
    ownershipState: 'OPERATOR',
  },
  {
    participantId: '20000000-0000-4000-8000-000000000002',
    campaignId: FIXTURE_CAMPAIGN_ID,
    workflowId: '30000000-0000-4000-8000-000000000002',
    maskedName: '블로거 B**',
    maskedPhone: '***-****-1188',
    applicationStatus: 'received',
    bloggerLevel: 5,
    previousDayVisitors: 290,
    bloggerRegion: '부산',
    automationState: 'WAITING_SELECTION',
    ownershipState: 'AUTOMATION',
  },
]

type TimelineSeed = readonly [
  category: TimelineEvent['category'],
  eventCode: string,
  occurredAt: string,
  version: number | null,
  reasonCode: string | null,
  stateCode: string | null,
]

const timeline: readonly TimelineEvent[] = (
  [
    [
      'privacy_request',
      'PRIVACY_REQUEST_RECEIVED',
      '2026-08-26T08:50:00.000Z',
      1,
      'SUBJECT_SCOPE_VERIFIED',
      'in_review',
    ],
    [
      'integration_failure',
      'INTEGRATION_FAILURE_RECORDED',
      '2026-08-26T08:45:00.000Z',
      null,
      'SOURCE_TEMPORARILY_UNAVAILABLE',
      'resolved',
    ],
    ['override', 'WORKFLOW_CORRECTION_RECORDED', '2026-08-26T08:40:00.000Z', 8, 'APPROVED_CORRECTION', 'corrected'],
    ['human_ownership', 'HUMAN_TASK_ASSIGNED', '2026-08-26T08:35:00.000Z', 7, 'QUEUE_TRIAGE', 'assigned'],
    ['guideline', 'GUIDELINE_DELIVERY_DELIVERED', '2026-08-26T08:30:00.000Z', 5, null, 'delivered'],
    ['validation_failure', 'TRANSITION_REJECTED', '2026-08-26T08:25:00.000Z', 6, 'PRECONDITION_FAILED', 'rejected'],
    [
      'ocr_ai',
      'AI_SAFE_FALLBACK_RECORDED',
      '2026-08-26T08:20:00.000Z',
      1,
      'REAL_PROVIDER_UNAVAILABLE',
      'safe_fallback',
    ],
    ['ocr_ai', 'OCR_RESULT_VALIDATED', '2026-08-26T08:15:00.000Z', 1, 'DETERMINISTIC_FIXTURE', 'validated'],
    ['reservation', 'RESERVATION_VERSIONED', '2026-08-26T08:10:00.000Z', 2, null, 'confirmed'],
    ['shipping', 'SHIPPING_ADDRESS_VERSIONED', '2026-08-26T08:05:00.000Z', 1, null, 'valid'],
    ['business_approval', 'BUSINESS_APPROVAL_CHANGED', '2026-08-26T08:00:00.000Z', 2, 'EVIDENCE_CONFIRMED', 'approved'],
    ['consent', 'PAYBACK_CONSENT_CHANGED', '2026-08-26T07:55:00.000Z', 1, 'PARTICIPANT_CONFIRMED', 'granted'],
    ['selection', 'SELECTION_MANUALLY_DECIDED', '2026-08-26T07:50:00.000Z', 1, 'OPERATOR_SELECTED', 'selected'],
    ['selection', 'SELECTION_RECOMMENDED', '2026-08-26T07:45:00.000Z', 1, 'SHADOW_EVIDENCE_READY', 'recommended'],
    [
      'secret_comment_evidence',
      'SECRET_COMMENT_EVIDENCE_VERIFIED',
      '2026-08-26T07:40:00.000Z',
      1,
      'APPROVED_EVIDENCE',
      'verified',
    ],
    ['messages', 'DELIVERED', '2026-08-26T07:35:00.000Z', 3, null, 'delivered'],
    ['messages', 'MESSAGE_RECEIVED', '2026-08-26T07:30:00.000Z', 1, 'PROVIDER_REFERENCE_ACCEPTED', 'received'],
    [
      'website_application',
      'STATE_TRANSITIONED',
      '2026-08-26T07:00:00.000Z',
      1,
      'APPLICATION_RECEIVED',
      'WAITING_SELECTION',
    ],
    ['website_application', 'APPLICATION_SYNCHRONIZED', '2026-08-26T06:55:00.000Z', 1, null, 'received'],
    ['identity_evidence', 'IDENTITY_CONFIRMED', '2026-08-26T06:50:00.000Z', null, 'STRONG_MATCH', 'strong'],
  ] satisfies readonly TimelineSeed[]
).map(([category, eventCode, occurredAt, version, reasonCode, stateCode], index) => ({
  eventId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  category,
  eventCode,
  occurredAt,
  version,
  reasonCode,
  stateCode,
}))

const secondaryTimeline: readonly TimelineEvent[] = [
  {
    eventId: '50000000-0000-4000-8000-000000000001',
    category: 'selection',
    eventCode: 'SELECTION_EVIDENCE_RECORDED',
    occurredAt: '2026-08-26T07:20:00.000Z',
    version: 1,
    reasonCode: 'SHADOW_EVIDENCE_READY',
    stateCode: 'pending_manual_approval',
  },
  {
    eventId: '50000000-0000-4000-8000-000000000002',
    category: 'website_application',
    eventCode: 'APPLICATION_SYNCHRONIZED',
    occurredAt: '2026-08-26T07:10:00.000Z',
    version: 1,
    reasonCode: null,
    stateCode: 'received',
  },
]

const timelinesByParticipantId: Readonly<Record<string, readonly TimelineEvent[]>> = {
  [FIXTURE_PARTICIPANT_ID]: timeline,
  '20000000-0000-4000-8000-000000000002': secondaryTimeline,
}

const fixtureTimelineCategorySupport = PRD_TIMELINE_CATEGORIES.map((category) => ({
  category,
  status: 'available' as const,
  reasonCode: null,
}))

const lockedTimelineCategorySupport = PRD_TIMELINE_CATEGORIES.map((category) => ({
  category,
  status: 'unsupported' as const,
  reasonCode: 'PRODUCTION_ADAPTER_LOCKED',
}))

export interface OperatorConsoleGateway {
  overview(): Promise<readonly ConsoleMetric[]>
  screen(route: Exclude<ConsoleRoute, '/overview' | '/participants'>): Promise<ConsoleScreen>
  campaignEditor(campaignId: string): Promise<ConsoleScreen | null>
  searchParticipants(request: ScopedParticipantSearch): Promise<ConsolePage<MaskedParticipant>>
  participantTimeline(request: ScopedParticipantTimelineRequest): Promise<ScopedParticipantTimelinePage>
}

export class DeterministicOperatorConsoleGateway implements OperatorConsoleGateway {
  overview(): Promise<readonly ConsoleMetric[]> {
    return Promise.resolve([
      { label: '사람 검토 대기', value: '2', detail: '미할당 1 · 처리 중 1', tone: 'warning' },
      { label: '사업 승인 대기', value: '1', detail: '승인 전 발송 차단', tone: 'warning' },
      { label: '실패 작업', value: '1', detail: '멱등 재시도 가능', tone: 'blocked' },
      { label: '활성 자동화 중지', value: '1', detail: '캠페인 범위', tone: 'warning' },
    ])
  }

  screen(route: Exclude<ConsoleRoute, '/overview' | '/participants'>): Promise<ConsoleScreen> {
    return Promise.resolve(consoleScreen(route))
  }

  campaignEditor(campaignId: string): Promise<ConsoleScreen | null> {
    if (campaignId !== FIXTURE_CAMPAIGN_ID) return Promise.resolve(null)
    return Promise.resolve({
      ...consoleScreen('/campaigns'),
      eyebrow: 'T114 · CAMPAIGN DETAIL',
      title: '지역 방문 캠페인 편집',
      description: `캠페인 ${campaignId}의 버전, 일정과 상태 변경을 검토합니다.`,
    })
  }

  searchParticipants({ campaignId, query, cursor }: ScopedParticipantSearch): Promise<ConsolePage<MaskedParticipant>> {
    if (campaignId !== FIXTURE_CAMPAIGN_ID) return Promise.resolve({ items: [], nextCursor: null })
    const normalized = query.trim().toLocaleLowerCase('ko-KR')
    if (normalized.length < 2 || normalized.length > 200) return Promise.resolve({ items: [], nextCursor: null })
    const filtered = participants.filter(
      (participant) =>
        participant.campaignId === campaignId &&
        [participant.maskedName, participant.maskedPhone, participant.participantId, participant.applicationStatus]
          .join(' ')
          .toLocaleLowerCase('ko-KR')
          .includes(normalized),
    )
    const offset = cursor === 'fixture-participants-page-2' ? 1 : 0
    const items = filtered.slice(offset, offset + 1)
    return Promise.resolve({
      items,
      nextCursor: filtered.length > offset + 1 ? 'fixture-participants-page-2' : null,
    })
  }

  participantTimeline({
    campaignId,
    participantId,
    cursor,
  }: ScopedParticipantTimelineRequest): Promise<ScopedParticipantTimelinePage> {
    const participant =
      participants.find(
        (candidate) => candidate.participantId === participantId && candidate.campaignId === campaignId,
      ) ?? null
    if (participant === null)
      return Promise.resolve({
        participant: null,
        events: { items: [], nextCursor: null },
        categorySupport: [],
      })
    const participantTimeline = timelinesByParticipantId[participantId] ?? []
    const pageNumberText = /^fixture-timeline-page-(\d+)$/.exec(cursor ?? '')?.[1]
    const parsedPageNumber = Number(pageNumberText)
    const pageNumber = Number.isSafeInteger(parsedPageNumber) && parsedPageNumber >= 2 ? parsedPageNumber : 1
    const offset = (pageNumber - 1) * 6
    const nextPage = Math.floor(offset / 6) + 2
    return Promise.resolve({
      participant,
      events: {
        items: participantTimeline.slice(offset, offset + 6),
        nextCursor: participantTimeline.length > offset + 6 ? `fixture-timeline-page-${String(nextPage)}` : null,
      },
      categorySupport: fixtureTimelineCategorySupport,
    })
  }
}

export const CONSOLE_FIXTURE_GATEWAY = new DeterministicOperatorConsoleGateway()

class ProductionLockedConsoleGateway implements OperatorConsoleGateway {
  overview(): Promise<readonly ConsoleMetric[]> {
    return Promise.resolve([])
  }

  screen(route: Exclude<ConsoleRoute, '/overview' | '/participants'>): Promise<ConsoleScreen> {
    const screen = consoleScreen(route)
    return Promise.resolve({
      ...screen,
      badge: { label: '프로덕션 잠금', tone: 'blocked' },
      rows: [],
      editor: null,
      actions: [],
    })
  }

  campaignEditor(_campaignId: string): Promise<ConsoleScreen | null> {
    return Promise.resolve(null)
  }

  searchParticipants(_request: ScopedParticipantSearch): Promise<ConsolePage<MaskedParticipant>> {
    return Promise.resolve({ items: [], nextCursor: null })
  }

  participantTimeline(_request: ScopedParticipantTimelineRequest): Promise<ScopedParticipantTimelinePage> {
    return Promise.resolve({
      participant: null,
      events: { items: [], nextCursor: null },
      categorySupport: lockedTimelineCategorySupport,
    })
  }
}

const PRODUCTION_LOCKED_GATEWAY = new ProductionLockedConsoleGateway()

/** Server-only adapter boundary. A future authenticated transport replaces this factory branch. */
export const getOperatorConsoleGateway = (): OperatorConsoleGateway =>
  readAdminConsoleEnvironment().sessionMode === 'test_fixture' ? CONSOLE_FIXTURE_GATEWAY : PRODUCTION_LOCKED_GATEWAY
