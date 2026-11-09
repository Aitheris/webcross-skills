import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  assetNames,
  publishRelease,
  giteePublishingUsername,
} from "./publish.mjs";

for (const platform of ["github", "gitee"]) {
  test(`${platform} resumes missing attachments, anonymously verifies, and refuses changed bytes`, async (context) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const zip = Buffer.from("signed archive fixture");
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        version: "1.0.0",
        archiveSha256: createHash("sha256").update(zip).digest("hex"),
      }),
    );
    const assets = new Map([
      [assetNames[0], zip],
      [assetNames[1], manifest],
      [
        assetNames[2],
        Buffer.from(sign(null, manifest, privateKey).toString("base64")),
      ],
    ]);
    const stored = new Map();
    let release;
    let base;
    let fail = true;
    let writes = 0;
    const attachment = (name) => ({
      name,
      url: `${base}/private/${name}`,
      browser_download_url: `${base}/download/v1.0.0/${name}`,
    });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const reply = (code, value) =>
        res
          .writeHead(code, { "content-type": "application/json" })
          .end(JSON.stringify(value));
      if (
        url.pathname.startsWith("/download/") ||
        url.pathname.startsWith("/private/")
      ) {
        if (url.pathname.startsWith("/download/"))
          assert.equal(req.headers.authorization, undefined);
        const bytes = stored.get(url.pathname.split("/").pop());
        res.writeHead(bytes ? 200 : 404).end(bytes);
        return;
      }
      assert.equal(req.headers.authorization, "Bearer synthetic-token");
      if (req.method === "GET") {
        if (url.pathname.includes("/tags/"))
          return reply(
            release || platform === "gitee" ? 200 : 404,
            release ?? (platform === "gitee" ? null : {}),
          );
        return reply(200, [...stored.keys()].map(attachment));
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (req.method === "POST" && url.pathname.endsWith("/releases")) {
        if (platform === "gitee") {
          const data = JSON.parse(body);
          for (const field of ["body", "name", "tag_name", "target_commitish"])
            assert.equal(typeof data[field], "string", field);
        }
        release = {
          ...JSON.parse(body),
          id: 1,
          upload_url: `${base}/upload{?name,label}`,
        };
        return reply(201, release);
      }
      if (req.method === "PATCH") {
        if (platform === "gitee") {
          const data = JSON.parse(body);
          for (const field of ["body", "name", "tag_name"])
            assert.equal(typeof data[field], "string", field);
        }
        release = { ...release, ...JSON.parse(body) };
        return reply(200, release);
      }
      let name = url.searchParams.get("name");
      let bytes = body;
      if (platform === "gitee") {
        const form = await new Response(body, {
          headers: { "content-type": req.headers["content-type"] },
        }).formData();
        const file = form.get("file");
        name = file.name;
        bytes = Buffer.from(await file.arrayBuffer());
      }
      if (name === assetNames[1] && fail) {
        fail = false;
        return reply(503, {});
      }
      writes++;
      stored.set(name, bytes);
      return reply(201, attachment(name));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    base = `http://127.0.0.1:${server.address().port}`;
    const options = {
      platform,
      apiUrl: base,
      publicDownloadUrl: `${base}/download`,
      repository: "example/skills",
      token: "synthetic-token",
      tag: "v1.0.0",
      commit: "a".repeat(40),
      assets,
      publicKey: publicKey.export({ format: "pem", type: "spki" }),
    };
    await assert.rejects(publishRelease(options), /503/);
    assert.equal(stored.size, 1);
    await publishRelease(options);
    assert.equal(stored.size, 3);
    assert.equal(release.prerelease, false);
    await publishRelease(options);
    assert.equal(writes, 3);
    stored.set(assetNames[0], Buffer.from("changed"));
    await assert.rejects(publishRelease(options), /differs/);
    assert.equal(writes, 3);
  });
}

test("uses the authenticated Gitee token owner instead of the mirror namespace", async (context) => {
  const server = createServer((req, res) => {
    assert.equal(req.url, "/user");
    assert.equal(req.headers.authorization, "Bearer synthetic-token");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ login: "publishing-account" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  assert.equal(
    await giteePublishingUsername(
      "synthetic-token",
      `http://127.0.0.1:${server.address().port}`,
    ),
    "publishing-account",
  );
});
