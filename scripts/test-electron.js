// Runs the node:test suite on Electron's embedded Node (PLAN G5).
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron') // in plain Node this resolves to the binary path

const args = ['--test', '--test-concurrency=1', '--test-timeout=120000', ...(process.argv.slice(2).length ? process.argv.slice(2) : ['test/*.test.js'])]
const child = spawn(electron, args, {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1))
