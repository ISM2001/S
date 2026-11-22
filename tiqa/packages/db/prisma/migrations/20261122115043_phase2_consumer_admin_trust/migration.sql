-- CreateEnum
CREATE TYPE "RequestType" AS ENUM ('dispute', 'deletion');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('open', 'upheld', 'rejected');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('open', 'dismissed', 'actioned');

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "trustComputedAt" TIMESTAMP(3),
ADD COLUMN     "trustDetails" JSONB;

-- AlterTable
ALTER TABLE "Outcome" ADD COLUMN     "carrierChecked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "contradicted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'member',
    "tokenHash" BYTEA NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpChallenge" (
    "id" TEXT NOT NULL,
    "phoneHash" BYTEA NOT NULL,
    "codeHash" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumerSession" (
    "tokenHash" BYTEA NOT NULL,
    "phoneHash" BYTEA NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsumerSession_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "DataSubjectRequest" (
    "id" TEXT NOT NULL,
    "phoneHash" BYTEA,
    "type" "RequestType" NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'open',
    "message" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataSubjectRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestItem" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "outcomeId" TEXT,
    "merchantId" TEXT NOT NULL,
    "outcome" "OutcomeType" NOT NULL,
    "source" "OutcomeSource" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "merchantOrderRef" TEXT,

    CONSTRAINT "RequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnomalyFlag" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "status" "FlagStatus" NOT NULL DEFAULT 'open',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnomalyFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_merchantId_idx" ON "Invite"("merchantId");

-- CreateIndex
CREATE INDEX "OtpChallenge_phoneHash_createdAt_idx" ON "OtpChallenge"("phoneHash", "createdAt");

-- CreateIndex
CREATE INDEX "OtpChallenge_expiresAt_idx" ON "OtpChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "ConsumerSession_expiresAt_idx" ON "ConsumerSession"("expiresAt");

-- CreateIndex
CREATE INDEX "DataSubjectRequest_status_createdAt_idx" ON "DataSubjectRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DataSubjectRequest_phoneHash_idx" ON "DataSubjectRequest"("phoneHash");

-- CreateIndex
CREATE INDEX "RequestItem_requestId_idx" ON "RequestItem"("requestId");

-- CreateIndex
CREATE INDEX "RequestItem_merchantId_idx" ON "RequestItem"("merchantId");

-- CreateIndex
CREATE INDEX "AnomalyFlag_merchantId_kind_status_idx" ON "AnomalyFlag"("merchantId", "kind", "status");

-- CreateIndex
CREATE INDEX "AnomalyFlag_status_createdAt_idx" ON "AnomalyFlag"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestItem" ADD CONSTRAINT "RequestItem_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DataSubjectRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnomalyFlag" ADD CONSTRAINT "AnomalyFlag_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
