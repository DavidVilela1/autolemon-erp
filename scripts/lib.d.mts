/**
 * @file Type declarations for scripts/lib.mjs, so TypeScript tests can import its helpers
 * (owning module: repository tooling). Declares every export: TypeScript also uses this file
 * when the other scripts import lib.mjs.
 */

/** Directory names never treated as authored files. */
export declare const EXCLUDED_DIRS: string[];
/** Files authored in this repository (excludes deps, builds, artifacts, local secrets). */
export declare function authoredFiles(root?: string): string[];
/** Secret patterns: [name, regular expression]. */
export declare const SECRET_PATTERNS: Array<[string, RegExp]>;
/** Scans files for secrets; returns findings ("path: pattern name"). */
export declare function scanSecrets(files: string[], root?: string): string[];
/** Longest a dependency-audit exception may run before it must be re-decided (days). */
export declare const AUDIT_EXCEPTION_MAX_DAYS: number;
/** Dependency-audit policy (see lib.mjs). */
export declare function evaluateAudit(input: {
  advisories: Array<{ id: string; severity: string; module: string }>;
  prodIds: Set<string>;
  exceptions: Array<{ advisory: string; recorded: string; expires: string }>;
  today: string;
}): { ok: boolean; blocking: string[]; accepted: string[]; warnings: string[] };
