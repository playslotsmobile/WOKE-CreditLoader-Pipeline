-- Add BLOCKED_VERIFICATION to InvoiceStatus.
-- For invoices stopped because a load hit a human-action-required wall
-- (phone/email/contact-update modal, Cloudflare hard block, CAPTCHA, dead
-- session) — distinct from BLOCKED_LOW_MASTER so the operator knows it needs
-- a person, not a master top-up. See services/blockadeDetector.js.
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'BLOCKED_VERIFICATION';
