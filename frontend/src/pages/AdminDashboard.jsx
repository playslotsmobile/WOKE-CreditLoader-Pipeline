import { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import InvoicePipeline from '../components/InvoicePipeline';

const STATUSES = ['REQUESTED', 'PENDING', 'PAID', 'LOADING', 'LOADED'];

export default function AdminDashboard() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('pipeline');
  const [vendors, setVendors] = useState([]);

  // Fake lifetime stats per vendor (until DB is live)
  const vendorStats = [
    { slug: 'cesar', name: 'Cesar Rivera', business: 'CGR SOFTWARE LLC', totalSpent: 142500, totalCredits: 407143, invoiceCount: 47, lastActive: '2026-04-01' },
    { slug: 'claudia', name: 'Claudia Cardenas', business: 'JCSOFTWARE', totalSpent: 128300, totalCredits: 366571, invoiceCount: 41, lastActive: '2026-04-02' },
    { slug: 'karla', name: 'Karla Rivera', business: 'LFM SOFTWARE LLC', totalSpent: 98700, totalCredits: 282000, invoiceCount: 33, lastActive: '2026-04-01' },
    { slug: 'mike', name: 'Mike Perez', business: 'OSL DEVELOPMENT LLC', totalSpent: 87200, totalCredits: 235676, invoiceCount: 29, lastActive: '2026-03-30' },
    { slug: 'yuli', name: 'Yuli', business: 'KKS SOFTWARE LLC', totalSpent: 76500, totalCredits: 191250, invoiceCount: 25, lastActive: '2026-04-02' },
    { slug: 'venisa', name: 'Venisa Vasquez', business: 'Venisa Vasquez', totalSpent: 68400, totalCredits: 171000, invoiceCount: 22, lastActive: '2026-03-29' },
    { slug: 'gilberto', name: 'Gilberto Rivera', business: 'GRR SOFTWARE LLC', totalSpent: 54200, totalCredits: 154857, invoiceCount: 18, lastActive: '2026-04-01' },
    { slug: 'alex', name: 'Alex Noz', business: 'GREAT RED SOLUTIONS LLC', totalSpent: 48900, totalCredits: 139714, invoiceCount: 16, lastActive: '2026-04-02' },
    { slug: 'luis', name: 'Luis Salinas', business: 'SaraLeasing LLC', totalSpent: 42300, totalCredits: 105750, invoiceCount: 14, lastActive: '2026-03-28' },
    { slug: 'cody', name: 'Cody Trejo', business: 'Cody Trejo', totalSpent: 38700, totalCredits: 77400, invoiceCount: 13, lastActive: '2026-03-31' },
    { slug: 'lorena', name: 'Lorena Delgado', business: 'DELGADO INNOVATIONS LLC', totalSpent: 35100, totalCredits: 100286, invoiceCount: 12, lastActive: '2026-03-27' },
    { slug: 'lynette', name: 'Lynette', business: 'AC DRIP LLC', totalSpent: 31500, totalCredits: 78750, invoiceCount: 10, lastActive: '2026-03-30' },
    { slug: 'jose', name: 'Jose Gracia', business: 'Jose Gracia', totalSpent: 27800, totalCredits: 92667, invoiceCount: 9, lastActive: '2026-03-25' },
    { slug: 'leo', name: 'Leo', business: 'GS SOFTWARE LLC', totalSpent: 22400, totalCredits: 44800, invoiceCount: 7, lastActive: '2026-03-26' },
  ];

  const fetchInvoices = useCallback(async () => {
    try {
      const res = await axios.get('/api/admin/invoices');
      setInvoices(res.data);
    } catch (err) {
      console.error('Failed to fetch invoices:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInvoices();
    const interval = setInterval(fetchInvoices, 5000);
    return () => clearInterval(interval);
  }, [fetchInvoices]);

  async function handleConfirmWire(invoiceId) {
    try {
      await axios.post(`/api/admin/invoices/${invoiceId}/confirm-wire`);
      fetchInvoices();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to confirm wire');
    }
  }

  async function handleTriggerLoad(invoiceId) {
    try {
      await axios.post(`/api/admin/invoices/${invoiceId}/trigger-load`);
      fetchInvoices();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to trigger load');
    }
  }

  const counts = {};
  STATUSES.forEach((s) => {
    counts[s] = invoices.filter((i) => i.invoice.status === s).length;
  });
  const actionNeeded = counts.PENDING + counts.PAID + (counts.FAILED || 0);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0f1117]">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-gray-400">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0f1117] text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-[#161922]">
        <div className="max-w-full mx-auto px-4 sm:px-6 py-3 sm:py-4">
          {/* Top row: logo + refresh */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <h1 className="text-lg font-bold tracking-tight">
                <span className="text-blue-400">WOKE</span>
                <span className="text-gray-400">AVR</span>
              </h1>
              <div className="h-5 w-px bg-gray-700 hidden sm:block"></div>
              <span className="text-sm text-gray-500 hidden sm:inline">Credit Loader</span>
            </div>

            <div className="flex items-center gap-3 sm:gap-6">
              {/* Stats */}
              <div className="flex items-center gap-3 sm:gap-4 text-xs">
                <Stat label="Total" value={invoices.length} color="text-gray-400" />
                <Stat label="Action" value={actionNeeded} color={actionNeeded > 0 ? 'text-amber-400' : 'text-gray-500'} />
                <Stat label="Loaded" value={counts.LOADED} color="text-green-400" />
              </div>

              <button
                onClick={fetchInvoices}
                className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-400 hover:text-white transition"
              >
                Refresh
              </button>
            </div>
          </div>

          {/* Bottom row: view toggle */}
          <div className="flex mt-3 sm:mt-2">
            <div className="flex bg-gray-800 rounded-lg p-0.5">
              <button
                onClick={() => setView('pipeline')}
                className={`px-3 py-1 text-xs rounded-md transition ${view === 'pipeline' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-300'}`}
              >
                Pipeline
              </button>
              <button
                onClick={() => setView('list')}
                className={`px-3 py-1 text-xs rounded-md transition ${view === 'list' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-300'}`}
              >
                List
              </button>
              <button
                onClick={() => setView('vendors')}
                className={`px-3 py-1 text-xs rounded-md transition ${view === 'vendors' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-300'}`}
              >
                Vendors
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="p-3 sm:p-6">
        {view === 'pipeline' ? (
          <InvoicePipeline
            invoices={invoices}
            statuses={STATUSES}
            onConfirmWire={handleConfirmWire}
            onTriggerLoad={handleTriggerLoad}
          />
        ) : view === 'vendors' ? (
          <VendorLeaderboard vendors={vendorStats} />
        ) : (
          <ListView
            invoices={invoices}
            onConfirmWire={handleConfirmWire}
            onTriggerLoad={handleTriggerLoad}
          />
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`font-bold text-base ${color}`}>{value}</span>
      <span className="text-gray-600">{label}</span>
    </div>
  );
}

function ListView({ invoices, onConfirmWire, onTriggerLoad }) {
  if (invoices.length === 0) {
    return <p className="text-gray-500 text-center py-12">No invoices yet.</p>;
  }

  return (
    <div className="bg-[#161922] rounded-xl border border-gray-800 overflow-x-auto">
      <table className="w-full text-sm min-w-[640px]">
        <thead>
          <tr className="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
            <th className="px-4 py-3">Vendor</th>
            <th className="px-4 py-3">Invoice</th>
            <th className="px-4 py-3">Method</th>
            <th className="px-4 py-3">Amount</th>
            <th className="px-4 py-3">Accounts</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Time</th>
            <th className="px-4 py-3">Action</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map(({ invoice, allocations }) => (
            <tr key={invoice.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
              <td className="px-4 py-3 font-medium text-gray-200">{invoice.vendorSlug}</td>
              <td className="px-4 py-3 text-gray-400">#{invoice.qbInvoiceId || invoice.id}</td>
              <td className="px-4 py-3 text-gray-400">{invoice.method}</td>
              <td className="px-4 py-3 text-gray-200">
                ${Number(invoice.baseAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1">
                  {allocations.filter((a) => a.dollarAmount > 0).map((a, i) => {
                    const p = a.platform === 'PLAY777' ? '7' : 'IC';
                    return (
                      <span key={i} className="text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">
                        {p}:{a.credits.toLocaleString()}
                      </span>
                    );
                  })}
                </div>
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={invoice.status} />
              </td>
              <td className="px-4 py-3 text-xs text-gray-500">
                {new Date(invoice.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </td>
              <td className="px-4 py-3">
                {invoice.status === 'PENDING' && (
                  <button onClick={() => onConfirmWire(invoice.id)} className="text-xs px-2 py-1 bg-amber-600/20 text-amber-400 hover:bg-amber-600/30 rounded transition">
                    Confirm Wire
                  </button>
                )}
                {invoice.status === 'PAID' && (
                  <button onClick={() => onTriggerLoad(invoice.id)} className="text-xs px-2 py-1 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded transition">
                    Load
                  </button>
                )}
                {invoice.status === 'FAILED' && (
                  <button onClick={() => onTriggerLoad(invoice.id)} className="text-xs px-2 py-1 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded transition">
                    Retry
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VendorLeaderboard({ vendors }) {
  const totalSpentAll = vendors.reduce((s, v) => s + v.totalSpent, 0);
  const totalCreditsAll = vendors.reduce((s, v) => s + v.totalCredits, 0);
  const totalInvoicesAll = vendors.reduce((s, v) => s + v.invoiceCount, 0);

  return (
    <div>
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <SummaryCard label="Total Revenue" value={`$${(totalSpentAll / 1000).toFixed(0)}k`} sub="All vendors" color="text-green-400" />
        <SummaryCard label="Total Credits" value={(totalCreditsAll / 1000000).toFixed(2) + 'M'} sub="Loaded lifetime" color="text-blue-400" />
        <SummaryCard label="Total Invoices" value={totalInvoicesAll} sub="All time" color="text-purple-400" />
        <SummaryCard label="Active Vendors" value={vendors.length} sub="Current" color="text-amber-400" />
      </div>

      {/* Leaderboard */}
      <div className="bg-[#161922] rounded-xl border border-gray-800 overflow-x-auto">
        <table className="w-full text-sm min-w-[768px]">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3 w-12">#</th>
              <th className="px-4 py-3">Vendor</th>
              <th className="px-4 py-3">Business</th>
              <th className="px-4 py-3 text-right">Total Spent</th>
              <th className="px-4 py-3 text-right">Credits Loaded</th>
              <th className="px-4 py-3 text-right">Invoices</th>
              <th className="px-4 py-3 text-right">Avg / Invoice</th>
              <th className="px-4 py-3">Last Active</th>
              <th className="px-4 py-3 w-32">Volume</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((v, i) => {
              const pct = (v.totalSpent / vendors[0].totalSpent) * 100;
              const avg = v.totalSpent / v.invoiceCount;
              const isTop3 = i < 3;
              return (
                <tr key={v.slug} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
                  <td className="px-4 py-3">
                    {isTop3 ? (
                      <span className={`text-xs font-bold ${i === 0 ? 'text-yellow-400' : i === 1 ? 'text-gray-300' : 'text-amber-600'}`}>
                        {i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-600">{i + 1}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-200">{v.name}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{v.business}</td>
                  <td className="px-4 py-3 text-right font-mono text-gray-200">
                    ${v.totalSpent.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-blue-400">
                    {v.totalCredits.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400">{v.invoiceCount}</td>
                  <td className="px-4 py-3 text-right text-xs text-gray-500">
                    ${Math.round(avg).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {new Date(v.lastActive).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="w-full bg-gray-800 rounded-full h-1.5">
                      <div
                        className="h-1.5 rounded-full bg-gradient-to-r from-blue-500 to-blue-400"
                        style={{ width: `${pct}%` }}
                      ></div>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, sub, color }) {
  return (
    <div className="bg-[#161922] rounded-xl border border-gray-800 p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-[10px] text-gray-600 mt-1">{sub}</p>
    </div>
  );
}

function StatusBadge({ status }) {
  const styles = {
    REQUESTED: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    PENDING: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    PAID: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    LOADING: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
    LOADED: 'bg-green-500/15 text-green-400 border-green-500/30',
    FAILED: 'bg-red-500/15 text-red-400 border-red-500/30',
  };
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${styles[status] || 'bg-gray-800 text-gray-400'}`}>
      {status}
    </span>
  );
}
