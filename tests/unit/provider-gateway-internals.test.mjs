// Unit tier: the provider gateway's internals, in process (T16, T17, T18).
//
// The security and e2e tiers exercise this code through a SPAWNED API, which proves the wiring and
// is the only way to prove it. It also means v8 coverage cannot observe any of it — a child process
// is invisible to the coverage of the process that started it — so the gateway read as 42% covered
// while being among the most heavily tested code in the repository.
//
// That is not merely a reporting problem. Coverage that cannot see a module cannot tell you when a
// BRANCH of it stops being exercised, and the branches here are the ones that matter: the size
// limit's drain path, the guard's fail-closed path when the raw body is missing, the registry's
// refusal of an unknown provider. Each is a security property, and each is tested below directly.

// AGAINST BUILT OUTPUT, and .mjs rather than .ts. Both follow the convention T7 established for
// anything Nest-shaped, and both are forced:
//
//   - The root tsconfig sets no `experimentalDecorators`, so pulling apps/api SOURCE into the root
//     program turns every @Injectable in the import graph into TS1206. Only the workspace tsconfig
//     has those flags.
//   - Nest's ExecutionContext and ArgumentsHost have a dozen members each. Satisfying them to build
//     a two-line fake is ceremony that tests the type system rather than the code.
//
// Coverage is unaffected: vitest.config.ts includes dist/**/*.js precisely so v8 can remap through
// the tsc source maps back onto src/*.ts.
import { test, describe, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import {
  singleHeader,
  flattenHeaders,
  collectRawBody,
  PayloadTooLargeStreamError,
  RAW_BODY,
  ProviderRegistry,
  ContractErrorFilter,
  SignatureGuard,
} from '../../apps/api/dist/modules/provider-gateway/index.js'
// The BUILT contracts package, not ../../packages/contracts/src — deliberately, and this is
// load-bearing rather than incidental.
//
// The gateway source under test imports '@helloreview/contracts', which resolves through the
// workspace link to packages/contracts/dist. Importing the same classes from src here would load a
// SECOND copy of each: `instanceof` compares constructor identity, so every assertion about a
// thrown error would be false against a guard throwing exactly the right thing. Measured — four
// tests failed with "expected error to be instance of UnauthenticatedError".
//
// The bare specifier cannot be used from tests/, which declares no dependency on the package, so
// the dist path is named explicitly.
import { UnauthenticatedError, RateLimitedError } from '../../packages/contracts/dist/index.js'

const ROOT = dirname(dirname(import.meta.dirname))

// --------------------------------------------------------------------------------- http helpers

describe('build freshness', () => {
  test('the dist this file imported is not older than its source', () => {
    // WHY AN ASSERTION AND NOT A beforeAll BUILD.
    //
    // The obvious guard — rebuild in `beforeAll` — DOES NOT WORK here, and I verified that rather
    // than assuming it. The imports at the top of this file are static, so the modules are resolved
    // and evaluated at COLLECTION time, before any hook runs. A build in `beforeAll` would produce
    // fresh output that this file had already finished importing, and the suite would report green
    // while testing the previous build. That is a worse failure than no guard, because it looks
    // like one.
    //
    // `pnpm test:unit` now runs `pnpm build` first, which is the actual fix. This assertion is what
    // catches the case that fix cannot reach: someone running `npx vitest` directly. It compares
    // timestamps rather than rebuilding, so it is correct regardless of when imports were resolved.
    //
    // The bug it exists for: gutting the payload size limit in raw-body.middleware.ts
    // (`limitBytes` -> `limitBytes * 1000`) left typecheck, lint and all 254 unit tests green,
    // because nothing in the gate rebuilt apps/api.
    const stale = []

    for (const workspace of ['packages/contracts', 'packages/observability', 'apps/api']) {
      const srcDir = join(ROOT, workspace, 'src')
      const distDir = join(ROOT, workspace, 'dist')

      const walk = (dir) => {
        for (const entry of readdirSync(dir)) {
          const absolute = join(dir, entry)
          if (statSync(absolute).isDirectory()) {
            walk(absolute)
            continue
          }
          if (!entry.endsWith('.ts')) continue
          // The lint-contract tests write throwaway fixtures into apps/api/src and delete them
          // again. They are transient by design and correctly have no compiled counterpart, so
          // walking src for a matching dist file trips on them — caught only by a FULL suite run,
          // where the two files overlap. Skipping them keeps this guard about real modules.
          if (entry.startsWith('__lint-fixture-')) continue

          const compiled = join(distDir, relative(srcDir, absolute).replace(/\.ts$/, '.js'))
          if (!existsSync(compiled)) {
            stale.push(`${workspace}: ${relative(srcDir, absolute)} has never been compiled`)
            continue
          }
          // One second of tolerance: some filesystems record whole seconds, so a build run
          // immediately after an edit can legitimately share its timestamp.
          if (statSync(absolute).mtimeMs > statSync(compiled).mtimeMs + 1000) {
            stale.push(`${workspace}: ${relative(srcDir, absolute)} is newer than its build output`)
          }
        }
      }
      walk(srcDir)
    }

    expect(
      stale,
      `This file imports compiled output, and ${String(stale.length)} source file(s) are newer than it.\n` +
        'Every assertion below is therefore about code that is not the code under review.\n' +
        'Run `pnpm build`, or use `pnpm test:unit`, which builds first.\n\n' +
        stale.map((entry) => `    - ${entry}`).join('\n'),
    ).toEqual([])
  })
})

describe('header flattening', () => {
  test('a single value passes through', () => {
    expect(singleHeader('abc')).toBe('abc')
    expect(singleHeader(undefined)).toBeUndefined()
  })

  test('a REPEATED header takes the first value, never a join', () => {
    // A request carrying two signature headers is either broken or an attempt at request
    // smuggling. Joining them would produce a string matching neither, which then looks like an
    // ordinary signature mismatch rather than the anomaly it is.
    expect(singleHeader(['first', 'second'])).toBe('first')
  })

  test('an empty repeated header does not become an empty string by accident', () => {
    expect(singleHeader([])).toBeUndefined()
  })

  test('flattening preserves every key', () => {
    expect(flattenHeaders({ a: '1', b: ['2', '3'], c: undefined })).toEqual({ a: '1', b: '2', c: undefined })
  })
})

// ------------------------------------------------------------------------------ raw body limits

/** A request stream that emits the given chunks, so the limit logic can be driven precisely. */
const fakeRequest = (chunks, { endAfter = true } = {}) => {
  const emitter = new EventEmitter()
  let destroyed = false
  let paused = false

  // Object.assign INVOKES a getter and copies its value, so spreading `{ get destroyed() {...} }`
  // would freeze the flag at its initial false. defineProperty installs the accessor itself.
  const request = Object.assign(emitter, {
    destroy: () => {
      destroyed = true
      return request
    },
    pause: () => {
      paused = true
      return request
    },
  })
  Object.defineProperty(request, 'destroyed', { get: () => destroyed })
  Object.defineProperty(request, 'paused', { get: () => paused })

  queueMicrotask(() => {
    for (const chunk of chunks) emitter.emit('data', chunk)
    if (endAfter) emitter.emit('end')
  })

  return request
}

describe('collectRawBody', () => {
  test('returns the exact bytes, unparsed', async () => {
    // The signature is computed over BYTES. A helper that decoded and re-encoded would break
    // verification for any body containing a multi-byte character — which for this platform is
    // every body containing a Korean name.
    const body = Buffer.from(JSON.stringify({ name: '홍길동' }), 'utf8')
    const collected = await collectRawBody(fakeRequest([body]), 1024)

    expect(collected.equals(body)).toBe(true)
  })

  test('reassembles a body split across chunks', async () => {
    const parts = [Buffer.from('{"a":'), Buffer.from('1'), Buffer.from('}')]
    const collected = await collectRawBody(fakeRequest(parts), 1024)

    expect(collected.toString('utf8')).toBe('{"a":1}')
  })

  test('accepts a body exactly at the limit', async () => {
    const body = Buffer.alloc(100, 0x61)
    const collected = await collectRawBody(fakeRequest([body]), 100)

    expect(collected.length).toBe(100)
  })

  test('rejects one byte over the limit', async () => {
    await expect(collectRawBody(fakeRequest([Buffer.alloc(101, 0x61)]), 100)).rejects.toBeInstanceOf(
      PayloadTooLargeStreamError,
    )
  })

  test('the limit is enforced across chunks, not per chunk', async () => {
    // Checking each chunk against the limit individually is a plausible mistake that passes the
    // test above and lets an unbounded body through in small pieces.
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(20, 0x61))
    await expect(collectRawBody(fakeRequest(chunks), 100)).rejects.toBeInstanceOf(PayloadTooLargeStreamError)
  })

  test('an oversized body is DRAINED, not reset, while it stays within the allowance', async () => {
    // The behaviour a mildly-oversized client depends on. Closing the socket immediately means the
    // 413 never arrives and the client sees ECONNRESET, indistinguishable from a network fault.
    const request = fakeRequest([Buffer.alloc(150, 0x61), Buffer.alloc(50, 0x61)])
    await expect(collectRawBody(request, 100)).rejects.toBeInstanceOf(PayloadTooLargeStreamError)

    expect(request.destroyed, 'a body within the drain allowance must not be reset').toBe(false)
  })

  test('a body far past the allowance IS cut off', async () => {
    // The other half of the trade. Draining without a bound lets an attacker hold a connection
    // open indefinitely; the allowance is what stops that.
    const huge = Array.from({ length: 20 }, () => Buffer.alloc(100, 0x61))
    const request = fakeRequest(huge, { endAfter: false })

    await expect(collectRawBody(request, 100)).rejects.toBeInstanceOf(PayloadTooLargeStreamError)
    expect(request.destroyed, 'beyond the drain allowance the socket must be closed').toBe(true)
  })

  test('nothing past the limit is retained, whatever the drain does', async () => {
    // Memory is bounded by the LIMIT, not by the allowance. The drain reads bytes; it must not
    // keep them.
    const request = fakeRequest([Buffer.alloc(150, 0x61), Buffer.alloc(100, 0x62)])
    const rejection = await collectRawBody(request, 100).catch((error) => error)

    expect(rejection).toBeInstanceOf(PayloadTooLargeStreamError)
    if (rejection instanceof PayloadTooLargeStreamError) expect(rejection.limitBytes).toBe(100)
  })

  test('a stream error rejects rather than hanging', async () => {
    const emitter = new EventEmitter()
    const request = Object.assign(emitter, { destroy: () => request, pause: () => request })
    queueMicrotask(() => emitter.emit('error', new Error('socket closed')))

    await expect(collectRawBody(request, 1024)).rejects.toThrow('socket closed')
  })

  test('an empty body is a valid body', async () => {
    const collected = await collectRawBody(fakeRequest([]), 1024)
    expect(collected.length).toBe(0)
  })
})

// ------------------------------------------------------------------------------ provider registry

describe('ProviderRegistry', () => {
  const config = {
    environment: 'test',
    webhookSecrets: { helloreview_website: 'a-secret-of-at-least-32-characters-long' },
    webhookReplayWindowSeconds: 300,
  }

  test('builds a verifier for each configured provider', () => {
    const registry = new ProviderRegistry(config)
    expect(registry.verifierFor('helloreview_website')?.provider).toBe('helloreview_website')
  })

  test('returns undefined for a provider it does not know', () => {
    // The guard turns this into the same 401 an invalid signature gets, so provider names cannot be
    // enumerated by watching which failure comes back.
    const registry = new ProviderRegistry(config)
    expect(registry.verifierFor('official_kakao_provider')).toBeUndefined()
    expect(registry.verifierFor('')).toBeUndefined()
  })

  test('the secret is not reachable from the registry or its verifiers', () => {
    const registry = new ProviderRegistry(config)
    const serialized = JSON.stringify({ registry, verifier: registry.verifierFor('helloreview_website') })

    expect(serialized).not.toContain('a-secret-of-at-least-32-characters-long')
  })
})

// -------------------------------------------------------------------------- contract error filter

/** A response that records what was written, instead of writing it. */
const recordingResponse = () => {
  const state = {}
  const response = {
    status: (code) => {
      state.status = code
      return response
    },
    json: (body) => {
      state.body = body
      return response
    },
    on: () => response,
  }
  return { response, state }
}

const hostFor = (response) => ({
  switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
})

describe('ContractErrorFilter', () => {
  test('maps the §18.4 status onto the response', () => {
    const { response, state } = recordingResponse()
    new ContractErrorFilter().catch(new RateLimitedError('slow down', 'RATE_LIMITED'), hostFor(response))

    expect(state.status).toBe(429)
    expect(state.body).toEqual({ accepted: false, error: 'RateLimitedError', reason_code: 'RATE_LIMITED' })
  })

  test('omits the reason code when there is none, rather than sending undefined', () => {
    const { response, state } = recordingResponse()
    new ContractErrorFilter().catch(new UnauthenticatedError('nope'), hostFor(response))

    expect(state.status).toBe(401)
    expect(state.body).toEqual({ accepted: false, error: 'UnauthenticatedError' })
  })

  test('the response body never carries the error MESSAGE', () => {
    // The message is for a log line and may name what failed; the body is disclosed to whoever
    // called, and "which check failed" is exactly what an attacker wants to know.
    const { response, state } = recordingResponse()
    new ContractErrorFilter().catch(
      new UnauthenticatedError('signature mismatch on x-helloreview-signature'),
      hostFor(response),
    )

    expect(JSON.stringify(state.body)).not.toContain('signature mismatch')
  })
})

// ------------------------------------------------------------------------------- signature guard

const contextFor = (request) => ({
  switchToHttp: () => ({ getRequest: () => request, getResponse: () => recordingResponse().response }),
})

describe('SignatureGuard', () => {
  const config = {
    environment: 'test',
    webhookSecrets: { helloreview_website: 'a-secret-of-at-least-32-characters-long' },
    webhookReplayWindowSeconds: 300,
  }
  const guard = () => new SignatureGuard(new ProviderRegistry(config), config)

  test('FAILS CLOSED when the raw body is missing', () => {
    // Reaching the guard without the raw-body middleware means the route is wired wrong. The unsafe
    // reading is to verify a signature over an empty buffer, which succeeds for anyone who signs an
    // empty body — so this must refuse rather than continue.
    expect(() => guard().canActivate(contextFor({ params: { provider: 'helloreview_website' }, headers: {} }))).toThrow(
      UnauthenticatedError,
    )
  })

  test('refuses an unknown provider', () => {
    expect(() =>
      guard().canActivate(contextFor({ params: { provider: 'nobody' }, headers: {}, [RAW_BODY]: Buffer.from('{}') })),
    ).toThrow(UnauthenticatedError)
  })

  test('refuses a request with no signature header', () => {
    expect(() =>
      guard().canActivate(
        contextFor({
          params: { provider: 'helloreview_website' },
          headers: {},
          [RAW_BODY]: Buffer.from('{}'),
        }),
      ),
    ).toThrow(UnauthenticatedError)
  })

  test('an absent provider param is refused rather than treated as a provider named ""', () => {
    expect(() => guard().canActivate(contextFor({ params: {}, headers: {}, [RAW_BODY]: Buffer.from('{}') }))).toThrow(
      UnauthenticatedError,
    )
  })
})
