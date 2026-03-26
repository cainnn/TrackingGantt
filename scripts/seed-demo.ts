/**
 * Seeds the "Launch SaaS Product" demo project matching the reference image.
 * Run: npx tsx scripts/seed-demo.ts
 */
import { Pool } from 'pg'

const pool = new Pool({
  host: 'localhost', port: 5432,
  database: 'gantt_db', user: 'postgres', password: '11111a',
})

async function main() {
  const client = await pool.connect()
  try {
    // Find the admin user
    const userRes = await client.query(`SELECT id FROM users WHERE username='admin' LIMIT 1`)
    if (userRes.rows.length === 0) {
      console.error('Admin user not found. Run: npx tsx scripts/seed-admin.ts first')
      return
    }
    const userId = userRes.rows[0].id

    // ── Create project ──────────────────────────────────────────────────────
    const projRes = await client.query(
      `INSERT INTO projects (user_id, name, start_date, end_date, status_date)
       VALUES ($1, 'Launch SaaS Product', '2026-01-12', '2026-02-09', '2026-01-22')
       RETURNING id`,
      [userId]
    )
    const pid = projRes.rows[0].id
    console.log('Created project:', pid)

    // ── Helper ──────────────────────────────────────────────────────────────
    let order = 0
    async function insertTask(
      name: string, parentId: string | null,
      start: string, end: string,
      percentDone: number, orderIdx?: number
    ): Promise<string> {
      const r = await client.query(
        `INSERT INTO tasks
           (project_id, parent_id, name, start_date, end_date, duration,
            duration_unit, percent_done, order_index)
         VALUES ($1,$2,$3,$4::date,$5::date,
           ($5::date - $4::date),
           'day', $6, $7)
         RETURNING id`,
        [pid, parentId, name, start, end, percentDone, orderIdx ?? order++]
      )
      return r.rows[0].id
    }

    // ── Tasks (matching reference image) ────────────────────────────────────
    const root    = await insertTask('Launch SaaS Product', null,
                      '2026-01-12', '2026-02-09', 0)

    const server  = await insertTask('Setup web server',    root,
                      '2026-01-12', '2026-01-22', 0)

    const apache  = await insertTask('Install Apache',      server,
                      '2026-01-12', '2026-01-17', 50)
    const fw      = await insertTask('Configure firewall',  server,
                      '2026-01-12', '2026-01-17', 50)
    const lb      = await insertTask('Setup load balancer', server,
                      '2026-01-12', '2026-01-17', 50)
    const ports   = await insertTask('Configure ports',     server,
                      '2026-01-12', '2026-01-14', 10)
    const tests   = await insertTask('Run tests',           server,
                      '2026-01-20', '2026-01-23', 0)

    const design  = await insertTask('Website Design',      root,
                      '2026-01-24', '2026-02-09', 0)

    const contact = await insertTask('Contact designers',            design,
                      '2026-01-24', '2026-02-01', 60)
    const short   = await insertTask('Create shortlist of three',    design,
                      '2026-02-01', '2026-02-05', 0)
    const select  = await insertTask('Select & review final design', design,
                      '2026-02-03', '2026-02-09', 0)

    // ── Dependencies ────────────────────────────────────────────────────────
    const deps = [
      [apache,  tests],
      [fw,      tests],
      [lb,      tests],
      [ports,   tests],
      [tests,   contact],
      [contact, short],
      [short,   select],
    ]
    for (const [from, to] of deps) {
      await client.query(
        `INSERT INTO dependencies (project_id, from_task_id, to_task_id, type)
         VALUES ($1, $2, $3, 2)`,
        [pid, from, to]
      )
    }

    console.log('Demo data seeded successfully!')
    console.log('Login: admin / admin123')
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(console.error)
