#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const TEMP_DIR_EBUSY_WARNING = 'vitest-pool-worker: Unable to remove temporary directory:';

function resolveVitestCli() {
  const packageJsonPath = require.resolve('vitest/package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const binEntry =
    typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.vitest;

  if (!binEntry) {
    throw new Error('Unable to resolve Vitest binary path from vitest/package.json');
  }

  return path.resolve(path.dirname(packageJsonPath), binEntry);
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function shouldSuppress(line) {
  const normalized = stripAnsi(line);
  return normalized.includes(TEMP_DIR_EBUSY_WARNING) && normalized.includes('EBUSY');
}

function pipeWithFilter(stream, target) {
  let buffered = '';

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';

    for (const line of lines) {
      if (!shouldSuppress(line)) {
        target.write(`${line}\n`);
      }
    }
  });

  stream.on('end', () => {
    if (buffered.length > 0 && !shouldSuppress(buffered)) {
      target.write(buffered);
    }
  });
}

const vitestCli = resolveVitestCli();
const args = process.argv.slice(2);

const child = spawn(process.execPath, [vitestCli, ...args], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
});

pipeWithFilter(child.stdout, process.stdout);
pipeWithFilter(child.stderr, process.stderr);

child.on('error', (error) => {
  process.stderr.write(`Failed to start Vitest: ${error.message}\n`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
