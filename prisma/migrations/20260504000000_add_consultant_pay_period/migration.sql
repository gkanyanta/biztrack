-- AlterTable
ALTER TABLE "Company" ADD COLUMN "consultantPayDay" INTEGER NOT NULL DEFAULT 11;

-- AlterTable
ALTER TABLE "Consultant" ADD COLUMN "startDate" TIMESTAMP(3);
