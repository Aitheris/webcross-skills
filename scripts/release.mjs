/** Builds and signs release assets from the exact committed skill revision. */
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

/** Builds from Git objects so uncommitted files cannot enter a release. */
export function buildRelease(root, keyPath, tag) {
  const privateKey = createPrivateKey(readFileSync(keyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("The Skill signing key must use Ed25519.");
  }
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { maxBuffer: 8 * 1024 * 1024 });
  const commit = git("rev-parse", "HEAD").toString().trim();
  const { version, userVersionRange } = JSON.parse(
    git("show", `${commit}:skills/release.json`),
  );
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version) ||
    !version.split(".").every((part) => Number.isSafeInteger(Number(part))) ||
    typeof userVersionRange !== "string" ||
    !userVersionRange.trim() ||
    !semver.validRange(userVersionRange)
  ) {
    throw new Error(
      "skills/release.json must declare a stable version and a WebCross version range.",
    );
  }

  if (
    tag !== `v${version}` ||
    git("rev-parse", `${tag}^{commit}`).toString().trim() !== commit
  ) {
    throw new Error(
      "The release tag must match the committed Skill version and HEAD.",
    );
  }
  const skillDirectories = [
    "skills/webcross-browser",
    "skills/webcross-workflow",
  ];
  const entries = git("ls-tree", "-r", "-z", commit, "--", ...skillDirectories)
    .toString()
    .split("\0")
    .filter(Boolean);
  const required = new Set([
    "skills/webcross-browser/SKILL.md",
    "skills/webcross-browser/references/connection-and-recovery.md",
    "skills/webcross-browser/references/workflow-orchestration.md",
    "skills/webcross-workflow/SKILL.md",
    "skills/webcross-workflow/references/observation-async-and-options.md",
    "skills/webcross-workflow/references/segmentation-and-validation.md",
  ]);
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const files = {};
  const references = [];
  for (const entry of entries) {
    const [metadata, name] = entry.split("\t");
    const [, objectId] = /^100644 blob ([a-f0-9]+)$/.exec(metadata) ?? [];
    if (
      !objectId ||
      !/^skills\/webcross-(?:browser|workflow)\/(?:[\w-]+\/)*[\w.-]+\.(?:md|yaml|png)$/.test(
        name,
      )
    ) {
      throw new Error(`Unsupported Skill release entry: ${name}`);
    }
    const content = git("cat-file", "blob", objectId);
    if (name.endsWith(".md")) {
      for (const [, link] of content
        .toString("utf8")
        .matchAll(/\]\(([^\s):#]+)(?:#[^)]*)?\)/g)) {
        references.push([
          name,
          path.posix.normalize(path.posix.join(path.posix.dirname(name), link)),
        ]);
      }
    }
    if (name.endsWith("/SKILL.md")) {
      const skill = path.basename(path.dirname(name));
      if (!content.toString("utf8").startsWith(`---\nname: ${skill}\n`)) {
        throw new Error(`Invalid Skill front matter: ${name}`);
      }
    }
    files[name] = sha256(content);
    required.delete(name);
  }
  if (required.size)
    throw new Error(`Missing release files: ${[...required].join(", ")}`);

  for (const [source, target] of references) {
    if (!Object.hasOwn(files, target))
      throw new Error(`Broken Skill reference in ${source}: ${target}`);
  }
  const output = path.join(root, "dist");
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(path.join(output, ".pack-"));
  const archivePath = path.join(staging, "webcross-skills.zip");
  try {
    git(
      "archive",
      "--format=zip",
      `--output=${archivePath}`,
      commit,
      ...skillDirectories,
    );
    if (statSync(archivePath).size > 8 * 1024 * 1024) {
      throw new Error("The Skill ZIP exceeds the desktop 8 MiB limit.");
    }
    const manifest = Buffer.from(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version,
          userVersionRange,
          archiveSha256: sha256(readFileSync(archivePath)),
          files,
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(path.join(staging, "webcross-skills.json"), manifest);
    writeFileSync(
      path.join(staging, "webcross-skills.sig"),
      `${sign(null, manifest, privateKey).toString("base64")}\n`,
    );
    for (const name of [
      "webcross-skills.zip",
      "webcross-skills.json",
      "webcross-skills.sig",
    ]) {
      renameSync(path.join(staging, name), path.join(output, name));
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { version, commit, output };
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [, , keyPath, tag] = process.argv;
  if (!keyPath || !tag)
    throw new Error(
      "Usage: node scripts/release.mjs <private-key-path> <version-tag>",
    );
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { version, commit } = buildRelease(root, keyPath, tag);
  process.stdout.write(`Prepared Skill ${version} from ${commit}.\n`);
}
