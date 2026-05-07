import { useEffect, useState } from 'react';
import axios from 'axios';

function formatCDT(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }) + ' CDT';
}

function statusIcon(status) {
  const s = (status || '').toUpperCase();
  if (s === 'SUCCESS' || s === 'LOADED' || s === 'COMPLETED')
    return <span className="text-green-400 font-bold">&#10003;</span>;
  if (s === 'FAILED' || s === 'ERROR')
    return <span className="text-red-400 font-bold">&#10007;</span>;
  return <span className="text-blue-400 font-bold">&#9679;</span>;
}

export default function EventTimeline({ invoiceId, token, onClose }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState(null);

  useEffect(() => {
    if (!invoiceId) return;
    setLoading(true);
    setError(null);
    axios
      .get(`/api/admin/invoices/${invoiceId}/events`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((res) => setEvents(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Failed to load events'))
      .finally(() => setLoading(false));
  }, [invoiceId, token]);

  const filtered = errorsOnly
    ? events.filter((e) => {
        const s = (e.status || '').toUpperCase();
        return s === 'FAILED' || s === 'ERROR';
      })
    : events;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Panel */}
      <div
        className="relative w-full max-w-[500px] h-full overflow-y-auto"
        style={{ background: '#1a1a2e', borderLeft: '1px solid #333' }}
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 flex items-center justify-between px-4 py-3"
          style={{ background: '#1a1a2e', borderBottom: '1px solid #333' }}
        >
          <h2 className="text-sm font-bold text-gray-200">
            Events &mdash; Invoice #{invoiceId}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white text-lg leading-none transition"
          >
            &times;
          </button>
        </div>

        {/* Filter */}
        <div className="px-4 py-2" style={{ borderBottom: '1px solid #333' }}>
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => setErrorsOnly(e.target.checked)}
              className="accent-red-500"
            />
            Show Only Errors
          </label>
        </div>

        {/* Content */}
        <div className="px-4 py-3">
          {loading && (
            <div className="flex items-center gap-2 py-8 justify-center">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-gray-500">Loading events...</span>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-400 py-4 text-center">{error}</p>
          )}

          {!loading && !error && filtered.length === 0 && (
            <p className="text-xs text-gray-500 py-8 text-center">
              {errorsOnly ? 'No error events.' : 'No events recorded.'}
            </p>
          )}

          {!loading && !error && filtered.length > 0 && (
            <div className="space-y-0">
              {filtered.map((evt, idx) => {
                const isExpanded = expandedIdx === idx;
                const step = (evt.step || evt.type || 'unknown').replace(/_/g, ' ');
                const acctInfo = [evt.platform, evt.account || evt.username]
                  .filter(Boolean)
                  .join(' / ');
                const hasMeta =
                  evt.metadata && Object.keys(evt.metadata).length > 0;

                return (
                  <div
                    key={idx}
                    className="relative pl-6 pb-4"
                    style={{
                      borderLeft: idx < filtered.length - 1 ? '1px solid #333' : 'none',
                      marginLeft: '8px',
                    }}
                  >
                    {/* Dot */}
                    <div className="absolute left-[-6px] top-0.5">
                      {statusIcon(evt.status)}
                    </div>

                    <div className="ml-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium text-gray-200 capitalize">
                            {step}
                          </p>
                          {acctInfo && (
                            <p className="text-[10px] text-gray-500 mt-0.5">
                              {acctInfo}
                            </p>
                          )}
                        </div>
                        <span className="text-[10px] text-gray-600 whitespace-nowrap shrink-0">
                          {formatCDT(evt.timestamp || evt.createdAt)}
                        </span>
                      </div>

                      {evt.message && (
                        <p className="text-[11px] text-gray-400 mt-1">
                          {evt.message}
                        </p>
                      )}

                      {evt.screenshotPath && (
                        <a
                          href={`/api/screenshots/${evt.screenshotPath}?token=${encodeURIComponent(token || '')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block text-[10px] text-blue-400 hover:text-blue-300 mt-1 underline"
                        >
                          View Screenshot
                        </a>
                      )}

                      {hasMeta && (
                        <button
                          onClick={() =>
                            setExpandedIdx(isExpanded ? null : idx)
                          }
                          className="block text-[10px] text-gray-500 hover:text-gray-300 mt-1 transition"
                        >
                          {isExpanded ? 'Hide metadata' : 'Show metadata'}
                        </button>
                      )}

                      {hasMeta && isExpanded && (
                        <pre
                          className="mt-1 text-[10px] text-gray-500 bg-black/30 rounded p-2 overflow-x-auto max-h-48"
                          style={{ border: '1px solid #333' }}
                        >
                          {JSON.stringify(evt.metadata, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
