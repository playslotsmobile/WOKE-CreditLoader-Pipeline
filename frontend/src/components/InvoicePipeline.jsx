import InvoiceCard from './InvoiceCard';

const STATUS_CONFIG = {
  REQUESTED: { label: 'Requested', color: 'yellow', icon: '📩' },
  PENDING: { label: 'Pending Wire', color: 'orange', icon: '🔒' },
  PAID: { label: 'Paid', color: 'blue', icon: '💰' },
  LOADING: { label: 'Loading', color: 'purple', icon: '⏳' },
  LOADED: { label: 'Loaded', color: 'green', icon: '✅' },
  FAILED: { label: 'Failed', color: 'red', icon: '🚨' },
};

const COLUMN_STYLES = {
  yellow: 'border-yellow-500/30',
  orange: 'border-orange-500/30',
  blue: 'border-blue-500/30',
  purple: 'border-purple-500/30',
  green: 'border-green-500/30',
  red: 'border-red-500/30',
};

const DOT_STYLES = {
  yellow: 'bg-yellow-400',
  orange: 'bg-orange-400',
  blue: 'bg-blue-400',
  purple: 'bg-purple-400',
  green: 'bg-green-400',
  red: 'bg-red-400',
};

export default function InvoicePipeline({ invoices, statuses, onConfirmWire, onTriggerLoad, onResendEmail }) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: 'calc(100vh - 140px)' }}>
      {statuses.map((status) => {
        const config = STATUS_CONFIG[status] || { label: status, color: 'gray', icon: '' };
        const items = invoices.filter((i) => i.invoice.status === status);

        return (
          <div key={status} className="flex-shrink-0 w-64 sm:w-72">
            <div className={`h-full rounded-xl bg-[#161922] border ${COLUMN_STYLES[config.color]} p-3`}>
              {/* Column Header */}
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

              {/* Cards */}
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
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
