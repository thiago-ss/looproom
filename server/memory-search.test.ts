import test from "node:test";
import assert from "node:assert/strict";
import { MemorySearchSession, type MemorySearchState } from "../src/lib/memory-search.ts";

type Page = { id: string; projectId: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("Memory ignores late results and failures from another project", async () => {
  const a = { id: "project-a", page: { id: "a-page", projectId: "project-a" } };
  const b = { id: "project-b", page: { id: "b-page", projectId: "project-b" } };
  const session = new MemorySearchSession<Page>(a.id);
  const shown: MemorySearchState<Page>[] = [];
  const update = (state: MemorySearchState<Page>) => shown.push(state);
  const lateA = deferred<Page[]>();
  const pendingA = session.search(a.id, "outcome", () => lateA.promise, update);
  session.switchProject(b.id);
  const responseB = deferred<Page[]>();
  const pendingB = session.search(b.id, "outcome", () => responseB.promise, update);
  lateA.resolve([a.page]);
  await pendingA;
  assert.deepEqual(session.state, { projectId: b.id, status: "pending" });
  responseB.resolve([b.page]);
  await pendingB;
  assert.deepEqual(session.state, { projectId: b.id, status: "success", results: [b.page] });
  assert.equal(shown.some(state => state.status === "success" && state.projectId === a.id), false);

  const lateFailure = deferred<Page[]>();
  const pendingFailure = session.search(a.id, "missing", () => lateFailure.promise, update);
  session.switchProject(b.id);
  const empty = session.search(b.id, "missing", async () => [], update);
  lateFailure.reject(new Error("A search failed"));
  await Promise.all([pendingFailure, empty]);
  assert.deepEqual(session.state, { projectId: b.id, status: "success", results: [] });
  assert.equal(shown.some(state => state.status === "error" && state.projectId === a.id), false);
});

test("Memory distinguishes failure, retry, empty results and superseded responses", async () => {
  const session = new MemorySearchSession<Page>("project-b");
  const shown: MemorySearchState<Page>[] = [];
  const update = (state: MemorySearchState<Page>) => shown.push(state);
  const failure = await session.search("project-b", "term", async () => {
    throw new Error("Coordinator unavailable");
  }, update);
  assert.equal(failure, undefined);
  assert.deepEqual(session.state, {
    projectId: "project-b", status: "error", message: "Coordinator unavailable",
  });
  const old = deferred<Page[]>();
  const oldRequest = session.search("project-b", "term", () => old.promise, update);
  const retry = session.search("project-b", "term", async () => [], update);
  old.resolve([{ id: "stale", projectId: "project-b" }]);
  await Promise.all([oldRequest, retry]);
  assert.deepEqual(session.state, { projectId: "project-b", status: "success", results: [] });
  assert.deepEqual(shown.map(state => state.status), ["pending", "error", "pending", "pending", "success"]);
  assert.deepEqual(session.clear(), { projectId: "project-b", status: "idle" });
});
