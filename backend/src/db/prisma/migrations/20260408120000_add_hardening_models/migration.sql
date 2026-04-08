-- CreateTable
CREATE TABLE "load_steps" (
    "id" SERIAL NOT NULL,
    "load_job_id" INTEGER NOT NULL,
    "step" TEXT NOT NULL,
    "account_id" INTEGER NOT NULL,
    "credits" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "balance_before" INTEGER,
    "balance_after" INTEGER,
    "screenshot_path" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "load_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "load_events" (
    "id" SERIAL NOT NULL,
    "load_job_id" INTEGER NOT NULL,
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" JSONB,
    "screenshot_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "load_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "load_steps_load_job_id_idx" ON "load_steps"("load_job_id");

-- CreateIndex
CREATE INDEX "load_events_load_job_id_idx" ON "load_events"("load_job_id");

-- CreateIndex
CREATE INDEX "webhook_events_status_idx" ON "webhook_events"("status");

-- AddForeignKey
ALTER TABLE "load_steps" ADD CONSTRAINT "load_steps_load_job_id_fkey" FOREIGN KEY ("load_job_id") REFERENCES "load_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_steps" ADD CONSTRAINT "load_steps_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "vendor_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_events" ADD CONSTRAINT "load_events_load_job_id_fkey" FOREIGN KEY ("load_job_id") REFERENCES "load_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
