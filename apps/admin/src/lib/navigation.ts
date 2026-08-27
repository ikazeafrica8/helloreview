export const OPERATOR_NAVIGATION = [
  {
    label: '운영',
    items: [
      { href: '/overview', label: '운영 현황' },
      { href: '/participants', label: '참여자 검색' },
      { href: '/human-review', label: '인간 검토' },
      { href: '/business-approvals', label: '사업 승인' },
      { href: '/failed-jobs', label: '실패 작업' },
      { href: '/notifications', label: '알림 이력' },
      { href: '/deduplication', label: '중복 방지 이력' },
    ],
  },
  {
    label: '캠페인',
    items: [
      { href: '/campaigns', label: '캠페인' },
      { href: '/selection-rules', label: '선정 규칙' },
      { href: '/reservation-rules', label: '예약 규칙' },
      { href: '/message-templates', label: '메시지 템플릿' },
      { href: '/guidelines', label: '가이드라인' },
    ],
  },
  {
    label: '거버넌스',
    items: [
      { href: '/integrations', label: '연동 상태' },
      { href: '/audit', label: '감사 로그' },
      { href: '/privacy', label: '개인정보 요청' },
      { href: '/users-roles', label: '사용자 및 역할' },
      { href: '/automation-pauses', label: '자동화 일시중지' },
      { href: '/ai-cost', label: 'AI 및 비용' },
      { href: '/sensitive-access', label: '민감정보 접근' },
      { href: '/system', label: '시스템 정보' },
    ],
  },
] as const

export const OPERATOR_ROUTES = OPERATOR_NAVIGATION.flatMap((section) => section.items.map((item) => item.href))

export const operatorRouteLabel = (route: string): string | undefined =>
  OPERATOR_NAVIGATION.flatMap((section) => section.items.map((item) => item)).find((item) => item.href === route)?.label

/** The exact PRD §20.1 page inventory. Dynamic detail pages are separate from sidebar destinations. */
export const PRD_REQUIRED_ROUTE_PATTERNS = [
  '/overview',
  '/participants',
  '/participants/[participantId]',
  '/human-review',
  '/campaigns',
  '/campaigns/[campaignId]',
  '/selection-rules',
  '/reservation-rules',
  '/business-approvals',
  '/message-templates',
  '/guidelines',
  '/notifications',
  '/deduplication',
  '/failed-jobs',
  '/integrations',
  '/audit',
  '/privacy',
  '/users-roles',
  '/automation-pauses',
  '/ai-cost',
] as const

/** Explicit governance extensions, not substitutes for the PRD's dynamic detail pages. */
export const OPERATOR_EXTENSION_ROUTES = ['/sensitive-access', '/system'] as const
