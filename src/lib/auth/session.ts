import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import type { AppModule, ProfileRow, RoleRow, SalonRow, UserRole } from "@/lib/types/database";

export interface SessionContext {
  userId: string;
  email: string;
  profile: ProfileRow;
  salon: SalonRow;
  /**
   * Who this login is on the roster, or null.
   *
   * Since the Team/User split these are two different identities: `userId` is
   * the account that performs actions, `teamMemberId` is the person who
   * performs services. Anything asking "are these my appointments / my
   * earnings?" means the second one.
   */
  teamMemberId: string | null;
  /** The role this login holds, or null for an account with none yet. */
  role: RoleRow | null;
  /** What that role may reach. The owner's set is every module. */
  modules: Set<AppModule>;
  /** Owner of this salon: holds everything, and cannot be assigned. */
  isOwner: boolean;
}

/** Every module, for the owner -- who holds all of them by definition. */
const ALL_MODULES: AppModule[] = [
  "calendar",
  "customers",
  "pos",
  "services",
  "payroll",
  "reports",
  "team",
  "audit",
  "settings",
];

/**
 * The signed-in user's profile and salon, or null.
 *
 * Both reads go through the RLS-bound server client, so the salon returned is
 * by construction the caller's own -- there is no code path here that could
 * select a different tenant.
 *
 * `cache()` de-duplicates this within a single request/render pass.
 */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const supabase = await createClient();

  // getUser() revalidates the JWT against Supabase Auth. Never trust
  // getSession() for authorisation -- its contents are not verified.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  // No profile, or a deactivated one: no tenant, therefore no access.
  if (!profile || !profile.is_active) return null;

  const { data: salon } = await supabase
    .from("salons")
    .select("*")
    .eq("id", profile.salon_id)
    .maybeSingle();

  if (!salon) return null;

  /*
   * The role and its modules, read once per request.
   *
   * This mirrors `has_module()` in Postgres, which is where access is actually
   * enforced. Nothing here is the security boundary -- it decides which links
   * to draw and which pages to bounce, and the database refuses the rest
   * regardless.
   */
  const { data: role } = profile.role_id
    ? await supabase.from("roles").select("*").eq("id", profile.role_id).maybeSingle()
    : { data: null };

  const { data: grants } = profile.role_id
    ? await supabase.from("role_modules").select("module").eq("role_id", profile.role_id)
    : { data: [] as { module: AppModule }[] };

  const isOwner = Boolean((role as RoleRow | null)?.is_owner);
  const modules = new Set<AppModule>(
    isOwner ? ALL_MODULES : ((grants ?? []) as { module: AppModule }[]).map((g) => g.module),
  );

  return {
    userId: user.id,
    email: user.email ?? profile.email,
    profile,
    salon,
    teamMemberId: profile.team_member_id,
    role: (role as RoleRow | null) ?? null,
    modules,
    isOwner,
  };
});

/** Require any signed-in, active member of a salon. */
export async function requireSession(): Promise<SessionContext> {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  return session;
}

/**
 * Require one of the given roles.
 *
 * Kept for the few places that genuinely mean a job title rather than a
 * permission. Prefer `requireModule()`: since Phase 7b a salon defines its own
 * roles, so "is this person a receptionist?" is rarely the question worth
 * asking -- "may they take payment?" is.
 */
export async function requireRole(...roles: UserRole[]): Promise<SessionContext> {
  const session = await requireSession();
  if (!roles.includes(session.profile.role)) redirect("/dashboard?denied=1");
  return session;
}

/**
 * Require a module.
 *
 * The page-level counterpart of `has_module()` in the database. Bouncing here
 * is a courtesy -- it shows a clear refusal instead of an empty page -- and
 * the policies would return nothing anyway.
 */
export async function requireModule(module: AppModule): Promise<SessionContext> {
  const session = await requireSession();
  if (!session.modules.has(module)) redirect("/dashboard?denied=1");
  return session;
}

/** Areas that are the salon owner's alone, rather than a delegated module. */
export async function requireOwner(): Promise<SessionContext> {
  const session = await requireSession();
  if (!session.isOwner) redirect("/dashboard?denied=1");
  return session;
}

/**
 * Module check for use inside Server Actions, where a redirect would swallow
 * the error. Throws instead, so the action can return a message to the form.
 */
export function assertModule(session: SessionContext, module: AppModule): void {
  if (!session.modules.has(module)) {
    throw new Error("Your role does not include this.");
  }
}

/**
 * Role check for use inside Server Actions.
 *
 * "owner" here means the salon's owner role, not the legacy enum -- so a
 * custom role can never satisfy it by being named "Owner".
 */
export function assertRole(session: SessionContext, ...roles: UserRole[]): void {
  if (roles.includes("owner") && session.isOwner) return;
  if (!roles.includes(session.profile.role)) {
    throw new Error("You do not have permission to perform this action.");
  }
}

export const ROLE_LABELS: Record<UserRole, string> = {
  owner: "Owner / Admin",
  staff: "Staff / Therapist",
  receptionist: "Receptionist",
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  owner: "Full access, including staff, payroll, reporting, audit log and billing.",
  staff: "Own schedule, own appointments and consent forms, own commission history.",
  receptionist: "Bookings, customer profiles, consent forms and POS receipts.",
};
