#!/bin/bash
set -e

# Deploys CreditLoader Pipeline. Uses SSH key auth (~/.ssh/id_ed25519 per
# reference_deployment). The previously-committed sshpass + plaintext root
# password were removed for obvious reasons; rotate that password if you
# haven't already (it lived in git history).

REMOTE="${CREDITLOADER_DEPLOY_HOST:-root@87.99.135.197}"

echo "🚀 Deploying CreditLoader Pipeline to $REMOTE..."

ssh -o StrictHostKeyChecking=accept-new "$REMOTE" << 'EOF'
  set -e
  cd /root/WOKE-CreditLoader-Pipeline

  echo "📥 Pulling latest code..."
  git pull --ff-only

  echo "📦 Installing backend dependencies..."
  cd backend
  npm install --omit=dev --no-audit --no-fund

  echo "🗃️ Running migrations..."
  npx prisma generate --schema src/db/prisma/schema.prisma
  npx prisma migrate deploy --schema src/db/prisma/schema.prisma

  echo "🎨 Building frontend..."
  cd ../frontend
  npm install --no-audit --no-fund
  npm run build

  echo "🔄 Restarting service..."
  systemctl restart creditloader
  sleep 8

  if curl -sf http://localhost:3000/api/vendors/mike > /dev/null; then
    echo "✅ DEPLOY OK — service is healthy"
  else
    echo "❌ DEPLOY FAILED — health check failed"
    journalctl -u creditloader --since '30 seconds ago' --no-pager | tail -20
    exit 1
  fi
EOF

echo "✅ Deployment complete"
