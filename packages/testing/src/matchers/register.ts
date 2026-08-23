import { expect } from 'vitest'
import { detectPii, describeFindings } from './no-pii.js'

// Registers `expect(...).toContainNoPii()` and the stdout capture that the security tier uses.
//
// Two levels, because they answer different questions:
//
//   toContainNoPii() — assert about a string you already hold. Any tier can use it.
//   captureOutput()  — capture everything a block writes to stdout/stderr, so a test can assert on
//                      output it never sees directly. This is what catches the real failure mode: a
//                      field somebody added to a log call months after the line was written.

declare module 'vitest' {
  // The type parameter must match Vitest's own declaration EXACTLY — it declares
  // `interface Matchers<T = any>`, and TypeScript refuses to merge declarations whose parameters
  // differ. This is the one place `any` is unavoidable: it is mirroring a third-party signature,
  // not describing our own value.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> {
    toContainNoPii: () => T
  }
}

expect.extend({
  toContainNoPii(received: unknown) {
    if (typeof received !== 'string') {
      return { pass: false, message: () => `expected a string to scan, received ${typeof received}` }
    }

    const findings = detectPii(received)
    return {
      pass: findings.length === 0,
      message: () =>
        findings.length === 0
          ? 'expected the text to contain personal data, but none was found'
          : `personal data reached output that must not carry it (SPEC.md §21.4):\n${describeFindings(findings)}`,
    }
  },
})

/**
 * Run `body` with stdout and stderr captured, and return everything it wrote.
 *
 * Restores the originals in a finally, so a throwing body cannot leave the process unable to print
 * — which would turn one failing test into a silent suite.
 */
export const captureOutput = async (body: () => void | Promise<void>): Promise<string> => {
  const chunks: string[] = []
  const originalOut = process.stdout.write.bind(process.stdout)
  const originalErr = process.stderr.write.bind(process.stderr)

  const collect =
    (passthrough: typeof originalOut) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      chunks.push(String(chunk))
      // Still written through: a captured test must not go blind when it fails.
      // Reflect.apply returns `any`; routed via unknown so nothing untyped escapes. The return
      // value is a backpressure hint, and only an explicit false means "slow down".
      const accepted: unknown = Reflect.apply(passthrough, process.stdout, [chunk, ...rest])
      return accepted !== false
    }

  process.stdout.write = collect(originalOut)
  process.stderr.write = collect(originalErr)
  try {
    await body()
  } finally {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
  }

  return chunks.join('')
}
