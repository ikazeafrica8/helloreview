import 'server-only'
import { readAdminConsoleEnvironment } from './env-source'
import { OPERATOR_CONSOLE_TEST_FIXTURE_SESSION, type OperatorConsoleSession } from './operator-session-contract'

export {
  isOperatorConsoleAuthorized,
  OPERATOR_CONSOLE_FIXTURE_READ_ACTIONS,
  OPERATOR_CONSOLE_TEST_FIXTURE_SESSION,
  type OperatorConsoleSession,
} from './operator-session-contract'

/**
 * Provider-neutral session boundary. Production stays locked until T103's principal is supplied by
 * an approved SSO or local-MFA adapter. The fixture cannot be enabled in production.
 */
export const getOperatorConsoleSession = (): OperatorConsoleSession | null => {
  const environment = readAdminConsoleEnvironment()
  if (environment.sessionMode !== 'test_fixture') return null
  return OPERATOR_CONSOLE_TEST_FIXTURE_SESSION
}
