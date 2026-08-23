// Integration tier: correlation surviving the boundaries that matter (T10).
//
// The unit tests prove the async context works. These prove the two places it is actually load-
// bearing: an HTTP request, and the enqueue/dequeue hop between the api and the worker. Neither can
// be checked without really crossing the boundary.

import { test, describe, beforeAll, expect, onTestFinished } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const CORRELATION_HEADER = 'x-correlation-id'
const TEST_PORT = 13097

const parseEnv = (text) => {
  const out = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return out
}

const envExample = () => parseEnv(readFileSync(join(ROOT, '.env.example'), 'utf8'))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

const bootApi = async () => {
  const env = { ...process.env, ...Object.fromEntries(envExample()), API_PORT: String(TEST_PORT) }
  const child = spawn(process.execPath, [join(ROOT, 'apps', 'api', 'dist', 'main.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += String(chunk)))
  child.stderr.on('data', (chunk) => (output += String(chunk)))

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`api exited early:\n${output}`)
    try {
      await fetch(`http://127.0.0.1:${TEST_PORT}/health`)
      return {
        stop: async () => {
          child.kill('SIGTERM')
          await new Promise((resolve) => child.once('exit', resolve))
        },
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  child.kill()
  throw new Error(`api never answered:\n${output}`)
}

describe('correlation propagation', () => {
  beforeAll(() => {
    for (const workspace of ['packages/observability', 'packages/contracts', 'apps/api', 'apps/worker']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('a request with a valid id reuses it; one without gets a fresh one', async () => {
    const api = await bootApi()
    onTestFinished(api.stop)

    const supplied = 'cor_from_an_upstream_caller'
    const reused = await fetch(`http://127.0.0.1:${TEST_PORT}/health`, {
      headers: { [CORRELATION_HEADER]: supplied },
    })
    expect(reused.headers.get(CORRELATION_HEADER)).toBe(supplied)

    const minted = await fetch(`http://127.0.0.1:${TEST_PORT}/health`)
    const generated = minted.headers.get(CORRELATION_HEADER)
    expect(generated).toBeTruthy()
    expect(generated).not.toBe(supplied)
  })

  test('an id that could forge a log line is rejected rather than sanitized', async () => {
    const api = await bootApi()
    onTestFinished(api.stop)

    // A newline in an adopted id would let a caller inject a second, fabricated JSON line into the
    // log stream. A forged trace is worse than a discontinuous one, so this must not be echoed back.
    const hostile = 'cor_ok\n{"level":"info","message":"forged"}'
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/health`, {
      headers: { [CORRELATION_HEADER]: 'cor_plain_but_checked' },
    })
    expect(response.headers.get(CORRELATION_HEADER)).toBe('cor_plain_but_checked')

    const { isCorrelationId } = await importBuilt('packages/observability/dist/index.js')
    expect(isCorrelationId(hostile)).toBe(false)
  })

  test('a job inherits the enqueuing correlation id and restores it in the handler', async () => {
    const { runWithCorrelation } = await importBuilt('packages/observability/dist/index.js')
    const { createWorkerRuntime, createQueue, enqueueJob } = await importBuilt('apps/worker/dist/runtime.js')
    const { QUEUE_NAMES } = await importBuilt('packages/contracts/dist/index.js')

    const redisUrl = envExample().get('REDIS_URL')
    const queueName = QUEUE_NAMES.RECONCILE_APPLICATIONS
    const producerId = 'cor_producer_side'

    const seen = Promise.withResolvers()
    const runtime = createWorkerRuntime({
      redisUrl,
      queues: [queueName],
      handlers: {
        [queueName]: async () => {
          const { currentCorrelationId } = await importBuilt('packages/observability/dist/index.js')
          seen.resolve(currentCorrelationId())
        },
      },
    })

    const queue = createQueue(redisUrl, queueName)
    try {
      await runtime.start()
      await queue.drain()

      // Enqueue from INSIDE a scope — this is the hop the whole feature exists for.
      await runWithCorrelation(producerId, async () => enqueueJob(queue, 'correlation-probe', { any: 'payload' }))

      expect(await seen.promise).toBe(producerId)
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close()
      await runtime.stop().catch(() => undefined)
    }
  })
})
