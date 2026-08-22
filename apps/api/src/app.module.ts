import { Module } from '@nestjs/common'
import { PlatformCoreModule } from './modules/platform-core/index.js'

/**
 * Composition root. Every capability-map module from SPEC.md §3.1 is imported here as it lands, in
 * dependency order — platform-core first, because everything else rests on it.
 */
@Module({
  imports: [PlatformCoreModule],
})
export class AppModule {}
