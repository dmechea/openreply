/**
 * A real Postgres for suites that drive route handlers end to end.
 *
 * Each suite gets its own throwaway Postgres schema, built from
 * prisma/migrations exactly as `prisma migrate deploy` would build it, and
 * dropped when the suite ends, so it never touches existing data and suites
 * can run side by side against one server. Without TEST_DATABASE_URL these
 * suites skip; set REQUIRE_TEST_DATABASE=1 to make that an error instead, as
 * the pre-push gate does. See docs/testing.md.
 *
 * A suite routes the app's Prisma client here with:
 *
 *   vi.mock("@/lib/db/client", async () =>
 *     (await import("./support/database")).prismaModule);
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/app/generated/prisma/client";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL && process.env.REQUIRE_TEST_DATABASE === "1") {
  throw new Error(
    "REQUIRE_TEST_DATABASE=1 but TEST_DATABASE_URL is not set; the database suites would skip."
  );
}

export const hasTestDatabase = Boolean(TEST_DATABASE_URL);

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");

const current = {
  prisma: undefined as PrismaClient | undefined,
};

/** Stands in for `@/lib/db/client` while a suite's database is open. */
export const prismaModule = {
  get prisma() {
    return getTestPrisma();
  },
  getPrisma: () => getTestPrisma(),
};

export function getTestPrisma(): PrismaClient {
  if (!current.prisma) {
    throw new Error("The test database is not open; call openTestDatabase() in beforeAll.");
  }
  return current.prisma;
}

export type TestDatabase = {
  prisma: PrismaClient;
  /** A plain connection with the suite's schema on its search path. */
  sql: Client;
  close(): Promise<void>;
};

function migrationDirs() {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function openTestDatabase(label: string): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");

  const schema = `${label}_${randomBytes(4).toString("hex")}`;
  const sql = new Client({ connectionString: TEST_DATABASE_URL });
  await sql.connect();
  await sql.query(`CREATE SCHEMA "${schema}"`);
  await sql.query(`SET search_path TO "${schema}"`);
  for (const dir of migrationDirs()) {
    await sql.query(
      readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8")
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }, { schema }),
  });
  current.prisma = prisma;

  return {
    prisma,
    sql,
    async close() {
      await prisma.$disconnect();
      if (current.prisma === prisma) current.prisma = undefined;
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    },
  };
}
