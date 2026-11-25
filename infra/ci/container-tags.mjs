import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Return the immutable commit tag and any intentional moving/release tags. */
export function containerTags({ eventName, ref, sha }) {
  if (!/^[0-9a-f]{40}$/iu.test(sha)) {
    throw new Error("GITHUB_SHA must be a full 40-character commit SHA");
  }

  const tags = [`sha-${sha.slice(0, 7)}`];
  if (eventName === "push" && ref === "refs/heads/main") {
    tags.push("latest");
    return tags;
  }

  if (eventName === "pull_request") {
    const pr = /^refs\/pull\/(\d+)\/(?:merge|head)$/u.exec(ref);
    if (pr !== null) {
      tags.push(`pr-${pr[1]}`);
      return tags;
    }
  }

  const release = /^refs\/tags\/(v\d+\.\d+\.\d+)$/u.exec(ref);
  if (eventName === "push" && release !== null) {
    tags.push(release[1], "latest");
    return tags;
  }

  throw new Error(`Unsupported container publish event: ${eventName} ${ref}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const tags = containerTags({
      eventName: process.env["GITHUB_EVENT_NAME"] ?? "",
      ref: process.env["GITHUB_REF"] ?? "",
      sha: process.env["GITHUB_SHA"] ?? "",
    });
    process.stdout.write(`${tags.join("\n")}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
