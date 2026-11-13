// Logger: timestamped lines to stdout, optionally tee'd to a run file.
// Never logs secrets: Bearer tokens and 64-hex private-key-looking strings
// are redacted before anything is written.
import fs from "node:fs";

const TOKEN_RE = /(Bearer\s+)[A-Za-z0-9._\-~+/=]+/g;
const PRIVKEY_RE = /\b0x[0-9a-fA-F]{64}\b/g;

export function redact(s) {
  return String(s)
    .replace(TOKEN_RE, "$1<redacted>")
    .replace(PRIVKEY_RE, "0x<redacted-private-key>");
}

export function ts() {
  return new Date().toISOString();
}

export function createLogger(filePath) {
  let stream = null;
  if (filePath) {
    fs.mkdirSync(filePath.split("/").slice(0, -1).join("/"), { recursive: true });
    stream = fs.createWriteStream(filePath, { flags: "a" });
  }
  function write(level, msg) {
    const line = `[${ts()}] [${level}] ${redact(msg)}`;
    console.log(line);
    if (stream) stream.write(line + "\n");
  }
  return {
    info: (m) => write("INFO", m),
    warn: (m) => write("WARN", m),
    error: (m) => write("ERROR", m),
    dry: (m) => write("DRY-RUN", m),
    close: () => stream?.end(),
  };
}
