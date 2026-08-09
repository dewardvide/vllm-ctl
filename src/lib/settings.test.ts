import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Settings are read through a module-level cache. In Next's production build
 * this module can be instantiated more than once, so the cache has to notice a
 * write made by *another* instance — otherwise a changed bind address reaches
 * the settings route and nothing else.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vllm-admin-settings-"));
  process.env.VLLM_ADMIN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.VLLM_ADMIN_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A second module instance, exactly as a separate server bundle would get. */
async function freshInstance() {
  vi.resetModules();
  return import("./settings");
}

describe("getSettings", () => {
  it("writes defaults when no file exists yet", async () => {
    const { getSettings } = await import("./settings");
    expect(getSettings().serveHost).toBe("127.0.0.1");
    expect(fs.existsSync(path.join(dir, "settings.json"))).toBe(true);
  });

  it("caches repeated reads", async () => {
    const { getSettings } = await import("./settings");
    expect(getSettings()).toBe(getSettings());
  });

  it("picks up a write made by another module instance", async () => {
    const a = await import("./settings");
    expect(a.getSettings().serveHost).toBe("127.0.0.1");

    // A different instance saves a new bind address, as the settings route does.
    const b = await freshInstance();
    b.saveSettings({ serveHost: "0.0.0.0" });

    // The first instance never had `invalidateSettings()` called on it, and
    // must still see the new value — this is what the supervisor depends on.
    expect(a.getSettings().serveHost).toBe("0.0.0.0");
  });

  it("picks up an edit made by hand to the file", async () => {
    const { getSettings } = await import("./settings");
    getSettings();

    const file = path.join(dir, "settings.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...raw, serveHost: "192.168.1.5" }));

    expect(getSettings().serveHost).toBe("192.168.1.5");
  });
});
