import { describe, expect, test } from 'vitest'
import {
  evaluateConsoleEditorDraft,
  evaluateGovernedAction,
  isConsoleRoute,
  PRD_TIMELINE_CATEGORIES,
} from '../../apps/admin/src/lib/console-contract.ts'

const { CONSOLE_FIXTURE_GATEWAY, CONSOLE_SCREEN_READ_ACTIONS, FIXTURE_CAMPAIGN_ID, FIXTURE_PARTICIPANT_ID } =
  await import('../../apps/admin/src/lib/console-gateway.ts')
const { OPERATOR_CONSOLE_TEST_FIXTURE_SESSION } = await import('../../apps/admin/src/lib/operator-session-contract.ts')

const action = (overrides = {}) => ({
  scenarioId: 'fixture.command',
  authorizationAction: 'failed_jobs.retry',
  label: '명령 검토',
  description: 'fixture command',
  effect: 'destructive',
  permission: 'fixture_allowed',
  expectedVersion: 7,
  currentVersion: 7,
  requiresReason: true,
  confirmationPhrase: '실행 확인',
  blockedReasonCode: null,
  ...overrides,
})

describe('T112-T116 operator console safety contracts', () => {
  test('recognizes only inventoried top-level routes', () => {
    expect(isConsoleRoute('/human-review')).toBe(true)
    expect(isConsoleRoute('/sensitive-access')).toBe(true)
    expect(isConsoleRoute('/participants/not-a-route')).toBe(false)
    expect(isConsoleRoute('/unknown')).toBe(false)
  })

  test('keeps every PRD 20.3 timeline category explicit without raw payload fields', () => {
    expect(PRD_TIMELINE_CATEGORIES).toHaveLength(16)
    expect(new Set(PRD_TIMELINE_CATEGORIES).size).toBe(16)
    expect(PRD_TIMELINE_CATEGORIES).toContain('ocr_ai')
    expect(PRD_TIMELINE_CATEGORIES).toContain('privacy_request')
  })

  test('maps every console screen to a canonical read action authorized by the fixture session', () => {
    expect(Object.keys(CONSOLE_SCREEN_READ_ACTIONS)).toHaveLength(18)
    expect(new Set(Object.keys(CONSOLE_SCREEN_READ_ACTIONS)).size).toBe(18)
    for (const actionId of Object.values(CONSOLE_SCREEN_READ_ACTIONS))
      expect(OPERATOR_CONSOLE_TEST_FIXTURE_SESSION.authorizedActions).toContain(actionId)
  })

  test('rechecks canonical action and campaign scope inside every fixture gateway read', async () => {
    const searchOnlySession = {
      ...OPERATOR_CONSOLE_TEST_FIXTURE_SESSION,
      authorizedActions: ['participants.search'],
    }
    await expect(CONSOLE_FIXTURE_GATEWAY.overview(searchOnlySession, FIXTURE_CAMPAIGN_ID)).resolves.toBeNull()
    await expect(
      CONSOLE_FIXTURE_GATEWAY.screen(searchOnlySession, '/human-review', FIXTURE_CAMPAIGN_ID),
    ).resolves.toBeNull()
    await expect(CONSOLE_FIXTURE_GATEWAY.campaignEditor(searchOnlySession, FIXTURE_CAMPAIGN_ID)).resolves.toBeNull()
    await expect(
      CONSOLE_FIXTURE_GATEWAY.participantTimeline(searchOnlySession, {
        campaignId: FIXTURE_CAMPAIGN_ID,
        participantId: FIXTURE_PARTICIPANT_ID,
      }),
    ).resolves.toBeNull()
    await expect(
      CONSOLE_FIXTURE_GATEWAY.searchParticipants(searchOnlySession, {
        campaignId: '10000000-0000-4000-8000-000000000099',
        query: '블로거',
      }),
    ).resolves.toBeNull()
  })

  test('fails closed on participant and timeline cursors that the fixture did not issue', async () => {
    await expect(
      CONSOLE_FIXTURE_GATEWAY.searchParticipants(OPERATOR_CONSOLE_TEST_FIXTURE_SESSION, {
        campaignId: FIXTURE_CAMPAIGN_ID,
        query: '블로거',
        cursor: 'not-issued',
      }),
    ).resolves.toEqual(expect.objectContaining({ items: [], reasonCode: 'ADMIN_CURSOR_INVALID' }))
    await expect(
      CONSOLE_FIXTURE_GATEWAY.participantTimeline(OPERATOR_CONSOLE_TEST_FIXTURE_SESSION, {
        campaignId: FIXTURE_CAMPAIGN_ID,
        participantId: FIXTURE_PARTICIPANT_ID,
        cursor: 'fixture-timeline-page-999',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        events: expect.objectContaining({ items: [], reasonCode: 'ADMIN_CURSOR_INVALID' }),
      }),
    )
  })

  test('requires a reason and an exact confirmation phrase for destructive actions', () => {
    expect(evaluateGovernedAction({ action: action(), reason: '', confirmation: '' }).reasonCode).toBe(
      'OPERATOR_REASON_REQUIRED',
    )
    expect(evaluateGovernedAction({ action: action(), reason: '검토 완료', confirmation: '확인' }).reasonCode).toBe(
      'OPERATOR_CONFIRMATION_REQUIRED',
    )
  })

  test('fails closed on policy denial before exposing target version state', () => {
    const result = evaluateGovernedAction({
      action: action({
        permission: 'policy_blocked',
        expectedVersion: null,
        currentVersion: null,
        blockedReasonCode: 'SENSITIVE_ACCESS_POLICY_NOT_APPROVED',
      }),
      reason: '',
      confirmation: '',
    })
    expect(result).toEqual(
      expect.objectContaining({ accepted: false, reasonCode: 'SENSITIVE_ACCESS_POLICY_NOT_APPROVED' }),
    )
  })

  test('surfaces stale expected versions and accepts only current fixture commands', () => {
    expect(
      evaluateGovernedAction({
        action: action({ expectedVersion: 4, currentVersion: 5 }),
        reason: '실패 작업 재검토',
        confirmation: '실행 확인',
      }).reasonCode,
    ).toBe('OPERATOR_EXPECTED_VERSION_STALE')
    expect(evaluateGovernedAction({ action: action(), reason: '실패 작업 재검토', confirmation: '실행 확인' })).toEqual(
      expect.objectContaining({ accepted: true, reasonCode: 'FIXTURE_COMMAND_ACCEPTED' }),
    )
  })

  test('keeps preview commands explicitly non-mutating', () => {
    expect(
      evaluateGovernedAction({
        action: action({
          effect: 'preview',
          requiresReason: false,
          confirmationPhrase: null,
          expectedVersion: 4,
          currentVersion: 4,
        }),
        reason: '',
        confirmation: '',
      }),
    ).toEqual(expect.objectContaining({ accepted: true, reasonCode: 'FIXTURE_PREVIEW_READY' }))
  })

  test('validates editor payload fields deterministically without returning entered content', () => {
    const editor = {
      editorId: 'selection-rule-editor:fixture:test',
      schemaVersion: 'selection-rule-editor-v1',
      title: '선정 규칙',
      description: 'fixture',
      currentVersion: 4,
      lifecycleState: 'draft',
      makerCheckerState: 'maker_draft_checker_pending',
      constraints: [],
      fields: [
        {
          name: 'minimumVisitors',
          label: '최소 방문자',
          kind: 'number',
          defaultValue: '1000',
          required: true,
          minLength: null,
          maxLength: null,
          minimum: 0,
          maximum: 10_000_000,
          options: [],
        },
      ],
    }
    expect(evaluateConsoleEditorDraft(editor, { minimumVisitors: '1000' })).toEqual(
      expect.objectContaining({ valid: true, reasonCode: 'FIXTURE_EDITOR_PREVIEW_VALID', issueCodes: [] }),
    )
    const invalid = evaluateConsoleEditorDraft(editor, { minimumVisitors: '-1' })
    expect(invalid).toEqual(
      expect.objectContaining({
        valid: false,
        reasonCode: 'FIXTURE_EDITOR_PREVIEW_INVALID',
        issueCodes: ['minimumVisitors:BELOW_MINIMUM'],
      }),
    )
    expect(JSON.stringify(invalid)).not.toContain('-1')
  })

  test('validates real calendar dates and requires campaign end dates after start dates', () => {
    const field = (name) => ({
      name,
      label: name,
      kind: 'date',
      defaultValue: '',
      required: true,
      minLength: null,
      maxLength: null,
      minimum: null,
      maximum: null,
      options: [],
    })
    const editor = {
      editorId: 'campaign-editor:fixture:test',
      schemaVersion: 'campaign-editor-v1',
      title: '캠페인',
      description: 'fixture',
      currentVersion: 7,
      lifecycleState: 'draft',
      makerCheckerState: 'maker_draft_checker_pending',
      fields: [field('startsOn'), field('endsOn')],
      constraints: [
        {
          kind: 'date_order',
          startField: 'startsOn',
          endField: 'endsOn',
          issueCode: 'campaignPeriod:END_NOT_AFTER_START',
        },
      ],
    }

    expect(evaluateConsoleEditorDraft(editor, { startsOn: '2026-09-30', endsOn: '2026-08-01' })).toEqual(
      expect.objectContaining({ valid: false, issueCodes: ['campaignPeriod:END_NOT_AFTER_START'] }),
    )
    expect(evaluateConsoleEditorDraft(editor, { startsOn: '2026-02-30', endsOn: '2026-09-30' })).toEqual(
      expect.objectContaining({ valid: false, issueCodes: ['startsOn:DATE_INVALID'] }),
    )
  })

  test('attaches the real campaign command states and date-order constraint to the shipped editor', async () => {
    const screen = await CONSOLE_FIXTURE_GATEWAY.campaignEditor(
      OPERATOR_CONSOLE_TEST_FIXTURE_SESSION,
      FIXTURE_CAMPAIGN_ID,
    )
    expect(screen).not.toBeNull()
    const editor = screen.editor
    expect(editor).not.toBeNull()
    expect(
      editor.fields.find((field) => field.name === 'campaignStatus')?.options.map((option) => option.value),
    ).toEqual(['draft', 'active', 'paused', 'closed'])
    expect(editor.constraints).toEqual([
      {
        kind: 'date_order',
        startField: 'startsOn',
        endField: 'endsOn',
        issueCode: 'campaignPeriod:END_NOT_AFTER_START',
      },
    ])
    const values = Object.fromEntries(editor.fields.map((field) => [field.name, field.defaultValue]))
    expect(evaluateConsoleEditorDraft(editor, { ...values, startsOn: '2026-09-30', endsOn: '2026-09-30' })).toEqual(
      expect.objectContaining({ valid: false, issueCodes: ['campaignPeriod:END_NOT_AFTER_START'] }),
    )
  })
})
