#!/bin/bash
set -e

echo "🚀 Deploying CreditLoader Pipeline..."

sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 << 'EOF'
  set -e
  cd /root/WOKE-CreditLoader-Pipeline

  echo "📥 Pulling latest code..."
  git pull

  echo "📦 Installing backend dependencies..."
  cd backend
  npm install --production

  echo "🗃️ Running migrations..."
  npx prisma generate --schema src/db/prisma/schema.prisma
  npx prisma migrate deploy --schema src/db/prisma/schema.prisma

  echo "🎨 Building frontend..."
  cd ../frontend
  npm install
  npm run build

  echo "🔄 Restarting service..."
  systemctl restart creditloader
  sleep 10

  if curl -sf http://localhost:3000/api/vendors/mike > /dev/null; then
    echo "✅ DEPLOY OK — service is healthy"
  else
    echo "❌ DEPLOY FAILED — health check failed"
    exit 1
  fi
EOF

echo "✅ Deployment complete"
