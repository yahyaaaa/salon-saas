"use client";

import { useState, useTransition } from "react";

import { getAttachmentUrlAction } from "../actions";
import { Button } from "@/components/ui";

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/webp": "WebP",
};

/**
 * Opens one attachment. The URL is minted on demand and expires after a
 * minute, so it cannot be copied out of the page and shared.
 */
export function AttachmentLink({
  id,
  fileName,
  mimeType,
  sizeBytes,
}: {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}) {
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function open() {
    startTransition(async () => {
      const url = await getAttachmentUrlAction(id);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else setFailed(true);
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span className="min-w-0 text-sm text-ink-700">
        <span className="mr-2 rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-ink-500">
          {LABELS[mimeType] ?? "File"}
        </span>
        <span className="truncate">{fileName}</span>
        <span className="ml-2 text-xs text-ink-400">{readableSize(sizeBytes)}</span>
      </span>

      <span className="flex items-center gap-2">
        {failed ? (
          <span className="text-xs text-red-600">You do not have access to this file.</span>
        ) : null}
        <Button type="button" variant="secondary" size="sm" onClick={open} disabled={pending}>
          {pending ? "Opening..." : "Open"}
        </Button>
      </span>
    </li>
  );
}
