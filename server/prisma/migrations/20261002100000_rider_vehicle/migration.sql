-- The Rider model was built for one man on a hired motorbike, and the name stuck. What it
-- actually holds is our own delivery capacity, which includes the owner delivering by car when
-- he is able to. Recording the vehicle lets the screens stop calling him a rider.
ALTER TABLE "Rider" ADD COLUMN "vehicle" TEXT;
