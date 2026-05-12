const crypto = require("crypto");

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256Hex(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

function randomBytesHex(len) {
  return crypto.randomBytes(len).toString("hex");
}

function sortKeys(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted = {};
  Object.keys(obj)
    .sort((a, b) => a.localeCompare(b))
    .forEach((k) => {
      sorted[k] = sortKeys(obj[k]);
    });
  return sorted;
}

function toJsonValue(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return jsonArray(v);
  if (typeof v === "object") {
    if (Buffer.isBuffer(v)) return '"' + v.toString("base64") + '"';
    return jsonDict(v);
  }
  return '"' + v + '"';
}

function jsonDict(obj) {
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  const parts = [];
  for (const k of keys) {
    if (k === "originatorVersion") continue;
    const v = obj[k];
    if (v === null || v === undefined) continue;
    parts.push('"' + k + '":' + toJsonValue(v));
  }
  return "{" + parts.join(",") + "}";
}

function jsonArray(arr) {
  return "[" + arr.map(toJsonValue).join(",") + "]";
}

function computeConfigKey(settingsDict) {
  const sorted = sortKeys(settingsDict);
  const jsonStr = jsonDict(sorted);
  return sha256Hex(jsonStr);
}

function computeBrowserExamKey(settingsXml, saltHex) {
  const saltBuf = Buffer.from(saltHex, "hex");
  return hmacSha256Hex(saltBuf, settingsXml);
}

function computeHeaderRequestHash(bekHex, url) {
  const urlNoFragment = url.replace(/#.*$/, "");
  const combined = urlNoFragment + bekHex;
  return sha256Hex(combined);
}

function computeHeaderConfigKeyHash(ckHex, url) {
  const urlNoFragment = url.replace(/#.*$/, "");
  const combined = urlNoFragment + ckHex;
  return sha256Hex(combined);
}

module.exports = {
  sha256Hex,
  hmacSha256Hex,
  randomBytesHex,
  computeConfigKey,
  computeBrowserExamKey,
  computeHeaderRequestHash,
  computeHeaderConfigKeyHash,
  sortKeys,
  jsonDict,
};
