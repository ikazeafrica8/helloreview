// API app contract for T4.
//
// The static assertions are cheap. The boot tests at the bottom are the real proof: they compile the
// app, run it, and make HTTP requests — including one deliberately-broken dependency, because
// "returns 503 when a dependency is unreachable" cannot be verified any other way.
//
// The unhealthy case points the app at a dead Postgres port rather than stopping the real container,
// so the test never disturbs the running stack or any other project on this machine.
//
// Integration tier: spawns processes and touches the local stack.

import { test, describe, beforeAll, onTestFinished } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const API_DIR = join(ROOT, 'apps', 'api')

const readJson = (relativePath) => JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))
const readText = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8')

/** KEY=VALUE reader, matching the one in local-services-contract. */
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

const envExample = () => parseEnv(readText('.env.example'))

// A port of its own, so a boot test never collides with `pnpm dev:api` or another project.
const TEST_PORT = 13098

/** Boot the compiled app with an environment override; resolve once it answers or time out. */
const bootApi = async (overrides) => {
  const env = { ...process.env, ...Object.fromEntries(envExample()), ...overrides, API_PORT: String(TEST_PORT) }
  const child = spawn(process.execPath, [join(API_DIR, 'dist', 'main.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += String(chunk)))
  child.stderr.on('data', (chunk) => (output += String(chunk)))

  const stop = async () => {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`api exited early (${child.exitCode}):\n${output}`)
    try {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/health`)
      return { response, body: await response.json(), stop, output: () => output }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  await stop()
  throw new Error(`api never answered on ${TEST_PORT}:\n${output}`)
}

describe('api app', () => {
  test('the workspace declares the NestJS runtime', () => {
    const manifest = JSON.parse(readFileSync(join(API_DIR, 'package.json'), 'utf8'))
    const deps = { ...manifest.dependencies, ...manifest.devDependencies }
    for (const dep of ['@nestjs/common', '@nestjs/core', '@nestjs/platform-express', 'reflect-metadata']) {
      assert.ok(deps[dep], `apps/api must declare "${dep}"`)
    }
  })

  test('decorators are enabled in the api workspace only', () => {
    // Verified: NestJS DI needs emitDecoratorMetadata, and it needs to be real metadata — esbuild
    // (and therefore tsx) silently omits it, which boots fine and then 500s on every injected
    // request. tsc is the only runner in this toolchain that emits it correctly.
    const apiTsconfig = JSON.parse(readFileSync(join(API_DIR, 'tsconfig.json'), 'utf8'))
    assert.equal(apiTsconfig.compilerOptions?.experimentalDecorators, true)
    assert.equal(apiTsconfig.compilerOptions?.emitDecoratorMetadata, true)

    // The base config is shared by every workspace; decorators belong only where they are used.
    const base = readJson('tsconfig.base.json')
    assert.equal(base.compilerOptions?.experimentalDecorators, undefined)
    assert.equal(base.compilerOptions?.emitDecoratorMetadata, undefined)
  })

  test('the api port is configurable and does not claim an occupied default', () => {
    const env = envExample()
    assert.ok(env.has('API_PORT'), '.env.example must declare API_PORT')
    assert.notEqual(env.get('API_PORT'), '3000', 'port 3000 collides with other projects on this machine')
  })

  test('SPEC.md §4 dev:api exists', () => {
    const { scripts = {} } = readJson('package.json')
    assert.ok(scripts['dev:api'], 'package.json is missing the "dev:api" script')
  })

  // ------------------------------------------------------------------ behavioural

  beforeAll(() => {
    const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
      cwd: API_DIR,
      encoding: 'utf8',
      timeout: 180_000,
    })
    assert.equal(build.status, 0, `apps/api must compile before the boot tests:\n${build.stdout}${build.stderr}`)
  })

  test('GET /health returns 200 and reports every dependency when all are reachable', async () => {
    const api = await bootApi({})
    onTestFinished(api.stop)

    assert.equal(api.response.status, 200, `expected 200, got ${api.response.status}: ${JSON.stringify(api.body)}`)
    assert.equal(api.body.status, 'ok')
    assert.equal(api.body.dependencies?.postgres?.status, 'up')
    assert.equal(api.body.dependencies?.redis?.status, 'up')
  })

  test('GET /health returns 503 and names the failed dependency', async () => {
    // Point Postgres at a closed port. Redis stays real, so the test also proves the response
    // distinguishes the failed dependency from the healthy one rather than failing wholesale.
    const api = await bootApi({ DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/nothing' })
    onTestFinished(api.stop)

    assert.equal(api.response.status, 503, `expected 503, got ${api.response.status}`)
    assert.equal(api.body.status, 'degraded')
    assert.equal(api.body.dependencies?.postgres?.status, 'down')
    assert.equal(api.body.dependencies?.redis?.status, 'up', 'a healthy dependency must still report up')
  })

  test('the health response leaks nothing an unauthenticated caller should not see', async () => {
    // Criterion 3: no authentication, and therefore no version or environment detail. SPEC.md §21.4
    // additionally forbids connection strings and secrets anywhere they could be read.
    const api = await bootApi({})
    onTestFinished(api.stop)

    const serialized = JSON.stringify(api.body)
    for (const forbidden of ['postgres://', 'redis://', 'password', 'localhost', '127.0.0.1', 'helloreview_local']) {
      assert.ok(!serialized.includes(forbidden), `health response leaked "${forbidden}": ${serialized}`)
    }
    for (const key of ['version', 'env', 'environment', 'nodeVersion', 'hostname', 'uptime']) {
      assert.equal(api.body[key], undefined, `health response must not expose "${key}"`)
    }
  })
})
