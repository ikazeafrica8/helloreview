import { MESSAGING_REASON, type MessagingReasonCode } from './reason-codes.js'

export type TemplateVariables = Readonly<Record<string, string | number | boolean>>

export class TemplateRenderingError extends Error {
  override readonly name = 'TemplateRenderingError'

  constructor(
    readonly reasonCode: MessagingReasonCode,
    readonly variableName?: string,
  ) {
    super(`template rendering rejected: ${reasonCode}${variableName === undefined ? '' : ` (${variableName})`}`)
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g
const FORBIDDEN_VARIABLES: ReadonlySet<string> = new Set([
  'selectionscore',
  'matchscore',
  'bloggerscore',
  'rankingscore',
  'internalscore',
  'internaldecisionreason',
  'ruleevaluation',
])

const normalizedVariable = (name: string): string => name.replaceAll('_', '').toLowerCase()

/** Render approved named variables while refusing internal decision data and schema drift. */
export const renderMessageTemplate = (body: string, variables: TemplateVariables): string => {
  const expected = new Set<string>()
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1]
    if (name !== undefined) expected.add(name)
  }

  if (body.replace(PLACEHOLDER, '').includes('{{') || body.replace(PLACEHOLDER, '').includes('}}')) {
    throw new TemplateRenderingError(MESSAGING_REASON.TEMPLATE_SYNTAX_INVALID)
  }

  for (const name of expected) {
    if (FORBIDDEN_VARIABLES.has(normalizedVariable(name))) {
      throw new TemplateRenderingError(MESSAGING_REASON.TEMPLATE_VARIABLE_FORBIDDEN, name)
    }
    if (!(name in variables)) {
      throw new TemplateRenderingError(MESSAGING_REASON.TEMPLATE_VARIABLE_MISSING, name)
    }
  }

  for (const name of Object.keys(variables)) {
    if (FORBIDDEN_VARIABLES.has(normalizedVariable(name))) {
      throw new TemplateRenderingError(MESSAGING_REASON.TEMPLATE_VARIABLE_FORBIDDEN, name)
    }
    if (!expected.has(name)) {
      throw new TemplateRenderingError(MESSAGING_REASON.TEMPLATE_VARIABLE_UNKNOWN, name)
    }
  }

  return body.replace(PLACEHOLDER, (_placeholder, name: string) => String(variables[name]))
}
