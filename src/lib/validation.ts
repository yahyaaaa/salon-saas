import { z } from "zod";

import { findCountry } from "@/lib/countries";

/**
 * A country, given as a name or an ISO code, normalised to its canonical name.
 * Stored canonically so the currency and timezone it implies can always be
 * looked back up.
 */
const country = z
  .string()
  .trim()
  .min(2, "Choose a country")
  .max(56)
  .refine((value) => findCountry(value) !== null, "Choose a country from the list")
  .transform((value) => findCountry(value)!.name);

const email = z.string().trim().min(1, "Email is required").email("Enter a valid email address");

const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be 72 characters or fewer");

export const signUpSchema = z.object({
  salonName: z.string().trim().min(2, "Salon name is required").max(200),
  businessType: z.enum(["salon", "aesthetic_clinic"]),
  fullName: z.string().trim().min(2, "Your name is required").max(120),
  email,
  password,
  country,
  timezone: z.string().trim().min(1, "Timezone is required").max(64),
  currency: z.string().trim().length(3, "Use a 3-letter currency code").toUpperCase(),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "Password is required"),
});

export const inviteSchema = z.object({
  email,
  fullName: z.string().trim().max(120).default(""),
  /*
   * The salon's own role. The owner role is never offered and is refused
   * server-side: the owner is whoever created the salon, and that is not
   * something an invitation can confer.
   */
  roleId: z.string().uuid("Choose a role"),
});
export type InviteInput = z.infer<typeof inviteSchema>;

/**
 * Moving a login onto a role.
 *
 * A role id, not one of three fixed names -- a salon defines its own. The
 * owner role is never offered and is refused server-side regardless: who owns
 * the salon is not a permission setting.
 */
export const roleChangeSchema = z.object({
  profileId: z.string().uuid(),
  roleId: z.string().uuid("Choose a role"),
});

/** A role the owner defines, and the modules it may reach. */
export const roleSchema = z.object({
  name: z.string().trim().min(2, "Give the role a name").max(60),
  modules: z
    .array(
      z.enum([
        "calendar",
        "customers",
        "pos",
        "services",
        "payroll",
        "reports",
        "team",
        "audit",
        "settings",
      ]),
    )
    .default([]),
});

export const setPasswordSchema = z
  .object({
    fullName: z.string().trim().min(2, "Your name is required").max(120),
    password,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

const businessHoursDay = z.object({
  open: timeOfDay,
  close: timeOfDay,
  closed: z.boolean(),
});

export const salonSettingsSchema = z.object({
  salonName: z.string().trim().min(2, "Salon name is required").max(200),
  businessType: z.enum(["salon", "aesthetic_clinic"]),
  country,
  timezone: z.string().trim().min(1).max(64),
  currency: z.string().trim().length(3).toUpperCase(),
  // Stored as a fraction (0.05 = 5%); the form collects a percentage.
  loyaltyEarnRatePercent: z.coerce
    .number()
    .min(0, "Cannot be negative")
    .max(100, "Cannot exceed 100%"),
  businessHours: z.object({
    mon: businessHoursDay,
    tue: businessHoursDay,
    wed: businessHoursDay,
    thu: businessHoursDay,
    fri: businessHoursDay,
    sat: businessHoursDay,
    sun: businessHoursDay,
  }),
});

export const profileUpdateSchema = z.object({
  fullName: z.string().trim().min(2, "Your name is required").max(120),
  phone: z.string().trim().max(32).optional().or(z.literal("")),
});

/** Turn a ZodError into the flat `{ field: message }` shape the forms render. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !result[key]) result[key] = issue.message;
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Phase 2 -- catalogue, customers, consent                                    */
/* -------------------------------------------------------------------------- */

const money = z.coerce
  .number({ message: "Enter an amount" })
  .min(0, "Cannot be negative")
  .max(9_999_999, "That is too large")
  // Guard against float drift before it reaches a money column.
  .transform((n) => Math.round(n * 100) / 100);

export const serviceSchema = z.object({
  name: z.string().trim().min(2, "Service name is required").max(160),
  category: z.string().trim().min(1, "Category is required").max(80).default("General"),
  description: z.string().trim().max(2000).default(""),
  price: money,
  durationMinutes: z.coerce
    .number({ message: "Enter a duration" })
    .int("Use whole minutes")
    .min(5, "Minimum 5 minutes")
    .max(1440, "Maximum 24 hours"),
  consentTemplateId: z.string().uuid().nullish().or(z.literal("")),
  staffIds: z.array(z.string().uuid()).default([]),
  /**
   * The default commission for whoever performs this service. "" means none.
   * A staff member with a rate of their own overrides it.
   */
  commissionBasis: z.enum(["", "percentage", "fixed_per_service"]).default(""),
  commissionPercent: z.coerce
    .number()
    .min(0, "Cannot be negative")
    .max(100, "Cannot exceed 100%")
    .default(0),
  commissionFixed: z.coerce.number().min(0, "Cannot be negative").max(9_999_999).default(0),
});
export type ServiceInput = z.infer<typeof serviceSchema>;

export const dealSchema = z
  .object({
    name: z.string().trim().min(2, "Deal name is required").max(160),
    dealType: z.enum(["percentage", "fixed_amount", "bundle_price"]),
    value: money,
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date"),
    endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick an end date"),
    serviceIds: z.array(z.string().uuid()).default([]),
  })
  .refine((d) => d.endsOn >= d.startsOn, {
    message: "The end date cannot be before the start date",
    path: ["endsOn"],
  })
  .refine((d) => d.dealType !== "percentage" || d.value <= 100, {
    message: "A percentage cannot exceed 100",
    path: ["value"],
  })
  .refine((d) => d.dealType !== "bundle_price" || d.serviceIds.length >= 2, {
    message: "A bundle needs at least two services",
    path: ["serviceIds"],
  });
export type DealInput = z.infer<typeof dealSchema>;

export const consentTemplateSchema = z.object({
  name: z.string().trim().min(2, "Template name is required").max(160),
  description: z.string().trim().max(2000).default(""),
  requiresMedicalHistory: z.boolean().default(true),
  // Blank lines are dropped, so an owner can paste a list.
  items: z
    .array(
      z.object({
        label: z.string().trim().min(3, "Each statement needs wording").max(500),
        isRequired: z.boolean().default(true),
      }),
    )
    .min(1, "Add at least one consent statement"),
});
export type ConsentTemplateInput = z.infer<typeof consentTemplateSchema>;

export const customerSchema = z.object({
  fullName: z.string().trim().min(2, "Customer name is required").max(160),
  phone: z
    .string()
    .trim()
    .min(3, "Phone number is required")
    .max(32)
    .refine((v) => v.replace(/[^0-9]/g, "").length >= 6, {
      message: "That does not look like a phone number",
    }),
  email: z.string().trim().email("Enter a valid email address").or(z.literal("")).optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .or(z.literal(""))
    .optional(),
  notes: z.string().trim().max(4000).default(""),
});
export type CustomerInput = z.infer<typeof customerSchema>;

/**
 * A data: URL holding the signature bitmap drawn on the canvas.
 * Capped well under the bucket's 512 KB limit; a signature is a few KB.
 */
export const signatureDataUrlSchema = z
  .string()
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, "The signature could not be read")
  .max(700_000, "That signature is too large");

export const consentFormSchema = z.object({
  customerId: z.string().uuid(),
  templateId: z.string().uuid().nullish().or(z.literal("")),
  serviceId: z.string().uuid().nullish().or(z.literal("")),
  /**
   * The visit this form belongs to. Linking it is what lets the treating
   * therapist read it -- see can_access_consent_form() in the schema.
   */
  appointmentId: z.string().uuid().nullish().or(z.literal("")),
  medicalHistory: z.string().trim().max(8000).default(""),
  allergies: z.string().trim().max(2000).default(""),
  signature: signatureDataUrlSchema,
  responses: z
    .array(
      z.object({
        itemId: z.string().uuid().nullish(),
        label: z.string().trim().min(1).max(500),
        isRequired: z.boolean().default(false),
        checked: z.boolean().default(false),
      }),
    )
    .default([]),
});
export type ConsentFormInput = z.infer<typeof consentFormSchema>;

/* -------------------------------------------------------------------------- */
/* Phase 3 -- booking                                                          */
/* -------------------------------------------------------------------------- */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date");
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Pick a time");

export const bookingSchema = z
  .object({
    customerId: z.string().uuid().nullish(),
    newCustomerName: z.string().trim().max(160).default(""),
    newCustomerPhone: z.string().trim().max(32).default(""),
    isNewCustomer: z.boolean().default(false),
    staffId: z.string().uuid("Choose a team member"),
    /** Wall-clock in the salon's own timezone; converted server-side. */
    date: isoDate,
    time: clockTime,
    notes: z.string().trim().max(2000).default(""),
    isWalkIn: z.boolean().default(false),
    /** Taken off the calculated subtotal. */
    discount: z.coerce.number().min(0, "Cannot be negative").max(9_999_999).default(0),
    /**
     * A price quoted for the whole booking, replacing the arithmetic. Blank
     * means "add the services up" -- which is not the same as zero.
     */
    quotedTotal: z
      .union([z.literal(""), z.coerce.number().min(0, "Cannot be negative").max(9_999_999)])
      .default(""),
    lines: z
      .array(
        z.object({
          serviceId: z.string().uuid(),
          quantity: z.coerce.number().int().min(1).max(20).default(1),
        }),
      )
      .min(1, "Add at least one service"),
  })
  .refine((d) => d.isNewCustomer || Boolean(d.customerId), {
    message: "Search for and choose a customer",
    path: ["customerId"],
  })
  .refine((d) => !d.isNewCustomer || d.newCustomerName.length >= 2, {
    message: "Enter the customer's name",
    path: ["newCustomerName"],
  })
  .refine(
    (d) => !d.isNewCustomer || d.newCustomerPhone.replace(/[^0-9]/g, "").length >= 6,
    { message: "Enter a valid phone number", path: ["newCustomerPhone"] },
  );
export type BookingInput = z.infer<typeof bookingSchema>;

export const rescheduleSchema = z.object({
  appointmentId: z.string().uuid(),
  staffId: z.string().uuid(),
  date: isoDate,
  time: clockTime,
});

/**
 * Cancelling and marking a no-show both require a reason -- the brief feeds
 * them into reporting, and the database rejects either without one.
 */
export const resolveAppointmentSchema = z.object({
  appointmentId: z.string().uuid(),
  status: z.enum(["cancelled", "no_show"]),
  reason: z.string().trim().min(3, "Give a brief reason").max(500),
});

/* -------------------------------------------------------------------------- */
/* Payments -- deposits, instalments and refunds                               */
/* -------------------------------------------------------------------------- */

export const paymentSchema = z.object({
  appointmentId: z.string().uuid(),
  amount: z.coerce
    .number()
    .positive("Enter an amount")
    .max(99_999_999, "That is larger than this can record"),
  method: z.enum(["cash", "card", "bank_transfer", "other"]),
  /**
   * When the money changed hands, which is not always when it was typed in --
   * a deposit taken on Friday may only be entered on Monday. Blank means now.
   */
  paidOn: z
    .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date")])
    .default(""),
  note: z.string().trim().max(500).default(""),
});

export const refundPaymentSchema = z.object({
  paymentId: z.string().uuid(),
  reason: z.string().trim().min(3, "Give a reason for the refund").max(500),
});

/** Changing the services or the price on a booking that has not happened yet. */
export const appointmentEditSchema = z.object({
  appointmentId: z.string().uuid(),
  discount: z.coerce.number().min(0, "Cannot be negative").max(9_999_999).default(0),
  quotedTotal: z
    .union([z.literal(""), z.coerce.number().min(0, "Cannot be negative").max(9_999_999)])
    .default(""),
  lines: z
    .array(
      z.object({
        serviceId: z.string().uuid(),
        quantity: z.coerce.number().int().min(1).max(20).default(1),
      }),
    )
    .min(1, "A booking needs at least one service"),
});

/* -------------------------------------------------------------------------- */
/* Phase 4 -- POS and loyalty                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the till submits. Note what is absent: no price, no subtotal, no total.
 * The checkout function re-derives every figure from the catalogue, so there is
 * nothing here for a tampered client to inflate.
 */
export const checkoutSchema = z.object({
  customerId: z.string().uuid("Choose a customer").nullish(),
  dealId: z.string().uuid().nullish().or(z.literal("")),
  paymentMethod: z.enum(["cash", "card", "bank_transfer", "split"]),
  cashAmount: z.coerce.number().min(0).max(9_999_999).default(0),
  cardAmount: z.coerce.number().min(0).max(9_999_999).default(0),
  transferAmount: z.coerce.number().min(0).max(9_999_999).default(0),
  loyaltyRedeem: z.coerce.number().min(0, "Cannot be negative").max(9_999_999).default(0),
  notes: z.string().trim().max(2000).default(""),
  /** The booking this sale settles, when it came from the diary. */
  appointmentId: z.string().uuid().nullish().or(z.literal("")),
  lines: z
    .array(
      z.object({
        serviceId: z.string().uuid(),
        staffId: z.string().uuid("Say who performed this service"),
        quantity: z.coerce.number().int().min(1).max(99).default(1),
        appointmentId: z.string().uuid().nullish().or(z.literal("")),
      }),
    )
    .min(1, "Add at least one service"),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const voidReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  reason: z.string().trim().min(3, "Give a reason for voiding").max(500),
});

/* -------------------------------------------------------------------------- */
/* Phase 5 -- payroll                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Pay is two independent settings, not one choice.
 *
 * `commissionBasis` of "" means "not set -- use the service's default", which
 * is deliberately different from "none".
 */
/** A roster entry: a name and, optionally, what they do. No email. */
export const teamMemberSchema = z.object({
  fullName: z.string().trim().min(2, "Enter their name").max(160),
  specialty: z.string().trim().max(160).default(""),
});

export const commissionSchema = z
  .object({
    staffId: z.string().uuid(),
    commissionBasis: z.enum(["", "none", "percentage", "fixed_per_service"]).default(""),
    /** Collected as a percentage; stored as a fraction. */
    commissionPercent: z.coerce
      .number()
      .min(0, "Cannot be negative")
      .max(100, "Cannot exceed 100%")
      .default(0),
    fixedAmount: z.coerce.number().min(0, "Cannot be negative").max(9_999_999).default(0),
    /** 0 means no salary, which is a real answer rather than a missing one. */
    salaryAmount: z.coerce.number().min(0, "Cannot be negative").max(99_999_999).default(0),
    /** Optional: a blank box means "no start date to withhold pay before". */
    joiningDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date")
      .optional()
      .or(z.literal("").transform(() => undefined)),
  })
  .refine((d) => d.commissionBasis !== "fixed_per_service" || d.fixedAmount > 0, {
    message: "Set an amount per service",
    path: ["fixedAmount"],
  });

/** A service's own default rate, which applies to whoever performs it. */
export const serviceCommissionSchema = z
  .object({
    commissionBasis: z.enum(["", "percentage", "fixed_per_service"]).default(""),
    commissionPercent: z.coerce
      .number()
      .min(0, "Cannot be negative")
      .max(100, "Cannot exceed 100%")
      .default(0),
    commissionFixed: z.coerce.number().min(0, "Cannot be negative").max(9_999_999).default(0),
  })
  .refine((d) => d.commissionBasis !== "fixed_per_service" || d.commissionFixed > 0, {
    message: "Set an amount per service",
    path: ["commissionFixed"],
  });

export const payrollPeriodSchema = z
  .object({
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date"),
    endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick an end date"),
    notes: z.string().trim().max(1000).default(""),
  })
  .refine((d) => d.endsOn >= d.startsOn, {
    message: "The end date cannot be before the start date",
    path: ["endsOn"],
  });

/* -------------------------------------------------------------------------- */
/* Consent attachments                                                         */
/* -------------------------------------------------------------------------- */

/** What the bucket accepts, kept in step with the migration's check constraint. */
export const ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 5;

export const ATTACHMENT_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Checks one uploaded file. Returns a message to show, or null if it is fine.
 * Re-checked here as well as by the bucket, because a browser is free to say
 * whatever it likes about a file's type.
 */
export function describeAttachmentProblem(file: File): string | null {
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return `${file.name} is larger than ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.`;
  }
  if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name} is a ${file.type || "unrecognised"} file. Attach a PDF, JPG, PNG or WebP.`;
  }
  return null;
}
