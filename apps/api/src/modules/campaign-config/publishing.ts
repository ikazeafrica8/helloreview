import { Inject, Injectable } from '@nestjs/common'
import { isWellFormedTemplatePurposeCode } from '@helloreview/contracts'
import { Pool, type PoolClient } from 'pg'
import { AUDIT_ACTION, AuditLogService, type AuditActorType } from '../audit-log/index.js'
import { POSTGRES_POOL } from '../platform-core/index.js'
import { CAMPAIGN_CONFIG_REASON, type CampaignConfigReasonCode } from './reason-codes.js'

type ConfigurationActor = Readonly<{
  type: Extract<AuditActorType, 'operator' | 'system'>
  /** Already masked or pseudonymous; raw staff names do not belong in configuration history. */
  id: string
}>

type GuidelinePublishCommand = Readonly<{
  guidelineVersionId: string
  effectiveFrom: Date
  publishedAt: Date
  actor: ConfigurationActor
}>

type TemplateTransitionCommand = Readonly<{
  templateId: string
  occurredAt: Date
  actor: ConfigurationActor
}>

export type PublishedGuidelineVersion = Readonly<{
  id: string
  campaignId: string
  version: number
}>

export type TransitionedMessageTemplate = Readonly<{
  id: string
  purposeCode: string
  version: number
  status: 'approved' | 'active' | 'retired'
}>

export class ConfigurationPublishingError extends Error {
  override readonly name = 'ConfigurationPublishingError'

  constructor(
    readonly reasonCode: CampaignConfigReasonCode,
    readonly targetId: string,
  ) {
    super(`Configuration transition rejected: ${reasonCode}`)
  }
}

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`configuration query returned a non-string ${column}`)
}

const numberColumn = (row: Record<string, unknown>, column: string): number => {
  const value = Number(row[column])
  if (Number.isInteger(value)) return value
  throw new Error(`configuration query returned a non-integer ${column}`)
}

/**
 * The write boundary for immutable guidelines and legally-reviewed templates (T24).
 *
 * Each state transition is one database transaction. The audit write follows the commit because
 * AuditLogService owns its own connection; importantly, the version row itself still carries the
 * actor and timestamp under an immutability trigger, so an audit outage cannot erase the evidence
 * of what was published. AuditLogService still throws, making that outage visible to the caller.
 */
@Injectable()
export class ConfigurationPublishingService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly auditLog: AuditLogService,
  ) {}

  async publishGuidelineVersion(command: GuidelinePublishCommand): Promise<PublishedGuidelineVersion> {
    const published = await this.inTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT id, campaign_id, version, status
           FROM guideline_versions
          WHERE id = $1
          FOR UPDATE`,
        [command.guidelineVersionId],
      )
      const row = result.rows[0]
      if (row === undefined) {
        throw new ConfigurationPublishingError(
          CAMPAIGN_CONFIG_REASON.GUIDELINE_VERSION_NOT_FOUND,
          command.guidelineVersionId,
        )
      }
      if (row.status !== 'draft') {
        throw new ConfigurationPublishingError(
          CAMPAIGN_CONFIG_REASON.GUIDELINE_VERSION_NOT_DRAFT,
          command.guidelineVersionId,
        )
      }

      const campaignId = stringColumn(row, 'campaign_id')

      // Close the predecessor before opening the successor. Both changes roll back together if
      // either trigger or constraint rejects the publication.
      await client.query(
        `UPDATE guideline_versions
            SET status = 'superseded', effective_to = $2
          WHERE campaign_id = $1
            AND status = 'published'
            AND effective_to IS NULL
            AND id <> $3`,
        [campaignId, command.effectiveFrom, command.guidelineVersionId],
      )

      const updated = await client.query<Record<string, unknown>>(
        `UPDATE guideline_versions
            SET status = 'published',
                effective_from = $2,
                published_by = $3,
                published_at = $4
          WHERE id = $1
          RETURNING id, campaign_id, version`,
        [command.guidelineVersionId, command.effectiveFrom, command.actor.id, command.publishedAt],
      )
      const publishedRow = updated.rows[0]
      if (publishedRow === undefined) throw new Error('guideline publication updated no row')

      return {
        id: stringColumn(publishedRow, 'id'),
        campaignId: stringColumn(publishedRow, 'campaign_id'),
        version: numberColumn(publishedRow, 'version'),
      }
    })

    await this.auditLog.record({
      actorType: command.actor.type,
      actorId: command.actor.id,
      action: AUDIT_ACTION.GUIDELINE_VERSION_PUBLISHED,
      targetType: 'guideline_version',
      targetId: published.id,
      result: 'success',
      detail: { campaignId: published.campaignId, version: published.version },
      occurredAt: command.publishedAt,
    })

    return published
  }

  async approveTemplate(command: TemplateTransitionCommand): Promise<TransitionedMessageTemplate> {
    const approved = await this.transitionDraftTemplate(command)
    await this.recordTemplateAudit(AUDIT_ACTION.TEMPLATE_APPROVED, approved, command)
    return approved
  }

  async activateTemplate(command: TemplateTransitionCommand): Promise<TransitionedMessageTemplate> {
    const transition = await this.inTransaction(async (client) => {
      const row = await this.lockTemplate(client, command.templateId)
      if (row.status !== 'approved') {
        throw new ConfigurationPublishingError(CAMPAIGN_CONFIG_REASON.TEMPLATE_NOT_APPROVED, command.templateId)
      }
      if (row.requires_provider_approval === true && row.provider_template_code === null) {
        throw new ConfigurationPublishingError(
          CAMPAIGN_CONFIG_REASON.TEMPLATE_PROVIDER_APPROVAL_MISSING,
          command.templateId,
        )
      }

      const purposeCode = stringColumn(row, 'purpose_code')
      const retired = await client.query<Record<string, unknown>>(
        `UPDATE message_templates
            SET status = 'retired', retired_at = $2
          WHERE purpose_code = $1 AND status = 'active' AND id <> $3
          RETURNING id, purpose_code, version`,
        [purposeCode, command.occurredAt, command.templateId],
      )
      const activated = await client.query<Record<string, unknown>>(
        `UPDATE message_templates
            SET status = 'active', activated_at = $2
          WHERE id = $1
          RETURNING id, purpose_code, version`,
        [command.templateId, command.occurredAt],
      )
      const activeRow = activated.rows[0]
      if (activeRow === undefined) throw new Error('template activation updated no row')

      return {
        activated: this.templateResult(activeRow, 'active'),
        retired: retired.rows.map((retiredRow) => this.templateResult(retiredRow, 'retired')),
      }
    })

    for (const retired of transition.retired) {
      await this.recordTemplateAudit(AUDIT_ACTION.TEMPLATE_RETIRED, retired, command)
    }
    await this.recordTemplateAudit(AUDIT_ACTION.TEMPLATE_ACTIVATED, transition.activated, command)
    return transition.activated
  }

  async retireTemplate(command: TemplateTransitionCommand): Promise<TransitionedMessageTemplate> {
    const retired = await this.inTransaction(async (client) => {
      const row = await this.lockTemplate(client, command.templateId)
      if (row.status !== 'approved' && row.status !== 'active') {
        throw new ConfigurationPublishingError(CAMPAIGN_CONFIG_REASON.TEMPLATE_NOT_RETIRABLE, command.templateId)
      }
      const result = await client.query<Record<string, unknown>>(
        `UPDATE message_templates
            SET status = 'retired', retired_at = $2
          WHERE id = $1
          RETURNING id, purpose_code, version`,
        [command.templateId, command.occurredAt],
      )
      const retiredRow = result.rows[0]
      if (retiredRow === undefined) throw new Error('template retirement updated no row')
      return this.templateResult(retiredRow, 'retired')
    })

    await this.recordTemplateAudit(AUDIT_ACTION.TEMPLATE_RETIRED, retired, command)
    return retired
  }

  private async transitionDraftTemplate(command: TemplateTransitionCommand): Promise<TransitionedMessageTemplate> {
    return this.inTransaction(async (client) => {
      const row = await this.lockTemplate(client, command.templateId)
      if (row.status !== 'draft') {
        throw new ConfigurationPublishingError(CAMPAIGN_CONFIG_REASON.TEMPLATE_NOT_DRAFT, command.templateId)
      }

      const purposeCode = stringColumn(row, 'purpose_code')
      if (!isWellFormedTemplatePurposeCode(purposeCode)) {
        throw new ConfigurationPublishingError(CAMPAIGN_CONFIG_REASON.TEMPLATE_PURPOSE_INVALID, command.templateId)
      }

      const result = await client.query<Record<string, unknown>>(
        `UPDATE message_templates
            SET status = 'approved', approved_by = $2, approved_at = $3
          WHERE id = $1
          RETURNING id, purpose_code, version`,
        [command.templateId, command.actor.id, command.occurredAt],
      )
      const approvedRow = result.rows[0]
      if (approvedRow === undefined) throw new Error('template approval updated no row')
      return this.templateResult(approvedRow, 'approved')
    })
  }

  private async lockTemplate(client: PoolClient, templateId: string): Promise<Record<string, unknown>> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT id, purpose_code, version, status, requires_provider_approval, provider_template_code
         FROM message_templates
        WHERE id = $1
        FOR UPDATE`,
      [templateId],
    )
    const row = result.rows[0]
    if (row === undefined) {
      throw new ConfigurationPublishingError(CAMPAIGN_CONFIG_REASON.TEMPLATE_NOT_FOUND, templateId)
    }
    return row
  }

  private templateResult(
    row: Record<string, unknown>,
    status: TransitionedMessageTemplate['status'],
  ): TransitionedMessageTemplate {
    return {
      id: stringColumn(row, 'id'),
      purposeCode: stringColumn(row, 'purpose_code'),
      version: numberColumn(row, 'version'),
      status,
    }
  }

  private async recordTemplateAudit(
    action:
      | typeof AUDIT_ACTION.TEMPLATE_APPROVED
      | typeof AUDIT_ACTION.TEMPLATE_ACTIVATED
      | typeof AUDIT_ACTION.TEMPLATE_RETIRED,
    template: TransitionedMessageTemplate,
    command: TemplateTransitionCommand,
  ): Promise<void> {
    await this.auditLog.record({
      actorType: command.actor.type,
      actorId: command.actor.id,
      action,
      targetType: 'message_template',
      targetId: template.id,
      result: 'success',
      detail: { purposeCode: template.purposeCode, version: template.version, status: template.status },
      occurredAt: command.occurredAt,
    })
  }

  private async inTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
