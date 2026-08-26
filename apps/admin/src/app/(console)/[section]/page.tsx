import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ConsoleScreen } from '@/components/console-screen'
import { getOperatorConsoleGateway } from '@/lib/console-gateway'
import { isConsoleRoute, type ConsoleRoute } from '@/lib/console-contract'

type Props = Readonly<{ params: Promise<{ section: string }> }>

const toRoute = (section: string): Exclude<ConsoleRoute, '/overview' | '/participants'> | null => {
  const route = `/${section}`
  return isConsoleRoute(route) && route !== '/overview' && route !== '/participants' ? route : null
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { section } = await params
  const route = toRoute(section)
  return { title: route === null ? '찾을 수 없음' : (await getOperatorConsoleGateway().screen(route)).title }
}

export default async function ConsoleSectionPage({ params }: Props) {
  const { section } = await params
  const route = toRoute(section)
  if (route === null) notFound()
  return <ConsoleScreen screen={await getOperatorConsoleGateway().screen(route)} />
}
