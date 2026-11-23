/**
 * Rebuilds the committed wasm artifacts:
 *   - `src/core/detect/pii-scan.wasm` from `wasm/pii-scan`
 *   - `src/core/ooxml/codec.wasm` from `wasm/codec`
 *
 * The compiled artifacts are committed so `bun run build` does not require a
 * Rust toolchain. Run this after changing either crate:
 *   bun run build:wasm
 */

import { copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

// Rust embeds panic locations as absolute paths. Remap the cargo home and the
// repository root so a local Windows/macOS username or checkout path never
// ends up in the committed WASM artifacts.
const REMAP_FLAGS = [`--remap-path-prefix=${homedir()}=/build`, `--remap-path-prefix=${root}=/src`];

const targets = [
  {
    name: 'pii-scan',
    manifest: join(root, 'wasm', 'pii-scan', 'Cargo.toml'),
    built: join(
      root,
      'wasm',
      'pii-scan',
      'target',
      'wasm32-unknown-unknown',
      'release',
      'pii_scan.wasm',
    ),
    target: join(root, 'src', 'core', 'detect', 'pii-scan.wasm'),
  },
  {
    name: 'codec',
    manifest: join(root, 'wasm', 'codec', 'Cargo.toml'),
    built: join(root, 'wasm', 'codec', 'target', 'wasm32-unknown-unknown', 'release', 'codec.wasm'),
    target: join(root, 'src', 'core', 'ooxml', 'codec.wasm'),
  },
];

for (const entry of targets) {
  const result = Bun.spawnSync(
    [
      'cargo',
      'build',
      '--release',
      '--target',
      'wasm32-unknown-unknown',
      '--manifest-path',
      entry.manifest,
    ],
    {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
      // `CARGO_ENCODED_RUSTFLAGS` keeps paths with spaces intact and, unlike
      // `RUSTFLAGS`, is passed to rustc as separate arguments.
      env: {
        ...process.env,
        CARGO_ENCODED_RUSTFLAGS: [
          ...(process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f') ?? []),
          ...REMAP_FLAGS,
        ].join('\x1f'),
      },
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`${entry.name}: cargo build failed with exit code ${result.exitCode}`);
  }
  copyFileSync(entry.built, entry.target);
  console.log(`[wasm] ${entry.target}`);
}
