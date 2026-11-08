import Database from "better-sqlite3";
import fs from "node:fs";
import { expect, it } from "vitest";
import { migrate } from "./db";
import { rowToProfile } from "@/app/api/deployments/route";
it("migrates existing v1 profiles and run history without changing data", () => {
  const db = new Database(":memory:");
  // Replay the shipped migration verbatim, then upgrade an actual populated DB.
  const source = fs.readFileSync(new URL("./db.ts", import.meta.url), "utf8");
  const original = source.match(/\/\* 1 \*\/ `([\s\S]*?)`,/)![1];
  db.exec(original);
  db.pragma("user_version = 1");
  db.exec(`INSERT INTO deployments (id,name,model,flags,created_at,updated_at) VALUES (1,'old','org/model','{"max-model-len":8192}',1,2);
    INSERT INTO deployment_runs (deployment_id,port,argv,status,started_at) VALUES (1,8000,'["vllm","serve","org/model"]','stopped',1);`);
  migrate(db);
  const profile = rowToProfile(db.prepare("SELECT * FROM deployments").get() as Record<string, unknown>);
  expect(profile.backend).toBe("vllm"); expect(profile.modelSource).toBeNull();
  expect(profile.flags).toEqual({ "max-model-len": 8192 });
  const run = db.prepare("SELECT * FROM deployment_runs").get() as Record<string, unknown>;
  expect(run.backend).toBe("vllm"); expect(JSON.parse(run.argv as string)).toEqual(["vllm", "serve", "org/model"]);
  migrate(db); // Repeated startup is idempotent.
  expect(db.pragma("user_version", { simple: true })).toBe(2);
  db.close();
});
