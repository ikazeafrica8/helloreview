import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common'
import { ContractError } from '@helloreview/contracts'
import type { GatewayResponse } from './http.js'

// The one place the PRD §18.4 status table becomes an HTTP response (T16).
//
// The hierarchy in packages/contracts carries the status; this maps it onto the wire. Keeping that
// mapping in a filter rather than in each controller means a new error class is answered correctly
// everywhere the moment it is thrown, and it means the §18.4 table has exactly one implementation.
//
// WHAT THE RESPONSE MAY CONTAIN. A status, a stable reason code, and nothing else. Not the message
// of an underlying exception, not a stack, not which validation failed. An error body is the
// cheapest oracle an attacker has: "invalid signature" versus "unknown provider" versus "replay
// window exceeded" tells them exactly which property to vary next. The reason code IS returned,
// because a legitimate provider integrating against this needs to know why they were refused — but
// the codes are deliberately coarse for the 401 case, where the guard reports one code for every
// authentication failure.

@Catch(ContractError)
export class ContractErrorFilter implements ExceptionFilter<ContractError> {
  catch(error: ContractError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<GatewayResponse>()

    response.status(error.status).json({
      accepted: false,
      // `error.name` is the class name, set in the ContractError constructor. Structural, not
      // derived from any value that arrived with the request.
      error: error.name,
      ...(error.reasonCode === undefined ? {} : { reason_code: error.reasonCode }),
    })
  }
}
