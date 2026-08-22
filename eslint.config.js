// ESLint flat configuration — T2.
//
// This file encodes the mechanical half of SPEC.md §6 and §8. The rules here are the ones a
// machine can check; the rest live in review and in the test tiers of SPEC.md §7.
//
// Read the numbered blocks below in order. Later blocks win, which is the extension mechanism
// every later task uses: T6 appends the module-boundary rule, T8 appends the config-loader
// exemption, T42 appends the dedupe-key builder exemption. Nothing here needs rewriting for any
// of them.
//
// NOT in this file, deliberately:
//   - Module boundaries (SPEC.md §5 "index.ts is the ONLY public surface", §3.1 dependency
//     table). That is T6, which reads the table from one machine-readable file and resolves
//     imports to real paths. A `no-restricted-imports` approximation here would match the import
//     *string* rather than the resolved path, miss relative deep imports, and have to be deleted
//     by T6. See the T6 APPEND POINT near the bottom.
//   - Formatting. Prettier owns it; eslint-config-prettier last switches off anything that would
//     argue. Run `pnpm format:check` as its own step, not through an ESLint plugin.

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import { defineConfig, globalIgnores } from 'eslint/config'
import { moduleBoundaries } from './tools/eslint-rules/module-boundaries.js'

// -----------------------------------------------------------------------------------------------
// Path sets
// -----------------------------------------------------------------------------------------------

/**
 * Files guaranteed to be covered by a workspace tsconfig, and therefore the only files that get
 * type-aware linting. See the decision note above block 3.
 *
 * A new workspace added by T4/T5/T9/T14 matches these globs automatically — no edit required.
 */
const TYPE_AWARE = ['apps/*/src/**/*.{ts,mts,cts}', 'packages/*/src/**/*.{ts,mts,cts}']

/**
 * SPEC.md §6: "Purity is the boundary. Predicates, validators, normalizers, and dedupe-key
 * builders take everything as arguments — including the clock — and perform no I/O."
 *
 * Scoped to filename patterns that do not exist yet, so this rule can never be retroactive — the
 * same property tasks/todo.md gives as the reason for building T6 before the modules exist. It is
 * also what makes SPEC.md §7's "100% branch coverage on every *-gate.ts / *-predicate.ts /
 * *-validator.ts" reachable: you cannot hit 100% branch on a function that reads a clock.
 */
const PURE = [
  '**/*-gate.ts',
  '**/*-predicate.ts',
  '**/*-validator.ts',
  '**/*-normalizer.ts',
  '**/dedupe-key.ts',
  '**/transition-table.ts',
  '**/matching-table.ts',
]

/**
 * Build, operational and test scripts. Not participant-facing, not part of the domain.
 *
 * `tests/**` is here deliberately. Verified: without it, a T7-shaped `tests/transitions/*.spec.ts`
 * containing a diagnostic `console.log` is rejected by `no-console` — a rule whose stated purpose
 * (SPEC.md §6 PII: console output escapes the structured logger and T12's PII matcher) does not
 * apply to test code, which has no participants and no logger.
 */
const TOOLING = [
  'tools/**',
  'infra/**',
  'eval/**',
  'tests/**',
  '**/*.config.{ts,mts,cts,js,mjs,cjs}',
  'eslint.config.js',
]

// -----------------------------------------------------------------------------------------------
// Restricted-syntax selectors
// -----------------------------------------------------------------------------------------------
//
// WHY A REGISTRY INSTEAD OF ONE INLINE ARRAY: overriding `no-restricted-syntax` in a later block
// REPLACES the whole selector array, it does not merge. An exemption block that writes
// `'no-restricted-syntax': 'off'` to excuse one selector silently drops all the others. Naming
// each group and composing with restrict() makes every exemption say exactly what it gives up.
//
// SELECTOR MECHANICS, verified rather than remembered: esquery's `:has()` does NOT support a
// leading child combinator — `:has(> Foo)` matches nothing and fails SILENTLY. Every selector
// below therefore uses attribute paths (`[typeAnnotation.typeName.name="const"]`,
// `[arguments.0.name!="tx"]`), which are verified working. Do not "simplify" one into `:has(>`.

/**
 * SPEC.md §6 PII / §8 Never: "Log full phone numbers, addresses, ... secrets, or authorization
 * headers". Qualified names only — a bare `name` would collide with campaign name, business name
 * (T23 config), template name and queue name, and the rule would be disabled within a week.
 */
const SENSITIVE_KEYS = [
  'phone',
  'phoneNumber',
  'mobile',
  'tel',
  'address',
  'addressLine',
  'roadAddress',
  'zipCode',
  'realName',
  'recipientName',
  'applicantName',
  'participantName',
  'residentRegistrationNumber',
  'rrn',
  'birthDate',
  'email',
  'token',
  'verificationToken',
  'secret',
  'password',
  'authorization',
  'apiKey',
  'accessToken',
  'refreshToken',
  'screenshot',
  'imageData',
  'rawText',
  'messageBody',
  'kakaoUserId',
].join('|')

const SELECTORS = {
  /**
   * T8 acceptance criterion: "process.env access outside the loader fails lint". Landed here so
   * it is never retroactive; T8 appends the loader exemption.
   */
  processEnv: [
    {
      selector: 'MemberExpression[object.name="process"][property.name="env"]',
      message:
        'Read configuration from the injected, Zod-validated config object. Only the platform-core config loader may touch process.env (SPEC.md §5, T8).',
    },
    {
      selector: 'MemberExpression[object.property.name="process"][property.name="env"]',
      message: 'globalThis.process.env is the same violation (SPEC.md §5, T8).',
    },
    {
      selector: 'ImportDeclaration[source.value=/^(node:)?process$/]',
      message: 'Importing the process module bypasses the config-loader ban (SPEC.md §5, T8).',
    },
  ],

  /**
   * SPEC.md §6: "The dedupe key is never hand-concatenated — buildDedupeKey owns the §17.4
   * format". A TRIPWIRE, NOT THE GUARANTEE: the UNIQUE constraint on
   * outbound_notifications.deduplication_key (T41) is the guarantee. This catches the named shapes
   * the spec's own sample code uses; it cannot catch `const k = a + b` passed onward.
   */
  dedupeKey: [
    {
      selector:
        ':matches(VariableDeclarator[id.name=/[Dd]edupe[Kk]ey$/], PropertyDefinition[key.name=/[Dd]edupe[Kk]ey$/], Property[key.name=/^dedupeKey$/], AssignmentExpression[left.property.name=/^dedupeKey$/]) > :matches(TemplateLiteral, BinaryExpression[operator="+"])',
      message: 'Dedupe keys are built only by buildDedupeKey() — it owns the §17.4 format (SPEC.md §6, §8, T42).',
    },
  ],

  /**
   * SPEC.md §6 PII. Also a tripwire: it only sees object literals passed directly as an argument,
   * and it is key-name based, so `logger.info(ctx)` and a key called `data` holding a phone number
   * both sail through. The real enforcement is T12's runtime PII matcher over captured log output.
   */
  piiLogger: [
    {
      selector: `CallExpression[callee.property.name=/^(trace|debug|info|warn|error|fatal)$/] > ObjectExpression > Property:matches([key.name=/^(${SENSITIVE_KEYS})$/],[key.value=/^(${SENSITIVE_KEYS})$/])[value.callee.name!="mask"]`,
      message:
        'Personal data must be masked before it reaches the logger: use mask(...) or a pseudonymous workflow/participant id (SPEC.md §6 PII, §8 Never).',
    },
  ],

  /** SPEC.md §8 Never: "Remove or skip a failing test to make the build green." */
  focusedTests: [
    {
      selector:
        // `todo` is deliberately NOT banned. SPEC.md §8's rule is "do not remove or skip a FAILING
        // test to make the build green" — `test.todo` advertises a test that was never written and
        // shows as such in the output, which is the opposite of hiding a failure.
        'CallExpression[callee.object.name=/^(describe|it|test|suite|bench)$/][callee.property.name=/^(only|skip|failing)$/]',
      message: 'Do not skip or focus tests to go green (SPEC.md §8 Never). Fix it, or delete it with a spec change.',
    },
    {
      selector: 'CallExpression[callee.name=/^(fit|fdescribe|xit|xdescribe)$/]',
      message: 'Do not skip or focus tests to go green (SPEC.md §8 Never).',
    },
  ],

  /**
   * SPEC.md §8 Always: "Commit state and send-intent in the same transaction." T43 enforces this
   * properly at the TYPE level with a branded Tx token that only db.transaction() hands out. This
   * selector is a readability guard against someone later widening that signature — it is not the
   * mechanism, and must not be sold as one.
   */
  outboxTx: [
    {
      // `enqueueIntent` only. A bare `.enqueue(` is a generic method name — verified to fire on an
      // ordinary local queue helper, which is a false positive T5's worker would hit immediately.
      selector: 'CallExpression[callee.property.name="enqueueIntent"][arguments.0.name!="tx"]',
      message:
        'Message intents commit with their state change — pass the transaction handle (SPEC.md §6, §8, FR-MSG-004, T43).',
    },
  ],

  /**
   * T5 acceptance criterion: "Queue names are defined in one shared constant, not string literals
   * at call sites." Inert until BullMQ arrives.
   */
  queueNames: [
    {
      selector: 'NewExpression[callee.name=/^(Queue|Worker|QueueEvents|FlowProducer)$/][arguments.0.type="Literal"]',
      message:
        'Queue names live in the QUEUE_NAMES registry in packages/contracts (T5) — the api is the producer for the T43 outbox and cannot import from apps/worker.',
    },
  ],

  /** SPEC.md §6: purity. Applied only to the PURE path set. */
  purity: [
    {
      selector: 'NewExpression[callee.name="Date"]',
      message:
        'Pure module: the clock arrives as a parameter, it is never read (SPEC.md §6, and the snapshot contract in the §16.9 gate).',
    },
    {
      selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]',
      message: 'Pure module: the clock arrives as a parameter (SPEC.md §6).',
    },
    {
      selector: 'CallExpression[callee.object.name="Math"][callee.property.name="random"]',
      message: 'Pure module: no randomness (SPEC.md §6).',
    },
    {
      selector: 'CallExpression[callee.object.name="crypto"][callee.property.name=/^(randomUUID|randomBytes)$/]',
      message: 'Pure module: no randomness (SPEC.md §6).',
    },
    {
      selector: 'AwaitExpression',
      message: 'Pure module: no I/O. Services own orchestration and persistence (SPEC.md §6).',
    },
    {
      selector:
        ':matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, MethodDefinition)[async=true]',
      message: 'Pure module: no async. Services own orchestration (SPEC.md §6).',
    },
  ],

  /**
   * SPEC.md §6 Naming: "Reason codes, purpose codes, and intent codes SCREAMING_SNAKE inside a
   * const object with as const". File-scoped on purpose — unscoped this would fire on every
   * legitimate `{ retryCount: 3 } as const`.
   */
  reasonCodeCasing: [
    {
      selector:
        // BOTH key forms must be tested. When the key is a string literal, `key.name` is absent and
        // esquery's `!=` compares against the string "undefined", which never matches the pattern —
        // so a correct `{ 'NOT_SELECTED': ... } as const` was verified to be wrongly rejected.
        // Requiring both conditions means the rule fires only when neither form is SCREAMING_SNAKE.
        'TSAsExpression[typeAnnotation.typeName.name="const"] > ObjectExpression > Property[key.name!=/^[A-Z][A-Z0-9_]*$/][key.value!=/^[A-Z][A-Z0-9_]*$/]',
      message:
        'Reason, purpose and intent codes are SCREAMING_SNAKE (SPEC.md §6 Naming). Export the derived union type alongside the registry.',
    },
  ],
}

/** Selectors that apply to ordinary application and test code. */
const BASE_SELECTORS = ['processEnv', 'dedupeKey', 'piiLogger', 'focusedTests', 'outboxTx', 'queueNames']

/**
 * Compose a `no-restricted-syntax` value. Accepts SELECTORS keys and raw selector objects. Always
 * build exemption blocks with this, so what is being given up is written out explicitly.
 */
const restrict = (...items) => [
  'error',
  ...items.flatMap((item) => (typeof item === 'string' ? SELECTORS[item] : [item])),
]

// -----------------------------------------------------------------------------------------------

export default defineConfig([
  // 0. Ignores. Flat config does NOT ignore build output for you, and .eslintignore is inert in
  //    ESLint 10. Everything must be listed here.
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/.turbo/**',
    '**/coverage/**',
    '**/.vitest/**',
    // Drizzle emits these; they are generated SQL wrappers, reviewed as migrations (T9).
    'packages/db/migrations/**',
    // Throwaway fixtures written by tests/toolchain/lint-contract.test.mjs. They must live inside a
    // workspace src/ to get a real TypeScript program, and they contain deliberate violations — so
    // a leaked one would otherwise fail every subsequent `pnpm lint`. The test lints them by
    // explicit path with --no-ignore, so ignoring them here costs the tests nothing.
    'apps/*/src/__lint-fixture-*.ts',
  ]),

  // 1. Everything ESLint parses: JS, MJS, CJS and TS alike.
  //    The syntax-only conventions live here so they also cover tests/, tools/ and config files,
  //    which by design get no type information (see block 3).
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    linterOptions: {
      // A stale `eslint-disable` is a lie about the code. Fail on both kinds.
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    rules: {
      // SPEC.md §6 PII: console.log bypasses the structured logger, its mask() calls, and T12's
      // PII matcher in one move — the matcher greps LOGGER output, so console output escapes it.
      'no-console': 'error',
      'no-restricted-syntax': restrict(...BASE_SELECTORS),
    },
  },

  // 2. All TypeScript, including files with no tsconfig coverage.
  //    Syntax-only TS rules — the non-type-checked `strict` and `stylistic` presets.
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [tseslint.configs.strict, tseslint.configs.stylistic],
    rules: {
      // SPEC.md §6: "Untrusted input is parsed, never cast." This is the syntax-only half — it
      // bans the angle-bracket form outright and forbids `{...} as T` on object literals, and it
      // works even where type information is unavailable. The precise half
      // (no-unsafe-type-assertion) is in block 3.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],

      // T4 PRE-EMPTION. `no-extraneous-class` is 'error' in the strict preset and fires on the
      // core NestJS shape `@Module({...}) export class AppModule {}`. Setting the option now means
      // T4 lands without a lint firefight and without anyone reflexively weakening the preset.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],

      // The preset sets this bare, so the conventional `_unused` prefix would error.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // 3. Type-aware linting — SOURCE ONLY.
  //
  //    THE DECISION, and why it is scoped rather than global:
  //
  //    Type-aware rules are non-negotiable here. T2's own acceptance criterion ("ESLint rejects
  //    `as` casts applied to values typed unknown from external sources") is satisfied by exactly
  //    one rule, @typescript-eslint/no-unsafe-type-assertion, and that rule needs types. So does
  //    switch-exhaustiveness-check, which is what makes SPEC.md §6's flagship promise true — "a
  //    new campaign type is a compile error here, not a workflow that silently falls through to
  //    ready". Syntax-only linting cannot deliver either.
  //
  //    But under `projectService`, a .ts file that NO tsconfig includes is a hard PARSING ERROR,
  //    not a skipped file. Every workspace tsconfig declares `include: ["src/**/*"]`, so pointing
  //    type-aware linting at `**/*.ts` would break the moment a later task adds a file outside
  //    src/ — vitest.config.ts (T7), packages/db/drizzle.config.ts (T9). The obvious escape hatch
  //    is worse: `allowDefaultProject` REJECTS any glob containing `**`, and one bad glob poisons
  //    the whole run.
  //
  //    Scoping to the globs below is what makes this config survive tasks not yet written. Files
  //    outside still get blocks 1 and 2 — the §6 conventions, the strict TS syntax rules and the
  //    `as` backstop — they simply do not get the rules that need a type checker. T7 and T9 opt
  //    their files in by adding tsconfig coverage and one glob here. Additive, not a rewrite.
  {
    files: TYPE_AWARE,
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        // projectService auto-discovers every workspace tsconfig. Never a `project` array — that
        // needs a new glob every time T4/T5/T9/T14 add a workspace.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        // TypeScript 7.x is currently npm `latest`, and typescript-eslint 8.x peer-caps at
        // <6.1.0 — it THROWS AT IMPORT TIME on TS 7, killing the whole lint run rather than just
        // the type-aware rules. The root pin is ^5.7.0 and must stay there. This makes a future
        // bump fail loudly instead of silently degrading.
        onUnsupportedTypeScriptVersion: 'error',
        // NOTE FOR T4: decorators need NO parserOptions here. projectService reads
        // experimentalDecorators / emitDecoratorMetadata from apps/api/tsconfig.json through the
        // real TypeScript program.
      },
    },
    rules: {
      // ===== T2 ACCEPTANCE CRITERION 2, and SPEC.md §6 "as on external data is a lint error" =====
      // Not in ANY preset — not recommended-type-checked, not strict-type-checked, not
      // stylistic-type-checked. It exists only in `all`. Extending strict-type-checked and
      // assuming coverage would ship a T2 that fails its own acceptance criterion.
      '@typescript-eslint/no-unsafe-type-assertion': 'error',

      // SPEC.md §6: "The switch is exhaustive: a new campaign type is a compile error here, not a
      // workflow that silently falls through to ready." Also not in any preset.
      // allowDefaultCaseForExhaustiveSwitch:false is the load-bearing option — it forbids a
      // `default:` on a union switch, which is what turns a new campaign route into an error.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {
          allowDefaultCaseForExhaustiveSwitch: false,
          requireDefaultForNonUnion: true,
          considerDefaultExhaustiveForUnions: false,
        },
      ],

      // SPEC.md §8 Always: "Commit state and send-intent in the same transaction." A dropped await
      // inside db.transaction() means the transaction commits before the enqueue resolves — the
      // exact failure the transactional outbox exists to prevent. Restated with options so
      // `void doFireAndForget()` stays a deliberate, greppable opt-out.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true, ignoreIIFE: false }],

      // SPEC.md §6 Naming: types PascalCase, functions camelCase. Kept deliberately small — this
      // is the rule where lint configs go to die. The `format: null` entries are load-bearing
      // escape hatches: object-literal keys must stay free for Zod shapes, Drizzle column maps,
      // Korean template variable maps and the SCREAMING_SNAKE registries; `import` must stay free
      // or every `import { GUIDELINE_BLOCK }` and every NestJS decorator import is flagged.
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'function', format: ['camelCase'] },
        { selector: 'enumMember', format: ['UPPER_CASE'] },
        { selector: 'objectLiteralProperty', format: null },
        { selector: 'typeProperty', format: null },
        { selector: 'import', format: null },
      ],

      // DELIBERATELY NOT ENABLED: @typescript-eslint/consistent-type-imports.
      // With emitDecoratorMetadata its autofix rewrites constructor-injected imports to
      // `import type`, erasing the class from design:paramtypes and breaking NestJS DI at RUNTIME
      // — a silent failure introduced by a linter. Revisit at T4 against a real Nest module.
    },
  },

  // 4. Convention blocks, scoped by path. Each targets filenames that do not exist yet, so they
  //    are zero-false-positive today and can never become retroactive.

  // SPEC.md §6: purity is the boundary.
  {
    files: PURE,
    rules: { 'no-restricted-syntax': restrict(...BASE_SELECTORS, 'purity') },
  },

  // SPEC.md §6 Naming: reason-code registries.
  {
    files: ['**/reason-codes.ts', '**/purposes.ts', '**/intents.ts'],
    rules: { 'no-restricted-syntax': restrict(...BASE_SELECTORS, 'reasonCodeCasing') },
  },

  // Build and operational scripts. These legitimately read the environment and print to stdout.
  // The exemption is written out by name rather than switching the whole rule off, so it is
  // obvious exactly which convention is relaxed and which still apply.
  {
    files: TOOLING,
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': restrict(...BASE_SELECTORS.filter((key) => key !== 'processEnv')),
    },
  },

  // The only files permitted to read process.env — one per deployable (T4, T5). T8 keeps this
  // exemption when it merges the two loaders and replaces their internals with a Zod schema.
  //
  // Scoped to a FILENAME, not the config folder: env-source.ts exists precisely so the impure read
  // is one line, and widening this to `config/**` would quietly re-open process.env to the
  // validation code beside it.
  //
  // Note the exemption is composed with restrict() and re-lists every other selector by name.
  // Writing `'no-restricted-syntax': 'off'` here would silently drop the dedupe-key, PII-logger,
  // focused-test, outbox and queue-name conventions for this file too — overriding the rule
  // REPLACES its selector array rather than merging with it.
  {
    files: ['**/config/env-source.ts'],
    rules: {
      'no-restricted-syntax': restrict(...BASE_SELECTORS.filter((key) => key !== 'processEnv')),
    },
  },

  // Module boundaries (T6). Enforces the SPEC.md §3.1 capability map on RESOLVED import paths:
  // a module's public surface is its index, and a cross-module edge must be declared in
  // module-graph.json. The rule reads that file, so the table exists in exactly one place.
  //
  // Scoped to apps/** because that is where modules live. Files outside a module (the composition
  // root, tests) are still held to the public-surface half — reaching into internals is wrong from
  // anywhere — but only module-to-module edges are checked against the dependency table.
  {
    files: ['apps/**/*.{ts,mts,cts}'],
    plugins: { local: { rules: { 'module-boundaries': moduleBoundaries } } },
    rules: { 'local/module-boundaries': 'error' },
  },

  // =============================================================================================
  // T6 LANDED — the append point below is kept for the notes that follow it.
  //
  // T6 appends its blocks HERE, between the convention blocks and eslint-config-prettier:
  //   - a `plugins: { local: { rules: { 'module-boundaries': rule } } }` block wired to
  //     tools/eslint-rules/module-boundaries.js, reading module-graph.json;
  //   - the §3.1 dependency table enforcement and the index.ts-only public surface.
  //
  // Use a custom rule rather than `no-restricted-imports`: that rule matches the import SPECIFIER
  // STRING via minimatch, not the resolved path, so a relative deep import such as
  // './modules/guideline-delivery/reason-codes.js' slips past a `**/modules/*/!(index)*` pattern.
  // A resolving rule catches it and can name both modules in the message, which T6's acceptance
  // criteria require.
  // =============================================================================================

  // OTHER RULES DELIBERATELY DEFERRED — recorded here so the intent is not lost. Each is inert or
  // harmful today; the task number is the one that makes it correct.
  //
  // T14 activates this — the §18.4 typed error hierarchy. Banning bare Error BEFORE
  // packages/contracts/src/errors.ts exists would ban the only option available, which is exactly
  // the retroactive-rule trap. (`only-throw-error` is already on via the strict preset.)
  // {
  //   files: ['apps/**/*.ts', 'packages/**/*.ts'],
  //   ignores: ['tests/**', 'packages/testing/**'],
  //   rules: { 'no-restricted-syntax': restrict(...BASE_SELECTORS,
  //     { selector: 'ThrowStatement > NewExpression[callee.name="Error"]',
  //       message: 'Throw a typed error from the §18.4 hierarchy (SPEC.md §6, T14).' }) },
  // },
  //
  // T9 activates this — SPEC.md §8 Always: "Store timestamptz". Drizzle's timestamp() defaults to
  // `timestamp without time zone`. Do NOT try this with a syntax selector (it breaks on
  // `{ precision: 3, withTimezone: true }` and on spread options); ban the raw import and export a
  // wrapped `tstz()` helper from packages/db instead — exact, robust, self-documenting.
  // {
  //   files: ['packages/db/src/schema/**/*.ts'],
  //   rules: { 'no-restricted-imports': ['error', { paths: [{ name: 'drizzle-orm/pg-core',
  //     importNames: ['timestamp'],
  //     message: 'Use tstz() from ../columns — SPEC.md §8 requires timestamptz.' }] }] },
  // },
  //
  // T13 / T34 activate this — SPEC.md §8 Never: "Delete or overwrite business history". Deferred
  // because the table identifiers must be written against real schema exports, not guessed. The
  // database constraint is the enforcement; this is a tripwire.
  // { files: ['apps/**/*.ts'], rules: { 'no-restricted-syntax': restrict(...BASE_SELECTORS,
  //   { selector: 'CallExpression[callee.property.name="delete"][arguments.0.name=/^(auditLogs|workflowEvents|eventInbox)$/]',
  //     message: 'Append-only: corrections supersede, they never erase (SPEC.md §8, §14.7).' }) } },
  //
  // T16 / T30 activate this, as a WARNING not an error — constant-time secret comparison.
  // Name-heuristic with obvious bypasses (`if (a === b)`); pnpm test:security is the real
  // instrument. Its value is firing at review time on webhook signature verification.
  // { selector: 'BinaryExpression[operator=/^([=!]==?)$/]:matches([left.name=/[Ss]ignature$|[Ss]ecret$|[Tt]oken$/],[right.name=/[Ss]ignature$|[Ss]ecret$|[Tt]oken$/])',
  //   message: 'Compare secrets with crypto.timingSafeEqual (T16, T30).' }
  //
  // T8 appends the config-loader exemption HERE, as a block scoped to
  // apps/api/src/modules/platform-core/config/** that re-lists BASE_SELECTORS minus 'processEnv'.
  // T42 appends the same shape for packages/contracts/src/dedupe-key.ts minus 'dedupeKey'.
  // Compose both with restrict() — never `'no-restricted-syntax': 'off'`, which would silently
  // drop every other convention.

  // LAST, ALWAYS. Switches off the core rules that would argue with Prettier. Against this exact
  // rule set it disables very little — typescript-eslint v8 deleted all its formatting rules —
  // but it is one dependency and one array entry, and it is insurance against any future plugin
  // that switches formatting rules back on. Do NOT add eslint-plugin-prettier; `pnpm format:check`
  // is a separate, faster step.
  eslintConfigPrettier,
])
