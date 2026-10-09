"use client";

import { useState, useTransition } from "react";

import { getSignatureUrlAction } from "../actions";
import { Button } from "@/components/ui";

/**
 * Fetches the signature on demand rather than rendering it with the page.
 *
 * The URL is minted server-side through the RLS-bound Storage client and
 * expires after a minute, so it cannot be copied out and shared. Each view is
 * recorded in the audit log.
 */
export function SignatureViewer({ formId }: { formId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function reveal() {
    startTransition(async () => {
      const signedUrl = await getSignatureUrlAction(formId);
      if (signedUrl) setUrl(signedUrl);
      else setFailed(true);
    });
  }

  if (url) {
    return (
      <figure>
        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not an optimisable asset */}
        <img
          src={url}
          alt="Customer signature"
          className="h-24 rounded-md border border-ink-200 bg-white"
        />
        <figcaption className="mt-1 text-xs text-ink-400">
          This link expires in a minute.
        </figcaption>
      </figure>
    );
  }

  return (
    <div>
      <Button type="button" variant="secondary" size="sm" onClick={reveal} disabled={pending}>
        {pending ? "Loading..." : "View signature"}
      </Button>
      {failed ? (
        <p className="mt-1 text-xs text-red-600">
          That signature could not be loaded. You may not have access to it.
        </p>
      ) : null}
    </div>
  );
}
