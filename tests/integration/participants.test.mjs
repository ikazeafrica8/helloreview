// Integration tier: participant identity constraints (T28, FR-ID-004/005/009).

import { beforeAll, describe, expect, test } from 'vitest'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

describe('T28 participant and channel identity persistence', () => {
  beforeAll(() => {
    for (const workspace of ['packages/db', 'packages/testing']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('shared phones persist while provider identities remain namespace-unique', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { Pool } = await import('pg')

    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url, max: 4 })
      try {
        const first = await pool.query(
          `INSERT INTO participants (name, phone_normalized, blog_url)
           VALUES ('Test Participant One', '+821012345678', 'https://blog.example/one')
           RETURNING id`,
        )
        const second = await pool.query(
          `INSERT INTO participants (name, phone_normalized, blog_url)
           VALUES ('Test Participant Two', '+821012345678', 'https://blog.example/two')
           RETURNING id`,
        )

        expect(first.rows[0].id).not.toBe(second.rows[0].id)
        const shared = await pool.query(
          `SELECT count(*)::integer AS count FROM participants WHERE phone_normalized = '+821012345678'`,
        )
        expect(shared.rows[0].count).toBe(2)

        const phoneIndex = await pool.query(
          `SELECT indexdef FROM pg_indexes
            WHERE schemaname = 'public' AND indexname = 'participants_phone_idx'`,
        )
        expect(phoneIndex.rows).toHaveLength(1)
        expect(phoneIndex.rows[0].indexdef).not.toContain('UNIQUE')

        await pool.query(
          `INSERT INTO channel_identities (
             participant_id, provider, external_user_id, verification_state, verified_at
           ) VALUES ($1, 'official_kakao_provider', 'provider-user-1', 'verified', now())`,
          [first.rows[0].id],
        )
        await expect(
          pool.query(
            `INSERT INTO channel_identities (participant_id, provider, external_user_id)
             VALUES ($1, 'official_kakao_provider', 'provider-user-1')`,
            [second.rows[0].id],
          ),
        ).rejects.toMatchObject({
          code: '23505',
          constraint: 'channel_identities_provider_external_user_key',
        })

        await expect(
          pool.query(
            `INSERT INTO channel_identities (participant_id, provider, external_user_id)
             VALUES ($1, 'second_kakao_provider', 'provider-user-1')`,
            [second.rows[0].id],
          ),
        ).resolves.toMatchObject({ rowCount: 1 })
      } finally {
        await pool.end()
      }
    })
  }, 300_000)
})
