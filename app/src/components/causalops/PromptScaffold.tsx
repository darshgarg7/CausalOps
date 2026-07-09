import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { composeFramework, EMPTY_FRAMEWORK, type FrameworkFields } from "@/lib/prompt-templates";

interface PromptScaffoldProps {
  onCompose: (text: string) => void;
  onClose: () => void;
}

export function PromptScaffold({ onCompose, onClose }: PromptScaffoldProps) {
  const [fields, setFields] = useState<FrameworkFields>(EMPTY_FRAMEWORK);

  const update = (k: keyof FrameworkFields, v: string) => setFields((f) => ({ ...f, [k]: v }));

  const handleInsert = () => {
    const composed = composeFramework(fields);
    if (!composed.trim()) return;
    onCompose(composed);
  };

  return (
    <div className="mb-3 rounded-xl border border-[color:var(--neon-violet)]/30 bg-[color:var(--neon-violet)]/[0.04] p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-[color:var(--neon-violet)]">
          Structured Brief · MITRE-style
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <ScaffoldField
          label="Target asset / system"
          placeholder="e.g. Production Postgres, Okta tenant, customer S3 bucket"
          value={fields.asset}
          onChange={(v) => update("asset", v)}
        />
        <ScaffoldField
          label="Suspected threat actor"
          placeholder="External attacker · insider · APT-style group · unknown"
          value={fields.actor}
          onChange={(v) => update("actor", v)}
        />
        <ScaffoldField
          label="Observed TTPs"
          placeholder="e.g. Macro execution, lateral via SMB, lsass dump"
          value={fields.ttps}
          onChange={(v) => update("ttps", v)}
        />
        <ScaffoldField
          label="Indicators / telemetry"
          placeholder="EDR alerts, IPs, hashes, timestamps"
          value={fields.indicators}
          onChange={(v) => update("indicators", v)}
        />
        <div className="sm:col-span-2">
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
            Constraints / objectives
          </label>
          <Textarea
            value={fields.constraints}
            onChange={(e) => update("constraints", e.target.value)}
            placeholder="Decision needed (e.g. isolate vs observe). Business limits (uptime, customer impact, time pressure)."
            rows={2}
            className="resize-none border-white/10 bg-black/30 text-sm"
          />
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={handleInsert}
          className="flex items-center gap-1.5 rounded-md bg-[color:var(--neon-violet)]/20 px-3 py-1.5 text-xs font-medium text-[color:var(--neon-violet)] transition-colors hover:bg-[color:var(--neon-violet)]/30"
        >
          <Plus className="h-3 w-3" />
          Insert into prompt
        </button>
      </div>
    </div>
  );
}

function ScaffoldField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="border-white/10 bg-black/30 text-sm"
      />
    </div>
  );
}
