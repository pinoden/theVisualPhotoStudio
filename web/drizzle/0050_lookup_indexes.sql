CREATE INDEX "membership_minutes_booking_idx" ON "membership_minutes" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "membership_payments_membership_idx" ON "membership_payments" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "payments_booking_idx" ON "payments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "refunds_payment_idx" ON "refunds" USING btree ("payment_id");