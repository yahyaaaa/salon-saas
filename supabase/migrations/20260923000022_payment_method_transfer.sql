-- =============================================================================
-- Bank transfer as a way to settle a bill.
--
-- The payment LEDGER has accepted bank transfers since it was built -- a
-- deposit can be wired. Checkout could not, so the same money had to be rung
-- up as cash or card and the receipt said something untrue about how it
-- arrived.
--
-- Its own migration file for the usual Postgres reason: a value added to an
-- enum cannot be USED in the transaction that adds it, and `supabase db push`
-- runs each file in one transaction. The column and the function that
-- reference 'bank_transfer' are in the next file.
-- =============================================================================

alter type public.payment_method add value if not exists 'bank_transfer';

comment on type public.payment_method is
  'How a bill was settled at the till: cash, card, bank_transfer, or split across more than one of them.';
