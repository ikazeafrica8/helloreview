// Fixture tests for the module-boundary rule (T6).
//
// A lint rule with no tests is a rule nobody can safely change. These cover both halves — the public
// surface and the declared-dependency table — and each case names a real path shape from this repo,
// so a refactor that moves modules breaks the test rather than silently disabling the rule.

import { test, describe } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { RuleTester } from 'eslint'
import { moduleBoundaries, moduleGraph } from '../../tools/eslint-rules/module-boundaries.js'

const ROOT = dirname(dirname(import.meta.dirname))
const MODULES = `${ROOT}/apps/api/src/modules`

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
})

describe('module boundaries rule', () => {
  test('accepts what the capability map permits and rejects what it does not', () => {
    ruleTester.run('module-boundaries', moduleBoundaries, {
      valid: [
        {
          name: 'a file may reach anywhere inside its own module',
          filename: `${MODULES}/platform-core/health/health.service.ts`,
          code: "import { POSTGRES_POOL } from '../tokens.js'",
        },
        {
          name: 'a declared dependency may be imported through its public surface',
          // module-graph.json: workflow-core dependsOn campaign-config
          filename: `${MODULES}/workflow-core/transition.service.ts`,
          code: "import { resolveRuleVersion } from '../campaign-config/index.js'",
        },
        {
          name: 'the composition root may import any module surface',
          filename: `${ROOT}/apps/api/src/app.module.ts`,
          code: "import { PlatformCoreModule } from './modules/platform-core/index.js'",
        },
        {
          name: 'bare package specifiers are not this rule’s business',
          filename: `${MODULES}/workflow-core/transition.service.ts`,
          code: "import { QUEUE_NAMES } from '@helloreview/contracts'",
        },
      ],

      invalid: [
        {
          name: 'reaching past another module’s index is rejected',
          // workflow-core IS allowed to depend on campaign-config — but only through its surface.
          filename: `${MODULES}/workflow-core/transition.service.ts`,
          code: "import { ruleTable } from '../campaign-config/internal/rule-table.js'",
          errors: [{ messageId: 'deepImport', data: { target: 'campaign-config' } }],
        },
        {
          name: 'an undeclared cross-module edge is rejected and names both modules',
          // module-graph.json: platform-core dependsOn nothing.
          filename: `${MODULES}/platform-core/health/health.service.ts`,
          code: "import { evaluate } from '../../rules-engine/index.js'",
          errors: [{ messageId: 'undeclared', data: { source: 'platform-core', target: 'rules-engine' } }],
        },
        {
          name: 'a dynamic import cannot evade the rule',
          filename: `${MODULES}/platform-core/health/health.service.ts`,
          code: "const m = await import('../../rules-engine/index.js')",
          errors: [{ messageId: 'undeclared' }],
        },
        {
          name: 're-exporting another module’s internals is still a deep import',
          filename: `${MODULES}/workflow-core/index.ts`,
          code: "export { ruleTable } from '../campaign-config/internal/rule-table.js'",
          errors: [{ messageId: 'deepImport' }],
        },
      ],
    })
  })

  test('the graph is the SPEC.md §3.1 map, not a copy of it', () => {
    // One machine-readable source (T6 criterion 3). If the rule ever inlines the table, this fails.
    const ruleSource = readFileSync(join(ROOT, 'tools', 'eslint-rules', 'module-boundaries.js'), 'utf8')
    assert.match(ruleSource, /module-graph\.json/, 'the rule must read the graph from module-graph.json')
    assert.ok(!/dependsOn:\s*\[/.test(ruleSource), 'the dependency table must not be inlined in the rule')
  })

  test('every module the map declares as a dependency exists in the map', () => {
    const known = new Set(Object.keys(moduleGraph.modules))
    const dangling = []
    for (const [id, entry] of Object.entries(moduleGraph.modules)) {
      for (const dependency of entry.dependsOn) {
        if (!known.has(dependency)) dangling.push(`${id} -> ${dependency}`)
      }
    }
    assert.deepEqual(
      dangling,
      [],
      `module-graph.json references modules that do not exist:\n  ${dangling.join('\n  ')}`,
    )
  })

  test('platform-core depends on nothing, which is what makes it the foundation', () => {
    assert.deepEqual(moduleGraph.modules['platform-core'].dependsOn, [])
  })
})
