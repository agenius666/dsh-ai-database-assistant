/**
 * Error taxonomy shared by services, routes, and tools.
 *
 * The code is what the workbench and the model see; the message is the
 * human-readable reason. Neither ever contains credentials.
 *
 * @module src/core/errors
 */

/** Stable error codes. */
export const ERROR_CODES = Object.freeze({
  invalidInput: 'invalid-input',
  notFound: 'not-found',
  conflict: 'conflict',
  notBound: 'session-not-bound',
  forbidden: 'forbidden',
  sourceUnavailable: 'source-unavailable',
  sourceReadOnly: 'read-only-violation',
  storageCorrupt: 'storage-corrupt',
  incomplete: 'incomplete-result',
  cancelled: 'cancelled',
  busy: 'busy',
  internal: 'internal',
});

/**
 * Business error with a stable code and optional safe details.
 */
export class AssistantError extends Error {
  /**
   * @param {string} code one of ERROR_CODES values.
   * @param {string} message human-readable reason, already free of secrets.
   * @param {{details?: Record<string, unknown>, status?: number}} [options] extra context.
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AssistantError';
    this.code = code;
    this.details = options.details ?? {};
    this.status = options.status ?? (code === ERROR_CODES.notFound ? 404 : code === ERROR_CODES.forbidden ? 403 : 400);
  }
}

/**
 * Throw an `AssistantError`.
 *
 * @param {string} code stable code.
 * @param {string} message reason.
 * @param {Record<string, unknown>} [details] extra context.
 * @returns {never} always throws.
 */
export function fail(code, message, details) {
  throw new AssistantError(code, message, {details});
}

/**
 * Extract a user-safe message from any thrown value.
 *
 * @param {unknown} error thrown value.
 * @returns {{code: string, message: string}} safe shape.
 */
export function describeError(error) {
  if (error instanceof AssistantError) return {code: error.code, message: error.message};
  const message = error instanceof Error ? error.message : String(error);
  // Do not leak host absolute paths or filesystem internals to the browser or
  // the model; the original message/stack is logged by the caller.
  const filesystemCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'EMFILE', 'ENOSPC', 'EEXIST', 'ELOOP']);
  if (error !== null && typeof error === 'object' && filesystemCodes.has(error.code)) {
    return {code: ERROR_CODES.internal, message: '宿主文件读写失败：目标不存在、不可读或权限不足（详细信息已写入宿主日志）。'};
  }
  if (/路径越出插件存储根目录|Invalid package config|Cannot find module/i.test(message)) {
    return {code: ERROR_CODES.internal, message: '请求涉及非法的存储路径或内部模块，已拒绝（详细信息已写入宿主日志）。'};
  }
  return {code: ERROR_CODES.internal, message: message.slice(0, 2000)};
}
