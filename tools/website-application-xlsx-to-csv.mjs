import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import {
  convertWebsiteWorkbook,
  WebsiteExportError,
  WEBSITE_EXPORT_FAILURES,
} from './lib/helloreview-website-export.mjs'

const MAX_FILE_BYTES = 10 * 1024 * 1024
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

const usage = `Usage:
  pnpm applications:convert-xlsx -- --file <xlsx> --output <csv> --exported-at <ISO timestamp>
  pnpm applications:convert-xlsx -- --file <xlsx> --validate-only --exported-at <ISO timestamp>

Optional:
  --campaign-map <json>    Object mapping website campaign numbers to HelloReview campaign codes
  --allow-missing-phone    Skip rows with a blank phone and report their spreadsheet row numbers
  --validate-only          Validate and report counts without writing a PII-bearing CSV
`

const argumentFailure = (message) => {
  process.stderr.write(`${message}\n\n${usage}`)
  process.exit(2)
}

const parseArguments = (args) => {
  const values = new Map()
  let allowMissingPhone = false
  let validateOnly = false
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (key === '--help') {
      process.stdout.write(usage)
      process.exit(0)
    }
    if (key === '--allow-missing-phone') {
      if (allowMissingPhone) argumentFailure('An argument was supplied more than once.')
      allowMissingPhone = true
      continue
    }
    if (key === '--validate-only') {
      if (validateOnly) argumentFailure('An argument was supplied more than once.')
      validateOnly = true
      continue
    }
    if (!['--file', '--output', '--exported-at', '--campaign-map'].includes(key)) argumentFailure('Unknown argument.')
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) argumentFailure('An argument value is missing.')
    if (values.has(key)) argumentFailure('An argument was supplied more than once.')
    values.set(key, value)
    index += 1
  }

  const file = values.get('--file')
  const output = values.get('--output')
  const exportedAtRaw = values.get('--exported-at')
  if (file === undefined || exportedAtRaw === undefined || (output === undefined && !validateOnly)) {
    argumentFailure('The required arguments must be supplied.')
  }
  if (output !== undefined && validateOnly) argumentFailure('--output and --validate-only are mutually exclusive.')
  if (extname(file).toLowerCase() !== '.xlsx') argumentFailure('--file must be an .xlsx workbook.')
  if (output !== undefined && extname(output).toLowerCase() !== '.csv') argumentFailure('--output must be a .csv file.')
  if (!ISO_WITH_TIMEZONE.test(exportedAtRaw)) argumentFailure('--exported-at must include a timezone.')
  const exportedAt = new Date(exportedAtRaw)
  if (Number.isNaN(exportedAt.getTime())) argumentFailure('--exported-at is invalid.')
  return { file, output, exportedAt, campaignMapFile: values.get('--campaign-map'), allowMissingPhone, validateOnly }
}

const loadCampaignMap = async (path) => {
  if (path === undefined) return undefined
  let parsed
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.CAMPAIGN_MAPPING_MISSING)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.CAMPAIGN_MAPPING_MISSING)
  }
  const mappings = new Map()
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^\d{1,20}$/.test(key) || typeof value !== 'string' || value.trim() === '') {
      throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.CAMPAIGN_MAPPING_MISSING)
    }
    mappings.set(key, value.trim())
  }
  return mappings
}

const main = async () => {
  const input = parseArguments(process.argv.slice(2))
  const fileStats = await stat(input.file)
  if (!fileStats.isFile() || fileStats.size > MAX_FILE_BYTES) {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_WORKBOOK)
  }
  const campaignMap = await loadCampaignMap(input.campaignMapFile)
  const converted = await convertWebsiteWorkbook(await readFile(input.file), {
    exportedAt: input.exportedAt,
    campaignMap,
    allowMissingPhone: input.allowMissingPhone,
  })
  if (!input.validateOnly) {
    await mkdir(dirname(input.output), { recursive: true })
    await writeFile(input.output, converted.csv, { encoding: 'utf8', flag: 'wx' })
  }
  process.stdout.write(
    [
      input.validateOnly ? 'Website XLSX validation complete.' : 'Website XLSX conversion complete.',
      `source_rows=${String(converted.report.sourceRowCount)}`,
      `converted_rows=${String(converted.report.convertedRowCount)}`,
      `skipped_missing_phone=${String(converted.report.skippedMissingPhoneRows.length)}`,
      `skipped_rows=${converted.report.skippedMissingPhoneRows.join(',') || 'none'}`,
      `discarded_non_url_channels=${String(converted.report.droppedNonUrlChannels)}`,
    ].join('\n') + '\n',
  )
}

try {
  await main()
} catch (error) {
  if (error instanceof WebsiteExportError) {
    const at = error.rowNumber === undefined ? '' : ` row=${String(error.rowNumber)}`
    process.stderr.write(`Conversion rejected: reason=${error.reasonCode}${at}\n`)
  } else if (error instanceof Error && error.code === 'EEXIST') {
    process.stderr.write('Conversion rejected: output already exists; choose a new file name.\n')
  } else {
    process.stderr.write('Conversion failed safely. No applicant values or file paths were logged.\n')
  }
  process.exitCode = 1
}
