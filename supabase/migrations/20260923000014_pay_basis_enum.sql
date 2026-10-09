-- =============================================================================
-- A third pay basis: a flat recurring salary.
--
-- This is its own migration file for a Postgres reason, not a stylistic one:
-- a value added to an enum cannot be USED in the same transaction that adds
-- it, and `supabase db push` runs each file in one transaction. The columns
-- and the payroll rewrite that reference 'fixed_salary' therefore live in the
-- next file, which runs in a transaction of its own.
--
-- The type keeps the name `commission_type`. Renaming it would touch
-- staff_compensation, payroll_entries, every policy and every generated type
-- for no behavioural gain; the columns are labelled "pay basis" in the UI.
-- =============================================================================

alter type public.commission_type add value if not exists 'fixed_salary';

comment on type public.commission_type is
  'How a team member is paid: a share of what they sell (percentage), a flat '
  'amount per service performed (fixed_per_service), or a monthly salary '
  'regardless of services (fixed_salary).';
