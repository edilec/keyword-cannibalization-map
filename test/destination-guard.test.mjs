import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * The map destination, driven through the real binary.
 *
 * This file exists because knowing about a hole does not close it. Measured
 * across this catalog: ten tools accepted a destination that overwrote a file
 * they were never asked to touch and four of them exited 0 saying the write
 * succeeded. This tool was one of them, twice over. Measured before the fix:
 *
 *   - a symbolic link at `--map` pointing at a file in another tree replaced
 *     that file with the map. Exit 0, stderr `map written`. Resolving the link
 *     is what *made* the destination look legitimate: the resolved path was
 *     outside the export root, which is exactly what this tool requires.
 *   - a hard link at `--map` to one of the exports replaced that export with
 *     the map -- 513 bytes of CSV became 9239 bytes of JSON, on a file the run
 *     had just read. Exit 0, stderr `map written`.
 *
 * Three holes, and each needs its own case because no one of them catches the
 * others. The root test is inverted here: the map is a derived artifact, so it
 * must stay *out* of the export root rather than inside one. The mechanism is
 * the same and only the direction of the answer differs.
 *
 * The allowed cases are not optional: a guard that refuses everything passes
 * every data-loss case above while making the tool useless.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/keyword-cannibalization-map.mjs')

const HEADER = 'query,page,region,locale,impressions,clicks,position'
const ROWS = [
  HEADER,
  'blue widgets,https://example.invalid/a,GB,en-gb,900,40,3.1',
  'blue widgets,https://example.invalid/b,GB,en-gb,700,10,7.4',
  '',
].join('\n')

const PRECIOUS = 'a file this run was never asked to touch\n'

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/**
 * An export root, a separate place the map may legitimately go, and a third
 * tree holding the file no argument to this tool ever names.
 */
async function withScene(body) {
  const scene = await realpath(await mkdtemp(join(tmpdir(), 'kcm-destination-')))
  try {
    const exports = join(scene, 'exports')
    const dest = join(scene, 'dest')
    const outside = join(scene, 'outside')
    await mkdir(exports)
    await mkdir(dest)
    await mkdir(outside)
    await writeFile(join(exports, 'search-console.csv'), ROWS)
    return await body({ scene, exports, dest, outside })
  } finally {
    await rm(scene, { recursive: true, force: true })
  }
}

/** Every refusal is a configuration error: exit 2, empty stdout, no report. */
function assertRefused(result, needle) {
  assert.equal(result.code, 2, `expected exit 2, got ${result.code}`)
  assert.equal(result.stdout, '', 'a refused destination is a configuration error, so stdout carries no report')
  assert.equal(result.stderr.includes(needle), true, `stderr did not mention "${needle}": ${result.stderr}`)
}

test('HOLE 1: a symlink at the destination is refused, and the file it points at survives', async () => {
  await withScene(async ({ exports, dest, outside }) => {
    const victim = join(outside, 'victim.txt')
    await writeFile(victim, PRECIOUS)
    await symlink(victim, join(dest, 'map.json'))

    const result = await cli(['--root', exports, '--map', join(dest, 'map.json'), '--json'])

    assertRefused(result, 'is a symbolic link')
    assert.equal(await readFile(victim, 'utf8'), PRECIOUS, 'the file the link pointed at must be untouched')
  })
})

test('HOLE 1: a symlink whose target does not exist yet creates nothing at the path nobody named', async () => {
  await withScene(async ({ exports, dest, outside }) => {
    const absent = join(outside, 'not-yet.json')
    await symlink(absent, join(dest, 'map.json'))

    const result = await cli(['--root', exports, '--map', join(dest, 'map.json'), '--json'])

    assertRefused(result, 'is a symbolic link')
    await assert.rejects(() => stat(absent), /ENOENT/, 'a dangling link must not become a new file somewhere else')
    assert.deepEqual(await readdir(outside), [])
  })
})

test('HOLE 2: a symlinked parent leading back into the export root is refused', async () => {
  await withScene(async ({ exports, dest }) => {
    // `dest/bridge` is lexically outside the export root and really is not.
    await symlink(exports, join(dest, 'bridge'))
    const before = await readdir(exports)

    const result = await cli(['--root', exports, '--map', join(dest, 'bridge', 'map.json'), '--json'])

    assertRefused(result, 'inside the export root')
    assert.deepEqual(await readdir(exports), before, 'nothing was added to the export set')
  })
})

test('HOLE 3: a hard link to an export is refused on device and inode, not on path', async () => {
  await withScene(async ({ exports, dest }) => {
    const source = join(exports, 'search-console.csv')
    const alias = join(dest, 'map.json')
    await link(source, alias)

    assert.notEqual(await realpath(source), await realpath(alias), 'this is exactly why realpath is the wrong test')

    const result = await cli(['--root', exports, '--map', alias, '--json'])

    assertRefused(result, 'same file as the export search-console.csv')
    assert.equal(await readFile(source, 'utf8'), ROWS, 'the export this run read must be exactly as it was')
  })
})

test('a destination inside the export root is refused, symlink or not', async () => {
  await withScene(async ({ exports }) => {
    const result = await cli(['--root', exports, '--map', join(exports, 'map.json'), '--json'])

    assertRefused(result, 'inside the export root')
    assert.deepEqual((await readdir(exports)).sort(), ['search-console.csv'])
  })
})

test('a destination that is a directory is refused rather than opened', async () => {
  await withScene(async ({ exports, dest }) => {
    await mkdir(join(dest, 'map.json'))

    const result = await cli(['--root', exports, '--map', join(dest, 'map.json'), '--json'])

    assertRefused(result, 'not a regular file')
    assert.equal((await stat(join(dest, 'map.json'))).isDirectory(), true)
  })
})

/**
 * The allowed cases. A guard that refuses everything passes every case above.
 */

test('ALLOWED: a new file outside the export root is written', async () => {
  await withScene(async ({ exports, dest }) => {
    const out = join(dest, 'map.json')

    const result = await cli(['--root', exports, '--map', out, '--json'])

    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(await readFile(out, 'utf8')).tool, 'keyword-cannibalization-map')
  })
})

test('ALLOWED: a destination whose directory does not exist yet is created and written', async () => {
  await withScene(async ({ exports, dest }) => {
    const out = join(dest, 'nested', 'deeper', 'map.json')

    const result = await cli(['--root', exports, '--map', out, '--json'])

    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(await readFile(out, 'utf8')).candidates.length >= 1, true)
  })
})

test('ALLOWED: an existing regular file that is not an export is replaced', async () => {
  await withScene(async ({ exports, dest }) => {
    const out = join(dest, 'map.json')
    await writeFile(out, 'stale\n')

    const result = await cli(['--root', exports, '--map', out, '--json'])

    assert.equal(result.code, 0, result.stderr)
    assert.equal((await readFile(out, 'utf8')).includes('stale'), false)
  })
})

test('ALLOWED: a symlinked parent that stays out of the export root is not falsely refused', async () => {
  await withScene(async ({ scene, exports, dest }) => {
    // The parent is a link, and it does not lead into the export set. Refusing
    // this would be a false refusal, which is a defect too.
    const real = join(scene, 'real-build')
    await mkdir(real)
    await symlink(real, join(dest, 'build'))
    const out = join(dest, 'build', 'map.json')

    const result = await cli(['--root', exports, '--map', out, '--json'])

    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(await readFile(join(real, 'map.json'), 'utf8')).tool, 'keyword-cannibalization-map')
  })
})

test('ALLOWED: an export root reached through a symlink is not falsely refused', async () => {
  await withScene(async ({ scene, exports, dest }) => {
    const linked = join(scene, 'linked-exports')
    await symlink(exports, linked)
    const out = join(dest, 'map.json')

    const result = await cli(['--root', linked, '--map', out, '--json'])

    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(await readFile(out, 'utf8')).tool, 'keyword-cannibalization-map')
  })
})
