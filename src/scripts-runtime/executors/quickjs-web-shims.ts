/**
 * Pure-JS web globals that the QuickJS build lacks: `URL`, `URLSearchParams`,
 * `TextEncoder`, `TextDecoder` (UTF-8 only), `atob` and `btoa`. The quickjs runner evaluates
 * this before `SANDBOX_PRELUDE`, so the prelude's fetch can serialize a
 * `URLSearchParams` body. Nothing here calls the host.
 *
 * `URL` follows the WHATWG URL parser for what scripts use: special and
 * non-special schemes, relative resolution, dot segments, percent-encoding,
 * IPv4/IPv6 hosts and punycode for non-ASCII labels. It skips the full UTS #46
 * mapping (hosts are lowercased and NFC-normalized only) and Windows drive
 * letters in `file:` URLs.
 */
export const SANDBOX_WEB_SHIMS = String.raw`(() => {
"use strict";

// ── UTF-8 ──
const utf8Encode = (input) => {
  const str = String(input);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
};

const INVALID_UTF8 = "The encoded data was not valid for encoding utf-8";

// WHATWG UTF-8 decode: one U+FFFD per maximal invalid subpart. With stream,
// an incomplete trailing sequence is returned as pending instead.
const utf8Decode = (bytes, fatal, stream) => {
  const parts = [];
  let units = [];
  const flush = () => {
    if (units.length) parts.push(String.fromCharCode.apply(null, units));
    units = [];
  };
  const push = (cp) => {
    if (cp > 0xffff) {
      cp -= 0x10000;
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else units.push(cp);
    if (units.length >= 8192) flush();
  };
  const n = bytes.length;
  let i = 0;
  let pending = null;
  while (i < n) {
    const b = bytes[i];
    if (b < 0x80) {
      push(b);
      i++;
      continue;
    }
    let need = 0;
    let cp = 0;
    let lower = 0x80;
    let upper = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      cp = b & 0xf;
      if (b === 0xe0) lower = 0xa0;
      if (b === 0xed) upper = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      cp = b & 7;
      if (b === 0xf0) lower = 0x90;
      if (b === 0xf4) upper = 0x8f;
    } else {
      if (fatal) throw new TypeError(INVALID_UTF8);
      push(0xfffd);
      i++;
      continue;
    }
    let j = 1;
    for (; j <= need; j++) {
      if (i + j >= n) break;
      const c = bytes[i + j];
      if (c < lower || c > upper) break;
      lower = 0x80;
      upper = 0xbf;
      cp = (cp << 6) | (c & 63);
    }
    if (j > need) {
      push(cp);
      i += need + 1;
      continue;
    }
    if (i + j >= n && stream) {
      pending = bytes.slice(i);
      break;
    }
    if (fatal) throw new TypeError(INVALID_UTF8);
    push(0xfffd);
    i += j;
  }
  flush();
  return { text: parts.join(""), pending };
};

const toBytes = (input) => {
  if (input === undefined) return new Uint8Array(0);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("The provided value is not of type '(ArrayBuffer or ArrayBufferView)'");
};

class TextEncoder {
  get encoding() {
    return "utf-8";
  }
  encode(input = "") {
    return utf8Encode(input);
  }
  encodeInto(source, destination) {
    const str = String(source);
    let read = 0;
    let written = 0;
    for (const char of str) {
      const bytes = utf8Encode(char);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written);
      written += bytes.length;
      read += char.length;
    }
    return { read, written };
  }
}

const UTF8_LABELS = ["utf-8", "utf8", "unicode-1-1-utf-8"];
class TextDecoder {
  constructor(label = "utf-8", options = {}) {
    if (!UTF8_LABELS.includes(String(label).trim().toLowerCase())) {
      throw new RangeError("quickjs executor: TextDecoder supports utf-8 only, not " + JSON.stringify(String(label)));
    }
    this._fatal = Boolean(options && options.fatal);
    this._ignoreBOM = Boolean(options && options.ignoreBOM);
    this._pending = null;
    this._started = false;
  }
  get encoding() {
    return "utf-8";
  }
  get fatal() {
    return this._fatal;
  }
  get ignoreBOM() {
    return this._ignoreBOM;
  }
  decode(input, options) {
    const stream = Boolean(options && options.stream);
    let bytes = toBytes(input);
    if (this._pending) {
      const joined = new Uint8Array(this._pending.length + bytes.length);
      joined.set(this._pending);
      joined.set(bytes, this._pending.length);
      bytes = joined;
    }
    let decoded;
    try {
      decoded = utf8Decode(bytes, this._fatal, stream);
    } catch (error) {
      this._pending = null;
      this._started = false;
      throw error;
    }
    let text = decoded.text;
    if (!this._started && text.length > 0) {
      if (!this._ignoreBOM && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this._started = true;
    }
    this._pending = decoded.pending;
    if (!stream) {
      this._pending = null;
      this._started = false;
    }
    return text;
  }
}

// ── percent-encoding ──
const HEX = "0123456789ABCDEF";
const hexByte = (b) => "%" + HEX[b >> 4] + HEX[b & 15];
const inSet = (chars) => (c) => c < 0x20 || c > 0x7e || chars.includes(String.fromCharCode(c));
const C0_SET = inSet("");
const FRAGMENT_SET = inSet(' "<>' + "\x60");
const QUERY_SET = inSet(' "#<>');
const SPECIAL_QUERY_SET = inSet(' "#<>' + "'");
const PATH_SET = inSet(' "#<>?^{}' + "\x60");
const USERINFO_SET = inSet(' "#<>?^{}/:;=@[\\]|' + "\x60");
const percentEncode = (input, set) => {
  let out = "";
  for (const char of String(input)) {
    const code = char.codePointAt(0);
    if (code < 0x80 && !set(code)) out += char;
    else if (code < 0x80) out += hexByte(code);
    else for (const b of utf8Encode(char)) out += hexByte(b);
  }
  return out;
};
const isHex = (c) => /^[0-9A-Fa-f]$/.test(c);
const percentDecodeBytes = (input) => {
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "%" && i + 2 < input.length && isHex(input[i + 1]) && isHex(input[i + 2])) {
      out.push(parseInt(input.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      let end = i;
      while (end < input.length && input[end] !== "%") end++;
      if (end === i) end = i + 1;
      for (const b of utf8Encode(input.slice(i, end))) out.push(b);
      i = end - 1;
    }
  }
  return new Uint8Array(out);
};
const percentDecode = (input) => utf8Decode(percentDecodeBytes(input), false, false).text;

// ── URLSearchParams ──
const formEncode = (input) => {
  let out = "";
  for (const b of utf8Encode(input)) {
    if (b === 0x20) out += "+";
    else if (
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) ||
      b === 0x2a || b === 0x2d || b === 0x2e || b === 0x5f
    ) out += String.fromCharCode(b);
    else out += hexByte(b);
  }
  return out;
};
const parseQuery = (input) => {
  const list = [];
  for (const piece of input.split("&")) {
    if (piece === "") continue;
    const eq = piece.indexOf("=");
    const name = eq === -1 ? piece : piece.slice(0, eq);
    const value = eq === -1 ? "" : piece.slice(eq + 1);
    list.push([percentDecode(name.replace(/\+/g, " ")), percentDecode(value.replace(/\+/g, " "))]);
  }
  return list;
};
const toUSVString = (value) => utf8Decode(utf8Encode(value), false, false).text;
const liveIterator = (params, pick) => {
  let index = 0;
  return {
    next() {
      if (index >= params._list.length) return { value: undefined, done: true };
      return { value: pick(params._list[index++]), done: false };
    },
    [Symbol.iterator]() {
      return this;
    },
  };
};

class URLSearchParams {
  constructor(init) {
    this._list = [];
    this._url = null;
    if (init == null) return;
    if (typeof init === "object" || typeof init === "function") {
      if (typeof init[Symbol.iterator] === "function") {
        for (const pair of init) {
          const entry = Array.from(pair);
          if (entry.length !== 2) throw new TypeError("Each query pair must be an iterable [name, value] tuple");
          this._list.push([toUSVString(entry[0]), toUSVString(entry[1])]);
        }
      } else {
        for (const key of Object.keys(init)) this._list.push([toUSVString(key), toUSVString(init[key])]);
      }
      return;
    }
    const text = String(init);
    this._list = parseQuery(text.startsWith("?") ? text.slice(1) : text);
  }
  _update() {
    if (!this._url) return;
    const serialized = this.toString();
    this._url._record.query = serialized === "" ? null : serialized;
  }
  get size() {
    return this._list.length;
  }
  append(name, value) {
    this._list.push([toUSVString(name), toUSVString(value)]);
    this._update();
  }
  delete(name, value) {
    const key = toUSVString(name);
    const match = value === undefined ? null : toUSVString(value);
    this._list = this._list.filter(([k, v]) => !(k === key && (match === null || v === match)));
    this._update();
  }
  get(name) {
    const key = toUSVString(name);
    const entry = this._list.find(([k]) => k === key);
    return entry ? entry[1] : null;
  }
  getAll(name) {
    const key = toUSVString(name);
    return this._list.filter(([k]) => k === key).map(([, v]) => v);
  }
  has(name, value) {
    const key = toUSVString(name);
    const match = value === undefined ? null : toUSVString(value);
    return this._list.some(([k, v]) => k === key && (match === null || v === match));
  }
  set(name, value) {
    const key = toUSVString(name);
    const index = this._list.findIndex(([k]) => k === key);
    if (index === -1) this._list.push([key, toUSVString(value)]);
    else {
      this._list[index] = [key, toUSVString(value)];
      this._list = this._list.filter(([k], i) => i <= index || k !== key);
    }
    this._update();
  }
  sort() {
    this._list = this._list
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => (a.entry[0] < b.entry[0] ? -1 : a.entry[0] > b.entry[0] ? 1 : a.index - b.index))
      .map(({ entry }) => entry);
    this._update();
  }
  // Traversal is live, as in the spec: each step reads the current list, so
  // entries appended or deleted during iteration are seen or skipped.
  forEach(callback, thisArg) {
    for (let i = 0; i < this._list.length; i++) {
      const [k, v] = this._list[i];
      callback.call(thisArg, v, k, this);
    }
  }
  keys() {
    return liveIterator(this, ([k]) => k);
  }
  values() {
    return liveIterator(this, ([, v]) => v);
  }
  entries() {
    return liveIterator(this, ([k, v]) => [k, v]);
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  toString() {
    return this._list.map(([k, v]) => formEncode(k) + "=" + formEncode(v)).join("&");
  }
}

// ── hosts ──
const punycode = (label) => {
  const codes = Array.from(label).map((c) => c.codePointAt(0));
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  let n = 128, delta = 0, bias = 72;
  let out = codes.filter((c) => c < 128).map((c) => String.fromCharCode(c)).join("");
  const basic = out.length;
  let handled = basic;
  if (basic > 0) out += "-";
  const digit = (d) => String.fromCharCode(d + 22 + (d < 26 ? 75 : 0));
  const adapt = (d, points, first) => {
    d = first ? Math.floor(d / damp) : d >> 1;
    d += Math.floor(d / points);
    let k = 0;
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + skew));
  };
  while (handled < codes.length) {
    let m = Infinity;
    for (const c of codes) if (c >= n && c < m) m = c;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const c of codes) {
      if (c < n) delta++;
      if (c !== n) continue;
      let q = delta;
      for (let k = base; ; k += base) {
        const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
        if (q < t) break;
        out += digit(t + ((q - t) % (base - t)));
        q = Math.floor((q - t) / (base - t));
      }
      out += digit(q);
      bias = adapt(delta, handled + 1, handled === basic);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }
  return out;
};

const parseIPv4Number = (input) => {
  let text = input;
  let radix = 10;
  if (/^0[xX]/.test(text)) {
    text = text.slice(2);
    radix = 16;
  } else if (text.length > 1 && text[0] === "0") {
    text = text.slice(1);
    radix = 8;
  }
  if (text === "") return 0;
  const valid = radix === 16 ? /^[0-9A-Fa-f]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  return valid.test(text) ? parseInt(text, radix) : NaN;
};
const endsInNumber = (host) => {
  const parts = host.split(".");
  if (parts[parts.length - 1] === "") {
    if (parts.length === 1) return false;
    parts.pop();
  }
  const last = parts[parts.length - 1];
  return /^[0-9]+$/.test(last) || /^0[xX][0-9A-Fa-f]*$/.test(last);
};
const parseIPv4 = (host) => {
  const parts = host.split(".");
  if (parts[parts.length - 1] === "" && parts.length > 1) parts.pop();
  if (parts.length > 4 || parts.some((part) => part === "")) return null;
  const numbers = parts.map(parseIPv4Number);
  if (numbers.some((value) => Number.isNaN(value))) return null;
  const last = numbers[numbers.length - 1];
  if (numbers.slice(0, -1).some((value) => value > 255)) return null;
  if (last >= 256 ** (5 - numbers.length)) return null;
  let address = last;
  numbers.slice(0, -1).forEach((value, index) => {
    address += value * 256 ** (3 - index);
  });
  const octets = [];
  for (let i = 0; i < 4; i++) {
    octets.unshift(address % 256);
    address = Math.floor(address / 256);
  }
  return octets.join(".");
};

const parseIPv6 = (input) => {
  const address = [0, 0, 0, 0, 0, 0, 0, 0];
  let piece = 0;
  let compress = null;
  let p = 0;
  const at = (i) => (i < input.length ? input[i] : "");
  const isDigit = (c) => c >= "0" && c <= "9" && c !== "";
  if (at(p) === ":") {
    if (at(p + 1) !== ":") return null;
    p += 2;
    piece++;
    compress = piece;
  }
  while (p < input.length) {
    if (piece === 8) return null;
    if (at(p) === ":") {
      if (compress !== null) return null;
      p++;
      piece++;
      compress = piece;
      continue;
    }
    let value = 0;
    let length = 0;
    while (length < 4 && isHex(at(p))) {
      value = value * 16 + parseInt(at(p), 16);
      p++;
      length++;
    }
    if (at(p) === ".") {
      if (length === 0) return null;
      p -= length;
      if (piece > 6) return null;
      let seen = 0;
      while (p < input.length) {
        let part = null;
        if (seen > 0) {
          if (at(p) === "." && seen < 4) p++;
          else return null;
        }
        if (!isDigit(at(p))) return null;
        while (isDigit(at(p))) {
          const digit = Number(at(p));
          if (part === null) part = digit;
          else if (part === 0) return null;
          else part = part * 10 + digit;
          if (part > 255) return null;
          p++;
        }
        address[piece] = address[piece] * 256 + part;
        seen++;
        if (seen === 2 || seen === 4) piece++;
      }
      if (seen !== 4) return null;
      break;
    } else if (at(p) === ":") {
      p++;
      if (p >= input.length) return null;
    } else if (p < input.length) return null;
    address[piece] = value;
    piece++;
  }
  if (compress !== null) {
    let swaps = piece - compress;
    piece = 7;
    while (piece !== 0 && swaps > 0) {
      const other = compress + swaps - 1;
      const tmp = address[piece];
      address[piece] = address[other];
      address[other] = tmp;
      piece--;
      swaps--;
    }
  } else if (piece !== 8) return null;
  return address;
};
const serializeIPv6 = (address) => {
  let best = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (address[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && address[j] === 0) j++;
    if (j - i > bestLength) {
      best = i;
      bestLength = j - i;
    }
    i = j;
  }
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (best !== -1 && i >= best && i < best + bestLength) {
      if (i === best) out += i === 0 ? "::" : ":";
      continue;
    }
    out += address[i].toString(16);
    if (i !== 7) out += ":";
  }
  return "[" + out + "]";
};

const FORBIDDEN_HOST = /[\u0000\t\n\r #/:<>?@[\\\]^|]/;
const FORBIDDEN_DOMAIN = /[\u0000-\u001f #%/:<>?@[\\\]^|\u007f]/;
const invalid = (input) => new TypeError("Invalid URL: " + JSON.stringify(String(input)));

const parseHost = (input, special, original) => {
  if (input.startsWith("[")) {
    if (!input.endsWith("]")) throw invalid(original);
    const address = parseIPv6(input.slice(1, -1));
    if (!address) throw invalid(original);
    return serializeIPv6(address);
  }
  if (!special) {
    if (FORBIDDEN_HOST.test(input)) throw invalid(original);
    return percentEncode(input, C0_SET);
  }
  let domain = percentDecode(input);
  if (typeof domain.normalize === "function") domain = domain.normalize("NFC");
  domain = domain.toLowerCase().replace(/[。．｡]/g, ".");
  const ascii = domain
    .split(".")
    .map((label) => (/[^\u0000-\u007f]/.test(label) ? "xn--" + punycode(label) : label))
    .join(".");
  if (ascii === "" || FORBIDDEN_DOMAIN.test(ascii)) throw invalid(original);
  if (endsInNumber(ascii)) {
    const ipv4 = parseIPv4(ascii);
    if (ipv4 === null) throw invalid(original);
    return ipv4;
  }
  return ascii;
};

// ── URL ──
const SPECIAL_PORTS = { "ftp": "21", "file": "", "http": "80", "https": "443", "ws": "80", "wss": "443" };
const isSpecial = (scheme) => Object.prototype.hasOwnProperty.call(SPECIAL_PORTS, scheme);
const isSingleDot = (segment) => segment === "." || segment.toLowerCase() === "%2e";
const isDoubleDot = (segment) => /^(\.|%2e)(\.|%2e)$/i.test(segment);

// Appends raw path segments to a path list, resolving dot segments.
const appendSegments = (path, segments) => {
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (isDoubleDot(segment)) {
      if (path.length > 0) path.pop();
      if (last) path.push("");
    } else if (isSingleDot(segment)) {
      if (last) path.push("");
    } else path.push(percentEncode(segment, PATH_SET));
  });
  return path;
};

// Splits "rest" into path, query and fragment, in that order.
const splitTail = (rest) => {
  let fragment = null;
  let query = null;
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  const question = rest.indexOf("?");
  if (question !== -1) {
    query = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }
  return { path: rest, query, fragment };
};

const encodeQuery = (query, special) => (query === null ? null : percentEncode(query, special ? SPECIAL_QUERY_SET : QUERY_SET));
const encodeFragment = (fragment) => (fragment === null ? null : percentEncode(fragment, FRAGMENT_SET));

// Parses "//authority/path?query#fragment" (slashes already stripped) into record.
const parseAuthorityAndTail = (record, input, original) => {
  const special = isSpecial(record.scheme);
  const end = input.search(special ? /[/\\?#]/ : /[/?#]/);
  const authority = end === -1 ? input : input.slice(0, end);
  const tail = end === -1 ? "" : input.slice(end);
  const at = authority.lastIndexOf("@");
  let hostPort = authority;
  record.username = "";
  record.password = "";
  if (at !== -1) {
    const userinfo = authority.slice(0, at);
    hostPort = authority.slice(at + 1);
    const colon = userinfo.indexOf(":");
    record.username = percentEncode(colon === -1 ? userinfo : userinfo.slice(0, colon), USERINFO_SET);
    record.password = colon === -1 ? "" : percentEncode(userinfo.slice(colon + 1), USERINFO_SET);
  }
  let hostText = hostPort;
  let port = "";
  const close = hostPort.lastIndexOf("]");
  const colon = hostPort.indexOf(":", close === -1 ? 0 : close);
  if (colon !== -1) {
    hostText = hostPort.slice(0, colon);
    port = hostPort.slice(colon + 1);
  }
  if (record.scheme === "file") {
    record.host = hostText === "" ? "" : parseHost(hostText, true, original);
    if (record.host === "localhost") record.host = "";
  } else if (hostText === "") {
    if (special || at !== -1 || port !== "") throw invalid(original);
    record.host = "";
  } else record.host = parseHost(hostText, special, original);
  if (port !== "") {
    if (!/^[0-9]+$/.test(port)) throw invalid(original);
    const value = Number(port);
    if (value > 65535) throw invalid(original);
    record.port = String(value) === SPECIAL_PORTS[record.scheme] ? "" : String(value);
  } else record.port = "";
  parseTail(record, tail);
};

// Parses an absolute path (or empty path) plus query and fragment.
const parseTail = (record, tail) => {
  const special = isSpecial(record.scheme);
  const parts = splitTail(tail);
  let path = parts.path;
  if (special) path = path.replace(/\\/g, "/");
  if (path === "" && !special) record.path = [];
  else {
    const segments = (path.startsWith("/") ? path.slice(1) : path).split("/");
    record.path = appendSegments([], segments);
  }
  record.query = encodeQuery(parts.query, special);
  record.fragment = encodeFragment(parts.fragment);
};

const blankRecord = (scheme) => ({
  scheme,
  username: "",
  password: "",
  host: null,
  port: "",
  path: [],
  opaque: false,
  query: null,
  fragment: null,
});

const parseRelative = (record, rest, base, original) => {
  const special = isSpecial(record.scheme);
  const slash = (c) => c === "/" || (special && c === "\\");
  if (slash(rest[0] || "") && slash(rest[1] || "")) {
    parseAuthorityAndTail(record, special ? rest.replace(/^[/\\]+/, "") : rest.slice(2), original);
    return record;
  }
  record.username = base.username;
  record.password = base.password;
  record.host = base.host;
  record.port = base.port;
  if (slash(rest[0] || "")) {
    parseTail(record, rest);
    return record;
  }
  const parts = splitTail(rest);
  record.fragment = encodeFragment(parts.fragment);
  if (parts.path === "") {
    record.path = base.path.slice();
    record.query = parts.query === null ? base.query : encodeQuery(parts.query, special);
    return record;
  }
  const relative = special ? parts.path.replace(/\\/g, "/") : parts.path;
  record.path = appendSegments(base.path.slice(0, -1), relative.split("/"));
  record.query = encodeQuery(parts.query, special);
  return record;
};

const parseURL = (rawInput, base) => {
  const input = String(rawInput)
    .replace(/^[\u0000- ]+|[\u0000- ]+$/g, "")
    .replace(/[\t\n\r]/g, "");
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.\-]*):/.exec(input);
  if (!schemeMatch) {
    if (!base) throw invalid(rawInput);
    if (base.opaque) {
      if (!input.startsWith("#")) throw invalid(rawInput);
      return { ...base, fragment: encodeFragment(input.slice(1)) };
    }
    return parseRelative(blankRecord(base.scheme), input, base, rawInput);
  }
  const record = blankRecord(schemeMatch[1].toLowerCase());
  const rest = input.slice(schemeMatch[0].length);
  if (isSpecial(record.scheme)) {
    // Same special scheme as the base: "http:x", "http:/x" and "http:?q"
    // resolve against the base; two slashes start a new authority.
    if (base && base.scheme === record.scheme && (record.scheme !== "file" || !/^[/\\]/.test(rest))) {
      return parseRelative(record, rest, base, rawInput);
    }
    if (record.scheme === "file") {
      if (/^[/\\]{2}/.test(rest)) parseAuthorityAndTail(record, rest.slice(2), rawInput);
      else {
        record.host = "";
        parseTail(record, rest);
      }
      return record;
    }
    parseAuthorityAndTail(record, rest.replace(/^[/\\]+/, ""), rawInput);
    return record;
  }
  if (rest.startsWith("//")) {
    parseAuthorityAndTail(record, rest.slice(2), rawInput);
    return record;
  }
  if (rest.startsWith("/")) {
    parseTail(record, rest);
    return record;
  }
  const parts = splitTail(rest);
  record.opaque = true;
  record.path = percentEncode(parts.path, C0_SET);
  record.query = encodeQuery(parts.query, false);
  record.fragment = encodeFragment(parts.fragment);
  return record;
};

const pathnameOf = (record) =>
  record.opaque ? record.path : record.path.map((segment) => "/" + segment).join("");
const hostOf = (record) => (record.host === null ? "" : record.host + (record.port ? ":" + record.port : ""));
const hrefOf = (record) => {
  let out = record.scheme + ":";
  if (record.host !== null) {
    out += "//";
    if (record.username || record.password) {
      out += record.username + (record.password ? ":" + record.password : "") + "@";
    }
    out += hostOf(record);
  } else if (!record.opaque && record.path.length > 1 && record.path[0] === "") out += "/.";
  out += pathnameOf(record);
  if (record.query !== null) out += "?" + record.query;
  if (record.fragment !== null) out += "#" + record.fragment;
  return out;
};

// The host and hostname setters: the host state of the URL parser with a state
// override. Invalid input leaves the URL unchanged; it never throws. Where Bun
// departs from the spec, the host setter follows Bun (the native executor):
// it ignores input with a second ":" outside brackets, keeps the old port when
// the new one is the default, and clears the port when the new one is out of range.
const setHost = (record, value, withPort) => {
  if (record.opaque) return;
  const special = isSpecial(record.scheme);
  const input = String(value).replace(/[\t\n\r]/g, "");
  let end = 0;
  let brackets = false;
  let colons = 0;
  let colon = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "[") brackets = true;
    else if (c === "]") brackets = false;
    else if (c === ":" && !brackets && record.scheme !== "file") colons++;
  }
  brackets = false;
  for (; end < input.length; end++) {
    const c = input[end];
    if (c === "/" || c === "?" || c === "#" || (special && c === "\\")) break;
    if (c === ":" && !brackets && record.scheme !== "file") {
      colon = end;
      break;
    }
    if (c === "[") brackets = true;
    else if (c === "]") brackets = false;
  }
  const buffer = input.slice(0, end);
  if (colon !== -1 && (!withPort || colons > 1)) return;
  if (record.scheme === "file") {
    if (buffer === "") {
      record.host = "";
      return;
    }
  } else if (buffer === "") {
    if (special || colon !== -1) return;
    if (record.username || record.password || record.port !== "") return;
  }
  let host;
  try {
    host = parseHost(buffer, special || record.scheme === "file", value);
  } catch {
    return;
  }
  record.host = record.scheme === "file" && host === "localhost" ? "" : host;
  if (colon === -1) return;
  const digits = /^[0-9]*/.exec(input.slice(colon + 1))[0];
  if (digits === "") return;
  const port = Number(digits);
  if (port > 65535) record.port = "";
  else if (String(port) !== SPECIAL_PORTS[record.scheme]) record.port = String(port);
};

class URL {
  constructor(url, base) {
    const baseRecord = base === undefined ? null : parseURL(base instanceof URL ? base.href : base, null);
    this._record = parseURL(url, baseRecord);
    this._params = null;
  }
  static canParse(url, base) {
    try {
      new URL(url, base);
      return true;
    } catch {
      return false;
    }
  }
  static parse(url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  }
  _syncParams() {
    if (this._params) this._params._list = this._record.query ? parseQuery(this._record.query) : [];
  }
  get href() {
    return hrefOf(this._record);
  }
  set href(value) {
    this._record = parseURL(value, null);
    this._syncParams();
  }
  get origin() {
    const record = this._record;
    if (record.scheme === "blob") {
      const inner = URL.parse(pathnameOf(record));
      return inner && (inner.protocol === "http:" || inner.protocol === "https:") ? inner.origin : "null";
    }
    if (!isSpecial(record.scheme) || record.scheme === "file") return "null";
    return record.scheme + "://" + hostOf(record);
  }
  get protocol() {
    return this._record.scheme + ":";
  }
  set protocol(value) {
    // The scheme must end the input or be followed by ":"; anything else is invalid.
    const match = /^([A-Za-z][A-Za-z0-9+.\-]*)(:|$)/.exec(String(value).replace(/[\t\n\r]/g, ""));
    if (!match) return;
    const scheme = match[1].toLowerCase();
    if (isSpecial(scheme) !== isSpecial(this._record.scheme)) return;
    if (scheme === "file" && (this._record.username || this._record.password || this._record.port)) return;
    if (this._record.scheme === "file" && this._record.host === "") return;
    this._record.scheme = scheme;
    if (this._record.port === SPECIAL_PORTS[scheme]) this._record.port = "";
  }
  get username() {
    return this._record.username;
  }
  set username(value) {
    if (this._record.host === null || this._record.host === "" || this._record.scheme === "file") return;
    this._record.username = percentEncode(value, USERINFO_SET);
  }
  get password() {
    return this._record.password;
  }
  set password(value) {
    if (this._record.host === null || this._record.host === "" || this._record.scheme === "file") return;
    this._record.password = percentEncode(value, USERINFO_SET);
  }
  get host() {
    return hostOf(this._record);
  }
  set host(value) {
    setHost(this._record, value, true);
  }
  get hostname() {
    return this._record.host === null ? "" : this._record.host;
  }
  set hostname(value) {
    setHost(this._record, value, false);
  }
  get port() {
    return this._record.port;
  }
  set port(value) {
    if (this._record.host === null || this._record.host === "" || this._record.scheme === "file") return;
    const text = String(value);
    if (text === "") {
      this._record.port = "";
      return;
    }
    const digits = /^[0-9]+/.exec(text);
    if (!digits || Number(digits[0]) > 65535) return;
    const port = String(Number(digits[0]));
    this._record.port = port === SPECIAL_PORTS[this._record.scheme] ? "" : port;
  }
  get pathname() {
    return pathnameOf(this._record);
  }
  set pathname(value) {
    if (this._record.opaque) return;
    let path = String(value);
    if (isSpecial(this._record.scheme)) path = path.replace(/\\/g, "/");
    if (path === "" && !isSpecial(this._record.scheme)) {
      this._record.path = [];
      return;
    }
    this._record.path = appendSegments([], (path.startsWith("/") ? path.slice(1) : path).split("/"));
  }
  get search() {
    return this._record.query ? "?" + this._record.query : "";
  }
  set search(value) {
    const text = String(value);
    const query = text.startsWith("?") ? text.slice(1) : text;
    this._record.query = text === "" ? null : encodeQuery(query, isSpecial(this._record.scheme));
    this._syncParams();
  }
  get searchParams() {
    if (!this._params) {
      this._params = new URLSearchParams(this._record.query || "");
      this._params._url = this;
    }
    return this._params;
  }
  get hash() {
    return this._record.fragment ? "#" + this._record.fragment : "";
  }
  set hash(value) {
    const text = String(value);
    this._record.fragment = text === "" ? null : encodeFragment(text.startsWith("#") ? text.slice(1) : text);
  }
  toString() {
    return this.href;
  }
  toJSON() {
    return this.href;
  }
}

// ── base64 (forgiving-base64, latin1 strings) ──
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const invalidCharacter = (message) => {
  const error = new Error(message);
  error.name = "InvalidCharacterError";
  return error;
};
function btoa(data) {
  if (arguments.length === 0) throw new TypeError("btoa requires 1 argument");
  const text = String(data);
  let out = "";
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i);
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) : 0;
    if (a > 255 || b > 255 || c > 255) throw invalidCharacter("The string contains characters outside of the Latin1 range");
    const n = (a << 16) | (b << 8) | c;
    out += B64[n >> 18] + B64[(n >> 12) & 63];
    out += i + 1 < text.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < text.length ? B64[n & 63] : "=";
  }
  return out;
}
function atob(data) {
  if (arguments.length === 0) throw new TypeError("atob requires 1 argument");
  let text = String(data).replace(/[\t\n\f\r ]/g, "");
  if (text.length % 4 === 0) text = text.replace(/==?$/, "");
  if (text.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(text)) {
    throw invalidCharacter("The string contains invalid characters");
  }
  let out = "";
  let bits = 0;
  let buffer = 0;
  for (let i = 0; i < text.length; i++) {
    buffer = ((buffer << 6) | B64.indexOf(text[i])) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 255);
    }
  }
  return out;
}

const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
define("atob", atob);
define("btoa", btoa);
define("URL", URL);
define("URLSearchParams", URLSearchParams);
define("TextEncoder", TextEncoder);
define("TextDecoder", TextDecoder);
})();
`;
