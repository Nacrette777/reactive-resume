import type { ResumeData } from "@reactive-resume/schema/resume/data";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRouterClient } from "@orpc/server";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	getById: vi.fn(),
	findImportRequest: vi.fn(),
	createImportedResume: vi.fn(),
	update: vi.fn(),
	snapshot: vi.fn(),
}));

vi.mock("../../context", async () => {
	const { os } = await vi.importActual<typeof import("@orpc/server")>("@orpc/server");
	return {
		protectedProcedure: os.$context<{
			locale: "en-US";
			reqHeaders: Headers;
			user: { id: string };
		}>(),
	};
});

vi.mock("./service", () => ({
	resumeService: {
		create: mocks.create,
		getById: mocks.getById,
		importRequests: { find: mocks.findImportRequest, createResume: mocks.createImportedResume },
		update: mocks.update,
		versions: { snapshot: mocks.snapshot },
	},
}));

const { crudRouter } = await import("./crud");

const rendererUnsafeData = (): ResumeData =>
	({
		...structuredClone(defaultResumeData),
		customSections: [
			{
				id: "custom-experience",
				type: "experience",
				title: "Experience",
				icon: "",
				columns: 1,
				hidden: false,
				keepTogether: false,
				startOnNewPage: false,
				items: [{ id: "summary-item", hidden: false, content: "<p>Missing company</p>" }],
			},
		],
	}) as unknown as ResumeData;

describe("resume duplicate route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.create.mockResolvedValue("copy-id");
	});

	it("rejects invalid stored source data before calling the shared create service", async () => {
		mocks.getById.mockResolvedValue({
			id: "resume-id",
			name: "Resume",
			slug: "resume",
			tags: [],
			data: rendererUnsafeData(),
		});
		const client = createRouterClient(crudRouter, {
			context: { locale: "en-US", reqHeaders: new Headers(), user: { id: "user-id" } } as never,
		});

		const error = await client
			.duplicate({ id: "resume-id", name: "Copy", slug: "copy", tags: [] })
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR", status: 500 });
		expect(error).toHaveProperty("cause.issues.0.path", ["customSections", 0, "items", 0, "company"]);
		expect(mocks.create).not.toHaveBeenCalled();
	});
});

describe("resume write route validation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.create.mockResolvedValue("resume-id");
		mocks.update.mockResolvedValue({});
		mocks.snapshot.mockResolvedValue(undefined);
	});

	it.each(["import", "update"] as const)("rejects invalid %s input before calling persistence", async (operation) => {
		const client = createRouterClient(crudRouter, {
			context: { locale: "en-US", reqHeaders: new Headers(), user: { id: "user-id" } } as never,
		});
		const data = structuredClone(defaultResumeData);
		data.metadata.page.marginX = 500;

		const result = operation === "import" ? client.import({ data }) : client.update({ id: "resume-id", data });
		const error = await result.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "BAD_REQUEST", status: 400 });
		expect(error).toHaveProperty("cause.issues.0.path", ["data", "metadata", "page", "marginX"]);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.snapshot).not.toHaveBeenCalled();
	});
});

describe("resume sharing update route", () => {
	it.each([false, true])(
		"passes showDownloadButtons=%s through the authenticated update procedure",
		async (showDownloadButtons) => {
			const row = {
				id: "resume-id",
				name: "Resume",
				slug: "resume",
				tags: [],
				data: defaultResumeData,
				isPublic: true,
				isLocked: false,
				hasPassword: false,
				showDownloadButtons,
				updatedAt: new Date(),
			};
			mocks.update.mockResolvedValue(row);
			const client = createRouterClient(crudRouter, {
				context: { locale: "en-US", reqHeaders: new Headers(), user: { id: "user-id" } } as never,
			});
			const result = await client.update({ id: "resume-id", showDownloadButtons });
			expect(mocks.update).toHaveBeenCalledWith({ id: "resume-id", userId: "user-id", showDownloadButtons });
			expect(result.showDownloadButtons).toBe(showDownloadButtons);
		},
	);
});

describe("resume importJsonResume route", () => {
	const requestId = "0b8e3c1a-5f2d-4e7b-9a6c-1d2e3f4a5b6c";
	const jsonResume = {
		basics: { name: "Test Student", email: "student@example.test", label: "Data Analyst" },
		education: [{ institution: "Test University", studyType: "Bachelor", area: "Computer Science" }],
		skills: [{ name: "SQL", level: "Advanced" }],
	};

	const client = (userId = "user-id") =>
		createRouterClient(crudRouter, {
			context: { locale: "en-US", reqHeaders: new Headers(), user: { id: userId } } as never,
		});

	// The hash the route stores for jsonResume, captured from a first import.
	const firstImportHash = async () => {
		await client().importJsonResume({ requestId, resume: jsonResume });
		const hash = mocks.createImportedResume.mock.calls[0]?.[0].payloadSha256 as string;
		vi.clearAllMocks();
		return hash;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findImportRequest.mockResolvedValue(null);
		mocks.createImportedResume.mockResolvedValue("new-id");
	});

	it("converts the JSON Resume and records the import under the owner and requestId", async () => {
		const result = await client().importJsonResume({ requestId, name: "GradBridge draft", resume: jsonResume });

		expect(result).toEqual({ id: "new-id", created: true });
		expect(mocks.findImportRequest).toHaveBeenCalledWith({ userId: "user-id", requestId });
		expect(mocks.createImportedResume).toHaveBeenCalledTimes(1);
		const created = mocks.createImportedResume.mock.calls[0]?.[0];
		expect(created).toMatchObject({
			userId: "user-id",
			requestId,
			name: "GradBridge draft",
			slug: `gb-${requestId}`,
			locale: "en-US",
			payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(created.data.basics.name).toBe("Test Student");
		expect(created.data.basics.headline).toBe("Data Analyst");
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("hashes the document independently of key order", async () => {
		const reordered = {
			skills: [{ level: "Advanced", name: "SQL" }],
			education: [{ area: "Computer Science", studyType: "Bachelor", institution: "Test University" }],
			basics: { label: "Data Analyst", email: "student@example.test", name: "Test Student" },
		};
		await client().importJsonResume({ requestId, resume: jsonResume });
		await client().importJsonResume({ requestId: "1b8e3c1a-5f2d-4e7b-9a6c-1d2e3f4a5b6c", resume: reordered });

		const [first, second] = mocks.createImportedResume.mock.calls.map((call) => call[0].payloadSha256);
		expect(first).toBe(second);
	});

	it("returns the recorded resume on a retry, whatever its slug or name now is", async () => {
		const payloadSha256 = await firstImportHash();
		mocks.findImportRequest.mockResolvedValue({ resumeId: "existing-id", payloadSha256 });

		const result = await client().importJsonResume({ requestId, resume: jsonResume });

		expect(result).toEqual({ id: "existing-id", created: false });
		expect(mocks.createImportedResume).not.toHaveBeenCalled();
	});

	it("matches a mixed-case requestId to the same record", async () => {
		await client().importJsonResume({ requestId: requestId.toUpperCase(), resume: jsonResume });

		expect(mocks.findImportRequest).toHaveBeenCalledWith({ userId: "user-id", requestId });
	});

	it("accepts a retry of a backfilled import whose document hash is unknown", async () => {
		mocks.findImportRequest.mockResolvedValue({ resumeId: "legacy-id", payloadSha256: null });

		const result = await client().importJsonResume({ requestId, resume: jsonResume });

		expect(result).toEqual({ id: "legacy-id", created: false });
	});

	it("refuses a retry whose resume was deleted instead of importing again", async () => {
		const payloadSha256 = await firstImportHash();
		mocks.findImportRequest.mockResolvedValue({ resumeId: null, payloadSha256 });

		const error = await client()
			.importJsonResume({ requestId, resume: jsonResume })
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "IMPORT_TARGET_DELETED", status: 410 });
		expect(mocks.createImportedResume).not.toHaveBeenCalled();
	});

	it("refuses to reuse a requestId for a different document", async () => {
		mocks.findImportRequest.mockResolvedValue({ resumeId: "existing-id", payloadSha256: "0".repeat(64) });

		const error = await client()
			.importJsonResume({ requestId, resume: jsonResume })
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "IMPORT_REQUEST_MISMATCH", status: 409 });
		expect(mocks.createImportedResume).not.toHaveBeenCalled();
	});

	it("returns the winner's resume when a concurrent call with the same requestId committed first", async () => {
		const payloadSha256 = await firstImportHash();
		mocks.createImportedResume.mockResolvedValue(null);
		mocks.findImportRequest.mockResolvedValueOnce(null).mockResolvedValueOnce({ resumeId: "winner-id", payloadSha256 });

		const result = await client().importJsonResume({ requestId, resume: jsonResume });

		expect(result).toEqual({ id: "winner-id", created: false });
	});

	it("reports a slug taken by an unrelated resume instead of returning someone else's resume", async () => {
		mocks.createImportedResume.mockResolvedValue(null);

		const error = await client()
			.importJsonResume({ requestId, resume: jsonResume })
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "IMPORT_SLUG_TAKEN", status: 409 });
	});

	it("looks requests up per owner, so the same requestId never resolves to another user's resume", async () => {
		await client("other-user").importJsonResume({ requestId, resume: jsonResume });

		expect(mocks.findImportRequest).toHaveBeenCalledWith({ userId: "other-user", requestId });
		expect(mocks.createImportedResume.mock.calls[0]?.[0]).toMatchObject({ userId: "other-user" });
	});

	it("rejects a document that is not a valid JSON Resume without creating anything", async () => {
		const error = await client()
			.importJsonResume({ requestId, resume: { basics: "not an object" } })
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "INVALID_JSON_RESUME", status: 400 });
		expect(mocks.createImportedResume).not.toHaveBeenCalled();
	});

	it("requires the requestId to be a UUID", async () => {
		const error = await client()
			.importJsonResume({ requestId: "not-a-uuid", resume: jsonResume })
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.findImportRequest).not.toHaveBeenCalled();
		expect(mocks.createImportedResume).not.toHaveBeenCalled();
	});
});
