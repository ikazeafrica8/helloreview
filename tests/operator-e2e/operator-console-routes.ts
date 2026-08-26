import { PRD_REQUIRED_ROUTE_PATTERNS } from '../../apps/admin/src/lib/navigation.js'

const CAMPAIGN_ID = '10000000-0000-4000-8000-000000000001'
const PARTICIPANT_ID = '20000000-0000-4000-8000-000000000001'

type RequiredRoutePattern = (typeof PRD_REQUIRED_ROUTE_PATTERNS)[number]

const routeCases: Record<RequiredRoutePattern, Readonly<{ route: string; heading: string }>> = {
  '/overview': { route: '/overview', heading: '운영 현황' },
  '/participants': { route: '/participants', heading: '참여자 검색' },
  '/participants/[participantId]': {
    route: `/participants/${PARTICIPANT_ID}?campaignId=${CAMPAIGN_ID}`,
    heading: '참여자 타임라인',
  },
  '/human-review': { route: '/human-review', heading: '인간 검토' },
  '/campaigns': { route: '/campaigns', heading: '캠페인' },
  '/campaigns/[campaignId]': {
    route: `/campaigns/${CAMPAIGN_ID}`,
    heading: '지역 방문 캠페인 편집',
  },
  '/selection-rules': { route: '/selection-rules', heading: '선정 규칙' },
  '/reservation-rules': { route: '/reservation-rules', heading: '예약 규칙' },
  '/business-approvals': { route: '/business-approvals', heading: '사업 승인' },
  '/message-templates': { route: '/message-templates', heading: '메시지 템플릿' },
  '/guidelines': { route: '/guidelines', heading: '가이드라인' },
  '/notifications': { route: '/notifications', heading: '알림 이력' },
  '/deduplication': { route: '/deduplication', heading: '중복 방지 이력' },
  '/failed-jobs': { route: '/failed-jobs', heading: '실패 작업' },
  '/integrations': { route: '/integrations', heading: '연동 상태' },
  '/audit': { route: '/audit', heading: '감사 로그' },
  '/privacy': { route: '/privacy', heading: '개인정보 요청' },
  '/users-roles': { route: '/users-roles', heading: '사용자 및 역할' },
  '/automation-pauses': { route: '/automation-pauses', heading: '자동화 일시중지' },
  '/ai-cost': { route: '/ai-cost', heading: 'AI 및 비용' },
}

export const canonicalPages = PRD_REQUIRED_ROUTE_PATTERNS.map((pattern) => ({ pattern, ...routeCases[pattern] }))
export { CAMPAIGN_ID, PARTICIPANT_ID }
