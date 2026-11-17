/**
 * @file Type declarations for scripts/dev-env.mjs, so TypeScript tests can import its helpers
 * (owning module: repository tooling).
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process';

/** Repository root (scripts/..). */
export declare const ROOT: string;
/** Spawn arguments that also work on Windows (quoted for cmd.exe there; no shell elsewhere). */
export declare function shellSafe(cmd: string, args: readonly string[], platform?: string): { cmd: string; args: string[]; shell: boolean };
/** Starts a long-running tool so that `killTree` can stop it with all its descendants. */
export declare function startTree(cmd: string, args: readonly string[], opts?: SpawnOptions): ChildProcess;
/** Stops a process started with `startTree` and all its descendants. */
export declare function killTree(child: ChildProcess): void;
/** Parses a dotenv file (KEY=VALUE, # comments). */
export declare function parseEnvFile(file: string): Record<string, string>;
/** Ensures .env exists with generated dev secrets and loads it into process.env. */
export declare function ensureDevEnv(): Record<string, string>;
