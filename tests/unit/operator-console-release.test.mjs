import { describe, expect, test } from 'vitest'
import {
  evaluateConsoleEditorDraft,
  evaluateGovernedAction,
  isConsoleRoute,
  PRD_TIMELINE_CATEGORIES,
} from '../../apps/admin/src/lib/console-contract.ts'

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
})
