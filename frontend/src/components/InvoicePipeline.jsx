import { useState } from 'react';
import InvoiceCard from './InvoiceCard';

const STATUS_CONFIG = {
  REQUESTED: { label: 'Requested', color: 'yellow', icon: '📩' },
  PENDING: { label: 'Pending Wire', color: 'orange', icon: '🔒' },
  PAID: { label: 'Paid', color: 'blue', icon: '💰' },
  BLOCKED_LOW_MASTER: { label: 'Blocked (Low Master)', color: 'fuchsia', icon: '⛔' },
  LOADING: { label: 'Loading', color: 'purple', icon: '⏳' },
  LOADED: { label: 'Loaded', color: 'green', icon: '✅' },
  FAILED: { label: 'Failed', color: 'red', icon: '🚨' },
};

const COLUMN_STYLES = {
  yellow: 'border-yellow-500/30',
  orange: 'border-orange-500/30',
  blue: 'border-blue-500/30',
  fuchsia: 'border-fuchsia-500/30',
  purple: 'border-purple-500/30',
  green: 'border-green-500/30',
  red: 'border-red-500/30',
};

const DOT_STYLES = {
  yellow: 'bg-yellow-400',
  orange: 'bg-orange-400',
  blue: 'bg-blue-400',
  fuchsia: 'bg-fuchsia-400',
  purple: 'bg-purple-400',
  green: 'bg-green-400',
  red: 'bg-red-400',
};

const HEADER_TEXT = {
  yellow: 'text-yellow-400',
  orange: 'text-orange-400',
  blue: 'text-blue-400',
  fuchsia: 'text-fuchsia-400',
  purple: 'text-purple-400',
  green: 'text-green-400',
  red: 'text-red-400',
};

const COLUMN_PAGE_SIZE = 10;

export default function InvoicePipeline({ invoices, statuses, onConfirmWire, onTriggerLoad, onMarkLoaded, onResendEmail, onShowEvents, onDelete }) {
  // Mobile: auto-expand columns that have items, collapse empty ones
  const [expanded, setExpanded] = useState(() => {
    const initial = {};
    statuses.forEach((s) => {
      const count = invoices.filter((i) => i.invoice.status === s).length;
      initial[s] = count > 0;
    });
    return initial;
  });

  const [pages, setPages] = useState({});

  function toggleExpand(status) {
    setExpanded((prev) => ({ ...prev, [status]: !prev[status] }));
  }

  function getPage(status) { return pages[status] || 1; }
  function setColumnPage(status, p) { setPages((prev) => ({ ...prev, [status]: p })); }

  function ColumnPager({ status, total }) {
    const totalPages = Math.max(1, Math.ceil(total / COLUMN_PAGE_SIZE));
    if (totalPages <= 1) return null;
    const page = getPage(status);
    const from = (page - 1) * COLUMN_PAGE_SIZE + 1;
    const to = Math.min(page * COLUMN_PAGE_SIZE, total);
    const btn = 'px-2 py-0.5 text-[10px] rounded border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-30';
    return (
      <div className="mt-3 pt-2 border-t border-gray-800">
        <div className="text-[10px] text-gray-500 text-center mb-1">{from}–{to} of {total}</div>
        <div className="flex items-center justify-center gap-1">
          <button className={btn} onClick={() => setColumnPage(status, Math.max(1, page - 1))} disabled={page === 1}>Prev</button>
          <span className="text-[10px] text-gray-400 px-1">{page}/{totalPages}</span>
          <button className={btn} onClick={() => setColumnPage(status, Math.min(totalPages, page + 1))} disabled={page >= totalPages}>Next</button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Desktop: horizontal kanban */}
      <div className="hidden sm:flex gap-4 overflow-x-auto pb-4" style={{ minHeight: 'calc(100vh - 140px)' }}>
        {statuses.map((status) => {
          const config = STATUS_CONFIG[status] || { label: status, color: 'gray', icon: '' };
          const items = invoices.filter((i) => i.invoice.status === status);
          const page = getPage(status);
          const pageItems = items.slice((page - 1) * COLUMN_PAGE_SIZE, page * COLUMN_PAGE_SIZE);

          return (
            <div key={status} className="flex-shrink-0 w-72">
              <div className={`h-full rounded-xl bg-[#161922] border ${COLUMN_STYLES[config.color]} p-3`}>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${DOT_STYLES[config.color]}`}></div>
                    <h2 className="font-semibold text-sm text-gray-300">
                      {config.label}
                    </h2>
                  </div>
                  {items.length > 0 && (
                    <span className="text-xs font-mono bg-gray-800 text-gray-500 rounded-md px-1.5 py-0.5">
                      {items.length}
                    </span>
                  )}
                </div>
                <div className="space-y-3">
                  {items.length === 0 ? (
                    <div className="flex items-center justify-center py-8">
                      <p className="text-xs text-gray-600">Empty</p>
                    </div>
                  ) : (
                    pageItems.map((item) => (
                      <InvoiceCard
                        key={item.invoice.id}
                        invoice={item.invoice}
                        allocations={item.allocations}
                        onConfirmWire={onConfirmWire}
                        onTriggerLoad={onTriggerLoad}
                        onMarkLoaded={onMarkLoaded}
                        onResendEmail={onResendEmail}
                        onShowEvents={onShowEvents}
                        onDelete={onDelete}
                      />
                    ))
                  )}
                </div>
                <ColumnPager status={status} total={items.length} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Mobile: vertical accordion */}
      <div className="sm:hidden space-y-2">
        {statuses.map((status) => {
          const config = STATUS_CONFIG[status] || { label: status, color: 'gray', icon: '' };
          const items = invoices.filter((i) => i.invoice.status === status);
          const isOpen = expanded[status];
          const page = getPage(status);
          const pageItems = items.slice((page - 1) * COLUMN_PAGE_SIZE, page * COLUMN_PAGE_SIZE);

          return (
            <div key={status} className={`rounded-xl bg-[#161922] border ${COLUMN_STYLES[config.color]} overflow-hidden`}>
              {/* Accordion header */}
              <button
                onClick={() => toggleExpand(status)}
                className="w-full flex items-center justify-between px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${DOT_STYLES[config.color]}`}></div>
                  <span className={`font-semibold text-sm ${HEADER_TEXT[config.color]}`}>
                    {config.label}
                  </span>
                  {items.length > 0 && (
                    <span className="text-xs font-mono bg-gray-800 text-gray-500 rounded-md px-1.5 py-0.5">
                      {items.length}
                    </span>
                  )}
                </div>
                <span className="text-gray-600 text-xs">{isOpen ? '▲' : '▼'}</span>
              </button>

              {/* Accordion content */}
              {isOpen && (
                <div className="px-3 pb-3 space-y-3">
                  {items.length === 0 ? (
                    <p className="text-xs text-gray-600 text-center py-4">Empty</p>
                  ) : (
                    pageItems.map((item) => (
                      <InvoiceCard
                        key={item.invoice.id}
                        invoice={item.invoice}
                        allocations={item.allocations}
                        onConfirmWire={onConfirmWire}
                        onTriggerLoad={onTriggerLoad}
                        onMarkLoaded={onMarkLoaded}
                        onResendEmail={onResendEmail}
                        onShowEvents={onShowEvents}
                        onDelete={onDelete}
                      />
                    ))
                  )}
                  <ColumnPager status={status} total={items.length} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
