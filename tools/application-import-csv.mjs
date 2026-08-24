import { readFile, stat } from 'node:fs/promises'
import { Pool } from 'pg'
import { loadApplicationImportConfig, readEnvironment, ConfigurationError } from '../packages/config/dist/index.js'
import {
  ApplicationSyncService,
  APPLICATION_IMPORT_FAILURES,
  ManualCsvImportError,
  ManualCsvImportService,
} from '../apps/api/dist/modules/application-sync/index.js'

const MAX_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_SOURCE_SYSTEM = 'helloreview_website'
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

const usage = `Usage:
  pnpm applications:import-csv -- --file <csv> --exported-at <ISO timestamp>

Optional:
  --source-system <name>   Defaults to ${DEFAULT_SOURCE_SYSTEM}
`

const argumentFailure = (message) => {
  process.stderr.write(`${message}\n\n${usage}`)
  process.exit(2)
}

const parseArguments = (args) => {
  const values = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (key === '--help') {
      process.stdout.write(usage)
      process.exit(0)
    }
    if (!['--file', '--exported-at', '--source-system'].includes(key)) argumentFailure('Unknown argument.')
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) argumentFailure('An argument value is missing.')
    if (values.has(key)) argumentFailure('An argument was supplied more than once.')
    values.set(key, value)
    index += 1
  }

  const file = values.get('--file')
  const exportedAtRaw = values.get('--exported-at')
  if (file === undefined || exportedAtRaw === undefined) argumentFailure('Both required arguments must be supplied.')
  if (!ISO_WITH_TIMEZONE.test(exportedAtRaw)) argumentFailure('--exported-at must include a timezone.')
  const exportedAt = new Date(exportedAtRaw)
  if (Number.isNaN(exportedAt.getTime())) argumentFailure('--exported-at is invalid.')
  return {
    file,
    exportedAt,
    sourceSystem: values.get('--source-system') ?? DEFAULT_SOURCE_SYSTEM,
  }
}

const printFailure = (error) => {
  if (error instanceof ManualCsvImportError) {
    const at = error.rowNumber === undefined ? '' : ` record=${String(error.rowNumber)}`
    process.stderr.write(`Import rejected: reason=${error.reasonCode}${at}\n`)
    return
  }
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`)
    return
  }
  process.stderr.write('Import failed safely. No CSV values were logged; inspect database availability and retry.\n')
}

const main = async () => {
  const input = parseArguments(process.argv.slice(2))
  const fileStats = await stat(input.file)
  if (!fileStats.isFile()) argumentFailure('--file must identify a regular file.')
  if (fileStats.size > MAX_FILE_BYTES) {
    throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.FILE_TOO_LARGE)
  }
  const bytes = await readFile(input.file)
  let content
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new ManualCsvImportError(APPLICATION_IMPORT_FAILURES.INVALID_UTF8)
  }

  const config = loadApplicationImportConfig(readEnvironment())
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 })
  pool.on('error', () => undefined)
  try {
    const synchronization = new ApplicationSyncService(pool)
    const importer = new ManualCsvImportService(pool, synchronization, config.maskingPepper)
    const outcome = await importer.importCsv({
      content,
      sourceSystem: input.sourceSystem,
      exportedAt: input.exportedAt,
    })
    process.stdout.write(
      [
        'Application CSV import complete.',
        `batch=${outcome.batchId}`,
        `exported_at=${outcome.exportedAt.toISOString()}`,
        `rows=${String(outcome.rowCount)}`,
        `applied=${String(outcome.appliedCount)}`,
        `duplicates=${String(outcome.duplicateCount)}`,
        `stale=${String(outcome.staleCount)}`,
        `replayed=${String(outcome.replayed)}`,
      ].join('\n') + '\n',
    )
  } finally {
    await pool.end()
  }
}

try {
  await main()
} catch (error) {
  printFailure(error)
  process.exitCode = 1
}
