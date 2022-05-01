/**
 * keyword-cannibalization-map -- the output-destination guard.
 *
 * A tool that writes anything can destroy the wrong file. Measured across this
 * catalog rather than imagined: ten tools accepted a destination that overwrote
 * something they were never asked to touch, and four of them exited 0 saying
 * the write succeeded. This tool was one of them -- a symbolic link at `--map`
 * carried the derived map onto a file in another tree entirely, and the run
 * exited 0 with `map written` on stderr. A hard link to an export did the same
 * to an export the run had just read.
 *
 * Three holes, and each needs its own check because no one of them catches the
 * others:
 *
 * 1. A SYMLINK AT THE DESTINATION writes wherever the link points, which may be
 *    anywhere on the machine. `realpath` on the destination does not help -- it
 *    resolves the link, and resolving is precisely the dangerous act. Resolving
 *    it was in fact how this tool decided the destination was "outside the
 *    export root" and therefore allowed. The link is refused on sight, by
 *    `lstat`, before anything is resolved. A link whose target does not exist
 *    yet is refused by the same check, so a dangling link cannot quietly create
 *    a file at a path the caller never named.
 * 2. A SYMLINKED PARENT does the same thing one level up, so the parent is
 *    resolved and then compared. A lexical comparison passes for
 *    `elsewhere/link/map.json` where `link` leads back into the export set.
 * 3. A HARD LINK TO AN INPUT has no target to resolve and shares no path with
 *    the input, so `realpath` and string comparison both say it is a different
 *    file. It is the same file. Only device plus inode sees that.
 *
 * `--map` is not a safe place to put a path the tool has not checked, and "the
 * caller named it" is not a check: the caller named a path, not the file the
 * path resolves to.
 *
 * **The root test is inverted here, and deliberately.** The map is a derived
 * artifact about the export set, so it must land *outside* the export root
 * rather than inside one: a map written among the exports becomes an input to
 * the next run. So `exportRoot` names the tree the destination must stay out
 * of, where a sibling tool's `root` names the tree its destination must stay
 * inside. The mechanism is the same -- resolve, then compare -- and only the
 * direction of the answer differs.
 *
 * A refused destination is a configuration error. The CLI exits 2 with an empty
 * stdout, because a run that never had a usable destination has nothing to
 * report about one.
 */

import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** How far up the tree the nearest existing ancestor is looked for. */
const ANCESTOR_PROBE_LIMIT = 64

/** Raised when a destination cannot be written to safely. The caller exits 2. */
export class DestinationError extends TypeError {
  constructor(message) {
    super(message)
    this.name = 'DestinationError'
  }
}

/** True when `candidate` is `root` itself or lies beneath it. Both must be real paths. */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * The real path of the destination's parent, found without resolving anything
 * the caller may not have meant.
 *
 * The destination usually does not exist yet, and neither does the directory
 * that will hold it -- `--map build/cannibalization.map.json` is the documented
 * case -- so the nearest existing ancestor is resolved and the segments below
 * it are appended lexically. Nothing in that tail exists, so nothing in it can
 * be a symbolic link: the result is a path that cannot escape the ancestor this
 * function actually resolved.
 */
async function resolveParent(target, label) {
  const tail = []
  let probe = dirname(target)

  for (let step = 0; step < ANCESTOR_PROBE_LIMIT; step += 1) {
    try {
      const real = await realpath(probe)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new DestinationError(`${label} could not be resolved: ${error.code ?? 'unknown error'}`)
      }
      const parent = dirname(probe)
      if (parent === probe) throw new DestinationError(`${label} has no existing ancestor directory`)
      tail.unshift(basename(probe))
      probe = parent
    }
  }
  throw new DestinationError(`${label} is nested too deeply to resolve`)
}

/**
 * Refuse an output destination that would write somewhere the caller did not
 * name, or over something the caller is reading.
 *
 * Called twice by design: once before any export is read, so a bad destination
 * fails with no report rather than half a run, and once immediately before the
 * write, when `inputs` finally exists. Identity can only be compared against
 * inputs the run has actually opened, and the second call is the one that
 * stands between the write and an export.
 *
 * @param {string} destination Path as the caller wrote it.
 * @param {object} [options]
 * @param {Array<{label: string, dev: number, ino: number}>} [options.inputs]
 *   Identities of the exports this run read. Empty on the pre-flight call.
 * @param {string|null} [options.exportRoot] Real path the destination must stay OUT of.
 * @param {string} [options.label] Option name to name in a refusal.
 * @returns {Promise<string>} The path that is safe to write, parent resolved.
 */
export async function assertWritableDestination(destination, options = {}) {
  const { inputs = [], exportRoot = null, label = '--map' } = options
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw new DestinationError(`${label} must be a non-empty path`)
  }
  const target = resolve(destination)

  let existing = null
  try {
    existing = await lstat(target)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new DestinationError(`${label} could not be inspected: ${error.code ?? 'unknown error'}`)
    }
  }

  if (existing !== null && existing.isSymbolicLink()) {
    throw new DestinationError(
      `${label} is a symbolic link. Writing through it would put the map wherever the link `
      + 'points, which is not the path you named, so it is refused. Name the real destination.',
    )
  }
  if (existing !== null && !existing.isFile()) {
    throw new DestinationError(`${label} exists and is not a regular file.`)
  }

  const parent = await resolveParent(target, label)
  const final = join(parent, basename(target))

  if (exportRoot !== null && isInside(exportRoot, final)) {
    throw new DestinationError(
      `${label} is inside the export root; the map is a derived artifact and must be written `
      + 'elsewhere, or the next run reads it as an export. A symbolic link on the way there does '
      + 'not make it elsewhere.',
    )
  }

  if (existing === null) return final

  // Same file as an export? Compare identity, not paths. The exports are all
  // inside a root this destination is required to stay out of, which is exactly
  // why a path comparison is no answer: a hard link shares no path with the
  // file it is a second name for.
  for (const input of inputs) {
    if (input.dev === existing.dev && input.ino === existing.ino) {
      throw new DestinationError(
        `${label} is the same file as the export ${input.label}; this run would destroy what it `
        + `just read. They share device ${existing.dev} and inode ${existing.ino}, so a hard link `
        + 'does not make them different files.',
      )
    }
  }
  return final
}
