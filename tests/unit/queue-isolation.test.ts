// Unit tier: the guard that keeps the integration suite from destroying real queued work.
//
// This is a test about a cleanup step, which is an odd thing to test until you notice what the
// cleanup does: `queue.obliterate({ force: true })` deletes every key belonging to a queue. Two
// integration tests run it against the LOCAL dev Redis. While the queues are empty that is
// harmless; once T27/T43/T45 give SEND_OUTBOUND and RECONCILE_APPLICATIONS real jobs, a `pnpm test`
// run alongside a running worker would quietly delete queued outbound messages.
//
// The properties below are what make that impossible. They are asserted here rather than left to
// the integration tests because an integration test that silently stopped isolating would still
// PASS — it would just be operating on the wrong database.

import { test, describe, expect } from 'vitest'
import { isolatedRedisUrl, isolatedQueueName, TEST_DATABASE_INDEX } from '../../packages/testing/src/index.js'
import { QUEUE_NAMES } from '../../packages/contracts/src/index.js'

const DEV_URL = 'redis://default:helloreview_local_dev@127.0.0.1:16379/0'

describe('isolatedRedisUrl', () => {
  test('moves the connection off the application database', () => {
    const isolated = isolatedRedisUrl(DEV_URL)

    expect(new URL(isolated).pathname).toBe(`/${String(TEST_DATABASE_INDEX)}`)
    expect(TEST_DATABASE_INDEX).not.toBe(0)
  })

  test('keeps credentials, host and port, so a real misconfiguration still fails the test', () => {
    // Isolation must not become a way for the suite to pass against a server the application could
    // never reach. Only the database index changes.
    const original = new URL(DEV_URL)
    const isolated = new URL(isolatedRedisUrl(DEV_URL))

    expect(isolated.username).toBe(original.username)
    expect(isolated.password).toBe(original.password)
    expect(isolated.hostname).toBe(original.hostname)
    expect(isolated.port).toBe(original.port)
    expect(isolated.protocol).toBe(original.protocol)
  })

  test('is idempotent, so applying it twice is not a bug', () => {
    expect(isolatedRedisUrl(isolatedRedisUrl(DEV_URL))).toBe(isolatedRedisUrl(DEV_URL))
  })
})

describe('isolatedQueueName', () => {
  test('never equals the registered name, so obliterate cannot reach real work', () => {
    // The second layer of the guard. Even if someone later points the suite back at database 0,
    // the keys this test touches are still disjoint from the ones the platform uses.
    for (const registered of Object.values(QUEUE_NAMES)) {
      expect(isolatedQueueName(registered, 'probe')).not.toBe(registered)
    }
  })

  test('derives from the registered name, so renaming a queue still breaks the test', () => {
    // This is what keeps it a contract test rather than a test against a made-up string: the real
    // registry value has to survive into the name, or the provenance is lost.
    expect(isolatedQueueName(QUEUE_NAMES.SEND_OUTBOUND, 'probe')).toContain(QUEUE_NAMES.SEND_OUTBOUND)
  })

  test('separates concurrent tests and concurrent runs', () => {
    // Same process, two labels — two different queues, so tests cannot obliterate each other.
    expect(isolatedQueueName(QUEUE_NAMES.SEND_OUTBOUND, 'a')).not.toBe(
      isolatedQueueName(QUEUE_NAMES.SEND_OUTBOUND, 'b'),
    )
    // The pid is what separates two runs racing on one machine.
    expect(isolatedQueueName(QUEUE_NAMES.SEND_OUTBOUND, 'a')).toContain(String(process.pid))
  })
})
