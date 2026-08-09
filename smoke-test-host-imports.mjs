// Proves the packaged tarball actually links and runs against a real,
// separately-checked-out OpenClaw host: pack the plugin for real, extract
// it exactly as an installer would, wire its declared runtime dependencies
// to real packages, then let Node's own ESM linker resolve every emitted
// chunk. A missing named export throws at import time here the same way it
// throws inside the host's real plugin loader — no static parsing needed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
// Standalone plugin repo: the plugin root is the repository root, so the
// declared runtime dependencies (ws/zod) resolve from pluginDir/node_modules.
const repoRoot = pluginDir;

function requireHostRoot() {
  const hostRoot = process.env.MATTERMOST_CUSTOM_HOST_ROOT?.trim();
  if (!hostRoot) {
    throw new Error(
      "MATTERMOST_CUSTOM_HOST_ROOT is required: point it at a real OpenClaw checkout or " +
        "install (e.g. the pinned beta.7 host) to prove the packed tarball links against it",
    );
  }
  const resolved = path.resolve(hostRoot);
  if (!fs.existsSync(path.join(resolved, "package.json"))) {
    throw new Error(`MATTERMOST_CUSTOM_HOST_ROOT does not contain a package.json: ${resolved}`);
  }
  return resolved;
}

function resolveWorkspaceDependency(name) {
  const resolved = path.join(repoRoot, "node_modules", name);
  if (!fs.existsSync(path.join(resolved, "package.json"))) {
    throw new Error(`cannot find workspace dependency "${name}" at ${resolved}`);
  }
  return resolved;
}

function listJsFilesRecursive(dir) {
  const results = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      results.push(...listJsFilesRecursive(fullPath));
      continue;
    }
    if (dirent.isFile() && dirent.name.endsWith(".js")) {
      results.push(fullPath);
    }
  }
  return results;
}

async function importAndCollectFailure(filePath) {
  try {
    await import(pathToFileURL(filePath).href);
    return null;
  } catch (error) {
    return { filePath, error };
  }
}

const hostRoot = requireHostRoot();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mattermost-custom-host-smoke-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", tempRoot], {
    cwd: pluginDir,
    stdio: "inherit",
  });
  const tarballName = fs.readdirSync(tempRoot).find((name) => name.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error(`pnpm pack did not produce a tarball in ${tempRoot}`);
  }

  const extractedRoot = path.join(tempRoot, "extracted");
  fs.mkdirSync(extractedRoot);
  execFileSync("tar", ["xzf", path.join(tempRoot, tarballName), "-C", extractedRoot]);
  const packageRoot = path.join(extractedRoot, "package");

  const nodeModulesDir = path.join(packageRoot, "node_modules");
  fs.mkdirSync(nodeModulesDir);
  fs.symlinkSync(hostRoot, path.join(nodeModulesDir, "openclaw"), "dir");
  for (const dependency of ["ws", "zod"]) {
    fs.symlinkSync(
      resolveWorkspaceDependency(dependency),
      path.join(nodeModulesDir, dependency),
      "dir",
    );
  }

  const distDir = path.join(packageRoot, "dist");
  const jsFiles = listJsFilesRecursive(distDir).toSorted((left, right) =>
    left.localeCompare(right),
  );
  if (jsFiles.length === 0) {
    throw new Error(`packed tarball has no JavaScript output under ${distDir}`);
  }

  const failures = [];
  for (const filePath of jsFiles) {
    const failure = await importAndCollectFailure(filePath);
    if (failure) {
      failures.push(failure);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `[smoke-test] FAILED importing ${path.relative(packageRoot, failure.filePath)}`,
      );
      console.error(failure.error);
    }
    throw new Error(
      `${failures.length}/${jsFiles.length} packed runtime chunks failed to import against host ${hostRoot}`,
    );
  }

  // Red-capability check: a fabricated export must fail the same way a real
  // regression would. If this ever stops throwing, the harness above can no
  // longer be trusted to catch a missing export.
  const redCapabilityProbePath = path.join(distDir, "__red_capability_probe__.mjs");
  fs.writeFileSync(
    redCapabilityProbePath,
    'import { totallyFabricatedExportName123 } from "openclaw/plugin-sdk/core";\n' +
      "export { totallyFabricatedExportName123 };\n",
  );
  try {
    await import(pathToFileURL(redCapabilityProbePath).href);
    throw new Error(
      "red-capability self-check failed: importing a fabricated Plugin SDK export did not throw",
    );
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  } finally {
    fs.rmSync(redCapabilityProbePath, { force: true });
  }

  console.error(
    `[smoke-test] ${jsFiles.length}/${jsFiles.length} packed runtime chunks imported cleanly ` +
      `against host ${hostRoot}; red-capability self-check confirmed a fabricated export fails`,
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
