import { Injectable } from '@nestjs/common'
import { bindDbTransaction } from '@helloreview/db'
import { createParticipantForApplication } from '@helloreview/workflow-runtime'
import type { PoolClient } from 'pg'

@Injectable()
export class ApplicationParticipantBootstrapService {
  async createForApplication(client: PoolClient, applicationId: string, createdAt: Date): Promise<string> {
    return createParticipantForApplication(bindDbTransaction(client), applicationId, createdAt)
  }
}
