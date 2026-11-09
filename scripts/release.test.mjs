import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRelease } from "./release.mjs";
import { assetNames, verifyAssets } from "./publish.mjs";

function fixture(context) {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-release-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL("../skills/", import.meta.url), path.join(root, "skills"), {
    recursive: true,
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = path.join(root, "test.key");
  writeFileSync(key, privateKey.export({ format: "pem", type: "pkcs8" }));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  git("init", "-b", "main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.test");
  const commit = () => {
    git("add", "skills");
    git("commit", "-m", "test: prepare skills");
  };
  const declaration = (userVersionRange = ">=1.0.0") =>
    writeFileSync(
      path.join(root, "skills/release.json"),
      JSON.stringify({ version: "1.0.0", userVersionRange }),
    );
  declaration();
  return {
    root,
    key,
    publicKey: publicKey.export({ format: "pem", type: "spki" }),
    git,
    commit,
    declaration,
  };
}

test("builds three verifiable attachments exclusively from the tagged commit", (context) => {
  const f = fixture(context);
  f.commit();
  f.git("tag", "v1.0.0");
  const name = "skills/webcross-browser/SKILL.md";
  const original = readFileSync(path.join(f.root, name));
  writeFileSync(path.join(f.root, name), "uncommitted content");
  const result = buildRelease(f.root, f.key, "v1.0.0");
  const assets = new Map(
    assetNames.map((name) => [
      name,
      readFileSync(path.join(result.output, name)),
    ]),
  );
  const manifest = verifyAssets(assets, f.publicKey, "v1.0.0");
  assert.equal(manifest.version, "1.0.0");
  mkdirSync(path.join(f.root, "scripts"));
  cpSync(
    new URL("./publish.mjs", import.meta.url),
    path.join(f.root, "scripts/publish.mjs"),
  );
  writeFileSync(path.join(f.root, "release.pub"), f.publicKey);
  const check = execFileSync(
    process.execPath,
    [
      path.join(f.root, "scripts/publish.mjs"),
      "verify",
      "v1.0.0",
      result.commit,
    ],
    { encoding: "utf8" },
  );
  assert.match(check, /Verified verify v1.0.0/);
  const archived = execFileSync("git", ["-C", f.root, "show", `HEAD:${name}`]);
  assert.deepEqual(archived, original);
  const firstZip = assets.get(assetNames[0]);
  buildRelease(f.root, f.key, "v1.0.0");
  assert.deepEqual(
    readFileSync(path.join(result.output, assetNames[0])),
    firstZip,
  );
  assert.throws(() => buildRelease(f.root, f.key, "v1.1.0"), /tag/);
});

for (const invalid of ["range", "reference", "missing", "type", "size"]) {
  test(`rejects invalid committed ${invalid}`, (context) => {
    const f = fixture(context);
    if (invalid === "range") f.declaration("definitely not semver");
    if (invalid === "reference")
      writeFileSync(
        path.join(f.root, "skills/webcross-browser/references/broken.md"),
        "[missing](absent.md)",
      );
    if (invalid === "missing")
      rmSync(path.join(f.root, "skills/webcross-browser/SKILL.md"));
    if (invalid === "type")
      writeFileSync(path.join(f.root, "skills/webcross-browser/unsafe.js"), "");
    if (invalid === "size")
      writeFileSync(
        path.join(f.root, "skills/webcross-browser/assets/large.png"),
        randomBytes(8 * 1024 * 1024),
      );
    f.commit();
    f.git("tag", "v1.0.0");
    assert.throws(() => buildRelease(f.root, f.key, "v1.0.0"));
  });
}
