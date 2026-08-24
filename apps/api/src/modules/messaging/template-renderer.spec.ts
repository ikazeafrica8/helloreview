import { describe, expect, test } from 'vitest'
import { MESSAGING_REASON } from './reason-codes.js'
import { renderMessageTemplate, TemplateRenderingError } from './template-renderer.js'

describe('renderMessageTemplate', () => {
  test('renders named variables, repeated names, and primitive values', () => {
    expect(
      renderMessageTemplate('{{campaign}} / {{count}} / {{active}} / {{campaign}}', {
        campaign: '서울 체험단',
        count: 2,
        active: true,
      }),
    ).toBe('서울 체험단 / 2 / true / 서울 체험단')
  })

  test('fails loudly for missing, unknown, forbidden, and malformed variables', () => {
    const cases = [
      {
        run: () => renderMessageTemplate('{{campaign}}', {}),
        reason: MESSAGING_REASON.TEMPLATE_VARIABLE_MISSING,
      },
      {
        run: () => renderMessageTemplate('{{campaign}}', { campaign: 'A', extra: 'B' }),
        reason: MESSAGING_REASON.TEMPLATE_VARIABLE_UNKNOWN,
      },
      {
        run: () => renderMessageTemplate('{{selection_score}}', { selection_score: 99 }),
        reason: MESSAGING_REASON.TEMPLATE_VARIABLE_FORBIDDEN,
      },
      {
        run: () => renderMessageTemplate('안내', { internalDecisionReason: 'score' }),
        reason: MESSAGING_REASON.TEMPLATE_VARIABLE_FORBIDDEN,
      },
      {
        run: () => renderMessageTemplate('{{campaign-name}}', {}),
        reason: MESSAGING_REASON.TEMPLATE_SYNTAX_INVALID,
      },
    ]

    for (const item of cases) {
      try {
        item.run()
        throw new Error('expected rendering to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(TemplateRenderingError)
        if (error instanceof TemplateRenderingError) expect(error.reasonCode).toBe(item.reason)
      }
    }
  })
})
