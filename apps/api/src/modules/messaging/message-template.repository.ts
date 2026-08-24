import { Injectable } from '@nestjs/common'
import type { DbTransaction } from '@helloreview/db'
import { MESSAGING_REASON } from './reason-codes.js'

export type ResolvedMessageTemplate = Readonly<{
  id: string
  purposeCode: string
  version: number
  body: string
  providerTemplateCode?: string
}>

export class MessageTemplateResolutionError extends Error {
  override readonly name = 'MessageTemplateResolutionError'
  readonly reasonCode = MESSAGING_REASON.TEMPLATE_NOT_ACTIVE

  constructor(
    readonly purposeCode: string,
    readonly version: number,
  ) {
    super(`no active message template ${purposeCode} version ${String(version)}`)
  }
}

const requiredString = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`message template query returned invalid ${column}`)
}

@Injectable()
export class MessageTemplateRepository {
  async resolve(tx: DbTransaction, purposeCode: string, version: number): Promise<ResolvedMessageTemplate> {
    const result = await tx.query(
      `SELECT id, purpose_code, version, body, provider_template_code
         FROM message_templates
        WHERE purpose_code = $1 AND version = $2 AND status = 'active'`,
      [purposeCode, version],
    )
    const row = result.rows[0]
    if (row === undefined) throw new MessageTemplateResolutionError(purposeCode, version)

    const returnedVersion = Number(row.version)
    if (!Number.isInteger(returnedVersion)) throw new Error('message template query returned invalid version')
    const providerTemplateCode = row.provider_template_code
    if (
      providerTemplateCode !== null &&
      providerTemplateCode !== undefined &&
      typeof providerTemplateCode !== 'string'
    ) {
      throw new Error('message template query returned invalid provider_template_code')
    }

    return {
      id: requiredString(row, 'id'),
      purposeCode: requiredString(row, 'purpose_code'),
      version: returnedVersion,
      body: requiredString(row, 'body'),
      ...(typeof providerTemplateCode === 'string' ? { providerTemplateCode } : {}),
    }
  }
}
