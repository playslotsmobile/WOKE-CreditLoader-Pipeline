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

export default function InvoicePipeline({ invoices, statuses, onConfirmWire, onTriggerLoad, onResendEmail, onShowEvents }) {
  // Mobile: auto-expand columns that have items, collapse empty ones
  const [expanded, setExpanded] = useState(() => {
    const initial = {};
    statuses.forEach((s) => {
      const count = invoices.filter((i) => i.invoice.status === s).length;
      initial[s] = count > 0;
    });
    return initial;
  });

  function toggleExpand(status) {
    setExpanded((prev) => ({ ...prev, [status]: !prev[status] }));
  }

  return (
    <>
      {/* Desktop: horizontal kanban */}
      <div className="hidden sm:flex gap-4 overflow-x-auto pb-4" style={{ minHeight: 'calc(100vh - 140px)' }}>
        {statuses.map((status) => {
          const config = STATUS_CONFIG[status] || { label: status, color: 'gray', icon: '' };
          const items = invoices.filter((i) => i.invoice.status === status);

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
                    items.map((item) => (
                      <InvoiceCard
                        key={item.invoice.id}
                        invoice={item.invoice}
                        allocations={item.allocations}
                        onConfirmWire={onConfirmWire}
                        onTriggerLoad={onTriggerLoad}
                        onResendEmail={onResendEmail}
                        onShowEvents={onShowEvents}
                      />
                    ))
                  )}
                </div>
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
                    items.map((item) => (
                      <InvoiceCard
                        key={item.invoice.id}
                        invoice={item.invoice}
                        allocations={item.allocations}
                        onConfirmWire={onConfirmWire}
                        onTriggerLoad={onTriggerLoad}
                        onResendEmail={onResendEmail}
                        onShowEvents={onShowEvents}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
