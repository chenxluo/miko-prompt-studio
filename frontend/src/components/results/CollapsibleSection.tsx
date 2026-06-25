import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  icon?: React.ReactNode;
}

export function CollapsibleSection({
  title,
  children,
  defaultOpen = false,
  icon,
}: CollapsibleSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultOpen);

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex items-center justify-between rounded-md border border-surface-800 bg-surface-950 px-3 py-2 text-left transition-colors hover:border-surface-700 hover:bg-surface-800"
      >
        <div className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
          {icon}
          {title}
        </div>
        <ChevronDown
          size={14}
          className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
        />
      </button>
      {isExpanded && children}
    </div>
  );
}
