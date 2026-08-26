export type AdminConsoleSessionMode = 'disabled' | 'test_fixture'

export type AdminConsoleEnvironment = Readonly<{
  sessionMode: AdminConsoleSessionMode
  nodeEnvironment: 'development' | 'test' | 'production'
}>

export class AdminConsoleEnvironmentError extends Error {
  override readonly name = 'AdminConsoleEnvironmentError'
  constructor(readonly reasonCode: string) {
    super(`admin console environment rejected: ${reasonCode}`)
  }
}

export const parseAdminConsoleEnvironment = (
  input: Readonly<Record<string, string | undefined>>,
): AdminConsoleEnvironment => {
  const sessionMode = input.ADMIN_CONSOLE_SESSION_MODE ?? 'disabled'
  if (sessionMode !== 'disabled' && sessionMode !== 'test_fixture')
    throw new AdminConsoleEnvironmentError('ADMIN_CONSOLE_SESSION_MODE_INVALID')
  const nodeEnvironment = input.NODE_ENV ?? 'development'
  if (nodeEnvironment !== 'development' && nodeEnvironment !== 'test' && nodeEnvironment !== 'production')
    throw new AdminConsoleEnvironmentError('ADMIN_CONSOLE_NODE_ENVIRONMENT_INVALID')
  if (nodeEnvironment === 'production' && sessionMode === 'test_fixture')
    throw new AdminConsoleEnvironmentError('ADMIN_CONSOLE_TEST_SESSION_PRODUCTION_FORBIDDEN')
  return { sessionMode, nodeEnvironment }
}
