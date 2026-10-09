import Link from "next/link";
import type { Metadata } from "next";

import { CustomerForm } from "./customer-form";
import { requireModule } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import type { CustomerRow } from "@/lib/types/database";

export const metadata: Metadata = { title: "Customers" };

const PAGE_SIZE = 50;

export default async function CustomersPage({ searchParams }: PageProps<"/dashboard/customers">) {
  // Staff can read customers but not manage them, so this page is front desk.
  await requireModule("customers");

  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";

  const supabase = await createClient();

  let query = supabase
    .from("customers")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  if (q) {
    // Phone is the primary identifier, so a numeric query is matched against
    // the normalised column -- "0300 123" finds "+92 300 1234567".
    const digits = q.replace(/[^0-9]/g, "");
    query = digits.length >= 3
      ? query.ilike("phone_normalized", `%${digits}%`)
      : query.ilike("full_name", `%${q}%`);
  }

  const { data: customers } = await query;

  return (
    <>
      <PageHeader
        title="Customers"
        description="Look someone up by phone number or name, or add a new profile."
      />

      <Card>
        <CardHeader title="Find a customer" />
        <form className="flex flex-wrap items-end gap-3 px-5 py-4">
          <div className="min-w-56 flex-1">
            <label htmlFor="q" className="mb-1.5 block text-sm font-medium text-ink-700">
              Phone number or name
            </label>
            <input
              id="q"
              name="q"
              defaultValue={q}
              placeholder="0300 123 4567"
              className="block w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Search
          </button>
          {q ? (
            <Link
              href="/dashboard/customers"
              className="rounded-lg px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-100"
            >
              Clear
            </Link>
          ) : null}
        </form>
      </Card>

      <Card>
        <CardHeader
          title={q ? "Search results" : "Recently added"}
          description={q ? undefined : `Showing up to ${PAGE_SIZE}.`}
        />
        {!customers || customers.length === 0 ? (
          <EmptyState>
            {q ? "No customer matches that search." : "No customers yet. Add the first one below."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-ink-200">
            {(customers as CustomerRow[]).map((customer) => (
              <li key={customer.id}>
                <Link
                  href={`/dashboard/customers/${customer.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 hover:bg-ink-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">{customer.full_name}</p>
                    <p className="text-xs text-ink-500">{customer.phone}</p>
                  </div>
                  <span className="text-xs text-ink-400">
                    Added {formatDate(customer.created_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Add a customer"
          description="The phone number identifies them, and must be unique within this salon."
        />
        <div className="px-5 py-4">
          <CustomerForm />
        </div>
      </Card>
    </>
  );
}
