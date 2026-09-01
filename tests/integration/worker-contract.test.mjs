// Worker app contract for T5.
//
// The drain test is the one that matters. T5's criterion is that SIGTERM drains in-flight jobs
// rather than dropping them — but on Windows `child.kill(signal)` maps to TerminateProcess for
// every signal, so no programmatically sent signal ever reaches a handler (measured during T4).
// Testing through a real signal would therefore prove nothing here.
//
// So this exercises the shutdown PATH directly: start a worker, get a job genuinely in flight, call
// the same stop() the signal handler calls, and assert the job ran to completion. What remains
// unverified on this platform is only signal delivery, which is Node's business, not ours.
//
// Integration tier: spawns processes and touches the local stack.

import { test, describe, beforeAll } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const WORKER_DIR = join(ROOT, 'apps', 'worker')

const readJson = (relativePath) => JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))
const readText = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8')

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

/**
 * Run the built worker until its output matches `until` or it exits, then stop it.
 *
 * Signals cannot be delivered to a child on Windows, so the process is killed outright once the
 * expected line appears — this asserts on boot behaviour, not on shutdown, which the drain test
 * covers by calling stop() directly.
 *
 * REDIS_URL is isolated because the worker now binds the approved internal import processor. A boot
 * test must never consume jobs from the developer's queues. `overrides` still wins, so the
 * unreachable-Redis test below can supply its own deliberately broken URL.
 */
const runWorker = async (overrides, until) => {
  const { isolatedRedisUrl } = await import('../../packages/testing/dist/index.js')
  const base = Object.fromEntries(parseEnv(readText('.env.example')))

  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...base, REDIS_URL: isolatedRedisUrl(base.REDIS_URL), ...overrides }
    const child = spawn(process.execPath, [join(WORKER_DIR, 'dist', 'main.js')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    const settle = (code) => {
      clearTimeout(timer)
      resolve({ output, code })
    }
    const onData = (chunk) => {
      output += String(chunk)
      if (until.test(output)) {
        child.kill()
        settle(null)
      }
    }
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`worker never matched ${String(until)} within 20s:\n${output}`))
    }, 20_000)

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', settle)
  })
}

describe('worker app', () => {
  test('the workspace declares the queue runtime', () => {
    const manifest = JSON.parse(readFileSync(join(WORKER_DIR, 'package.json'), 'utf8'))
    const deps = { ...manifest.dependencies, ...manifest.devDependencies }
    for (const dep of ['bullmq', 'ioredis']) {
      assert.ok(deps[dep], `apps/worker must declare "${dep}"`)
    }
  })

  test('SPEC.md §4 dev:worker exists', () => {
    const { scripts = {} } = readJson('package.json')
    assert.ok(scripts['dev:worker'], 'package.json is missing the "dev:worker" script')
  })

  test('queue names live in one shared registry, not at the call sites', () => {
    // T5 criterion 3. The registry is in packages/contracts rather than apps/worker because the api
    // is the producer for the T43 outbox and cannot import from another app.
    const source = readText('packages/contracts/src/queues.ts')
    assert.match(source, /as const/, 'the registry must be an `as const` object (SPEC.md §6)')

    const names = [...source.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1])
    assert.ok(names.length > 0, 'the registry declares no queues')
    for (const name of names) {
      assert.match(name, /^[A-Z][A-Z0-9_]*$/, `queue key "${name}" must be SCREAMING_SNAKE`)
    }

    // Nothing may construct a Worker or Queue with a literal — the lint rule enforces it, and this
    // asserts the worker's own source actually complies rather than relying on the rule alone.
    const runtime = readText('apps/worker/src/runtime.ts')
    assert.ok(
      !/new (Worker|Queue)\(\s*['"]/.test(runtime),
      'queue names must come from the registry, never a string literal',
    )
  })

  test('contracts re-exports the registry through its public surface', () => {
    const index = readText('packages/contracts/src/index.ts')
    assert.match(index, /queues\.js/, 'packages/contracts/src/index.ts must export the queue registry')
  })

  // ------------------------------------------------------------------ behavioural

  beforeAll(() => {
    for (const workspace of ['packages/contracts', 'apps/worker']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 180_000,
      })
      assert.equal(build.status, 0, `${workspace} must compile:\n${build.stdout}${build.stderr}`)
    }
  })

  test('stop() drains an in-flight job instead of dropping it', async () => {
    // Importing the BUILT module means bullmq and ioredis resolve from apps/worker/node_modules,
    // because Node resolves a dependency relative to the importing file.
    const { createWorkerRuntime, createQueue } = await import('../../apps/worker/dist/runtime.js')
    const { QUEUE_NAMES } = await import('../../packages/contracts/dist/queues.js')
    const { isolatedRedisUrl, isolatedQueueName } = await import('../../packages/testing/dist/index.js')

    // Isolated database AND isolated queue name — the obliterate() below must never be able to
    // reach the developer's real work once T43/T45 give this queue jobs. See queue-isolation.ts.
    const redisUrl = isolatedRedisUrl(parseEnv(readText('.env.example')).get('REDIS_URL'))
    const queueName = isolatedQueueName(QUEUE_NAMES.SEND_OUTBOUND, 'drain-on-stop')

    let started = false
    let finished = false
    const jobStarted = Promise.withResolvers()

    const runtime = createWorkerRuntime({
      redisUrl,
      queues: [queueName],
      handlers: {
        [queueName]: async () => {
          started = true
          jobStarted.resolve()
          // Long enough that a shutdown which abandons in-flight work would cut it short.
          await new Promise((resolve) => setTimeout(resolve, 1_500))
          finished = true
        },
      },
    })

    const queue = createQueue(redisUrl, queueName)
    try {
      await runtime.start()
      await queue.drain()
      await queue.add('drain-probe', {})

      await jobStarted.promise
      assert.equal(started, true, 'the job never started, so the drain was not actually exercised')

      // The same call the SIGTERM handler makes.
      await runtime.stop()

      assert.equal(finished, true, 'stop() returned before the in-flight job completed — jobs are being dropped')
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close()
      await runtime.stop().catch(() => undefined)
    }
  })

  test('the worker process boots, connects and reports ready', async () => {
    // Covers main.ts's boot path, which the runtime tests below do NOT reach. Regression test: the
    // first version of verifyRedis pinged before the socket was up and died with "Stream isn't
    // writeable" against a perfectly healthy Redis — the runtime tests all passed regardless.
    const result = await runWorker({}, /ready —/)
    assert.match(result.output, /connected to redis/, `worker never reported connecting:\n${result.output}`)
    assert.match(
      result.output,
      /ready — 1 processor\(s\): process-inbound-event/,
      `worker did not bind only the approved internal processor:\n${result.output}`,
    )
  })

  test('the worker refuses to start against an unreachable Redis', async () => {
    // Failing at boot is diagnosable; sitting in ioredis's reconnect loop looking alive while
    // processing nothing is not.
    const result = await runWorker({ REDIS_URL: 'redis://default:nobody@127.0.0.1:1/0' }, /failed to start/)
    assert.notEqual(result.code, 0, `expected a non-zero exit, got ${String(result.code)}:\n${result.output}`)
    assert.match(result.output, /failed to start/, result.output)
    assert.ok(!/ready —/.test(result.output), 'the worker reported ready despite having no Redis')
  })

  test('the runtime reports ready once connected', async () => {
    const { createWorkerRuntime } = await import('../../apps/worker/dist/runtime.js')
    const { QUEUE_NAMES } = await import('../../packages/contracts/dist/queues.js')
    const { isolatedRedisUrl, isolatedQueueName } = await import('../../packages/testing/dist/index.js')

    // This test binds a real BullMQ Worker whose handler does NOTHING, so on the application
    // database it would silently consume and discard real queued jobs — measured: a job planted on
    // `send-outbound` in database 0 was gone by the end of the run. Silent consumption is worse
    // than the obliterate() the other tests do, because it leaves no trace at all.
    const redisUrl = isolatedRedisUrl(parseEnv(readText('.env.example')).get('REDIS_URL'))
    const queueName = isolatedQueueName(QUEUE_NAMES.SEND_OUTBOUND, 'ready-probe')

    const runtime = createWorkerRuntime({
      redisUrl,
      queues: [queueName],
      handlers: { [queueName]: async () => undefined },
    })
    try {
      await runtime.start()
      assert.equal(runtime.isReady(), true, 'runtime.start() resolved but the runtime does not report ready')
    } finally {
      await runtime.stop()
      // Binding a Worker creates `:meta` and `:stalled-check` even with no job, and the queue name
      // is unique per run — so without this the isolation database grows by two dead keys every
      // time the suite runs. Safe to obliterate precisely because the name is this run's own.
      const { createQueue } = await import('../../apps/worker/dist/runtime.js')
      const queue = createQueue(redisUrl, queueName)
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close()
    }
  })
})
