const fs = require('fs');
const path = require('path');

function cdtTimestamp() {
  const now = new Date();
  const cdt = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const iso = cdt.toISOString().replace(/\.\d{3}Z$/, '-05:00');
  return iso;
}

function createLogger(stream = process.stdout) {
  function log(level, message, context = {}, parentCtx = {}) {
    const merged = { ...parentCtx, ...context };
    if (merged.error instanceof Error) {
      merged.error = `${merged.error.message}\n${merged.error.stack}`;
    }
    const entry = {
      timestamp: cdtTimestamp(),
      level,
      message,
      context: Object.keys(merged).length > 0 ? merged : undefined,
    };
    const line = JSON.stringify(entry) + '\n';
    if (stream.write) {
      stream.write(line);
    }
  }

  function makeLogger(parentCtx = {}) {
    return {
      info: (msg, ctx) => log('info', msg, ctx, parentCtx),
      warn: (msg, ctx) => log('warn', msg, ctx, parentCtx),
      error: (msg, ctx) => log('error', msg, ctx, parentCtx),
      debug: (msg, ctx) => log('debug', msg, ctx, parentCtx),
      child: (extraCtx) => makeLogger({ ...parentCtx, ...extraCtx }),
    };
  }

  return makeLogger();
}

function createFileLogger(invoiceId) {
  const logDir = '/var/log/creditloader/loads';
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {}
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logDir, `invoice-${invoiceId}-${ts}.log`);
  const fileStream = fs.createWriteStream(logPath, { flags: 'a' });
  return { logger: createLogger(fileStream), logPath, close: () => fileStream.end() };
}

const logger = createLogger();

module.exports = { logger, createLogger, createFileLogger };
