const https = require("https");
const http = require("http");
const os = require("os");

class SebServerClient {
  constructor(serverUrl, options) {
    this.serverUrl = serverUrl.replace(/\/$/, "");
    this.institution = options?.institution || "";
    this.sebVersion = options?.sebVersion || "0.1.0-linux";
    this.osName = options?.osName || (os.platform() + " " + os.release());
    this.machineName = options?.machineName || os.hostname();
    this.clientUserId = options?.clientUserId || safeUserName();
    this.examId = options?.examId || "";
    this.oauthClientName = options?.clientName || "";
    this.oauthClientSecret = options?.clientSecret || "";
    this.discoveryEndpoint = options?.discoveryEndpoint || "/exam-api/discovery";
    this.pingInterval = options?.pingInterval || 1000;
    this.browserExamKey = options?.browserExamKey || "";
    this.configKey = options?.configKey || "";
    this.connectionToken = null;
    this.oauth2Token = null;
    this.api = null;
    this.appSignatureKeySalt = null;
    this.serverBrowserExamKey = null;
    this.endpoints = {};
    this.pingNumber = 0;
  }

  async fetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      const reqOpts = {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers: {
          "Content-Type": opts.contentType || "application/x-www-form-urlencoded",
          Accept: "application/json, */*",
          ...opts.headers,
        },
      };

      if (opts.body) {
        reqOpts.headers["Content-Length"] = Buffer.byteLength(opts.body);
      }

      const req = mod.request(reqOpts, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const bodyBuffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: bodyBuffer.toString("utf8"),
            bodyBuffer,
          });
        });
      });

      req.on("error", reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error("Request timeout")); });

      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  resolveUrl(pathOrUrl) {
    return new URL(pathOrUrl, this.serverUrl + "/").toString();
  }

  getEndpoint(name) {
    return this.endpoints[name]?.location || null;
  }

  async connect() {
    try {
      const res = await this.fetch(this.resolveUrl(this.discoveryEndpoint));
      if (res.status >= 400) {
        return { success: false, error: `API discovery failed: ${res.status}` };
      }

      try {
        this.api = JSON.parse(res.body);
      } catch (e) {
        return { success: false, error: "Failed to parse API response" };
      }

      const apiVersions = this.api["api-versions"] || this.api.api_versions || [];
      const version = apiVersions.find((entry) => entry.name === "v1") || apiVersions[0];
      if (!version || !Array.isArray(version.endpoints)) {
        return { success: false, error: "Exam API discovery response is missing endpoints" };
      }

      this.endpoints = {};
      for (const endpoint of version.endpoints) {
        if (endpoint?.name) {
          this.endpoints[endpoint.name] = endpoint;
        }
      }

      if (!this.getEndpoint("access-token-endpoint") || !this.getEndpoint("seb-handshake-endpoint")) {
        return { success: false, error: "Exam API discovery is missing required endpoints" };
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async authorize() {
    if (!this.oauthClientName || !this.oauthClientSecret) {
      return { success: false, error: "Missing SEB Server client credentials" };
    }

    const endpoint = this.getEndpoint("access-token-endpoint");
    if (!endpoint) {
      return { success: false, error: "Missing access token endpoint" };
    }

    const authorization = Buffer.from(
      `${this.oauthClientName}:${this.oauthClientSecret}`,
      "utf8",
    ).toString("base64");

    try {
      const res = await this.fetch(this.resolveUrl(endpoint), {
        method: "POST",
        headers: {
          Authorization: `Basic ${authorization}`,
        },
        body: "grant_type=client_credentials&scope=read write",
      });

      if (res.status >= 400) {
        return { success: false, error: `Access token request failed: ${res.status}`, body: res.body };
      }

      let tokenResponse;
      try {
        tokenResponse = JSON.parse(res.body);
      } catch (e) {
        return { success: false, error: "Failed to parse access token response" };
      }

      if (!tokenResponse.access_token) {
        return { success: false, error: "Access token response did not contain an access token" };
      }

      this.oauth2Token = tokenResponse.access_token;
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async getAvailableExams() {
    const endpoint = this.getEndpoint("seb-handshake-endpoint");
    if (!this.api || !endpoint || !this.oauth2Token) {
      return { success: false, error: "Not connected" };
    }

    const clientInfo = `client_id=${encodeURIComponent(this.clientUserId)}`;
    const machineInfo = `seb_machine_name=${encodeURIComponent(this.machineName)}`;
    const versionInfo = `seb_os_name=${encodeURIComponent(this.osName)}&seb_version=${encodeURIComponent(this.sebVersion)}`;
    const instId = `institutionId=${encodeURIComponent(this.institution)}`;
    const body = `${instId}&${clientInfo}&${machineInfo}&${versionInfo}${this.examId ? "&examId=" + encodeURIComponent(this.examId) : ""}`;

    try {
      const url = this.resolveUrl(endpoint);
      const res = await this.fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.oauth2Token}`,
        },
        body,
      });

      if (res.status >= 400) {
        return { success: false, error: `Handshake failed: ${res.status}`, body: res.body };
      }

      const connToken = res.headers["sebconnectiontoken"]?.toLowerCase();
      if (connToken) {
        this.connectionToken = res.headers["sebconnectiontoken"];
      }
      this.appSignatureKeySalt = res.headers["sebexamsalt"] || null;
      if (res.headers["sebserverbek"]) {
        this.serverBrowserExamKey = res.headers["sebserverbek"];
      }

      let exams = [];
      try {
        exams = JSON.parse(res.body);
      } catch (e) {
        return { success: false, error: "Failed to parse exams JSON" };
      }

      return { success: true, exams };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async selectExam(examId) {
    const endpoint = this.getEndpoint("seb-handshake-endpoint");
    if (!this.connectionToken || !endpoint || !this.oauth2Token) {
      return { success: false, error: "Not connected" };
    }

    try {
      const url = this.resolveUrl(endpoint);
      const res = await this.fetch(url, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${this.oauth2Token}`,
          SEBConnectionToken: this.connectionToken,
        },
        body: `examId=${encodeURIComponent(examId)}`,
      });

      if (res.status >= 400) {
        return { success: false, error: `Select exam failed: ${res.status}` };
      }

      this.appSignatureKeySalt = res.headers["sebexamsalt"] || null;

      if (res.headers["sebserverbek"]) {
        this.serverBrowserExamKey = res.headers["sebserverbek"];
      }

      return { success: true, appSignatureKeySalt: this.appSignatureKeySalt };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async establishConnection(examId, userSessionId = "", appSignatureKey = "") {
    const endpoint = this.getEndpoint("seb-handshake-endpoint");
    if (!this.connectionToken || !endpoint || !this.oauth2Token) {
      return { success: false, error: "Not connected" };
    }

    const params = [];
    if (examId) params.push(`examId=${encodeURIComponent(examId)}`);
    if (userSessionId) params.push(`seb_user_session_id=${encodeURIComponent(userSessionId)}`);
    if (appSignatureKey) params.push(`seb_signature_key=${encodeURIComponent(appSignatureKey)}`);

    try {
      const res = await this.fetch(this.resolveUrl(endpoint), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.oauth2Token}`,
          SEBConnectionToken: this.connectionToken,
        },
        body: params.join("&"),
      });

      if (res.status >= 400) {
        return { success: false, error: `Establish connection failed: ${res.status}`, body: res.body };
      }

      this.appSignatureKeySalt = res.headers["sebexamsalt"] || this.appSignatureKeySalt;
      if (res.headers["sebserverbek"]) {
        this.serverBrowserExamKey = res.headers["sebserverbek"];
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async downloadExamConfig(examId) {
    const endpoint = this.getEndpoint("seb-configuration-endpoint");
    if (!this.connectionToken || !endpoint || !this.oauth2Token) {
      return { success: false, error: "Not connected" };
    }

    const url = new URL(this.resolveUrl(endpoint));
    if (examId) {
      url.searchParams.set("examId", examId);
    }

    try {
      const res = await this.fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/octet-stream, application/json, */*",
          Authorization: `Bearer ${this.oauth2Token}`,
          SEBConnectionToken: this.connectionToken,
        },
      });

      if (res.status >= 400) {
        return { success: false, error: `Exam config download failed: ${res.status}`, body: res.body };
      }

      return { success: true, configBuffer: res.bodyBuffer };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async sendPing(instructionConfirm = "") {
    const endpoint = this.getEndpoint("seb-ping-endpoint");
    if (!this.connectionToken || !endpoint || !this.oauth2Token) {
      return { success: false, error: "Not connected" };
    }

    this.pingNumber += 1;
    let body = `timestamp=${Date.now()}&ping-number=${this.pingNumber}`;
    if (instructionConfirm) {
      body += `&instruction-confirm=${encodeURIComponent(instructionConfirm)}`;
    }

    try {
      const res = await this.fetch(this.resolveUrl(endpoint), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.oauth2Token}`,
          SEBConnectionToken: this.connectionToken,
        },
        body,
      });

      if (res.status >= 400) {
        return { success: false, error: `Ping failed: ${res.status}`, body: res.body };
      }

      let instruction = null;
      if (res.body && res.body.trim().length > 0) {
        try {
          instruction = JSON.parse(res.body);
        } catch (e) {
          instruction = null;
        }
      }

      return { success: true, instruction };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async disconnect() {
    const endpoint = this.getEndpoint("seb-handshake-endpoint");
    if (!this.connectionToken || !endpoint || !this.oauth2Token) return { success: true };

    try {
      const url = this.resolveUrl(endpoint);
      await this.fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.oauth2Token}`,
          SEBConnectionToken: this.connectionToken,
        },
      });
      this.connectionToken = null;
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

function safeUserName() {
  try {
    return os.userInfo().username;
  } catch (e) {
    return os.hostname();
  }
}

module.exports = { SebServerClient };
