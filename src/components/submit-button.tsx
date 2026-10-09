"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps } from "react";

import { Button } from "@/components/ui";

/**
 * Submit button that disables itself while its enclosing form action is in
 * flight. Must be rendered inside the <form> it belongs to.
 */
export function SubmitButton({
  children,
  pendingLabel,
  ...props
}: ComponentProps<typeof Button> & { pendingLabel?: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending} aria-busy={pending} {...props}>
      {pending ? (pendingLabel ?? "Working...") : children}
    </Button>
  );
}
