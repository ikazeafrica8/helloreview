import { pgEnum } from 'drizzle-orm/pg-core'

// Shared enumerations — the vocabulary several modules will use.
//
// SCOPE: only values the PRD explicitly says are STORED as structured fields, and only where more
// than one module needs them. Entity tables and their module-local enums arrive with the module
// that owns them (T21 campaigns, T34 workflow instances, and so on).
//
// Why enums at the database level rather than text with a CHECK: the §16.4 routing table branches
// on exactly these values, and an unrecognized campaign type must be impossible to store rather
// than discovered later by a rules engine that has no sensible answer for it.
//
// Adding a value to a Postgres enum is easy; removing or reordering one is not. Treat these as
// append-only, and prefer a new value over redefining an existing one.

/**
 * PRD FR-CAM-001: "Campaign type shall be stored as Shipping, Payback, or Visit. Routing never
 * depends on repeated free-text interpretation."
 */
export const campaignTypeEnum = pgEnum('campaign_type', ['shipping', 'payback', 'visit'])

/**
 * PRD FR-CAM-002: "Visit method shall be stored as A, B, or C."
 *
 * `not_applicable` is a real state, not a null stand-in: §14.2 lists it explicitly for shipping and
 * payback campaigns, and making it explicit keeps the §16.4 routing table total.
 */
export const visitMethodEnum = pgEnum('visit_method', ['not_applicable', 'visit_a', 'visit_b', 'visit_c'])
