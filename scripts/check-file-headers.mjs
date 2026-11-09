/**
 * @file Documentation gate (owning module: repository tooling), run by `pnpm lint`.
 *
 * Automatable part of the documentation policy (docs/HANDOVER.md §Documentation standard):
 *  1. every authored source file starts with a header stating purpose (@file) and owning
 *     module (@module or "owning module"), SQL migrations with an "Owning module:" banner;
 *  2. every exported function/class/interface/type/const in application code has a preceding
 *     JSDoc/TSDoc block.
 * Manual review still covers comment quality; this check prevents silent omissions.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const dirs = ['apps/api/src', 'apps/web/src', 'packages/contracts/src', 'scripts', 'tests'];
const problems = [];
const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' || e.name === 'dist' ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
  );
let checkedFiles = 0;
let checkedExports = 0;
for (const dir of dirs) {
  for (const f of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    if (!/\.(ts|tsx|mjs|sql)$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    checkedFiles++;
    const head = text.slice(0, 1500);
    if (f.endsWith('.sql')) {
      if (!/Owning module:/i.test(head)) problems.push(`${rel}: missing migration banner with "Owning module:"`);
      continue;
    }
    if (!/@file/.test(head) || !/(@module|owning module)/i.test(head)) problems.push(`${rel}: missing @file / owning module header`);
    if (rel.startsWith('tests/') || rel.startsWith('scripts/') || rel.endsWith('.test.ts')) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!/^export (async )?(function|class|interface|type|const|abstract class) /.test(line)) return;
      checkedExports++;
      let j = i - 1;
      while (j >= 0 && /^\s*@\w+/.test(lines[j])) j--; // skip decorators
      if (j < 0 || !/\*\/\s*$/.test(lines[j])) problems.push(`${rel}:${i + 1}: exported symbol without TSDoc: ${line.slice(0, 80)}`);
    });
  }
}
if (problems.length) {
  console.error(`Documentation gate failed (${problems.length}):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`Documentation gate passed: ${checkedFiles} files, ${checkedExports} exported symbols documented.`);
