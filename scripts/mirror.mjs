/** Pushes the release tag without storing the Gitee publishing credential in Git configuration. */
import { execFileSync } from "node:child_process";
import { GITEE_REPOSITORY, giteePublishingUsername } from "./publish.mjs";
const repository = GITEE_REPOSITORY;
const token = process.env.GITEE_TOKEN;
const tag = process.argv[2];
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
  !token ||
  !/^v\d+\.\d+\.\d+$/.test(tag ?? "")
) {
  throw new Error(
    "A Gitee repository, token and stable release tag are required.",
  );
}
const username = await giteePublishingUsername(token);
const remote = `https://gitee.com/${repository}.git`;
const env = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://gitee.com/.extraheader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
  GIT_TRACE: "0",
  GIT_CURL_VERBOSE: undefined,
  GIT_TERMINAL_PROMPT: "0",
};
const git = (...args) => execFileSync("git", args, { env, encoding: "utf8" });
const branches = git("ls-remote", "--heads", remote);
// Seed a new repository once; existing default branches are never force-updated.
if (!branches.trim()) git("push", remote, "HEAD:refs/heads/main");
git("push", remote, `refs/tags/${tag}:refs/tags/${tag}`);
