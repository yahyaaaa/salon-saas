"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { siteUrl } from "@/lib/env";
import { AUDIT_ACTIONS, logAudit } from "@/lib/audit";
import { assertModule, assertRole, requireSession } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  ATTACHMENT_EXTENSIONS,
  describeAttachmentProblem,
  fieldErrors,
  inviteSchema,
  roleChangeSchema,
  roleSchema,
  teamMemberSchema,
} from "@/lib/validation";
import type { UserRole } from "@/lib/types/database";

export interface TeamFormState {
  message?: string;
  success?: string;
  errors?: Record<string, string>;
}

/**
 * Invite a staff member or receptionist.
 *
 * Order matters: the `invitations` row must be committed before the Auth invite
 * is sent, because `handle_new_user` reads it to decide which salon the new
 * auth user joins. If the email send fails we roll the row back, so a retry is
 * not blocked by the one-pending-invite-per-email constraint.
 */
export async function inviteMemberAction(
  _prevState: TeamFormState,
  formData: FormData,
): Promise<TeamFormState> {
  const session = await requireSession();

  try {
    assertModule(session, "team");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    fullName: formData.get("fullName") ?? "",
    roleId: formData.get("roleId"),
  });

  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  const { email, fullName, roleId } = parsed.data;
  const supabase = await createClient();

  /*
   * Which person this login is for:
   *   a uuid  -> an existing roster entry gets an account
   *   "none"  -> a login that performs no services
   *   ""      -> make a roster entry for them, which is what an invitation
   *              always did before the Team/User split
   */
  const wanted = String(formData.get("teamMemberId") ?? "");
  const teamMemberId = wanted && wanted !== "none" ? wanted : null;
  const createRosterEntry = wanted !== "none";

  /*
   * The role has to exist in this salon, and must not be the owner role. The
   * form does not offer it, so reaching here means a hand-made request --
   * refuse rather than trust the markup.
   */
  const { data: chosenRole } = await supabase
    .from("roles")
    .select("id, name, is_owner")
    .eq("id", roleId)
    .maybeSingle();

  if (!chosenRole) return { errors: { roleId: "Choose a role." } };
  if (chosenRole.is_owner) {
    return { errors: { roleId: "The owner role cannot be given to an invited account." } };
  }

  /*
   * `invitations.role` is the pre-Phase-7b enum and is still NOT NULL. It is
   * no longer the authority on anything -- role_id is -- so it is filled with
   * the nearest legacy equivalent purely so old rows and new ones keep the
   * same shape.
   */
  const legacyRole: UserRole = chosenRole.name === "Receptionist" ? "receptionist" : "staff";

  // Already on the team? Nothing to invite.
  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .ilike("email", email)
    .maybeSingle();

  if (existing) {
    return { errors: { email: "This person is already on your team." } };
  }

  // Insert through the RLS client: the policy pins salon_id to the owner's own
  // salon, so this cannot create an invitation into another tenant.
  const { data: invitation, error: inviteError } = await supabase
    .from("invitations")
    .insert({
      salon_id: session.profile.salon_id,
      email,
      role: legacyRole,
      role_id: roleId,
      full_name: fullName,
      invited_by: session.userId,
      team_member_id: teamMemberId,
      create_roster_entry: createRosterEntry,
    })
    .select("id")
    .single();

  if (inviteError) {
    if (inviteError.code === "23505") {
      return { errors: { email: "There is already a pending invitation for this email." } };
    }
    return { message: inviteError.message };
  }

  // Service role is required to reach the Auth admin API. It is used only to
  // send the invite -- never to read or write tenant rows.
  const admin = createAdminClient();
  const { error: authError } = await admin.auth.admin.inviteUserByEmail(email, {
    /*
     * The client-side callback, because Supabase's default invite email sends
     * the session back in a URL fragment that no server route can read. The
     * `next` is encoded: it rides inside redirect_to as a nested query
     * string, and an unencoded one is fragile to the outer parse.
     */
    redirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent("/accept-invite")}`,
    data: { full_name: fullName },
  });

  if (authError) {
    await supabase.from("invitations").delete().eq("id", invitation.id);

    if (authError.message.toLowerCase().includes("already been registered")) {
      return {
        errors: {
          email:
            "That email already has an account on this platform. Each user can belong to one salon only.",
        },
      };
    }
    return { message: authError.message };
  }

  await logAudit(session, {
    action: AUDIT_ACTIONS.STAFF_INVITED,
    entityType: "invitation",
    entityId: invitation.id,
    metadata: { email, role: chosenRole.name, role_id: roleId },
  });

  revalidatePath("/dashboard/team");
  return { success: `Invitation sent to ${email}.` };
}

export async function revokeInviteAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "team");

  const invitationId = String(formData.get("invitationId") ?? "");
  if (!invitationId) return;

  const supabase = await createClient();

  // RLS restricts this to the owner's own salon; the returned row confirms it.
  const { data: revoked } = await supabase
    .from("invitations")
    .update({ status: "revoked" })
    .eq("id", invitationId)
    .eq("status", "pending")
    .select("email, role")
    .maybeSingle();

  if (revoked) {
    await logAudit(session, {
      action: AUDIT_ACTIONS.STAFF_INVITE_REVOKED,
      entityType: "invitation",
      entityId: invitationId,
      metadata: { email: revoked.email, role: revoked.role },
    });
  }

  revalidatePath("/dashboard/team");
}

export async function changeRoleAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "team");

  const parsed = roleChangeSchema.safeParse({
    profileId: formData.get("profileId"),
    roleId: formData.get("roleId"),
  });

  if (!parsed.success) return;

  const { profileId, roleId } = parsed.data;

  // The database also blocks this (guard_profile_changes), but failing here
  // gives a clearer path than surfacing a Postgres exception.
  if (profileId === session.userId) return;

  const supabase = await createClient();

  /*
   * The owner role is never assignable. The form does not offer it, so
   * reaching here means a hand-made request -- refuse rather than trust the
   * absence of an option in the markup.
   */
  const { data: target } = await supabase
    .from("roles")
    .select("id, name, is_owner")
    .eq("id", roleId)
    .maybeSingle();

  if (!target || target.is_owner) return;

  const { data: before } = await supabase
    .from("profiles")
    .select("role_id, email")
    .eq("id", profileId)
    .maybeSingle();

  if (!before || before.role_id === roleId) return;

  const { data: updated, error } = await supabase
    .from("profiles")
    .update({ role_id: roleId })
    .eq("id", profileId)
    .select("id")
    .maybeSingle();

  if (error || !updated) return;

  await logAudit(session, {
    action: AUDIT_ACTIONS.STAFF_ROLE_CHANGED,
    entityType: "profile",
    entityId: profileId,
    metadata: { email: before.email, to: target.name, role_id: roleId },
  });

  revalidatePath("/dashboard/team");
}

/**
 * Deactivate or reactivate a team member.
 *
 * Deactivation rather than deletion: receipts, appointments and payroll entries
 * reference the staff member, and the audit trail has to stay intact. A
 * deactivated user's `current_salon_id()` resolves to NULL, so RLS stops
 * matching any row for them -- they lose access immediately and completely.
 */
export async function setActiveAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "team");

  const profileId = String(formData.get("profileId") ?? "");
  const isActive = formData.get("isActive") === "true";

  if (!profileId || profileId === session.userId) return;

  const supabase = await createClient();

  const { data: updated, error } = await supabase
    .from("profiles")
    .update({ is_active: isActive })
    .eq("id", profileId)
    .select("email, role")
    .maybeSingle();

  if (error || !updated) return;

  await logAudit(session, {
    action: isActive ? AUDIT_ACTIONS.STAFF_REACTIVATED : AUDIT_ACTIONS.STAFF_DEACTIVATED,
    entityType: "profile",
    entityId: profileId,
    metadata: { email: updated.email, role: updated.role as UserRole },
  });

  revalidatePath("/dashboard/team");
}

/* -------------------------------------------------------------------------- */
/* Staff identity documents                                                    */
/*                                                                             */
/* An ID card is held about a real person, for the owner's records only. It is */
/* treated as the consent attachments are: a private bucket, a row describing  */
/* the object, short-lived signed URLs, and every touch recorded in the audit  */
/* trail. Who may read one is decided in exactly one place --                  */
/* `public.can_access_staff_document()` -- not here.                           */
/* -------------------------------------------------------------------------- */

export async function uploadStaffDocumentAction(
  _prevState: TeamFormState,
  formData: FormData,
): Promise<TeamFormState> {
  const session = await requireSession();
  try {
    assertRole(session, "owner");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const staffId = String(formData.get("staffId") ?? "");
  if (!staffId) return { message: "No team member was given." };

  const file = formData.get("document");
  if (!(file instanceof File) || file.size === 0) {
    return { errors: { document: "Choose a file to upload." } };
  }

  const problem = describeAttachmentProblem(file);
  if (problem) return { errors: { document: problem } };

  const supabase = await createClient();
  const salonId = session.profile.salon_id;

  // Confirm the person is ours before building a storage path from their id.
  const { data: member } = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .eq("id", staffId)
    .maybeSingle();
  if (!member) return { message: "That team member could not be found." };

  // One card per person: the old row and its object go first, so the bucket
  // does not accumulate a file nothing points at.
  const { data: existing } = await supabase
    .from("staff_documents")
    .select("id, file_path")
    .eq("staff_id", staffId)
    .eq("doc_type", "id_card")
    .maybeSingle();

  const documentId = randomUUID();
  const extension = ATTACHMENT_EXTENSIONS[file.type] ?? "bin";
  const path = `${salonId}/${staffId}/${documentId}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from("staff-documents")
    .upload(path, file, { contentType: file.type, upsert: false });

  if (uploadError) return { message: uploadError.message };

  if (existing) {
    const { error: removeRowError } = await supabase
      .from("staff_documents")
      .delete()
      .eq("id", existing.id);
    if (removeRowError) {
      await supabase.storage.from("staff-documents").remove([path]);
      return { message: removeRowError.message };
    }
    await supabase.storage.from("staff-documents").remove([existing.file_path]);
  }

  // `.select()` and check: a zero-row insert refused by a missing policy looks
  // exactly like success in PostgREST.
  const { data: inserted, error: insertError } = await supabase
    .from("staff_documents")
    .insert({
      id: documentId,
      salon_id: salonId,
      staff_id: staffId,
      doc_type: "id_card",
      file_path: path,
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
      note: String(formData.get("note") ?? "").slice(0, 500),
      uploaded_by: session.userId,
    })
    .select("id")
    .maybeSingle();

  if (insertError || !inserted) {
    await supabase.storage.from("staff-documents").remove([path]);
    return { message: insertError?.message ?? "The document could not be saved." };
  }

  await logAudit(session, {
    action: AUDIT_ACTIONS.STAFF_DOCUMENT_UPLOADED,
    entityType: "staff_document",
    entityId: inserted.id,
    // The staff member, never the file itself or anything read out of it.
    metadata: { staff_id: staffId, replaced: Boolean(existing) },
  });

  revalidatePath("/dashboard/team");
  return { success: `ID document saved for ${member.full_name || member.email}.` };
}

export async function removeStaffDocumentAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertRole(session, "owner");

  const documentId = String(formData.get("documentId") ?? "");
  if (!documentId) return;

  const supabase = await createClient();

  const { data: document } = await supabase
    .from("staff_documents")
    .select("id, staff_id, file_path")
    .eq("id", documentId)
    .maybeSingle();
  if (!document) return;

  const { data: deleted } = await supabase
    .from("staff_documents")
    .delete()
    .eq("id", documentId)
    .select("id")
    .maybeSingle();

  if (!deleted) return;

  await supabase.storage.from("staff-documents").remove([document.file_path]);

  await logAudit(session, {
    action: AUDIT_ACTIONS.STAFF_DOCUMENT_REMOVED,
    entityType: "staff_document",
    entityId: documentId,
    metadata: { staff_id: document.staff_id },
  });

  revalidatePath("/dashboard/team");
}

/**
 * A short-lived URL for one ID document.
 *
 * Minted through the RLS-bound Storage client, so Storage applies the same
 * single rule the table does: a staff member holding the exact object path
 * gets nothing back, and neither does another tenant.
 */
export async function getStaffDocumentUrlAction(documentId: string): Promise<string | null> {
  const session = await requireSession();
  const supabase = await createClient();

  const { data: document } = await supabase
    .from("staff_documents")
    .select("id, staff_id, file_path")
    .eq("id", documentId)
    .maybeSingle();

  if (!document) return null;

  const { data, error } = await supabase.storage
    .from("staff-documents")
    .createSignedUrl(document.file_path, 60);

  if (error || !data) return null;

  await logAudit(session, {
    action: AUDIT_ACTIONS.STAFF_DOCUMENT_VIEWED,
    entityType: "staff_document",
    entityId: document.id,
    metadata: { staff_id: document.staff_id },
  });

  return data.signedUrl;
}

/* -------------------------------------------------------------------------- */
/* The roster                                                                  */
/*                                                                             */
/* A team member is a name and a specialty. No email, no password, no auth     */
/* user -- most of a salon floor has no reason to sign in, and inventing an    */
/* address for them would put a fictional account in the auth system.          */
/*                                                                             */
/* A login is an optional attachment, handled by linkLoginAction below.        */
/* -------------------------------------------------------------------------- */

export async function saveTeamMemberAction(
  _prevState: TeamFormState,
  formData: FormData,
): Promise<TeamFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "team");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = teamMemberSchema.safeParse({
    fullName: formData.get("fullName"),
    specialty: formData.get("specialty") ?? "",
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const memberId = String(formData.get("memberId") ?? "");
  const supabase = await createClient();

  const row = {
    salon_id: session.profile.salon_id,
    full_name: parsed.data.fullName,
    specialty: parsed.data.specialty,
  };

  // `.select()` and check the result: a zero-row update is not an error in
  // PostgREST, so "no error" is not evidence anything happened.
  const { data: saved, error } = memberId
    ? await supabase
        .from("team_members")
        .update(row)
        .eq("id", memberId)
        .select("id")
        .maybeSingle()
    : await supabase.from("team_members").insert(row).select("id").maybeSingle();

  if (error) return { message: error.message };
  if (!saved) return { message: "That team member could not be saved." };

  await logAudit(session, {
    action: memberId ? AUDIT_ACTIONS.TEAM_MEMBER_UPDATED : AUDIT_ACTIONS.TEAM_MEMBER_ADDED,
    entityType: "team_member",
    entityId: saved.id,
    metadata: { full_name: parsed.data.fullName, specialty: parsed.data.specialty },
  });

  revalidatePath("/dashboard/team");
  return { success: memberId ? "Team member updated." : `${parsed.data.fullName} added.` };
}

/**
 * Take someone off the rota, or put them back.
 *
 * Deactivation rather than deletion, for the same reason a login is
 * deactivated: appointments, receipt lines and payroll entries reference them,
 * and the history has to stay readable. An inactive member cannot be booked or
 * credited with new work, and stops drawing a salary.
 */
export async function setTeamMemberActiveAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "team");

  const memberId = String(formData.get("memberId") ?? "");
  const isActive = formData.get("isActive") === "true";
  if (!memberId) return;

  const supabase = await createClient();
  const { data: updated } = await supabase
    .from("team_members")
    .update({ is_active: isActive })
    .eq("id", memberId)
    .select("id, full_name")
    .maybeSingle();

  if (!updated) return;

  await logAudit(session, {
    action: isActive
      ? AUDIT_ACTIONS.TEAM_MEMBER_REACTIVATED
      : AUDIT_ACTIONS.TEAM_MEMBER_DEACTIVATED,
    entityType: "team_member",
    entityId: memberId,
    metadata: { full_name: updated.full_name },
  });

  revalidatePath("/dashboard/team");
}

/**
 * Attach a login to a roster entry, or detach it.
 *
 * This is the "upgrade" the brief asks for: someone already on the team is
 * given an account so they can sign in and see their own earnings. It is
 * decided per person -- most of the roster never needs one.
 *
 * One login per roster entry, enforced by a unique constraint as well as here:
 * two accounts sharing an entry would make "my earnings" ambiguous.
 */
export async function linkLoginAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "team");

  const profileId = String(formData.get("profileId") ?? "");
  const memberId = String(formData.get("memberId") ?? "");
  if (!profileId) return;

  const supabase = await createClient();
  const { data: updated } = await supabase
    .from("profiles")
    .update({ team_member_id: memberId || null })
    .eq("id", profileId)
    .select("id, email")
    .maybeSingle();

  if (!updated) return;

  await logAudit(session, {
    action: memberId ? AUDIT_ACTIONS.LOGIN_LINKED : AUDIT_ACTIONS.LOGIN_UNLINKED,
    entityType: "profile",
    entityId: profileId,
    metadata: { email: updated.email, team_member_id: memberId || null },
  });

  revalidatePath("/dashboard/team");
}

/* -------------------------------------------------------------------------- */
/* Roles                                                                       */
/*                                                                             */
/* A role is a name and a set of modules. The owner role is not among them --  */
/* it is created with the salon, holds everything, and the database refuses to */
/* rename, delete, assign or fabricate it.                                     */
/* -------------------------------------------------------------------------- */

export async function saveRoleAction(
  _prevState: TeamFormState,
  formData: FormData,
): Promise<TeamFormState> {
  const session = await requireSession();
  try {
    assertModule(session, "team");
  } catch (error) {
    return { message: (error as Error).message };
  }

  const parsed = roleSchema.safeParse({
    name: formData.get("name"),
    modules: formData.getAll("modules").map(String),
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const { name, modules } = parsed.data;
  const roleId = String(formData.get("roleId") ?? "");
  const supabase = await createClient();

  if (roleId) {
    const { data: existing } = await supabase
      .from("roles")
      .select("id, is_owner, is_system, name")
      .eq("id", roleId)
      .maybeSingle();

    if (!existing) return { message: "That role could not be found." };
    if (existing.is_owner) {
      return { message: "The owner role holds every module and cannot be edited." };
    }

    // A built-in role keeps its name -- the seeds are referred to by name when
    // an older invitation has to be matched to one.
    if (!existing.is_system && existing.name !== name) {
      const { error: renameError } = await supabase
        .from("roles")
        .update({ name })
        .eq("id", roleId);
      if (renameError) return { message: friendlyRoleError(renameError) };
    }
  }

  let targetId = roleId;

  if (!targetId) {
    const { data: created, error: createError } = await supabase
      .from("roles")
      .insert({ salon_id: session.profile.salon_id, name })
      .select("id")
      .maybeSingle();

    if (createError) return { message: friendlyRoleError(createError) };
    if (!created) return { message: "That role could not be created." };
    targetId = created.id;
  }

  /*
   * Replace the ticks wholesale. An unticked box has no row to update, so a
   * diff would have to work out what was removed -- clearing and re-inserting
   * says exactly what the form said.
   */
  const { error: clearError } = await supabase
    .from("role_modules")
    .delete()
    .eq("role_id", targetId);
  if (clearError) return { message: clearError.message };

  if (modules.length > 0) {
    const { error: grantError } = await supabase.from("role_modules").insert(
      modules.map((module) => ({
        salon_id: session.profile.salon_id,
        role_id: targetId,
        module,
      })),
    );
    if (grantError) return { message: grantError.message };
  }

  await logAudit(session, {
    action: roleId ? AUDIT_ACTIONS.ROLE_UPDATED : AUDIT_ACTIONS.ROLE_CREATED,
    entityType: "role",
    entityId: targetId,
    metadata: { name, modules: modules.join(", ") || "none" },
  });

  revalidatePath("/dashboard/team");
  return { success: roleId ? `${name} updated.` : `${name} created.` };
}

export async function deleteRoleAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  assertModule(session, "team");

  const roleId = String(formData.get("roleId") ?? "");
  if (!roleId) return;

  const supabase = await createClient();

  const { data: deleted } = await supabase
    .from("roles")
    .delete()
    .eq("id", roleId)
    .select("id, name")
    .maybeSingle();

  // The database refuses the owner role, built-in roles, and any role still
  // referenced by a login. A refusal simply deletes nothing.
  if (!deleted) return;

  await logAudit(session, {
    action: AUDIT_ACTIONS.ROLE_DELETED,
    entityType: "role",
    entityId: roleId,
    metadata: { name: deleted.name },
  });

  revalidatePath("/dashboard/team");
}

/** Turns the constraint violations into something an owner can act on. */
function friendlyRoleError(error: { code?: string; message: string }): string {
  if (error.code === "23505") return "A role with that name already exists.";
  return error.message.replace(/^.*?:\s*/, "");
}