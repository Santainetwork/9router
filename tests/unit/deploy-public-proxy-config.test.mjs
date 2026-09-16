import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(path.join(repoRoot, file), "utf8");

test("retired Node public proxy systemd unit is not shipped", () => {
  assert.equal(existsSync(path.join(repoRoot, "deploy/9router-public-proxy.service")), false);
});

test("nginx installer resolves the usage page path without a machine-specific literal", () => {
  const config = read("deploy/nginx-9router-public.conf");
  const installer = read("deploy/install-public-nginx.sh");

  assert.match(config, /alias "__USAGE_CHECK_HTML__";/);
  assert.doesNotMatch(config, /\/opt\/9router\//);
  assert.doesNotMatch(config, /cp deploy\/nginx-9router-public\.conf/);
  assert.match(installer, /USAGE_CHECK_HTML=/);
  assert.match(installer, /sed .*__USAGE_CHECK_HTML__/);
});
