import type { ReactNode } from 'react';

/** A labelled form field with an optional tag, hint, warning and error. */
export default function Field({
  id,
  label,
  tag,
  hint,
  warning,
  error,
  children,
}: {
  id: string;
  label: string;
  tag?: ReactNode;
  hint?: ReactNode;
  warning?: string | null;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {tag}
      </label>
      {children}
      {error ? (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : warning ? (
        <p className="field-warning" id={`${id}-warning`}>
          {warning}
        </p>
      ) : null}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
