// gsd-pi — worker registry tests: host-native background task rows (#2533).

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
	formatWorkerElapsed,
	getActiveWorkers,
	getHostTaskBatchStats,
	getWorkerBatches,
	registerHostTaskWorker,
	registerWorker,
	releaseHostTaskBatch,
	resetWorkerRegistry,
	updateWorker,
} from "../worker-registry.js";

describe("worker registry — host task workers (#2533)", () => {
	afterEach(() => {
		resetWorkerRegistry();
	});

	it("registers a native task as a running worker row", () => {
		const id = registerHostTaskWorker({
			batchId: "cc-test",
			agent: "local_agent",
			task: "Agent: rewrite docs",
		});

		const workers = getActiveWorkers();
		assert.equal(workers.length, 1);
		assert.equal(workers[0].id, id);
		assert.equal(workers[0].agent, "local_agent");
		assert.equal(workers[0].task, "Agent: rewrite docs");
		assert.equal(workers[0].status, "running");
		assert.equal(workers[0].batchId, "cc-test");
		assert.equal(workers[0].index, 0);
		assert.equal(workers[0].batchSize, 1);
	});

	it("grows the whole batch as later native tasks register", () => {
		registerHostTaskWorker({ batchId: "cc-test", agent: "local_agent", task: "one" });
		registerHostTaskWorker({ batchId: "cc-test", agent: "local_bash", task: "two" });
		registerHostTaskWorker({ batchId: "cc-test", agent: "local_agent", task: "three" });

		const workers = getActiveWorkers();
		assert.equal(workers.length, 3);
		assert.deepEqual(
			workers.map((worker) => worker.index),
			[0, 1, 2],
		);
		for (const worker of workers) {
			assert.equal(worker.batchSize, 3, "every row must track the running batch total");
		}
		assert.equal(getWorkerBatches().get("cc-test")?.length, 3);
	});

	it("keeps native task batches separate from GSD subagent batches", () => {
		registerWorker("explore", "gsd subagent", 0, 2, "batch-gsd");
		registerHostTaskWorker({ batchId: "cc-test", agent: "local_agent", task: "native" });

		assert.equal(getWorkerBatches().get("batch-gsd")?.length, 1);
		assert.equal(getWorkerBatches().get("cc-test")?.length, 1);
		const gsdRow = getWorkerBatches().get("batch-gsd")?.[0];
		assert.equal(gsdRow?.batchSize, 2, "registerWorker batches stay untouched");
	});

	it("keeps batch accounting correct after earlier rows age out", (t) => {
		const clock = t.mock.timers;
		clock.enable({ apis: ["setTimeout"] });
		t.after(() => clock.reset());

		const first = registerHostTaskWorker({ batchId: "cc-exp", agent: "local_agent", task: "one" });
		registerHostTaskWorker({ batchId: "cc-exp", agent: "local_agent", task: "two" });
		updateWorker(first, "completed");
		clock.tick(5001); // the completed row ages out of the registry

		const thirdId = registerHostTaskWorker({ batchId: "cc-exp", agent: "local_bash", task: "three" });
		const rows = getActiveWorkers().filter((worker) => worker.batchId === "cc-exp");
		assert.equal(rows.length, 2, "the aged-out row must be gone");
		const survivor = rows.find((worker) => worker.task === "two");
		assert.equal(survivor?.batchSize, 3, "surviving rows must keep the cumulative total");
		const third = rows.find((worker) => worker.id === thirdId);
		assert.equal(third?.index, 2, "the new row must continue the cumulative ordering");
		assert.equal(third?.batchSize, 3);
		assert.deepEqual(
			getHostTaskBatchStats("cc-exp"),
			{ total: 3, done: 1, failed: 0 },
			"batch stats must survive row expiry for the dashboard header",
		);
	});

	it("releaseHostTaskBatch resets accounting for the batch", () => {
		registerHostTaskWorker({ batchId: "cc-rel", agent: "local_agent", task: "one" });
		releaseHostTaskBatch("cc-rel");
		const freshId = registerHostTaskWorker({ batchId: "cc-rel", agent: "local_agent", task: "two" });
		const fresh = getActiveWorkers().find((worker) => worker.id === freshId);
		assert.equal(fresh?.index, 0);
		assert.equal(fresh?.batchSize, 1);
	});

	it("updateWorker completes a native task row and elapses it honestly", () => {
		const id = registerHostTaskWorker({ batchId: "cc-test", agent: "local_agent", task: "one" });
		updateWorker(id, "completed");

		const row = getActiveWorkers().find((worker) => worker.id === id);
		assert.equal(row?.status, "completed");
		assert.ok(row?.completedAt);
		assert.doesNotMatch(formatWorkerElapsed(row!, "completed"), /^running/);
	});

	it("marks stopped native tasks as failed — they did not complete", () => {
		const id = registerHostTaskWorker({ batchId: "cc-test", agent: "local_agent", task: "one" });
		// The adapter maps notification status stopped → registry "failed".
		updateWorker(id, "failed");

		const row = getActiveWorkers().find((worker) => worker.id === id);
		assert.equal(row?.status, "failed");
		assert.match(formatWorkerElapsed(row!, "failed"), /^failed after/);
	});
});
