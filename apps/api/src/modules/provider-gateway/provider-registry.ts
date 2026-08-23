import { Inject, Injectable } from '@nestjs/common'
import { APP_CONFIG, type ApiConfig } from '../platform-core/index.js'
import { createHmacSignatureVerifier, type SignatureVerifier } from './signature/index.js'

// Which providers this gateway will accept events from, and how each one is authenticated.
//
// A REGISTRY, not a switch. Every provider signs differently, and PRD §18 is explicit that its
// contracts "are not claims about actual Kakao, Aligo, Naver, or website payloads" — the schemes
// are unverified for all of them. Adding a provider must therefore be adding an entry, not editing
// the controller.
//
// UNKNOWN PROVIDERS ARE REFUSED, and refused the same way an invalid signature is. A gateway that
// distinguishes "no such provider" from "bad signature" in its response tells an attacker which
// provider names exist, which is free reconnaissance for no benefit.

@Injectable()
export class ProviderRegistry {
  private readonly verifiers: ReadonlyMap<string, SignatureVerifier>

  constructor(@Inject(APP_CONFIG) config: ApiConfig) {
    const verifiers = new Map<string, SignatureVerifier>()

    for (const [provider, secret] of Object.entries(config.webhookSecrets)) {
      verifiers.set(
        provider,
        createHmacSignatureVerifier({
          provider,
          secret,
          replayWindowSeconds: config.webhookReplayWindowSeconds,
        }),
      )
    }

    this.verifiers = verifiers
  }

  /** The verifier for `provider`, or undefined if this gateway does not accept its events. */
  verifierFor(provider: string): SignatureVerifier | undefined {
    return this.verifiers.get(provider)
  }

  /** Provider names this gateway accepts. For diagnostics only — never returned to a caller. */
  known(): readonly string[] {
    return [...this.verifiers.keys()]
  }
}
