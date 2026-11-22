-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "OutcomeType" AS ENUM ('delivered', 'refused', 'returned', 'unreachable');

-- CreateEnum
CREATE TYPE "OutcomeSource" AS ENUM ('carrier_api', 'carrier_export', 'merchant_manual');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('active', 'frozen');

-- CreateEnum
CREATE TYPE "Band" AS ENUM ('low', 'medium', 'high', 'insufficient_data');

-- CreateEnum
CREATE TYPE "LookupDecision" AS ENUM ('shipped', 'cancelled', 'prepaid_required');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('api_key', 'user', 'staff', 'consumer', 'system');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "MerchantStatus" NOT NULL DEFAULT 'active',
    "trustWeight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "trustOverride" DOUBLE PRECISION,
    "failedOrderCostCentimes" INTEGER NOT NULL DEFAULT 4000,
    "termsAcceptedAt" TIMESTAMP(3),
    "termsVersion" TEXT,
    "isSeed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'fr',
    "emailVerifiedAt" TIMESTAMP(3),
    "isStaff" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "userId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("userId","merchantId")
);

-- CreateTable
CREATE TABLE "Session" (
    "idHash" BYTEA NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("idHash")
);

-- CreateTable
CREATE TABLE "MagicLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" BYTEA NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MagicLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" BYTEA NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['score', 'outcomes:write']::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outcome" (
    "id" TEXT NOT NULL,
    "phoneHash" BYTEA NOT NULL,
    "hashKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "merchantId" TEXT NOT NULL,
    "outcome" "OutcomeType" NOT NULL,
    "source" "OutcomeSource" NOT NULL DEFAULT 'merchant_manual',
    "carrier" TEXT,
    "cityCode" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "merchantOrderRef" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Outcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lookup" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "phoneHash" BYTEA NOT NULL,
    "phoneLast2" TEXT NOT NULL,
    "merchantOrderRef" TEXT,
    "band" "Band" NOT NULL,
    "score" INTEGER,
    "outcomesBucket" TEXT NOT NULL,
    "merchantsBucket" TEXT NOT NULL,
    "scoreVersion" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'api',
    "decision" "LookupDecision",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lookup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CsvImport" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "userId" TEXT,
    "sourceType" "OutcomeSource" NOT NULL,
    "rowsTotal" INTEGER NOT NULL,
    "inserted" INTEGER NOT NULL,
    "updated" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "errors" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CsvImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "merchantId" TEXT,
    "action" TEXT NOT NULL,
    "phoneHash" BYTEA,
    "result" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameFr" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "monthlyFeeCentimes" INTEGER NOT NULL,
    "includedLookups" INTEGER NOT NULL,
    "overageCentimesPerLookup" INTEGER NOT NULL,
    "rateLimitPerMin" INTEGER NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "merchantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currentPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "UsageMonthly" (
    "merchantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "lookups" INTEGER NOT NULL DEFAULT 0,
    "outcomesSubmitted" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageMonthly_pkey" PRIMARY KEY ("merchantId","period")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MagicLink_tokenHash_key" ON "MagicLink"("tokenHash");

-- CreateIndex
CREATE INDEX "MagicLink_expiresAt_idx" ON "MagicLink"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- CreateIndex
CREATE INDEX "ApiKey_merchantId_idx" ON "ApiKey"("merchantId");

-- CreateIndex
CREATE INDEX "Outcome_phoneHash_occurredAt_idx" ON "Outcome"("phoneHash", "occurredAt");

-- CreateIndex
CREATE INDEX "Outcome_occurredAt_idx" ON "Outcome"("occurredAt");

-- CreateIndex
CREATE INDEX "Outcome_merchantId_createdAt_idx" ON "Outcome"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Outcome_merchantId_merchantOrderRef_key" ON "Outcome"("merchantId", "merchantOrderRef");

-- CreateIndex
CREATE INDEX "Lookup_merchantId_createdAt_idx" ON "Lookup"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "Lookup_merchantId_phoneHash_idx" ON "Lookup"("merchantId", "phoneHash");

-- CreateIndex
CREATE INDEX "CsvImport_merchantId_createdAt_idx" ON "CsvImport"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_merchantId_at_idx" ON "AuditLog"("merchantId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_phoneHash_idx" ON "AuditLog"("phoneHash");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MagicLink" ADD CONSTRAINT "MagicLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outcome" ADD CONSTRAINT "Outcome_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lookup" ADD CONSTRAINT "Lookup_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CsvImport" ADD CONSTRAINT "CsvImport_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageMonthly" ADD CONSTRAINT "UsageMonthly_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
