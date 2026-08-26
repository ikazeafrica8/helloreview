import { spawn } from 'node:child_process'
import { cp, mkdir } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ADMIN = join(ROOT, 'apps', 'admin')
const BASE_URL = 'http://localhost:3001'
const nextCli = join(ADMIN, 'node_modules', 'next', 'dist', 'bin', 'next')
const playwrightCli = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js')
const standaloneAdmin = join(ADMIN, '.next', 'standalone', 'apps', 'admin')
const standaloneServer = join(standaloneAdmin, 'server.js')
const playwrightConfig = 'apps/admin/playwright.config.ts'
const unexpectedServerError =
  /(?:uncaught|unhandled rejection|(?:^|\n)Error:|TypeError:|ReferenceError:|SyntaxError:|⨯)/i

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const isPortOccupied = () =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: 3001 })
    socket.setTimeout(1_000)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    const unavailable = () => {
      socket.destroy()
      resolve(false)
    }
    socket.once('error', unavailable)
    socket.once('timeout', unavailable)
  })

const isReady = async () => {
  try {
    const response = await fetch(`${BASE_URL}/overview`, { signal: AbortSignal.timeout(1_500) })
    return response.status >= 200 && response.status < 500
  } catch {
    return false
  }
}

const waitUntilReady = async (server, lane) => {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`${lane} server exited with ${String(server.exitCode)}`)
    if (await isReady()) return
    await delay(250)
  }
  throw new Error(`${lane} server did not become ready within 120 seconds`)
}

const waitUntilPortFree = async (lane) => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (!(await isPortOccupied())) return
    await delay(100)
  }
  throw new Error(`${lane} server did not release localhost:3001 within 15 seconds`)
}

const prepareStandaloneAssets = async () => {
  const standaloneNext = join(standaloneAdmin, '.next')
  await mkdir(standaloneNext, { recursive: true })
  await cp(join(ADMIN, '.next', 'static'), join(standaloneNext, 'static'), { recursive: true, force: true })
}

const waitForExit = (child) =>
  child.exitCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => resolve(code))
      })

const findWindowsListeningPid = async () => {
  const netstat = spawn('netstat.exe', ['-ano', '-p', 'tcp'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
  let output = ''
  netstat.stdout?.on('data', (chunk) => {
    output += String(chunk)
  })
  const exitCode = await waitForExit(netstat)
  if (exitCode !== 0) return null
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5 || parts[0]?.toUpperCase() !== 'TCP' || parts[3]?.toUpperCase() !== 'LISTENING') continue
    if (!parts[1]?.endsWith(':3001')) continue
    const pid = Number(parts[4])
    if (Number.isSafeInteger(pid) && pid > 0) return pid
  }
  return null
}

const stopServer = async (server, listeningPid) => {
  if (process.platform === 'win32') {
    const targets = [...new Set([server.pid, listeningPid].filter((pid) => pid !== undefined && pid !== null))]
    for (const target of targets) {
      const killer = spawn('taskkill.exe', ['/pid', String(target), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      await Promise.race([waitForExit(killer), delay(10_000)])
      if (killer.exitCode === null) {
        killer.kill()
        killer.unref()
      }
    }
    await Promise.race([waitForExit(server), delay(10_000)])
    server.unref()
    return
  }
  if (server.exitCode !== null || server.pid === undefined) return
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
    throw error
  }
  await Promise.race([waitForExit(server), delay(10_000)])
  if (server.exitCode === null) process.kill(-server.pid, 'SIGKILL')
  server.unref()
}

const runLane = async ({ lane, serverMode, sessionMode, spec, testArguments = [] }) => {
  if (await isPortOccupied()) throw new Error(`${lane} refused: localhost:3001 is already in use`)

  const serverOutput = []
  const serverArguments = serverMode === 'standalone' ? [standaloneServer] : [nextCli, 'dev', '--port', '3001']
  const server = spawn(process.execPath, serverArguments, {
    cwd: ADMIN,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      ADMIN_CONSOLE_SESSION_MODE: sessionMode,
      NODE_ENV: serverMode === 'standalone' ? 'production' : 'development',
      ...(serverMode === 'standalone' ? { HOSTNAME: '127.0.0.1', PORT: '3001' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  server.stdout?.on('data', (chunk) => {
    const output = String(chunk)
    serverOutput.push(output)
    process.stdout.write(output)
  })
  server.stderr?.on('data', (chunk) => {
    const output = String(chunk)
    serverOutput.push(output)
    process.stderr.write(output)
  })

  let exitCode
  let listeningPid = null
  try {
    await waitUntilReady(server, lane)
    listeningPid = process.platform === 'win32' ? await findWindowsListeningPid() : server.pid
    if (listeningPid === null) throw new Error(`${lane} could not resolve its listening process`)
    const tests = spawn(
      process.execPath,
      [playwrightCli, 'test', spec, '--config', playwrightConfig, ...testArguments],
      {
        cwd: ROOT,
        env: { ...process.env, OPERATOR_E2E_LANE: lane },
        stdio: 'inherit',
        windowsHide: true,
      },
    )
    exitCode = (await waitForExit(tests)) ?? 1
  } finally {
    await stopServer(server, listeningPid)
    server.stdout?.removeAllListeners()
    server.stderr?.removeAllListeners()
    server.stdout?.destroy()
    server.stderr?.destroy()
    server.unref()
    await waitUntilPortFree(lane)
  }

  if (unexpectedServerError.test(serverOutput.join(''))) {
    process.stderr.write(`\n${lane} emitted an unexpected server runtime error.\n`)
    return 1
  }
  return exitCode ?? 1
}

const fixtureExitCode = await runLane({
  lane: 'fixture',
  serverMode: 'dev',
  sessionMode: 'test_fixture',
  spec: 'tests/operator-e2e/operator-console-release.spec.ts',
  testArguments: process.argv.slice(2),
})

if (fixtureExitCode === 0) await prepareStandaloneAssets()

const lockedExitCode =
  fixtureExitCode === 0
    ? await runLane({
        lane: 'production-locked',
        serverMode: 'standalone',
        sessionMode: 'disabled',
        spec: 'tests/operator-e2e/operator-console-locked.spec.ts',
      })
    : 1

process.exitCode = fixtureExitCode === 0 && lockedExitCode === 0 ? 0 : 1
