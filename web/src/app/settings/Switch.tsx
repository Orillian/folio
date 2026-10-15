export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** A labelled on/off switch (a real checkbox with `role="switch"`, so it works with the keyboard and screen readers). */
export function Switch({ checked, onChange, label, hint, disabled }: SwitchProps) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <span className="relative mt-0.5 inline-flex h-5 w-9 shrink-0">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-[inherit] appearance-none rounded-full opacity-0"
        />
        <span className="absolute inset-0 rounded-full bg-neutral-300 transition-colors peer-checked:bg-neutral-900 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 dark:bg-neutral-700 dark:peer-checked:bg-neutral-100" />
        <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4 dark:bg-neutral-950 dark:peer-checked:bg-neutral-900" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-neutral-800 dark:text-neutral-200">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">{hint}</span>}
      </span>
    </label>
  );
}
