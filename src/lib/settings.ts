import "server-only";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

import { PATHS, defaultHfCacheDir, hfTokenFile } from "./paths";

/**
 * User-editable settings, persisted as JSON.
 *
 * Kept in a plain file rather than SQLite because these values must be
 * readable and repairable by hand when a bad path stops the app from booting.
 */

export const SettingsSchema = z.object({
  /**
   * Directory containing the `vllm` executable — i.e. a virtualenv's `bin`.
   * Auto-detected on first run; see `detectVllmBinDir`.
   */
  vllmBinDir: z.string().nullable(),
  /** Directory containing the `guidellm` executable. */
  guidellmBinDir: z.string().nullable(),
  /**
   * CUDA toolkit root passed to deployments as `CUDA_HOME`. Auto-detected;
   * vLLM cannot compile kernels without it.
   */
  cudaHome: z.string().nullable(),
  /** Hugging Face hub cache root. */
  hfCacheDir: z.string(),
  /** Token for gated/private repos. Falls back to the `hf` CLI's stored token. */
  hfToken: z.string().nullable(),
  /** Address vLLM servers bind to. Loopback by default — this app has no auth. */
  serveHost: z.string(),
  /** First port handed out by the allocator; it scans upward from here. */
  portRangeStart: z.number().int().min(1024).max(65535),
  portRangeEnd: z.number().int().min(1024).max(65535),
  /** Telemetry sample period. 1000 ms is comfortable; nvidia-smi costs ~24 ms. */
  sampleIntervalMs: z.number().int().min(250).max(10000),
  /** How long full-resolution telemetry is kept before downsampling. */
  telemetryRetentionHours: z.number().int().min(1).max(24 * 30),
  /** Fraction of total VRAM that must remain free after a projected start. */
  vramSafetyMargin: z.number().min(0).max(0.5),
});

export type Settings = z.infer<typeof SettingsSchema>;

function defaults(): Settings {
  return {
    vllmBinDir: detectVllmBinDir(),
    guidellmBinDir: detectGuidellmBinDir(),
    cudaHome: detectCudaHome(detectVllmBinDir()),
    hfCacheDir: defaultHfCacheDir(),
    hfToken: null,
    serveHost: "127.0.0.1",
    portRangeStart: 8000,
    portRangeEnd: 8099,
    sampleIntervalMs: 1000,
    telemetryRetentionHours: 72,
    vramSafetyMargin: 0.03,
  };
}

/* -------------------------------------------------------------------------- */
/* environment detection                                                       */
/* -------------------------------------------------------------------------- */

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Candidate virtualenv `bin` directories, most specific first. */
function candidateBinDirs(): string[] {
  const home = os.homedir();
  const out: string[] = [];
  if (process.env.VLLM_BIN_DIR) out.push(process.env.VLLM_BIN_DIR);

  // Any `.venv/bin` sitting directly under a project folder in $HOME. This is
  // how uv lays out project environments, which is how vLLM is installed here.
  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      out.push(path.join(home, entry.name, ".venv", "bin"));
    }
  } catch {
    /* unreadable home is not fatal — fall through to PATH */
  }

  out.push(path.join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin");
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) out.push(dir);
  }
  return out;
}

function detectBinDirContaining(exe: string): string | null {
  for (const dir of candidateBinDirs()) {
    if (isExecutable(path.join(dir, exe))) return dir;
  }
  return null;
}

export function detectVllmBinDir(): string | null {
  return detectBinDirContaining("vllm");
}

/**
 * Finds a CUDA toolkit root (a directory with `bin/nvcc`).
 *
 * vLLM compiles kernels during engine init and looks for `nvcc` under
 * `$CUDA_HOME`, falling back to `/usr/local/cuda`. On a machine with only the
 * NVIDIA *driver* installed that fails — but PyTorch's own wheels ship a
 * complete toolkit inside site-packages (`nvidia/cu13/`), which vLLM never
 * looks at. Pointing `CUDA_HOME` there makes deployments work with no system
 * package and no sudo, and it matches the CUDA version torch was built for
 * rather than whatever the distro happens to package.
 */
export function detectCudaHome(vllmBinDir: string | null): string | null {
  const candidates: string[] = [];

  if (process.env.CUDA_HOME) candidates.push(process.env.CUDA_HOME);
  if (process.env.CUDA_PATH) candidates.push(process.env.CUDA_PATH);

  // Toolkits bundled in the vLLM environment's site-packages.
  if (vllmBinDir) {
    const venv = path.dirname(vllmBinDir);
    for (const libDir of [path.join(venv, "lib"), path.join(venv, "lib64")]) {
      let pythons: string[] = [];
      try {
        pythons = fs.readdirSync(libDir).filter((d) => d.startsWith("python"));
      } catch {
        continue;
      }
      for (const py of pythons) {
        const nvidia = path.join(libDir, py, "site-packages", "nvidia");
        let entries: string[] = [];
        try {
          entries = fs.readdirSync(nvidia);
        } catch {
          continue;
        }
        // Newer wheels use `cu13/`; older ones split it into `cuda_nvcc/`.
        for (const e of entries.sort().reverse()) {
          if (/^cu\d+$/.test(e) || e === "cuda_nvcc") {
            candidates.push(path.join(nvidia, e));
          }
        }
      }
    }
  }

  candidates.push("/usr/local/cuda", "/usr/lib/cuda", "/opt/cuda");

  for (const c of candidates) {
    if (isExecutable(path.join(c, "bin", "nvcc"))) return c;
  }
  return null;
}

export function detectGuidellmBinDir(): string | null {
  return detectBinDirContaining("guidellm");
}

/** Absolute path to an executable in a configured bin dir, if it exists. */
export function resolveExe(binDir: string | null, exe: string): string | null {
  if (!binDir) return null;
  const p = path.join(binDir, exe);
  return isExecutable(p) ? p : null;
}

/**
 * The `hf` CLI, preferred from the vLLM environment (newer, xet-enabled) and
 * falling back to whatever is on PATH.
 */
export function resolveHfCli(s: Settings): string | null {
  return resolveExe(s.vllmBinDir, "hf") ?? detectHfOnPath();
}

function detectHfOnPath(): string | null {
  const dir = detectBinDirContaining("hf");
  return dir ? path.join(dir, "hf") : null;
}

/** The effective HF token: explicit setting, then env, then the CLI's file. */
export function effectiveHfToken(s: Settings): string | null {
  if (s.hfToken) return s.hfToken;
  if (process.env.HF_TOKEN) return process.env.HF_TOKEN;
  try {
    const t = fs.readFileSync(hfTokenFile(), "utf8").trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* persistence                                                                 */
/* -------------------------------------------------------------------------- */

let cached: Settings | null = null;

export function getSettings(): Settings {
  if (cached) return cached;
  fs.mkdirSync(PATHS.dataDir, { recursive: true });
  try {
    const raw = JSON.parse(fs.readFileSync(PATHS.settings, "utf8"));
    // Merge over defaults so a settings file written by an older version still
    // loads once new keys are added.
    cached = SettingsSchema.parse({ ...defaults(), ...raw });
  } catch {
    cached = defaults();
    writeSettings(cached);
  }
  return cached;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = SettingsSchema.parse({ ...getSettings(), ...patch });
  writeSettings(next);
  cached = next;
  return next;
}

function writeSettings(s: Settings) {
  fs.mkdirSync(PATHS.dataDir, { recursive: true });
  fs.writeFileSync(PATHS.settings, JSON.stringify(s, null, 2) + "\n");
}

/** Drops the in-process cache. Used by tests and by the settings form. */
export function invalidateSettings() {
  cached = null;
}
