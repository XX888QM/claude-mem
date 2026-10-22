// Puts the tree-sitter CLI executable into a plugin root's own tree-sitter-cli
// package. Every install path installs that package with lifecycle scripts off:
// Claude Code's marketplace install, `bun install --ignore-scripts` and
// `npm install --ignore-scripts` alike. So tree-sitter-cli's install.js, the
// step that downloads the executable, never runs, and smart_search,
// smart_outline and smart_unfold cannot parse anything (#2910). Dependency-free
// like tree-sitter-bin-path.ts, so the npx installer and the worker share it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { treeSitterBinaryName } from "./tree-sitter-bin-name.js";
import { isExecutableFile } from "./tree-sitter-bin-path.js";
import { pinnedTreeSitterExecutableSha256 } from "./tree-sitter-cli-checksums.js";

const TREE_SITTER_VERSION_TIMEOUT_MS = 10_000;
const TREE_SITTER_VERSION_OUTPUT = /^tree-sitter \d+\.\d+\.\d+(?:\s|$)/;

/**
 * Every provisioning error for a verified release executable that the OS
 * cannot run contains this text; the installer error taxonomy matches on it.
 */
export const TREE_SITTER_CLI_CANNOT_RUN = "cannot run on this system";

function treeSitterCliPackageDir(pluginRoot: string): string {
  return join(pluginRoot, "node_modules", "tree-sitter-cli");
}

/** The tree-sitter executable inside `pluginRoot`'s own tree-sitter-cli package. */
export function treeSitterCliBinaryPath(pluginRoot: string): string {
  return join(treeSitterCliPackageDir(pluginRoot), treeSitterBinaryName());
}

export interface TreeSitterCliVersionProbe {
  usable: boolean;
  /** The spawn failure's stderr (or error) first line when not usable. */
  reason?: string;
}

async function answersTreeSitterVersion(executablePath: string): Promise<TreeSitterCliVersionProbe> {
  return await new Promise<TreeSitterCliVersionProbe>((resolve) => {
    // Bun can throw synchronously when the OS refuses the file outright (a
    // truncated Mach-O is EBADMACHO on macOS); that is "not usable", the same
    // as a spawn failure reported through the callback.
    try {
      const child = execFile(executablePath, ["--version"], {
        encoding: "utf-8",
        timeout: TREE_SITTER_VERSION_TIMEOUT_MS,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (!error && TREE_SITTER_VERSION_OUTPUT.test((stdout ?? "").trim())) {
          resolve({ usable: true });
          return;
        }
        const detail = (stderr ?? "").trim().split("\n")[0]
          || (error?.message ?? "").split("\n")[0]
          || undefined;
        resolve({ usable: false, reason: detail });
      });
      child.stdin?.end();
    } catch (spawnError) {
      const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
      resolve({ usable: false, reason: message.split("\n")[0] || undefined });
    }
  });
}

/** True only when a pinned package-local executable answers `--version`. */
export async function isTreeSitterCliBinaryUsable(
  pluginRoot: string,
  pinnedSha256ForVersion: (version: string) => string | undefined = pinnedTreeSitterExecutableSha256,
): Promise<boolean> {
  try {
    assertTreeSitterCliExecutableVerified(treeSitterCliBinaryPath(pluginRoot), pinnedSha256ForVersion);
    return (await answersTreeSitterVersion(treeSitterCliBinaryPath(pluginRoot))).usable;
  } catch {
    return false;
  }
}

function runInstallScript(
  installScript: string,
  workingDirectory: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [installScript], {
      cwd: workingDirectory,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}

function sha256OfFile(filePath: string): string {
  assertRegularFile(filePath);
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertRegularFile(filePath: string): void {
  if (!lstatSync(filePath).isFile()) throw new Error(`tree-sitter-cli path is not a regular file: ${filePath}`);
}

function assertCliDirectory(pluginRoot: string): void {
  const cliDir = treeSitterCliPackageDir(pluginRoot);
  if (!lstatSync(cliDir).isDirectory()
    || realpathSync(cliDir) !== join(realpathSync(pluginRoot), "node_modules", "tree-sitter-cli")) {
    throw new Error(`tree-sitter-cli package path is not a directory inside the plugin: ${cliDir}`);
  }
}

function expectedExecutableSha256(cliDir: string, pinnedSha256ForVersion: (version: string) => string | undefined): string {
  const packageJson = join(cliDir, "package.json");
  assertRegularFile(packageJson);
  const version = String((JSON.parse(readFileSync(packageJson, "utf-8")) as { version?: unknown }).version);
  const pinnedSha256 = pinnedSha256ForVersion(version);
  if (!pinnedSha256) {
    throw new Error(`No SHA-256 is pinned for the tree-sitter ${version} executable on ${process.platform}-${process.arch}, `
      + "so it is not downloaded (src/services/smart-file-read/tree-sitter-cli-checksums.ts)");
  }
  return pinnedSha256;
}

/** Every executable entry point, including direct parser calls, checks the pinned bytes first. */
export function assertTreeSitterCliExecutableVerified(
  executablePath: string,
  pinnedSha256ForVersion: (version: string) => string | undefined = pinnedTreeSitterExecutableSha256,
): void {
  assertCliDirectory(join(dirname(executablePath), "..", ".."));
  const pinnedSha256 = expectedExecutableSha256(dirname(executablePath), pinnedSha256ForVersion);
  if (sha256OfFile(executablePath) !== pinnedSha256) {
    throw new Error(`tree-sitter-cli executable does not match the pinned SHA-256; it was not run: ${executablePath}`);
  }
}

/**
 * Run tree-sitter-cli's own install.js when the package-local CLI is not
 * usable. The script and its package.json run from a private staging directory
 * inside the package, including installers that write beside __dirname.
 * The executable must match
 * the SHA-256 pinned for the package's version and this platform before it is
 * run at all (a replaced release asset never executes), and is renamed into
 * place only once it then answers `--version`. The File Read Gate checks
 * existence while the parser verifies the pin again. A download that fails, times out
 * or dies with its process must never leave a partial executable there.
 * Throws when no verified, working executable results. When the existing
 * executable is intact (matches the pinned SHA-256) but the OS cannot run it
 * (#4758), the download would fetch identical bytes, so it throws immediately
 * with the spawn failure's reason instead.
 *
 * `pinnedSha256ForVersion` exists for tests; callers pass none.
 */
export async function ensureTreeSitterCliBinary(
  pluginRoot: string,
  installTimeoutMs: number,
  pinnedSha256ForVersion: (version: string) => string | undefined = pinnedTreeSitterExecutableSha256,
): Promise<"already-usable" | "release"> {
  const cliDir = treeSitterCliPackageDir(pluginRoot);

  const installScript = join(cliDir, "install.js");
  if (!existsSync(cliDir)) {
    throw new Error(`tree-sitter-cli install script not found: ${installScript}`);
  }
  assertCliDirectory(pluginRoot);
  const pinnedSha256 = expectedExecutableSha256(cliDir, pinnedSha256ForVersion);
  const finalExecutable = treeSitterCliBinaryPath(pluginRoot);
  const existingBinaryPath = finalExecutable;
  const version = String(JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")).version);
  if (lstatSync(finalExecutable, { throwIfNoEntry: false })) assertRegularFile(finalExecutable);
  if (await isTreeSitterCliBinaryUsable(pluginRoot, pinnedSha256ForVersion)) return "already-usable";
  if (!existsSync(installScript)) throw new Error(`tree-sitter-cli install script not found: ${installScript}`);
  assertRegularFile(installScript);

  // The executable is intact (it matches the pinned SHA-256) but the OS cannot
  // run it — e.g. tree-sitter-cli 0.26.9 links against GLIBC_2.39, which
  // Ubuntu 22.04 / Debian 12 / RHEL 9 do not have (#4758). Downloading the
  // same release asset again cannot help, so fail fast with the real reason
  // instead of burning a download on every worker start. A corrupt or stale
  // binary (SHA mismatch) still falls through to the download below, as does
  // a binary that merely lost its executable bit: the download restores 755.
  if (existsSync(existingBinaryPath)) {
    let existingSha256 = "(unreadable)";
    try {
      existingSha256 = sha256OfFile(existingBinaryPath);
    } catch {
      // Fall through to the download; it cannot make things worse.
    }
    if (existingSha256 === pinnedSha256 && isExecutableFile(existingBinaryPath)) {
      const existingProbe = await answersTreeSitterVersion(existingBinaryPath);
      throw new Error(
        `The tree-sitter ${version} executable at ${existingBinaryPath} is intact (SHA-256 matches the pinned value) `
        + `but ${TREE_SITTER_CLI_CANNOT_RUN}${existingProbe.reason ? `: ${existingProbe.reason}` : ""}. `
        + "smart_search, smart_outline and smart_unfold cannot parse here, and the File Read Gate stays off.",
      );
    }
  }

  // Inside the package, so the final rename stays on one filesystem.
  const stagingDir = mkdtempSync(join(cliDir, ".provision-"));
  try {
    copyFileSync(installScript, join(stagingDir, "install.js"));
    copyFileSync(join(cliDir, "package.json"), join(stagingDir, "package.json"));
    const installOutput = await runInstallScript(join(stagingDir, "install.js"), stagingDir, installTimeoutMs);
    const stagedExecutable = join(stagingDir, treeSitterBinaryName());
    const downloadedSha256 = existsSync(stagedExecutable) ? sha256OfFile(stagedExecutable) : "(no file)";
    if (downloadedSha256 !== pinnedSha256) {
      throw Object.assign(
        new Error(`The downloaded tree-sitter executable has SHA-256 ${downloadedSha256}, not the pinned ${pinnedSha256}; it was not run`),
        installOutput,
      );
    }
    const stagedProbe = await answersTreeSitterVersion(stagedExecutable);
    if (!stagedProbe.usable) {
      throw Object.assign(
        new Error(
          `The tree-sitter ${version} executable ${treeSitterCliBinaryPath(pluginRoot)} matches the pinned SHA-256 `
          + `but ${TREE_SITTER_CLI_CANNOT_RUN}${stagedProbe.reason ? `: ${stagedProbe.reason}` : ""}`,
        ),
        installOutput,
      );
    }
    assertCliDirectory(pluginRoot);
    if (lstatSync(finalExecutable, { throwIfNoEntry: false })) assertRegularFile(finalExecutable);
    if (sha256OfFile(stagedExecutable) !== pinnedSha256) throw new Error("tree-sitter-cli staged executable changed after verification");
    renameSync(stagedExecutable, finalExecutable);
    return "release";
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
