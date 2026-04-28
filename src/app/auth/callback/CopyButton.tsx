"use client";

import { useState } from "react";

export default function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard write blocked — operator can still select+copy manually
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      style={{
        marginTop: "0.25rem",
        padding: "0.25rem 0.75rem",
        fontSize: "0.875rem",
        background: copied ? "#22a06b" : "#f4f4f4",
        color: copied ? "white" : "#222",
        border: "1px solid #ddd",
        borderRadius: 4,
        cursor: "pointer",
        transition: "background 0.15s",
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
