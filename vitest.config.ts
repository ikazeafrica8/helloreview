import { defineConfig } from 'vitest/config'

// Test tiers, per SPEC.md §7.
//
// Each tier is a separate project so it can be run alone: `pnpm test:unit` must stay fast enough to
// sit inside the pre-commit gate, while the integration tier starts containers and is not.
//
// A NOTE ON DECORATORS, which shapes what may live in which tier.
// Vitest transforms TypeScript with esbuild, and esbuild does not emit `emitDecoratorMetadata`
// (measured in T4: an app built that way boots and then 500s on every injected request). So a test
// that needs NestJS dependency injection must NOT import .ts sources directly — it exercises the
// tsc-compiled output in dist/ instead, which is what the integration tier already does. Pure
// functions have no decorators, so the unit and transition tiers are unaffected and need no extra
// transform. If a future test genuinely needs Nest's TestingModule over sources, that is the point
// to add an SWC transform — not before.

/**
 * Timeouts are per tier on purpose.
 *
 * Vitest defaults to 5s, which is right for a pure function and wrong for anything that compiles a
 * workspace, boots a server or starts a container — those legitimately take tens of seconds. Giving
 * the slow tiers a generous budget while the unit tier keeps the tight default means a genuinely
 * hung unit test still fails fast, instead of every tier inheriting the slowest one's patience.
 */
interface TierOptions {
  timeoutMs?: number
  /** Share one worker: the tier touches Docker and host ports, which cannot be used concurrently. */
  serial?: boolean
  /** Files run before each test file in this tier. */
  setupFiles?: string[]
}

const tier = (
  name: string,
  include: string[],
  { timeoutMs = 5_000, serial = false, setupFiles = [] }: TierOptions = {},
) => ({
  test: {
    name,
    include,
    environment: 'node' as const,
    testTimeout: timeoutMs,
    hookTimeout: timeoutMs,
    // The later tiers are empty until the tasks that fill them land, and an empty tier must not
    // fail the run — otherwise `pnpm verify` is red from now until T36.
    passWithNoTests: true,
    // Every tier can use expect(...).toContainNoPii(); the security tier additionally captures all
    // output automatically (see its setupFiles below).
    setupFiles: ['./packages/testing/src/matchers/register.ts', ...setupFiles],
    // fileParallelism/maxWorkers rather than poolOptions.forks.singleFork: Vitest 4 deprecates that
    // idiom and ignores it, so the config would look correct and quietly do nothing.
    ...(serial ? { pool: 'forks' as const, fileParallelism: false, maxWorkers: 1 } : {}),
  },
})

/** Compiles workspaces, boots servers, starts containers. */
const SLOW_TIER_TIMEOUT_MS = 180_000

export default defineConfig({
  test: {
    // Also required at the root, not only per project: the per-project flag governs that project's
    // own result, but the overall run still exits 1 when a filtered tier matched no files. Without
    // this, `pnpm verify` is red from now until T36 fills the transitions tier.
    passWithNoTests: true,

    projects: [
      // Pure functions: no I/O, no containers, no child processes. SPEC.md §7.
      tier('unit', ['tests/unit/**/*.test.{ts,mts,mjs}', 'apps/*/src/**/*.spec.ts', 'packages/*/src/**/*.spec.ts']),
      // Every §14.5 legal transition and every §14.6 illegal one (T36, T37).
      tier('transitions', ['tests/transitions/**/*.test.{ts,mts,mjs}']),
      // Real Postgres and Redis, real child processes, fake providers.
      //
      // SERIAL, deliberately. These files share one Docker daemon and one set of host ports: two
      // running at once means a container-leak assertion counts a sibling's container, and a boot
      // test races another for the same port. Measured — the leak assertions failed intermittently
      // under parallelism and pass reliably serialized.
      tier('integration', ['tests/integration/**/*.test.{ts,mts,mjs}'], {
        timeoutMs: SLOW_TIER_TIMEOUT_MS,
        serial: true,
      }),
      // Authorization, webhook spoofing and replay, file attacks, PII in logs (T12, T16).
      // The PII capture applies to EVERY test here, not only ones that remember to ask (T12).
      tier('security', ['tests/security/**/*.test.{ts,mts,mjs}'], {
        timeoutMs: SLOW_TIER_TIMEOUT_MS,
        setupFiles: ['./packages/testing/src/matchers/security-setup.ts'],
      }),
      // The §26.3 acceptance tests that gate release (T20, T33, T47, T52, T56).
      tier('e2e', ['tests/e2e/**/*.test.{ts,mts,mjs}'], { timeoutMs: SLOW_TIER_TIMEOUT_MS, serial: true }),
    ],

    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text-summary', 'html'],
      // dist/ is INCLUDED, not excluded. v8 remaps through the tsc source maps back to src/*.ts
      // (every workspace sets sourceMap: true), so a test that imports compiled output still
      // attributes its coverage to the source file. Excluding dist/ would silently discard all of
      // it — and since Nest-DI tests must run against compiled output, that would zero out exactly
      // the modules the §7 thresholds care about.
      //
      // This does NOT recover coverage from a SPAWNED process: v8 cannot observe a child at all.
      // That distinction is why the global threshold below is where it is.
      include: ['apps/*/src/**', 'packages/*/src/**', 'apps/*/dist/**/*.js', 'packages/*/dist/**/*.js'],
      exclude: [
        '**/*.spec.ts',
        // Public surfaces: re-exports with no logic to cover.
        '**/index.ts',
        // Composition roots and wiring. These are exercised by the integration tier, which boots
        // the built process — and v8 coverage cannot observe a child process at all, so counting
        // them would permanently understate how much logic is actually tested. Excluding a
        // composition root is conventional; excluding logic would be gaming the number.
        '**/main.ts',
        '**/*.module.ts',
        '**/tokens.ts',
        '**/processors/index.ts',
        // A single line whose entire purpose is to touch process.env.
        '**/config/env-source.ts',
      ],

      // Apply `exclude` to the REMAPPED paths, not the raw ones.
      //
      // Without this the exclusions above were almost entirely inert. `include` deliberately covers
      // `dist/**/*.js` so the integration tier's measurements can be remapped through the source
      // maps back onto TypeScript — but the exclusion globs are all written against `.ts` paths, so
      // by default they were tested against `main.js`, `app.module.js`, `index.js` and matched
      // nothing. Every composition root the list names was still being counted.
      //
      // The default is false, which is why this needed saying out loud rather than assuming.
      excludeAfterRemap: true,

      // SPEC.md §7. Coverage is a floor, not the goal: a module at 95% with no test for its illegal
      // transitions fails review, and one at 82% with the full §26.2 matrix covered passes.
      thresholds: {
        // SPEC.md §7's value, restored. This sat at 40 as a "documented deviation needing a
        // decision", on the reasoning that 80 was unreachable because v8 cannot observe a child
        // process and most code today is bootstrap exercised by the integration tier.
        //
        // That reasoning was mostly wrong, and two measurement bugs were hiding it:
        //
        //   1. `excludeAfterRemap` defaults to FALSE, so every exclusion above was inert — the
        //      globs are written against .ts paths but were being matched against the emitted .js.
        //      Composition roots the list explicitly names were still counted as uncovered.
        //   2. dist held 28 orphaned modules from the T8 refactor and 88 leaked lint fixtures, all
        //      counted as real, uncovered application code.
        //
        // With both fixed the same test suite reports 82% lines and 84% statements, no new tests
        // written. The deviation was an artifact, so there is nothing left to decide.
        //
        // The margin over 80 is thin on purpose: this is a floor that should bite when Phase 2 adds
        // logic without tests. If it goes red, the fix is a test, not a lower number.
        lines: 80,
        statements: 80,

        // Pure, small, and where the safety guarantees live — so 100% branch is reachable and
        // cheap. You cannot hit 100% branch on a function that reads a clock, which is exactly why
        // eslint.config.js forbids these files from doing so.
        '**/*-gate.ts': { branches: 100, lines: 100 },
        '**/*-predicate.ts': { branches: 100, lines: 100 },
        '**/*-validator.ts': { branches: 100, lines: 100 },
        '**/dedupe-key.ts': { branches: 100, lines: 100 },
        '**/rules-engine/**': { branches: 100, lines: 100 },

        // The §14 state model.
        '**/modules/selection/**': { lines: 90 },
        '**/modules/shipping/**': { lines: 90 },
        '**/modules/payback-consent/**': { lines: 90 },
        '**/modules/business-approval/**': { lines: 90 },
        '**/modules/reservation/**': { lines: 90 },
        '**/modules/guideline-delivery/**': { lines: 90 },
      },
    },
  },
})
