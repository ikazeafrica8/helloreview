import 'server-only'
import { parseAdminConsoleEnvironment } from './admin-console-environment'

export const readAdminConsoleEnvironment = () =>
  parseAdminConsoleEnvironment({
    ADMIN_CONSOLE_SESSION_MODE: process.env.ADMIN_CONSOLE_SESSION_MODE,
    NODE_ENV: process.env.NODE_ENV,
  })
