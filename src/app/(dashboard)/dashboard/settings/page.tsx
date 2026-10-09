import type { Metadata } from "next";

import { SettingsForm } from "./settings-form";
import { requireModule } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import type { BusinessHours } from "@/lib/types/database";

export const metadata: Metadata = { title: "Settings" };

const DEFAULT_HOURS: BusinessHours = {
  mon: { open: "09:00", close: "18:00", closed: false },
  tue: { open: "09:00", close: "18:00", closed: false },
  wed: { open: "09:00", close: "18:00", closed: false },
  thu: { open: "09:00", close: "18:00", closed: false },
  fri: { open: "09:00", close: "18:00", closed: false },
  sat: { open: "10:00", close: "16:00", closed: false },
  sun: { open: "10:00", close: "16:00", closed: true },
};

export default async function SettingsPage() {
  const session = await requireModule("settings");
  const supabase = await createClient();

  const { data: settings } = await supabase
    .from("salon_settings")
    .select("*")
    .eq("salon_id", session.profile.salon_id)
    .maybeSingle();

  return (
    <>
      <PageHeader
        title="Salon settings"
        description="Business details and loyalty configuration. Services and pricing arrive in Phase 2."
      />

      <SettingsForm
        salon={session.salon}
        loyaltyEarnRate={settings?.loyalty_earn_rate ?? 0.05}
        businessHours={settings?.business_hours ?? DEFAULT_HOURS}
      />
    </>
  );
}
