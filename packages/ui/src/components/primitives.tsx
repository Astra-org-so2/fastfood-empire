import { clsx, type ClassValue } from 'clsx';
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { AlertTriangle, ChevronDown, Loader2, X } from 'lucide-react';
import { quotaTypeLabel } from '../lib/format.js';

export const cx = (...values: ClassValue[]): string => clsx(values);

/* ------------------------------------------------------------------ surfaces */

export function Panel({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return (
    <div className={cx('panel', className)} {...rest}>
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div className={cx('panel-header', className)}>
      <div className="min-w-0">
        <div className="truncate text-muted">{title}</div>
        {subtitle ? <div className="mt-0.5 truncate text-[11px] normal-case tracking-normal text-faint">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

/** A single number with a label — used across dashboard, quotas and performance. */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'positive' | 'warning' | 'danger' | 'muted';
}): ReactNode {
  const toneClass = {
    default: 'text-ink',
    positive: 'text-free',
    warning: 'text-warn',
    danger: 'text-danger',
    muted: 'text-muted',
  }[tone];
  return (
    <div className="min-w-0 px-3 py-2">
      <div className="text-2xs uppercase tracking-wide text-faint">{label}</div>
      <div className={cx('tabular mt-0.5 text-[17px] leading-6', toneClass)}>{value}</div>
      {hint ? <div className="mt-0.5 truncate text-[11px] text-faint" title={typeof hint === 'string' ? hint : undefined}>{hint}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ controls */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'default' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
};

export function Button({ variant = 'default', size = 'sm', loading, icon, children, className, disabled, ...rest }: ButtonProps): ReactNode {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const sizes = size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]';
  const variants = {
    primary: 'border-accent bg-accent text-accent-ink hover:brightness-110',
    default: 'border-line bg-surface-2 text-ink hover:bg-hover',
    ghost: 'border-transparent bg-transparent text-muted hover:bg-hover hover:text-ink',
    danger: 'border-danger/50 bg-danger/10 text-danger hover:bg-danger/20',
  }[variant];
  return (
    <button type="button" className={cx(base, sizes, variants, className)} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <input
      className={cx(
        'h-7 w-full rounded-[var(--radius-sm)] border border-line bg-inset px-2 text-[12px] text-ink placeholder:text-faint',
        'focus:border-line-strong focus:outline-none',
        className,
      )}
      {...rest}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <div className="relative inline-flex">
      <select
        className={cx(
          'h-7 appearance-none rounded-[var(--radius-sm)] border border-line bg-inset pl-2 pr-6 text-[12px] text-ink',
          'focus:border-line-strong focus:outline-none',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
    </div>
  );
}

export function Checkbox({ label, checked, onChange, hint }: { label: ReactNode; checked: boolean; onChange: (next: boolean) => void; hint?: ReactNode }): ReactNode {
  return (
    <label className="flex cursor-pointer items-start gap-2 py-1">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-accent)]"
      />
      <span className="min-w-0">
        <span className="block text-[12px] text-ink">{label}</span>
        {hint ? <span className="block text-[11px] text-faint">{hint}</span> : null}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ status */

export type Tone = 'neutral' | 'accent' | 'free' | 'trial' | 'paid' | 'unknown' | 'hosted' | 'warn' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-line bg-surface-2 text-muted',
  accent: 'border-accent/40 bg-accent/10 text-accent',
  free: 'border-free/40 bg-free/10 text-free',
  trial: 'border-trial/40 bg-trial/10 text-trial',
  paid: 'border-paid/40 bg-paid/10 text-paid',
  unknown: 'border-unknown/40 bg-unknown/10 text-muted',
  hosted: 'border-hosted/40 bg-hosted/10 text-hosted',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  danger: 'border-danger/40 bg-danger/10 text-danger',
};

export function Badge({ children, tone = 'neutral', title, className }: { children: ReactNode; tone?: Tone; title?: string; className?: string }): ReactNode {
  return (
    <span
      title={title}
      className={cx('inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide', TONE_CLASS[tone], className)}
    >
      {children}
    </span>
  );
}

/**
 * The five quota classifications the product must never blur together (§19).
 * FREE_TRIAL and FREE_RENEWABLE look different on purpose: a trial credit is not
 * renewable free quota and FREE ONLY mode must not spend it.
 */
export function QuotaTypeBadge({ type, title }: { type: string | null | undefined; title?: string }): ReactNode {
  const map: Record<string, Tone> = {
    free_renewable: 'free',
    free_trial: 'trial',
    paid: 'paid',
    unknown: 'unknown',
    user_hosted: 'hosted',
  };
  const label = quotaTypeLabel(type as never);
  const explanation =
    title ??
    ({
      FREE_RENEWABLE: 'Renewable free quota: resets on a schedule and can be used in FREE ONLY mode.',
      FREE_TRIAL: 'Trial credits: finite, not renewable. Never used in FREE ONLY mode.',
      PAID: 'Paid usage. Never used in FREE ONLY mode.',
      UNKNOWN: 'Quota type unknown. Treated as unavailable in FREE ONLY mode.',
      USER_HOSTED: 'Self-hosted endpoint: you pay for the hardware, not per token.',
    }[label] ??
      '');
  return (
    <Badge tone={map[(type as string) ?? 'unknown'] ?? 'unknown'} title={explanation}>
      {label}
    </Badge>
  );
}

export function StatusDot({ tone = 'neutral', pulse }: { tone?: Tone; pulse?: boolean }): ReactNode {
  const colour: Record<Tone, string> = {
    neutral: 'bg-unknown',
    accent: 'bg-accent',
    free: 'bg-free',
    trial: 'bg-trial',
    paid: 'bg-paid',
    unknown: 'bg-unknown',
    hosted: 'bg-hosted',
    warn: 'bg-warn',
    danger: 'bg-danger',
  };
  return <span className={cx('inline-block size-1.5 shrink-0 rounded-full', colour[tone], pulse && 'animate-pulse')} aria-hidden />;
}

export function ProgressBar({ value, tone = 'accent', label }: { value: number; tone?: Tone; label?: string }): ReactNode {
  const clamped = Math.max(0, Math.min(1, value));
  const colour: Record<Tone, string> = {
    neutral: 'bg-unknown',
    accent: 'bg-accent',
    free: 'bg-free',
    trial: 'bg-trial',
    paid: 'bg-paid',
    unknown: 'bg-unknown',
    hosted: 'bg-hosted',
    warn: 'bg-warn',
    danger: 'bg-danger',
  };
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-inset" role="progressbar" aria-valuenow={Math.round(clamped * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={cx('h-full transition-[width] duration-300', colour[tone])} style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ states */

export function EmptyState({ title, detail, action, icon }: { title: ReactNode; detail?: ReactNode; action?: ReactNode; icon?: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon ? <div className="text-faint">{icon}</div> : null}
      <div className="text-[13px] font-medium text-ink">{title}</div>
      {detail ? <div className="max-w-xl text-[12px] leading-5 text-muted">{detail}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title, detail, retry }: { title: ReactNode; detail?: ReactNode; retry?: () => void }): ReactNode {
  return (
    <div className="flex flex-col items-start gap-2 rounded-[var(--radius-md)] border border-danger/40 bg-danger/5 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-danger">
        <AlertTriangle className="size-3.5" aria-hidden />
        {title}
      </div>
      {detail ? <pre className="max-h-40 w-full overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted">{String(detail)}</pre> : null}
      {retry ? (
        <Button variant="ghost" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }): ReactNode {
  return <div className={cx('skeleton h-4 w-full', className)} style={style} aria-hidden />;
}

export function LoadingRows({ rows = 4 }: { rows?: number }): ReactNode {
  return (
    <div className="space-y-1.5 p-3">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-4" style={{ width: `${100 - index * 7}%` }} />
      ))}
    </div>
  );
}

/** A note that explains a limitation instead of hiding it. */
export function Notice({ tone = 'neutral', children, action }: { tone?: 'neutral' | 'warn' | 'danger' | 'accent'; children: ReactNode; action?: ReactNode }): ReactNode {
  const tones = {
    neutral: 'border-line bg-surface-2 text-muted',
    warn: 'border-warn/40 bg-warn/5 text-warn',
    danger: 'border-danger/40 bg-danger/5 text-danger',
    accent: 'border-accent/40 bg-accent/5 text-accent',
  }[tone];
  return (
    <div className={cx('flex items-start justify-between gap-3 rounded-[var(--radius-md)] border px-2.5 py-2 text-[12px]', tones)}>
      <div className="min-w-0 leading-5">{children}</div>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ dialogs */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 'md',
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg';
}): ReactNode {
  if (!open) return null;
  const widths = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl' }[width];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[8vh]" role="dialog" aria-modal="true">
      <div className={cx('panel w-full shadow-2xl', widths)}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <div className="text-[13px] font-medium">{title}</div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="rounded p-1 text-faint hover:bg-hover hover:text-ink">
            <X className="size-3.5" />
          </button>
        </div>
        <div className="max-h-[70vh] scroll-y px-3 py-3">{children}</div>
        {footer ? <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { id: T; label: ReactNode; count?: number }[]; active: T; onChange: (id: T) => void }): ReactNode {
  return (
    <div className="flex items-center gap-0.5 border-b border-line" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cx(
            'relative -mb-px border-b-2 px-2.5 py-1.5 text-[12px] transition-colors',
            active === tab.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="ml-1 text-[10px] text-faint tabular">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ charts */

export function Sparkline({ values, tone = 'accent', height = 28 }: { values: number[]; tone?: Tone; height?: number }): ReactNode {
  if (!values.length) return <div className="h-[28px] w-full rounded bg-inset" />;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * 100;
      const y = 100 - ((value - min) / range) * 100;
      return `${x},${y}`;
    })
    .join(' ');
  const stroke = {
    neutral: 'var(--color-unknown)',
    accent: 'var(--color-accent)',
    free: 'var(--color-free)',
    trial: 'var(--color-trial)',
    paid: 'var(--color-paid)',
    unknown: 'var(--color-unknown)',
    hosted: 'var(--color-hosted)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  }[tone];
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }} className="w-full" role="img" aria-label="trend">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function BarSeries({ data, tone = 'accent', height = 120 }: { data: { label: string; value: number }[]; tone?: Tone; height?: number }): ReactNode {
  if (!data.length) return <EmptyState title="No data yet" detail="This chart fills in as agents run." />;
  const max = Math.max(...data.map((entry) => entry.value), 1);
  return (
    <div className="flex items-end gap-1" style={{ height }}>
      {data.map((entry) => (
        <div key={entry.label} className="group relative flex flex-1 flex-col items-center justify-end gap-1" title={`${entry.label}: ${entry.value}`}>
          <div
            className={cx(
              'w-full rounded-t-[2px] transition-colors',
              { neutral: 'bg-unknown', accent: 'bg-accent', free: 'bg-free', trial: 'bg-trial', paid: 'bg-paid', unknown: 'bg-unknown', hosted: 'bg-hosted', warn: 'bg-warn', danger: 'bg-danger' }[tone],
            )}
            style={{ height: `${Math.max((entry.value / max) * 100, entry.value > 0 ? 2 : 0)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
