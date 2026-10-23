const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const log = {
  info: (...a: unknown[]) => console.log(ts(), '[info]', ...a),
  warn: (...a: unknown[]) => console.warn(ts(), '[warn]', ...a),
  error: (...a: unknown[]) => console.error(ts(), '[error]', ...a),
};

export function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
