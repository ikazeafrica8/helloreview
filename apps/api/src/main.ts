// reflect-metadata must be imported before anything that uses a decorator. NestJS dependency
// injection reads the metadata TypeScript emits under emitDecoratorMetadata, and that metadata is
// stored on the Reflect polyfill this import installs.
import 'reflect-metadata'

import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { APP_CONFIG } from './modules/platform-core/index.js'
import { ConfigurationError, type ApiConfig } from './modules/platform-core/index.js'

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] })

  // Without this, SIGTERM kills the process before onApplicationShutdown runs and the Postgres pool
  // and Redis connection are abandoned rather than closed.
  app.enableShutdownHooks()

  const config = app.get<ApiConfig>(APP_CONFIG)

  // Loopback only. Binding 0.0.0.0 in development exposes the service to whatever network the
  // machine has joined, and this one talks to a database holding participant data (PRD §21.3).
  await app.listen(config.apiPort, '127.0.0.1')

  new Logger('Bootstrap').log(`api listening on http://127.0.0.1:${String(config.apiPort)}`)
}

try {
  await bootstrap()
} catch (error) {
  const logger = new Logger('Bootstrap')
  if (error instanceof ConfigurationError) {
    // A misconfigured process must not start. Print every problem at once so it takes one restart
    // to fix rather than one per missing key.
    logger.error(error.message)
  } else {
    logger.error(`failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  }
  process.exit(1)
}
