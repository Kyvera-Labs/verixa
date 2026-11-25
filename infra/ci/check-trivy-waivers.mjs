import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const waiverPath = "infra/ci/trivyignore.yaml";
const ignorePath = ".trivyignore";
const waivers = parse(await readFile(waiverPath, "utf8"))?.waivers;
if (!Array.isArray(waivers)) {
  throw new Error(`${waiverPath} must contain a waivers list`);
}

const ignoreText = await readFile(ignorePath, "utf8");
const ignoredIds = ignoreText
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => /^(CVE|GHSA)-[A-Za-z0-9-]+$/u.test(line));
const waiverIds = new Set();
const today = new Date();
today.setUTCHours(0, 0, 0, 0);

for (const waiver of waivers) {
  if (
    typeof waiver?.id !== "string" ||
    typeof waiver.justification !== "string" ||
    waiver.justification.trim().length < 20 ||
    typeof waiver.expires !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(waiver.expires)
  ) {
    throw new Error(
      "Each Trivy waiver needs id, 20+ character justification, and YYYY-MM-DD expires",
    );
  }
  const expiry = new Date(`${waiver.expires}T00:00:00.000Z`);
  if (!Number.isFinite(expiry.getTime()) || expiry.toISOString().slice(0, 10) !== waiver.expires) {
    throw new Error(`Invalid expiry date for ${waiver.id}`);
  }
  if (expiry < today) throw new Error(`Trivy waiver ${waiver.id} expired on ${waiver.expires}`);
  if (waiverIds.has(waiver.id)) throw new Error(`Duplicate Trivy waiver ${waiver.id}`);
  waiverIds.add(waiver.id);
}

if (ignoredIds.length !== waiverIds.size || ignoredIds.some((id) => !waiverIds.has(id))) {
  throw new Error(".trivyignore and infra/ci/trivyignore.yaml must list the same CVE identifiers");
}
console.log(`Validated ${waiverIds.size} Trivy waiver(s)`);
