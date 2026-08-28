import type { Metadata } from 'next'
import { ConsoleAccessDenied } from '@/components/console-access-denied'
import { ConsoleScreen } from '@/components/console-screen'
import { SessionRequired } from '@/components/session-required'
import { getOperatorConsoleGateway } from '@/lib/console-gateway-provider'
import { getOperatorConsoleSession, isOperatorConsoleAuthorized } from '@/lib/operator-session'

type Props = Readonly<{ params: Promise<{ campaignId: string }> }>

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { campaignId } = await params
  return { title: `캠페인 ${campaignId.slice(0, 8)} 편집` }
}

export default async function CampaignDetailPage({ params }: Props) {
  const { campaignId } = await params
  const session = getOperatorConsoleSession()
  if (session === null) return <SessionRequired />
  if (!isOperatorConsoleAuthorized(session, 'campaigns.read', campaignId)) return <ConsoleAccessDenied />
  const screen = await getOperatorConsoleGateway().campaignEditor(session, campaignId)
  if (screen === null) return <ConsoleAccessDenied />
  return <ConsoleScreen screen={screen} session={session} campaignId={campaignId} />
}
