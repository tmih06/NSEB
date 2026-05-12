const crypto = require("./crypto");
const configParser = require("./configParser");
const fs = require("fs");
const path = require("path");
const os = require("os");

class SebSession {
  constructor() {
    this.settings = {};
    this.startUrl = null;
    this.configKey = null;
    this.browserExamKey = null;
    this.serverBrowserExamKey = null;
    this.examKeySalt = null;
    this.quitPassword = null;
    this.quitUrl = null;
    this.sebServerUrl = null;
    this.sebServerOauth2 = false;
    this.sebServerConfiguration = null;
    this.userAgent = null;
    this.urlFilterRules = [];
    this.allowQuit = true;
    this.hasSettingsPassword = false;
  }

  loadFromFile(filePath) {
    const buf = fs.readFileSync(filePath);
    return this.loadFromBuffer(buf);
  }

  loadFromBuffer(buf) {
    const result = configParser.loadConfig(buf);
    if (!result) throw new Error("Failed to parse SEB config file");
    this.settings = result.dict;
    this._extractSettings();
    this._computeKeys();
    return this;
  }

  loadFromUrl(url) {
    this.startUrl = url;
    return this;
  }

  loadFromManualEntry({ startUrl, browserExamKey, quitPassword }) {
    this.startUrl = startUrl;
    this.settings = { startURL: startUrl };
    if (browserExamKey) {
      this.browserExamKey = browserExamKey;
      this.serverBrowserExamKey = browserExamKey;
    }
    if (quitPassword) {
      this.quitPassword = crypto.sha256Hex(quitPassword);
    }
    this.allowQuit = true;
    return this;
  }

  _extractSettings() {
    const s = this.settings;

    this.startUrl = configParser.getString(s, "startURL", null);
    this.quitPassword = configParser.getString(s, "hashedQuitPassword", null) || configParser.getString(s, "quitPassword", null);
    this.quitUrl = configParser.getString(s, "quitURL", null);
    this.allowQuit = configParser.getBool(s, "allowQuit", true);
    this.hasSettingsPassword = !!configParser.getString(s, "hashedSettingsPassword", null);

    if (!this.startUrl) {
      const urls = s["startURLs"];
      if (urls && Array.isArray(urls) && urls.length > 0) {
        const first = urls[0];
        this.startUrl = typeof first === "string" ? first : first.url || first.startURL;
      }
    }

    this.sebServerUrl = configParser.getString(s, "sebServerURL", null);
    this.sebServerOauth2 = configParser.getBool(s, "sebServerOauth2", false);
    this.sebServerConfiguration = this._extractServerConfiguration(s);

    const uaDesktop = configParser.getString(s, "browserUserAgentWinDesktopModeCustom", null);
    const uaTouch = configParser.getString(s, "browserUserAgentWinTouchModeCustom", null);
    const uaMac = configParser.getString(s, "browserUserAgentMacCustom", null);
    const uaGeneric = configParser.getString(s, "browserUserAgent", null);
    const uaDesktopMode = configParser.getInt(s, "browserUserAgentWinDesktopMode", 0);
    const uaTouchMode = configParser.getInt(s, "browserUserAgentWinTouchMode", 0);
    const uaMacMode = configParser.getInt(s, "browserUserAgentMac", 0);

    if (uaDesktopMode === 1 && uaDesktop) this.userAgent = uaDesktop;
    else if (uaTouchMode === 2 && uaTouch) this.userAgent = uaTouch;
    else if (uaMacMode === 1 && uaMac) this.userAgent = uaMac;
    else if (uaGeneric) this.userAgent = uaGeneric;

    this.urlFilterRules = s["URLFilterRules"] || s["urlFilterRules"] || [];
    this.examKeySalt = s["examKeySalt"];
    if (this.examKeySalt instanceof Buffer) {
      this.examKeySalt = this.examKeySalt.toString("hex");
    }
  }

  _extractServerConfiguration(settings) {
    const config = settings["sebServerConfiguration"];
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return null;
    }

    return {
      institution: configParser.getString(config, "institution", ""),
      exam: configParser.getString(config, "exam", ""),
      clientName: configParser.getString(config, "clientName", ""),
      clientSecret: configParser.getString(config, "clientSecret", ""),
      apiDiscovery: configParser.getString(config, "apiDiscovery", "/exam-api/discovery"),
      pingInterval: configParser.getInt(config, "pingInterval", 1000),
    };
  }

  _computeKeys() {
    if (!this.examKeySalt) {
      this.examKeySalt = crypto.randomBytesHex(32);
    }

    const xmlStr = configToXmlString(this.settings);
    this.browserExamKey = crypto.computeBrowserExamKey(xmlStr, this.examKeySalt);
    this.configKey = crypto.computeConfigKey(this.settings);
  }

  getHeaderRequestHash(url) {
    const examKey = this.serverBrowserExamKey || this.browserExamKey;
    if (!examKey) return null;
    return crypto.computeHeaderRequestHash(examKey, url);
  }

  getHeaderConfigKeyHash(url) {
    if (!this.configKey) return null;
    return crypto.computeHeaderConfigKeyHash(this.configKey, url);
  }

  setServerBrowserExamKey(browserExamKey) {
    this.serverBrowserExamKey = browserExamKey || null;
  }

  canConnectToServer() {
    const config = this.sebServerConfiguration;
    return !!(
      this.sebServerUrl &&
      config &&
      config.institution &&
      config.clientName &&
      config.clientSecret
    );
  }

  getSeServerInfo() {
    return {
      osName: os.platform() + " " + os.release(),
      sebVersion: "0.1.0-linux",
      machineName: os.hostname(),
    };
  }
}

function configToXmlString(settings) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  );
  lines.push('<plist version="1.0">');
  lines.push("<dict>");
  encodeDict(settings, lines, 1);
  lines.push("</dict>");
  lines.push("</plist>");
  return lines.join("\n");
}

function encodeDict(dict, lines, indent) {
  const prefix = "  ".repeat(indent);
  for (const [k, v] of Object.entries(dict)) {
    lines.push(prefix + "<key>" + escapeXml(k) + "</key>");
    encodeValue(v, lines, indent);
  }
}

function encodeValue(v, lines, indent) {
  const prefix = "  ".repeat(indent);
  if (v === null || v === undefined) {
    lines.push(prefix + "<string></string>");
  } else if (typeof v === "boolean") {
    lines.push(prefix + (v ? "<true/>" : "<false/>"));
  } else if (typeof v === "number") {
    if (Number.isInteger(v)) {
      lines.push(prefix + "<integer>" + v + "</integer>");
    } else {
      lines.push(prefix + "<real>" + v + "</real>");
    }
  } else if (typeof v === "string") {
    lines.push(prefix + "<string>" + escapeXml(v) + "</string>");
  } else if (v instanceof Buffer || v instanceof Uint8Array) {
    lines.push(prefix + "<data>" + Buffer.from(v).toString("base64") + "</data>");
  } else if (Array.isArray(v)) {
    lines.push(prefix + "<array>");
    for (const item of v) encodeValue(item, lines, indent + 1);
    lines.push(prefix + "</array>");
  } else if (typeof v === "object") {
    lines.push(prefix + "<dict>");
    encodeDict(v, lines, indent + 1);
    lines.push(prefix + "</dict>");
  }
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

module.exports = { SebSession };
