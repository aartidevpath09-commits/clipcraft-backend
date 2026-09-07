/**
 * Minimal, dependency-free SQL migration runner.
 *
 * No ORM/migration framework is used in this project. Migrations are plain
 * .sql files in app/db/migrations/, named with a numeric prefix
 * (e.g. 001_*.sql) so they sort and apply in order. Applied migrations are
 * tracked in a `schema_migrations` table so re-running this script is safe
 * (already-applied files are skipped).
 *
 * Usage:
 *   node app/db/migrate.js
 *
 * This only touches migration bookkeeping + the SQL files below; it does not
 * modify any other shared file.
 */

const fs = require("fs");
const path = require("path");

// This script is a standalone CLI entry point (not loaded through
// app/server.js), so it must load environment variables itself.
require("dotenv").config();

const pool = require("../config/db");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(client) {
  const result = await client.query("SELECT filename FROM schema_migrations");
  return new Set(result.rows.map((row) => row.filename));
}

async function runMigrations() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    for (const filename of files) {
      if (applied.has(filename)) {
        console.log(`[migrate] skip (already applied): ${filename}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
      console.log(`[migrate] applying: ${filename}`);

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [filename]
        );
        await client.query("COMMIT");
        console.log(`[migrate] applied: ${filename}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration failed (${filename}): ${err.message}`);
      }
    }

    console.log("[migrate] done");
  } finally {
    client.release();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .catch((err) => {
      console.error("[migrate] error:", err.message);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { runMigrations };
