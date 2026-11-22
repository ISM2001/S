-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('issued', 'paid', 'cancelled');

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "billingAddress" TEXT,
ADD COLUMN     "billingCity" TEXT,
ADD COLUMN     "billingEmail" TEXT,
ADD COLUMN     "billingIce" TEXT,
ADD COLUMN     "billingLegalName" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "mfaAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN     "totpSecretEnc" TEXT;

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'issued',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "lines" JSONB NOT NULL,
    "subtotalCentimes" INTEGER NOT NULL,
    "vatRateBp" INTEGER NOT NULL,
    "vatCentimes" INTEGER NOT NULL,
    "totalCentimes" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "seller" JSONB NOT NULL,
    "buyer" JSONB NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "paymentRef" TEXT,
    "creditNoteNumber" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentCounter" (
    "series" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DocumentCounter_pkey" PRIMARY KEY ("series")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_creditNoteNumber_key" ON "Invoice"("creditNoteNumber");

-- CreateIndex
CREATE INDEX "Invoice_status_dueAt_idx" ON "Invoice"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_merchantId_period_key" ON "Invoice"("merchantId", "period");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
