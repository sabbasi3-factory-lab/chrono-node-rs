// Canonical JSON in the style of RFC 8785 (JCS):
// - object keys sorted by UTF-16 code units, recursively
// - no insignificant whitespace
// - numbers and strings serialized exactly like JSON.stringify
// - non-finite numbers, undefined, functions, symbols, bigints and
//   non-plain objects are rejected instead of being silently dropped.

export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, at: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonical JSON: non-finite number at ${at}`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      throw new TypeError(`canonical JSON: undefined at ${at}`);
    case 'object':
      break;
    default:
      throw new TypeError(`canonical JSON: unsupported ${typeof value} at ${at}`);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new TypeError(`canonical JSON: sparse array at ${at}[${i}]`);
      parts.push(serialize(value[i], `${at}[${i}]`));
    }
    return `[${parts.join(',')}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`canonical JSON: non-plain object at ${at}`);
  }
  const obj = value as Record<string, unknown>;
  // Array.prototype.sort without a comparator orders by UTF-16 code units.
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k], `${at}.${k}`)}`);
  return `{${parts.join(',')}}`;
}
