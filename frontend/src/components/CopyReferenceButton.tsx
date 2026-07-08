import { Check, Copy, X } from 'lucide-react';
import { useState, type MouseEvent } from 'react';

import { useI18n } from '../i18n';
import { copyText } from '../utils/clipboard';

interface CopyReferenceButtonProps {
  reference: string;
  className?: string;
}

export function CopyReferenceButton({ reference, className = '' }: CopyReferenceButtonProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  async function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    try {
      await copyText(reference);
      setStatus('copied');
    } catch {
      setStatus('error');
    } finally {
      setTimeout(() => setStatus('idle'), 1200);
    }
  }

  const icon =
    status === 'copied' ? (
      <Check size={14} />
    ) : status === 'error' ? (
      <X size={14} />
    ) : (
      <Copy size={14} />
    );

  return (
    <button
      type="button"
      onClick={handleClick}
      title={t('common.copyReference')}
      aria-label={t('common.copyReference')}
      className={`inline-flex items-center justify-center rounded-md p-1.5 text-ink-dim transition-colors hover:bg-surface-800 hover:text-ink ${className}`}
    >
      {icon}
    </button>
  );
}
