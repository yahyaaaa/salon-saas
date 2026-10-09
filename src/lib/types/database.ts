/**
 * Database types for the Phase 1 schema.
 *
 * Hand-maintained for now so the app is type-safe before a Supabase project
 * exists. Once the project is linked you can regenerate this file verbatim:
 *
 *   npm run db:types
 */

export type UserRole = "owner" | "staff" | "receptionist";
export type BusinessType = "salon" | "aesthetic_clinic";
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "unpaid";
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export type BusinessHoursDay = {
  open: string;
  close: string;
  closed: boolean;
};

export type BusinessHours = Record<
  "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
  BusinessHoursDay
>;

export type SalonRow = {
  id: string;
  name: string;
  business_type: BusinessType;
  country: string;
  timezone: string;
  currency: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus;
  trial_ends_at: string;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
};

export type ProfileRow = {
  /** The role this login holds -- the authority on what they may do. */
  role_id: string | null;
  /**
   * The roster entry this login belongs to, if any. NULL for an account that
   * manages the salon but performs no services -- it has no appointments and
   * no earnings of its own.
   */
  team_member_id: string | null;
  id: string;
  salon_id: string;
  role: UserRole;
  full_name: string;
  email: string;
  phone: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type SalonSettingsRow = {
  salon_id: string;
  loyalty_earn_rate: number;
  business_hours: BusinessHours;
  created_at: string;
  updated_at: string;
};

export type InvitationRow = {
  /** The roster entry this login is for, if an existing person. */
  team_member_id: string | null;
  create_roster_entry: boolean;
  /** The role the accepted login will hold. */
  role_id: string | null;
  id: string;
  salon_id: string;
  email: string;
  role: UserRole;
  full_name: string;
  status: InvitationStatus;
  invited_by: string | null;
  accepted_user_id: string | null;
  accepted_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type AuditLogRow = {
  id: number;
  salon_id: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_role: UserRole | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Json;
  created_at: string;
}

export type DealType = "percentage" | "fixed_amount" | "bundle_price";

export type ConsentTemplateRow = {
  id: string;
  salon_id: string;
  name: string;
  description: string;
  requires_medical_history: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type ConsentTemplateItemRow = {
  id: string;
  salon_id: string;
  template_id: string;
  label: string;
  is_required: boolean;
  sort_order: number;
  created_at: string;
};

export type ServiceRow = {
  id: string;
  salon_id: string;
  name: string;
  category: string;
  description: string;
  price: number;
  duration_minutes: number;
  consent_template_id: string | null;
  /**
   * A default commission for whoever performs this service, used when the
   * staff member has no rate of their own. NULL means none.
   */
  commission_basis: CommissionBasis | null;
  commission_rate: number | null;
  commission_fixed: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type ServiceStaffRow = {
  salon_id: string;
  service_id: string;
  staff_id: string;
  created_at: string;
};

export type DealRow = {
  id: string;
  salon_id: string;
  name: string;
  deal_type: DealType;
  value: number;
  starts_on: string;
  ends_on: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type DealServiceRow = {
  salon_id: string;
  deal_id: string;
  service_id: string;
};

export type CustomerRow = {
  id: string;
  salon_id: string;
  full_name: string;
  phone: string;
  phone_normalized: string;
  email: string | null;
  date_of_birth: string | null;
  notes: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** SENSITIVE MEDICAL RECORD -- see can_access_consent_form() in the schema. */
export type ConsentFormRow = {
  id: string;
  salon_id: string;
  customer_id: string;
  template_id: string | null;
  service_id: string | null;
  appointment_id: string | null;
  collected_by: string | null;
  medical_history: string;
  allergies: string;
  signature_path: string | null;
  signed_at: string | null;
  created_at: string;
};

export type ConsentFormResponseRow = {
  id: string;
  salon_id: string;
  form_id: string;
  item_id: string | null;
  label: string;
  is_required: boolean;
  checked: boolean;
  sort_order: number;
};

export type AppointmentStatus =
  | "booked"
  | "confirmed"
  | "completed"
  | "cancelled"
  | "no_show";

export type AppointmentRow = {
  id: string;
  salon_id: string;
  customer_id: string;
  staff_id: string;
  service_id: string;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  is_walk_in: boolean;
  notes: string;
  services_subtotal: number;
  discount_amount: number;
  quoted_total: number | null;
  /** The agreed price: the override if given, else subtotal minus discount. */
  price_at_booking: number;
  created_by: string | null;
  resolution_reason: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PaymentMethod = "cash" | "card" | "bank_transfer" | "split";
export type ReceiptStatus = "issued" | "voided";
export type LoyaltyTransactionType = "earn" | "redeem" | "void_reversal";

export type ReceiptRow = {
  id: string;
  salon_id: string;
  receipt_number: number;
  customer_id: string;
  issued_by: string | null;
  deal_id: string | null;
  subtotal: number;
  discount_total: number;
  loyalty_redeemed: number;
  total: number;
  loyalty_earned: number;
  loyalty_earn_rate: number;
  payment_method: PaymentMethod;
  /** Settled by bank transfer at this transaction. */
  transfer_amount: number;
  cash_amount: number;
  card_amount: number;
  status: ReceiptStatus;
  /** The appointment this receipt settles, when the sale came from the diary. */
  appointment_id: string | null;
  /**
   * How much of this bill was already covered by advances. cash + card +
   * this always equals total -- the receipt states its own settlement.
   */
  deposit_applied: number;
  void_reason: string | null;
  voided_at: string | null;
  voided_by: string | null;
  notes: string;
  created_at: string;
};

export type ReceiptLineItemRow = {
  id: string;
  salon_id: string;
  receipt_id: string;
  service_id: string | null;
  service_name: string;
  staff_id: string | null;
  appointment_id: string | null;
  quantity: number;
  unit_price: number;
  discount_amount: number;
  line_total: number;
  performed_at: string;
  sort_order: number;
};

export type LoyaltyTransactionRow = {
  id: string;
  salon_id: string;
  customer_id: string;
  receipt_id: string | null;
  type: LoyaltyTransactionType;
  amount: number;
  resulting_balance: number;
  created_at: string;
};

/** One line as the checkout function expects it: what was done, never what it costs. */
export interface CheckoutLine {
  service_id: string;
  staff_id: string;
  quantity: number;
  appointment_id?: string | null;
}

/**
 * How someone earns commission. Three states, not two, and the difference
 * matters:
 *
 *   "none"   explicitly no commission -- the service's own default is ignored
 *   null     not set -- fall back to whatever the service says
 *
 * Without that distinction, "salary-only, zero commission" is impossible to
 * say once services carry defaults.
 */
export type CommissionBasis = "none" | "percentage" | "fixed_per_service";

/** The pre-split enum. Still stamped onto payroll entries for continuity. */
export type CommissionType = "percentage" | "fixed_per_service" | "fixed_salary";
export type PayrollStatus = "draft" | "paid";

export type StaffCompensationRow = {
  staff_id: string;
  salon_id: string;
  /** NULL means unset: use the service's default. */
  commission_basis: CommissionBasis | null;
  /** A fraction: 0.3 is 30%. NULL when the basis is not percentage. */
  commission_rate: number | null;
  fixed_amount: number | null;
  /** A monthly figure, pro-rated over the payroll period. */
  salary_amount: number;
  joining_date: string | null;
  created_at: string;
  updated_at: string;
};

export type PaymentEntryMethod = "cash" | "card" | "bank_transfer" | "other";

/**
 * Why the money moved. Set by the database functions, never chosen by a
 * caller, so a report can separate advances taken from bills settled.
 */
export type PaymentKind = "deposit" | "settlement" | "refund";

/** One event in the payment ledger. Append-only: a correction is a new row. */
export type PaymentRow = {
  id: string;
  salon_id: string;
  customer_id: string;
  appointment_id: string | null;
  receipt_id: string | null;
  kind: PaymentKind;
  method: PaymentEntryMethod;
  /** Signed: money in is positive, money back is negative. */
  amount: number;
  paid_at: string;
  note: string;
  reverses_id: string | null;
  recorded_by: string | null;
  created_at: string;
};

/** What one visit is owed, has been paid, and still owes. */
export type AppointmentBalance = {
  amount_due: number;
  amount_paid: number;
  balance: number;
  has_receipt: boolean;
};

/**
 * A roster entry: who performs services and who gets paid.
 *
 * Deliberately has no email and no auth user behind it. A login is an optional
 * attachment -- see ProfileRow.team_member_id -- so a therapist who never signs
 * in is still bookable, still earns commission, and still appears on payroll.
 */
/** A grantable area of the product. */
export type AppModule =
  | "calendar"
  | "customers"
  | "pos"
  | "services"
  | "payroll"
  | "reports"
  | "team"
  | "audit"
  | "settings";

/**
 * A role the salon defines.
 *
 * `is_owner` marks the salon owner's own role: exactly one per salon, holding
 * every module implicitly, and never assignable -- who owns the salon is not a
 * permission setting.
 *
 * `is_system` marks the four shipped with the product. Their modules are
 * editable; the roles themselves cannot be deleted, so a salon always has
 * something to assign.
 */
export type RoleRow = {
  id: string;
  salon_id: string;
  name: string;
  is_owner: boolean;
  is_system: boolean;
  created_at: string;
  updated_at: string;
};

export type RoleModuleRow = {
  salon_id: string;
  role_id: string;
  module: AppModule;
};

export type TeamMemberRow = {
  id: string;
  salon_id: string;
  full_name: string;
  specialty: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type StaffDocumentType = "id_card";

/** An identity document held about a team member. Owner-only, always. */
export type StaffDocumentRow = {
  id: string;
  salon_id: string;
  staff_id: string;
  doc_type: StaffDocumentType;
  file_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  note: string;
  uploaded_by: string | null;
  created_at: string;
};

export type PayrollPeriodRow = {
  id: string;
  salon_id: string;
  starts_on: string;
  ends_on: string;
  status: PayrollStatus;
  total_revenue: number;
  total_commission: number;
  notes: string;
  created_by: string | null;
  created_at: string;
  paid_at: string | null;
  paid_by: string | null;
};

export type PayrollEntryRow = {
  id: string;
  salon_id: string;
  period_id: string;
  staff_id: string | null;
  staff_name: string;
  services_performed: number;
  revenue: number;
  commission_type: CommissionType;
  /** The basis actually used, snapshotted. */
  commission_basis: CommissionBasis | null;
  commission_rate: number;
  fixed_amount: number;
  salary_amount: number;
  /** The pro-rated salary for the period. */
  salary_pay: number;
  /** Commission earned on services performed. */
  commission_pay: number;
  /** Days of the period paid at salary: its length, less any before joining. */
  salary_days_paid: number;
  /** What this entry pays out -- commission on services, or the salary. */
  commission_amount: number;
  period_starts_on: string;
  period_ends_on: string;
  status: PayrollStatus;
  paid_at: string | null;
  created_at: string;
};

/* -------------------------------------------------------------------------- */
/* Reporting (Phase 6) -- function return shapes                               */
/* -------------------------------------------------------------------------- */

export interface RevenueBucket {
  bucket: string;
  receipt_count: number;
  gross: number;
  discounts: number;
  loyalty_redeemed: number;
  revenue: number;
  loyalty_earned: number;
}

export interface RevenueByService {
  service_name: string;
  quantity: number;
  revenue: number;
  discounts: number;
}

export interface RevenueByStaff {
  staff_id: string | null;
  staff_name: string;
  services: number;
  revenue: number;
}

export interface RetentionSummary {
  new_customers: number;
  returning_customers: number;
  total_customers: number;
  repeat_rate: number;
  visits: number;
  visits_per_customer: number;
}

export interface AppointmentStats {
  staff_id: string | null;
  staff_name: string;
  booked: number;
  confirmed: number;
  completed: number;
  cancelled: number;
  no_show: number;
  total: number;
  no_show_rate: number;
}

export interface LoyaltyCost {
  issued: number;
  redeemed: number;
  adjustments: number;
  net_change: number;
  outstanding_balance: number;
  customers_with_balance: number;
}

export interface PeakTime {
  weekday: number;
  hour_of_day: number;
  appointments: number;
}

export type ReportGranularity = "day" | "week" | "month";

export type ConsentFormAttachmentRow = {
  id: string;
  salon_id: string;
  form_id: string;
  customer_id: string;
  file_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string | null;
  created_at: string;
};

export type AppointmentServiceRow = {
  id: string;
  salon_id: string;
  appointment_id: string;
  service_id: string;
  service_name: string;
  quantity: number;
  unit_price: number;
  duration_minutes: number;
  sort_order: number;
  created_at: string;
};

/** One service line as create_appointment() expects it. */
export interface BookingLine {
  service_id: string;
  quantity: number;
}

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      salons: Table<SalonRow>;
      profiles: Table<ProfileRow>;
      salon_settings: Table<SalonSettingsRow>;
      invitations: Table<
        InvitationRow,
        Pick<InvitationRow, "salon_id" | "email" | "role"> &
          Partial<Omit<InvitationRow, "salon_id" | "email" | "role">>
      >;
      audit_logs: Table<
        AuditLogRow,
        Pick<AuditLogRow, "salon_id" | "action"> &
          Partial<Omit<AuditLogRow, "id" | "salon_id" | "action" | "created_at">>
      >;
      consent_templates: Table<ConsentTemplateRow>;
      consent_template_items: Table<ConsentTemplateItemRow>;
      services: Table<ServiceRow>;
      service_staff: Table<ServiceStaffRow>;
      deals: Table<DealRow>;
      deal_services: Table<DealServiceRow>;
      // phone_normalized is generated by the database, never written.
      customers: Table<CustomerRow, Partial<Omit<CustomerRow, "phone_normalized">>, Partial<Omit<CustomerRow, "phone_normalized">>>;
      consent_forms: Table<ConsentFormRow>;
      consent_form_responses: Table<ConsentFormResponseRow>;
      consent_form_attachments: Table<ConsentFormAttachmentRow>;
      appointments: Table<AppointmentRow>;
      appointment_services: Table<AppointmentServiceRow>;
      receipts: Table<ReceiptRow>;
      receipt_line_items: Table<ReceiptLineItemRow>;
      loyalty_transactions: Table<LoyaltyTransactionRow>;
      staff_compensation: Table<StaffCompensationRow>;
      roles: Table<RoleRow>;
      role_modules: Table<RoleModuleRow>;
      team_members: Table<TeamMemberRow>;
      staff_documents: Table<StaffDocumentRow>;
      payments: Table<PaymentRow>;
      payroll_periods: Table<PayrollPeriodRow>;
      payroll_entries: Table<PayrollEntryRow>;
    };
    Views: Record<never, never>;
    Functions: {
      current_salon_id: { Args: Record<never, never>; Returns: string | null };
      current_app_role: { Args: Record<never, never>; Returns: UserRole | null };
      current_team_member_id: { Args: Record<never, never>; Returns: string | null };
      has_module: { Args: { p_module: AppModule }; Returns: boolean };
      is_owner: { Args: Record<never, never>; Returns: boolean };
      customer_loyalty_balance: { Args: { p_customer_id: string }; Returns: number };
      generate_payroll_period: {
        Args: { p_starts_on: string; p_ends_on: string; p_notes: string };
        Returns: string;
      };
      mark_payroll_paid: { Args: { p_period_id: string }; Returns: undefined };
      appointment_balance: {
        Args: { p_appointment_id: string };
        Returns: AppointmentBalance[];
      };
      record_payment: {
        Args: {
          p_appointment_id: string;
          p_amount: number;
          p_method: PaymentEntryMethod;
          p_paid_at: string | null;
          p_note: string;
        };
        Returns: string;
      };
      refund_payment: { Args: { p_payment_id: string; p_reason: string }; Returns: string };
      update_appointment_services: {
        Args: {
          p_appointment_id: string;
          p_lines: { service_id: string; quantity: number }[];
          p_discount: number;
          p_quoted_total: number | null;
        };
        Returns: undefined;
      };
      appointment_balances: {
        Args: { p_appointment_ids: string[] };
        Returns: (AppointmentBalance & { appointment_id: string })[];
      };
      report_revenue_over_time: {
        Args: { p_from: string; p_to: string; p_granularity: ReportGranularity };
        Returns: RevenueBucket[];
      };
      report_revenue_by_service: {
        Args: { p_from: string; p_to: string };
        Returns: RevenueByService[];
      };
      report_revenue_by_staff: {
        Args: { p_from: string; p_to: string };
        Returns: RevenueByStaff[];
      };
      report_customer_retention: {
        Args: { p_from: string; p_to: string };
        Returns: RetentionSummary[];
      };
      report_appointment_stats: {
        Args: { p_from: string; p_to: string };
        Returns: AppointmentStats[];
      };
      report_loyalty_cost: {
        Args: { p_from: string; p_to: string };
        Returns: LoyaltyCost[];
      };
      report_peak_times: {
        Args: { p_from: string; p_to: string };
        Returns: PeakTime[];
      };
      search_customers: {
        Args: { p_query: string; p_limit: number };
        Returns: { id: string; full_name: string; phone: string }[];
      };
      create_appointment: {
        Args: {
          p_customer_id: string | null;
          p_new_customer_name: string | null;
          p_new_customer_phone: string | null;
          p_staff_id: string;
          p_starts_at: string;
          p_notes: string;
          p_is_walk_in: boolean;
          p_discount: number;
          p_quoted_total: number | null;
          p_lines: BookingLine[];
        };
        Returns: string;
      };
      create_receipt: {
        Args: {
          p_customer_id: string | null;
          p_payment_method: PaymentMethod;
          p_cash_amount: number;
          p_card_amount: number;
          p_loyalty_redeem: number;
          p_deal_id: string | null;
          p_notes: string;
          p_lines: CheckoutLine[];
          p_new_customer_name?: string | null;
          p_new_customer_phone?: string | null;
          p_appointment_id?: string | null;
          p_transfer_amount?: number;
        };
        Returns: string;
      };
      void_receipt: { Args: { p_receipt_id: string; p_reason: string }; Returns: undefined };
      can_access_consent_form: {
        Args: {
          p_salon_id: string;
          p_collected_by: string | null;
          p_appointment_id: string | null;
        };
        Returns: boolean;
      };
    };
    Enums: {
      user_role: UserRole;
      business_type: BusinessType;
      subscription_status: SubscriptionStatus;
      invitation_status: InvitationStatus;
      deal_type: DealType;
      appointment_status: AppointmentStatus;
      payment_method: PaymentMethod;
      receipt_status: ReceiptStatus;
      loyalty_transaction_type: LoyaltyTransactionType;
      commission_type: CommissionType;
      payroll_status: PayrollStatus;
    };
    CompositeTypes: Record<never, never>;
  };
};
