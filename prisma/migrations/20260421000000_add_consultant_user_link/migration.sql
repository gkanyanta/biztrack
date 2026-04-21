-- AlterTable
ALTER TABLE "Consultant" ADD COLUMN "userId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Consultant_userId_key" ON "Consultant"("userId");
