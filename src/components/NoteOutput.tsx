"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";

interface NoteOutputProps {
  note: string;
  ehrMode: "epic" | "cerner";
  onEhrModeChange: (mode: "epic" | "cerner") => void;
}

export default function NoteOutput({
  note,
  ehrMode,
  onEhrModeChange,
}: NoteOutputProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!note) return;
    await navigator.clipboard.writeText(note);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
        <h3 className="text-sm font-medium text-gray-700">
          Generated Note
        </h3>
        <div className="flex items-center gap-2">
          {/* EHR Mode Toggle */}
          <div className="flex rounded-md bg-gray-100 p-0.5 text-xs">
            <button
              onClick={() => onEhrModeChange("epic")}
              className={`rounded px-2 py-1 font-medium ${
                ehrMode === "epic"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500"
              }`}
            >
              Epic
            </button>
            <button
              onClick={() => onEhrModeChange("cerner")}
              className={`rounded px-2 py-1 font-medium ${
                ehrMode === "cerner"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500"
              }`}
            >
              Cerner
            </button>
          </div>
          <button
            onClick={handleCopy}
            disabled={!note}
            className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-30"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
      <div className="h-96 overflow-y-auto px-4 py-3">
        {note ? (
          <div className="prose prose-sm max-w-none text-gray-800 [&_strong]:font-semibold [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0.5">
            <ReactMarkdown>{note}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm text-gray-400 italic">
            Note will be generated after the encounter. Record your
            conversation, then click &ldquo;Generate Note&rdquo; when ready.
          </p>
        )}
      </div>
    </div>
  );
}
