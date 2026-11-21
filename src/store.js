/**
 * Independent storage root for the AI database assistant plugin.
 *
 * Design note: this plugin owns its own directory tree instead of opening a
 * host storage domain. Reasons:
 *   1. `@deepseek-ai/dsh-storage-domain` is not guaranteed to be mounted (in
 *      this deployment its Loader row is disabled), and a plugin that cannot
 *      persist cannot be trusted with analysis records.
 *   2. Analysis records need adjacency between structured JSON, raw imported
 *      files, and binary evidence packs; a KV domain would force those into
 *      blobs.
 *   3. The requirement is isolation from `data_agent_connections` /
 *      `data_agent_catalog`, and a private root guarantees the isolation structurally.
 *
 * Every write is atomic (fsync + temp file + rename in the same directory) and
 * serialized per path, so a crash or a concurrent route call cannot leave a
 * half-written project/result record behind.
 *
 * @module src/store
 */
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';

import {hostPlatform, isPathInside} from './core/user-path.js';

/**
 * A stored JSON file exists but cannot be parsed.
 *
 * This is deliberately distinct from "file is missing": callers that own
 * durable configuration must not treat a corrupt file as a fresh empty state,
 * because writing the empty fallback back would silently replace the user's
 * data. `filePath` points at the original file, which is never modified or
 * renamed by this error path.
 */
export class StoreCorruptError extends Error {
  /**
   * @param {string} relative relative store path.
   * @param {string} filePath absolute path on disk.
   * @param {unknown} cause parse error.
   */
  constructor(relative, filePath, cause) {
    super(`存储文件损坏，无法解析：${relative}`);
    this.name = 'StoreCorruptError';
    this.code = 'STORE_CORRUPT';
    this.relative = relative;
    this.filePath = filePath;
    this.cause = cause;
  }
}

/**
 * Guard against a computed path escaping the storage root.
 *
 * Uses real path relationships instead of a string prefix: on Windows a
 * cross-drive target makes `path.win32.relative()` return an absolute path, and
 * a literal `startsWith` test would wrongly call that target "inside".
 *
 * @param {string} root absolute root directory.
 * @param {string} target absolute target path.
 * @returns {string} the target when the target is inside the root.
 * @throws {Error} when the target escapes the root.
 */
export function assertInside(root, target) {
  if (isPathInside(root, target, {platform: hostPlatform()})) return target;
  throw new Error(`路径越出插件存储根目录：${target}`);
}

/**
 * Atomic, serialized JSON/text store rooted at one directory.
 */
export class JsonStore {
  /** @type {string} */
  #root;
  /** @type {Map<string, Promise<unknown>>} */
  #queues = new Map();
  /** @type {{debug?: Function, warn?: Function, info?: Function}} */
  #logger;

  /**
   * @param {string} root absolute storage root.
   * @param {{logger?: object}} [options] optional logger.
   */
  constructor(root, options = {}) {
    this.#root = resolve(root);
    this.#logger = options.logger ?? {};
  }

  /** @returns {string} absolute storage root. */
  get root() {
    return this.#root;
  }

  /**
   * Resolve one path inside the root.
   *
   * @param {...string} parts relative path parts.
   * @returns {string} absolute path.
   */
  path(...parts) {
    for (const part of parts) {
      const text = String(part ?? '');
      // A computed identifier must stay one relative path. Absolute parts,
      // drive-qualified parts, NUL characters and `..` segments are never a
      // valid store member, so reject them before string concatenation can
      // walk outside the root or into a sibling project.
      if (text.includes('\0')) throw new Error(`路径越出插件存储根目录：非法字符`);
      if (isAbsolute(text) || /^[A-Za-z]:/.test(text) || text.startsWith('\\\\')) {
        throw new Error(`路径越出插件存储根目录：${text}`);
      }
      for (const segment of text.split(/[\\/]+/)) {
        if (segment === '..') throw new Error(`路径越出插件存储根目录：${text}`);
      }
    }
    return assertInside(this.#root, join(this.#root, ...parts));
  }

  /**
   * Reject a target whose real parent resolves outside the storage root.
   *
   * The lexical containment above cannot see a junction/symlink created inside
   * the root (Windows junction, POSIX symlink). Resolving the parent's real path
   * makes such a link fail closed instead of redirecting a write or read.
   *
   * @param {string} target absolute target path.
   * @returns {Promise<void>} resolves when the real parent is inside the root.
   * @throws {Error} when the real parent escapes the root.
   */
  async #assertRealInside(target) {
    const realRoot = await fs.realpath(this.#root).catch(() => this.#root);
    const parent = dirname(target);
    const realParent = await fs.realpath(parent).catch(() => null);
    if (realParent === null) return;
    if (!isPathInside(realRoot, realParent, {platform: hostPlatform()})) {
      throw new Error(`路径越出插件存储根目录（真实路径）：${target}`);
    }
    // A link at the target itself is not redirected by the parent check: an
    // atomic write replaces it, but read/append/copy would follow it outside.
    // No legitimate store member is a symlink, so reject it outright.
    const info = await fs.lstat(target).catch(() => null);
    if (info !== null && info.isSymbolicLink()) {
      throw new Error(`路径越出插件存储根目录（符号链接）：${target}`);
    }
  }

  /**
   * Create a directory (recursively).
   *
   * @param {...string} parts relative path parts.
   * @returns {Promise<string>} absolute directory path.
   */
  async ensureDir(...parts) {
    const target = this.path(...parts);
    await fs.mkdir(target, {recursive: true, mode: 0o700});
    await this.#assertRealInside(target);
    // Tighten directories created before the mode existed; best effort only.
    await fs.chmod(target, 0o700).catch(() => {});
    return target;
  }

  /**
   * Read and parse a JSON file, returning a fallback when the file does not exist.
   *
   * `options.corrupt` separates the two states a JSON file can be in:
   *   * `'fallback'` (default) keeps the historical behavior: the damaged file is
   *     quarantined as `<name>.corrupt-<stamp>` and the fallback is returned. Only
   *     files whose content is disposable (result indexes rebuilt elsewhere) may
   *     use this.
   *   * `'throw'` is for durable configuration (the project registry): it throws
   *     `StoreCorruptError` and leaves the original file untouched, so no later
   *     write can silently replace a corrupt registry with an empty one. A
   *     missing file still returns the fallback, which is the genuine
   *     first-start state.
   *
   * @template T
   * @param {string} relative relative file path.
   * @param {T} fallback value used when the file is missing.
   * @param {{corrupt?: 'fallback' | 'throw'}} [options] corrupt-file policy.
   * @returns {Promise<T>} parsed content.
   */
  async readJson(relative, fallback, options = {}) {
    const target = this.path(relative);
    try {
      await this.#assertRealInside(target);
      const raw = await fs.readFile(target, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      if (error instanceof SyntaxError) {
        if (options.corrupt === 'throw') {
          // Leave the bytes exactly where they are: renaming would make the next
          // read look like a fresh install and reopen the silent-overwrite path.
          throw new StoreCorruptError(relative, target, error);
        }
        // Keep the damaged file instead of letting the next write silently
        // replace the file: a corrupt project/result index is evidence, not garbage.
        await fs.rename(target, `${target}.corrupt-${Date.now()}`).catch(() => {});
        this.#logger.warn?.(`ai-database-assistant: 存储文件损坏，已隔离并忽略内容：${relative}`);
        return fallback;
      }
      throw error;
    }
  }

  /**
   * Write JSON atomically and durably.
   *
   * @param {string} relative relative file path.
   * @param {unknown} value JSON-compatible value.
   * @returns {Promise<void>} resolves after rename.
   */
  async writeJson(relative, value) {
    await this.writeText(relative, `${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * Read a text file.
   *
   * @param {string} relative relative file path.
   * @param {string} [fallback] value used when missing.
   * @returns {Promise<string>} file text.
   */
  async readText(relative, fallback = '') {
    try {
      await this.#assertRealInside(this.path(relative));
      return await fs.readFile(this.path(relative), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  /**
   * Write text atomically, serialized per path.
   *
   * @param {string} relative relative file path.
   * @param {string} text content.
   * @returns {Promise<void>} resolves after rename.
   */
  async writeText(relative, text) {
    const target = this.path(relative);
    const previous = this.#queues.get(target) ?? Promise.resolve();
    const task = previous.then(async () => {
      await fs.mkdir(dirname(target), {recursive: true, mode: 0o700});
      await this.#assertRealInside(target);
      const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
      // fsync before rename: a crash right after the rename must not leave an
      // empty/partial file that looks successfully written.
      const handle = await fs.open(temporary, 'w', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.rm(temporary, {force: true}).catch(() => {});
        throw error;
      }
      await handle.close();
      try {
        await fs.rename(temporary, target);
      } catch (error) {
        // The write branch above already cleans up; a rename failure must not
        // leave a temp file behind for the next startup to trip over.
        await fs.rm(temporary, {force: true}).catch(() => {});
        throw error;
      }
    });
    const queued = task.catch(() => {});
    this.#queues.set(target, queued);
    try {
      await task;
    } finally {
      if (this.#queues.get(target) === queued) this.#queues.delete(target);
    }
  }

  /**
   * Append one line to a JSONL file.
   *
   * Appending is serialized with the same queue as rewriting, so a concurrent
   * reader never sees a partial line.
   *
   * @param {string} relative relative file path.
   * @param {unknown} value JSON-compatible value.
   * @returns {Promise<void>} resolves after the append.
   */
  async appendJsonl(relative, value) {
    const target = this.path(relative);
    const previous = this.#queues.get(target) ?? Promise.resolve();
    const task = previous.then(async () => {
      await fs.mkdir(dirname(target), {recursive: true, mode: 0o700});
      await this.#assertRealInside(target);
      const handle = await fs.open(target, 'a', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.chmod(target, 0o600).catch(() => {});
    });
    const queued = task.catch(() => {});
    this.#queues.set(target, queued);
    try {
      await task;
    } finally {
      if (this.#queues.get(target) === queued) this.#queues.delete(target);
    }
  }

  /**
   * Read a JSONL file into memory.
   *
   * @param {string} relative relative file path.
   * @returns {Promise<object[]>} parsed lines; malformed lines are skipped.
   */
  async readJsonl(relative) {
    const text = await this.readText(relative, '');
    const rows = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        this.#logger.warn?.(`ai-database-assistant: 跳过无法解析的 JSONL 行：${relative}`);
      }
    }
    return rows;
  }

  /**
   * List directory entries.
   *
   * @param {string} [relative] relative directory.
   * @returns {Promise<import('node:fs').Dirent[]>} entries sorted by name.
   */
  async list(relative = '.') {
    try {
      const entries = await fs.readdir(this.path(relative), {withFileTypes: true});
      return entries.sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  /**
   * Whether a path exists.
   *
   * @param {string} relative relative path.
   * @returns {Promise<boolean>} existence.
   */
  async exists(relative) {
    try {
      await fs.access(this.path(relative));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Copy a file into the store.
   *
   * @param {string} source absolute source path.
   * @param {string} relative destination relative path.
   * @returns {Promise<void>} resolves after copy.
   */
  async copyIn(source, relative) {
    const target = this.path(relative);
    await fs.mkdir(dirname(target), {recursive: true, mode: 0o700});
    await this.#assertRealInside(target);
    await fs.copyFile(source, target);
    await fs.chmod(target, 0o600).catch(() => {});
  }

  /**
   * SHA-256 of a stored file.
   *
   * @param {string} relative relative file path.
   * @returns {Promise<string>} hex digest.
   */
  async hashFile(relative) {
    const bytes = await fs.readFile(this.path(relative));
    return createHash('sha256').update(bytes).digest('hex');
  }

  /**
   * Remove one stored file (analysis records use append-only history, so callers
   * are expected to retire rather than delete).
   *
   * @param {string} relative relative file path.
   * @returns {Promise<void>} resolves after removal.
   */
  async remove(relative) {
    try {
      await fs.unlink(this.path(relative));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  /**
   * Absolute path of the storage root for a project.
   *
   * @param {string} projectId project id.
   * @returns {string} absolute path.
   */
  projectPath(projectId) {
    return this.path('projects', projectId);
  }
}

/**
 * Build the storage root used by this plugin.
 *
 * @param {string} dshHome value of DSH_HOME.
 * @returns {string} absolute root.
 */
export function defaultStorageRoot(dshHome) {
  return join(dshHome, 'ai-database-assistant');
}
