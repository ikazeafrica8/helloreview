import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL } from '@helloreview/db'
import type { Pool, PoolClient } from 'pg'
import { ConfigurationPublishingService } from '../campaign-config/index.js'
import { authorizeAdminInvocation, type AdminInvocation } from './admin-invocation.js'
import type { AdminAction } from './admin-authorization.js'

const RULE_TYPES = ['selection', 'reservation', 'guideline', 'payback', 'shipping'] as const
type RuleType = (typeof RULE_TYPES)[number]
type TemplateTransition = 'approve' | 'activate' | 'retire'

export class AdminConfigurationCommandError extends Error {
  override readonly name = 'AdminConfigurationCommandError'
  constructor(readonly reasonCode: string) {
    super(`admin configuration command rejected: ${reasonCode}`)
  }
}

export type RulePreview = Readonly<{
  valid: boolean
  campaignId: string
  ruleType: RuleType
  version: number
  issueCodes: readonly string[]
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const validateConfiguration = (value: unknown): readonly string[] => {
  const issues: string[] = []
  if (!isRecord(value) || Object.keys(value).length === 0) issues.push('RULE_CONFIGURATION_OBJECT_REQUIRED')
  let encoded = ''
  try {
    encoded = JSON.stringify(value)
  } catch {
    issues.push('RULE_CONFIGURATION_NOT_SERIALIZABLE')
  }
  if (encoded.length > 65_536) issues.push('RULE_CONFIGURATION_TOO_LARGE')
  return issues
}

const actionForRule = (ruleType: RuleType): AdminAction =>
  ruleType === 'selection'
    ? 'selection_rules.publish'
    : ruleType === 'reservation'
      ? 'reservation_rules.publish'
      : 'campaigns.configure'

@Injectable()
export class ConfigurationAdminCommandService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly publishing: ConfigurationPublishingService,
  ) {}

  async configureCampaign(
    invocation: AdminInvocation,
    command: Readonly<{
      campaignId: string
      expectedVersion: number
      name: string
      status: 'draft' | 'active' | 'paused' | 'closed'
      startsAt: Date
      endsAt: Date
      occurredAt: Date
    }>,
  ): Promise<Readonly<{ campaignId: string; version: number; status: string }>> {
    authorizeAdminInvocation(invocation, 'campaigns.configure', command.campaignId)
    if (
      command.name.trim().length < 1 ||
      command.name.length > 200 ||
      Number.isNaN(command.startsAt.getTime()) ||
      Number.isNaN(command.endsAt.getTime()) ||
      command.endsAt <= command.startsAt
    )
      throw new AdminConfigurationCommandError('CAMPAIGN_CONFIGURATION_INVALID')
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE campaigns
          SET name = $3, status = $4, starts_at = $5, ends_at = $6,
              version = version + 1, updated_at = $7
        WHERE id = $1 AND version = $2
        RETURNING id, version, status`,
      [
        command.campaignId,
        command.expectedVersion,
        command.name.trim(),
        command.status,
        command.startsAt,
        command.endsAt,
        command.occurredAt,
      ],
    )
    const row = result.rows[0]
    if (row === undefined) throw new AdminConfigurationCommandError('CAMPAIGN_VERSION_STALE_OR_NOT_FOUND')
    return { campaignId: String(row.id), version: Number(row.version), status: String(row.status) }
  }

  async previewRule(
    invocation: AdminInvocation,
    command: Readonly<{ ruleId: string; expectedVersion: number }>,
  ): Promise<RulePreview> {
    const row = await this.rule(command.ruleId)
    const ruleType = this.ruleType(row.rule_type)
    authorizeAdminInvocation(invocation, actionForRule(ruleType), String(row.campaign_id))
    if (Number(row.version) !== command.expectedVersion) throw new AdminConfigurationCommandError('RULE_VERSION_STALE')
    const issueCodes = [
      ...(row.status === 'draft' ? [] : ['RULE_NOT_DRAFT']),
      ...validateConfiguration(row.configuration),
    ]
    return {
      valid: issueCodes.length === 0,
      campaignId: String(row.campaign_id),
      ruleType,
      version: Number(row.version),
      issueCodes,
    }
  }

  async publishRule(
    invocation: AdminInvocation,
    command: Readonly<{ ruleId: string; expectedVersion: number; effectiveFrom: Date; publishedAt: Date }>,
  ): Promise<RulePreview> {
    const preview = await this.previewRule(invocation, command)
    if (!preview.valid) throw new AdminConfigurationCommandError(preview.issueCodes[0] ?? 'RULE_INVALID')
    await this.transaction(async (client) => {
      const locked = await client.query<Record<string, unknown>>(
        `SELECT id, campaign_id, rule_type, version, status, configuration
           FROM campaign_rules WHERE id = $1 FOR UPDATE`,
        [command.ruleId],
      )
      const row = locked.rows[0]
      if (
        row?.status !== 'draft' ||
        Number(row.version) !== command.expectedVersion ||
        validateConfiguration(row.configuration).length > 0
      )
        throw new AdminConfigurationCommandError('RULE_CHANGED_AFTER_PREVIEW')
      await client.query(
        `UPDATE campaign_rules SET status = 'superseded', effective_to = $3
          WHERE campaign_id = $1 AND rule_type = $2 AND status = 'published' AND effective_to IS NULL`,
        [row.campaign_id, row.rule_type, command.effectiveFrom],
      )
      await client.query(
        `UPDATE campaign_rules
            SET status = 'published', effective_from = $2, published_by = $3, published_at = $4
          WHERE id = $1`,
        [command.ruleId, command.effectiveFrom, invocation.principal.principalReference, command.publishedAt],
      )
    })
    return preview
  }

  async publishGuideline(
    invocation: AdminInvocation,
    command: Readonly<{ guidelineVersionId: string; expectedVersion: number; effectiveFrom: Date; publishedAt: Date }>,
  ) {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT campaign_id, version, status FROM guideline_versions WHERE id = $1`,
      [command.guidelineVersionId],
    )
    const row = result.rows[0]
    if (row === undefined) throw new AdminConfigurationCommandError('GUIDELINE_NOT_FOUND')
    authorizeAdminInvocation(invocation, 'guidelines.publish', String(row.campaign_id))
    if (row.status !== 'draft' || Number(row.version) !== command.expectedVersion)
      throw new AdminConfigurationCommandError('GUIDELINE_VERSION_STALE_OR_NOT_DRAFT')
    return this.publishing.publishGuidelineVersion({
      guidelineVersionId: command.guidelineVersionId,
      effectiveFrom: command.effectiveFrom,
      publishedAt: command.publishedAt,
      actor: { type: 'operator', id: invocation.principal.principalReference },
    })
  }

  async transitionTemplate(
    invocation: AdminInvocation,
    command: Readonly<{
      targetCampaignId: string
      templateId: string
      expectedVersion: number
      transition: TemplateTransition
      occurredAt: Date
    }>,
  ) {
    authorizeAdminInvocation(invocation, 'message_templates.publish', command.targetCampaignId)
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT version FROM message_templates WHERE id = $1`,
      [command.templateId],
    )
    if (Number(result.rows[0]?.version) !== command.expectedVersion)
      throw new AdminConfigurationCommandError('TEMPLATE_VERSION_STALE_OR_NOT_FOUND')
    const transitionCommand = {
      templateId: command.templateId,
      occurredAt: command.occurredAt,
      actor: { type: 'operator' as const, id: invocation.principal.principalReference },
    }
    return command.transition === 'approve'
      ? this.publishing.approveTemplate(transitionCommand)
      : command.transition === 'activate'
        ? this.publishing.activateTemplate(transitionCommand)
        : this.publishing.retireTemplate(transitionCommand)
  }

  private async rule(ruleId: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id, campaign_id, rule_type, version, status, configuration FROM campaign_rules WHERE id = $1`,
      [ruleId],
    )
    const row = result.rows[0]
    if (row === undefined) throw new AdminConfigurationCommandError('RULE_NOT_FOUND')
    return row
  }

  private ruleType(value: unknown): RuleType {
    const found = RULE_TYPES.find((candidate) => candidate === value)
    if (found === undefined) throw new AdminConfigurationCommandError('RULE_TYPE_UNKNOWN')
    return found
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
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
