-- AlterTable (non-destructive): lock the gem grant of GEMS deposits at prepare time.
ALTER TABLE "Deposit" ADD COLUMN "productId" TEXT,
ADD COLUMN "gems" INTEGER;
