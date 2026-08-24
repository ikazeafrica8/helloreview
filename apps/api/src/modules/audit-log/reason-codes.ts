// Which audited actions are PROTECTED, and why that classification matters.
//
// PRD §23.3 lists "audit-log failure for protected actions" among the incidents that must raise an
// immediate alert. The distinction is not about importance in general — it is about whether losing
// the record destroys the ability to reconstruct a decision that materially affected a participant.
//
// SPEC.md §9 requires every automated decision to remain reconstructable from this log. For a
// protected action, an audit write that fails and is swallowed means the decision happened and
// nothing can prove why. That is the case worth waking somebody for.

export const AUDIT_ACTION = {
  /** §13.4 — every selection decision must be reconstructable (FR-SEL-005). */
  SELECTION_DECIDED: 'SELECTION_DECIDED',
  SELECTION_OVERRIDDEN: 'SELECTION_OVERRIDDEN',
  /** §13.10 — Visit C approval, recordable only by an authorized source (FR-VC-003). */
  BUSINESS_APPROVAL_CHANGED: 'BUSINESS_APPROVAL_CHANGED',
  /** §13.12 — every delivery stores its full evidence (FR-GDL-003). */
  GUIDELINE_DELIVERED: 'GUIDELINE_DELIVERED',
  /** §13.7 — consent evidence must reconstruct the consent (FR-PAY-006). */
  CONSENT_RECORDED: 'CONSENT_RECORDED',
  /** §14.7 — a correction supersedes rather than erases, so the correction itself is evidence. */
  CORRECTION_APPLIED: 'CORRECTION_APPLIED',
  /** §20.5 — revealing a masked field is itself an audited access (FR-ADM-009). */
  SENSITIVE_FIELD_REVEALED: 'SENSITIVE_FIELD_REVEALED',
  /** §13.14 — the emergency stop, and who used it (FR-HUM-008). */
  AUTOMATION_PAUSED: 'AUTOMATION_PAUSED',

  // Unprotected: useful for operations, but losing one does not make a decision unexplainable.
  HEALTH_CHECKED: 'HEALTH_CHECKED',
  CONFIGURATION_READ: 'CONFIGURATION_READ',

  /**
   * §13.12 / §21.9 configuration publishing (T24). Deliberately UNPROTECTED, and the reasoning is
   * the standard stated above rather than a judgement that these matter less.
   *
   * The test is whether losing the record destroys the ability to reconstruct a decision. It does
   * not here: publishing FREEZES a row, and the row itself carries who did it and when
   * (`published_by`/`published_at`, `approved_by`/`approved_at`) under a trigger that refuses any
   * later edit. The evidence survives in the table whether or not the audit write lands, which is
   * exactly what is NOT true of a selection decision or a consent.
   *
   * Adding them to PROTECTED_ACTIONS would page somebody for an event whose evidence is already
   * durable, and alert fatigue is what makes the genuinely protected eight worth waking for.
   */
  GUIDELINE_VERSION_PUBLISHED: 'GUIDELINE_VERSION_PUBLISHED',
  TEMPLATE_APPROVED: 'TEMPLATE_APPROVED',
  TEMPLATE_ACTIVATED: 'TEMPLATE_ACTIVATED',
  TEMPLATE_RETIRED: 'TEMPLATE_RETIRED',
} as const

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION]

/**
 * Actions whose audit write failing is a critical incident.
 *
 * An explicit set rather than a flag on each entry: whether an action is protected is a property of
 * the ACTION, not of the call site, and letting a caller decide would mean the classification drifts
 * with whoever wrote the line.
 */
export const PROTECTED_ACTIONS: ReadonlySet<string> = new Set<AuditAction>([
  AUDIT_ACTION.SELECTION_DECIDED,
  AUDIT_ACTION.SELECTION_OVERRIDDEN,
  AUDIT_ACTION.BUSINESS_APPROVAL_CHANGED,
  AUDIT_ACTION.GUIDELINE_DELIVERED,
  AUDIT_ACTION.CONSENT_RECORDED,
  AUDIT_ACTION.CORRECTION_APPLIED,
  AUDIT_ACTION.SENSITIVE_FIELD_REVEALED,
  AUDIT_ACTION.AUTOMATION_PAUSED,
])

export const isProtectedAction = (action: string): boolean => PROTECTED_ACTIONS.has(action)
