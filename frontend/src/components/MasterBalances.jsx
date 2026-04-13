import { useState } from 'react';
import axios from 'axios';

function fmtUsd(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTime(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function tierStyle(tier) {
  switch (tier) {
    case 'HEALTHY':
      return { bg: 'bg-green-500/10', border: 'border-green-500/30', text: 'text-green-400', label: 'HEALTHY' };
    case 'INFO':
      return { bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', text: 'text-yellow-400', label: 'INFO' };
    case 'WARN':
      return { bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-400', label: 'WARN' };
    case 'CRITICAL':
      return { bg: 'bg-red-500/10', border: 'border-red-500/50', text: 'text-red-400', label: 'CRITICAL' };
    default:
      return { bg: 'bg-gray-800', border: 'border-gray-700', text: 'text-gray-500', label: 'NO DATA' };
  }
}

// Simple SVG sparkline of the last 24h of readings. Scales balance to the
// min/max of the window so movement is visible even when the absolute range
// is small.
function Sparkline({ history, color = '#60a5fa', width = 180, height = 32 }) {
  if (!history || history.length < 2) {
    return <div className="text-[10px] text-gray-600">Not enough data for trend</div>;
  }

  const values = history.map((h) => Number(h.balance));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
    </svg>
  );
}

function BalanceCard({ platform, label, account, data, thresholds }) {
  const tier = data?.tier || null;
  const style = tierStyle(tier);
  const sparkColor = tier === 'CRITICAL' ? '#f87171' : tier === 'WARN' ? '#fb923c' : tier === 'INFO' ? '#facc15' : '#34d399';

  return (
    <div className={`rounded-xl border ${style.border} ${style.bg} p-4`}>
      <div className="flex justify-between items-start mb-2">
        <div>
          <p className="text-xs text-gray-500">{label}</p>
          <p className="text-[10px] text-gray-600 font-mono">{account}</p>
        </div>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${style.text} ${style.bg} border ${style.border}`}>
          {style.label}
        </span>
      </div>
      <p className={`text-2xl font-bold font-mono ${style.text}`}>{fmtUsd(data?.balance)}</p>
      <div className="mt-2">
        <Sparkline history={data?.history} color={sparkColor} />
      </div>
      <div className="mt-2 flex justify-between items-center text-[10px] text-gray-600">
        <span>Last check: {fmtTime(data?.checkedAt)}</span>
        <span>
          Warn ≤ {fmtUsd(thresholds?.WARN)} · Critical ≤ {fmtUsd(thresholds?.CRITICAL)}
        </span>
      </div>
    </div>
  );
}

export default function MasterBalances({ data, onRefresh, getAuthHeaders }) {
  const [sweeping, setSweeping] = useState(false);

  async function handleSweep() {
    setSweeping(true);
    try {
      await axios.post('/api/admin/master-balances/sweep', {}, { headers: getAuthHeaders() });
      // The sweep runs for up to ~90s; poll after 20s for a fresh reading.
      setTimeout(() => {
        onRefresh?.();
        setSweeping(false);
      }, 20000);
    } catch (err) {
      console.error('Sweep failed:', err);
      setSweeping(false);
    }
  }

  if (!data) return null;

  const blocked = data.blockedInvoiceCount || 0;

  return (
    <div className="mb-6">
      <div className="flex justify-between items-center mb-3">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Master Balances</h2>
        <div className="flex items-center gap-3">
          {blocked > 0 && (
            <span className="text-xs px-2 py-1 rounded bg-red-500/10 border border-red-500/30 text-red-400">
              ⛔ {blocked} invoice{blocked === 1 ? '' : 's'} blocked
            </span>
          )}
          <button
            onClick={handleSweep}
            disabled={sweeping}
            className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-gray-400 hover:text-white transition"
          >
            {sweeping ? 'Sweeping…' : 'Force Sweep'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
        <BalanceCard
          platform="PLAY777"
          label="Play777"
          account="Master715 · op 1110"
          data={data.play777}
          thresholds={data.thresholds}
        />
        <BalanceCard
          platform="ICONNECT"
          label="iConnect"
          account="tonydist"
          data={data.iconnect}
          thresholds={data.thresholds}
        />
      </div>
    </div>
  );
}
