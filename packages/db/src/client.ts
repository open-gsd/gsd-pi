// packages/db — Drizzle ORM client singleton using neon-http driver.
// Uses HTTP transport (not TCP pool) — correct for Next.js serverless API routes (D-05, D-06).
// Per Pattern 3 from RESEARCH.md: drizzle({ client: sql, schema }) with schema passed for type-safe queries.
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema/index.js';

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return drizzle({ client: neon(url), schema });
}

type Db = ReturnType<typeof createDb>;

let instance: Db | undefined;

export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    instance ??= createDb();
    const value = Reflect.get(instance, prop) as unknown;
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
  },
});
