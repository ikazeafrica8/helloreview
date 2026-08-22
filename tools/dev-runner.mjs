// Watch-mode runner for an app workspace: `node tools/dev-runner.mjs api`.
//
// WHY THIS EXISTS RATHER THAN tsx.
// NestJS dependency injection reads the metadata TypeScript emits under emitDecoratorMetadata.
// esbuild — and therefore tsx — does not emit it. Verified: an app run under tsx BOOTS, maps its
// routes, and then returns HTTP 500 on every request that needs an injected dependency, with no
// hint that the transform is the cause. Node's native type stripping cannot do it either. tsc is
// the only runner in this toolchain that emits correct decorator metadata, so dev mode is
// `tsc --watch` feeding `node --watch`.
//
// Two processes, no dependency. `concurrently` would do the same job, and SPEC.md §8 puts adding a
// dependency under Ask first for a reason.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ROOT = dirname(import.meta.dirname)

const WORKSPACES = {
  api: { dir: 'apps/api', label: 'api' },
  worker: { dir: 'apps/worker', label: 'worker' },
}

const name = process.argv[2]
const workspace = name === undefined ? undefined : WORKSPACES[name]

if (workspace === undefined) {
  process.stderr.write(
    `dev-runner: unknown workspace ${JSON.stringify(name ?? null)}. ` +
      `Known: ${Object.keys(WORKSPACES).join(', ')}.\n`,
  )
  process.exit(2)
}

if (!existsSync(join(ROOT, '.env'))) {
  process.stderr.write('\n  No .env found. Run `pnpm services:up` first — it creates one from .env.example.\n\n')
  process.exit(1)
}

const children = []

/** Spawn a child, tagging each of its output lines so two interleaved streams stay readable. */
const run = (label, command, args) => {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  const tag = (stream) => (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() !== '') stream.write(`[${label}] ${line}\n`)
    }
  }
  child.stdout.on('data', tag(process.stdout))
  child.stderr.on('data', tag(process.stderr))
  children.push(child)
  return child
}

const tsc = run(`${workspace.label}:tsc`, process.execPath, [
  join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p',
  join(ROOT, workspace.dir, 'tsconfig.json'),
  '--watch',
  // Without this the compiler clears the terminal on every rebuild, taking the app's logs with it.
  '--preserveWatchOutput',
])

const app = run(`${workspace.label}:run`, process.execPath, [
  '--watch',
  // --env-file-if-exists rather than --env-file: a missing file should surface as the config
  // loader's own message listing every absent key, not as a Node startup error.
  '--env-file-if-exists=.env',
  join(ROOT, workspace.dir, 'dist', 'main.js'),
])

let shuttingDown = false
const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) child.kill('SIGTERM')
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// If either half dies, stop the other — a running app with a dead compiler silently serves stale
// code, which is worse than stopping.
for (const [child, why] of [
  [tsc, 'compiler'],
  [app, 'app'],
]) {
  child.on('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(`\n  ${why} exited (${String(code)}); stopping the other half.\n`)
      shutdown()
      process.exitCode = code ?? 1
    }
  })
}
