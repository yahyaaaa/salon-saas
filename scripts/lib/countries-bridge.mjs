/**
 * Reads the country table straight out of the TypeScript source, so the test
 * checks the data the application actually ships rather than a copy that can
 * drift away from it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const source = fs.readFileSync("src/lib/countries.ts", "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});

const compiled = path.join(os.tmpdir(), `salon-countries-${process.pid}.mjs`);
fs.writeFileSync(compiled, outputText);

let mod;
try {
  mod = await import(`file://${compiled.split(path.sep).join("/")}`);
} finally {
  fs.rmSync(compiled, { force: true });
}

export const { COUNTRIES, findCountry, currencyFor, timezoneFor, allTimeZones } = mod;
