import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ConsoleAccessDenied } from '@/components/console-access-denied'
import { ConsoleScreen } from '@/components/console-screen'
import { SessionRequired } from '@/components/session-required'
import { CONSOLE_SCREEN_READ_ACTIONS, FIXTURE_CAMPAIGN_ID } from '@/lib/console-gateway'
import { getOperatorConsoleGateway } from '@/lib/console-gateway-provider'
import { isConsoleRoute, type ConsoleRoute } from '@/lib/console-contract'
import { operatorRouteLabel } from '@/lib/navigation'
import { getOperatorConsoleSession, isOperatorConsoleAuthorized } from '@/lib/operator-session'

type Props = Readonly<{ params: Promise<{ section: string }> }>

const toRoute = (section: string): Exclude<ConsoleRoute, '/overview' | '/participants'> | null => {
  const route = `/${section}`
  return isConsoleRoute(route) && route !== '/overview' && route !== '/participants' ? route : null
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { section } = await params
  const route = toRoute(section)
  return { title: route === null ? '찾을 수 없음' : (operatorRouteLabel(route) ?? '운영 콘솔') }
}

export default async function ConsoleSectionPage({ params }: Props) {
  const { section } = await params
  const route = toRoute(section)
  if (route === null) notFound()
  const session = getOperatorConsoleSession()
  if (session === null) return <SessionRequired />
  if (!isOperatorConsoleAuthorized(session, CONSOLE_SCREEN_READ_ACTIONS[route], FIXTURE_CAMPAIGN_ID))
    return <ConsoleAccessDenied />
  const screen = await getOperatorConsoleGateway().screen(session, route, FIXTURE_CAMPAIGN_ID)
  if (screen === null) return <ConsoleAccessDenied />
  return <ConsoleScreen screen={screen} />
}
