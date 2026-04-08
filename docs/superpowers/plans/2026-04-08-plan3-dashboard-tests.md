# Plan 3: Dashboard Event Timeline, Tests & Remaining Ops

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the event timeline UI to the admin dashboard so load events are visible per-invoice, write unit and integration tests for all new services, and fix the AdsPower systemd service.

**Architecture:** Add a React component for the event timeline view accessible from the admin dashboard. Write Jest tests for the validator, logger, browserSession, and webhook processor. Fix the AdsPower systemd service file for reliable restarts.

**Tech Stack:** React, Vite, Jest, systemd

**Spec:** `docs/superpowers/specs/2026-04-08-pipeline-hardening-design.md` (Sections 4.4, 6.1, 7)

---

## File Structure

### New Files
- `frontend/src/components/EventTimeline.jsx` — Timeline component showing LoadEvents for an invoice
- `backend/__tests__/integration/invoiceFlow.test.js` — Integration tests for invoice submission + validation

### Modified Files
- `frontend/src/pages/AdminDashboard.jsx` — Add event timeline modal/drawer on invoice click
- `frontend/src/components/InvoiceCard.jsx` — Add "Events" button to cards

---

### Task 1: Event Timeline React Component

**Files:**
- Create: `frontend/src/components/EventTimeline.jsx`
- Modify: `frontend/src/pages/AdminDashboard.jsx`
- Modify: `frontend/src/components/InvoiceCard.jsx`

- [ ] **Step 1: Read the current frontend files**

Read:
- `/Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/frontend/src/pages/AdminDashboard.jsx`
- `/Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/frontend/src/components/InvoiceCard.jsx`
- `/Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/frontend/src/App.jsx`

Understand the existing component structure, styling approach, and how API calls are made (auth token from localStorage).

- [ ] **Step 2: Create EventTimeline.jsx**

```jsx
// frontend/src/components/EventTimeline.jsx
import { useState, useEffect } from 'react';

const STATUS_COLORS = {
  SUCCESS: '#10b981',
  FAILED: '#ef4444',
  INFO: '#3b82f6',
};

const STATUS_ICONS = {
  SUCCESS: '✓',
  FAILED: '✗',
  INFO: '●',
};

export default function EventTimeline({ invoiceId, token, onClose }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showErrorsOnly, setShowErrorsOnly] = useState(false);

  useEffect(() => {
    if (!invoiceId) return;
    setLoading(true);
    fetch(`/api/admin/invoices/${invoiceId}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then((data) => {
        setEvents(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [invoiceId, token]);

  const filtered = showErrorsOnly ? events.filter((e) => e.status === 'FAILED') : events;

  const formatTime = (ts) => {
    return new Date(ts).toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  };

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: '500px',
      background: '#1a1a2e', borderLeft: '1px solid #333', zIndex: 1000,
      display: 'flex', flexDirection: 'column', color: '#e0e0e0',
    }}>
      <div style={{
        padding: '16px 20px', borderBottom: '1px solid #333',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <h3 style={{ margin: 0, fontSize: '16px' }}>Invoice #{invoiceId} Events</h3>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: '#999', fontSize: '20px', cursor: 'pointer',
        }}>×</button>
      </div>

      <div style={{ padding: '12px 20px', borderBottom: '1px solid #333' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showErrorsOnly}
            onChange={(e) => setShowErrorsOnly(e.target.checked)}
          />
          Show Only Errors
        </label>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {loading ? (
          <p style={{ color: '#666' }}>Loading events...</p>
        ) : filtered.length === 0 ? (
          <p style={{ color: '#666' }}>No events recorded yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {filtered.map((event) => (
              <EventItem key={event.id} event={event} formatTime={formatTime} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EventItem({ event, formatTime }) {
  const [expanded, setExpanded] = useState(false);
  const color = STATUS_COLORS[event.status] || '#666';
  const icon = STATUS_ICONS[event.status] || '●';

  return (
    <div style={{
      borderLeft: `3px solid ${color}`,
      paddingLeft: '12px',
      paddingBottom: '4px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <span style={{ color, fontWeight: 'bold', marginRight: '8px' }}>{icon}</span>
          <span style={{ fontWeight: 500, fontSize: '14px' }}>{event.step.replace(/_/g, ' ')}</span>
          {event.account && (
            <span style={{ color: '#888', fontSize: '12px', marginLeft: '8px' }}>
              {event.account} ({event.platform})
            </span>
          )}
        </div>
      </div>
      <div style={{ color: '#888', fontSize: '12px', marginTop: '2px' }}>
        {formatTime(event.createdAt)}
      </div>
      {event.metadata && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              background: 'none', border: 'none', color: '#5b9bd5',
              fontSize: '12px', cursor: 'pointer', padding: '4px 0',
            }}
          >
            {expanded ? '▼ Hide details' : '▶ Show details'}
          </button>
          {expanded && (
            <pre style={{
              background: '#0d0d1a', padding: '8px', borderRadius: '4px',
              fontSize: '11px', color: '#ccc', overflowX: 'auto', marginTop: '4px',
            }}>
              {JSON.stringify(event.metadata, null, 2)}
            </pre>
          )}
        </div>
      )}
      {event.screenshotPath && (
        <a
          href={`/api/screenshots/${event.screenshotPath.split('/').pop()}`}
          target="_blank"
          rel="noreferrer"
          style={{ color: '#5b9bd5', fontSize: '12px' }}
        >
          📷 View Screenshot
        </a>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add "Events" button to InvoiceCard.jsx**

Read `frontend/src/components/InvoiceCard.jsx`. Add an "Events" button in the action buttons area. The button should call a callback prop `onShowEvents(invoiceId)`.

Add the prop to the component: `function InvoiceCard({ invoice, allocations, onAction, onShowEvents })`

Add the button alongside existing action buttons:
```jsx
<button
  onClick={() => onShowEvents(invoice.id)}
  style={{
    padding: '4px 8px', fontSize: '11px', background: '#2563eb',
    color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer',
  }}
>
  Events
</button>
```

- [ ] **Step 4: Integrate EventTimeline into AdminDashboard.jsx**

Read `frontend/src/pages/AdminDashboard.jsx`. Add:

1. Import at top:
```jsx
import EventTimeline from '../components/EventTimeline';
```

2. Add state:
```jsx
const [selectedInvoiceEvents, setSelectedInvoiceEvents] = useState(null);
```

3. Pass the callback to InvoiceCard wherever it's rendered:
```jsx
onShowEvents={(id) => setSelectedInvoiceEvents(id)}
```

4. Render the timeline panel at the bottom of the component, before the closing `</div>`:
```jsx
{selectedInvoiceEvents && (
  <EventTimeline
    invoiceId={selectedInvoiceEvents}
    token={token}
    onClose={() => setSelectedInvoiceEvents(null)}
  />
)}
```

- [ ] **Step 5: Build frontend**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/frontend && npm run build && cp -r dist/* ../backend/public/
```

- [ ] **Step 6: Commit**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline
git add frontend/src/components/EventTimeline.jsx frontend/src/components/InvoiceCard.jsx frontend/src/pages/AdminDashboard.jsx backend/public/
git commit -m "feat: add event timeline panel to admin dashboard"
```

---

### Task 2: Fix AdsPower Systemd Service

**Files:**
- Remote: `/etc/systemd/system/adspower.service` on VPS

- [ ] **Step 1: Fix the service file via SSH**

```bash
sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 'ln -sf "/opt/AdsPower Global/adspower_global" /usr/local/bin/adspower 2>/dev/null; cat > /etc/systemd/system/adspower.service << EOF
[Unit]
Description=AdsPower Browser
After=xvfb.service
Requires=xvfb.service

[Service]
Environment=DISPLAY=:99
ExecStartPre=/bin/rm -f /tmp/.X99-lock
ExecStart=/usr/local/bin/adspower --no-sandbox
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && echo "Service file updated"'
```

- [ ] **Step 2: Verify Xvfb service**

```bash
sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 'systemctl is-active xvfb && systemctl is-active adspower && echo "Both services active"'
```

- [ ] **Step 3: No commit needed** (remote-only change)

---

### Task 3: Integration Tests — Invoice Submission Flow

**Files:**
- Create: `backend/__tests__/integration/invoiceFlow.test.js`

- [ ] **Step 1: Create the integration test**

```js
// backend/__tests__/integration/invoiceFlow.test.js
const { validateInvoice, validateCorrection } = require('../../src/services/validator');

describe('Invoice submission flow', () => {
  const vendor = {
    id: 1,
    accounts: [
      { id: 10, platform: 'PLAY777', rate: '0.35', loadType: 'vendor', username: 'M12345' },
      { id: 11, platform: 'ICONNECT', rate: '0.15', loadType: 'vendor', username: 'Mikee' },
      { id: 12, platform: 'PLAY777', rate: '0.35', loadType: 'correction', username: 'DSilva777' },
      { id: 13, platform: 'PLAY777', rate: '0.50', loadType: 'operator', username: 'CTrejo' },
    ],
  };

  describe('Wire invoice validation', () => {
    test('valid wire invoice with single allocation', () => {
      const result = validateInvoice({
        vendor,
        method: 'Wire',
        baseAmount: 2000,
        feeAmount: 0,
        totalAmount: 2000,
        allocations: [{ accountId: 10, dollarAmount: 2000, credits: 5714 }],
      });
      expect(result.valid).toBe(true);
    });

    test('valid wire with split allocations across platforms', () => {
      const result = validateInvoice({
        vendor,
        method: 'Wire',
        baseAmount: 3000,
        feeAmount: 0,
        totalAmount: 3000,
        allocations: [
          { accountId: 10, dollarAmount: 2000, credits: 5714 },
          { accountId: 11, dollarAmount: 1000, credits: 6666 },
        ],
      });
      expect(result.valid).toBe(true);
    });

    test('wire allows amounts below $1000', () => {
      const result = validateInvoice({
        vendor,
        method: 'Wire',
        baseAmount: 500,
        feeAmount: 0,
        totalAmount: 500,
        allocations: [{ accountId: 10, dollarAmount: 500, credits: 1428 }],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('ACH invoice validation', () => {
    test('rejects ACH below $1000', () => {
      const result = validateInvoice({
        vendor,
        method: 'ACH (1%)',
        baseAmount: 999,
        feeAmount: 9.99,
        totalAmount: 1008.99,
        allocations: [{ accountId: 10, dollarAmount: 999, credits: 2854 }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/minimum/i);
    });

    test('valid ACH at exactly $1000', () => {
      const result = validateInvoice({
        vendor,
        method: 'ACH (1%)',
        baseAmount: 1000,
        feeAmount: 10,
        totalAmount: 1010,
        allocations: [{ accountId: 10, dollarAmount: 1000, credits: 2857 }],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('Credit card invoice validation', () => {
    test('rejects card below $1000', () => {
      const result = validateInvoice({
        vendor,
        method: 'Credit/Debit (3%)',
        baseAmount: 500,
        feeAmount: 15,
        totalAmount: 515,
        allocations: [{ accountId: 10, dollarAmount: 500, credits: 1428 }],
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('Account ownership', () => {
    test('rejects account from different vendor', () => {
      const result = validateInvoice({
        vendor,
        method: 'Wire',
        baseAmount: 1000,
        feeAmount: 0,
        totalAmount: 1000,
        allocations: [{ accountId: 999, dollarAmount: 1000, credits: 2857 }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/does not belong/i);
    });

    test('rejects correction account in regular invoice', () => {
      const result = validateInvoice({
        vendor,
        method: 'Wire',
        baseAmount: 1000,
        feeAmount: 0,
        totalAmount: 1000,
        allocations: [{ accountId: 12, dollarAmount: 1000, credits: 2857 }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/correction/i);
    });

    test('allows operator account in regular invoice', () => {
      const result = validateInvoice({
        vendor,
        method: 'Wire',
        baseAmount: 1000,
        feeAmount: 0,
        totalAmount: 1000,
        allocations: [{ accountId: 13, dollarAmount: 1000, credits: 2000 }],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('Credit calculations', () => {
    test('rejects wildly wrong credits', () => {
      const result = validateInvoice({
        vendor,
        method: 'Wire',
        baseAmount: 1000,
        feeAmount: 0,
        totalAmount: 1000,
        allocations: [{ accountId: 10, dollarAmount: 1000, credits: 100000 }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/mismatch/i);
    });

    test('allows credits within ±1 tolerance', () => {
      // 1000 / 0.35 = 2857.14, floor = 2857
      const result1 = validateInvoice({
        vendor,
        method: 'Wire',
        baseAmount: 1000,
        feeAmount: 0,
        totalAmount: 1000,
        allocations: [{ accountId: 10, dollarAmount: 1000, credits: 2857 }],
      });
      expect(result1.valid).toBe(true);

      const result2 = validateInvoice({
        vendor,
        method: 'Wire',
        baseAmount: 1000,
        feeAmount: 0,
        totalAmount: 1000,
        allocations: [{ accountId: 10, dollarAmount: 1000, credits: 2858 }],
      });
      expect(result2.valid).toBe(true);
    });
  });

  describe('Correction validation', () => {
    test('valid correction to correction account', () => {
      const result = validateCorrection({
        vendor,
        sourceAccountId: 10,
        corrections: [{ accountId: 12, credits: 500 }],
      });
      expect(result.valid).toBe(true);
    });

    test('rejects correction to vendor account', () => {
      const result = validateCorrection({
        vendor,
        sourceAccountId: 10,
        corrections: [{ accountId: 10, credits: 500 }],
      });
      expect(result.valid).toBe(false);
    });

    test('rejects correction with zero total credits', () => {
      const result = validateCorrection({
        vendor,
        sourceAccountId: 10,
        corrections: [{ accountId: 12, credits: 0 }],
      });
      expect(result.valid).toBe(false);
    });

    test('rejects source account not belonging to vendor', () => {
      const result = validateCorrection({
        vendor,
        sourceAccountId: 999,
        corrections: [{ accountId: 12, credits: 100 }],
      });
      expect(result.valid).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend && npx jest --no-cache
```

Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline
git add backend/__tests__/integration/
git commit -m "test: add comprehensive integration tests for invoice and correction validation"
```

---

### Task 4: Update Proxy Username in .env on VPS

**Files:**
- Remote: `/root/WOKE-CreditLoader-Pipeline/backend/.env` on VPS

The proxy username needs the `__cr.us` suffix for US geo-targeting.

- [ ] **Step 1: Update .env on VPS**

```bash
sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 'cd /root/WOKE-CreditLoader-Pipeline/backend && sed -i "s/PROXY_USER=ac6522d6f0307b76a04b$/PROXY_USER=ac6522d6f0307b76a04b__cr.us/" .env && grep PROXY .env'
```

Expected: `PROXY_USER=ac6522d6f0307b76a04b__cr.us`

- [ ] **Step 2: No commit needed** (env var only)

---

### Task 5: Push, Deploy, Verify

- [ ] **Step 1: Run all tests locally**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend && npx jest --no-cache
```

- [ ] **Step 2: Push**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline && git push
```

- [ ] **Step 3: Deploy**

```bash
sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 'cd /root/WOKE-CreditLoader-Pipeline && git pull && cd backend && npm install --production && npx prisma generate --schema src/db/prisma/schema.prisma && systemctl restart creditloader && sleep 3 && curl -sf http://localhost:3000/api/vendors/mike > /dev/null && echo "DEPLOY OK" || echo "DEPLOY FAILED"'
```

- [ ] **Step 4: Verify event timeline in browser**

Open `https://load.wokeavr.com/admin` → click on Invoice #40 → should see the Events panel with the correction load timeline.

- [ ] **Step 5: Verify AdsPower service survives restart**

```bash
sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 'systemctl restart adspower && sleep 15 && systemctl is-active adspower && curl -s "http://127.0.0.1:50325/api/v1/user/list?page_size=1" -H "Authorization: Bearer e6175d58711b04fb7eabb15630c68235006e46fe9aad9ae9" | head -c 50 && echo ""'
```

Expected: "active" and API responds

---

## Deferred to Future Work

- **Balance History verification** — Needs deeper exploration of the Play777 drawer's Balance History tab (date picker interaction, AJAX loading). Will be tackled in a focused session after examining the page manually.
- **Master balance audit** — Depends on Balance History verification
- **LoadStep audit trail population** — Depends on balance verification
- **Browser smoke test script** — Straightforward but lower priority than getting the dashboard working
