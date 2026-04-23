// logger.js

// Default log level = INFO
const LOG_LEVEL = (process.env.LOG_LEVEL || "INFO").toUpperCase();

const LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function makeLogger(scope = "APP") {
  function write(level, msg, extra) {
    if (LEVELS[level] > LEVELS[LOG_LEVEL]) return;

    const line = `[${ts()}] [${scope}] [${level}] ${msg}${
      extra ? " " + JSON.stringify(extra) : ""
    }`;

    console.log(line);
  }

  return {
    info: (m, e) => write("INFO", m, e),
    warn: (m, e) => write("WARN", m, e),
    error: (m, e) => write("ERROR", m, e),
    debug: (m, e) => write("DEBUG", m, e),
  };
}

module.exports = { makeLogger };
