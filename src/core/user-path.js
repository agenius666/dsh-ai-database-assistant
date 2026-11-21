/**
 * User-supplied filesystem path rules.
 *
 * Why this module exists: a path a user types in the workbench is executed by
 * the **DSH Host** process, not by the browser. The Host is a Windows process
 * on Windows and a POSIX process on macOS/Linux, so the only correct absolute
 * path rule is the rule of the machine that will touch the filesystem. Mixing
 * the two (for example "the path must start with `/`") silently rejects every
 * valid Windows path.
 *
 * Two deliberate layers:
 *   1. `validateUserPath` is pure: syntax and platform shape only. It never
 *      touches the filesystem and never creates anything.
 *   2. `describeFsError` turns a real `fs` failure into one accurate business
 *      error, so the UI can distinguish "not absolute" from "missing",
 *      "not a folder", "no permission" and "cannot write".
 *
 * Platform injection: every function takes `{platform}` so Windows rules can be
 * unit-tested on macOS through `path.win32`. That is a **simulation** of the
 * Windows parser, not proof that a Windows filesystem accepted the path; real
 * Windows coverage comes from the CI matrix running on `windows-latest`.
 *
 * @module src/core/user-path
 */
import path from 'node:path';

import {AssistantError, ERROR_CODES} from './errors.js';

/** Platform id used by this module. */
export const PLATFORM_WIN32 = 'win32';
/** Platform id used for macOS and Linux. */
export const PLATFORM_POSIX = 'posix';

/** Windows device namespace (`\\?\` and `\\.\`) — never accepted as user input. */
const WINDOWS_DEVICE_PREFIX = /^\\\\[?.]\\/;
/** `C:\...` / `C:/...` — a complete Windows drive path. */
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
/** `C:Results` — drive-relative; must never be treated as `C:\Results`. */
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;
/** `\\server\share\...` (or `//server/share/...`) — UNC needs a server and a share. */
const WINDOWS_UNC = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/;
/** Windows reserved device names, with or without an extension. */
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])(?:\.|$)/i;
/**
 * Reserved device name even when a space sits before the extension.
 *
 * `CON .txt` still opens the console device on Windows, so a directory or file
 * base name must be treated exactly like `CON.txt`.
 */
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])(?:[ .]|$)/i;
/** Characters Windows never allows inside a path segment (a colon is also NTFS ADS). */
const WINDOWS_ILLEGAL_SEGMENT = /[:*?"<>|]/;
/** Control characters are illegal on Windows and unusable in a typed path. */
const CONTROL_CHARACTERS = /[\u0000-\u001f]/;
/** Default user-facing cap for a delivery base name. */
const DEFAULT_BASE_NAME_LENGTH = 80;
/** Defensive ceiling for a user path string. */
export const MAX_USER_PATH_LENGTH = 4096;

/**
 * Platform of the process that executes filesystem operations (the Host).
 *
 * @returns {'win32'|'posix'} platform id.
 */
export function hostPlatform() {
  return process.platform === 'win32' ? PLATFORM_WIN32 : PLATFORM_POSIX;
}

/**
 * Path API for one platform.
 *
 * @param {'win32'|'posix'} platform platform id.
 * @returns {import('node:path').PlatformPath} path API.
 */
export function pathApiFor(platform) {
  if (platform === PLATFORM_WIN32) return path.win32;
  if (platform === PLATFORM_POSIX) return path.posix;
  throw new TypeError(`未知的平台标识：${String(platform)}`);
}

/**
 * Human-readable name of the executing platform.
 *
 * @param {'win32'|'posix'} [platform] platform id; defaults to the Host.
 * @returns {string} label.
 */
export function hostPlatformLabel(platform = hostPlatform()) {
  if (platform === PLATFORM_WIN32) return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}

/**
 * Whether a string is a complete absolute path under one platform's rules.
 *
 * This is the rule the *target* filesystem uses, so it dispatches on the
 * injected platform rather than on `node:path` (which follows the local host).
 *
 * @param {unknown} input candidate.
 * @param {{platform?: 'win32'|'posix'}} [options] platform id.
 * @returns {boolean} true when the string is absolute for that platform.
 */
export function isUserAbsolutePath(input, options = {}) {
  if (typeof input !== 'string' || input === '') return false;
  const platform = options.platform ?? hostPlatform();
  if (CONTROL_CHARACTERS.test(input)) return false;
  if (platform === PLATFORM_WIN32) {
    if (WINDOWS_DEVICE_PREFIX.test(input)) return false;
    return path.win32.isAbsolute(input)
      && (WINDOWS_DRIVE_ABSOLUTE.test(input) || WINDOWS_UNC.test(input));
  }
  if (WINDOWS_DRIVE_ABSOLUTE.test(input) || WINDOWS_DRIVE_RELATIVE.test(input)) return false;
  if (input.startsWith('\\\\')) return false;
  return path.posix.isAbsolute(input);
}

/**
 * Split a path into raw segments using that platform's separators.
 *
 * @param {string} input path text.
 * @param {'win32'|'posix'} platform platform id.
 * @returns {string[]} segments.
 */
function segmentsOf(input, platform) {
  if (platform === PLATFORM_WIN32) return input.split(/[\\/]+/);
  return input.split('/');
}

/**
 * Reject the segments Windows cannot use, even though `path.win32` accepts them.
 *
 * @param {string[]} segments path segments.
 * @param {boolean} isUnc whether the path is a UNC path.
 * @param {string} label user-facing field name.
 * @returns {void}
 * @throws {AssistantError} on an unusable segment.
 */
function assertUsableWindowsSegments(segments, isUnc, label) {
  // A UNC path starts with two empty segments plus server/share; reserved device
  // names only apply to local directory names, but every segment must still be
  // free of characters Windows cannot store.
  const localStart = isUnc ? 4 : 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === '' || segment === '.' || segment === '..') continue;
    if (/^[A-Za-z]:$/.test(segment)) continue;
    if (WINDOWS_ILLEGAL_SEGMENT.test(segment)) {
      throw new AssistantError(ERROR_CODES.invalidInput, `${label}包含 Windows 不支持的字符（: * ? " < > |）：${segment}`);
    }
    if (/[. ]$/.test(segment)) {
      throw new AssistantError(ERROR_CODES.invalidInput, `${label}中有以点或空格结尾的片段，Windows 无法可靠使用该路径：${segment}`);
    }
    if (index >= localStart && WINDOWS_RESERVED_NAME.test(segment.trimEnd())) {
      throw new AssistantError(ERROR_CODES.invalidInput, `${label}中包含 Windows 保留名称（如 CON、NUL、COM1），请改名后重试：${segment}`);
    }
  }
}

/**
 * Validate and normalize a user path for the platform that will execute it.
 *
 * Rules applied (in order): empty/control characters, other-platform path
 * shape, device namespace and extended-length paths, complete absoluteness,
 * `..` traversal segments, and Windows-only segment rules. The returned value
 * is the normalized absolute path; the caller still has to prove existence,
 * type, permission and writability against the real filesystem.
 *
 * @param {unknown} input path typed, picked or posted by the user.
 * @param {{platform?: 'win32'|'posix', label?: string, maxLength?: number}} [options] options.
 * @returns {string} normalized absolute path.
 * @throws {AssistantError} with an error message naming the real problem.
 */
export function validateUserPath(input, options = {}) {
  const label = options.label ?? '保存目录';
  const platform = options.platform ?? hostPlatform();
  const maxLength = options.maxLength ?? MAX_USER_PATH_LENGTH;
  if (typeof input !== 'string') {
    throw new AssistantError(ERROR_CODES.invalidInput, `缺少${label}。`);
  }
  const raw = input.trim();
  if (raw === '') throw new AssistantError(ERROR_CODES.invalidInput, `${label}不能为空。`);
  if (raw.length > maxLength) {
    throw new AssistantError(ERROR_CODES.invalidInput, `${label}过长（${raw.length} 个字符，上限 ${maxLength}）。`);
  }
  if (CONTROL_CHARACTERS.test(raw)) {
    throw new AssistantError(ERROR_CODES.invalidInput, `${label}包含非法控制字符。`);
  }
  if (raw.startsWith('~')) {
    throw new AssistantError(ERROR_CODES.invalidInput, `${label}必须是绝对路径（不支持 ~ 展开，请填写完整路径）。`);
  }
  const api = pathApiFor(platform);
  const platformName = hostPlatformLabel(platform);

  if (platform === PLATFORM_WIN32) {
    if (WINDOWS_DEVICE_PREFIX.test(raw)) {
      throw new AssistantError(ERROR_CODES.invalidInput, `${label}不支持设备路径或扩展长度路径（\\\\?\\、\\\\.\\），请使用普通绝对路径。`);
    }
    if (WINDOWS_DRIVE_RELATIVE.test(raw)) {
      throw new AssistantError(ERROR_CODES.invalidInput, `${label}不是完整绝对路径：${raw.slice(0, 2)} 是盘符相对路径，请写成 ${raw.slice(0, 2)}\\...。`);
    }
    const isUnc = raw.startsWith('\\\\') || raw.startsWith('//');
    if (isUnc) {
      if (!WINDOWS_UNC.test(raw)) {
        throw new AssistantError(ERROR_CODES.invalidInput, `${label}的 UNC 路径必须包含共享名（例如 \\\\server\\share\\目录）。`);
      }
    } else if (!WINDOWS_DRIVE_ABSOLUTE.test(raw)) {
      if (raw.startsWith('/')) {
        throw new AssistantError(ERROR_CODES.invalidInput, `当前运行环境是 Windows，${label}请填写 Windows 绝对路径（例如 C:\\Users\\<你>\\Desktop），而不是以 / 开头的路径。`);
      }
      if (raw.startsWith('\\')) {
        throw new AssistantError(ERROR_CODES.invalidInput, `当前运行环境是 Windows，${label}需要完整的盘符或 UNC 路径（例如 C:\\Users\\<你>\\Desktop）。`);
      }
      throw new AssistantError(ERROR_CODES.invalidInput, `${label}必须是绝对路径（例如 C:\\Users\\<你>\\Desktop）。`);
    }
    const segments = segmentsOf(raw, platform);
    if (segments.includes('..')) {
      throw new AssistantError(ERROR_CODES.forbidden, `${label}不能包含 .. 路径片段。`);
    }
    assertUsableWindowsSegments(segments, isUnc, label);
    const normalized = api.normalize(raw);
    if (!isUserAbsolutePath(normalized, {platform})) {
      throw new AssistantError(ERROR_CODES.invalidInput, `${label}必须是绝对路径。`);
    }
    return normalized;
  }

  // POSIX (macOS and Linux).
  if (WINDOWS_DRIVE_ABSOLUTE.test(raw) || WINDOWS_DRIVE_RELATIVE.test(raw) || raw.startsWith('\\\\')) {
    throw new AssistantError(
      ERROR_CODES.invalidInput,
      `当前运行环境（${platformName}）无法访问 Windows 路径，${label}请填写本机绝对路径（例如 /Users/<你>/Desktop）。`,
    );
  }
  if (!api.isAbsolute(raw)) {
    throw new AssistantError(ERROR_CODES.invalidInput, `${label}必须是绝对路径（例如 /Users/<你>/Desktop）。`);
  }
  const segments = segmentsOf(raw, platform);
  if (segments.includes('..')) {
    throw new AssistantError(ERROR_CODES.forbidden, `${label}不能包含 .. 路径片段。`);
  }
  const normalized = api.normalize(raw);
  if (!isUserAbsolutePath(normalized, {platform})) {
    throw new AssistantError(ERROR_CODES.invalidInput, `${label}必须是绝对路径。`);
  }
  return normalized;
}

/**
 * Remove the Windows extended-length prefix a native realpath may return.
 *
 * `GetFinalPathNameByHandle` can answer `\\?\C:\Users\...` (or
 * `\\?\UNC\server\share\...`). That form is a device path which this module
 * deliberately refuses as *user input*; it is also not what the user typed, so
 * it must be canonicalized before being stored or compared. Stripping the
 * prefix does not change the target — it is the same location.
 *
 * @param {unknown} value resolved path.
 * @param {{platform?: 'win32'|'posix'}} [options] platform id.
 * @returns {string} canonical path text.
 */
export function canonicalizeRealPath(value, options = {}) {
  const platform = options.platform ?? hostPlatform();
  let text = String(value ?? '');
  if (platform === PLATFORM_WIN32) {
    if (text.startsWith('\\\\?\\UNC\\')) text = `\\\\${text.slice('\\\\?\\UNC\\'.length)}`;
    else if (text.startsWith('\\\\?\\')) text = text.slice('\\\\?\\'.length);
  }
  return text;
}

/**
 * Compare two paths for identity on one platform.
 *
 * Windows paths are case-insensitive and tolerate either separator and a
 * trailing separator; two spellings of the same directory must compare equal or
 * the export authorization check rejects a directory the user just saved.
 *
 * @param {string} left first path.
 * @param {string} right second path.
 * @param {{platform?: 'win32'|'posix'}} [options] platform id.
 * @returns {boolean} true when both name the same location.
 */
export function sameUserPath(left, right, options = {}) {
  const platform = options.platform ?? hostPlatform();
  const api = pathApiFor(platform);
  const normalize = (value) => resolveUsablePath(value, platform);
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  // Fail closed: an absent or relative value is never "the same directory".
  if (normalizedLeft === null || normalizedRight === null) return false;
  return normalizedLeft === normalizedRight;
}

/**
 * Resolve one path for identity/containment comparison.
 *
 * Returns null for anything that is not a non-empty absolute path, so a missing
 * configuration value can never compare equal to a real directory (fail closed).
 *
 * @param {unknown} value candidate.
 * @param {'win32'|'posix'} platform platform id.
 * @returns {string|null} canonical comparison key.
 */
function resolveUsablePath(value, platform) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const api = pathApiFor(platform);
  if (!api.isAbsolute(text)) return null;
  const resolved = api.resolve(text);
  const trimmed = resolved.length > 1 && resolved.endsWith(api.sep) && !/^([A-Za-z]:)?[\\/]$/.test(resolved)
    ? resolved.slice(0, -1)
    : resolved;
  return platform === PLATFORM_WIN32 ? trimmed.toLowerCase() : trimmed;
}

/**
 * Whether `target` is `root` or inside it, using path relationships rather than
 * a string prefix.
 *
 * Cross-drive relative paths (`path.win32.relative('C:\\a', 'D:\\b')` returns
 * `D:\\b`, an absolute path) are outside the root; a bare `startsWith` check
 * would call them inside.
 *
 * @param {string} root containing directory.
 * @param {string} target candidate path.
 * @param {{platform?: 'win32'|'posix'}} [options] platform id.
 * @returns {boolean} true when the target is contained by the root.
 */
export function isPathInside(root, target, options = {}) {
  const platform = options.platform ?? hostPlatform();
  const api = pathApiFor(platform);
  const resolvedRoot = resolveUsablePath(root, platform);
  const resolvedTarget = resolveUsablePath(target, platform);
  // Fail closed: a non-string/relative root or target is never "inside".
  if (resolvedRoot === null || resolvedTarget === null) return false;
  if (sameUserPath(resolvedRoot, resolvedTarget, {platform})) return true;
  const relative = api.relative(resolvedRoot, resolvedTarget);
  if (relative === '') return true;
  // Different drive/volume: `relative` returns an absolute path, which is never inside.
  if (api.isAbsolute(relative)) return false;
  const lowered = platform === PLATFORM_WIN32 ? relative.toLowerCase() : relative;
  return lowered !== '..' && !lowered.startsWith(`..${api.sep}`);
}

/**
 * Turn a real filesystem failure into one accurate business error.
 *
 * @param {unknown} error thrown value from `node:fs`.
 * @param {{label?: string}} [options] options.
 * @returns {AssistantError|null} mapped error, or null when the code is unknown.
 */
export function describeFsError(error, options = {}) {
  const label = options.label ?? '保存目录';
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  const mapped = mapFsError(code, label);
  // Keep the original failure reachable for the Host log without exposing its
  // localized text to the browser or the model.
  if (mapped !== null && error instanceof Error) mapped.cause = error;
  return mapped;
}

/**
 * Map one fs error code to a business error.
 *
 * @param {string|undefined} code fs error code.
 * @param {string} label user-facing field name.
 * @returns {AssistantError|null} mapped error.
 */
function mapFsError(code, label) {
  switch (code) {
    case 'ENOENT':
      return new AssistantError(ERROR_CODES.invalidInput, `${label}不存在，或其所在磁盘/网络共享当前不可用。`);
    case 'ENOTDIR':
      return new AssistantError(ERROR_CODES.invalidInput, `${label}不是文件夹（路径中有一段是文件）。`);
    case 'EINVAL':
      return new AssistantError(ERROR_CODES.invalidInput, `${label}包含当前文件系统不支持的字符或格式。`);
    case 'EACCES':
    case 'EPERM':
      return new AssistantError(ERROR_CODES.forbidden, `没有访问${label}的权限，请换一个目录或调整系统权限。`);
    case 'ENOSPC':
      return new AssistantError(ERROR_CODES.conflict, `磁盘空间不足，无法写入${label}。`);
    case 'EROFS':
      return new AssistantError(ERROR_CODES.forbidden, `${label}所在磁盘是只读的，无法写入。`);
    case 'ENAMETOOLONG':
      return new AssistantError(ERROR_CODES.invalidInput, `${label}过长，超出当前文件系统的路径长度限制。`);
    case 'ELOOP':
      return new AssistantError(ERROR_CODES.invalidInput, `${label}存在符号链接循环，无法解析真实路径。`);
    case 'EBUSY':
      return new AssistantError(ERROR_CODES.conflict, `${label}正被占用，请关闭相关程序后重试。`);
    case 'EEXIST':
      return new AssistantError(ERROR_CODES.conflict, `${label}已存在同名对象。`);
    default:
      return null;
  }
}

/**
 * Make a user-provided name safe as a delivered file base name on both
 * platforms.
 *
 * Windows is the stricter target: it rejects `\ / : * ? " < > |`, control
 * characters, trailing dots/spaces and reserved device names. A portable name
 * is used on macOS too, so the same result exported on either platform keeps the
 * same name and never produces a file that cannot be copied to Windows.
 *
 * @param {unknown} name raw name.
 * @param {{maxLength?: number}} [options] options.
 * @returns {string} safe base name (never empty).
 */
export function sanitizeFileBaseName(name, options = {}) {
  const maxLength = options.maxLength ?? DEFAULT_BASE_NAME_LENGTH;
  let cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .slice(0, maxLength)
    .replace(/[. ]+$/g, '')
    .trim();
  if (cleaned === '') cleaned = '查询结果';
  // Windows reserves device names with any extension (`CON`, `CON.txt`) and
  // also treats `CON .txt` as a device: a space before the dot does not make it
  // a normal file, and Windows refuses to open the delivered file. Insert the
  // separator after the device stem so the existing `CON_.txt` contract holds.
  const reservedMatch = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])([ .]|$)/i.exec(cleaned);
  if (reservedMatch !== null) cleaned = `${reservedMatch[1]}_${cleaned.slice(reservedMatch[1].length)}`;
  return cleaned;
}
