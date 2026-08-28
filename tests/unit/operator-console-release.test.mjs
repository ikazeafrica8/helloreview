import { describe, expect, test } from 'vitest'
import {
  evaluateConsoleEditorDraft,
  evaluateGovernedAction,
  isConsoleRoute,
  PRD_TIMELINE_CATEGORIES,
} from '../../apps/admin/src/lib/console-contract.ts'

const { CONSOLE_FIXTURE_GATEWAY, CONSOLE_SCREEN_READ_ACTIONS, FIXTURE_CAMPAIGN_ID, FIXTURE_PARTICIPANT_ID } =
  await import('../../apps/admin/src/lib/console-gateway.ts')
const { OPERATOR_CONSOLE_FIXTURE_READ_ACTIONS, OPERATOR_CONSOLE_TEST_FIXTURE_SESSION } =
  await import('../../apps/admin/src/lib/operator-session-contract.ts')

const authorized = (submission) => ({
  session: OPERATOR_CONSOLE_TEST_FIXTURE_SESSION,
  campaignId: FIXTURE_CAMPAIGN_ID,
  ...submission,
})

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
    expect(evaluateGovernedAction(authorized({ action: action(), reason: '', confirmation: '' })).reasonCode).toBe(
      'OPERATOR_REASON_REQUIRED',
    )
    expect(
      evaluateGovernedAction(authorized({ action: action(), reason: '검토 완료', confirmation: '확인' })).reasonCode,
    ).toBe('OPERATOR_CONFIRMATION_REQUIRED')
  })

  test('fails closed on policy denial before exposing target version state', () => {
    const result = evaluateGovernedAction(
      authorized({
        action: action({
          permission: 'policy_blocked',
          expectedVersion: null,
          currentVersion: null,
          blockedReasonCode: 'SENSITIVE_ACCESS_POLICY_NOT_APPROVED',
        }),
        reason: '',
        confirmation: '',
      }),
    )
    expect(result).toEqual(
      expect.objectContaining({ accepted: false, reasonCode: 'SENSITIVE_ACCESS_POLICY_NOT_APPROVED' }),
    )
  })

  test('surfaces stale expected versions and accepts only current fixture commands', () => {
    expect(
      evaluateGovernedAction(
        authorized({
          action: action({ expectedVersion: 4, currentVersion: 5 }),
          reason: '실패 작업 재검토',
          confirmation: '실행 확인',
        }),
      ).reasonCode,
    ).toBe('OPERATOR_EXPECTED_VERSION_STALE')
    expect(
      evaluateGovernedAction(authorized({ action: action(), reason: '실패 작업 재검토', confirmation: '실행 확인' })),
    ).toEqual(expect.objectContaining({ accepted: true, reasonCode: 'FIXTURE_COMMAND_ACCEPTED' }))
  })

  test('keeps preview commands explicitly non-mutating', () => {
    expect(
      evaluateGovernedAction(
        authorized({
          action: action({
            authorizationAction: 'campaigns.read',
            effect: 'preview',
            requiresReason: false,
            confirmationPhrase: null,
            expectedVersion: 4,
            currentVersion: 4,
          }),
          reason: '',
          confirmation: '',
        }),
      ),
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

describe('T133 command-specific console authorization', () => {
  const submission = (overrides = {}) => ({
    action: action(),
    session: OPERATOR_CONSOLE_TEST_FIXTURE_SESSION,
    campaignId: FIXTURE_CAMPAIGN_ID,
    reason: '실패 작업 재검토',
    confirmation: '실행 확인',
    ...overrides,
  })

  test('refuses a command whose authorization action the session does not hold', () => {
    expect(
      evaluateGovernedAction(submission({ action: action({ authorizationAction: 'sensitive_values.reveal' }) })),
    ).toEqual(expect.objectContaining({ accepted: false, reasonCode: 'OPERATOR_ACTION_NOT_AUTHORIZED' }))
    expect(
      evaluateGovernedAction(submission({ action: action({ authorizationAction: 'users_roles.manage' }) })),
    ).toEqual(expect.objectContaining({ accepted: false, reasonCode: 'OPERATOR_ACTION_NOT_AUTHORIZED' }))
  })

  test('refuses a command outside the session campaign scope', () => {
    expect(evaluateGovernedAction(submission({ campaignId: '10000000-0000-4000-8000-000000000099' }))).toEqual(
      expect.objectContaining({ accepted: false, reasonCode: 'OPERATOR_ACTION_NOT_AUTHORIZED' }),
    )
  })

  test('refuses an unmapped fixture scenario instead of issuing a receipt for it', () => {
    expect(evaluateGovernedAction(submission({ action: action({ authorizationAction: null }) }))).toEqual(
      expect.objectContaining({ accepted: false, reasonCode: 'OPERATOR_ACTION_UNMAPPED' }),
    )
  })

  test('never authorizes a command action by read permission alone', () => {
    const readOnlySession = {
      ...OPERATOR_CONSOLE_TEST_FIXTURE_SESSION,
      authorizedActions: OPERATOR_CONSOLE_FIXTURE_READ_ACTIONS,
    }
    expect(evaluateGovernedAction(submission({ session: readOnlySession }))).toEqual(
      expect.objectContaining({ accepted: false, reasonCode: 'OPERATOR_ACTION_NOT_AUTHORIZED' }),
    )
  })

  test('still accepts a command the session is explicitly authorized to simulate', () => {
    expect(evaluateGovernedAction(submission())).toEqual(
      expect.objectContaining({ accepted: true, reasonCode: 'FIXTURE_COMMAND_ACCEPTED' }),
    )
  })

  test('gives every fixture screen command a canonical action the session holds', async () => {
    const routes = Object.keys(CONSOLE_SCREEN_READ_ACTIONS)
    for (const route of routes) {
      const screen = await CONSOLE_FIXTURE_GATEWAY.screen(
        OPERATOR_CONSOLE_TEST_FIXTURE_SESSION,
        route,
        FIXTURE_CAMPAIGN_ID,
      )
      for (const screenAction of screen?.actions ?? []) {
        if (screenAction.permission !== 'fixture_allowed') continue
        expect(screenAction.authorizationAction).not.toBeNull()
        expect(OPERATOR_CONSOLE_TEST_FIXTURE_SESSION.authorizedActions).toContain(screenAction.authorizationAction)
      }
    }
  })
})

describe('T133 average-daily visitor evidence naming', () => {
  test('names the website metric by its source meaning, not as previous-day traffic', async () => {
    const page = await CONSOLE_FIXTURE_GATEWAY.searchParticipants(OPERATOR_CONSOLE_TEST_FIXTURE_SESSION, {
      campaignId: FIXTURE_CAMPAIGN_ID,
      query: '블로거',
    })
    expect(page.items.length).toBeGreaterThan(0)
    for (const participant of page.items) {
      expect(participant).toHaveProperty('averageDailyVisitors')
      expect(participant).not.toHaveProperty('previousDayVisitors')
      expect(typeof participant.averageDailyVisitors === 'number' || participant.averageDailyVisitors === null).toBe(
        true,
      )
    }
  })

  test('keeps every Korean visitor label on the average-daily metric', async () => {
    const screens = await Promise.all(
      Object.keys(CONSOLE_SCREEN_READ_ACTIONS).map((route) =>
        CONSOLE_FIXTURE_GATEWAY.screen(OPERATOR_CONSOLE_TEST_FIXTURE_SESSION, route, FIXTURE_CAMPAIGN_ID),
      ),
    )
    const rendered = JSON.stringify(screens)
    expect(rendered).not.toContain('전일 방문자')
    expect(rendered).toContain('일평균 방문자')
  })
})
