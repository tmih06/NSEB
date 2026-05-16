const zlib = require("zlib");

// Canonical 4-character SEB binary block prefixes — matches seb-mac/seb-win/seb-server.
//   pswd : password-encrypted
//   pwcc : password-configure-client encrypted
//   plnd : plain (still gzipped) data
//   pkhs : public key hash (asymmetric)
//   phsk : public key hash (symmetric inner)
const BLOCK_PREFIX = {
  Password: "pswd",
  PasswordConfigureClient: "pwcc",
  PlainData: "plnd",
  PublicKey: "pkhs",
  PublicKeySymmetric: "phsk",
};

const ALL_BLOCK_PREFIXES = new Set(Object.values(BLOCK_PREFIX));
const ENCRYPTED_BLOCK_PREFIXES = new Set([
  BLOCK_PREFIX.Password,
  BLOCK_PREFIX.PasswordConfigureClient,
  BLOCK_PREFIX.PublicKey,
  BLOCK_PREFIX.PublicKeySymmetric,
]);

function isGzipBuffer(buf) {
  return buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function parseBinaryConfig(buf) {
  if (!buf || buf.length < 4) return null;

  // SEB ".seb" files are always at least gzipped once on the outside, even for
  // the "plain" plnd block. Mirrors `compressor.IsCompressed(data) ?
  // compressor.Decompress(data) : data` from
  // seb-win-refactoring/SafeExamBrowser.Configuration/DataFormats/BinaryParser.cs.
  let working = buf;
  if (isGzipBuffer(working)) {
    try {
      working = zlib.gunzipSync(working);
    } catch (e) {
      return null;
    }
  }

  if (working.length < 4) return null;
  const prefix = working.slice(0, 4).toString("ascii");

  if (!ALL_BLOCK_PREFIXES.has(prefix)) {
    // Not a known binary prefix — try to parse the (de-gzipped) buffer as XML.
    return parseXmlPlist(working);
  }

  if (ENCRYPTED_BLOCK_PREFIXES.has(prefix)) {
    // Linux client doesn't yet support password / public-key encrypted .seb
    // payloads — surfaced via main.js / serverClient.js error handling.
    return null;
  }

  // PlainData ("plnd"): inner payload is gzipped XML plist.
  let inner = working.slice(4);
  if (isGzipBuffer(inner)) {
    try {
      inner = zlib.gunzipSync(inner);
    } catch (e) {
      return null;
    }
  }

  const xmlStart = findPlistStart(inner);
  if (xmlStart === -1) return null;
  return parseXmlPlist(inner.slice(xmlStart));
}

function findPlistStart(buf) {
  const str = buf.toString("utf-8");
  const idx = str.indexOf("<plist");
  if (idx !== -1) return idx;
  const idx2 = str.indexOf("<?xml");
  return idx2;
}

class PlistParser {
  constructor(str) {
    this.str = str;
    this.pos = 0;
  }

  readTo(c) {
    while (this.pos < this.str.length && this.str[this.pos] !== c)
      this.pos++;
  }

  readPast(c) {
    this.readTo(c);
    if (this.pos < this.str.length) this.pos++;
  }

  readOpenTag() {
    const start = this.pos;
    this.readPast(">");
    const raw = this.str.slice(start, this.pos);
    const selfClosing = raw.endsWith("/>") || raw.endsWith("/ >");
    const m = raw.match(/^<\s*([a-zA-Z_-]+)/);
    if (!m) return { tag: null, selfClosing: false };
    return { tag: m[1].toLowerCase(), selfClosing, raw };
  }

  readTextContent(parentTag) {
    const closeTag = "</" + parentTag + ">";
    const closeTagLen = closeTag.length;
    const start = this.pos;
    while (this.pos < this.str.length) {
      if (this.str[this.pos] === "<") {
        const slice = this.str.slice(this.pos, this.pos + closeTagLen);
        if (slice.toLowerCase() === closeTag.toLowerCase()) {
          const text = this.str.slice(start, this.pos).trim();
          this.pos += closeTagLen;
          return text;
        }
      }
      this.pos++;
    }
    const text = this.str.slice(start).trim();
    return text;
  }

  skipToContentStart() {
    this.readPast(">");
  }

  parseValue() {
    while (this.pos < this.str.length) {
      if (this.str[this.pos] !== "<") {
        this.pos++;
        continue;
      }

      if (
        this.str[this.pos + 1] === "/" ||
        this.str.slice(this.pos, this.pos + 6) === "</dict" ||
        this.str.slice(this.pos, this.pos + 7) === "</array" ||
        this.str.slice(this.pos, this.pos + 7) === "</plist"
      ) {
        return undefined;
      }

      const { tag, selfClosing } = this.readOpenTag();
      if (!tag) {
        this.pos++;
        continue;
      }

      switch (tag) {
        case "key": {
          const key = this.readTextContent("key");
          const v = this.parseValue();
          if (v !== undefined) {
            return { _kv: true, key, value: v };
          }
          return undefined;
        }
        case "dict": {
          if (selfClosing) return {};
          const d = {};
          while (this.pos < this.str.length) {
            const saved = this.pos;
            if (
              this.str[this.pos] === "<" &&
              (this.str.slice(this.pos, this.pos + 6) === "</dict" ||
                this.str.slice(this.pos, this.pos + 7) === "</dict ")
            ) {
              this.readPast(">");
              break;
            }
            if (
              this.str.slice(this.pos, this.pos + 2) === "</" &&
              this.str.slice(this.pos, this.pos + 2) !== "<!"
            ) {
              this.readPast(">");
              break;
            }
            const kv = this.parseValue();
            if (kv && kv._kv) {
              d[kv.key] = kv.value;
            }
            if (this.pos === saved) {
              this.pos++;
            }
          }
          return d;
        }
        case "array": {
          // A self-closing <array/> has no contents and no closing tag — return
          // an empty array immediately so the caller continues parsing the
          // following key/value pairs. Prior to this fix, the parser kept
          // scanning past the self-closing tag and silently swallowed
          // everything up to the next </dict>, dropping startURL,
          // sendBrowserExamKey, etc., from real-world configs.
          if (selfClosing) return [];
          const arr = [];
          while (this.pos < this.str.length) {
            const saved = this.pos;
            if (
              this.str[this.pos] === "<" &&
              (this.str.slice(this.pos, this.pos + 7) === "</array" ||
                this.str.slice(this.pos, this.pos + 8) === "</array ")
            ) {
              this.readPast(">");
              break;
            }
            if (
              this.str.slice(this.pos, this.pos + 2) === "</" &&
              this.str.slice(this.pos, this.pos + 2) !== "<!" &&
              this.str.slice(this.pos, this.pos + 7) !== "</array" &&
              this.str.slice(this.pos, this.pos + 8) !== "</array "
            ) {
              break;
            }
            const v = this.parseValue();
            if (v !== undefined) {
              if (v._kv) {
                arr.push(v.value);
              } else {
                arr.push(v);
              }
            }
            if (this.pos === saved) {
              this.pos++;
            }
          }
          return arr;
        }
        case "string":
          if (selfClosing) return "";
          return this.readTextContent("string");
        case "integer":
          if (selfClosing) return 0;
          return parseInt(this.readTextContent("integer"), 10);
        case "real":
          if (selfClosing) return 0.0;
          return parseFloat(this.readTextContent("real"));
        case "true":
          if (!selfClosing) this.readTextContent("true");
          return true;
        case "false":
          if (!selfClosing) this.readTextContent("false");
          return false;
        case "data": {
          if (selfClosing) return Buffer.from("");
          const val = this.readTextContent("data");
          try {
            return Buffer.from(val.replace(/\s/g, ""), "base64");
          } catch (e) {
            return Buffer.from("");
          }
        }
        case "plist":
          if (selfClosing) return {};
          return this.parseValue();
        case "?xml":
        case "!doctype":
          this.readPast(">");
          break;
        default:
          if (!selfClosing) {
            this.readTextContent(tag);
          }
          break;
      }
    }
    return undefined;
  }

  readCloseTag() {
    this.readPast(">");
  }
}

function parseXmlPlist(buf) {
  const str = Buffer.isBuffer(buf) ? buf.toString("utf-8") : String(buf);
  const parser = new PlistParser(str);
  const result = parser.parseValue();
  if (result && result._kv && result.key === "plist") {
    return result.value || {};
  }
  if (result && !result._kv && typeof result === "object" && !Array.isArray(result)) {
    return result;
  }
  if (result && result._kv) {
    const d = {};
    d[result.key] = result.value;
    return d;
  }
  return result || {};
}

function loadConfig(fileBuffer) {
  if (!fileBuffer || fileBuffer.length === 0) return null;

  // Inspect the *uncompressed* head when the buffer happens to be gzipped, so
  // a `.seb` that was saved as raw XML and then gzipped on disk (e.g. by
  // seb-server's connection-config download) is correctly identified as an
  // XML plist rather than re-routed through the binary block parser.
  const headBuf = isGzipBuffer(fileBuffer)
    ? safeGunzipPeek(fileBuffer)
    : fileBuffer.slice(0, 16);
  const head = headBuf ? headBuf.toString("utf-8").trimStart() : "";

  if (head.startsWith("<?xml") || head.startsWith("<plist")) {
    const xmlBuf = isGzipBuffer(fileBuffer) ? zlib.gunzipSync(fileBuffer) : fileBuffer;
    return { dict: parseXmlPlist(xmlBuf), format: "xml" };
  }

  const dict = parseBinaryConfig(fileBuffer);
  if (dict) {
    return { dict, format: "binary" };
  }
  return null;
}

function safeGunzipPeek(buf) {
  try {
    return zlib.gunzipSync(buf).slice(0, 16);
  } catch (e) {
    return null;
  }
}

function getString(dict, key, defaultValue) {
  const v = dict[key];
  if (typeof v === "string") return v;
  if (v instanceof Buffer) return v.toString("utf-8");
  return defaultValue;
}

function getBool(dict, key, defaultValue) {
  const v = dict[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return defaultValue;
}

function getInt(dict, key, defaultValue) {
  const v = dict[key];
  if (typeof v === "number") return v;
  return defaultValue;
}

module.exports = {
  loadConfig,
  parseXmlPlist,
  getString,
  getBool,
  getInt,
  BLOCK_PREFIX,
  ENCRYPTED_BLOCK_PREFIXES,
};
