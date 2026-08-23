import { beforeEach, afterEach, expect } from 'vitest'
import './register.js'
import { detectPii, describeFindings } from './no-pii.js'

// Applied to EVERY test in the security tier (T12's second criterion).
//
// The tier-wide form matters because the realistic leak is not a test that forgets to assert — it is
// a log call somewhere deep in the code that gained a field months after it was written. A test that
// merely exercises that path will now fail, without its author having thought about PII at all.
//
// Other tiers get the matcher but not the automatic capture: capturing everything in the unit tier
// would slow it for no benefit, since it does no I/O.

let captured: string[] = []
let restore: (() => void) | undefined

beforeEach(() => {
  captured = []
  const originalOut = process.stdout.write.bind(process.stdout)
  const originalErr = process.stderr.write.bind(process.stderr)

  const collect =
    (passthrough: typeof originalOut, stream: NodeJS.WriteStream) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      captured.push(String(chunk))
      // Passed through as well: a captured test must not go blind when it fails.
      // Reflect.apply returns `any`; routed via unknown so nothing untyped escapes.
      const accepted: unknown = Reflect.apply(passthrough, stream, [chunk, ...rest])
      return accepted !== false
    }

  process.stdout.write = collect(originalOut, process.stdout)
  process.stderr.write = collect(originalErr, process.stderr)

  restore = () => {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
  }
})

afterEach(() => {
  // Restore FIRST, so the assertion below can print if it fails.
  restore?.()
  restore = undefined

  const findings = detectPii(captured.join(''))
  expect(
    findings.length,
    `personal data reached the output of this test (SPEC.md §21.4):\n${describeFindings(findings)}`,
  ).toBe(0)
})
