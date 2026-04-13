import { useState } from 'react';

function fmt(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export default function InvoiceCard({ invoice, allocations, onConfirmWire, onTriggerLoad, onResendEmail, onShowEvents, onDelete }) {
  const [showReceipt, setShowReceipt] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const isPending = invoice.status === 'PENDING';
  const isFailed = invoice.status === 'FAILED';
  const isPaid = invoice.status === 'PAID';
  const isRequested = invoice.status === 'REQUESTED';
  const canResend = (isRequested || isPending) && invoice.qbInvoiceId;

  const receiptUrl = invoice.wireReceiptPath ? `/api/uploads/${invoice.wireReceiptPath}` : null;

  return (
    <>
      <div className="bg-[#1c1f2e] rounded-lg border border-gray-800 hover:border-gray-700 transition p-3 group">
        {/* Header */}
        <div className="flex justify-between items-start mb-1">
          <p className="font-semibold text-sm text-gray-200 capitalize">{invoice.vendorSlug}</p>
          <span className="text-[10px] text-gray-600 font-mono">{timeAgo(invoice.submittedAt)}</span>
        </div>
        <p className="text-[10px] text-gray-500 font-mono mb-2">#{invoice.qbInvoiceId || invoice.id}</p>

        {/* Method & Amount */}
        <div className="flex justify-between items-baseline mb-3">
          <span className="text-[10px] uppercase tracking-wider text-gray-500">{invoice.method}</span>
          <span className="text-sm font-bold text-gray-100">{fmt(invoice.baseAmount)}</span>
        </div>

        {/* Wire Receipt Thumbnail */}
        {receiptUrl && (
          <button
            onClick={() => setShowReceipt(true)}
            className="mb-3 w-full rounded-md overflow-hidden border border-gray-700 hover:border-amber-500/50 transition"
          >
            <img
              src={receiptUrl}
              alt="Wire receipt"
              className="w-full h-20 object-cover opacity-80 hover:opacity-100 transition"
            />
          </button>
        )}

        {/* Allocations */}
        <div className="space-y-1.5 mb-1">
          {allocations
            .filter((a) => a.dollarAmount > 0)
            .map((a, i) => {
              const platform = a.platform === 'PLAY777' ? '777' : 'IC';
              const id = a.operatorId ? ` ${a.operatorId}` : '';
              return (
                <div key={i} className="flex justify-between items-center text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1 h-1 rounded-full ${a.platform === 'PLAY777' ? 'bg-blue-400' : 'bg-emerald-400'}`}></span>
                    <span className="text-gray-500">{platform}</span>
                    <span className="text-gray-400">{a.username}{id}</span>
                  </div>
                  <span className="font-mono text-gray-300">{a.credits.toLocaleString()}</span>
                </div>
              );
            })}
        </div>

        {/* Actions */}
        {isPending && (
          <button
            onClick={() => onConfirmWire(invoice.id)}
            className="mt-3 w-full text-xs font-semibold py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition"
          >
            Confirm Wire
          </button>
        )}

        {isFailed && (
          <button
            onClick={() => onTriggerLoad(invoice.id)}
            className="mt-3 w-full text-xs font-semibold py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 transition"
          >
            Retry Load
          </button>
        )}

        {isPaid && (
          <button
            onClick={() => onTriggerLoad(invoice.id)}
            className="mt-3 w-full text-xs font-semibold py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 hover:bg-blue-500/20 transition"
          >
            Trigger Load
          </button>
        )}

        {canResend && (
          <button
            onClick={() => onResendEmail(invoice.id)}
            className="mt-2 w-full text-xs font-semibold py-2 rounded-lg bg-gray-500/10 border border-gray-500/30 text-gray-400 hover:bg-gray-500/20 transition"
          >
            Resend Email
          </button>
        )}

        {onShowEvents && (
          <button
            onClick={() => onShowEvents(invoice.id)}
            className="mt-2 w-full text-xs font-semibold py-1.5 rounded-lg text-[#2563eb] hover:bg-[#2563eb]/10 transition"
          >
            Events
          </button>
        )}

        {onDelete && (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="mt-2 w-full text-xs py-1.5 rounded-lg text-red-500/50 hover:text-red-400 hover:bg-red-500/10 transition"
          >
            Delete
          </button>
        )}
      </div>

      {/* Delete Confirmation */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div
            className="bg-[#1c1f2e] rounded-xl border border-gray-700 p-6 max-w-sm w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-200 mb-2">Delete Invoice?</h3>
            <div className="text-sm text-gray-400 mb-4 space-y-1">
              <p><span className="text-gray-500">Vendor:</span> <span className="capitalize">{invoice.vendorSlug}</span></p>
              <p><span className="text-gray-500">Invoice:</span> #{invoice.qbInvoiceId || invoice.id}</p>
              <p><span className="text-gray-500">Amount:</span> {fmt(invoice.baseAmount)}</p>
            </div>
            <p className="text-xs text-red-400/70 mb-5">
              This will permanently remove this invoice and all related records.
              {invoice.qbInvoiceId && ' The QuickBooks invoice will be voided.'}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 text-sm py-2 rounded-lg bg-gray-700/50 text-gray-400 hover:bg-gray-700 transition"
              >
                Cancel
              </button>
              <button
                onClick={() => { onDelete(invoice.id); setShowDeleteConfirm(false); }}
                className="flex-1 text-sm py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-red-400 hover:bg-red-500/30 transition font-semibold"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receipt Lightbox */}
      {showReceipt && receiptUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setShowReceipt(false)}
        >
          <div className="relative max-w-2xl max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setShowReceipt(false)}
              className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-gray-800 border border-gray-600 text-gray-300 hover:text-white flex items-center justify-center text-sm"
            >
              X
            </button>
            <img
              src={receiptUrl}
              alt="Wire receipt"
              className="rounded-lg max-h-[85vh] object-contain"
            />
          </div>
        </div>
      )}
    </>
  );
}
