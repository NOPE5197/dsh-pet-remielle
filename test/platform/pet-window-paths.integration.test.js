import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Platform integration test: needs a real child process to verify the exited PID; should be
// run by CI in a restricted sandbox.
const require = createRequire(import.meta.url)
const paths = require('../../src/pet-window-paths.cjs')

/** One independent temporary root directory per case, the whole directory removed afterwards (only the one we created). */
function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-paths-'))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('isProcessAlive rejects junk input and reports ESRCH as dead / EPERM as alive', () => {
  assert.equal(paths.isProcessAlive(0), false)
  assert.equal(paths.isProcessAlive(-5), false)
  assert.equal(paths.isProcessAlive(Number.NaN), false)
  assert.equal(paths.isProcessAlive(process.pid), true, 'our own pid is necessarily alive')

  // Take a real pid that is certainly exited (the child is already finished when spawnSync
  // returns). Not a fixed big number: it may fall inside the valid range on some
  // platforms/containers, which makes the assertion flip red at random.
  const exited = spawnSync(process.execPath, ['-e', '0'])
  assert.ok(Number.isInteger(exited.pid) && exited.pid > 0)
  assert.equal(paths.isProcessAlive(exited.pid), false)

  // EPERM = the process exists but the signal may not be sent (the NodeService host of DSH
  // Desktop is exactly that case). Hard to construct for real, so replace process.kill's
  // behaviour to pin this branch.
  const original = process.kill
  process.kill = () => {
    const error = new Error('operation not permitted')
    error.code = 'EPERM'
    throw error
  }
  try {
    assert.equal(paths.isProcessAlive(1234), true, 'EPERM must count as alive, otherwise a living host gets killed')
  } finally {
    process.kill = original
  }
})
