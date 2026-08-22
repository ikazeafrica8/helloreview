// Preflight for `pnpm services:up`. Turns four quiet Docker failures into clear messages.
//
// 1. No `.env` on a fresh clone. Compose resolves `.env` relative to the compose file, so it would
//    read `infra/.env`, find nothing, and Postgres would exit with "superuser password is not
//    specified". We create `.env` from `.env.example` instead.
// 2. `.env` drifted from `.env.example` after a pull that added a key. Compose's `${VAR:?}` catches
//    the keys it reads; this catches the ones only the application reads (T8).
// 3. DATABASE_URL / REDIS_URL disagreeing with the POSTGRES_* / REDIS_* parts they duplicate.
//    Compose builds the containers from the parts, the app connects with the URLs, so a partial
//    edit produces a stack that reports healthy and an app that cannot connect — with nothing in
//    the output pointing at the cause.
// 4. A host port already held by something else. Docker's own message names the port but not the
//    holder, and on a machine running several project stacks that is the most likely failure.
//
// Plain Node with no dependencies, so it works before `pnpm install` has ever run.

import { readFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const ENV = join(ROOT, '.env')
const EXAMPLE = join(ROOT, '.env.example')
const PROJECT = 'helloreview'

const fail = (message) => {
  console.error(`\n  services:up preflight failed\n\n  ${message}\n`)
  process.exit(1)
}

/** KEY=VALUE reader. No export, no interpolation — .env.example is deliberately that simple. */
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

if (!existsSync(EXAMPLE)) {
  fail(`.env.example is missing from ${ROOT}. It is committed — restore it with git checkout.`)
}

if (!existsSync(ENV)) {
  copyFileSync(EXAMPLE, ENV)
  console.log('  created .env from .env.example (local placeholder credentials, safe for dev only)')
}

const example = parseEnv(readFileSync(EXAMPLE, 'utf8'))
const env = parseEnv(readFileSync(ENV, 'utf8'))

const missing = [...example.keys()].filter((key) => !env.has(key))
if (missing.length > 0) {
  fail(
    `.env is missing ${missing.length} key(s) that .env.example declares:\n` +
      missing.map((key) => `    - ${key}`).join('\n') +
      '\n\n  Add them to .env. The values in .env.example are fine for local development.',
  )
}

const need = (key) => {
  const value = env.get(key)
  if (value === undefined || value === '') fail(`.env sets no value for ${key}.`)
  return value
}

const parseUrl = (key, shape) => {
  try {
    return new URL(need(key))
  } catch {
    return fail(`${key} is not a valid URL. Expected ${shape}`)
  }
}

const disagree = (urlKey, partKey, inUrl, inParts) => {
  const column = Math.max(urlKey.length, partKey.length) + 12
  fail(
    `${urlKey} disagrees with ${partKey}.\n\n` +
      `    ${`${urlKey} carries`.padEnd(column)}${inUrl === '' ? '(empty)' : inUrl}\n` +
      `    ${`${partKey} is`.padEnd(column)}${inParts}\n\n` +
      `  Compose builds the container from ${partKey}; the app connects with ${urlKey}.\n` +
      `  While they disagree the stack starts healthy and the app cannot connect.`,
  )
}

// --- DATABASE_URL must agree with the POSTGRES_* parts Compose uses ---
const db = parseUrl('DATABASE_URL', 'postgres://user:password@127.0.0.1:port/database')
for (const [partKey, inUrl, inParts] of [
  ['POSTGRES_USER', decodeURIComponent(db.username), need('POSTGRES_USER')],
  ['POSTGRES_PASSWORD', decodeURIComponent(db.password), need('POSTGRES_PASSWORD')],
  ['POSTGRES_PORT', db.port, need('POSTGRES_PORT')],
  ['POSTGRES_DB', decodeURIComponent(db.pathname.replace(/^\//, '')), need('POSTGRES_DB')],
]) {
  if (inUrl !== inParts) disagree('DATABASE_URL', partKey, inUrl, inParts)
}

// --- REDIS_URL must agree with the REDIS_* parts ---
const redis = parseUrl('REDIS_URL', 'redis://default:password@127.0.0.1:port/0')
if (decodeURIComponent(redis.password) !== need('REDIS_PASSWORD')) {
  disagree('REDIS_URL', 'REDIS_PASSWORD', decodeURIComponent(redis.password), need('REDIS_PASSWORD'))
}
if (redis.port !== need('REDIS_PORT')) {
  disagree('REDIS_URL', 'REDIS_PORT', redis.port, need('REDIS_PORT'))
}
if (redis.username === '') {
  fail(
    'REDIS_URL omits the username.\n\n' +
      '    Use redis://default:<password>@host:port/0\n\n' +
      '  redis-cli 7.x sends no AUTH for the empty-username form and fails with NOAUTH,\n' +
      '  so the documented URL would not work for manual debugging. ioredis accepts both.',
  )
}

// --- S3_ENDPOINT must point at the published MinIO port ---
const s3 = parseUrl('S3_ENDPOINT', 'http://127.0.0.1:port')
if (s3.port !== need('MINIO_PORT')) {
  disagree('S3_ENDPOINT', 'MINIO_PORT', s3.port, need('MINIO_PORT'))
}

// --- Host ports must be free, or already held by this project's own stack ---

/** Containers this compose project already has, if any. */
const projectIsUp = () => {
  try {
    const out = execFileSync('docker', ['compose', '--project-name', PROJECT, 'ps', '--quiet'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() !== ''
  } catch {
    // Docker unreachable. Let `docker compose up` produce its own, better error.
    return false
  }
}

const portIsFree = (port) =>
  new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => {
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() => {
        resolve(true)
      })
    })
    server.listen(Number(port), '127.0.0.1')
  })

/** Best-effort: name whatever container publishes this port, to make the message actionable. */
const holderOf = (port) => {
  try {
    const out = execFileSync('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}} ({{.Image}})'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim().split('\n').filter(Boolean).join(', ')
  } catch {
    return ''
  }
}

let portsChecked = false

if (projectIsUp()) {
  console.log(`  ${PROJECT} stack is already up — skipping the port check`)
} else {
  portsChecked = true
  const wanted = [
    ['POSTGRES_PORT', need('POSTGRES_PORT')],
    ['REDIS_PORT', need('REDIS_PORT')],
    ['MINIO_PORT', need('MINIO_PORT')],
    ['MINIO_CONSOLE_PORT', need('MINIO_CONSOLE_PORT')],
  ]
  const taken = []
  for (const [key, port] of wanted) {
    if (!(await portIsFree(port))) taken.push([key, port, holderOf(port)])
  }
  if (taken.length > 0) {
    fail(
      `${taken.length} host port(s) are already in use:\n` +
        taken
          .map(([key, port, holder]) => `    - ${port} (${key})${holder === '' ? '' : ` — held by ${holder}`}`)
          .join('\n') +
        '\n\n  Two containers cannot bind one host port. Either stop whatever holds it, or change\n' +
        '  the port in .env — the container-internal ports stay standard either way, so nothing\n' +
        '  else needs to change.',
    )
  }
}

// Say only what was actually checked. A message that claims the ports are free when the check was
// skipped is a small lie, and small lies are how a preflight stops being trusted.
console.log(
  portsChecked
    ? '  preflight ok — .env agrees with infra/docker-compose.yml and the ports are free'
    : '  preflight ok — .env agrees with infra/docker-compose.yml',
)
