"use client";

import { Button } from "@/components/ui";

/** Prints the receipt. The page's print styles hide everything around it. */
export function PrintButton() {
  return (
    <Button type="button" variant="secondary" size="sm" onClick={() => window.print()}>
      Print / save as PDF
    </Button>
  );
}
