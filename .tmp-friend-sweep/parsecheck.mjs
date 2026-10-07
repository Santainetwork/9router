import babel from "@babel/core";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = "src/app/(dashboard)/dashboard/providers";
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) files.push(p);
  }
};
walk(dir);
let bad = 0;
for (const f of files.sort()) {
  try {
    babel.parseSync(readFileSync(f, "utf8"), {
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["jsx"] },
    });
    console.log("OK  " + f);
  } catch (e) {
    bad++;
    console.log("FAIL " + f + " :: " + e.message.split("\n")[0]);
  }
}
console.log(bad ? `FAILED ${bad}` : `ALL PARSE (${files.length} files)`);
process.exit(bad ? 1 : 0);
