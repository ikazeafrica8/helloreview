import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common'
import { HealthService, type HealthReport } from './health.service.js'

/**
 * Unauthenticated by design — a load balancer and an uptime probe both need it before any credential
 * exists. That is exactly why the response carries no version, environment, hostname or connection
 * detail: everything here is readable by anyone who can reach the port.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async check(): Promise<HealthReport> {
    const report = await this.health.check()

    // 503 rather than 200-with-a-status-field: orchestrators route on the status code, and a
    // degraded instance that answers 200 keeps receiving traffic.
    if (report.status !== 'ok') {
      throw new HttpException(report, HttpStatus.SERVICE_UNAVAILABLE)
    }
    return report
  }
}
