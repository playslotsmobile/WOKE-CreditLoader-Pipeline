import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import InvoicePipeline from '../components/InvoicePipeline';
import EventTimeline from '../components/EventTimeline';
import MasterBalances from '../components/MasterBalances';

const STATUSES = ['REQUESTED', 'PENDING', 'PAID', 'BLOCKED_LOW_MASTER', 'LOADING', 'LOADED'];

function getAuthHeaders() {
  const token = localStorage.getItem('admin_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function AdminDashboard() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('dashboard');
  const [vendorStats, setVendorStats] = useState([]);
  const [selectedInvoiceEvents, setSelectedInvoiceEvents] = useState(null);
  const [creditLines, setCreditLines] = useState([]);
  const [clTransactions, setClTransactions] = useState([]);
  const [clVendorFilter, setClVendorFilter] = useState('');
  const [masterBalances, setMasterBalances] = useState(null);
  const navigate = useNavigate();

  function handleAuthError(err) {
    if (err.response?.status === 401) {
      localStorage.removeItem('admin_token');
      navigate('/admin/login');
    }
  }

  const fetchInvoices = useCallback(async () => {
    try {
      const res = await axios.get('/api/admin/invoices', { headers: getAuthHeaders() });
      setInvoices(res.data);
    } catch (err) {
      handleAuthError(err);
      console.error('Failed to fetch invoices:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchVendorStats = useCallback(async () => {
    try {
      const res = await axios.get('/api/admin/vendor-stats', { headers: getAuthHeaders() });
      setVendorStats(res.data);
    } catch (err) {
      handleAuthError(err);
      console.error('Failed to fetch vendor stats:', err);
    }
  }, []);

  const fetchCreditLines = useCallback(async () => {
    try {
      const res = await axios.get('/api/admin/credit-lines', { headers: getAuthHeaders() });
      setCreditLines(res.data);
    } catch (err) {
      handleAuthError(err);
    }
  }, []);

  const fetchClTransactions = useCallback(async () => {
    try {
      const params = clVendorFilter ? `?vendorSlug=${clVendorFilter}` : '';
      const res = await axios.get(`/api/admin/credit-line-transactions${params}`, { headers: getAuthHeaders() });
      setClTransactions(res.data);
    } catch (err) {
      handleAuthError(err);
    }
  }, [clVendorFilter]);

  const fetchMasterBalances = useCallback(async () => {
    try {
      const res = await axios.get('/api/admin/master-balances', { headers: getAuthHeaders() });
      setMasterBalances(res.data);
    } catch (err) {
      handleAuthError(err);
    }
  }, []);

  useEffect(() => {
    if (!localStorage.getItem('admin_token')) {
      navigate('/admin/login');
      return;
    }
    fetchInvoices();
    fetchVendorStats();
    fetchCreditLines();
    fetchClTransactions();
    fetchMasterBalances();
    const interval = setInterval(fetchInvoices, 5000);
    const balanceInterval = setInterval(fetchMasterBalances, 60000);
    return () => {
      clearInterval(interval);
      clearInterval(balanceInterval);
    };
  }, [fetchInvoices, fetchVendorStats, fetchCreditLines, fetchClTransactions, fetchMasterBalances]);

  useEffect(() => {
    fetchClTransactions();
  }, [clVendorFilter, fetchClTransactions]);

  async function handleConfirmWire(invoiceId) {
    try {
      await axios.post(`/api/admin/invoices/${invoiceId}/confirm-wire`, {}, { headers: getAuthHeaders() });
      fetchInvoices();
    } catch (err) {
      handleAuthError(err);
      alert(err.response?.data?.error || 'Failed to confirm wire');
    }
  }

  async function handleTriggerLoad(invoiceId) {
    try {
      await axios.post(`/api/admin/invoices/${invoiceId}/trigger-load`, {}, { headers: getAuthHeaders() });
      fetchInvoices();
    } catch (err) {
      handleAuthError(err);
      alert(err.response?.data?.error || 'Failed to trigger load');
    }
  }

  async function handleResendEmail(invoiceId) {
    try {
      const res = await axios.post(`/api/admin/invoices/${invoiceId}/resend-email`, {}, { headers: getAuthHeaders() });
      alert(res.data.message);
    } catch (err) {
      handleAuthError(err);
      alert(err.response?.data?.error || 'Failed to resend email');
    }
  }

  async function handleDelete(invoiceId) {
    try {
      await axios.delete(`/api/admin/invoices/${invoiceId}`, { headers: getAuthHeaders() });
      fetchInvoices();
    } catch (err) {
      handleAuthError(err);
      alert(err.response?.data?.error || 'Failed to delete invoice');
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
              <h1
                onClick={() => { setView('dashboard'); fetchInvoices(); fetchVendorStats(); fetchCreditLines(); fetchClTransactions(); }}
                className="text-lg font-bold tracking-tight cursor-pointer hover:opacity-80 transition"
              >
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
              <button
                onClick={() => { localStorage.removeItem('admin_token'); navigate('/admin/login'); }}
                className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-400 hover:text-white transition"
              >
                Logout
              </button>
            </div>
          </div>

          {/* Bottom row: view toggle */}
          <div className="flex mt-3 sm:mt-2">
            <div className="flex bg-gray-800 rounded-lg p-0.5">
              <button
                onClick={() => setView('dashboard')}
                className={`px-3 py-1 text-xs rounded-md transition ${view === 'dashboard' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-300'}`}
              >
                Dashboard
              </button>
              <button
                onClick={() => setView('pipeline')}
                className={`px-3 py-1 text-xs rounded-md transition ${view === 'pipeline' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-300'}`}
              >
                Pipeline
              </button>
              <button
                onClick={() => setView('creditLines')}
                className={`px-3 py-1 text-xs rounded-md transition ${view === 'creditLines' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-300'}`}
              >
                Credit Lines
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="p-3 sm:p-6">
        {view === 'dashboard' ? (
          <>
            <MasterBalances
              data={masterBalances}
              onRefresh={fetchMasterBalances}
              getAuthHeaders={getAuthHeaders}
            />
            <VendorLeaderboard vendors={vendorStats} />
          </>
        ) : view === 'pipeline' ? (
          <InvoicePipeline
            invoices={invoices}
            statuses={STATUSES}
            onConfirmWire={handleConfirmWire}
            onTriggerLoad={handleTriggerLoad}
            onResendEmail={handleResendEmail}
            onShowEvents={(id) => setSelectedInvoiceEvents(id)}
            onDelete={handleDelete}
          />
        ) : view === 'creditLines' ? (
          <CreditLinesView
            creditLines={creditLines}
            transactions={clTransactions}
            vendorFilter={clVendorFilter}
            onVendorFilter={(slug) => setClVendorFilter(slug)}
          />
        ) : null}
      </main>

      {selectedInvoiceEvents && (
        <EventTimeline
          invoiceId={selectedInvoiceEvents}
          token={localStorage.getItem('admin_token')}
          onClose={() => setSelectedInvoiceEvents(null)}
        />
      )}
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

function VendorLeaderboard({ vendors }) {
  if (vendors.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-500">No vendor activity yet. Stats will appear here once invoices are submitted.</p>
      </div>
    );
  }

  const totalSpentAll = vendors.reduce((s, v) => s + v.totalSpent, 0);
  const totalCreditsAll = vendors.reduce((s, v) => s + v.totalCredits, 0);
  const totalInvoicesAll = vendors.reduce((s, v) => s + v.invoiceCount, 0);
  const totalOwedAll = vendors.reduce((s, v) => s + (v.creditLineOwed || 0), 0);

  function fmtCompact(n) {
    if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
    return `$${n.toLocaleString()}`;
  }

  return (
    <div>
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 sm:gap-4 mb-6">
        <SummaryCard label="Total Revenue" value={fmtCompact(totalSpentAll)} sub="Paid invoices" color="text-green-400" />
        <SummaryCard label="Total Owed" value={fmtCompact(totalOwedAll)} sub="Credit line balance" color={totalOwedAll > 0 ? 'text-orange-400' : 'text-gray-500'} />
        <SummaryCard label="Total Credits" value={totalCreditsAll >= 1000000 ? (totalCreditsAll / 1000000).toFixed(2) + 'M' : totalCreditsAll.toLocaleString()} sub="Loaded lifetime" color="text-blue-400" />
        <SummaryCard label="Total Invoices" value={totalInvoicesAll} sub="Paid only" color="text-purple-400" />
        <SummaryCard label="Active Vendors" value={vendors.length} sub="With activity" color="text-amber-400" />
      </div>

      {/* Leaderboard */}
      <div className="bg-[#161922] rounded-xl border border-gray-800">
        {/* Mobile: card layout */}
        <div className="sm:hidden divide-y divide-gray-800/50">
          {vendors.map((v, i) => {
            const topSpent = vendors[0].totalSpent + vendors[0].totalCreditLine;
            const myTotal = v.totalSpent + (v.totalCreditLine || 0);
            const pct = topSpent > 0 ? (myTotal / topSpent) * 100 : 0;
            const avg = v.invoiceCount > 0 ? v.totalSpent / v.invoiceCount : 0;
            const isTop3 = i < 3;
            return (
              <div key={v.slug} className="px-4 py-3 space-y-2">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    {isTop3 ? (
                      <span className="text-sm">{i === 0 ? '\u{1F947}' : i === 1 ? '\u{1F948}' : '\u{1F949}'}</span>
                    ) : (
                      <span className="text-xs text-gray-600">{i + 1}</span>
                    )}
                    <span className="font-medium text-gray-200">{v.name}</span>
                  </div>
                  <span className="font-mono font-bold text-green-400">${v.totalSpent.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-gray-500">{v.business}</span>
                  <span className="font-mono text-blue-400">{v.totalCredits.toLocaleString()} credits</span>
                </div>
                {(v.creditLineOwed > 0 || v.totalCreditLine > 0) && (
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-orange-400">Owes: <span className="font-mono font-bold">${(v.creditLineOwed || 0).toLocaleString()}</span></span>
                    <span className="text-gray-500">CL drawn: ${(v.totalCreditLine || 0).toLocaleString()}</span>
                  </div>
                )}
                <div className="flex justify-between items-center text-xs text-gray-500">
                  <span>{v.invoiceCount} invoices{v.invoiceCount > 0 ? ` (avg $${Math.round(avg).toLocaleString()})` : ''}</span>
                  <span>{v.lastActive ? new Date(v.lastActive).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-'}</span>
                </div>
                <div className="w-full bg-gray-800 rounded-full h-1.5">
                  <div
                    className="h-1.5 rounded-full bg-gradient-to-r from-blue-500 to-blue-400"
                    style={{ width: `${pct}%` }}
                  ></div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Desktop: table layout */}
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3 w-12">#</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Business</th>
                <th className="px-4 py-3 text-right">Revenue</th>
                <th className="px-4 py-3 text-right">Owed</th>
                <th className="px-4 py-3 text-right">Credits</th>
                <th className="px-4 py-3 text-right">Invoices</th>
                <th className="px-4 py-3">Last Active</th>
                <th className="px-4 py-3 w-32">Volume</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v, i) => {
                const topTotal = vendors[0].totalSpent + (vendors[0].totalCreditLine || 0);
                const myTotal = v.totalSpent + (v.totalCreditLine || 0);
                const pct = topTotal > 0 ? (myTotal / topTotal) * 100 : 0;
                const isTop3 = i < 3;
                return (
                  <tr key={v.slug} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
                    <td className="px-4 py-3">
                      {isTop3 ? (
                        <span className={`text-xs font-bold ${i === 0 ? 'text-yellow-400' : i === 1 ? 'text-gray-300' : 'text-amber-600'}`}>
                          {i === 0 ? '\u{1F947}' : i === 1 ? '\u{1F948}' : '\u{1F949}'}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-600">{i + 1}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-200">{v.name}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{v.business}</td>
                    <td className="px-4 py-3 text-right font-mono text-green-400">
                      ${v.totalSpent.toLocaleString()}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono ${(v.creditLineOwed || 0) > 0 ? 'text-orange-400' : 'text-gray-600'}`}>
                      {(v.creditLineOwed || 0) > 0 ? `$${v.creditLineOwed.toLocaleString()}` : '-'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-blue-400">
                      {v.totalCredits.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-400">{v.invoiceCount}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {v.lastActive ? new Date(v.lastActive).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-'}
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

function CreditLinesView({ creditLines, transactions, vendorFilter, onVendorFilter }) {
  function fmtUsd(n) {
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  return (
    <div>
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-6">
        {creditLines.map((cl) => {
          const pct = cl.capAmount > 0 ? (cl.usedAmount / cl.capAmount) * 100 : 0;
          const color = pct > 80 ? 'text-red-400' : pct > 50 ? 'text-yellow-400' : 'text-green-400';
          return (
            <div
              key={cl.id}
              onClick={() => onVendorFilter(vendorFilter === cl.vendorSlug ? '' : cl.vendorSlug)}
              className={`bg-[#161922] rounded-xl border cursor-pointer transition ${
                vendorFilter === cl.vendorSlug ? 'border-blue-500' : 'border-gray-800 hover:border-gray-600'
              } p-4`}
            >
              <p className="text-xs text-gray-500 mb-1">{cl.vendorName}</p>
              <p className={`text-xl font-bold ${color}`}>{fmtUsd(cl.availableAmount)}</p>
              <div className="w-full bg-gray-800 rounded-full h-1.5 mt-2">
                <div
                  className={`h-1.5 rounded-full ${
                    pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${pct}%` }}
                ></div>
              </div>
              <p className="text-[10px] text-gray-600 mt-1">
                {fmtUsd(cl.usedAmount)} / {fmtUsd(cl.capAmount)} used
              </p>
            </div>
          );
        })}
      </div>

      {/* Transaction History */}
      <div className="bg-[#161922] rounded-xl border border-gray-800">
        <div className="flex justify-between items-center px-4 py-3 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-gray-300">
            Transaction History
            {vendorFilter && <span className="text-blue-400 ml-2">({vendorFilter})</span>}
          </h3>
          {vendorFilter && (
            <button
              onClick={() => onVendorFilter('')}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              Clear filter
            </button>
          )}
        </div>

        {transactions.length === 0 ? (
          <p className="px-4 py-8 text-center text-gray-500">No transactions yet.</p>
        ) : (
          <>
            {/* Mobile: card layout */}
            <div className="sm:hidden divide-y divide-gray-800/50">
              {transactions.map((t) => (
                <div key={t.id} className="px-4 py-3 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-medium text-gray-200 capitalize">{t.vendorName}</span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                      t.type === 'DRAW'
                        ? 'bg-orange-500/15 text-orange-400 border-orange-500/30'
                        : 'bg-green-500/15 text-green-400 border-green-500/30'
                    }`}>
                      {t.type}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className={`font-mono text-lg font-bold ${
                      t.type === 'DRAW' ? 'text-orange-400' : 'text-green-400'
                    }`}>
                      {t.type === 'DRAW' ? '-' : '+'}{fmtUsd(t.amount)}
                    </span>
                    <span className="text-xs text-gray-500">
                      Balance: <span className="font-mono text-gray-300">{fmtUsd(t.balanceAfter)}</span>
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs text-gray-500">
                    <span>
                      {new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{' '}
                      {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="font-mono">#{t.invoiceId}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop: table layout */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Vendor</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3 text-right">Balance After</th>
                    <th className="px-4 py-3">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t) => (
                    <tr key={t.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{' '}
                        {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-200 capitalize">{t.vendorName}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                          t.type === 'DRAW'
                            ? 'bg-orange-500/15 text-orange-400 border-orange-500/30'
                            : 'bg-green-500/15 text-green-400 border-green-500/30'
                        }`}>
                          {t.type}
                        </span>
                      </td>
                      <td className={`px-4 py-3 text-right font-mono ${
                        t.type === 'DRAW' ? 'text-orange-400' : 'text-green-400'
                      }`}>
                        {t.type === 'DRAW' ? '-' : '+'}{fmtUsd(t.amount)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-gray-300">
                        {fmtUsd(t.balanceAfter)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">
                        #{t.invoiceId}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
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
