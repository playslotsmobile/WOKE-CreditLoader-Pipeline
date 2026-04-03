import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';

const FEE_RATES = {
  'Credit/Debit': 0.03,
  ACH: 0.01,
  Wire: 0,
};

const METHOD_CONFIG = {
  'Credit/Debit': { min: 2000, max: 4500, step: 250 },
  ACH: { min: 2000, max: 9000, step: 1000 },
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
    const type = acct.loadType === 'operator' ? 'Operator' : 'Vendor';
    const id = acct.operatorId ? ` (${acct.operatorId})` : '';
    return `777 ${type} ${acct.username}${id}`;
  }
  return 'IConnect';
}

export default function VendorForm() {
  const { vendorSlug } = useParams();
  const [vendor, setVendor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [method, setMethod] = useState('');
  const [baseAmount, setBaseAmount] = useState('');
  // allocations keyed by account id: { [accountId]: dollarAmount }
  const [allocations, setAllocations] = useState({});
  const [wireReceipt, setWireReceipt] = useState(null);

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

  // Reset downstream when method changes
  useEffect(() => {
    setBaseAmount('');
    setAllocations({});
    setWireReceipt(null);
  }, [method]);

  // Reset allocations when base changes
  useEffect(() => {
    setAllocations({});
  }, [baseAmount]);

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

  const accounts = vendor?.accounts || [];

  // Calculate allocation total and per-account credits
  const allocTotal = accounts.reduce((sum, acct) => {
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

  const hasAnyAllocation = accounts.some(
    (acct) => (parseFloat(allocations[acct.id]) || 0) > 0
  );

  const wireValid =
    !isWire || (wireReceipt && base >= config?.min && base <= config?.max);
  const canSubmit = method && base > 0 && splitValid && !submitting && wireValid;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const accountAllocations = accounts
        .map((acct) => ({
          accountId: acct.id,
          platform: acct.platform,
          username: acct.username,
          operatorId: acct.operatorId,
          dollarAmount: parseFloat(allocations[acct.id]) || 0,
          credits: getCredits(acct),
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
        await axios.post('/api/submit-invoice', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
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

  // Determine grid columns based on number of accounts
  const colClass =
    accounts.length <= 2
      ? 'grid-cols-2'
      : accounts.length === 3
      ? 'grid-cols-3'
      : 'grid-cols-4';

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow-md p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-8">
            {vendor.name} Invoice Request
          </h1>

          {/* Row 1: Name | Business Name */}
          <div className="grid grid-cols-2 gap-6 mb-6">
            <LockedField label="Name" value={vendor.name} />
            <LockedField label="Business Name" value={vendor.businessName} />
          </div>

          {/* Row 2: Email | Payment Method */}
          <div className="grid grid-cols-2 gap-6 mb-6">
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

          <form onSubmit={handleSubmit}>
            {/* Base Amount */}
            {method && (
              <div className="grid grid-cols-2 gap-6 mb-6">
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
                    <div className="w-full border border-gray-300 rounded-md px-3 py-2 bg-gray-50 text-sm text-gray-700 min-h-[38px]">
                      BANK: Choice Financial Group
                      <br />
                      BUSINESS: Woke AVR LLC
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Total w/ Fee */}
            {method && !isWire && base > 0 && (
              <div className="grid grid-cols-2 gap-6 mb-6">
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
              <div className={`grid ${colClass} gap-6 mb-6`}>
                {accounts.map((acct) => (
                  <div key={acct.id}>
                    <Label required>
                      {accountLabel(acct)} ({methodLabel})
                    </Label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={allocations[acct.id] || ''}
                      onChange={(e) => setAllocation(acct.id, e.target.value)}
                      placeholder="Amount ($)"
                      className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <HelpText>
                      Enter the amount in <strong>dollars ($)</strong> for{' '}
                      <strong>
                        {acct.platform === 'PLAY777' ? 'Play777' : 'IConnect'}
                      </strong>
                      .
                    </HelpText>
                  </div>
                ))}
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
              <div className={`grid ${colClass} gap-6 mb-6`}>
                {accounts.map((acct) => {
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
                        <strong>Credits</strong> you will receive at a{' '}
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
                  Submit a <strong>photo</strong> of your <strong>Wire</strong>{' '}
                  receipt.
                </HelpText>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={!canSubmit}
              className={`px-8 py-3 rounded-md text-white font-semibold transition ${
                canSubmit
                  ? 'bg-amber-700 hover:bg-amber-800 cursor-pointer'
                  : 'bg-gray-300 cursor-not-allowed'
              }`}
            >
              {submitting ? 'Submitting...' : 'Submit'}
            </button>
          </form>
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
