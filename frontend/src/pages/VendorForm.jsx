import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';

const FEE_RATES = {
  'Credit/Debit': 0.03,
  ACH: 0.01,
  Wire: 0,
};

const METHOD_CONFIG = {
  'Credit/Debit': { min: 1000, max: 4500, step: 250 },
  ACH: { min: 1000, max: 9000, step: 250 },
  Wire: { min: 1000, max: 20000 },
};

function buildOptions(min, max, step) {
  const opts = [];
  for (let v = min; v <= max; v += step) opts.push(v);
  return opts;
}

function fmt(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function accountLabel(acct) {
  if (acct.platform === 'PLAY777') {
    return `777 ${acct.username} (${acct.operatorId})`;
  }
  return `IC ${acct.username}`;
}

export default function VendorForm() {
  const { vendorSlug } = useParams();
  const [vendor, setVendor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Tab state
  const [activeTab, setActiveTab] = useState('invoice');

  // Invoice form state
  const [method, setMethod] = useState('');
  const [baseAmount, setBaseAmount] = useState('');
  const [allocations, setAllocations] = useState({});

  // Wire receipt state
  const [wireReceipt, setWireReceipt] = useState(null);

  // Corrections form state
  const [corrections, setCorrections] = useState({});
  const [correctionSubmitted, setCorrectionSubmitted] = useState(false);
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);

  // Credit line state
  const [clAmount, setClAmount] = useState('');
  const [clAllocations, setClAllocations] = useState({});
  const [clSubmitted, setClSubmitted] = useState(false);
  const [clSubmitting, setClSubmitting] = useState(false);
  const [clConfirming, setClConfirming] = useState(false);

  useEffect(() => {
    axios
      .get(`/api/vendors/${vendorSlug}`)
      .then((res) => {
        setVendor(res.data);
        setLoading(false);
      })
      .catch(() => {
        setError('Vendor not found.');
        setLoading(false);
      });
  }, [vendorSlug]);

  useEffect(() => {
    setBaseAmount('');
    setAllocations({});
  }, [method]);

  useEffect(() => {
    setAllocations({});
  }, [baseAmount]);

  const allAccounts = vendor?.accounts || [];

  // Split accounts into invoice vs correction
  // Hide chain-source accounts (they have chainToAccId) — show the final destination instead
  const invoiceAccounts = allAccounts.filter(
    (a) => a.loadType !== 'correction' && !a.chainToAccId
  );
  const correctionAccounts = allAccounts.filter(
    (a) => a.loadType === 'correction'
  );
  const hasCorrectionTab = correctionAccounts.length > 0;

  // Credit line
  const creditLine = vendor?.creditLine || null;
  const hasCreditLineTab = creditLine !== null;
  const clAvailable = creditLine ? creditLine.availableAmount : 0;
  const clBase = parseFloat(clAmount) || 0;

  const clAllocTotal = invoiceAccounts.reduce((sum, acct) => {
    return sum + (parseFloat(clAllocations[acct.id]) || 0);
  }, 0);
  const clSplitTotal = +clAllocTotal.toFixed(2);
  const clSplitValid = clBase > 0 && clSplitTotal === clBase;
  const clOverLimit = clBase > clAvailable;

  function getClCredits(acct) {
    const amt = parseFloat(clAllocations[acct.id]) || 0;
    const rate = parseFloat(acct.rate);
    if (!amt || !rate) return 0;
    return Math.round(amt / rate);
  }

  function setClAllocation(accountId, value) {
    setClAllocations((prev) => ({ ...prev, [accountId]: value }));
  }

  const hasAnyClAllocation = invoiceAccounts.some(
    (acct) => (parseFloat(clAllocations[acct.id]) || 0) > 0
  );

  const canSubmitCl = clBase > 0 && clSplitValid && !clOverLimit && !clSubmitting && clAvailable > 0;

  // Invoice calculations
  const config = METHOD_CONFIG[method];
  const isWire = method === 'Wire';

  const dropdownOptions = useMemo(() => {
    if (!config || isWire) return [];
    return buildOptions(config.min, config.max, config.step);
  }, [method]);

  const base = parseFloat(baseAmount) || 0;
  const feeRate = FEE_RATES[method] ?? 0;
  const feeAmount = +(base * feeRate).toFixed(2);
  const totalAmount = +(base + feeAmount).toFixed(2);

  const allocTotal = invoiceAccounts.reduce((sum, acct) => {
    return sum + (parseFloat(allocations[acct.id]) || 0);
  }, 0);
  const splitTotal = +allocTotal.toFixed(2);
  const splitValid = base > 0 && splitTotal === base;

  function getCredits(acct) {
    const amt = parseFloat(allocations[acct.id]) || 0;
    const rate = parseFloat(acct.rate);
    if (!amt || !rate) return 0;
    return Math.round(amt / rate);
  }

  function setAllocation(accountId, value) {
    setAllocations((prev) => ({ ...prev, [accountId]: value }));
  }

  function setCorrection(accountId, value) {
    setCorrections((prev) => ({ ...prev, [accountId]: value }));
  }

  const hasAnyAllocation = invoiceAccounts.some(
    (acct) => (parseFloat(allocations[acct.id]) || 0) > 0
  );

  const wireValid =
    !isWire || (base >= (config?.min || 0) && base <= (config?.max || Infinity));
  const canSubmit = method && base > 0 && splitValid && !submitting && wireValid;

  // Correction validation
  const hasAnyCorrection = correctionAccounts.some(
    (acct) => (parseInt(corrections[acct.id]) || 0) > 0
  );
  const canSubmitCorrection = hasAnyCorrection && !correctionSubmitting;

  async function handleInvoiceSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const accountAllocations = invoiceAccounts
        .map((acct) => ({
          accountId: acct.id,
          platform: acct.platform,
          username: acct.username,
          operatorId: acct.operatorId,
          dollarAmount: parseFloat(allocations[acct.id]) || 0,
          credits: getCredits(acct),
          chainToAccId: acct.chainToAccId,
        }))
        .filter((a) => a.dollarAmount > 0);

      const payload = {
        vendorSlug,
        method,
        baseAmount: base,
        feeAmount,
        totalAmount,
        allocations: accountAllocations,
      };

      if (isWire && wireReceipt) {
        const formData = new FormData();
        formData.append('data', JSON.stringify(payload));
        formData.append('wireReceipt', wireReceipt);
        await axios.post('/api/submit-invoice', formData);
      } else {
        await axios.post('/api/submit-invoice', payload);
      }
      setSubmitted(true);
    } catch (err) {
      alert(
        err.response?.data?.error || 'Submission failed. Please try again.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCorrectionSubmit(e) {
    e.preventDefault();
    if (!canSubmitCorrection) return;
    setCorrectionSubmitting(true);
    try {
      const correctionAllocations = correctionAccounts
        .map((acct) => ({
          accountId: acct.id,
          platform: acct.platform,
          username: acct.username,
          operatorId: acct.operatorId,
          credits: parseInt(corrections[acct.id]) || 0,
        }))
        .filter((a) => a.credits > 0);

      // Find the source account (CR1234 — the main vendor account)
      const sourceAccount = invoiceAccounts.find(
        (a) => a.platform === 'PLAY777' && a.loadType === 'vendor'
      );

      const payload = {
        vendorSlug,
        sourceAccountId: sourceAccount?.id,
        corrections: correctionAllocations,
      };

      await axios.post('/api/submit-correction', payload);
      setCorrectionSubmitted(true);
    } catch (err) {
      alert(
        err.response?.data?.error || 'Correction failed. Please try again.'
      );
    } finally {
      setCorrectionSubmitting(false);
    }
  }

  async function handleCreditLineSubmit(e) {
    e.preventDefault();
    if (!canSubmitCl) return;

    if (!clConfirming) {
      setClConfirming(true);
      return;
    }

    setClSubmitting(true);
    try {
      const clAccountAllocations = invoiceAccounts
        .map((acct) => ({
          accountId: acct.id,
          platform: acct.platform,
          username: acct.username,
          operatorId: acct.operatorId,
          dollarAmount: parseFloat(clAllocations[acct.id]) || 0,
          credits: getClCredits(acct),
        }))
        .filter((a) => a.dollarAmount > 0);

      await axios.post('/api/submit-credit-line', {
        vendorSlug,
        baseAmount: clBase,
        allocations: clAccountAllocations,
      });
      setClSubmitted(true);
    } catch (err) {
      alert(err.response?.data?.error || 'Credit line request failed. Please try again.');
      setClConfirming(false);
    } finally {
      setClSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500 text-lg">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-red-600 text-lg">{error}</p>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="bg-white rounded-lg shadow-md p-8 max-w-md w-full text-center">
          <div className="text-green-600 text-5xl mb-4">&#10003;</div>
          <h2 className="text-2xl font-bold mb-2">Invoice Submitted</h2>
          <p className="text-gray-600">
            Your invoice has been created and sent to your email. You will
            receive a Telegram notification once your credits are loaded.
          </p>
        </div>
      </div>
    );
  }

  const methodLabel = method || '...';
  const colClass =
    invoiceAccounts.length <= 2
      ? 'grid-cols-1 sm:grid-cols-2'
      : invoiceAccounts.length <= 3
      ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3'
      : 'grid-cols-1 sm:grid-cols-2 md:grid-cols-4';

  return (
    <div className="min-h-screen bg-gray-50 py-4 px-3 sm:py-8 sm:px-4">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow-md p-4 sm:p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-6">
            {vendor.name} Invoice Request
          </h1>

          {/* Tabs */}
          {(hasCorrectionTab || hasCreditLineTab) && (
            <div className="flex border-b border-gray-200 mb-8">
              <button
                type="button"
                onClick={() => setActiveTab('invoice')}
                className={`px-6 py-3 text-sm font-semibold border-b-2 transition ${
                  activeTab === 'invoice'
                    ? 'border-amber-700 text-amber-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                Invoice
              </button>
              {hasCorrectionTab && (
                <button
                  type="button"
                  onClick={() => setActiveTab('corrections')}
                  className={`px-6 py-3 text-sm font-semibold border-b-2 transition ${
                    activeTab === 'corrections'
                      ? 'border-amber-700 text-amber-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Corrections
                </button>
              )}
              {hasCreditLineTab && (
                <button
                  type="button"
                  onClick={() => setActiveTab('creditLine')}
                  className={`px-6 py-3 text-sm font-semibold border-b-2 transition ${
                    activeTab === 'creditLine'
                      ? 'border-amber-700 text-amber-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Request Credit Line
                </button>
              )}
            </div>
          )}

          {/* ============ INVOICE TAB ============ */}
          {activeTab === 'invoice' && (
            <>
              {/* Row 1: Name | Business Name */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 mb-6">
                <LockedField label="Name" value={vendor.name} />
                <LockedField label="Business Name" value={vendor.businessName} />
              </div>

              {/* Row 2: Email | Payment Method */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 mb-6">
                <LockedField label="Email (Business)" value={vendor.email} />
                <div>
                  <Label required>Credit/Debit, ACH, or Wire?</Label>
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Choose</option>
                    <option value="Credit/Debit">Credit/Debit (3%)</option>
                    <option value="ACH">ACH (1%)</option>
                    <option value="Wire">Wire</option>
                  </select>
                  <HelpText>Choose your payment method.</HelpText>
                </div>
              </div>

              <form onSubmit={handleInvoiceSubmit}>
                {/* Base Amount */}
                {method && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 mb-6">
                    <div>
                      <Label required>{methodLabel} (Base)</Label>
                      {isWire ? (
                        <input
                          type="number"
                          min={config.min}
                          max={config.max}
                          step="0.01"
                          value={baseAmount}
                          onChange={(e) => setBaseAmount(e.target.value)}
                          placeholder="Amount ($)"
                          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          required
                        />
                      ) : (
                        <select
                          value={baseAmount}
                          onChange={(e) => setBaseAmount(e.target.value)}
                          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          required
                        >
                          <option value="">Amount ($)</option>
                          {dropdownOptions.map((v) => (
                            <option key={v} value={v}>
                              {fmt(v)}
                            </option>
                          ))}
                        </select>
                      )}
                      <HelpText>
                        {isWire ? (
                          <>
                            Minimum wire amount is <strong>{fmt(config.min)}</strong>.
                            Maximum is <strong>{fmt(config.max)}</strong>.
                          </>
                        ) : (
                          <>
                            This is the <strong>price BEFORE</strong> the{' '}
                            <strong>{(feeRate * 100).toFixed(0)}% FEE</strong>.
                          </>
                        )}
                      </HelpText>
                    </div>

                    {isWire && (
                      <div>
                        <Label>Wire Info</Label>
                        <div className="w-full border border-gray-300 rounded-md px-3 py-2 bg-gray-50 text-sm text-gray-700 min-h-[38px] space-y-0.5">
                          <div><strong>Business:</strong> Woke AVR LLC</div>
                          <div><strong>Address:</strong> 1209 S 10th St, McAllen, TX 78501</div>
                          <div><strong>Bank:</strong> Column N.A., Member FDIC</div>
                          <div><strong>Account #:</strong> 331914301134415</div>
                          <div><strong>Routing #:</strong> 121145307</div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Total w/ Fee */}
                {method && !isWire && base > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 mb-6">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">
                        Total ({methodLabel} w/ Fee)
                      </p>
                      <p className="text-lg font-bold text-gray-900">
                        {fmt(totalAmount)}
                      </p>
                      <HelpText>
                        This is the <strong>Total AFTER</strong> the{' '}
                        <strong>{(feeRate * 100).toFixed(0)}% FEE</strong>.
                      </HelpText>
                    </div>
                  </div>
                )}

                {/* Per-account allocation fields */}
                {base > 0 && (
                  <div className={`grid ${colClass} gap-4 sm:gap-6 mb-6`}>
                    {invoiceAccounts.map((acct) => {
                      // For chain loads, show what happens
                      const chainTarget = acct.chainToAccId
                        ? allAccounts.find((a) => a.id === acct.chainToAccId)
                        : null;

                      return (
                        <div key={acct.id}>
                          <Label required>{accountLabel(acct)} ({methodLabel})</Label>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={allocations[acct.id] || ''}
                            onChange={(e) =>
                              setAllocation(acct.id, e.target.value)
                            }
                            placeholder="Amount ($)"
                            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <HelpText>
                            {chainTarget ? (
                              <>
                                Credits load to <strong>{acct.username}</strong>{' '}
                                then auto-load to{' '}
                                <strong>{chainTarget.username}</strong>.
                              </>
                            ) : (
                              <>
                                Enter amount in <strong>dollars ($)</strong> for{' '}
                                <strong>
                                  {acct.platform === 'PLAY777'
                                    ? 'Play777'
                                    : 'IConnect'}
                                </strong>
                                .
                              </>
                            )}
                          </HelpText>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Split validation */}
                {base > 0 && hasAnyAllocation && !splitValid && (
                  <div className="mb-6 text-sm text-red-600">
                    The amounts must total {fmt(base)}. Current total:{' '}
                    {fmt(splitTotal)}.
                  </div>
                )}

                {/* Credits per account */}
                {splitValid && (
                  <div className={`grid ${colClass} gap-4 sm:gap-6 mb-6`}>
                    {invoiceAccounts.map((acct) => {
                      const amt = parseFloat(allocations[acct.id]) || 0;
                      if (amt <= 0) return null;
                      const credits = getCredits(acct);
                      const rate = parseFloat(acct.rate);
                      return (
                        <div key={acct.id}>
                          <p className="text-sm font-semibold text-gray-900">
                            Credits ({accountLabel(acct)})
                          </p>
                          <p className="text-lg font-bold text-gray-900">
                            {credits.toLocaleString()}
                          </p>
                          <HelpText>
                            <strong>Credits</strong> at{' '}
                            <strong>{(rate * 100).toFixed(0)}% rate</strong>.
                          </HelpText>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Wire Receipt */}
                {isWire && base > 0 && (
                  <div className="mb-6">
                    <Label required>Wire Receipt</Label>
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      onChange={(e) => setWireReceipt(e.target.files[0] || null)}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:bg-gray-100 file:text-gray-700 file:cursor-pointer"
                    />
                    <HelpText>
                      Submit a <strong>photo</strong> of your{' '}
                      <strong>Wire</strong> receipt.
                    </HelpText>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={!canSubmit}
                  className={`w-full sm:w-auto px-8 py-3 rounded-md text-white font-semibold transition ${
                    canSubmit
                      ? 'bg-amber-700 hover:bg-amber-800 cursor-pointer'
                      : 'bg-gray-300 cursor-not-allowed'
                  }`}
                >
                  {submitting ? 'Submitting...' : 'Submit Invoice'}
                </button>
              </form>
            </>
          )}

          {/* ============ CORRECTIONS TAB ============ */}
          {activeTab === 'corrections' && hasCorrectionTab && (
            <>
              {correctionSubmitted ? (
                <div className="text-center py-12">
                  <div className="text-green-600 text-5xl mb-4">&#10003;</div>
                  <h2 className="text-2xl font-bold mb-2">
                    Correction Submitted
                  </h2>
                  <p className="text-gray-600">
                    Your correction request has been submitted. Credits will be
                    moved from CR1234 to the requested accounts.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleCorrectionSubmit}>
                  <div className="mb-6">
                    <p className="text-sm text-gray-600 mb-4">
                      Enter the number of <strong>credits</strong> to move from{' '}
                      <strong>CR1234</strong> to each account. The system will
                      check CR1234's balance before processing.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 mb-6">
                    {correctionAccounts.map((acct) => (
                      <div key={acct.id}>
                        <Label>
                          {accountLabel(acct)}
                        </Label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={corrections[acct.id] || ''}
                          onChange={(e) =>
                            setCorrection(acct.id, e.target.value)
                          }
                          placeholder="Credits"
                          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <HelpText>
                          Credits to move from <strong>CR1234</strong> to{' '}
                          <strong>{acct.username}</strong>.
                        </HelpText>
                      </div>
                    ))}
                  </div>

                  {hasAnyCorrection && (
                    <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                      <p className="text-sm text-yellow-800">
                        <strong>Total credits to move:</strong>{' '}
                        {correctionAccounts
                          .reduce(
                            (sum, a) =>
                              sum + (parseInt(corrections[a.id]) || 0),
                            0
                          )
                          .toLocaleString()}{' '}
                        credits from CR1234
                      </p>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={!canSubmitCorrection}
                    className={`w-full sm:w-auto px-8 py-3 rounded-md text-white font-semibold transition ${
                      canSubmitCorrection
                        ? 'bg-amber-700 hover:bg-amber-800 cursor-pointer'
                        : 'bg-gray-300 cursor-not-allowed'
                    }`}
                  >
                    {correctionSubmitting
                      ? 'Submitting...'
                      : 'Submit Correction'}
                  </button>
                </form>
              )}
            </>
          )}

          {/* ============ CREDIT LINE TAB ============ */}
          {activeTab === 'creditLine' && hasCreditLineTab && (
            <>
              {clSubmitted ? (
                <div className="text-center py-12">
                  <div className="text-green-600 text-5xl mb-4">&#10003;</div>
                  <h2 className="text-2xl font-bold mb-2">Credit Line Request Submitted</h2>
                  <p className="text-gray-600">
                    Your credit line request has been submitted. Credits will be loaded shortly.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleCreditLineSubmit}>
                  {/* Credit Line Status */}
                  <div className="mb-6 p-4 rounded-lg border bg-gray-50 border-gray-200">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-sm font-semibold text-gray-700">Credit Line</span>
                      <span className={`text-sm font-bold ${clAvailable > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {fmt(clAvailable)} available
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-3">
                      <div
                        className={`h-3 rounded-full transition-all ${
                          creditLine.usedAmount / creditLine.capAmount > 0.8
                            ? 'bg-red-500'
                            : creditLine.usedAmount / creditLine.capAmount > 0.5
                            ? 'bg-yellow-500'
                            : 'bg-green-500'
                        }`}
                        style={{ width: `${(creditLine.usedAmount / creditLine.capAmount) * 100}%` }}
                      ></div>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {fmt(creditLine.usedAmount)} used of {fmt(creditLine.capAmount)} total
                    </p>
                  </div>

                  {clAvailable <= 0 ? (
                    <div className="text-center py-8">
                      <p className="text-red-600 font-semibold text-lg mb-2">
                        Credit line fully used — {fmt(0)} of {fmt(creditLine.capAmount)} available
                      </p>
                      <p className="text-gray-500 text-sm">
                        Submit an invoice with a Credit Line Repayment allocation to free up balance.
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* Amount */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 mb-6">
                        <div>
                          <Label required>Amount ($)</Label>
                          <input
                            type="number"
                            min="1"
                            max={clAvailable}
                            step="0.01"
                            value={clAmount}
                            onChange={(e) => {
                              setClAmount(e.target.value);
                              setClAllocations({});
                              setClConfirming(false);
                            }}
                            placeholder={`Up to ${fmt(clAvailable)}`}
                            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <HelpText>
                            Maximum: <strong>{fmt(clAvailable)}</strong>. No fees applied.
                          </HelpText>
                        </div>
                      </div>

                      {clOverLimit && (
                        <div className="mb-6 text-sm text-red-600">
                          Amount exceeds available credit line of {fmt(clAvailable)}.
                        </div>
                      )}

                      {/* Account allocation */}
                      {clBase > 0 && !clOverLimit && (
                        <div className={`grid ${colClass} gap-4 sm:gap-6 mb-6`}>
                          {invoiceAccounts.map((acct) => (
                            <div key={acct.id}>
                              <Label required>{accountLabel(acct)}</Label>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={clAllocations[acct.id] || ''}
                                onChange={(e) => {
                                  setClAllocation(acct.id, e.target.value);
                                  setClConfirming(false);
                                }}
                                placeholder="Amount ($)"
                                className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                              <HelpText>
                                Enter amount in <strong>dollars ($)</strong> for{' '}
                                <strong>{acct.platform === 'PLAY777' ? 'Play777' : 'IConnect'}</strong>.
                              </HelpText>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Split validation */}
                      {clBase > 0 && hasAnyClAllocation && !clSplitValid && (
                        <div className="mb-6 text-sm text-red-600">
                          The amounts must total {fmt(clBase)}. Current total: {fmt(clSplitTotal)}.
                        </div>
                      )}

                      {/* Credits preview */}
                      {clSplitValid && (
                        <div className={`grid ${colClass} gap-4 sm:gap-6 mb-6`}>
                          {invoiceAccounts.map((acct) => {
                            const amt = parseFloat(clAllocations[acct.id]) || 0;
                            if (amt <= 0) return null;
                            const credits = getClCredits(acct);
                            const rate = parseFloat(acct.rate);
                            return (
                              <div key={acct.id}>
                                <p className="text-sm font-semibold text-gray-900">
                                  Credits ({accountLabel(acct)})
                                </p>
                                <p className="text-lg font-bold text-gray-900">
                                  {credits.toLocaleString()}
                                </p>
                                <HelpText>
                                  <strong>Credits</strong> at{' '}
                                  <strong>{(rate * 100).toFixed(0)}% rate</strong>.
                                </HelpText>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Confirmation screen */}
                      {clConfirming && clSplitValid && (
                        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-md">
                          <p className="text-sm font-semibold text-amber-800 mb-2">
                            Confirm Credit Line Request
                          </p>
                          <div className="text-sm text-amber-700 space-y-1">
                            <p>Amount: <strong>{fmt(clBase)}</strong></p>
                            {invoiceAccounts.map((acct) => {
                              const amt = parseFloat(clAllocations[acct.id]) || 0;
                              if (amt <= 0) return null;
                              return (
                                <p key={acct.id}>
                                  {accountLabel(acct)}: {fmt(amt)} — {getClCredits(acct).toLocaleString()} credits
                                </p>
                              );
                            })}
                            <p className="mt-2 pt-2 border-t border-amber-300">
                              Remaining after request: <strong>{fmt(clAvailable - clBase)}</strong>
                            </p>
                          </div>
                        </div>
                      )}

                      <button
                        type="submit"
                        disabled={!canSubmitCl}
                        className={`w-full sm:w-auto px-8 py-3 rounded-md text-white font-semibold transition ${
                          canSubmitCl
                            ? 'bg-amber-700 hover:bg-amber-800 cursor-pointer'
                            : 'bg-gray-300 cursor-not-allowed'
                        }`}
                      >
                        {clSubmitting
                          ? 'Submitting...'
                          : clConfirming
                          ? 'Confirm Request'
                          : 'Request Credit Line'}
                      </button>
                    </>
                  )}
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LockedField({ label, value }) {
  return (
    <div>
      <Label required>{label}</Label>
      <div className="w-full border border-gray-300 rounded-md px-3 py-2 bg-gray-50 text-gray-700">
        {value}
      </div>
    </div>
  );
}

function Label({ children, required }) {
  return (
    <label className="block text-sm font-bold text-gray-900 mb-1">
      {children}
      {required && <span className="text-red-600 ml-0.5">*</span>}
    </label>
  );
}

function HelpText({ children }) {
  return <p className="mt-1 text-xs text-gray-500 italic">{children}</p>;
}
