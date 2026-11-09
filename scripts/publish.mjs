/** Publishes immutable signed attachments and resumes incomplete mirror uploads. */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GITEE_REPOSITORY = "aitheris/webcross-skills";
export const assetNames = [
  "webcross-skills.zip",
  "webcross-skills.json",
  "webcross-skills.sig",
];
const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Checks the original manifest bytes against the public key also trusted by desktop builds. */
export function verifyAssets(assets, publicKey, tag) {
  const bytes = assets.get(assetNames[1]);
  const signature = Buffer.from(
    assets.get(assetNames[2]).toString("utf8").trim(),
    "base64",
  );
  if (!verify(null, bytes, createPublicKey(publicKey), signature))
    throw new Error("Invalid release signature.");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || `v${manifest.version}` !== tag)
    throw new Error("Release version mismatch.");
  if (digest(assets.get(assetNames[0])) !== manifest.archiveSha256)
    throw new Error("Release archive checksum mismatch.");
  if (assets.get(assetNames[0]).length > 8 * 1024 * 1024)
    throw new Error("Release archive exceeds 8 MiB.");
  return manifest;
}

async function download(url) {
  const response = await fetch(url, {
    credentials: "omit",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`Anonymous attachment download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Git authentication needs the token owner's login, not the repository's organization. */
export async function giteePublishingUsername(
  token,
  apiUrl = "https://gitee.com/api/v5",
) {
  const response = await fetch(`${apiUrl}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Gitee token identity lookup failed: ${response.status}`);
  const user = await response.json();
  if (typeof user.login !== "string" || !user.login)
    throw new Error("Gitee returned no token owner login.");
  return user.login;
}

/** Works with local HTTP fixtures as well as the two public release APIs. */
export async function publishRelease({
  platform,
  apiUrl,
  repository,
  token,
  tag,
  commit,
  assets,
  publicKey,
  publicDownloadUrl,
}) {
  verifyAssets(assets, publicKey, tag);
  publicDownloadUrl ??= `${platform === "github" ? "https://github.com" : "https://gitee.com"}/${repository}/releases/download`;
  const base = `${apiUrl}/repos/${repository}`;
  const request = async (url, method = "GET", body) => {
    const form = body instanceof FormData;
    const response = await fetch(url, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(!form && body !== undefined
          ? {
              "Content-Type": Buffer.isBuffer(body)
                ? "application/octet-stream"
                : "application/json",
            }
          : {}),
      },
      body:
        form || Buffer.isBuffer(body)
          ? body
          : body === undefined
            ? undefined
            : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok)
      throw new Error(
        `${platform} release ${method} failed: ${response.status}`,
      );
    return response.status === 204 ? null : response.json();
  };
  let release = await request(
    `${base}/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (!release)
    release = await request(`${base}/releases`, "POST", {
      tag_name: tag,
      name: tag,
      body: `Signed WebCross Skills ${tag}.`,
      target_commitish: commit,
      ...(platform === "github"
        ? { draft: true, prerelease: false }
        : { prerelease: true }),
    });
  if (release.tag_name !== tag)
    throw new Error("Unexpected remote release tag.");
  const attachments = [];
  for (let page = 1; ; page++) {
    const batch = await request(
      `${base}/releases/${release.id}/${platform === "github" ? "assets" : "attach_files"}?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error("Invalid remote release attachments.");
    attachments.push(...batch);
    if (batch.length < 100) break;
  }
  for (const name of assetNames) {
    const expected = assets.get(name);
    const existing = attachments.find((asset) => asset.name === name);
    if (existing) {
      // Draft GitHub assets are private even when their repository is public.
      const url =
        platform === "github" && release.draft
          ? existing.url
          : existing.browser_download_url;
      let actual;
      if (platform === "github" && release.draft) {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/octet-stream",
          },
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok)
          throw new Error(
            `Draft attachment download failed: ${response.status}`,
          );
        actual = Buffer.from(await response.arrayBuffer());
      } else actual = await download(url);
      if (!actual.equals(expected))
        throw new Error(`Published attachment differs: ${name}`);
      continue;
    }
    if (platform === "github") {
      const url = new URL(release.upload_url.replace(/\{.*$/, ""));
      url.searchParams.set("name", name);
      await request(url.href, "POST", expected);
    } else {
      const form = new FormData();
      form.set("file", new Blob([expected]), name);
      await request(
        `${base}/releases/${release.id}/attach_files`,
        "POST",
        form,
      );
    }
  }
  if (release.draft || release.prerelease) {
    release = await request(
      `${base}/releases/${release.id}`,
      "PATCH",
      platform === "github"
        ? { draft: false, prerelease: false }
        : {
            tag_name: tag,
            name: release.name,
            body: release.body,
            prerelease: false,
          },
    );
  }
  const downloaded = new Map();
  for (const name of assetNames) {
    const url = `${publicDownloadUrl}/${encodeURIComponent(tag)}/${name}`;
    const bytes = await download(url);
    if (!bytes.equals(assets.get(name)))
      throw new Error(`Anonymous attachment differs: ${name}`);
    downloaded.set(name, bytes);
  }
  verifyAssets(downloaded, publicKey, tag);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [, , platform, tag, commit] = process.argv;
  if (
    !["github", "gitee", "verify"].includes(platform) ||
    !/^v\d+\.\d+\.\d+$/.test(tag ?? "") ||
    !/^[a-f0-9]{40}$/.test(commit ?? "")
  )
    throw new Error(
      "Usage: node scripts/publish.mjs <github|gitee|verify> <version-tag> <commit>",
    );
  const assets = new Map();
  if (platform === "gitee")
    mkdirSync(path.join(root, "dist"), { recursive: true });
  for (const name of assetNames) {
    const bytes =
      platform === "gitee"
        ? await download(
            `https://github.com/Aitheris/webcross-skills/releases/download/${tag}/${name}`,
          )
        : readFileSync(path.join(root, "dist", name));
    assets.set(name, bytes);
    if (platform === "gitee")
      writeFileSync(path.join(root, "dist", name), bytes);
  }
  const publicKey = readFileSync(path.join(root, "release.pub"));
  verifyAssets(assets, publicKey, tag);
  if (platform !== "verify") {
    const token =
      process.env[platform === "github" ? "GITHUB_TOKEN" : "GITEE_TOKEN"];
    if (!token) throw new Error("Missing platform publishing token.");
    await publishRelease({
      platform,
      tag,
      commit,
      assets,
      publicKey,
      token,
      apiUrl:
        platform === "github"
          ? "https://api.github.com"
          : "https://gitee.com/api/v5",
      repository:
        platform === "github" ? "Aitheris/webcross-skills" : GITEE_REPOSITORY,
    });
  }
  process.stdout.write(`Verified ${platform} ${tag}.\n`);
}
