# seb-linux

Safe Exam Browser - Linux Port (Educational Prototype)

## Build & Run

```bash
cd seb-linux
npm install
npm start -- /path/to/config.seb
```

Without a config file:

```bash
npm start -- seb://https://example.com
```

## Features

- Parse `.seb` configuration files (XML plist & binary format)
- Compute Browser Exam Key (HMAC-SHA256 over settings XML)
- Compute Config Key (SHA256 over sorted JSON of settings)
- Inject `X-SafeExamBrowser-RequestHash` header per-request
- Inject `X-SafeExamBrowser-ConfigKeyHash` header per-request
- Custom User-Agent override from config
- Fullscreen kiosk browser mode
- Quit password support (SHA256 hash comparison)
- `seb://` protocol handler
- URL filter rule support (allow/block)
- SEB Server discovery, OAuth2 handshake, and exam config download

## Configuration Keys Supported

| Key | Description |
|-----|-------------|
| `startURL` | Exam start page URL |
| `startURLs` | Multiple start URLs (uses first) |
| `quitPassword` / `hashedQuitPassword` | SHA256 hashed quit password |
| `allowQuit` | Allow quitting without password |
| `sebServerURL` | SEB Server URL |
| `sebServerConfiguration` | SEB Server client credentials and discovery settings |
| `browserUserAgent*` | Custom user agent strings |
| `URLFilterRules` | URL allow/block rules |
| `examKeySalt` | Salt for Browser Exam Key |

## SEB Server Flow

If a `.seb` file contains `sebServerURL` plus a `sebServerConfiguration` dictionary,
`seb-linux` will:

1. Fetch the exam API discovery document.
2. Request an OAuth2 access token with the exported `clientName` and `clientSecret`.
3. Perform the SEB Server handshake.
4. Download the server-provided exam configuration.
5. Start the exam URL from that downloaded config.

Current limitation:

- Server-delivered encrypted exam configs are not supported yet. Plain XML exam configs work.

## Architecture

```
seb-linux/
  src/
    main.js          - Electron main process, window management, SEB headers
    preload.js        - Context bridge for renderer process
    session.js        - SEB session state, config key computation
    configParser.js   - .seb file parser (XML plist + binary)
    crypto.js         - SHA256, HMAC-SHA256, Config Key computation
    appState.js       - Singleton session state
  package.json
```

## Limitations

This is an educational prototype. It does NOT implement:
- Windows/macOS desktop lockdown features
- Process monitoring/prohibition
- Virtual machine detection
- Screen proctoring client
- Integrity verification
- MDM/enterprise management
