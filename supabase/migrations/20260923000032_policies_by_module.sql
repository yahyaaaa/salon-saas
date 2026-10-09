-- =============================================================================
-- Policies ask for a module, not a role
--
-- Every `current_app_role() in ('owner','receptionist')` becomes the module
-- that access actually depends on, and every owner-only policy becomes the
-- module a salon would grant to delegate that area. `is_owner()` survives only
-- where the thing really is the owner's alone.
--
-- This is the half of Phase 7 that makes custom roles mean anything. Without
-- it the Team page could tick boxes that changed nothing, because the database
-- would still be asking the old three-value enum -- and the UI and the
-- database would disagree about who may do what, which is the worst of both.
--
-- The mapping, once, so it can be checked against the nav:
--
--   calendar   appointments, appointment_services
--   customers  customer profiles (consent has its own rule, updated below)
--   pos        receipts, receipt lines, loyalty, payments
--   services   the catalogue, deals, consent templates, qualifications
--   payroll    pay settings, payroll periods and entries
--   team       the roster, accounts, invitations, roles
--   audit      the audit log
--   settings   the salon record and its settings
--
-- `reports` guards nothing here: the report functions are SECURITY INVOKER and
-- check for themselves, and are updated in the next migration.
--
-- WHAT DOES NOT CHANGE. "Or it is mine" clauses stay exactly as they are -- a
-- therapist reads their own appointments, their own receipt lines, their own
-- pay settings and their own payroll entries whether or not their role holds
-- the module. Those are not delegated powers; they are the person's own
-- record, and taking them away with a module tick would be wrong.
-- =============================================================================

-- --- calendar ----------------------------------------------------------------
drop policy if exists appointments_select_permitted on public.appointments;
create policy appointments_select_permitted
  on public.appointments for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and (public.has_module('calendar') or staff_id = public.current_team_member_id())
  );

drop policy if exists appointments_insert_front_desk on public.appointments;
create policy appointments_insert_front_desk
  on public.appointments for insert to authenticated
  with check (salon_id = public.current_salon_id() and public.has_module('calendar'));

drop policy if exists appointments_update_front_desk on public.appointments;
create policy appointments_update_front_desk
  on public.appointments for update to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('calendar'))
  with check (salon_id = public.current_salon_id() and public.has_module('calendar'));

drop policy if exists appointment_services_select_permitted on public.appointment_services;
create policy appointment_services_select_permitted
  on public.appointment_services for select to authenticated
  using (
    exists (
      select 1
      from public.appointments a
      where a.id = appointment_id
        and a.salon_id = public.current_salon_id()
        and (public.has_module('calendar') or a.staff_id = public.current_team_member_id())
    )
  );

drop policy if exists appointment_services_write_front_desk on public.appointment_services;
create policy appointment_services_write_front_desk
  on public.appointment_services for all to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('calendar'))
  with check (salon_id = public.current_salon_id() and public.has_module('calendar'));

-- --- customers ---------------------------------------------------------------
drop policy if exists customers_insert_front_desk on public.customers;
create policy customers_insert_front_desk
  on public.customers for insert to authenticated
  with check (salon_id = public.current_salon_id() and public.has_module('customers'));

drop policy if exists customers_update_front_desk on public.customers;
create policy customers_update_front_desk
  on public.customers for update to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('customers'))
  with check (salon_id = public.current_salon_id() and public.has_module('customers'));

drop policy if exists customers_delete_owner_only on public.customers;
create policy customers_delete_owner_only
  on public.customers for delete to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('customers'));

-- --- pos ---------------------------------------------------------------------
drop policy if exists receipts_select_front_desk on public.receipts;
create policy receipts_select_front_desk
  on public.receipts for select to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('pos'));

drop policy if exists receipt_line_items_select_permitted on public.receipt_line_items;
create policy receipt_line_items_select_permitted
  on public.receipt_line_items for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and (public.has_module('pos') or staff_id = public.current_team_member_id())
  );

drop policy if exists loyalty_transactions_select_front_desk on public.loyalty_transactions;
create policy loyalty_transactions_select_front_desk
  on public.loyalty_transactions for select to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('pos'));

drop policy if exists payments_select_front_desk on public.payments;
create policy payments_select_front_desk
  on public.payments for select to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('pos'));

-- --- services ----------------------------------------------------------------
drop policy if exists services_write_owner_only on public.services;
create policy services_write_owner_only
  on public.services for all to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('services'))
  with check (salon_id = public.current_salon_id() and public.has_module('services'));

drop policy if exists service_staff_write_owner_only on public.service_staff;
create policy service_staff_write_owner_only
  on public.service_staff for all to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('services'))
  with check (salon_id = public.current_salon_id() and public.has_module('services'));

drop policy if exists deals_write_owner_only on public.deals;
create policy deals_write_owner_only
  on public.deals for all to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('services'))
  with check (salon_id = public.current_salon_id() and public.has_module('services'));

drop policy if exists deal_services_write_owner_only on public.deal_services;
create policy deal_services_write_owner_only
  on public.deal_services for all to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('services'))
  with check (salon_id = public.current_salon_id() and public.has_module('services'));

drop policy if exists consent_templates_write_owner_only on public.consent_templates;
create policy consent_templates_write_owner_only
  on public.consent_templates for all to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('services'))
  with check (salon_id = public.current_salon_id() and public.has_module('services'));

drop policy if exists consent_template_items_write_owner_only on public.consent_template_items;
create policy consent_template_items_write_owner_only
  on public.consent_template_items for all to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('services'))
  with check (salon_id = public.current_salon_id() and public.has_module('services'));

-- --- payroll -----------------------------------------------------------------
drop policy if exists staff_compensation_select_self_or_owner on public.staff_compensation;
create policy staff_compensation_select_self_or_owner
  on public.staff_compensation for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and (public.has_module('payroll') or staff_id = public.current_team_member_id())
  );

drop policy if exists staff_compensation_write_owner_only on public.staff_compensation;
create policy staff_compensation_write_owner_only
  on public.staff_compensation for all to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('payroll'))
  with check (salon_id = public.current_salon_id() and public.has_module('payroll'));

drop policy if exists payroll_periods_select_owner_only on public.payroll_periods;
create policy payroll_periods_select_owner_only
  on public.payroll_periods for select to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('payroll'));

drop policy if exists payroll_periods_delete_draft_owner_only on public.payroll_periods;
create policy payroll_periods_delete_draft_owner_only
  on public.payroll_periods for delete to authenticated
  using (
    salon_id = public.current_salon_id()
    and public.has_module('payroll')
    and status = 'draft'
  );

drop policy if exists payroll_entries_select_permitted on public.payroll_entries;
create policy payroll_entries_select_permitted
  on public.payroll_entries for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and (public.has_module('payroll') or staff_id = public.current_team_member_id())
  );

-- --- team --------------------------------------------------------------------
drop policy if exists team_members_write_owner_only on public.team_members;
create policy team_members_write_owner_only
  on public.team_members for all to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('team'))
  with check (salon_id = public.current_salon_id() and public.has_module('team'));

drop policy if exists invitations_select_owner_only on public.invitations;
create policy invitations_select_owner_only
  on public.invitations for select to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('team'));

drop policy if exists invitations_insert_owner_only on public.invitations;
create policy invitations_insert_owner_only
  on public.invitations for insert to authenticated
  with check (salon_id = public.current_salon_id() and public.has_module('team'));

drop policy if exists invitations_update_owner_only on public.invitations;
create policy invitations_update_owner_only
  on public.invitations for update to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('team'))
  with check (salon_id = public.current_salon_id() and public.has_module('team'));

drop policy if exists invitations_delete_owner_only on public.invitations;
create policy invitations_delete_owner_only
  on public.invitations for delete to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('team'));

drop policy if exists profiles_update_owner_manages_tenant on public.profiles;
create policy profiles_update_owner_manages_tenant
  on public.profiles for update to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('team'))
  with check (salon_id = public.current_salon_id() and public.has_module('team'));

-- --- audit -------------------------------------------------------------------
drop policy if exists audit_logs_select_owner_only on public.audit_logs;
create policy audit_logs_select_owner_only
  on public.audit_logs for select to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('audit'));

-- --- settings ----------------------------------------------------------------
drop policy if exists salon_settings_insert_owner_only on public.salon_settings;
create policy salon_settings_insert_owner_only
  on public.salon_settings for insert to authenticated
  with check (salon_id = public.current_salon_id() and public.has_module('settings'));

drop policy if exists salon_settings_update_owner_only on public.salon_settings;
create policy salon_settings_update_owner_only
  on public.salon_settings for update to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('settings'))
  with check (salon_id = public.current_salon_id() and public.has_module('settings'));

drop policy if exists salons_update_owner_only on public.salons;
create policy salons_update_owner_only
  on public.salons for update to authenticated
  using (id = public.current_salon_id() and public.has_module('settings'))
  with check (id = public.current_salon_id() and public.has_module('settings'));

-- =============================================================================
-- Consent visibility
--
-- The one place that decides who may read a consent record. "Works across the
-- whole salon's records" becomes the Customers module, because that is where
-- consent lives; the treating-therapist and own-collection clauses are
-- untouched.
-- =============================================================================
create or replace function public.can_access_consent_form(
  p_salon_id       uuid,
  p_collected_by   uuid,
  p_appointment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_salon_id is not null
     and p_salon_id = public.current_salon_id()
     and (
       public.has_module('customers')
       or p_collected_by = (select auth.uid())
       or exists (
         select 1
         from public.appointments a
         where a.id = p_appointment_id
           and a.salon_id = p_salon_id
           and a.staff_id = public.current_team_member_id()
       )
     )
$$;
