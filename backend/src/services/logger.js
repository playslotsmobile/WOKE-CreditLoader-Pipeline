const fs = require('fs');
const path = require('path');

// DST-aware Chicago timestamp. Returns ISO-ish string with the correct offset
// (-05:00 in CDT, -06:00 in CST). Uses Intl to compute the actual offset for
// "now" in America/Chicago, avoiding the half-the-year drift of a fixed -05:00.
function cdtTimestamp() {
  const now = new Date();
  // Format components in Chicago tz, then reconstruct as ISO with the right offset.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  // Hour from Intl is "24" at midnight in some impls; normalize.
  const hh = parts.hour === '24' ? '00' : parts.hour;
  // Compute current Chicago offset by comparing the formatted local time to UTC.
  const localMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +hh, +parts.minute, +parts.second);
  const offsetMin = Math.round((localMs - now.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const offH = String(Math.floor(absMin / 60)).padStart(2, '0');
  const offM = String(absMin % 60).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}${sign}${offH}:${offM}`;
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
