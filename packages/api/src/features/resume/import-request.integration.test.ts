import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouterClient } from "@orpc/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const fixture = vi.hoisted(() => ({
	db: undefined as ReturnType<typeof drizzle> | undefined,
	pool: undefined as Pool | undefined,
}));
vi.mock("@reactive-resume/db/client", () => ({
	get db() {
		return fixture.db;
	},
	getPool: () => fixture.pool,
}));
vi.mock("../storage/service", () => ({ getStorageService: () => ({}) }));
vi.mock("../../middleware/rate-limit", async () => {
	const { os } = await vi.importActual<typeof import("@orpc/server")>("@orpc/server");
	return { resumeMutationRateLimit: os.middleware(({ next }) => next()) };
});
vi.mock("../../context", async () => {
	const { os } = await vi.importActual<typeof import("@orpc/server")>("@orpc/server");
	return {
		protectedProcedure: os.$context<{ locale: "en-US"; reqHeaders: Headers; user: { id: string } }>(),
	};
});

const migrationsFolder = new URL("../../../../../migrations", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function getPool(): Pool {
	if (!fixture.pool) throw new Error("Test database is not initialized");
	return fixture.pool;
}

const jsonResume = {
	basics: { name: "Test Student", email: "student@example.test", label: "Data Analyst" },
	skills: [{ name: "SQL", level: "Advanced" }],
};

// Opt-in real PostgreSQL tests: the URL names a server where a throwaway database may be created.
// Every migration is applied to that database, so the unique and foreign-key rules are the real ones.
describe.skipIf(!process.env.RESUME_IMPORT_TEST_DATABASE_URL)("resume import requests on PostgreSQL", () => {
	const databaseName = `resume_import_test_${randomUUID().replaceAll("-", "")}`;
	let admin: Pool;
	let crudRouter: typeof import("./crud").crudRouter;

	const client = (userId: string) =>
		createRouterClient(crudRouter, {
			context: { locale: "en-US", reqHeaders: new Headers(), user: { id: userId } } as never,
		});
	const count = async (sql: string, params: unknown[] = []) =>
		Number((await getPool().query(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n);

	beforeAll(async () => {
		admin = new Pool({ connectionString: process.env.RESUME_IMPORT_TEST_DATABASE_URL });
		await admin.query(`CREATE DATABASE ${databaseName}`);
		const url = new URL(process.env.RESUME_IMPORT_TEST_DATABASE_URL as string);
		url.pathname = `/${databaseName}`;
		fixture.pool = new Pool({ connectionString: url.toString() });
		fixture.db = drizzle({ client: fixture.pool });
		await migrate(fixture.db, { migrationsFolder });
		crudRouter = (await import("./crud")).crudRouter;
	}, 120_000);

	afterAll(async () => {
		await fixture.pool?.end();
		await admin?.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
		await admin?.end();
	});

	beforeEach(async () => {
		await getPool().query('TRUNCATE "user" CASCADE');
		for (const id of ["alice", "bob"]) {
			await getPool().query(
				'INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $2, $1, $1)',
				[id, `${id}@example.test`],
			);
		}
	});

	it("creates exactly one resume when the same request arrives concurrently", async () => {
		const requestId = randomUUID();
		const results = await Promise.all(
			Array.from({ length: 6 }, () => client("alice").importJsonResume({ requestId, resume: jsonResume })),
		);

		expect(new Set(results.map((result) => result.id)).size).toBe(1);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		expect(await count("resume WHERE user_id = $1", ["alice"])).toBe(1);
		expect(await count("resume_import_request WHERE user_id = $1", ["alice"])).toBe(1);
		expect(await count("resume_version WHERE resume_id = $1", [results[0]?.id])).toBe(1);
	});

	it("returns the same resume after the owner renamed it and changed its slug, without overwriting edits", async () => {
		const requestId = randomUUID();
		const first = await client("alice").importJsonResume({ requestId, name: "Draft", resume: jsonResume });
		await getPool().query(
			`UPDATE resume SET name = 'Renamed', slug = 'my-own-slug', data = jsonb_set(data, '{basics,headline}', '"Edited"') WHERE id = $1`,
			[first.id],
		);

		const retry = await client("alice").importJsonResume({ requestId, name: "Draft", resume: jsonResume });

		expect(retry).toEqual({ id: first.id, created: false });
		expect(await count("resume WHERE user_id = $1", ["alice"])).toBe(1);
		const { rows } = await getPool().query(
			"SELECT name, data->'basics'->>'headline' AS headline FROM resume WHERE id = $1",
			[first.id],
		);
		expect(rows[0]).toEqual({ name: "Renamed", headline: "Edited" });
	});

	it("answers a retry for a deleted resume with 410 and keeps it deleted", async () => {
		const requestId = randomUUID();
		const first = await client("alice").importJsonResume({ requestId, resume: jsonResume });
		await getPool().query("DELETE FROM resume WHERE id = $1", [first.id]);

		const error = await client("alice")
			.importJsonResume({ requestId, resume: jsonResume })
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "IMPORT_TARGET_DELETED", status: 410 });
		expect(await count("resume WHERE user_id = $1", ["alice"])).toBe(0);
		expect(await count("resume_import_request WHERE user_id = $1 AND resume_id IS NULL", ["alice"])).toBe(1);
	});

	it("keeps the same requestId separate per owner", async () => {
		const requestId = randomUUID();
		const alice = await client("alice").importJsonResume({ requestId, resume: jsonResume });
		const bob = await client("bob").importJsonResume({ requestId, resume: jsonResume });

		expect(bob.created).toBe(true);
		expect(bob.id).not.toBe(alice.id);
		expect((await client("bob").importJsonResume({ requestId, resume: jsonResume })).id).toBe(bob.id);
		const { rows } = await getPool().query("SELECT user_id FROM resume WHERE id = $1", [bob.id]);
		expect(rows[0].user_id).toBe("bob");
	});

	it("refuses to reuse a requestId for a different document", async () => {
		const requestId = randomUUID();
		await client("alice").importJsonResume({ requestId, resume: jsonResume });

		const error = await client("alice")
			.importJsonResume({ requestId, resume: { ...jsonResume, basics: { name: "Someone Else" } } })
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "IMPORT_REQUEST_MISMATCH", status: 409 });
		expect(await count("resume WHERE user_id = $1", ["alice"])).toBe(1);
	});

	it("carries over imports made before the table existed, matched by their gb- slug", async () => {
		const requestId = randomUUID();
		await getPool().query(
			"INSERT INTO resume (id, name, slug, user_id, data) VALUES ('legacy-resume', 'Legacy', $1, 'alice', '{}')",
			[`gb-${requestId}`],
		);
		const migration = await readFile(
			`${migrationsFolder}/20261026094545_gradbridge_import_request/migration.sql`,
			"utf8",
		);
		const backfill = migration.split("--> statement-breakpoint").at(-1) as string;
		await getPool().query(backfill);

		const retry = await client("alice").importJsonResume({ requestId, resume: jsonResume });

		expect(retry).toEqual({ id: "legacy-resume", created: false });
		expect(await count("resume WHERE user_id = $1", ["alice"])).toBe(1);
	});
});
