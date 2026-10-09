import type { Metadata } from "next";

import { archiveConsentTemplateAction, archiveDealAction, setServiceActiveAction } from "./actions";
import { ConsentTemplateForm } from "./consent-template-form";
import { DealForm } from "./deal-form";
import { ServiceForm } from "./service-form";
import { groupByCategory } from "@/lib/services";
import { requireModule } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { formatMoney, formatDuration } from "@/lib/format";
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import type {
  ConsentTemplateItemRow,
  ConsentTemplateRow,
  DealRow,
  DealServiceRow,
  ServiceRow,
  ServiceStaffRow,
  TeamMemberRow,
} from "@/lib/types/database";

export const metadata: Metadata = { title: "Services" };

const DEAL_TYPE_LABEL = {
  percentage: "% off",
  fixed_amount: "Amount off",
  bundle_price: "Bundle price",
} as const;

export default async function ServicesPage() {
  const session = await requireModule("services");
  const supabase = await createClient();
  const currency = session.salon.currency;

  const [
    { data: services },
    { data: serviceStaff },
    { data: templates },
    { data: templateItems },
    { data: deals },
    { data: dealServices },
    { data: team },
  ] = await Promise.all([
    supabase.from("services").select("*").order("is_active", { ascending: false }).order("category").order("name"),
    supabase.from("service_staff").select("*"),
    supabase.from("consent_templates").select("*").order("is_active", { ascending: false }).order("name"),
    supabase.from("consent_template_items").select("*").order("sort_order"),
    supabase.from("deals").select("*").order("is_active", { ascending: false }).order("ends_on", { ascending: false }),
    supabase.from("deal_services").select("*"),
    supabase.from("team_members").select("*").eq("is_active", true).order("full_name"),
  ]);

  // Everyone on the roster, which is exactly the set who perform treatments.
  const therapists = (team ?? []) as TeamMemberRow[];
  const activeTemplates = (templates ?? []).filter((t: ConsentTemplateRow) => t.is_active);
  const activeServices = (services ?? []).filter((s: ServiceRow) => s.is_active);

  const staffByService = new Map<string, string[]>();
  for (const link of (serviceStaff ?? []) as ServiceStaffRow[]) {
    staffByService.set(link.service_id, [...(staffByService.get(link.service_id) ?? []), link.staff_id]);
  }

  const servicesByDeal = new Map<string, string[]>();
  for (const link of (dealServices ?? []) as DealServiceRow[]) {
    servicesByDeal.set(link.deal_id, [...(servicesByDeal.get(link.deal_id) ?? []), link.service_id]);
  }

  const itemsByTemplate = new Map<string, ConsentTemplateItemRow[]>();
  for (const item of (templateItems ?? []) as ConsentTemplateItemRow[]) {
    itemsByTemplate.set(item.template_id, [...(itemsByTemplate.get(item.template_id) ?? []), item]);
  }

  const nameById = new Map<string, string>();
  for (const p of therapists) nameById.set(p.id, p.full_name);
  for (const s of (services ?? []) as ServiceRow[]) nameById.set(s.id, s.name);
  for (const t of (templates ?? []) as ConsentTemplateRow[]) nameById.set(t.id, t.name);

  return (
    <>
      <PageHeader
        title="Services &amp; pricing"
        description="What you sell, who can perform it, and the consent wording that applies."
      />

      <Card>
        <CardHeader title="Add a service" />
        <div className="px-5 py-4">
          <ServiceForm therapists={therapists} templates={activeTemplates} currency={currency} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Service list"
          description="Archiving keeps a service out of new bookings and bills without disturbing past records."
        />
        {!services || services.length === 0 ? (
          <EmptyState>No services yet. Add your first one above.</EmptyState>
        ) : (
          groupByCategory(services as ServiceRow[]).map(([category, inCategory]) => (
          <section key={category}>
          <h3 className="border-b border-ink-200 bg-ink-50 px-5 py-1.5 text-xs font-bold uppercase tracking-wide text-ink-500">
            {category}
          </h3>
          <ul className="divide-y divide-ink-200">
            {inCategory.map((service) => {
              const assigned = staffByService.get(service.id) ?? [];
              return (
                <li key={service.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-900">
                        <span>{service.name}</span>
                        {!service.is_active ? <Badge tone="danger">Archived</Badge> : null}
                        {service.consent_template_id ? (
                          <Badge tone="warning">
                            Consent: {nameById.get(service.consent_template_id) ?? "template"}
                          </Badge>
                        ) : null}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {formatMoney(service.price, currency)} &middot;{" "}
                        {formatDuration(service.duration_minutes)} &middot;{" "}
                        {assigned.length === 0
                          ? "any therapist"
                          : assigned.map((id) => nameById.get(id) ?? "?").join(", ")}
                      </p>
                      {service.description ? (
                        <p className="mt-1 text-xs text-ink-500">{service.description}</p>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2">
                      <ServiceForm
                        therapists={therapists}
                        templates={activeTemplates}
                        currency={currency}
                        service={service}
                        assignedStaffIds={assigned}
                      />
                      <form action={setServiceActiveAction}>
                        <input type="hidden" name="serviceId" value={service.id} />
                        <input type="hidden" name="isActive" value={service.is_active ? "false" : "true"} />
                        <Button
                          type="submit"
                          variant={service.is_active ? "danger" : "secondary"}
                          size="sm"
                        >
                          {service.is_active ? "Archive" : "Restore"}
                        </Button>
                      </form>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          </section>
          ))
        )}
      </Card>

      <Card>
        <CardHeader
          title="Consent templates"
          description="Treatment-specific wording. A signed form keeps a copy of its statements, so editing a template never changes what someone already agreed to."
        />
        <div className="border-b border-ink-200 px-5 py-4">
          <ConsentTemplateForm />
        </div>
        {!templates || templates.length === 0 ? (
          <EmptyState>No consent templates yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200">
            {(templates as ConsentTemplateRow[]).map((template) => {
              const items = itemsByTemplate.get(template.id) ?? [];
              return (
                <li key={template.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                      {template.name}
                      {!template.is_active ? <Badge tone="danger">Archived</Badge> : null}
                      {template.requires_medical_history ? (
                        <Badge tone="brand">Medical intake</Badge>
                      ) : null}
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {items.map((item) => (
                        <li key={item.id} className="text-xs text-ink-500">
                          &bull; {item.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex items-center gap-2">
                    <ConsentTemplateForm template={template} items={items} />
                    {template.is_active ? (
                      <form action={archiveConsentTemplateAction}>
                        <input type="hidden" name="templateId" value={template.id} />
                        <Button type="submit" variant="danger" size="sm">
                          Archive
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Deals"
          description="Time-boxed offers the front desk applies at checkout."
        />
        <div className="border-b border-ink-200 px-5 py-4">
          <DealForm services={activeServices} currency={currency} />
        </div>
        {!deals || deals.length === 0 ? (
          <EmptyState>No deals yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200">
            {(deals as DealRow[]).map((deal) => {
              const linked = servicesByDeal.get(deal.id) ?? [];
              return (
                <li key={deal.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                      {deal.name}
                      <Badge tone="neutral">{DEAL_TYPE_LABEL[deal.deal_type]}</Badge>
                      {!deal.is_active ? <Badge tone="danger">Archived</Badge> : null}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {deal.deal_type === "percentage"
                        ? `${deal.value}% off`
                        : formatMoney(deal.value, currency)}{" "}
                      &middot; {deal.starts_on} to {deal.ends_on} &middot;{" "}
                      {linked.length === 0
                        ? "no services linked"
                        : linked.map((id) => nameById.get(id) ?? "?").join(", ")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <DealForm services={activeServices} currency={currency} deal={deal} linkedServiceIds={linked} />
                    {deal.is_active ? (
                      <form action={archiveDealAction}>
                        <input type="hidden" name="dealId" value={deal.id} />
                        <Button type="submit" variant="danger" size="sm">
                          Archive
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
