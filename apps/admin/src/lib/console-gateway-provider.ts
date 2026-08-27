import 'server-only'
import {
  CONSOLE_FIXTURE_GATEWAY,
  PRODUCTION_LOCKED_CONSOLE_GATEWAY,
  type OperatorConsoleGateway,
} from './console-gateway'
import { readAdminConsoleEnvironment } from './env-source'

/** Server-only adapter boundary. A future authenticated transport replaces this factory branch. */
export const getOperatorConsoleGateway = (): OperatorConsoleGateway =>
  readAdminConsoleEnvironment().sessionMode === 'test_fixture'
    ? CONSOLE_FIXTURE_GATEWAY
    : PRODUCTION_LOCKED_CONSOLE_GATEWAY
