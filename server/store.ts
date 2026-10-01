import { escalationMode } from "../src/lib/autonomy.ts";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type RecordData = { id: string; [key: string]: any };
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS record_kind ON records(kind);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, project_id UNINDEXED, title, content);`);
  }
  all(kind: string, projectId?: string): RecordData[] {
    const rows = this.db
      .prepare("SELECT data FROM records WHERE kind=? ORDER BY rowid")
      .all(kind) as { data: string }[];
    return rows
      .map((row) => JSON.parse(row.data))
      .filter((row) => !projectId || row.projectId === projectId);
  }
  get(id: string): RecordData {
    const row = this.db
      .prepare("SELECT data FROM records WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new Error("Record not found");
    return JSON.parse(row.data);
  }
  put(
    kind: string,
    data: Record<string, any>,
    id: string = randomUUID(),
  ): RecordData {
    const record = { ...data, id };
    this.db
      .prepare(
        "INSERT INTO records(id,kind,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=records.version+1",
      )
      .run(id, kind, JSON.stringify(record));
    return record;
  }
  patch(id: string, changes: Record<string, any>): RecordData {
    const record = { ...this.get(id), ...changes, id };
    this.db
      .prepare("UPDATE records SET data=?,version=version+1 WHERE id=?")
      .run(JSON.stringify(record), id);
    return record;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  event(type: string, data: Record<string, any>, projectId?: string) {
    this.db
      .prepare(
        "INSERT INTO events(project_id,type,data,created_at) VALUES(?,?,?,?)",
      )
      .run(
        projectId ?? null,
        type,
        JSON.stringify(data),
        new Date().toISOString(),
      );
  }
  events(projectId?: string) {
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE (? IS NULL OR project_id=?) ORDER BY seq DESC LIMIT 80",
      )
      .all(projectId ?? null, projectId ?? null) as any[];
    return rows.map((row) => ({ ...row, data: JSON.parse(row.data) }));
  }
  memory(projectId: string, title: string, content: string, sources: string[]) {
    const record = this.put("memory", {
      projectId,
      title,
      content,
      sources,
      createdAt: new Date().toISOString(),
    });
    this.db
      .prepare(
        "INSERT INTO memory_search(id,project_id,title,content) VALUES(?,?,?,?)",
      )
      .run(record.id, projectId, title, content);
    return record;
  }
  search(projectId: string, query: string) {
    const terms = query
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.slice(0, 12)
      .map((term) => '"' + term.replaceAll('"', '""') + '"')
      .join(" OR ");
    if (!terms) return this.all("memory", projectId);
    const rows = this.db
      .prepare(
        "SELECT id FROM memory_search WHERE memory_search MATCH ? AND project_id=? ORDER BY rank LIMIT 20",
      )
      .all(terms, projectId) as { id: string }[];
    return rows.map((row) => this.get(row.id));
  }
  recordEscalation(gate: RecordData) {
    return this.put(
      "message",
      {
        projectId: gate.projectId,
        taskId: gate.taskId,
        gateId: gate.id,
        kind: "escalation",
        role: gate.authorRole ?? "coordinator",
        title: gate.title,
        text: gate.detail,
        createdAt: gate.createdAt,
      },
      "escalation:" + gate.id,
    );
  }
  recordGateResponse(
    gate: RecordData,
    answer: string,
    actor: string,
    createdAt: string,
    runId?: string,
    kind = "escalation_response",
  ) {
    return this.put(
      "message",
      {
        projectId: gate.projectId,
        taskId: gate.taskId,
        gateId: gate.id,
        kind,
        role: actor,
        text: answer,
        runId,
        createdAt,
      },
      "response:" +
        gate.id +
        ":" +
        actor +
        (actor === "judge" && runId ? ":" + runId : ""),
    );
  }
  syncConversation() {
    this.transaction(() => {
      for (const gate of this.all("gate")) {
        if (!gate.authorRole) {
          const origin = this.all("run", gate.projectId).findLast((run) => {
            if (run.taskId !== gate.taskId || !run.output) return false;
            try {
              const output = JSON.parse(run.output);
              return (
                output.humanQuestion === gate.detail ||
                output.gate === gate.detail ||
                (run.role === "review" && output.summary === gate.detail)
              );
            } catch {
              return false;
            }
          });
          if (origin)
            Object.assign(
              gate,
              this.patch(gate.id, {
                authorRole: origin.role,
                originRunId: origin.id,
              }),
            );
        }
        this.recordEscalation(gate);
        if (!gate.answer || !gate.resolvedAt) continue;
        const actor = gate.resolvedBy ?? "human";
        const legacy = this.all("message", gate.projectId).find(
          (message) =>
            !message.gateId &&
            message.role === actor &&
            message.text === gate.answer &&
            Math.abs(
              Date.parse(message.createdAt) - Date.parse(gate.resolvedAt),
            ) < 3000,
        );
        if (legacy)
          this.patch(legacy.id, {
            gateId: gate.id,
            taskId: gate.taskId,
            kind: "escalation_response",
          });
        else if (
          !this.all("message", gate.projectId).some(
            (message) =>
              message.gateId === gate.id &&
              message.kind === "escalation_response" &&
              message.role === actor,
          )
        )
          this.recordGateResponse(gate, gate.answer, actor, gate.resolvedAt);
      }
    });
  }
  conversation(projectId?: string) {
    return this.all("message", projectId).sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        Number(b.kind === "escalation") - Number(a.kind === "escalation"),
    );
  }
  hasOpenInterruption(projectId: string) {
    return this.all("gate", projectId).some((gate) =>
      gate.status === "open" && gate.type === "interrupted");
  }
  recover() {
    this.transaction(() => {
      const interrupted = this.all("run").filter(
        (run) => run.status === "running",
      );
      const recovery = interrupted
        .filter((run) => run.role !== "judge")
        .map((run) => ({
          projectId: run.projectId,
          taskId: run.taskId,
        }));
      const openGates = this.all("gate").filter((gate) => gate.status === "open");
      // A YOLO judgment may submit a reply or start worktree recovery. Its
      // interrupted run needs a human gate even when the task was blocked.
      for (const run of interrupted.filter((run) => run.role === "judge" && run.taskId)) {
        if (escalationMode(this.get(run.projectId)) !== "yolo") continue;
        if (openGates.some((gate) =>
          gate.projectId === run.projectId && gate.taskId === run.taskId &&
          gate.type !== "pr" && gate.judgeStatus === "running"))
          recovery.push({ projectId: run.projectId, taskId: run.taskId });
      }
      const activeRecoveryGates = openGates.filter(
        (gate) => gate.taskId &&
          ["running", "verifying"].includes(gate.judgeRecoveryStatus),
      );
      for (const gate of activeRecoveryGates)
        recovery.push({ projectId: gate.projectId, taskId: gate.taskId });
      for (const run of interrupted)
        this.patch(run.id, {
          status: "interrupted",
          error: "Coordinator restarted before completion.",
          finishedAt: new Date().toISOString(),
        });
      for (const gate of this.all("gate").filter(
        (gate) => gate.status === "open" &&
          (gate.judgeStatus === "running" || activeRecoveryGates.some((active) => active.id === gate.id)),
      ))
        this.patch(gate.id, {
          judgeStatus:
            gate.judgeStatus === "running"
              ? escalationMode(this.get(gate.projectId)) === "yolo" &&
                  (gate.judgeFailures ?? 0) < 3
                ? "pending"
                : "failed"
              : gate.judgeStatus,
          judgeError: gate.judgeStatus === "running"
            ? "Coordinator restarted during judgment."
            : gate.judgeError,
          judgeRecoveryStatus:
            ["running", "verifying"].includes(gate.judgeRecoveryStatus)
              ? "interrupted"
              : gate.judgeRecoveryStatus,
        });
      for (const task of this.all("task").filter((task) =>
        ["running", "verifying"].includes(task.status),
      ))
        recovery.push({ projectId: task.projectId, taskId: task.id });
      const seen = new Set<string>();
      for (const item of recovery) {
        const key = item.projectId + ":" + (item.taskId ?? "planning");
        if (seen.has(key)) continue;
        seen.add(key);
        if (item.taskId) this.patch(item.taskId, { status: "blocked" });
        this.patch(item.projectId, { status: "paused" });
        if (this.all("gate", item.projectId).some(
          (gate) => gate.status === "open" && gate.type === "interrupted" && gate.taskId === item.taskId,
        ))
          continue;
        this.put("gate", {
          ...item,
          type: "interrupted",
          status: "open",
          title: "Resume interrupted work",
          detail:
            "Review preserved work before retrying. Publication or verification may have been interrupted; reconcile any existing PR before retrying.",
          createdAt: new Date().toISOString(),
        });
      }
    });
  }
  close() {
    this.db.close();
  }
}
