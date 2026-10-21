import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface QualityOption {
  quality: number;
  label: string;
  available: boolean;
  requiresLogin: boolean;
  requiresVip: boolean;
}

export interface QualityMenuProps {
  options: QualityOption[];
  currentQuality: number;
  decodedLabel: string | null;
  loggedIn: boolean;
  loading?: boolean;
  onSelect: (quality: number) => void;
}

const memberQualities = new Set([112, 116, 120, 125, 126, 127]);
const standardLabels: Record<number, string> = {
  80: '1080p 高清',
  64: '720p 准高清',
  32: '480p 标清',
  16: '360p 流畅',
};

export function QualityMenu({ options, currentQuality, decodedLabel, loggedIn, loading = false, onSelect }: QualityMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const initialFocus = useRef<number | null>(null);
  const id = useId();
  const sorted = [...options].sort((a, b) => b.quality - a.quality);
  const current = sorted.find(option => option.quality === currentQuality);

  useEffect(() => {
    if (!open) return;
    const selected = sorted.findIndex(option => option.quality === currentQuality);
    items.current[initialFocus.current ?? Math.max(0, selected)]?.focus();
    initialFocus.current = null;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const count = sorted.length;
    if (!count || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = items.current.findIndex(item => item === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1
      : event.key === 'ArrowDown' ? (index + 1) % count : (index - 1 + count) % count;
    items.current[next]?.focus();
  };

  return (
    <div
      className="quality-picker"
      ref={root}
      onKeyDown={event => event.stopPropagation()}
      onKeyUp={event => event.stopPropagation()}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={`quality-picker-trigger${open ? ' is-open' : ''}`}
        aria-label={`画质：${decodedLabel ?? current?.label ?? '正在读取'}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? id : undefined}
        aria-busy={loading}
        disabled={loading || !sorted.length}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            initialFocus.current = event.key === 'ArrowUp' ? sorted.length - 1 : 0;
            setOpen(true);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      >
        <span>{loading ? '切换中…' : decodedLabel ?? current?.label ?? '画质'}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="m3 7.5 3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div id={id} role="menu" aria-label="选择画质" className="quality-picker-menu" onKeyDown={menuKeyDown}>
          {sorted.map((option, index) => {
            const requiresVip = option.requiresVip || memberQualities.has(option.quality);
            const loginRequired = !loggedIn && (option.requiresLogin || option.quality > 64);
            const disabled = !option.available && !loginRequired;
            const selected = option.quality === currentQuality;
            const badge = loginRequired ? (requiresVip ? '登录 · 大会员' : '需登录')
              : requiresVip ? '大会员' : disabled ? '暂不可用' : null;
            return (
              <button
                key={option.quality}
                ref={element => { items.current[index] = element; }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-disabled={disabled || loading}
                tabIndex={-1}
                className={`quality-picker-option${selected ? ' is-selected' : ''}`}
                title={disabled ? (requiresVip ? '需要大会员权限，当前不可用' : '当前视频暂不提供此画质') : undefined}
                onClick={() => {
                  if (disabled || loading) return;
                  close();
                  onSelect(option.quality);
                }}
              >
                <span className="quality-picker-label">{standardLabels[option.quality] ?? option.label}</span>
                {badge && <span className={`quality-picker-badge${requiresVip ? ' is-vip' : ''}`}>{badge}</span>}
                {!badge && selected && <span className="quality-picker-check" aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
