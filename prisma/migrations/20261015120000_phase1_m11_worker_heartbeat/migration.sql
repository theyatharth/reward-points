-- Migration 11: worker heartbeat. Additive: one new table, one row per worker loop (name = its jobType), upserted every tick,
-- including quiet ticks that write no JobRun, so the admin Overview can show "last worker tick".
CREATE TABLE "WorkerHeartbeat" (
    "name"           TEXT         NOT NULL,
    "lastTickAt"     TIMESTAMP(3) NOT NULL,
    "lastTickRan"    BOOLEAN      NOT NULL DEFAULT false,
    "lastTickFailed" BOOLEAN      NOT NULL DEFAULT false,
    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("name")
);
