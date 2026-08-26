import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ConsoleScreen } from '@/components/console-screen'
import { getOperatorConsoleGateway } from '@/lib/console-gateway'

type Props = Readonly<{ params: Promise<{ campaignId: string }> }>

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { campaignId } = await params
  return { title: `캠페인 ${campaignId.slice(0, 8)} 편집` }
}

export default async function CampaignDetailPage({ params }: Props) {
  const { campaignId } = await params
  const screen = await getOperatorConsoleGateway().campaignEditor(campaignId)
  if (screen === null) notFound()
  return <ConsoleScreen screen={screen} />
}
