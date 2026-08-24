import readExcelFile from 'read-excel-file/node'

export const WEBSITE_EXPORT_HEADERS = [
  '고유번호',
  '캠페인번호',
  '채널',
  '신청한마디',
  '진행상태(1신청/2선정/3검수요청/4등록완료/5미선정/6선정후 취소/7수정요청)',
  '배송지 이름',
  '배송지 우편번호',
  '배송지 주소',
  '배송지 상세주소',
  '배송지 연락처',
  '리뷰신청일시',
  '접속기기(1PC/2모바일)',
  '아이디',
  '이름',
  '휴대폰',
  '닉네임',
  '이메일',
  '블랙컨슈머(0일반/1블랙컨슈머)',
  '캠페인 형태(1배송형/2방문형)',
  '간단 리뷰 설명',
  '회원성별(M남/F여)',
  '회원연령대',
  '지역',
  '주소상세',
  '회원레벨',
  '캠페인명',
  '채널구분',
  '블로그일평균방문자수',
  '답변1',
  '답변2',
  '답변3',
  '답변4',
  '신청일자',
]

export const CANONICAL_APPLICATION_HEADERS = [
  'application_id',
  'campaign_code',
  'application_status',
  'applicant_name',
  'phone_normalized',
  'blog_url',
  'blogger_level',
  'blog_daily_visitors',
  'blogger_region',
  'submitted_at',
  'updated_at',
]

export const WEBSITE_EXPORT_FAILURES = {
  INVALID_WORKBOOK: 'WEBSITE_EXPORT_INVALID_WORKBOOK',
  INVALID_HEADER: 'WEBSITE_EXPORT_INVALID_HEADER',
  TOO_MANY_ROWS: 'WEBSITE_EXPORT_TOO_MANY_ROWS',
  INVALID_ROW: 'WEBSITE_EXPORT_INVALID_ROW',
  DUPLICATE_APPLICATION_ID: 'WEBSITE_EXPORT_DUPLICATE_APPLICATION_ID',
  MISSING_PHONE: 'WEBSITE_EXPORT_MISSING_PHONE',
  INVALID_PHONE: 'WEBSITE_EXPORT_INVALID_PHONE',
  INVALID_BLOGGER_LEVEL: 'WEBSITE_EXPORT_INVALID_BLOGGER_LEVEL',
  INVALID_VISITOR_COUNT: 'WEBSITE_EXPORT_INVALID_VISITOR_COUNT',
  INVALID_TIMESTAMP: 'WEBSITE_EXPORT_INVALID_TIMESTAMP',
  UNSUPPORTED_STATUS: 'WEBSITE_EXPORT_UNSUPPORTED_STATUS',
  CAMPAIGN_MAPPING_MISSING: 'WEBSITE_EXPORT_CAMPAIGN_MAPPING_MISSING',
}

export class WebsiteExportError extends Error {
  constructor(reasonCode, rowNumber) {
    super(`Website export conversion rejected: ${reasonCode}${rowNumber === undefined ? '' : ` at row ${rowNumber}`}`)
    this.name = 'WebsiteExportError'
    this.reasonCode = reasonCode
    this.rowNumber = rowNumber
  }
}

const MAX_ROWS = 10_000
const SEOUL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
const KNOWN_SOURCE_STATUSES = new Set(['1', '2', '3', '4', '5', '6', '7'])
const VERIFIED_SOURCE_STATUS_MAP = new Map([['1', 'received']])

const indexOf = (header) => WEBSITE_EXPORT_HEADERS.indexOf(header) + 1

const COLUMN = {
  applicationId: indexOf('고유번호'),
  campaignNumber: indexOf('캠페인번호'),
  channel: indexOf('채널'),
  sourceStatus: indexOf('진행상태(1신청/2선정/3검수요청/4등록완료/5미선정/6선정후 취소/7수정요청)'),
  submittedAt: indexOf('리뷰신청일시'),
  applicantName: indexOf('이름'),
  phone: indexOf('휴대폰'),
  bloggerRegion: indexOf('지역'),
  bloggerLevel: indexOf('회원레벨'),
  blogDailyVisitors: indexOf('블로그일평균방문자수'),
}

const cellText = (row, column) => {
  const value = row[column - 1]
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  return String(value).trim()
}

const requiredIdentifier = (value, rowNumber) => {
  if (!/^\d{1,20}$/.test(value)) throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_ROW, rowNumber)
  return value
}

const requiredText = (value, maximum, rowNumber) => {
  if (value.length === 0 || value.length > maximum) {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_ROW, rowNumber)
  }
  return value
}

const optionalText = (value, maximum, rowNumber) => {
  if (value.length > maximum) throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_ROW, rowNumber)
  return value === '' ? undefined : value
}

const sourceInteger = (value, minimum, reasonCode, rowNumber) => {
  if (!/^\d+$/.test(value)) throw new WebsiteExportError(reasonCode, rowNumber)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new WebsiteExportError(reasonCode, rowNumber)
  return parsed
}

export const normalizeWebsiteKoreanPhone = (raw, rowNumber) => {
  const compact = raw.replace(/[\s()-]/g, '')
  if (compact === '') throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.MISSING_PHONE, rowNumber)
  if (/^\+8210\d{8}$/.test(compact)) return compact
  if (/^8210\d{8}$/.test(compact)) return `+${compact}`
  if (/^010\d{8}$/.test(compact)) return `+82${compact.slice(1)}`
  throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_PHONE, rowNumber)
}

export const websiteSeoulTimestamp = (raw, rowNumber) => {
  const match = SEOUL_TIMESTAMP.exec(raw)
  if (match === null) throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_TIMESTAMP, rowNumber)
  const parsed = new Date(`${raw.replace(' ', 'T')}+09:00`)
  if (Number.isNaN(parsed.getTime())) {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_TIMESTAMP, rowNumber)
  }
  const seoul = new Date(parsed.getTime() + 9 * 60 * 60 * 1_000)
  const twoDigits = (value) => String(value).padStart(2, '0')
  const seoulRoundTrip = `${String(seoul.getUTCFullYear()).padStart(4, '0')}-${twoDigits(
    seoul.getUTCMonth() + 1,
  )}-${twoDigits(seoul.getUTCDate())} ${twoDigits(seoul.getUTCHours())}:${twoDigits(
    seoul.getUTCMinutes(),
  )}:${twoDigits(seoul.getUTCSeconds())}`
  if (seoulRoundTrip !== raw) throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_TIMESTAMP, rowNumber)
  return parsed
}

const sourceStatus = (raw, rowNumber) => {
  if (!KNOWN_SOURCE_STATUSES.has(raw)) {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_ROW, rowNumber)
  }
  const mapped = VERIFIED_SOURCE_STATUS_MAP.get(raw)
  if (mapped === undefined) {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.UNSUPPORTED_STATUS, rowNumber)
  }
  return mapped
}

const optionalHttpUrl = (raw) => {
  if (raw === '') return undefined
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return raw
  } catch {
    return undefined
  }
  return undefined
}

const csvField = (value) => `"${String(value).replaceAll('"', '""')}"`

export const canonicalCsv = (rows) =>
  `\uFEFF${CANONICAL_APPLICATION_HEADERS.join(',')}\n${rows
    .map((row) =>
      [
        row.sourceApplicationId,
        row.campaignCode,
        row.status,
        row.applicantName,
        row.phoneNormalized,
        row.blogUrl ?? '',
        row.bloggerLevel,
        row.blogDailyVisitors,
        row.bloggerRegion ?? '',
        row.submittedAt.toISOString(),
        row.updatedAt.toISOString(),
      ]
        .map(csvField)
        .join(','),
    )
    .join('\n')}\n`

const validateHeaders = (actual) => {
  if (!WEBSITE_EXPORT_HEADERS.every((expected, index) => actual[index] === expected)) {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_HEADER)
  }
  if (actual.length !== WEBSITE_EXPORT_HEADERS.length) {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_HEADER)
  }
}

const campaignCode = (sourceCampaignNumber, campaignMap, rowNumber) => {
  if (campaignMap === undefined) return sourceCampaignNumber
  const mapped = campaignMap.get(sourceCampaignNumber)
  if (mapped === undefined || mapped.length === 0) {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.CAMPAIGN_MAPPING_MISSING, rowNumber)
  }
  return mapped
}

export const convertWebsiteRows = (workbookRows, options) => {
  const header = workbookRows[0]
  if (header === undefined) throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_HEADER)
  validateHeaders(header.map((value) => cellText([value], 1)))
  const sourceRows = workbookRows.slice(1)
  const rowCount = sourceRows.length
  if (rowCount < 0 || rowCount > MAX_ROWS) throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.TOO_MANY_ROWS)

  const rows = []
  const applicationIds = new Set()
  const skippedMissingPhoneRows = []
  let droppedNonUrlChannels = 0
  for (const [index, row] of sourceRows.entries()) {
    const rowNumber = index + 2
    if (!row.some((value) => value !== null && value !== undefined && String(value).trim() !== '')) continue
    const sourceApplicationId = requiredIdentifier(cellText(row, COLUMN.applicationId), rowNumber)
    if (applicationIds.has(sourceApplicationId)) {
      throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.DUPLICATE_APPLICATION_ID, rowNumber)
    }
    applicationIds.add(sourceApplicationId)

    let phoneNormalized
    try {
      phoneNormalized = normalizeWebsiteKoreanPhone(cellText(row, COLUMN.phone), rowNumber)
    } catch (error) {
      if (
        error instanceof WebsiteExportError &&
        error.reasonCode === WEBSITE_EXPORT_FAILURES.MISSING_PHONE &&
        options.allowMissingPhone
      ) {
        skippedMissingPhoneRows.push(rowNumber)
        continue
      }
      throw error
    }

    const submittedAt = websiteSeoulTimestamp(cellText(row, COLUMN.submittedAt), rowNumber)
    if (submittedAt.getTime() > options.exportedAt.getTime() + 5 * 60 * 1_000) {
      throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_TIMESTAMP, rowNumber)
    }
    const channel = cellText(row, COLUMN.channel)
    const blogUrl = optionalHttpUrl(channel)
    if (channel !== '' && blogUrl === undefined) droppedNonUrlChannels += 1
    const sourceCampaignNumber = requiredIdentifier(cellText(row, COLUMN.campaignNumber), rowNumber)
    const bloggerRegion = optionalText(cellText(row, COLUMN.bloggerRegion), 100, rowNumber)
    rows.push({
      sourceApplicationId,
      campaignCode: campaignCode(sourceCampaignNumber, options.campaignMap, rowNumber),
      status: sourceStatus(cellText(row, COLUMN.sourceStatus), rowNumber),
      applicantName: requiredText(cellText(row, COLUMN.applicantName), 200, rowNumber),
      phoneNormalized,
      ...(blogUrl === undefined ? {} : { blogUrl }),
      bloggerLevel: sourceInteger(
        cellText(row, COLUMN.bloggerLevel),
        1,
        WEBSITE_EXPORT_FAILURES.INVALID_BLOGGER_LEVEL,
        rowNumber,
      ),
      blogDailyVisitors: sourceInteger(
        cellText(row, COLUMN.blogDailyVisitors),
        0,
        WEBSITE_EXPORT_FAILURES.INVALID_VISITOR_COUNT,
        rowNumber,
      ),
      ...(bloggerRegion === undefined ? {} : { bloggerRegion }),
      submittedAt,
      updatedAt: options.exportedAt,
    })
  }

  return {
    csv: canonicalCsv(rows),
    report: {
      sourceRowCount: rowCount,
      convertedRowCount: rows.length,
      skippedMissingPhoneRows,
      droppedNonUrlChannels,
    },
  }
}

export const convertWebsiteWorkbook = async (buffer, options) => {
  if (!(options.exportedAt instanceof Date) || Number.isNaN(options.exportedAt.getTime())) {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_TIMESTAMP)
  }
  let workbook
  try {
    workbook = await readExcelFile(buffer)
  } catch {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_WORKBOOK)
  }
  if (workbook.length !== 1) throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_WORKBOOK)
  const worksheet = workbook[0]
  if (worksheet === undefined || worksheet.sheet !== 'Worksheet') {
    throw new WebsiteExportError(WEBSITE_EXPORT_FAILURES.INVALID_WORKBOOK)
  }
  return convertWebsiteRows(worksheet.data, options)
}
