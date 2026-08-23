import { timestamp } from 'drizzle-orm/pg-core'

// Column helpers shared by every schema file.

/**
 * A timestamp WITH time zone.
 *
 * SPEC.md §8 requires timestamptz everywhere, and Drizzle's bare `timestamp()` emits `timestamp`
 * WITHOUT time zone — a silent default that would store every instant with no offset and quietly
 * corrupt any Asia/Seoul rendering the moment a process ran in a different zone.
 *
 * eslint.config.js bans importing `timestamp` from drizzle-orm/pg-core anywhere else, so this file
 * is the only place that default is reachable. Note the ban cannot catch a namespace import
 * (`import * as pg` then `pg.timestamp`) — that remains a review matter.
 *
 * mode 'date' hands application code a JS Date rather than a string, which is what the §14 state
 * model and the reservation rules expect.
 */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
