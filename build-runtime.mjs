import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "tsdown";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(pluginDir, "dist");
const privateSurfacePattern = /(?:^|[._-])(?:test|spec|fixture|mock)(?:[._-]|$)/u;

const sourceEntries = fs
  .readdirSync(pluginDir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !privateSurfacePattern.test(entry.name) &&
      // Standalone repo root also holds the Vitest config; it is not a
      // runtime entry and must not ship in the plugin artifact.
      entry.name !== "vitest.config.ts",
  )
  .map((entry) => entry.name)
  .toSorted((left, right) => left.localeCompare(right));

const entry = Object.fromEntries(
  sourceEntries.map((fileName) => [path.basename(fileName, ".ts"), path.join(pluginDir, fileName)]),
);

function neverBundle(id) {
  return (
    id === "openclaw" ||
    id.startsWith("openclaw/") ||
    id === "ws" ||
    id.startsWith("ws/") ||
    id === "zod" ||
    id.startsWith("zod/")
  );
}

fs.rmSync(outDir, { recursive: true, force: true });
await build({
  clean: false,
  config: false,
  dts: false,
  deps: { neverBundle },
  entry,
  env: { NODE_ENV: "production" },
  fixedExtension: false,
  format: "esm",
  logLevel: "info",
  outDir,
  platform: "node",
});

// tsdown/rolldown splits shared code used by 2+ entries into hashed chunk
// files (e.g. `channel.runtime-X1qGRmcs.js`) alongside the entry-named
// outputs. Most Plugin SDK imports live in those chunks, not the entries, so
// every acceptance check below must walk the whole emitted tree instead of
// just the source-entry basenames.
function listEmittedJsFiles(dir) {
  const results = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      results.push(...listEmittedJsFiles(fullPath));
      continue;
    }
    if (dirent.isFile() && dirent.name.endsWith(".js")) {
      results.push(fullPath);
    }
  }
  return results;
}

const emittedJsFiles = listEmittedJsFiles(outDir).toSorted((left, right) =>
  left.localeCompare(right),
);
if (emittedJsFiles.length === 0) {
  throw new Error("build produced no JavaScript output under dist/");
}

for (const fileName of sourceEntries.map((name) => name.replace(/\.ts$/u, ".js"))) {
  const outputPath = path.join(outDir, fileName);
  if (!fs.existsSync(outputPath)) {
    throw new Error(`missing runtime output: dist/${fileName}`);
  }
}

for (const filePath of emittedJsFiles) {
  const source = fs.readFileSync(filePath, "utf8");
  if (source.includes("session_nodes_entry_valid_after_insert")) {
    throw new Error(
      `runtime output unexpectedly embeds OpenClaw session schema: ${path.relative(pluginDir, filePath)}`,
    );
  }
}

// Collect the real named bindings each emitted chunk imports from the host
// Plugin SDK. Unrecognized import shapes (namespace/default) fail closed
// instead of being silently skipped, since a skipped shape is the same class
// of hole this gate exists to close.
const namedImportPattern =
  /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*["'](openclaw\/plugin-sdk\/[^"']+)["']/gu;
const sideEffectImportPattern = /\bimport\s*["'](openclaw\/plugin-sdk\/[^"']+)["']/gu;
const dynamicImportPattern = /\bimport\s*\(\s*["'](openclaw\/plugin-sdk\/[^"']+)["']\s*\)/gu;
const unsupportedShapePattern =
  /\bimport\s+(?:\*\s+as\s+[\w$]+|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s*from\s*["'](openclaw\/plugin-sdk\/[^"']+)["']/gu;

/** @type {Map<string, Set<string>>} */
const namedImportsBySpecifier = new Map();

function recordNamedImports(specifier, bindingClause) {
  const names = bindingClause
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      part
        .replace(/^type\s+/u, "")
        .split(/\s+as\s+/u)[0]
        .trim(),
    );
  const existing = namedImportsBySpecifier.get(specifier) ?? new Set();
  for (const name of names) {
    existing.add(name);
  }
  namedImportsBySpecifier.set(specifier, existing);
}

function recordBareSpecifier(specifier) {
  if (!namedImportsBySpecifier.has(specifier)) {
    namedImportsBySpecifier.set(specifier, new Set());
  }
}

for (const filePath of emittedJsFiles) {
  const source = fs.readFileSync(filePath, "utf8");
  const relativePath = path.relative(pluginDir, filePath);

  for (const match of source.matchAll(unsupportedShapePattern)) {
    throw new Error(
      `${relativePath} imports "${match[1]}" with a default/namespace import; ` +
        "this build gate only validates named imports — use a named import instead",
    );
  }
  for (const match of source.matchAll(namedImportPattern)) {
    recordNamedImports(match[2], match[1]);
  }
  for (const match of source.matchAll(sideEffectImportPattern)) {
    recordBareSpecifier(match[1]);
  }
  for (const match of source.matchAll(dynamicImportPattern)) {
    recordBareSpecifier(match[1]);
  }
}

if (namedImportsBySpecifier.size === 0) {
  throw new Error("runtime output does not preserve any external OpenClaw Plugin SDK imports");
}

function findWorkspaceHostRoot(startDir) {
  let currentDir = startDir;
  while (true) {
    const installedDir = path.join(currentDir, "node_modules", "openclaw");
    if (fs.existsSync(path.join(installedDir, "package.json"))) {
      return installedDir;
    }
    const workspacePackageJsonPath = path.join(currentDir, "package.json");
    if (fs.existsSync(workspacePackageJsonPath)) {
      const candidate = JSON.parse(fs.readFileSync(workspacePackageJsonPath, "utf8"));
      if (candidate.name === "openclaw") {
        return currentDir;
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        "cannot find the OpenClaw host used for the runtime build; " +
          "set MATTERMOST_CUSTOM_HOST_ROOT to an OpenClaw checkout or install",
      );
    }
    currentDir = parentDir;
  }
}

function resolveHostRoot() {
  const override = process.env.MATTERMOST_CUSTOM_HOST_ROOT?.trim();
  if (!override) {
    return findWorkspaceHostRoot(pluginDir);
  }
  const overridePackageJsonPath = path.join(override, "package.json");
  if (!fs.existsSync(overridePackageJsonPath)) {
    throw new Error(`MATTERMOST_CUSTOM_HOST_ROOT does not contain a package.json: ${override}`);
  }
  return path.resolve(override);
}

const hostRoot = resolveHostRoot();
const hostPackageJson = JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8"));
const hostExports = hostPackageJson.exports ?? {};

const missingHostExports = [...namedImportsBySpecifier.keys()].filter(
  (specifier) => !(specifier.replace(/^openclaw/u, ".") in hostExports),
);
if (missingHostExports.length > 0) {
  throw new Error(
    `OpenClaw host at ${hostRoot} does not export: ${missingHostExports.toSorted().join(", ")}`,
  );
}

function resolveHostSubpathFile(specifier) {
  const target = hostExports[specifier.replace(/^openclaw/u, ".")];
  const relativeTarget =
    typeof target === "string" ? target : (target?.default ?? target?.import ?? target?.node);
  if (!relativeTarget) {
    throw new Error(`OpenClaw host export "${specifier}" has no resolvable JS target`);
  }
  return path.join(hostRoot, relativeTarget);
}

const missingNamedExports = [];
for (const [specifier, names] of namedImportsBySpecifier) {
  if (names.size === 0) {
    continue;
  }
  const hostFilePath = resolveHostSubpathFile(specifier);
  if (!fs.existsSync(hostFilePath)) {
    throw new Error(
      `OpenClaw host export "${specifier}" points at a missing file: ${hostFilePath}. ` +
        "Build the OpenClaw host before running this check.",
    );
  }
  const hostModule = await import(pathToFileURL(hostFilePath).href);
  const realExportNames = new Set(Object.keys(hostModule));
  for (const name of names) {
    if (!realExportNames.has(name)) {
      missingNamedExports.push(`${specifier}: ${name}`);
    }
  }
}
if (missingNamedExports.length > 0) {
  throw new Error(
    `OpenClaw host at ${hostRoot} does not export the following names used by the packaged runtime:\n` +
      missingNamedExports.toSorted().join("\n"),
  );
}

const totalNamedExports = [...namedImportsBySpecifier.values()].reduce(
  (sum, names) => sum + names.size,
  0,
);
console.error(
  `[mattermost-custom] built ${sourceEntries.length} standalone runtime entries across ` +
    `${emittedJsFiles.length} emitted files; verified ${totalNamedExports} named Plugin SDK ` +
    `exports across ${namedImportsBySpecifier.size} subpaths against host ${hostRoot}`,
);
