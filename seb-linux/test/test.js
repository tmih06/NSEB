const { SebSession } = require("../src/session");
const crypto = require("../src/crypto");
const configParser = require("../src/configParser");
const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} - ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEquals(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected "${b}", got "${a}"`);
}

console.log("\n=== Crypto Tests ===");

test("sha256Hex produces 64-char hex", () => {
  const h = crypto.sha256Hex("hello");
  assertEquals(h.length, 64);
});

test("sha256Hex matches known value", () => {
  assertEquals(
    crypto.sha256Hex("hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

test("hmacSha256Hex produces 64-char hex", () => {
  const h = crypto.hmacSha256Hex("key", "data");
  assertEquals(h.length, 64);
});

test("computeHeaderRequestHash produces 64-char hex", () => {
  const bek = "a".repeat(64);
  const h = crypto.computeHeaderRequestHash(bek, "https://example.com");
  assertEquals(h.length, 64);
});

test("computeHeaderConfigKeyHash produces 64-char hex", () => {
  const ck = "b".repeat(64);
  const h = crypto.computeHeaderConfigKeyHash(ck, "https://example.com#anchor");
  assertEquals(h.length, 64);
});

test("URL fragment stripped in header hash", () => {
  const bek = "a".repeat(64);
  const h1 = crypto.computeHeaderRequestHash(bek, "https://ex.com/path");
  const h2 = crypto.computeHeaderRequestHash(bek, "https://ex.com/path#frag");
  assertEquals(h1, h2, "header hash should ignore URL fragments");
});

console.log("\n=== Config Parser Tests ===");

test("parse XML plist config", () => {
  const buf = fs.readFileSync(path.join(__dirname, "example.seb"));
  const result = configParser.loadConfig(buf);
  assert(result !== null, "result should not be null");
  assert(result.dict !== null, "dict should not be null");
  const d = result.dict;
  assertEquals(d.startURL, "https://example.com/exam");
  assertEquals(d.allowQuit, false);
  assertEquals(d.allowedDisplaysMaxNumber, 1);
  assertEquals(d.allowDownUploads, true);
  assertEquals(d.browserViewMode, 0);
  assertEquals(d.blockPopUpWindows, true);
  assertEquals(d.sebServerURL, "https://exam-server.example.com");
  assertEquals(d.sebServerConfiguration.institution, "1");
  assertEquals(d.sebServerConfiguration.exam, "42");
  assertEquals(d.sebServerConfiguration.clientName, "seb-client");
  assertEquals(d.sebServerConfiguration.clientSecret, "seb-secret");
  assertEquals(d.sebServerConfiguration.apiDiscovery, "/exam-api/discovery");
  assertEquals(d.sebServerConfiguration.pingInterval, 2500);
});

test("configParser getString helper", () => {
  const d = {
    startURL: "https://example.com",
    someBool: false,
    someInt: 42,
  };
  assertEquals(configParser.getString(d, "startURL"), "https://example.com");
  assertEquals(configParser.getString(d, "missing", "default"), "default");
});

test("configParser getBool helper", () => {
  const d = { a: true, b: false, c: 1, d: 0 };
  assertEquals(configParser.getBool(d, "a"), true);
  assertEquals(configParser.getBool(d, "b"), false);
  assertEquals(configParser.getBool(d, "c"), true);
  assertEquals(configParser.getBool(d, "d"), false);
  assertEquals(configParser.getBool(d, "missing", true), true);
});

test("self-closing <array/> does not swallow following keys", () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<plist version="1.0">\n' +
    "<dict>\n" +
    "  <key>URLFilterRules</key>\n" +
    "  <array/>\n" +
    "  <key>startURL</key>\n" +
    "  <string>https://example.com/exam</string>\n" +
    "  <key>sendBrowserExamKey</key>\n" +
    "  <true/>\n" +
    "</dict>\n" +
    "</plist>";
  const result = configParser.loadConfig(Buffer.from(xml, "utf-8"));
  assert(result !== null, "result should not be null");
  assert(Array.isArray(result.dict.URLFilterRules), "URLFilterRules must be []");
  assertEquals(result.dict.URLFilterRules.length, 0);
  assertEquals(result.dict.startURL, "https://example.com/exam");
  assertEquals(result.dict.sendBrowserExamKey, true);
});

test("loadConfig parses a single-gzipped XML payload", () => {
  const zlib = require("zlib");
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<plist version="1.0"><dict>' +
    "<key>startURL</key><string>https://example.com/exam</string>" +
    "</dict></plist>";
  const gz = zlib.gzipSync(Buffer.from(xml, "utf-8"));
  const result = configParser.loadConfig(gz);
  assert(result !== null);
  assertEquals(result.format, "xml");
  assertEquals(result.dict.startURL, "https://example.com/exam");
});

test("loadConfig parses canonical SEB binary plnd block (gzip(plnd + gzip(xml)))", () => {
  const zlib = require("zlib");
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<plist version="1.0"><dict>' +
    "<key>startURL</key><string>https://example.com/binary</string>" +
    "</dict></plist>";
  const innerGz = zlib.gzipSync(Buffer.from(xml, "utf-8"));
  const block = Buffer.concat([Buffer.from("plnd", "ascii"), innerGz]);
  const outerGz = zlib.gzipSync(block);
  const result = configParser.loadConfig(outerGz);
  assert(result !== null, "binary result should not be null");
  assertEquals(result.format, "binary");
  assertEquals(result.dict.startURL, "https://example.com/binary");
});

test("ENCRYPTED_BLOCK_PREFIXES uses canonical 4-char block names", () => {
  const expected = ["pswd", "pwcc", "pkhs", "phsk"];
  for (const p of expected) {
    assert(
      configParser.ENCRYPTED_BLOCK_PREFIXES.has(p),
      `expected ${p} in ENCRYPTED_BLOCK_PREFIXES`,
    );
  }
  assert(
    !configParser.ENCRYPTED_BLOCK_PREFIXES.has("pswcc"),
    "5-char pswcc should not be present (it's a Linux-only typo)",
  );
});

console.log("\n=== Session Tests ===");

test("SebSession loads config and computes keys", () => {
  const sess = new SebSession();
  sess.loadFromFile(path.join(__dirname, "example.seb"));
  assert(sess.startUrl === "https://example.com/exam",
    `Expected start URL, got ${sess.startUrl}`);
  assert(sess.configKey !== null, "configKey should be set");
  assert(sess.browserExamKey !== null, "browserExamKey should be set");
  assertEquals(typeof sess.configKey, "string");
  assertEquals(typeof sess.browserExamKey, "string");
  assertEquals(sess.configKey.length, 64);
  assertEquals(sess.browserExamKey.length, 64);
  assertEquals(sess.sebServerUrl, "https://exam-server.example.com");
  assertEquals(sess.sebServerConfiguration.institution, "1");
  assertEquals(sess.sebServerConfiguration.clientName, "seb-client");
  assertEquals(sess.sebServerConfiguration.apiDiscovery, "/exam-api/discovery");
  assertEquals(sess.sebServerConfiguration.pingInterval, 2500);
  assertEquals(sess.canConnectToServer(), true);
});

test("SebSession loads config from buffer", () => {
  const buf = fs.readFileSync(path.join(__dirname, "example.seb"));
  const sess = new SebSession();
  sess.loadFromBuffer(buf);
  assertEquals(sess.startUrl, "https://example.com/exam");
  assertEquals(sess.canConnectToServer(), true);
});

test("SebSession getHeaderRequestHash", () => {
  const sess = new SebSession();
  sess.loadFromFile(path.join(__dirname, "example.seb"));
  const h = sess.getHeaderRequestHash("https://example.com/page");
  assert(h !== null, "header request hash should not be null");
  assertEquals(h.length, 64);
});

test("SebSession getHeaderConfigKeyHash", () => {
  const sess = new SebSession();
  sess.loadFromFile(path.join(__dirname, "example.seb"));
  const h = sess.getHeaderConfigKeyHash("https://example.com/page");
  assert(h !== null, "header config key hash should not be null");
  assertEquals(h.length, 64);
});

test("SebSession getSeServerInfo returns platform info", () => {
  const sess = new SebSession();
  sess.loadFromFile(path.join(__dirname, "example.seb"));
  const info = sess.getSeServerInfo();
  assert(typeof info.osName === "string");
  assert(typeof info.sebVersion === "string");
  assert(typeof info.machineName === "string");
});

test("SebSession loads manual entry and hashes quit password", () => {
  const sess = new SebSession();
  sess.loadFromManualEntry({
    startUrl: "https://example.com/manual",
    browserExamKey: "a".repeat(64),
    quitPassword: "secret123",
  });
  assertEquals(sess.startUrl, "https://example.com/manual");
  assertEquals(sess.browserExamKey, "a".repeat(64));
  assertEquals(sess.serverBrowserExamKey, "a".repeat(64));
  assertEquals(sess.quitPassword, crypto.sha256Hex("secret123"));
  assertEquals(sess.getHeaderRequestHash("https://example.com/page").length, 64);
  assertEquals(sess.getHeaderConfigKeyHash("https://example.com/page"), null);
 });

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
