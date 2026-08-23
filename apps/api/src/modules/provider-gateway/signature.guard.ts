import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { UnauthenticatedError } from '@helloreview/contracts'
import { createLogger, type Logger } from '@helloreview/observability'
import { Inject } from '@nestjs/common'
import { APP_CONFIG, type ApiConfig } from '../platform-core/index.js'
import { ProviderRegistry } from './provider-registry.js'
import { RAW_BODY, type RequestWithRawBody } from './raw-body.middleware.js'
import { flattenHeaders } from './http.js'

// The gate that runs before anything else (PRD §18.3, T16).
//
// A GUARD rather than logic inside the controller, because a guard cannot be forgotten. Nest runs
// every guard before the handler and before any body-shaped pipe, so an endpoint that carries this
// one cannot be reached by an unauthenticated request — whereas a controller that calls `verify()`
// on its first line is one refactor away from calling it on its second.
//
// WHAT IT MUST NOT LOG. Not the signature, not the secret, not the body, not the headers. §18.3
// lists "Secrets and authorization headers excluded from logs" as a requirement, and a signature
// IS an authorization header. What is logged is the provider, the reason CODE, and the correlation
// id — enough to answer "who is failing and why" and nothing that helps an attacker.

@Injectable()
export class SignatureGuard implements CanActivate {
  private readonly logger: Logger

  constructor(
    private readonly registry: ProviderRegistry,
    @Inject(APP_CONFIG) config: ApiConfig,
  ) {
    this.logger = createLogger({ module: 'provider-gateway', environment: config.environment })
  }

  canActivate(context: ExecutionContext): boolean {
    const request: RequestWithRawBody = context.switchToHttp().getRequest()
    const provider = request.params.provider ?? ''

    const rawBody = request[RAW_BODY]
    if (rawBody === undefined) {
      // Reaching the guard without the raw-body middleware having run means the route is wired
      // wrong. Failing closed is the only safe reading: the alternative is verifying a signature
      // over an empty buffer, which would succeed for anyone who signs an empty body.
      this.reject(provider, 'RAW_BODY_MISSING')
    }

    const verifier = this.registry.verifierFor(provider)
    if (verifier === undefined) {
      // Deliberately the same refusal an invalid signature gets. Distinguishing them would tell an
      // attacker which provider names are registered, for no operational benefit.
      this.reject(provider, 'UNKNOWN_PROVIDER')
    }

    const result = verifier.verify({
      rawBody,
      headers: flattenHeaders(request.headers),
      receivedAt: new Date(),
    })

    if (!result.ok) this.reject(provider, result.reasonCode)

    return true
  }

  /**
   * Log the specific refusal, return a coarse one. Never returns.
   *
   * THE ASYMMETRY IS THE POINT, and it was wrong until an audit caught it. The specific code was
   * being passed to UnauthenticatedError, and ContractErrorFilter renders `reasonCode` into the
   * response body — so an attacker could read MISSING_SIGNATURE, MALFORMED_TIMESTAMP,
   * REPLAY_WINDOW_EXCEEDED, SIGNATURE_MISMATCH or UNKNOWN_PROVIDER straight off the 401 and tune
   * their attempts one property at a time. Three comments in this module asserted the opposite, and
   * the security test written to pin it compared only the response KEYS, never their values, so it
   * passed while they differed.
   *
   * An operator still needs to know which check failed, and now gets it: the specific code goes to
   * the log line. (That was also broken until recently — the logger declared `reasonCode` and
   * dropped it. Both halves had to be fixed for either to be worth anything.)
   */
  private reject(provider: string, reasonCode: string): never {
    this.logger.warn('webhook signature rejected', {
      operation: 'provider_gateway.verify',
      result: 'rejected',
      reasonCode,
      provider,
    })
    // ONE code for every authentication failure. Deliberately coarse; see above.
    throw new UnauthenticatedError('signature verification failed', 'WEBHOOK_AUTH_FAILED')
  }
}
